-- PostgreSQL-authoritative Listing Audit event reader.
--
-- analytics.catalog_change_event remains the only lifecycle-event fact table.
-- These views expose a bounded, frontend-safe projection to the dedicated
-- read-only role; raw evidence, catalog artifacts, and connection metadata are
-- deliberately not part of the publication contract.

ALTER TABLE analytics.catalog_change_event
  ADD COLUMN IF NOT EXISTS official_listed_at timestamptz,
  ADD COLUMN IF NOT EXISTS time_basis text NOT NULL DEFAULT 'first_observed'
    CHECK (time_basis IN ('official', 'first_observed'));

ALTER TABLE analytics.catalog_change_event
  DROP CONSTRAINT IF EXISTS catalog_change_event_time_basis_coherent;

ALTER TABLE analytics.catalog_change_event
  ADD CONSTRAINT catalog_change_event_time_basis_coherent CHECK (
    (time_basis = 'official' AND official_listed_at IS NOT NULL)
    OR (time_basis = 'first_observed' AND official_listed_at IS NULL)
  );

CREATE INDEX IF NOT EXISTS catalog_change_event_public_history_idx
  ON analytics.catalog_change_event(observed_at DESC, catalog_change_event_id)
  WHERE status = 'confirmed' AND baseline = false;

CREATE OR REPLACE VIEW publication.listing_change_event_v1
WITH (security_barrier = true)
AS
SELECT
  event.catalog_change_event_id::text AS event_id,
  COALESCE(
    NULLIF(event.evidence->>'listingKey', ''),
    source.market || ':' || source.venue || ':' || instrument_version.normalized_venue_symbol
  ) AS listing_key,
  source.market,
  source.venue,
  instrument_version.normalized_venue_symbol AS venue_symbol,
  asset_version.canonical_underlying AS canonical_symbol,
  COALESCE(
    NULLIF(event.evidence->>'name', ''),
    NULLIF(membership_evidence.normalized_attributes->>'name', ''),
    asset_version.display_name
  ) AS display_name,
  asset_version.category,
  COALESCE(
    NULLIF(event.evidence->>'venueCategory', ''),
    NULLIF(membership_evidence.normalized_attributes->>'venueCategory', '')
  ) AS venue_category,
  COALESCE(
    NULLIF(event.evidence->>'lifecycleStatus', ''),
    NULLIF(membership_evidence.normalized_attributes->>'lifecycleStatus', '')
  ) AS lifecycle_status,
  event.event_type,
  CASE event.event_type
    WHEN 'listed' THEN 'new'
    WHEN 'relisted' THEN 'relisted'
    WHEN 'delisted' THEN 'delisted'
    ELSE NULL
  END AS change_type,
  event.observed_at,
  event.official_listed_at,
  event.time_basis,
  instrument_version.identity_status,
  CASE
    WHEN event.event_type IN ('listed', 'relisted')
      AND instrument_version.identity_status = 'verified'
    THEN 'eligible'
    ELSE 'removed'
  END AS inclusion_status,
  event.baseline,
  event.status
FROM analytics.catalog_change_event AS event
JOIN identity.source AS source
  ON source.source_id = event.source_id
JOIN identity.instrument_version AS instrument_version
  ON instrument_version.instrument_version_id = event.instrument_version_id
 AND instrument_version.source_id = event.source_id
JOIN identity.asset_version AS asset_version
  ON asset_version.asset_version_id = instrument_version.asset_version_id
LEFT JOIN LATERAL (
  SELECT membership.normalized_attributes
  FROM ingest.catalog_membership AS membership
  WHERE membership.instrument_version_id = event.instrument_version_id
    AND membership.source_id = event.source_id
    AND membership.observed_at <= event.observed_at
  ORDER BY membership.observed_at DESC, membership.source_run_id DESC
  LIMIT 1
) AS membership_evidence ON true
WHERE event.event_type IN ('listed', 'relisted', 'delisted')
  AND event.status = 'confirmed'
  AND event.baseline = false;

CREATE OR REPLACE VIEW publication.listing_audit_run_v1
WITH (security_barrier = true)
AS
SELECT
  cycle.cycle_id::text,
  cycle.bucket_at,
  cycle.completed_at AS cycle_completed_at,
  cycle.status AS cycle_status,
  source.source_key,
  source.market,
  source.venue,
  run.status AS run_status,
  run.catalog_status,
  run.identity_status,
  run.listing_count,
  run.admitted_listing_count,
  run.rejected_listing_count,
  run.error_codes,
  NULLIF(run.metadata->>'mergedStatus', '') AS merged_status,
  NULLIF(run.metadata->>'baselineAt', '')::timestamptz AS baseline_at,
  NULLIF(run.metadata->>'observedAt', '')::timestamptz AS observed_at,
  COALESCE((run.metadata->>'pendingRemovalCount')::integer, 0) AS pending_removal_count,
  NULLIF(run.metadata->>'writeDisposition', '') AS write_disposition
FROM ingest.collection_cycle AS cycle
JOIN ingest.collection_attempt AS attempt
  ON attempt.cycle_id = cycle.cycle_id
JOIN ingest.source_run AS run
  ON run.attempt_id = attempt.attempt_id
JOIN identity.source AS source
  ON source.source_id = run.source_id
WHERE cycle.job_name = 'rwa-listing-audit'
  AND cycle.pipeline_version = 'rwa-listing-catalog-pg-shadow/v1'
  AND run.endpoint_key = 'official-catalog';

CREATE OR REPLACE VIEW publication.listing_audit_pending_review_v1
WITH (security_barrier = true)
AS
SELECT
  review.review_case_id::text AS review_id,
  source.source_key,
  source.market,
  source.venue,
  review.candidate_official_product_key AS venue_symbol,
  NULLIF(review.candidate_payload->>'canonicalUnderlying', '') AS canonical_symbol,
  NULLIF(review.candidate_payload->>'name', '') AS display_name,
  NULLIF(review.candidate_payload->>'category', '') AS category,
  review.opened_at AS first_seen_at,
  NULLIF(review.candidate_payload->>'observedAt', '')::timestamptz AS last_seen_at
FROM identity.review_case AS review
JOIN identity.source AS source
  ON source.source_id = review.source_id
WHERE review.status = 'open';

REVOKE ALL ON publication.listing_change_event_v1 FROM PUBLIC;
REVOKE ALL ON publication.listing_audit_run_v1 FROM PUBLIC;
REVOKE ALL ON publication.listing_audit_pending_review_v1 FROM PUBLIC;
REVOKE ALL ON analytics.catalog_change_event FROM rwa_listing_audit_reader;
REVOKE ALL ON ingest.catalog_membership FROM rwa_listing_audit_reader;
REVOKE ALL ON ingest.source_run FROM rwa_listing_audit_reader;
REVOKE ALL ON identity.evidence FROM rwa_listing_audit_reader;

GRANT SELECT ON
  publication.listing_change_event_v1,
  publication.listing_audit_run_v1,
  publication.listing_audit_pending_review_v1
TO rwa_listing_audit_reader;

COMMENT ON VIEW publication.listing_change_event_v1 IS
  'Frontend-safe projection of confirmed analytics.catalog_change_event facts. Raw event evidence is intentionally excluded.';

COMMENT ON VIEW publication.listing_audit_run_v1 IS
  'Safe Listing Audit source-run coverage projection used to distinguish Full, Partial, Warming, and Unavailable.';

COMMENT ON VIEW publication.listing_audit_pending_review_v1 IS
  'Safe active identity-review projection. Review rows never become eligible listing events.';

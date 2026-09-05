-- Forward repair for the frontend-safe Listing event projection.
--
-- Immutable lifecycle-event evidence records what the writer observed, but it
-- is not the canonical presentation authority after a reviewed identity
-- correction. Published names and categories must come from the exact
-- identity version already bound to the event's instrument version. Venue
-- category and lifecycle metadata remain separate event/membership facts.

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
  asset_version.display_name AS display_name,
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

REVOKE ALL ON publication.listing_change_event_v1 FROM PUBLIC;

GRANT SELECT ON publication.listing_change_event_v1
TO rwa_listing_audit_reader;

COMMENT ON VIEW publication.listing_change_event_v1 IS
  'Frontend-safe projection of confirmed analytics.catalog_change_event facts. Canonical name/category come from the bound identity version; raw event evidence is intentionally excluded.';

DO $reviewed_listing_identity_projection$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM publication.listing_change_event_v1 AS published
    JOIN (VALUES
      ('SKDD', 'GraniteShares 2x Short SK Hynix Daily ETF'),
      ('SKUU', 'GraniteShares 2x Long SK Hynix Daily ETF')
    ) AS expected(canonical_symbol, display_name)
      ON expected.canonical_symbol = published.canonical_symbol
    WHERE published.category = 'etf'
      AND published.display_name <> expected.display_name
  ) THEN
    RAISE EXCEPTION 'published SKDD/SKUU ETF events do not use the corrected identity display names';
  END IF;
END
$reviewed_listing_identity_projection$;

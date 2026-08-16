-- Phase 1 same-day catalog retry replacement.
-- The catalog shadow writer may delete only the two source-run-scoped rows
-- that it immediately reconstructs inside the same serializable transaction.

GRANT DELETE ON identity.evidence, ingest.catalog_membership
TO rwa_catalog_shadow_writer;

CREATE TABLE IF NOT EXISTS ingest.catalog_publication_lease (
  lease_key text PRIMARY KEY CHECK (lease_key ~ '^[a-z0-9][a-z0-9._:-]{2,191}$'),
  owner_token uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  payload_checksum char(64) NOT NULL CHECK (payload_checksum ~ '^[0-9a-f]{64}$'),
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at timestamptz NOT NULL,
  released_at timestamptz,
  last_release_status text CHECK (last_release_status IN ('published', 'failed')),
  last_published_at timestamptz,
  last_published_checksum char(64) CHECK (
    last_published_checksum IS NULL OR last_published_checksum ~ '^[0-9a-f]{64}$'
  ),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (lease_expires_at >= acquired_at),
  CHECK ((last_published_at IS NULL) = (last_published_checksum IS NULL))
);

GRANT SELECT, INSERT, UPDATE ON ingest.catalog_publication_lease
TO rwa_catalog_shadow_writer;

CREATE OR REPLACE FUNCTION ingest.reject_stale_catalog_retry()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '40001',
    MESSAGE = 'STALE_TRUSTED_LISTING_RETRY';
END
$function$;

REVOKE ALL ON FUNCTION ingest.reject_stale_catalog_retry() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingest.reject_stale_catalog_retry()
TO rwa_catalog_shadow_writer;

CREATE OR REPLACE FUNCTION ingest.reject_catalog_identity_downgrade()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'UNTRUSTED_CATALOG_IDENTITY_DOWNGRADE';
END
$function$;

REVOKE ALL ON FUNCTION ingest.reject_catalog_identity_downgrade() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingest.reject_catalog_identity_downgrade()
TO rwa_catalog_shadow_writer;

CREATE OR REPLACE FUNCTION ingest.reject_verified_catalog_identity_conflict()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'CONFLICTING_VERIFIED_CATALOG_IDENTITY';
END
$function$;

REVOKE ALL ON FUNCTION ingest.reject_verified_catalog_identity_conflict() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingest.reject_verified_catalog_identity_conflict()
TO rwa_catalog_shadow_writer;

COMMENT ON TABLE ingest.catalog_membership IS
  'Exact accepted official membership for the latest trusted observation in a source run. Trusted same-day retries replace this set transactionally; unavailable or untrusted retries preserve the last-good set.';

COMMENT ON TABLE identity.evidence IS
  'Versioned identity evidence. Official-catalog evidence is replaced transactionally with exact accepted membership on a trusted same-day catalog retry.';

COMMENT ON TABLE ingest.catalog_publication_lease IS
  'Short distributed lease spanning one Listing Audit PostgreSQL mutation, Runtime Cache publication, and sink acknowledgement. It prevents an older serverless invocation from overwriting a newer same-day bundle.';

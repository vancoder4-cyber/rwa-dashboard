-- Durable Listing Audit publication checkpoint.
--
-- The checkpoint stores the exact compact bundle already accepted by the
-- authenticated writer. It is not reconstructed from historical catalog
-- membership and therefore cannot synthesize New/Re-listed events after a
-- Runtime Cache eviction.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rwa_listing_audit_reader') THEN
    CREATE ROLE rwa_listing_audit_reader NOLOGIN;
  END IF;
END
$roles$;

CREATE TABLE IF NOT EXISTS publication.listing_audit_checkpoint (
  checkpoint_key text PRIMARY KEY CHECK (checkpoint_key = 'rwa-listing-audit-v2'),
  bundle_format text NOT NULL CHECK (bundle_format = 'rwa-listing-audit-bundle/v2'),
  schema_version text NOT NULL CHECK (schema_version = 'rwa-listing-audit/v1'),
  source_cycle_id uuid NOT NULL REFERENCES ingest.collection_cycle(cycle_id),
  observed_at timestamptz NOT NULL,
  payload_text text NOT NULL,
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload_bytes integer NOT NULL CHECK (payload_bytes > 0 AND payload_bytes <= 1750000),
  source_count integer NOT NULL CHECK (source_count = 10),
  active_listing_count integer NOT NULL CHECK (active_listing_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (octet_length(payload_text) = payload_bytes)
);

GRANT USAGE ON SCHEMA publication TO rwa_listing_audit_reader;
GRANT SELECT ON publication.listing_audit_checkpoint TO rwa_listing_audit_reader;
GRANT USAGE ON SCHEMA publication TO rwa_catalog_shadow_writer;
GRANT SELECT, INSERT, UPDATE ON publication.listing_audit_checkpoint
TO rwa_catalog_shadow_writer;

COMMENT ON TABLE publication.listing_audit_checkpoint IS
  'Exact bounded Listing Audit publication bundle. PostgreSQL preserves continuity; Runtime Cache remains a disposable read replica.';

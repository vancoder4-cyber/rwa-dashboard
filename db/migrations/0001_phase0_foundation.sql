-- Phase 0: durable identity, ingestion lineage, and raw archive metadata.
-- Raw upstream bodies belong in object storage. Postgres stores only immutable
-- hashes, locations, and normalized facts tied to exact official identities.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA IF NOT EXISTS ops;
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS ingest;
CREATE SCHEMA IF NOT EXISTS fact;
CREATE SCHEMA IF NOT EXISTS analytics;
CREATE SCHEMA IF NOT EXISTS publication;
CREATE SCHEMA IF NOT EXISTS alert;

CREATE TABLE IF NOT EXISTS ops.schema_migration (
  version text PRIMARY KEY,
  name text NOT NULL,
  checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  statement_count integer NOT NULL CHECK (statement_count > 0),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS identity.source (
  source_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_key text NOT NULL UNIQUE CHECK (source_key ~ '^[a-z0-9][a-z0-9._:-]{2,191}$'),
  market text NOT NULL CHECK (market IN ('perp', 'spot', 'traditional', 'reference', 'operations')),
  venue text NOT NULL CHECK (length(btrim(venue)) > 0),
  data_domain text NOT NULL CHECK (length(btrim(data_domain)) > 0),
  catalog_authority text NOT NULL DEFAULT 'official' CHECK (catalog_authority IN ('official', 'regulatory', 'licensed-vendor', 'internal')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (market, venue, data_domain)
);

CREATE TABLE IF NOT EXISTS identity.asset (
  asset_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_key text COLLATE "C" NOT NULL UNIQUE
    CHECK (asset_key ~ '^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS identity.asset_version (
  asset_version_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES identity.asset(asset_id),
  category text NOT NULL CHECK (category IN ('equity', 'etf', 'commodity', 'fx', 'index', 'bond', 'fund', 'pre-ipo', 'other')),
  canonical_underlying text COLLATE "C" NOT NULL CHECK (length(btrim(canonical_underlying)) > 0),
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  market_origin text NOT NULL DEFAULT 'unknown' CHECK (market_origin IN ('us', 'hk', 'adr', 'kr', 'tw', 'jp', 'cn', 'global', 'pre-ipo', 'unknown')),
  market_tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  identity_status text NOT NULL CHECK (identity_status IN ('verified', 'quarantined', 'rejected')),
  identity_fingerprint char(64) NOT NULL CHECK (identity_fingerprint ~ '^[0-9a-f]{64}$'),
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (array_position(market_tags, NULL) IS NULL),
  CHECK (market_tags <@ ARRAY['us', 'adr', 'hk', 'kr', 'tw', 'jp', 'cn', 'global', 'pre-ipo']::text[]),
  CHECK (identity_status <> 'verified' OR category <> 'other'),
  CONSTRAINT asset_version_no_overlap
    EXCLUDE USING gist (asset_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&),
  CONSTRAINT verified_asset_identity_no_overlap
    EXCLUDE USING gist (
      category WITH =,
      canonical_underlying WITH =,
      tstzrange(valid_from, valid_to, '[)') WITH &&
    ) WHERE (identity_status = 'verified')
);

CREATE UNIQUE INDEX IF NOT EXISTS asset_version_one_current
  ON identity.asset_version(asset_id)
  WHERE valid_to IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS verified_asset_identity_one_current
  ON identity.asset_version(category, canonical_underlying)
  WHERE valid_to IS NULL AND identity_status = 'verified';

CREATE TABLE IF NOT EXISTS identity.instrument (
  instrument_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id bigint NOT NULL REFERENCES identity.source(source_id),
  official_product_key text COLLATE "C" NOT NULL CHECK (length(official_product_key) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_id, official_product_key),
  UNIQUE (instrument_id, source_id)
);

CREATE TABLE IF NOT EXISTS identity.instrument_version (
  instrument_version_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id uuid NOT NULL,
  source_id bigint NOT NULL,
  asset_version_id bigint NOT NULL REFERENCES identity.asset_version(asset_version_id),
  official_venue_symbol text COLLATE "C" NOT NULL CHECK (length(official_venue_symbol) > 0),
  normalized_venue_symbol text NOT NULL CHECK (length(btrim(normalized_venue_symbol)) > 0),
  instrument_type text NOT NULL CHECK (instrument_type IN ('perpetual', 'future', 'spot', 'equity', 'etf', 'option', 'index', 'forex', 'bond', 'fund', 'other')),
  quote_currency text COLLATE "C",
  contract_multiplier numeric(38, 12),
  official_status text NOT NULL CHECK (official_status IN ('online', 'prelaunch', 'suspended', 'delisted', 'unknown')),
  identity_status text NOT NULL CHECK (identity_status IN ('verified', 'quarantined', 'rejected')),
  identity_fingerprint char(64) NOT NULL CHECK (identity_fingerprint ~ '^[0-9a-f]{64}$'),
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (instrument_id, source_id) REFERENCES identity.instrument(instrument_id, source_id),
  CHECK (contract_multiplier IS NULL OR contract_multiplier > 0),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT instrument_version_no_overlap
    EXCLUDE USING gist (instrument_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&),
  CONSTRAINT verified_official_symbol_no_overlap
    EXCLUDE USING gist (
      source_id WITH =,
      official_venue_symbol WITH =,
      tstzrange(valid_from, valid_to, '[)') WITH &&
    ) WHERE (identity_status = 'verified'),
  CONSTRAINT verified_normalized_symbol_no_overlap
    EXCLUDE USING gist (
      source_id WITH =,
      normalized_venue_symbol WITH =,
      tstzrange(valid_from, valid_to, '[)') WITH &&
    ) WHERE (identity_status = 'verified'),
  UNIQUE (instrument_version_id, source_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS instrument_version_one_current
  ON identity.instrument_version(instrument_id)
  WHERE valid_to IS NULL;

CREATE INDEX IF NOT EXISTS instrument_version_asset_current_idx
  ON identity.instrument_version(asset_version_id, source_id)
  WHERE valid_to IS NULL AND identity_status = 'verified';

CREATE TABLE IF NOT EXISTS identity.alias_version (
  alias_version_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id uuid NOT NULL,
  source_id bigint NOT NULL,
  alias_type text NOT NULL CHECK (alias_type IN ('catalog-key', 'venue-symbol', 'ws-symbol', 'rest-symbol', 'display-symbol', 'legacy-symbol')),
  alias_value text COLLATE "C" NOT NULL CHECK (length(alias_value) > 0),
  identity_status text NOT NULL CHECK (identity_status IN ('verified', 'quarantined', 'rejected')),
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (instrument_id, source_id) REFERENCES identity.instrument(instrument_id, source_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT instrument_alias_version_no_overlap
    EXCLUDE USING gist (
      source_id WITH =,
      alias_type WITH =,
      alias_value WITH =,
      tstzrange(valid_from, valid_to, '[)') WITH &&
    ) WHERE (identity_status = 'verified')
);

CREATE UNIQUE INDEX IF NOT EXISTS alias_version_one_current
  ON identity.alias_version(instrument_id, alias_type, alias_value)
  WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS ingest.collection_cycle (
  cycle_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name text NOT NULL CHECK (length(btrim(job_name)) > 0),
  pipeline_version text NOT NULL CHECK (length(btrim(pipeline_version)) > 0),
  bucket_at timestamptz NOT NULL,
  scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'running', 'complete', 'partial', 'failed')),
  trigger_kind text NOT NULL DEFAULT 'cron' CHECK (trigger_kind IN ('cron', 'manual', 'backfill', 'replay')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at),
  UNIQUE (job_name, pipeline_version, bucket_at)
);

CREATE TABLE IF NOT EXISTS ingest.collection_attempt (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES ingest.collection_cycle(cycle_id),
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'complete', 'partial', 'failed')),
  error_summary text,
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  UNIQUE (cycle_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS ingest.source_run (
  source_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES ingest.collection_attempt(attempt_id),
  source_id bigint NOT NULL REFERENCES identity.source(source_id),
  endpoint_key text NOT NULL CHECK (length(btrim(endpoint_key)) > 0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'full', 'partial', 'unavailable', 'failed')),
  catalog_status text NOT NULL DEFAULT 'unavailable' CHECK (catalog_status IN ('full', 'partial', 'unavailable')),
  identity_status text NOT NULL DEFAULT 'unavailable' CHECK (identity_status IN ('full', 'partial', 'unavailable')),
  data_status text NOT NULL DEFAULT 'unavailable' CHECK (data_status IN ('full', 'partial', 'unavailable', 'not-applicable')),
  listing_count integer,
  admitted_listing_count integer,
  rejected_listing_count integer,
  error_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK (listing_count IS NULL OR listing_count >= 0),
  CHECK (admitted_listing_count IS NULL OR admitted_listing_count >= 0),
  CHECK (rejected_listing_count IS NULL OR rejected_listing_count >= 0),
  CHECK (jsonb_typeof(metadata) = 'object'),
  UNIQUE (attempt_id, source_id, endpoint_key),
  UNIQUE (source_run_id, source_id)
);

CREATE INDEX IF NOT EXISTS source_run_source_completed_idx
  ON ingest.source_run(source_id, completed_at DESC);

CREATE TABLE IF NOT EXISTS ingest.raw_artifact (
  artifact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_run_id uuid NOT NULL REFERENCES ingest.source_run(source_run_id),
  environment text NOT NULL CHECK (environment IN ('production', 'preview', 'development', 'test', 'other')),
  deployment_sha text CHECK (deployment_sha IS NULL OR deployment_sha ~ '^[0-9a-fA-F]{7,64}$'),
  artifact_kind text NOT NULL CHECK (artifact_kind IN ('raw', 'normalized')),
  artifact_role text NOT NULL CHECK (artifact_role IN ('catalog', 'ticker', 'funding', 'open-interest', 'reference-price', 'traditional', 'derived-input', 'other')),
  artifact_format text NOT NULL CHECK (artifact_format ~ '^[a-z0-9][a-z0-9._-]{2,127}$'),
  storage_provider text NOT NULL DEFAULT 'vercel-blob' CHECK (storage_provider IN ('vercel-blob', 's3', 'gcs', 'azure-blob', 'other')),
  object_uri text,
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  content_type text,
  compression text NOT NULL DEFAULT 'none' CHECK (compression IN ('none', 'gzip', 'zstd', 'brotli')),
  byte_length bigint CHECK (byte_length IS NULL OR byte_length >= 0),
  captured_at timestamptz NOT NULL,
  archived_at timestamptz,
  retention_class text NOT NULL DEFAULT 'standard' CHECK (retention_class IN ('ephemeral', 'standard', 'compliance', 'permanent')),
  archive_status text NOT NULL DEFAULT 'pending' CHECK (archive_status IN ('pending', 'stored', 'failed', 'expired')),
  error_summary text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK (
    archive_status <> 'stored'
    OR (object_uri IS NOT NULL AND sha256 IS NOT NULL AND byte_length IS NOT NULL AND archived_at IS NOT NULL)
  ),
  UNIQUE (artifact_id, source_run_id),
  UNIQUE (source_run_id, artifact_kind, artifact_role, artifact_format, sha256),
  UNIQUE (storage_provider, object_uri)
);

CREATE TABLE IF NOT EXISTS ingest.sink_commit (
  sink_commit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES ingest.collection_attempt(attempt_id),
  sink_name text NOT NULL CHECK (length(btrim(sink_name)) > 0),
  status text NOT NULL CHECK (status IN ('pending', 'stored', 'skipped', 'failed')),
  row_count integer CHECK (row_count IS NULL OR row_count >= 0),
  checksum text CHECK (checksum IS NULL OR checksum ~ '^[0-9a-f]{64}$'),
  committed_at timestamptz,
  error_summary text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (attempt_id, sink_name)
);

CREATE TABLE IF NOT EXISTS identity.evidence (
  evidence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id bigint NOT NULL REFERENCES identity.source(source_id),
  source_run_id uuid NOT NULL,
  asset_id uuid REFERENCES identity.asset(asset_id),
  instrument_id uuid,
  raw_artifact_id uuid,
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('official-catalog', 'official-announcement', 'regulatory-filing', 'licensed-reference', 'dated-exception', 'manual-review')),
  official_uri text,
  observed_at timestamptz NOT NULL,
  evidence_sha256 text CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[0-9a-f]{64}$'),
  notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (asset_id IS NOT NULL OR instrument_id IS NOT NULL),
  FOREIGN KEY (source_run_id, source_id) REFERENCES ingest.source_run(source_run_id, source_id),
  FOREIGN KEY (instrument_id, source_id) REFERENCES identity.instrument(instrument_id, source_id),
  FOREIGN KEY (raw_artifact_id, source_run_id) REFERENCES ingest.raw_artifact(artifact_id, source_run_id),
  UNIQUE (source_run_id, instrument_id, evidence_kind)
);

CREATE TABLE IF NOT EXISTS identity.review_case (
  review_case_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id bigint NOT NULL REFERENCES identity.source(source_id),
  candidate_official_product_key text COLLATE "C" NOT NULL CHECK (length(candidate_official_product_key) > 0),
  candidate_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'verified', 'rejected', 'superseded')),
  resolved_asset_id uuid REFERENCES identity.asset(asset_id),
  resolved_instrument_id uuid REFERENCES identity.instrument(instrument_id),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  decision_note text,
  CHECK (jsonb_typeof(candidate_payload) = 'object'),
  CHECK (decided_at IS NULL OR decided_at >= opened_at),
  UNIQUE (source_id, candidate_official_product_key, status)
);

CREATE TABLE IF NOT EXISTS identity.asset_relation (
  asset_relation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_asset_version_id bigint NOT NULL REFERENCES identity.asset_version(asset_version_id),
  to_asset_version_id bigint NOT NULL REFERENCES identity.asset_version(asset_version_id),
  relation_type text NOT NULL CHECK (relation_type IN ('depositary-receipt-of', 'share-class-of', 'tracks', 'wrapped-claim-on', 'successor-of', 'other')),
  evidence_id uuid REFERENCES identity.evidence(evidence_id),
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_to timestamptz,
  CHECK (from_asset_version_id <> to_asset_version_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  UNIQUE (from_asset_version_id, to_asset_version_id, relation_type, valid_from)
);

CREATE TABLE IF NOT EXISTS ingest.catalog_membership (
  source_run_id uuid NOT NULL,
  instrument_version_id bigint NOT NULL,
  source_id bigint NOT NULL REFERENCES identity.source(source_id),
  presence_status text NOT NULL CHECK (presence_status IN ('present', 'absent', 'unknown')),
  official_catalog_position text COLLATE "C",
  normalized_attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(normalized_attributes) = 'object'),
  FOREIGN KEY (source_run_id, source_id) REFERENCES ingest.source_run(source_run_id, source_id),
  FOREIGN KEY (instrument_version_id, source_id) REFERENCES identity.instrument_version(instrument_version_id, source_id),
  PRIMARY KEY (source_run_id, instrument_version_id)
);

CREATE INDEX IF NOT EXISTS catalog_membership_instrument_observed_idx
  ON ingest.catalog_membership(instrument_version_id, observed_at DESC);

COMMENT ON COLUMN identity.instrument.official_product_key IS
  'Case-preserving official catalog key; never derive it from a normalized dashboard ticker.';

COMMENT ON TABLE ingest.raw_artifact IS
  'Object archive metadata only. Raw response bodies are stored outside Postgres.';

COMMENT ON TABLE ingest.catalog_membership IS
  'Exact official instrument membership. Partial or unavailable runs must use unknown and never manufacture absence.';

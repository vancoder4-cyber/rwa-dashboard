-- Phase 2 foundation: immutable, bitemporal market-fact revisions.
-- This migration deliberately enables no writer and changes no read path.
-- Exact typed facts may be shadow-written only after a separately reviewed
-- collector supplies a versioned policy and the required future partitions.

CREATE TABLE IF NOT EXISTS ops.market_fact_collection_policy (
  data_family text NOT NULL CHECK (data_family ~ '^[a-z0-9][a-z0-9._:-]{2,127}$'),
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-z0-9][a-z0-9._:/-]{2,127}$'),
  cadence_seconds integer NOT NULL CHECK (cadence_seconds > 0),
  event_grain text NOT NULL CHECK (event_grain IN ('point', 'hour', 'settlement', 'utc-day', 'session')),
  hot_overlap_seconds integer NOT NULL DEFAULT 0 CHECK (hot_overlap_seconds >= 0),
  cold_overlap_seconds integer NOT NULL DEFAULT 0 CHECK (cold_overlap_seconds >= hot_overlap_seconds),
  finality_lag_seconds integer NOT NULL DEFAULT 0 CHECK (finality_lag_seconds >= 0),
  retention_days integer NOT NULL CHECK (retention_days > 0),
  capture_policy text NOT NULL,
  writer_default_mode text NOT NULL DEFAULT 'off' CHECK (writer_default_mode = 'off'),
  read_default_mode text NOT NULL DEFAULT 'off' CHECK (read_default_mode = 'off'),
  effective_from timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (data_family, policy_version)
);

CREATE TABLE IF NOT EXISTS ops.market_fact_drift_policy (
  data_family text NOT NULL,
  policy_version text NOT NULL,
  field_family text NOT NULL CHECK (field_family IN ('price', 'quantity', 'funding-rate')),
  normal_relative_delta numeric(20, 10),
  review_relative_delta numeric(20, 10),
  normal_absolute_delta numeric(24, 16),
  review_absolute_delta numeric(24, 16),
  maximum_review_batch_fraction numeric(12, 10) NOT NULL DEFAULT 0.05,
  maximum_review_batch_rows integer NOT NULL DEFAULT 50,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (data_family, policy_version, field_family),
  FOREIGN KEY (data_family, policy_version)
    REFERENCES ops.market_fact_collection_policy(data_family, policy_version),
  CHECK (normal_relative_delta IS NULL OR normal_relative_delta >= 0),
  CHECK (review_relative_delta IS NULL OR review_relative_delta >= normal_relative_delta),
  CHECK (normal_absolute_delta IS NULL OR normal_absolute_delta >= 0),
  CHECK (review_absolute_delta IS NULL OR review_absolute_delta >= normal_absolute_delta),
  CHECK (maximum_review_batch_fraction BETWEEN 0 AND 1),
  CHECK (maximum_review_batch_rows > 0),
  CHECK (
    (field_family IN ('price', 'quantity')
      AND normal_relative_delta IS NOT NULL
      AND review_relative_delta IS NOT NULL)
    OR (field_family = 'funding-rate'
      AND normal_absolute_delta IS NOT NULL
      AND review_absolute_delta IS NOT NULL)
  )
);

INSERT INTO ops.market_fact_collection_policy (
  data_family, policy_version, cadence_seconds, event_grain,
  hot_overlap_seconds, cold_overlap_seconds, finality_lag_seconds,
  retention_days, capture_policy, effective_from
) VALUES (
  'listing-market-hourly', 'listing-market-fact/v1', 3600, 'hour',
  21600, 172800, 0, 400,
  'Append exact current observations; re-read a six-hour hot window and a 48-hour daily cold window only where the official source exposes historical facts.',
  '2026-08-20T00:00:00Z'::timestamptz
)
ON CONFLICT (data_family, policy_version) DO NOTHING;

INSERT INTO ops.market_fact_drift_policy (
  data_family, policy_version, field_family,
  normal_relative_delta, review_relative_delta,
  normal_absolute_delta, review_absolute_delta
) VALUES
  ('listing-market-hourly', 'listing-market-fact/v1', 'price', 0.005, 0.02, NULL, NULL),
  ('listing-market-hourly', 'listing-market-fact/v1', 'quantity', 0.01, 0.05, NULL, NULL),
  ('listing-market-hourly', 'listing-market-fact/v1', 'funding-rate', NULL, NULL, 0.00000001, 0.0001)
ON CONFLICT (data_family, policy_version, field_family) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS instrument_version_source_asset_revision_fk_idx
  ON identity.instrument_version(instrument_version_id, source_id, asset_version_id);

CREATE TABLE IF NOT EXISTS fact.market_fact_revision (
  revision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_key char(64) NOT NULL CHECK (observation_key ~ '^[0-9a-f]{64}$'),
  revision_no integer NOT NULL CHECK (revision_no > 0),
  supersedes_revision_id uuid UNIQUE REFERENCES fact.market_fact_revision(revision_id),
  data_family text NOT NULL,
  policy_version text NOT NULL,
  method_version text NOT NULL CHECK (method_version ~ '^[a-z0-9][a-z0-9._:/-]{2,127}$'),
  cycle_id uuid NOT NULL REFERENCES ingest.collection_cycle(cycle_id),
  source_run_id uuid NOT NULL,
  source_id bigint NOT NULL REFERENCES identity.source(source_id),
  instrument_version_id bigint NOT NULL,
  asset_version_id bigint NOT NULL REFERENCES identity.asset_version(asset_version_id),
  input_artifact_id uuid REFERENCES ingest.raw_artifact(artifact_id),
  event_at timestamptz NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NOT NULL,
  captured_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  quote_currency text NOT NULL CHECK (quote_currency ~ '^[A-Z0-9][A-Z0-9._-]{1,15}$'),
  native_currency text CHECK (native_currency IS NULL OR native_currency ~ '^[A-Z0-9][A-Z0-9._-]{1,15}$'),
  normalized_payload_sha256 char(64) NOT NULL CHECK (normalized_payload_sha256 ~ '^[0-9a-f]{64}$'),
  revision_disposition text NOT NULL CHECK (revision_disposition IN ('initial', 'normal-restatement', 'late-completion')),
  reason_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (data_family, policy_version)
    REFERENCES ops.market_fact_collection_policy(data_family, policy_version),
  FOREIGN KEY (source_run_id, source_id)
    REFERENCES ingest.source_run(source_run_id, source_id),
  FOREIGN KEY (instrument_version_id, source_id, asset_version_id)
    REFERENCES identity.instrument_version(instrument_version_id, source_id, asset_version_id),
  FOREIGN KEY (input_artifact_id, source_run_id)
    REFERENCES ingest.raw_artifact(artifact_id, source_run_id),
  UNIQUE (observation_key, revision_no),
  UNIQUE (observation_key, normalized_payload_sha256),
  CHECK (valid_to > valid_from),
  CHECK (event_at >= valid_from AND event_at < valid_to),
  CHECK (captured_at >= event_at - interval '7 days'),
  CHECK (captured_at <= recorded_at + interval '5 minutes'),
  CHECK (
    (revision_no = 1 AND supersedes_revision_id IS NULL AND revision_disposition = 'initial')
    OR (revision_no > 1 AND supersedes_revision_id IS NOT NULL AND revision_disposition <> 'initial')
  )
);

CREATE INDEX IF NOT EXISTS market_fact_revision_instrument_valid_idx
  ON fact.market_fact_revision(instrument_version_id, valid_from DESC, revision_no DESC);

CREATE INDEX IF NOT EXISTS market_fact_revision_source_captured_idx
  ON fact.market_fact_revision(source_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS fact.listing_market_fact_revision (
  valid_from timestamptz NOT NULL,
  revision_id uuid NOT NULL REFERENCES fact.market_fact_revision(revision_id),
  last_price numeric(38, 12),
  mark_price numeric(38, 12),
  reference_price_usd numeric(38, 12),
  volume_24h_native numeric(38, 12),
  volume_24h_usd numeric(38, 4),
  open_interest_native numeric(38, 12),
  open_interest_usd numeric(38, 4),
  funding_rate numeric(24, 16),
  price_change_24h_pct numeric(20, 8),
  price_status text NOT NULL CHECK (price_status IN ('full', 'partial', 'estimated', 'unavailable')),
  volume_status text NOT NULL CHECK (volume_status IN ('full', 'partial', 'estimated', 'unavailable')),
  open_interest_status text NOT NULL CHECK (open_interest_status IN ('full', 'partial', 'estimated', 'unavailable')),
  funding_status text NOT NULL CHECK (funding_status IN ('full', 'partial', 'estimated', 'unavailable')),
  volume_method text,
  open_interest_method text,
  reference_price_method text,
  quality_flags text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (valid_from, revision_id),
  CHECK (last_price IS NULL OR last_price >= 0),
  CHECK (mark_price IS NULL OR mark_price >= 0),
  CHECK (reference_price_usd IS NULL OR reference_price_usd >= 0),
  CHECK (volume_24h_native IS NULL OR volume_24h_native >= 0),
  CHECK (volume_24h_usd IS NULL OR volume_24h_usd >= 0),
  CHECK (open_interest_native IS NULL OR open_interest_native >= 0),
  CHECK (open_interest_usd IS NULL OR open_interest_usd >= 0),
  CHECK (
    (price_status = 'unavailable' AND last_price IS NULL AND mark_price IS NULL AND reference_price_usd IS NULL AND price_change_24h_pct IS NULL)
    OR (price_status <> 'unavailable' AND (last_price IS NOT NULL OR mark_price IS NOT NULL OR reference_price_usd IS NOT NULL OR price_change_24h_pct IS NOT NULL))
  ),
  CHECK (
    (volume_status = 'unavailable' AND volume_24h_native IS NULL AND volume_24h_usd IS NULL)
    OR (volume_status <> 'unavailable' AND (volume_24h_native IS NOT NULL OR volume_24h_usd IS NOT NULL))
  ),
  CHECK (
    (open_interest_status = 'unavailable' AND open_interest_native IS NULL AND open_interest_usd IS NULL)
    OR (open_interest_status <> 'unavailable' AND (open_interest_native IS NOT NULL OR open_interest_usd IS NOT NULL))
  ),
  CHECK (
    (funding_status = 'unavailable' AND funding_rate IS NULL)
    OR (funding_status <> 'unavailable' AND funding_rate IS NOT NULL)
  ),
  CHECK (reference_price_usd IS NULL OR reference_price_method ~ '^[a-z0-9][a-z0-9._:/-]{2,127}$'),
  CHECK (volume_status = 'unavailable' OR volume_method ~ '^[a-z0-9][a-z0-9._:/-]{2,127}$'),
  CHECK (open_interest_status = 'unavailable' OR open_interest_method ~ '^[a-z0-9][a-z0-9._:/-]{2,127}$')
) PARTITION BY RANGE (valid_from);

CREATE OR REPLACE FUNCTION fact.ensure_listing_market_fact_partitions(reference_time timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, fact
AS $function$
DECLARE
  month_offset integer;
  partition_start timestamptz;
  partition_end timestamptz;
  partition_name text;
BEGIN
  FOR month_offset IN -1..2 LOOP
    partition_start := date_trunc('month', reference_time) + (month_offset * interval '1 month');
    partition_end := partition_start + interval '1 month';
    partition_name := format('listing_market_fact_revision_%s', to_char(partition_start AT TIME ZONE 'UTC', 'YYYY_MM'));
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS fact.%I PARTITION OF fact.listing_market_fact_revision FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      partition_start,
      partition_end
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON fact.%I (revision_id)',
      partition_name || '_revision_idx',
      partition_name
    );
  END LOOP;
END
$function$;

REVOKE ALL ON FUNCTION fact.ensure_listing_market_fact_partitions(timestamptz) FROM PUBLIC;
SELECT fact.ensure_listing_market_fact_partitions(clock_timestamp());

CREATE TABLE IF NOT EXISTS ops.market_fact_revision_review (
  review_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_key char(64) NOT NULL CHECK (observation_key ~ '^[0-9a-f]{64}$'),
  candidate_payload_sha256 char(64) NOT NULL CHECK (candidate_payload_sha256 ~ '^[0-9a-f]{64}$'),
  previous_revision_id uuid REFERENCES fact.market_fact_revision(revision_id),
  source_run_id uuid NOT NULL,
  source_id bigint NOT NULL REFERENCES identity.source(source_id),
  instrument_version_id bigint NOT NULL,
  asset_version_id bigint NOT NULL REFERENCES identity.asset_version(asset_version_id),
  data_family text NOT NULL,
  policy_version text NOT NULL,
  method_version text NOT NULL CHECK (method_version ~ '^[a-z0-9][a-z0-9._:/-]{2,127}$'),
  event_at timestamptz NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NOT NULL,
  quote_currency text NOT NULL CHECK (quote_currency ~ '^[A-Z0-9][A-Z0-9._-]{1,15}$'),
  native_currency text CHECK (native_currency IS NULL OR native_currency ~ '^[A-Z0-9][A-Z0-9._-]{1,15}$'),
  classification text NOT NULL CHECK (classification IN ('review-required', 'anomalous')),
  reason_codes text[] NOT NULL,
  comparison jsonb NOT NULL,
  candidate_payload jsonb NOT NULL,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (data_family, policy_version)
    REFERENCES ops.market_fact_collection_policy(data_family, policy_version),
  FOREIGN KEY (source_run_id, source_id)
    REFERENCES ingest.source_run(source_run_id, source_id),
  FOREIGN KEY (instrument_version_id, source_id, asset_version_id)
    REFERENCES identity.instrument_version(instrument_version_id, source_id, asset_version_id),
  UNIQUE (observation_key, candidate_payload_sha256),
  CHECK (valid_to > valid_from),
  CHECK (event_at >= valid_from AND event_at < valid_to),
  CHECK (cardinality(reason_codes) > 0),
  CHECK (jsonb_typeof(comparison) = 'object'),
  CHECK (jsonb_typeof(candidate_payload) = 'object')
);

CREATE OR REPLACE FUNCTION fact.reject_market_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'IMMUTABLE_MARKET_FACT_REVISION';
END
$function$;

CREATE OR REPLACE FUNCTION fact.validate_market_fact_revision_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  previous fact.market_fact_revision%ROWTYPE;
  source_run_cycle_id uuid;
BEGIN
  SELECT attempt.cycle_id INTO source_run_cycle_id
    FROM ingest.source_run run
    JOIN ingest.collection_attempt attempt ON attempt.attempt_id = run.attempt_id
    WHERE run.source_run_id = NEW.source_run_id
      AND run.source_id = NEW.source_id
      AND run.status IN ('full', 'partial')
      AND run.data_status IN ('full', 'partial');
  IF NOT FOUND OR source_run_cycle_id <> NEW.cycle_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'INVALID_MARKET_FACT_SOURCE_RUN';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM identity.instrument_version instrument_version
    JOIN identity.asset_version asset_version
      ON asset_version.asset_version_id = instrument_version.asset_version_id
    WHERE instrument_version.instrument_version_id = NEW.instrument_version_id
      AND instrument_version.source_id = NEW.source_id
      AND instrument_version.asset_version_id = NEW.asset_version_id
      AND instrument_version.identity_status = 'verified'
      AND instrument_version.official_status <> 'delisted'
      AND NEW.event_at >= instrument_version.valid_from
      AND (instrument_version.valid_to IS NULL OR NEW.event_at < instrument_version.valid_to)
      AND asset_version.identity_status = 'verified'
      AND NEW.event_at >= asset_version.valid_from
      AND (asset_version.valid_to IS NULL OR NEW.event_at < asset_version.valid_to)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'INVALID_MARKET_FACT_IDENTITY_VERSION';
  END IF;
  IF NEW.revision_no = 1 THEN
    RETURN NEW;
  END IF;
  SELECT * INTO previous
    FROM fact.market_fact_revision
    WHERE revision_id = NEW.supersedes_revision_id;
  IF NOT FOUND
    OR previous.observation_key <> NEW.observation_key
    OR previous.revision_no + 1 <> NEW.revision_no
    OR previous.source_id <> NEW.source_id
    OR previous.instrument_version_id <> NEW.instrument_version_id
    OR previous.asset_version_id <> NEW.asset_version_id
    OR previous.data_family <> NEW.data_family
    OR previous.policy_version <> NEW.policy_version
    OR previous.method_version <> NEW.method_version
    OR previous.event_at <> NEW.event_at
    OR previous.valid_from <> NEW.valid_from
    OR previous.valid_to <> NEW.valid_to
    OR previous.quote_currency <> NEW.quote_currency
    OR previous.native_currency IS DISTINCT FROM NEW.native_currency
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'INVALID_MARKET_FACT_REVISION_CHAIN';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION fact.require_listing_market_fact_typed_child()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.data_family = 'listing-market-hourly'
    AND NOT EXISTS (
      SELECT 1
      FROM fact.listing_market_fact_revision typed
      WHERE typed.revision_id = NEW.revision_id
        AND typed.valid_from = NEW.valid_from
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'MISSING_LISTING_MARKET_FACT_TYPED_CHILD';
  END IF;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION fact.validate_listing_market_fact_revision_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  header fact.market_fact_revision%ROWTYPE;
  previous_typed fact.listing_market_fact_revision%ROWTYPE;
BEGIN
  SELECT * INTO header
    FROM fact.market_fact_revision
    WHERE revision_id = NEW.revision_id;
  IF NOT FOUND
    OR header.data_family <> 'listing-market-hourly'
    OR header.valid_from <> NEW.valid_from
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'INVALID_LISTING_MARKET_FACT_HEADER';
  END IF;
  IF header.supersedes_revision_id IS NOT NULL THEN
    SELECT * INTO previous_typed
      FROM fact.listing_market_fact_revision existing
      WHERE existing.revision_id = header.supersedes_revision_id;
    IF NOT FOUND
      OR previous_typed.volume_method IS DISTINCT FROM NEW.volume_method
      OR previous_typed.open_interest_method IS DISTINCT FROM NEW.open_interest_method
      OR previous_typed.reference_price_method IS DISTINCT FROM NEW.reference_price_method
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'INVALID_LISTING_MARKET_FACT_METHOD_REVISION';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM fact.listing_market_fact_revision existing
    WHERE existing.revision_id = NEW.revision_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'DUPLICATE_LISTING_MARKET_FACT_REVISION';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION ops.reject_market_fact_control_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'IMMUTABLE_MARKET_FACT_CONTROL_RECORD';
END
$function$;

DROP TRIGGER IF EXISTS market_fact_revision_append_only ON fact.market_fact_revision;
CREATE TRIGGER market_fact_revision_append_only
BEFORE UPDATE OR DELETE ON fact.market_fact_revision
FOR EACH ROW EXECUTE FUNCTION fact.reject_market_fact_mutation();

DROP TRIGGER IF EXISTS market_fact_revision_chain ON fact.market_fact_revision;
CREATE TRIGGER market_fact_revision_chain
BEFORE INSERT ON fact.market_fact_revision
FOR EACH ROW EXECUTE FUNCTION fact.validate_market_fact_revision_insert();

DROP TRIGGER IF EXISTS market_fact_revision_typed_child ON fact.market_fact_revision;
CREATE CONSTRAINT TRIGGER market_fact_revision_typed_child
AFTER INSERT ON fact.market_fact_revision
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION fact.require_listing_market_fact_typed_child();

DROP TRIGGER IF EXISTS listing_market_fact_revision_append_only ON fact.listing_market_fact_revision;
CREATE TRIGGER listing_market_fact_revision_append_only
BEFORE UPDATE OR DELETE ON fact.listing_market_fact_revision
FOR EACH ROW EXECUTE FUNCTION fact.reject_market_fact_mutation();

DROP TRIGGER IF EXISTS listing_market_fact_revision_header ON fact.listing_market_fact_revision;
CREATE TRIGGER listing_market_fact_revision_header
BEFORE INSERT ON fact.listing_market_fact_revision
FOR EACH ROW EXECUTE FUNCTION fact.validate_listing_market_fact_revision_insert();

DROP TRIGGER IF EXISTS market_fact_collection_policy_append_only ON ops.market_fact_collection_policy;
CREATE TRIGGER market_fact_collection_policy_append_only
BEFORE UPDATE OR DELETE ON ops.market_fact_collection_policy
FOR EACH ROW EXECUTE FUNCTION ops.reject_market_fact_control_mutation();

DROP TRIGGER IF EXISTS market_fact_drift_policy_append_only ON ops.market_fact_drift_policy;
CREATE TRIGGER market_fact_drift_policy_append_only
BEFORE UPDATE OR DELETE ON ops.market_fact_drift_policy
FOR EACH ROW EXECUTE FUNCTION ops.reject_market_fact_control_mutation();

DROP TRIGGER IF EXISTS market_fact_revision_review_append_only ON ops.market_fact_revision_review;
CREATE TRIGGER market_fact_revision_review_append_only
BEFORE UPDATE OR DELETE ON ops.market_fact_revision_review
FOR EACH ROW EXECUTE FUNCTION ops.reject_market_fact_control_mutation();

CREATE OR REPLACE VIEW fact.listing_market_fact_revision_summary AS
WITH revisions AS (
  SELECT
    header.observation_key,
    header.revision_id,
    header.revision_no,
    header.instrument_version_id,
    header.asset_version_id,
    header.source_id,
    header.event_at,
    header.valid_from,
    header.valid_to,
    header.captured_at,
    header.recorded_at,
    header.method_version,
    header.policy_version,
    typed.last_price,
    typed.mark_price,
    typed.reference_price_usd,
    typed.volume_24h_native,
    typed.volume_24h_usd,
    typed.open_interest_native,
    typed.open_interest_usd,
    typed.funding_rate,
    typed.price_change_24h_pct,
    typed.price_status,
    typed.volume_status,
    typed.open_interest_status,
    typed.funding_status,
    first_value(typed.last_price) OVER observation_window AS first_last_price,
    first_value(typed.mark_price) OVER observation_window AS first_mark_price,
    first_value(typed.reference_price_usd) OVER observation_window AS first_reference_price_usd,
    first_value(typed.volume_24h_native) OVER observation_window AS first_volume_24h_native,
    first_value(typed.volume_24h_usd) OVER observation_window AS first_volume_24h_usd,
    first_value(typed.open_interest_native) OVER observation_window AS first_open_interest_native,
    first_value(typed.open_interest_usd) OVER observation_window AS first_open_interest_usd,
    first_value(typed.funding_rate) OVER observation_window AS first_funding_rate,
    first_value(typed.price_change_24h_pct) OVER observation_window AS first_price_change_24h_pct,
    lag(typed.last_price) OVER observation_order AS previous_last_price,
    lag(typed.mark_price) OVER observation_order AS previous_mark_price,
    lag(typed.reference_price_usd) OVER observation_order AS previous_reference_price_usd,
    lag(typed.volume_24h_native) OVER observation_order AS previous_volume_24h_native,
    lag(typed.volume_24h_usd) OVER observation_order AS previous_volume_24h_usd,
    lag(typed.open_interest_native) OVER observation_order AS previous_open_interest_native,
    lag(typed.open_interest_usd) OVER observation_order AS previous_open_interest_usd,
    lag(typed.funding_rate) OVER observation_order AS previous_funding_rate,
    lag(typed.price_change_24h_pct) OVER observation_order AS previous_price_change_24h_pct,
    count(*) OVER (PARTITION BY header.observation_key) - 1 AS revision_count,
    row_number() OVER (PARTITION BY header.observation_key ORDER BY header.revision_no DESC) AS latest_rank
  FROM fact.market_fact_revision header
  JOIN fact.listing_market_fact_revision typed
    ON typed.revision_id = header.revision_id
   AND typed.valid_from = header.valid_from
  WINDOW
    observation_window AS (
      PARTITION BY header.observation_key
      ORDER BY header.revision_no
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ),
    observation_order AS (
      PARTITION BY header.observation_key
      ORDER BY header.revision_no
    )
)
SELECT
  revisions.*,
  last_price - first_last_price AS last_price_latest_minus_first,
  last_price - previous_last_price AS last_price_latest_minus_previous,
  mark_price - first_mark_price AS mark_price_latest_minus_first,
  mark_price - previous_mark_price AS mark_price_latest_minus_previous,
  reference_price_usd - first_reference_price_usd AS reference_price_latest_minus_first,
  reference_price_usd - previous_reference_price_usd AS reference_price_latest_minus_previous,
  volume_24h_native - first_volume_24h_native AS volume_native_latest_minus_first,
  volume_24h_native - previous_volume_24h_native AS volume_native_latest_minus_previous,
  volume_24h_usd - first_volume_24h_usd AS volume_usd_latest_minus_first,
  volume_24h_usd - previous_volume_24h_usd AS volume_usd_latest_minus_previous,
  open_interest_native - first_open_interest_native AS open_interest_native_latest_minus_first,
  open_interest_native - previous_open_interest_native AS open_interest_native_latest_minus_previous,
  open_interest_usd - first_open_interest_usd AS open_interest_usd_latest_minus_first,
  open_interest_usd - previous_open_interest_usd AS open_interest_usd_latest_minus_previous,
  funding_rate - first_funding_rate AS funding_rate_latest_minus_first,
  funding_rate - previous_funding_rate AS funding_rate_latest_minus_previous,
  price_change_24h_pct - first_price_change_24h_pct AS price_change_latest_minus_first,
  price_change_24h_pct - previous_price_change_24h_pct AS price_change_latest_minus_previous,
  CASE WHEN first_last_price <> 0 THEN (last_price - first_last_price) / abs(first_last_price) END AS last_price_latest_vs_first_pct,
  CASE WHEN previous_last_price <> 0 THEN (last_price - previous_last_price) / abs(previous_last_price) END AS last_price_latest_vs_previous_pct,
  CASE WHEN first_mark_price <> 0 THEN (mark_price - first_mark_price) / abs(first_mark_price) END AS mark_price_latest_vs_first_pct,
  CASE WHEN previous_mark_price <> 0 THEN (mark_price - previous_mark_price) / abs(previous_mark_price) END AS mark_price_latest_vs_previous_pct,
  CASE WHEN first_reference_price_usd <> 0 THEN (reference_price_usd - first_reference_price_usd) / abs(first_reference_price_usd) END AS reference_price_latest_vs_first_pct,
  CASE WHEN previous_reference_price_usd <> 0 THEN (reference_price_usd - previous_reference_price_usd) / abs(previous_reference_price_usd) END AS reference_price_latest_vs_previous_pct,
  CASE WHEN first_volume_24h_native <> 0 THEN (volume_24h_native - first_volume_24h_native) / abs(first_volume_24h_native) END AS volume_native_latest_vs_first_pct,
  CASE WHEN previous_volume_24h_native <> 0 THEN (volume_24h_native - previous_volume_24h_native) / abs(previous_volume_24h_native) END AS volume_native_latest_vs_previous_pct,
  CASE WHEN first_volume_24h_usd <> 0 THEN (volume_24h_usd - first_volume_24h_usd) / abs(first_volume_24h_usd) END AS volume_usd_latest_vs_first_pct,
  CASE WHEN previous_volume_24h_usd <> 0 THEN (volume_24h_usd - previous_volume_24h_usd) / abs(previous_volume_24h_usd) END AS volume_usd_latest_vs_previous_pct,
  CASE WHEN first_open_interest_native <> 0 THEN (open_interest_native - first_open_interest_native) / abs(first_open_interest_native) END AS open_interest_native_latest_vs_first_pct,
  CASE WHEN previous_open_interest_native <> 0 THEN (open_interest_native - previous_open_interest_native) / abs(previous_open_interest_native) END AS open_interest_native_latest_vs_previous_pct,
  CASE WHEN first_open_interest_usd <> 0 THEN (open_interest_usd - first_open_interest_usd) / abs(first_open_interest_usd) END AS open_interest_usd_latest_vs_first_pct,
  CASE WHEN previous_open_interest_usd <> 0 THEN (open_interest_usd - previous_open_interest_usd) / abs(previous_open_interest_usd) END AS open_interest_usd_latest_vs_previous_pct,
  CASE WHEN first_funding_rate <> 0 THEN (funding_rate - first_funding_rate) / abs(first_funding_rate) END AS funding_rate_latest_vs_first_pct,
  CASE WHEN previous_funding_rate <> 0 THEN (funding_rate - previous_funding_rate) / abs(previous_funding_rate) END AS funding_rate_latest_vs_previous_pct,
  CASE WHEN first_price_change_24h_pct <> 0 THEN (price_change_24h_pct - first_price_change_24h_pct) / abs(first_price_change_24h_pct) END AS price_change_latest_vs_first_pct,
  CASE WHEN previous_price_change_24h_pct <> 0 THEN (price_change_24h_pct - previous_price_change_24h_pct) / abs(previous_price_change_24h_pct) END AS price_change_latest_vs_previous_pct
FROM revisions
WHERE latest_rank = 1;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rwa_market_fact_shadow_writer') THEN
    CREATE ROLE rwa_market_fact_shadow_writer NOLOGIN;
  END IF;
END
$roles$;

DO $role_membership$
BEGIN
  EXECUTE format('GRANT rwa_market_fact_shadow_writer TO %I', current_user);
END
$role_membership$;

GRANT USAGE ON SCHEMA ops, identity, ingest, fact TO rwa_market_fact_shadow_writer;
GRANT SELECT ON
  ops.market_fact_collection_policy,
  ops.market_fact_drift_policy,
  identity.source,
  identity.asset_version,
  identity.instrument_version,
  ingest.collection_cycle,
  ingest.collection_attempt,
  ingest.source_run,
  ingest.raw_artifact
TO rwa_market_fact_shadow_writer;
GRANT SELECT, INSERT ON
  fact.market_fact_revision,
  fact.listing_market_fact_revision,
  ops.market_fact_revision_review
TO rwa_market_fact_shadow_writer;
GRANT SELECT ON fact.listing_market_fact_revision_summary
TO rwa_market_fact_shadow_writer, rwa_analytics_reader;

REVOKE UPDATE, DELETE, TRUNCATE ON
  fact.market_fact_revision,
  fact.listing_market_fact_revision,
  ops.market_fact_revision_review
FROM rwa_market_fact_shadow_writer;

COMMENT ON TABLE fact.market_fact_revision IS
  'Immutable Phase 2 revision header. Exact identity, method, units, event/valid time and capture/system time form the observation contract.';

COMMENT ON TABLE fact.listing_market_fact_revision IS
  'Typed monthly-partitioned listing facts. NULL remains missing; observed zero remains zero. Existing Dashboard reads do not use this table.';

COMMENT ON TABLE ops.market_fact_revision_review IS
  'Append-only quarantine for review-range or anomalous restatements. Rows here never become accepted facts automatically.';

COMMENT ON VIEW fact.listing_market_fact_revision_summary IS
  'Read-only first/latest/revision-count and delta projection over immutable accepted listing fact revisions.';

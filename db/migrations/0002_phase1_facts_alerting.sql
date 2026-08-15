-- Phase 1: durable observations, reproducible analytics, publication lineage,
-- and a transactional alert outbox. Every market row is tied to a versioned
-- exact instrument or asset identity; no bare ticker is an identity key.

CREATE TABLE IF NOT EXISTS fact.listing_observation_hourly (
  observation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES ingest.collection_cycle(cycle_id),
  source_run_id uuid NOT NULL,
  instrument_version_id bigint NOT NULL,
  source_id bigint NOT NULL REFERENCES identity.source(source_id),
  asset_version_id bigint NOT NULL REFERENCES identity.asset_version(asset_version_id),
  input_artifact_id uuid REFERENCES ingest.raw_artifact(artifact_id),
  bucket_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  last_price numeric(38, 12),
  mark_price numeric(38, 12),
  reference_price_usd numeric(38, 12),
  volume_24h_native numeric(38, 12),
  volume_24h_usd numeric(38, 4),
  open_interest_native numeric(38, 12),
  open_interest_usd numeric(38, 4),
  funding_rate numeric(24, 16),
  price_change_24h_pct numeric(20, 8),
  volume_method text,
  open_interest_method text,
  reference_price_method text,
  price_status text NOT NULL DEFAULT 'unavailable' CHECK (price_status IN ('full', 'partial', 'estimated', 'unavailable')),
  volume_status text NOT NULL DEFAULT 'unavailable' CHECK (volume_status IN ('full', 'partial', 'estimated', 'unavailable')),
  open_interest_status text NOT NULL DEFAULT 'unavailable' CHECK (open_interest_status IN ('full', 'partial', 'estimated', 'unavailable')),
  funding_status text NOT NULL DEFAULT 'unavailable' CHECK (funding_status IN ('full', 'partial', 'estimated', 'unavailable')),
  quality_flags text[] NOT NULL DEFAULT ARRAY[]::text[],
  input_sha256 text CHECK (input_sha256 IS NULL OR input_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (last_price IS NULL OR last_price >= 0),
  CHECK (mark_price IS NULL OR mark_price >= 0),
  CHECK (reference_price_usd IS NULL OR reference_price_usd >= 0),
  CHECK (volume_24h_native IS NULL OR volume_24h_native >= 0),
  CHECK (volume_24h_usd IS NULL OR volume_24h_usd >= 0),
  CHECK (open_interest_native IS NULL OR open_interest_native >= 0),
  CHECK (open_interest_usd IS NULL OR open_interest_usd >= 0),
  CHECK (observed_at >= bucket_at - interval '1 day'),
  FOREIGN KEY (source_run_id, source_id) REFERENCES ingest.source_run(source_run_id, source_id),
  FOREIGN KEY (instrument_version_id, source_id) REFERENCES identity.instrument_version(instrument_version_id, source_id),
  FOREIGN KEY (input_artifact_id, source_run_id) REFERENCES ingest.raw_artifact(artifact_id, source_run_id),
  UNIQUE (cycle_id, instrument_version_id, bucket_at)
);

CREATE INDEX IF NOT EXISTS listing_observation_instrument_bucket_idx
  ON fact.listing_observation_hourly(instrument_version_id, bucket_at DESC);

CREATE INDEX IF NOT EXISTS listing_observation_asset_bucket_idx
  ON fact.listing_observation_hourly(asset_version_id, bucket_at DESC);

CREATE TABLE IF NOT EXISTS fact.catalog_presence_daily (
  presence_day date NOT NULL,
  instrument_version_id bigint NOT NULL,
  source_run_id uuid NOT NULL,
  source_id bigint NOT NULL REFERENCES identity.source(source_id),
  presence_status text NOT NULL CHECK (presence_status IN ('present', 'absent')),
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  observation_count integer NOT NULL CHECK (observation_count > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (last_observed_at >= first_observed_at),
  FOREIGN KEY (source_run_id, source_id) REFERENCES ingest.source_run(source_run_id, source_id),
  FOREIGN KEY (instrument_version_id, source_id) REFERENCES identity.instrument_version(instrument_version_id, source_id),
  PRIMARY KEY (presence_day, instrument_version_id)
);

CREATE TABLE IF NOT EXISTS fact.top_trader_observation_hourly (
  observation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES ingest.collection_cycle(cycle_id),
  source_run_id uuid NOT NULL,
  instrument_version_id bigint NOT NULL,
  source_id bigint NOT NULL REFERENCES identity.source(source_id),
  input_artifact_id uuid REFERENCES ingest.raw_artifact(artifact_id),
  bucket_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  period text NOT NULL CHECK (period IN ('1h', '2h', '4h', '6h', '12h', '1d')),
  long_short_ratio numeric(20, 10),
  long_position_fraction numeric(20, 10),
  short_position_fraction numeric(20, 10),
  field_status text NOT NULL CHECK (field_status IN ('full', 'partial', 'estimated', 'unavailable')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (long_short_ratio IS NULL OR long_short_ratio >= 0),
  CHECK (long_position_fraction IS NULL OR long_position_fraction BETWEEN 0 AND 1),
  CHECK (short_position_fraction IS NULL OR short_position_fraction BETWEEN 0 AND 1),
  FOREIGN KEY (source_run_id, source_id) REFERENCES ingest.source_run(source_run_id, source_id),
  FOREIGN KEY (instrument_version_id, source_id) REFERENCES identity.instrument_version(instrument_version_id, source_id),
  FOREIGN KEY (input_artifact_id, source_run_id) REFERENCES ingest.raw_artifact(artifact_id, source_run_id),
  UNIQUE (cycle_id, instrument_version_id, bucket_at, period)
);

CREATE INDEX IF NOT EXISTS top_trader_instrument_bucket_idx
  ON fact.top_trader_observation_hourly(instrument_version_id, bucket_at DESC);

CREATE TABLE IF NOT EXISTS fact.traditional_observation_daily (
  observation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES ingest.collection_cycle(cycle_id),
  source_run_id uuid NOT NULL,
  source_id bigint NOT NULL REFERENCES identity.source(source_id),
  instrument_version_id bigint NOT NULL,
  asset_version_id bigint NOT NULL REFERENCES identity.asset_version(asset_version_id),
  input_artifact_id uuid REFERENCES ingest.raw_artifact(artifact_id),
  session_date date NOT NULL,
  market_timezone text NOT NULL,
  cash_close_price_usd numeric(38, 12),
  cash_volume_shares numeric(38, 4),
  cash_volume_usd numeric(38, 4),
  options_volume_contracts numeric(38, 4),
  options_notional_usd numeric(38, 4),
  total_traditional_value_usd numeric(38, 4),
  cash_status text NOT NULL DEFAULT 'unavailable' CHECK (cash_status IN ('full', 'partial', 'estimated', 'unavailable')),
  options_status text NOT NULL DEFAULT 'unavailable' CHECK (options_status IN ('full', 'partial', 'estimated', 'unavailable')),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (cash_close_price_usd IS NULL OR cash_close_price_usd >= 0),
  CHECK (cash_volume_shares IS NULL OR cash_volume_shares >= 0),
  CHECK (cash_volume_usd IS NULL OR cash_volume_usd >= 0),
  CHECK (options_volume_contracts IS NULL OR options_volume_contracts >= 0),
  CHECK (options_notional_usd IS NULL OR options_notional_usd >= 0),
  CHECK (total_traditional_value_usd IS NULL OR total_traditional_value_usd >= 0),
  FOREIGN KEY (source_run_id, source_id) REFERENCES ingest.source_run(source_run_id, source_id),
  FOREIGN KEY (instrument_version_id, source_id) REFERENCES identity.instrument_version(instrument_version_id, source_id),
  FOREIGN KEY (input_artifact_id, source_run_id) REFERENCES ingest.raw_artifact(artifact_id, source_run_id),
  UNIQUE (cycle_id, instrument_version_id, session_date)
);

CREATE INDEX IF NOT EXISTS traditional_observation_asset_session_idx
  ON fact.traditional_observation_daily(asset_version_id, session_date DESC);

CREATE TABLE IF NOT EXISTS analytics.cohort_version (
  cohort_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_version_id bigint NOT NULL REFERENCES identity.asset_version(asset_version_id),
  market text NOT NULL CHECK (market IN ('perp', 'spot', 'traditional')),
  formula_version text NOT NULL CHECK (length(btrim(formula_version)) > 0),
  cohort_fingerprint char(64) NOT NULL CHECK (cohort_fingerprint ~ '^[0-9a-f]{64}$'),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  UNIQUE (asset_version_id, market, formula_version, cohort_fingerprint),
  CONSTRAINT asset_cohort_version_no_overlap
    EXCLUDE USING gist (
      asset_version_id WITH =,
      market WITH =,
      formula_version WITH =,
      tstzrange(valid_from, valid_to, '[)') WITH &&
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS cohort_version_one_current
  ON analytics.cohort_version(asset_version_id, market, formula_version)
  WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS analytics.cohort_member (
  cohort_version_id uuid NOT NULL REFERENCES analytics.cohort_version(cohort_version_id),
  instrument_version_id bigint NOT NULL REFERENCES identity.instrument_version(instrument_version_id),
  member_position integer NOT NULL CHECK (member_position > 0),
  volume_method text,
  open_interest_method text,
  member_fingerprint char(64) NOT NULL CHECK (member_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (cohort_version_id, instrument_version_id),
  UNIQUE (cohort_version_id, member_position)
);

CREATE TABLE IF NOT EXISTS analytics.asset_hourly (
  asset_hourly_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES ingest.collection_cycle(cycle_id),
  cohort_version_id uuid NOT NULL REFERENCES analytics.cohort_version(cohort_version_id),
  bucket_at timestamptz NOT NULL,
  current_volume_24h_usd numeric(38, 4),
  current_open_interest_usd numeric(38, 4),
  weighted_funding_rate numeric(24, 16),
  reference_price_usd numeric(38, 12),
  expected_listing_count integer NOT NULL CHECK (expected_listing_count >= 0),
  observed_volume_count integer NOT NULL CHECK (observed_volume_count >= 0),
  observed_open_interest_count integer NOT NULL CHECK (observed_open_interest_count >= 0),
  volume_status text NOT NULL CHECK (volume_status IN ('full', 'partial', 'estimated', 'unavailable')),
  open_interest_status text NOT NULL CHECK (open_interest_status IN ('full', 'partial', 'estimated', 'unavailable')),
  funding_status text NOT NULL CHECK (funding_status IN ('full', 'partial', 'estimated', 'unavailable')),
  computed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (current_volume_24h_usd IS NULL OR current_volume_24h_usd >= 0),
  CHECK (current_open_interest_usd IS NULL OR current_open_interest_usd >= 0),
  CHECK (reference_price_usd IS NULL OR reference_price_usd >= 0),
  CHECK (observed_volume_count <= expected_listing_count),
  CHECK (observed_open_interest_count <= expected_listing_count),
  UNIQUE (cycle_id, cohort_version_id, bucket_at)
);

CREATE INDEX IF NOT EXISTS asset_hourly_cohort_bucket_idx
  ON analytics.asset_hourly(cohort_version_id, bucket_at DESC);

CREATE TABLE IF NOT EXISTS analytics.asset_daily_volume_anchor (
  anchor_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_version_id uuid NOT NULL REFERENCES analytics.cohort_version(cohort_version_id),
  anchor_day date NOT NULL,
  rolling_24h_volume_usd numeric(38, 4) NOT NULL CHECK (rolling_24h_volume_usd >= 0),
  anchor_method text NOT NULL CHECK (length(btrim(anchor_method)) > 0),
  field_status text NOT NULL CHECK (field_status IN ('full', 'partial', 'estimated')),
  source_asset_hourly_id uuid NOT NULL REFERENCES analytics.asset_hourly(asset_hourly_id),
  sealed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (cohort_version_id, anchor_day, anchor_method)
);

CREATE TABLE IF NOT EXISTS analytics.spot_listing_daily_anchor (
  anchor_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_version_id bigint NOT NULL REFERENCES identity.instrument_version(instrument_version_id),
  anchor_day date NOT NULL,
  rolling_24h_volume_usd numeric(38, 4) NOT NULL CHECK (rolling_24h_volume_usd >= 0),
  close_price numeric(38, 12),
  price_change_24h_pct numeric(20, 8),
  volume_method text NOT NULL,
  volume_status text NOT NULL CHECK (volume_status IN ('full', 'partial', 'estimated')),
  price_status text NOT NULL CHECK (price_status IN ('full', 'partial', 'estimated', 'unavailable')),
  source_observation_id uuid NOT NULL REFERENCES fact.listing_observation_hourly(observation_id),
  sealed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (close_price IS NULL OR close_price >= 0),
  UNIQUE (instrument_version_id, anchor_day, volume_method)
);

CREATE TABLE IF NOT EXISTS analytics.asset_daily_oi_close (
  close_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_version_id uuid NOT NULL REFERENCES analytics.cohort_version(cohort_version_id),
  close_day date NOT NULL,
  open_interest_usd numeric(38, 4) NOT NULL CHECK (open_interest_usd >= 0),
  close_method text NOT NULL,
  field_status text NOT NULL CHECK (field_status IN ('estimated')),
  source_asset_hourly_id uuid NOT NULL REFERENCES analytics.asset_hourly(asset_hourly_id),
  observed_at timestamptz NOT NULL,
  sealed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (extract(hour FROM observed_at AT TIME ZONE 'UTC') >= 22),
  UNIQUE (cohort_version_id, close_day, close_method)
);

CREATE TABLE IF NOT EXISTS analytics.signal_result (
  signal_result_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  result_key char(64) NOT NULL UNIQUE CHECK (result_key ~ '^[0-9a-f]{64}$'),
  cycle_id uuid NOT NULL REFERENCES ingest.collection_cycle(cycle_id),
  formula_version text NOT NULL,
  signal_type text NOT NULL,
  asset_version_id bigint REFERENCES identity.asset_version(asset_version_id),
  instrument_version_id bigint REFERENCES identity.instrument_version(instrument_version_id),
  cohort_version_id uuid REFERENCES analytics.cohort_version(cohort_version_id),
  evaluated_at timestamptz NOT NULL,
  trigger text NOT NULL,
  severity text CHECK (severity IS NULL OR severity IN ('info', 'low', 'medium', 'high', 'critical')),
  rank integer CHECK (rank IS NULL OR rank > 0),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_status text NOT NULL CHECK (field_status IN ('full', 'partial', 'estimated', 'unavailable')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(metrics) = 'object'),
  CHECK (asset_version_id IS NOT NULL OR instrument_version_id IS NOT NULL OR cohort_version_id IS NOT NULL),
  UNIQUE (cycle_id, formula_version, signal_type, trigger, asset_version_id, instrument_version_id, cohort_version_id)
);

CREATE INDEX IF NOT EXISTS signal_result_type_evaluated_idx
  ON analytics.signal_result(signal_type, evaluated_at DESC);

CREATE TABLE IF NOT EXISTS analytics.catalog_change_event (
  catalog_change_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id bigint NOT NULL REFERENCES identity.source(source_id),
  instrument_version_id bigint NOT NULL,
  detection_cycle_id uuid NOT NULL REFERENCES ingest.collection_cycle(cycle_id),
  previous_source_run_id uuid,
  current_source_run_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('listed', 'delisted', 'relisted', 'status-change')),
  effective_day date NOT NULL,
  baseline boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'confirmed', 'suppressed')),
  observed_at timestamptz NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(evidence) = 'object'),
  FOREIGN KEY (instrument_version_id, source_id) REFERENCES identity.instrument_version(instrument_version_id, source_id),
  FOREIGN KEY (previous_source_run_id, source_id) REFERENCES ingest.source_run(source_run_id, source_id),
  FOREIGN KEY (current_source_run_id, source_id) REFERENCES ingest.source_run(source_run_id, source_id),
  UNIQUE (source_id, instrument_version_id, event_type, effective_day)
);

CREATE INDEX IF NOT EXISTS catalog_change_event_observed_idx
  ON analytics.catalog_change_event(event_type, observed_at DESC);

CREATE TABLE IF NOT EXISTS publication.snapshot_manifest (
  snapshot_manifest_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES ingest.collection_cycle(cycle_id),
  snapshot_kind text NOT NULL CHECK (length(btrim(snapshot_kind)) > 0),
  formula_version text NOT NULL CHECK (length(btrim(formula_version)) > 0),
  cohort_version_id uuid REFERENCES analytics.cohort_version(cohort_version_id),
  artifact_id uuid REFERENCES ingest.raw_artifact(artifact_id),
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  row_count integer NOT NULL CHECK (row_count >= 0),
  generated_at timestamptz NOT NULL,
  valid_until timestamptz,
  status text NOT NULL CHECK (status IN ('full', 'partial', 'unavailable')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (valid_until IS NULL OR valid_until > generated_at),
  UNIQUE (cycle_id, snapshot_kind, formula_version, payload_sha256)
);

CREATE TABLE IF NOT EXISTS publication.latest_pointer (
  pointer_key text PRIMARY KEY CHECK (pointer_key ~ '^[a-z0-9][a-z0-9._:-]{2,191}$'),
  snapshot_manifest_id uuid NOT NULL REFERENCES publication.snapshot_manifest(snapshot_manifest_id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS alert.rule (
  rule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key text NOT NULL UNIQUE CHECK (rule_key ~ '^[a-z0-9][a-z0-9._:-]{2,191}$'),
  display_name text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('instrument', 'asset', 'cohort', 'system')),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS alert.rule_version (
  rule_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES alert.rule(rule_id),
  version integer NOT NULL CHECK (version > 0),
  formula_version text NOT NULL,
  configuration jsonb NOT NULL,
  configuration_sha256 char(64) NOT NULL CHECK (configuration_sha256 ~ '^[0-9a-f]{64}$'),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(configuration) = 'object'),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  UNIQUE (rule_id, version),
  UNIQUE (rule_id, configuration_sha256)
);

CREATE TABLE IF NOT EXISTS alert.evaluation_run (
  evaluation_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_version_id uuid NOT NULL REFERENCES alert.rule_version(rule_version_id),
  cycle_id uuid NOT NULL REFERENCES ingest.collection_cycle(cycle_id),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'complete', 'partial', 'failed', 'skipped')),
  evaluated_count integer NOT NULL DEFAULT 0 CHECK (evaluated_count >= 0),
  matched_count integer NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
  history_watermark timestamptz,
  error_summary text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK (matched_count <= evaluated_count),
  UNIQUE (rule_version_id, cycle_id)
);

CREATE TABLE IF NOT EXISTS alert.event (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_run_id uuid NOT NULL REFERENCES alert.evaluation_run(evaluation_run_id),
  signal_result_id uuid REFERENCES analytics.signal_result(signal_result_id),
  catalog_change_event_id uuid REFERENCES analytics.catalog_change_event(catalog_change_event_id),
  scope_type text NOT NULL CHECK (scope_type IN ('instrument', 'asset', 'cohort', 'system')),
  asset_version_id bigint REFERENCES identity.asset_version(asset_version_id),
  instrument_version_id bigint REFERENCES identity.instrument_version(instrument_version_id),
  cohort_version_id uuid REFERENCES analytics.cohort_version(cohort_version_id),
  event_type text NOT NULL,
  trigger text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  dedupe_key char(64) NOT NULL UNIQUE CHECK (dedupe_key ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'suppressed')),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  CHECK (jsonb_typeof(metrics) = 'object'),
  CHECK (
    (scope_type = 'instrument' AND instrument_version_id IS NOT NULL)
    OR (scope_type = 'asset' AND asset_version_id IS NOT NULL)
    OR (scope_type = 'cohort' AND cohort_version_id IS NOT NULL)
    OR (scope_type = 'system' AND asset_version_id IS NULL AND instrument_version_id IS NULL AND cohort_version_id IS NULL)
  ),
  CHECK (resolved_at IS NULL OR resolved_at >= observed_at)
);

CREATE INDEX IF NOT EXISTS alert_event_type_observed_idx
  ON alert.event(event_type, observed_at DESC);

CREATE TABLE IF NOT EXISTS alert.event_evidence (
  event_id uuid NOT NULL REFERENCES alert.event(event_id) ON DELETE CASCADE,
  evidence_order integer NOT NULL CHECK (evidence_order > 0),
  listing_observation_id uuid REFERENCES fact.listing_observation_hourly(observation_id),
  signal_result_id uuid REFERENCES analytics.signal_result(signal_result_id),
  raw_artifact_id uuid REFERENCES ingest.raw_artifact(artifact_id),
  evidence_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(evidence_payload) = 'object'),
  CHECK (listing_observation_id IS NOT NULL OR signal_result_id IS NOT NULL OR raw_artifact_id IS NOT NULL),
  PRIMARY KEY (event_id, evidence_order)
);

CREATE TABLE IF NOT EXISTS alert.incident (
  incident_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_key char(64) NOT NULL UNIQUE CHECK (incident_key ~ '^[0-9a-f]{64}$'),
  title text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  opened_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (acknowledged_at IS NULL OR acknowledged_at >= opened_at),
  CHECK (resolved_at IS NULL OR resolved_at >= opened_at)
);

CREATE TABLE IF NOT EXISTS alert.incident_event (
  incident_id uuid NOT NULL REFERENCES alert.incident(incident_id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES alert.event(event_id),
  added_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (incident_id, event_id)
);

CREATE TABLE IF NOT EXISTS alert.destination (
  destination_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_key text NOT NULL UNIQUE CHECK (destination_key ~ '^[a-z0-9][a-z0-9._:-]{2,191}$'),
  channel_type text NOT NULL CHECK (channel_type IN ('webhook', 'email', 'slack', 'lark', 'internal')),
  secret_ref text,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(configuration) = 'object')
);

CREATE TABLE IF NOT EXISTS alert.subscription (
  subscription_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES alert.rule(rule_id),
  destination_id uuid NOT NULL REFERENCES alert.destination(destination_id),
  minimum_severity text NOT NULL DEFAULT 'info' CHECK (minimum_severity IN ('info', 'low', 'medium', 'high', 'critical')),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (rule_id, destination_id)
);

CREATE TABLE IF NOT EXISTS alert.delivery (
  delivery_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES alert.event(event_id),
  subscription_id uuid NOT NULL REFERENCES alert.subscription(subscription_id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'sent', 'retry', 'failed', 'suppressed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (event_id, subscription_id)
);

CREATE TABLE IF NOT EXISTS alert.outbox (
  outbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL UNIQUE REFERENCES alert.delivery(delivery_id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_at timestamptz,
  lock_owner text,
  published_at timestamptz,
  dead_lettered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (published_at IS NULL OR published_at >= created_at),
  CHECK (dead_lettered_at IS NULL OR dead_lettered_at >= created_at)
);

CREATE INDEX IF NOT EXISTS alert_outbox_claim_idx
  ON alert.outbox(available_at, created_at)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;

CREATE TABLE IF NOT EXISTS alert.delivery_attempt (
  delivery_attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES alert.delivery(delivery_id) ON DELETE CASCADE,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'sent', 'retry', 'failed')),
  response_code integer,
  response_sha256 text CHECK (response_sha256 IS NULL OR response_sha256 ~ '^[0-9a-f]{64}$'),
  error_summary text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  UNIQUE (delivery_id, attempt_no)
);

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rwa_catalog_shadow_writer') THEN
    CREATE ROLE rwa_catalog_shadow_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rwa_analytics_reader') THEN
    CREATE ROLE rwa_analytics_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rwa_alert_dispatcher') THEN
    CREATE ROLE rwa_alert_dispatcher NOLOGIN;
  END IF;
END
$roles$;

DO $role_membership$
BEGIN
  EXECUTE format('GRANT rwa_catalog_shadow_writer TO %I', current_user);
END
$role_membership$;

GRANT USAGE ON SCHEMA identity, ingest, analytics TO rwa_catalog_shadow_writer;
GRANT SELECT, INSERT, UPDATE ON
  identity.source,
  identity.asset,
  identity.asset_version,
  identity.instrument,
  identity.instrument_version,
  identity.evidence,
  identity.review_case,
  ingest.collection_cycle,
  ingest.collection_attempt,
  ingest.source_run,
  ingest.raw_artifact,
  ingest.catalog_membership,
  ingest.sink_commit,
  analytics.catalog_change_event
TO rwa_catalog_shadow_writer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA identity, ingest TO rwa_catalog_shadow_writer;

GRANT USAGE ON SCHEMA identity, ingest, fact, analytics, publication TO rwa_analytics_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA identity, ingest, fact, analytics, publication TO rwa_analytics_reader;

GRANT USAGE ON SCHEMA identity, alert TO rwa_alert_dispatcher;
GRANT SELECT ON ALL TABLES IN SCHEMA identity, alert TO rwa_alert_dispatcher;
GRANT UPDATE ON alert.delivery, alert.outbox TO rwa_alert_dispatcher;
GRANT INSERT ON alert.delivery_attempt TO rwa_alert_dispatcher;

COMMENT ON TABLE analytics.cohort_version IS
  'Versioned exact listing cohort. Fingerprints must include venue, official symbol, and metric method.';

COMMENT ON TABLE alert.outbox IS
  'Insert in the same transaction as delivery; workers claim due rows with FOR UPDATE SKIP LOCKED.';

COMMENT ON COLUMN alert.destination.secret_ref IS
  'Reference to an external secret only. Never store delivery credentials in configuration JSON.';

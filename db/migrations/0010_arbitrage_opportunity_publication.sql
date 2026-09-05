-- Authoritative five-minute cash-and-carry observations and a frontend-safe
-- publication contract. Market facts retain exact versioned identities; the
-- public reader can see only the already validated JSON snapshot.

CREATE TABLE IF NOT EXISTS fact.arbitrage_route_observation (
  route_observation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES ingest.collection_cycle(cycle_id),
  asset_version_id bigint NOT NULL REFERENCES identity.asset_version(asset_version_id),
  spot_instrument_version_id bigint NOT NULL REFERENCES identity.instrument_version(instrument_version_id),
  perp_instrument_version_id bigint NOT NULL REFERENCES identity.instrument_version(instrument_version_id),
  route_id text COLLATE "C" NOT NULL CHECK (route_id ~ '^[A-Za-z0-9._:-]{1,240}$'),
  route_fingerprint char(64) NOT NULL CHECK (route_fingerprint ~ '^[0-9a-f]{64}$'),
  formula_version text NOT NULL CHECK (formula_version = 'rwa-arbitrage-opportunity-1.0'),
  bucket_at timestamptz NOT NULL,
  generated_at timestamptz NOT NULL,
  spot_observed_at timestamptz NOT NULL,
  perp_observed_at timestamptz NOT NULL,
  funding_observed_at timestamptz NOT NULL,
  spot_ask_price_usd numeric(38, 12) NOT NULL CHECK (spot_ask_price_usd > 0),
  spot_executable_depth_usd numeric(38, 4) NOT NULL CHECK (spot_executable_depth_usd >= 0),
  perp_bid_price_usd numeric(38, 12) NOT NULL CHECK (perp_bid_price_usd > 0),
  perp_executable_depth_usd numeric(38, 4) NOT NULL CHECK (perp_executable_depth_usd >= 0),
  perp_open_interest_usd numeric(38, 4) NOT NULL CHECK (perp_open_interest_usd >= 0),
  basis_pct numeric(20, 8) NOT NULL,
  basis_persistence_minutes integer NOT NULL CHECK (basis_persistence_minutes >= 0),
  current_funding_rate_pct numeric(24, 12) NOT NULL,
  funding_interval_hours numeric(12, 6) NOT NULL CHECK (funding_interval_hours > 0 AND funding_interval_hours <= 24),
  current_funding_annualized_pct numeric(24, 8) NOT NULL,
  average_24h_funding_annualized_pct numeric(24, 8) NOT NULL,
  consecutive_positive_settlements integer NOT NULL CHECK (consecutive_positive_settlements >= 0),
  short_receives boolean NOT NULL,
  settled_observation_count integer NOT NULL CHECK (settled_observation_count >= 2),
  input_sha256 char(64) NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (generated_at >= bucket_at AND generated_at < bucket_at + interval '5 minutes'),
  CHECK (generated_at - spot_observed_at BETWEEN interval '0 seconds' AND interval '3 minutes'),
  CHECK (generated_at - perp_observed_at BETWEEN interval '0 seconds' AND interval '3 minutes'),
  CHECK (abs(extract(epoch FROM (spot_observed_at - perp_observed_at))) <= 60),
  CHECK (short_receives = (current_funding_rate_pct > 0)),
  UNIQUE (cycle_id, route_id),
  UNIQUE (bucket_at, route_fingerprint, formula_version, input_sha256)
);

CREATE INDEX IF NOT EXISTS arbitrage_route_history_idx
  ON fact.arbitrage_route_observation(route_fingerprint, bucket_at DESC);

CREATE TABLE IF NOT EXISTS publication.arbitrage_opportunity_snapshot (
  snapshot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL UNIQUE REFERENCES ingest.collection_cycle(cycle_id),
  schema_version text NOT NULL CHECK (schema_version = 'rwa-arbitrage-opportunities/v1'),
  formula_version text NOT NULL CHECK (formula_version = 'rwa-arbitrage-opportunity-1.0'),
  bucket_at timestamptz NOT NULL,
  generated_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  route_count integer NOT NULL CHECK (route_count >= 0),
  payload jsonb NOT NULL,
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (generated_at >= bucket_at AND generated_at < bucket_at + interval '5 minutes'),
  CHECK (valid_until = generated_at + interval '10 minutes'),
  CHECK (payload->>'schemaVersion' = schema_version),
  CHECK (payload->>'formulaVersion' = formula_version),
  CHECK (payload->>'status' = 'full'),
  CHECK ((payload->'coverage'->>'complete')::boolean = true),
  CHECK ((payload->'coverage'->>'returnedRoutes')::integer = route_count),
  CHECK (jsonb_array_length(payload->'routes') = route_count),
  UNIQUE (bucket_at, payload_sha256)
);

CREATE INDEX IF NOT EXISTS arbitrage_snapshot_generated_idx
  ON publication.arbitrage_opportunity_snapshot(generated_at DESC, snapshot_id DESC);

CREATE OR REPLACE VIEW publication.arbitrage_opportunity_v1
WITH (security_barrier = true)
AS
SELECT snapshot_id::text AS snapshot_id, generated_at, valid_until, payload
FROM publication.arbitrage_opportunity_snapshot
WHERE schema_version = 'rwa-arbitrage-opportunities/v1'
  AND formula_version = 'rwa-arbitrage-opportunity-1.0';

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rwa_arbitrage_writer') THEN
    CREATE ROLE rwa_arbitrage_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rwa_arbitrage_reader') THEN
    CREATE ROLE rwa_arbitrage_reader NOLOGIN;
  END IF;
END
$roles$;

DO $role_membership$
BEGIN
  EXECUTE format('GRANT rwa_arbitrage_writer TO %I', current_user);
END
$role_membership$;

GRANT USAGE ON SCHEMA identity, ingest, fact, publication TO rwa_arbitrage_writer;
GRANT SELECT ON identity.source, identity.asset_version, identity.instrument_version TO rwa_arbitrage_writer;
GRANT SELECT, INSERT ON ingest.collection_cycle, ingest.collection_attempt, ingest.source_run, ingest.sink_commit TO rwa_arbitrage_writer;
GRANT INSERT, SELECT ON fact.arbitrage_route_observation TO rwa_arbitrage_writer;
GRANT INSERT, SELECT ON publication.arbitrage_opportunity_snapshot TO rwa_arbitrage_writer;

GRANT USAGE ON SCHEMA publication TO rwa_arbitrage_reader;
GRANT SELECT ON publication.arbitrage_opportunity_v1 TO rwa_arbitrage_reader;

REVOKE ALL ON fact.arbitrage_route_observation FROM PUBLIC, rwa_arbitrage_reader;
REVOKE ALL ON publication.arbitrage_opportunity_snapshot FROM PUBLIC, rwa_arbitrage_reader;
REVOKE ALL ON publication.arbitrage_opportunity_v1 FROM PUBLIC;
GRANT SELECT ON publication.arbitrage_opportunity_v1 TO rwa_arbitrage_reader;

COMMENT ON TABLE fact.arbitrage_route_observation IS
  'Append-only exact spot/perpetual route facts. No bare ticker is an identity key and settled funding is contract-specific.';

COMMENT ON TABLE publication.arbitrage_opportunity_snapshot IS
  'Validated full snapshots only. Missing or partial collection never replaces the last authoritative snapshot.';

COMMENT ON VIEW publication.arbitrage_opportunity_v1 IS
  'Dedicated-reader projection containing only the public arbitrage consumer payload; raw evidence and database identifiers are excluded.';

-- Bound the five-minute arbitrage working set. Every executable candidate is
-- needed for the 10-minute basis-persistence formula, but only policy-qualified
-- routes belong in the wide authoritative fact table. The compact table keeps
-- the exact versioned route identity needed by that rolling calculation.

CREATE TABLE IF NOT EXISTS fact.arbitrage_basis_observation (
  basis_observation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES ingest.collection_cycle(cycle_id),
  asset_version_id bigint NOT NULL REFERENCES identity.asset_version(asset_version_id),
  spot_instrument_version_id bigint NOT NULL REFERENCES identity.instrument_version(instrument_version_id),
  perp_instrument_version_id bigint NOT NULL REFERENCES identity.instrument_version(instrument_version_id),
  route_id text COLLATE "C" NOT NULL CHECK (route_id ~ '^[A-Za-z0-9._:-]{1,240}$'),
  route_fingerprint char(64) NOT NULL CHECK (route_fingerprint ~ '^[0-9a-f]{64}$'),
  formula_version text NOT NULL CHECK (formula_version = 'rwa-arbitrage-opportunity-1.0'),
  bucket_at timestamptz NOT NULL,
  generated_at timestamptz NOT NULL,
  basis_pct numeric(20, 8) NOT NULL,
  input_sha256 char(64) NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (generated_at >= bucket_at AND generated_at < bucket_at + interval '5 minutes'),
  UNIQUE (cycle_id, route_id),
  UNIQUE (bucket_at, route_fingerprint, formula_version)
);

CREATE INDEX IF NOT EXISTS arbitrage_basis_history_idx
  ON fact.arbitrage_basis_observation(route_fingerprint, bucket_at DESC);

-- Retention and capacity probes filter globally by time rather than by route.
-- Keep a dedicated time index so cleanup cost stays proportional to the fixed
-- batch size even when the historical table is already large.
CREATE INDEX IF NOT EXISTS arbitrage_basis_retention_idx
  ON fact.arbitrage_basis_observation(bucket_at);

CREATE INDEX IF NOT EXISTS arbitrage_route_retention_idx
  ON fact.arbitrage_route_observation(bucket_at);

-- Preserve only the still-relevant tail if this migration is rehearsed while
-- the migration-0010 writer is active. This is an idempotent forward backfill,
-- not a replay and cannot manufacture a public opportunity snapshot.
INSERT INTO fact.arbitrage_basis_observation
  (cycle_id, asset_version_id, spot_instrument_version_id, perp_instrument_version_id,
   route_id, route_fingerprint, formula_version, bucket_at, generated_at,
   basis_pct, input_sha256)
SELECT cycle_id, asset_version_id, spot_instrument_version_id, perp_instrument_version_id,
  route_id, route_fingerprint, formula_version, bucket_at, generated_at,
  basis_pct, input_sha256
FROM fact.arbitrage_route_observation
WHERE bucket_at >= clock_timestamp() - interval '2 hours'
ON CONFLICT (cycle_id, route_id) DO NOTHING;

CREATE OR REPLACE FUNCTION ops.prune_arbitrage_observation_history()
RETURNS TABLE (basis_rows_deleted integer, route_rows_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $bounded_retention$
DECLARE
  deleted_basis integer := 0;
  deleted_routes integer := 0;
BEGIN
  WITH victims AS (
    SELECT observation.ctid
    FROM fact.arbitrage_basis_observation AS observation
    WHERE observation.bucket_at < clock_timestamp() - interval '2 hours'
    ORDER BY observation.bucket_at
    LIMIT 10000
  )
  DELETE FROM fact.arbitrage_basis_observation AS observation
  USING victims
  WHERE observation.ctid = victims.ctid;
  GET DIAGNOSTICS deleted_basis = ROW_COUNT;

  -- Route facts are self-contained audit evidence for published routes. Six
  -- hours is comfortably beyond the public ten-minute freshness contract and
  -- the 30-minute persistence read, while batched deletion prevents one Cron
  -- from turning legacy cleanup into a long transaction.
  WITH victims AS (
    SELECT observation.ctid
    FROM fact.arbitrage_route_observation AS observation
    WHERE observation.bucket_at < clock_timestamp() - interval '6 hours'
    ORDER BY observation.bucket_at
    LIMIT 5000
  )
  DELETE FROM fact.arbitrage_route_observation AS observation
  USING victims
  WHERE observation.ctid = victims.ctid;
  GET DIAGNOSTICS deleted_routes = ROW_COUNT;

  RETURN QUERY SELECT deleted_basis, deleted_routes;
END
$bounded_retention$;

GRANT USAGE ON SCHEMA ops TO rwa_arbitrage_writer;
GRANT INSERT, SELECT ON fact.arbitrage_basis_observation TO rwa_arbitrage_writer;
REVOKE ALL ON fact.arbitrage_basis_observation FROM PUBLIC, rwa_arbitrage_reader;

REVOKE ALL ON FUNCTION ops.prune_arbitrage_observation_history() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.prune_arbitrage_observation_history() TO rwa_arbitrage_writer;

COMMENT ON TABLE fact.arbitrage_basis_observation IS
  'Bounded non-public working history for exact-route basis persistence; two-hour retention, never a public opportunity authority.';

COMMENT ON FUNCTION ops.prune_arbitrage_observation_history() IS
  'Fixed-window, fixed-batch retention guard for arbitrage basis working rows and published route facts; callers cannot choose a deletion scope.';

COMMENT ON TABLE fact.arbitrage_route_observation IS
  'Exact versioned facts for policy-qualified published routes. Candidate-only basis history is isolated in the bounded working table.';

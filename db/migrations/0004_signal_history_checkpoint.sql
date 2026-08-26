-- Durable Signal Radar history checkpoints.
-- Vercel Runtime Cache remains a low-latency replica, not the continuity
-- authority. The authenticated hourly writer replaces each bounded payload
-- atomically and rejects stale invocations by observed_at.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rwa_signal_history_writer') THEN
    CREATE ROLE rwa_signal_history_writer NOLOGIN;
  END IF;
END
$roles$;

DO $role_membership$
BEGIN
  EXECUTE format('GRANT rwa_signal_history_writer TO %I', current_user);
END
$role_membership$;

CREATE TABLE IF NOT EXISTS publication.signal_history_checkpoint (
  namespace text PRIMARY KEY CHECK (namespace IN (
    'rwa-signal-radar-v2',
    'rwa-signal-volume-daily-v1',
    'rwa-signal-spot-volume-price-history-v1',
    'rwa-signal-oi-liquidation-hourly-v1'
  )),
  formula_version text NOT NULL CHECK (formula_version ~ '^rwa-[a-z0-9.-]+$'),
  observed_at timestamptz NOT NULL,
  payload_text text NOT NULL,
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload_bytes integer NOT NULL CHECK (payload_bytes > 0 AND payload_bytes <= 1750000),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (octet_length(payload_text) = payload_bytes)
);

GRANT USAGE ON SCHEMA publication TO rwa_signal_history_writer;
GRANT SELECT, INSERT, UPDATE ON publication.signal_history_checkpoint
TO rwa_signal_history_writer;

COMMENT ON TABLE publication.signal_history_checkpoint IS
  'Bounded durable checkpoints for Signal Radar hourly/daily histories. Runtime Cache is a disposable read replica; stale writers cannot replace a newer observed_at.';

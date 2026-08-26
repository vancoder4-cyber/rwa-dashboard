import { createHash } from 'node:crypto';

import { databaseConfigured, runDatabaseTransaction } from './database.js';

export const SIGNAL_HISTORY_CHECKPOINT_ROLE = 'rwa_signal_history_writer';
export const SIGNAL_HISTORY_MAX_BYTES = 1_750_000;
export const SIGNAL_HISTORY_CHECKPOINTS = Object.freeze({
  'rwa-signal-radar-v2':'rwa-signal-radar-history-v2',
  'rwa-signal-volume-daily-v1':'rwa-perp-volume-history-v1',
  'rwa-signal-spot-volume-price-history-v1':'rwa-spot-volume-price-history-v1',
  'rwa-signal-oi-liquidation-hourly-v1':'rwa-oi-liquidation-history-v1',
});

const WRITE_MODES = new Set(['off', 'shadow', 'required']);

function mode(env = process.env) {
  const value = String(env?.PG_WRITE_MODE || 'off').trim().toLowerCase();
  if (!WRITE_MODES.has(value)) throw new TypeError('PG_WRITE_MODE must be off, shadow, or required');
  return value;
}

function checksum(payloadText) {
  return createHash('sha256').update(payloadText).digest('hex');
}

function safeError(error) {
  return String(error?.message || error || 'unknown error').trim().slice(0, 300);
}

function emptyResult(persistenceMode, status, error = null) {
  const entryStatus = ['off', 'unavailable', 'not-requested'].includes(status) ? status : 'empty';
  return {
    mode:persistenceMode,
    status,
    values:{},
    entries:Object.fromEntries(Object.keys(SIGNAL_HISTORY_CHECKPOINTS).map(namespace => [
      namespace,
      { status:entryStatus, observedAt:null },
    ])),
    error,
  };
}

export async function readSignalHistoryCheckpoints({
  env = process.env,
  runTransaction = runDatabaseTransaction,
} = {}) {
  const persistenceMode = mode(env);
  if (persistenceMode === 'off') return emptyResult('off', 'off');
  if (!databaseConfigured(env)) {
    return emptyResult(persistenceMode, 'unavailable', 'database is not configured');
  }
  try {
    const namespaces = Object.keys(SIGNAL_HISTORY_CHECKPOINTS);
    const [, rows] = await runTransaction(sql => [
      sql.query(`SET LOCAL ROLE ${SIGNAL_HISTORY_CHECKPOINT_ROLE}`),
      sql.query(
        `SELECT namespace, formula_version, observed_at, payload_text, payload_sha256, payload_bytes
         FROM publication.signal_history_checkpoint
         WHERE namespace = ANY($1::text[])
         ORDER BY namespace`,
        [namespaces],
      ),
    ], { readOnly:true });
    const result = emptyResult(persistenceMode, rows.length ? 'stored' : 'empty');
    for (const row of rows) {
      const namespace = String(row?.namespace || '');
      const payloadText = String(row?.payload_text || '');
      const bytes = Buffer.byteLength(payloadText, 'utf8');
      const expectedFormula = SIGNAL_HISTORY_CHECKPOINTS[namespace];
      const observedAtMs = Date.parse(row?.observed_at);
      if (!expectedFormula || row?.formula_version !== expectedFormula ||
          !Number.isFinite(observedAtMs) || bytes < 1 || bytes > SIGNAL_HISTORY_MAX_BYTES ||
          Number(row?.payload_bytes) !== bytes || row?.payload_sha256 !== checksum(payloadText)) {
        throw new TypeError(`Invalid durable history checkpoint for ${namespace || 'unknown namespace'}`);
      }
      result.values[namespace] = JSON.parse(payloadText);
      result.entries[namespace] = {
        status:'stored',
        observedAt:new Date(observedAtMs).toISOString(),
        bytes,
      };
    }
    return result;
  } catch (error) {
    return emptyResult(persistenceMode, 'unavailable', safeError(error));
  }
}

export async function writeSignalHistoryCheckpoints(values, observedAt, {
  env = process.env,
  runTransaction = runDatabaseTransaction,
} = {}) {
  const persistenceMode = mode(env);
  if (persistenceMode === 'off') return emptyResult('off', 'off');
  if (!databaseConfigured(env)) {
    return emptyResult(persistenceMode, 'unavailable', 'database is not configured');
  }
  const observedAtMs = Date.parse(observedAt);
  if (!Number.isFinite(observedAtMs)) throw new TypeError('observedAt must be a valid timestamp');
  const payloads = Object.entries(values || {}).map(([namespace, value]) => {
    const formulaVersion = SIGNAL_HISTORY_CHECKPOINTS[namespace];
    if (!formulaVersion) throw new TypeError(`Unsupported Signal history namespace: ${namespace}`);
    const payloadText = JSON.stringify(value);
    const bytes = Buffer.byteLength(payloadText, 'utf8');
    if (bytes < 1 || bytes > SIGNAL_HISTORY_MAX_BYTES) {
      throw new RangeError(`Signal history checkpoint ${namespace} exceeds ${SIGNAL_HISTORY_MAX_BYTES} bytes`);
    }
    return { namespace, formulaVersion, payloadText, bytes, checksum:checksum(payloadText) };
  });
  if (!payloads.length) return emptyResult(persistenceMode, 'not-requested');
  try {
    const results = await runTransaction(sql => [
      sql.query(`SET LOCAL ROLE ${SIGNAL_HISTORY_CHECKPOINT_ROLE}`),
      ...payloads.map(payload => sql.query(
        `INSERT INTO publication.signal_history_checkpoint
           (namespace, formula_version, observed_at, payload_text, payload_sha256, payload_bytes, updated_at)
         VALUES ($1, $2, $3::timestamptz, $4, $5, $6, clock_timestamp())
         ON CONFLICT (namespace) DO UPDATE SET
           formula_version = EXCLUDED.formula_version,
           observed_at = EXCLUDED.observed_at,
           payload_text = EXCLUDED.payload_text,
           payload_sha256 = EXCLUDED.payload_sha256,
           payload_bytes = EXCLUDED.payload_bytes,
           updated_at = clock_timestamp()
         WHERE publication.signal_history_checkpoint.observed_at < EXCLUDED.observed_at
            OR (publication.signal_history_checkpoint.observed_at = EXCLUDED.observed_at
                AND publication.signal_history_checkpoint.payload_sha256 = EXCLUDED.payload_sha256)
         RETURNING namespace, observed_at`,
        [payload.namespace, payload.formulaVersion, new Date(observedAtMs).toISOString(),
          payload.payloadText, payload.checksum, payload.bytes],
      )),
    ]);
    const result = emptyResult(persistenceMode, 'stored');
    payloads.forEach((payload, index) => {
      const row = results[index + 1]?.[0];
      result.entries[payload.namespace] = row
        ? { status:'stored', observedAt:new Date(row.observed_at).toISOString(), bytes:payload.bytes }
        : { status:'stale', observedAt:null, bytes:payload.bytes };
    });
    if (Object.values(result.entries).some(entry => entry.status === 'stale')) result.status = 'stale';
    return result;
  } catch (error) {
    return emptyResult(persistenceMode, 'unavailable', safeError(error));
  }
}

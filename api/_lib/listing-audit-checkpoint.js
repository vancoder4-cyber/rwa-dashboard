import { createHash } from 'node:crypto';

import {
  LISTING_AUDIT_SCHEMA_VERSION,
  LISTING_AUDIT_STATE_VERSION,
  LISTING_SOURCE_KEYS,
} from './listing-audit.js';
import {
  databaseConfigured,
  listingDatabaseConfigured,
  runDatabaseTransaction,
  runListingDatabaseTransaction,
} from './database.js';

export const LISTING_AUDIT_CHECKPOINT_KEY = 'rwa-listing-audit-v2';
export const LISTING_AUDIT_BUNDLE_FORMAT = 'rwa-listing-audit-bundle/v2';
export const LISTING_AUDIT_BUNDLE_VERSION = 2;
export const LISTING_AUDIT_CHECKPOINT_MAX_BYTES = 1_750_000;
export const LISTING_AUDIT_CHECKPOINT_READER_ROLE = 'rwa_listing_audit_reader';
export const LISTING_AUDIT_CHECKPOINT_WRITER_ROLE = 'rwa_catalog_shadow_writer';
export const LISTING_AUDIT_KNOWN_ENCODING = 'listing-row-array/v1';
export const LISTING_AUDIT_EVENTS_ENCODING = 'listing-event-array/v1';

const CHECKPOINT_WRITE_MODES = new Set(['off', 'shadow', 'required']);
const READ_MODES = new Set(['runtime-cache', 'dual-read', 'durable-fallback']);

function checksum(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeError(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s]+/gi, '[redacted-url]')
    .replace(/\b(?:password|token|secret)=([^\s&]+)/gi, '$1=[redacted]')
    .trim()
    .slice(0, 300);
}

function exactStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function timestampMilliseconds(value) {
  if (value instanceof Date) return value.getTime();
  return Date.parse(String(value || ''));
}

function validateCompactListingState(bundle, observedAtMs) {
  const state = bundle.state;
  const snapshot = bundle.snapshot;
  if (state.version !== LISTING_AUDIT_STATE_VERSION || state.knownEncoding !== LISTING_AUDIT_KNOWN_ENCODING ||
      state.eventsEncoding !== LISTING_AUDIT_EVENTS_ENCODING || !state.known || typeof state.known !== 'object' ||
      Array.isArray(state.known) || !state.sources || typeof state.sources !== 'object' || Array.isArray(state.sources) ||
      !Array.isArray(state.events) || Date.parse(String(state.updatedAt || '')) !== observedAtMs) {
    throw new TypeError('Listing Audit checkpoint compact state contract is invalid');
  }
  const sourceKeySet = new Set(LISTING_SOURCE_KEYS);
  const activeKeys = new Set();
  let activeListings = 0;
  let reviewRequired = 0;
  for (const [listingKey, row] of Object.entries(state.known)) {
    if (!Array.isArray(row) || row.length < 11 || !LISTING_SOURCE_KEYS.some(sourceKey => listingKey.startsWith(`${sourceKey}:`)) ||
        !['v', 'r'].includes(row[3]) || ![0, 1].includes(row[5])) {
      throw new TypeError('Listing Audit checkpoint known identity encoding is invalid');
    }
    if (row[5] === 1) {
      activeListings += 1;
      activeKeys.add(listingKey);
      if (row[3] === 'r') reviewRequired += 1;
    }
  }
  const referencedActiveKeys = new Set();
  for (const [sourceKey, source] of Object.entries(state.sources)) {
    if (!sourceKeySet.has(sourceKey) || source?.sourceKey !== sourceKey || !Array.isArray(source?.listingKeys) ||
        new Set(source.listingKeys).size !== source.listingKeys.length) {
      throw new TypeError('Listing Audit checkpoint source state is invalid');
    }
    for (const listingKey of source.listingKeys) {
      if (!String(listingKey).startsWith(`${sourceKey}:`) || !activeKeys.has(listingKey)) {
        throw new TypeError('Listing Audit checkpoint source state does not reference an active exact listing');
      }
      referencedActiveKeys.add(listingKey);
    }
  }
  if (!exactStrings([...activeKeys].sort(), [...referencedActiveKeys].sort())) {
    throw new TypeError('Listing Audit checkpoint active listings do not reconcile with source state');
  }
  const eventCounts = { n:0, r:0, d:0 };
  for (const row of state.events) {
    if (!Array.isArray(row) || row.length < 12 || !Object.hasOwn(eventCounts, row[2])) {
      throw new TypeError('Listing Audit checkpoint event encoding is invalid');
    }
    eventCounts[row[2]] += 1;
  }
  const counts = snapshot.counts;
  if (nonNegativeInteger(counts?.activeListings) !== activeListings ||
      nonNegativeInteger(counts?.retainedEvents) !== state.events.length ||
      nonNegativeInteger(counts?.new) !== eventCounts.n || nonNegativeInteger(counts?.relisted) !== eventCounts.r ||
      nonNegativeInteger(counts?.delisted) !== eventCounts.d ||
      nonNegativeInteger(counts?.reviewRequired) !== reviewRequired ||
      !Array.isArray(snapshot.pendingReviews) || snapshot.pendingReviews.length !== reviewRequired ||
      JSON.stringify(state.eventHistory) !== JSON.stringify(snapshot.history)) {
    throw new TypeError('Listing Audit checkpoint state and public counts do not reconcile');
  }
}

export function resolveListingCheckpointWriteMode(env = process.env) {
  const value = String(env?.LISTING_CHECKPOINT_WRITE_MODE || 'off').trim().toLowerCase();
  if (!CHECKPOINT_WRITE_MODES.has(value)) {
    throw new TypeError('LISTING_CHECKPOINT_WRITE_MODE must be off, shadow, or required');
  }
  return value;
}

export function resolveListingReadMode(env = process.env) {
  const value = String(env?.LISTING_READ_MODE || 'runtime-cache').trim().toLowerCase();
  if (!READ_MODES.has(value)) {
    throw new TypeError('LISTING_READ_MODE must be runtime-cache, dual-read, or durable-fallback');
  }
  return value;
}

export function prepareListingAuditCheckpoint(bundle, observedAt = bundle?.snapshot?.generatedAt) {
  const observedAtMs = timestampMilliseconds(observedAt);
  const snapshotAtMs = timestampMilliseconds(bundle?.snapshot?.generatedAt);
  if (bundle?.version !== LISTING_AUDIT_BUNDLE_VERSION || !bundle?.state || !bundle?.snapshot) {
    throw new TypeError('Listing Audit checkpoint requires a compact v2 bundle');
  }
  if (bundle.snapshot.schemaVersion !== LISTING_AUDIT_SCHEMA_VERSION) {
    throw new TypeError('Listing Audit checkpoint schema is incompatible');
  }
  if (!Number.isFinite(observedAtMs) || snapshotAtMs !== observedAtMs) {
    throw new TypeError('Listing Audit checkpoint timestamp does not match the snapshot');
  }
  validateCompactListingState(bundle, observedAtMs);
  const sourceKeys = (Array.isArray(bundle.snapshot.sources) ? bundle.snapshot.sources : [])
    .map(row => String(row?.sourceKey || ''))
    .sort();
  const expectedKeys = [...LISTING_SOURCE_KEYS].sort();
  if (!exactStrings(sourceKeys, expectedKeys) || bundle.snapshot.coverage?.expectedSources !== expectedKeys.length) {
    throw new TypeError('Listing Audit checkpoint must contain the exact ten-source set');
  }
  const activeListingCount = nonNegativeInteger(bundle.snapshot.counts?.activeListings);
  if (activeListingCount === null) {
    throw new TypeError('Listing Audit checkpoint active listing count is invalid');
  }
  const payloadText = JSON.stringify(bundle);
  const payloadBytes = Buffer.byteLength(payloadText, 'utf8');
  if (payloadBytes < 1 || payloadBytes > LISTING_AUDIT_CHECKPOINT_MAX_BYTES) {
    throw new RangeError(`Listing Audit checkpoint exceeds ${LISTING_AUDIT_CHECKPOINT_MAX_BYTES} bytes`);
  }
  return Object.freeze({
    checkpointKey:LISTING_AUDIT_CHECKPOINT_KEY,
    bundleFormat:LISTING_AUDIT_BUNDLE_FORMAT,
    schemaVersion:LISTING_AUDIT_SCHEMA_VERSION,
    observedAt:new Date(observedAtMs).toISOString(),
    payloadText,
    payloadSha256:checksum(payloadText),
    payloadBytes,
    sourceCount:expectedKeys.length,
    activeListingCount,
    bundle,
  });
}

function emptyReadResult(status, error = null) {
  return {
    status,
    bundle:null,
    observedAt:null,
    checksum:null,
    bytes:null,
    error,
  };
}

export async function readListingAuditCheckpoint({
  env = process.env,
  runTransaction = runListingDatabaseTransaction,
} = {}) {
  try {
    if (!listingDatabaseConfigured(env)) {
      return emptyReadResult('unavailable', 'dedicated listing reader database is not configured');
    }
    const [, identities, rows] = await runTransaction(sql => [
      sql.query(`SET LOCAL ROLE ${LISTING_AUDIT_CHECKPOINT_READER_ROLE}`),
      sql.query(
        `SELECT session_user::text AS session_user_name,
           current_user::text AS active_role_name,
           session_user <> (
             SELECT pg_get_userbyid(database_row.datdba)
             FROM pg_database AS database_row
             WHERE database_row.datname = current_database()
           ) AS is_not_database_owner,
           NOT COALESCE((SELECT role_row.rolsuper FROM pg_roles AS role_row WHERE role_row.rolname = session_user), true)
             AS is_not_superuser,
           NOT pg_has_role(session_user, '${LISTING_AUDIT_CHECKPOINT_WRITER_ROLE}', 'MEMBER')
             AS is_not_catalog_writer,
           pg_has_role(session_user, '${LISTING_AUDIT_CHECKPOINT_READER_ROLE}', 'MEMBER')
             AS is_checkpoint_reader`,
      ),
      sql.query(
        `SELECT checkpoint_key, bundle_format, schema_version, observed_at,
           payload_text, payload_sha256, payload_bytes, source_count, active_listing_count
         FROM publication.listing_audit_checkpoint
         WHERE checkpoint_key = $1`,
        [LISTING_AUDIT_CHECKPOINT_KEY],
      ),
    ], { readOnly:true });
    const identity = identities?.[0];
    if (identities?.length !== 1 || identity?.active_role_name !== LISTING_AUDIT_CHECKPOINT_READER_ROLE ||
        identity?.is_not_database_owner !== true || identity?.is_not_superuser !== true ||
        identity?.is_not_catalog_writer !== true || identity?.is_checkpoint_reader !== true) {
      throw new TypeError('Listing Audit checkpoint connection is not a dedicated least-privilege reader');
    }
    if (!Array.isArray(rows) || rows.length === 0) return emptyReadResult('empty');
    if (rows.length !== 1) throw new TypeError('Listing Audit checkpoint cardinality is invalid');
    const row = rows[0];
    const payloadText = String(row?.payload_text || '');
    const parsed = JSON.parse(payloadText);
    const prepared = prepareListingAuditCheckpoint(parsed, row?.observed_at);
    if (row?.checkpoint_key !== prepared.checkpointKey || row?.bundle_format !== prepared.bundleFormat ||
        row?.schema_version !== prepared.schemaVersion || row?.payload_sha256 !== prepared.payloadSha256 ||
        Number(row?.payload_bytes) !== prepared.payloadBytes || Number(row?.source_count) !== prepared.sourceCount ||
        Number(row?.active_listing_count) !== prepared.activeListingCount) {
      throw new TypeError('Listing Audit checkpoint metadata or checksum is invalid');
    }
    return {
      status:'stored',
      bundle:parsed,
      observedAt:prepared.observedAt,
      checksum:prepared.payloadSha256,
      bytes:prepared.payloadBytes,
      error:null,
    };
  } catch (error) {
    return emptyReadResult('unavailable', safeError(error));
  }
}

export async function writeListingAuditCheckpoint(bundle, observedAt, {
  env = process.env,
  runTransaction = runDatabaseTransaction,
} = {}) {
  const mode = resolveListingCheckpointWriteMode(env);
  if (mode === 'off') return { mode, status:'off', observedAt:null, checksum:null, bytes:null, error:null };
  if (!databaseConfigured(env)) {
    return { mode, status:'unavailable', observedAt:null, checksum:null, bytes:null, error:'database is not configured' };
  }
  let prepared;
  try {
    prepared = prepareListingAuditCheckpoint(bundle, observedAt);
  } catch (error) {
    return { mode, status:'unavailable', observedAt:null, checksum:null, bytes:null, error:safeError(error) };
  }
  try {
    const [, rows] = await runTransaction(sql => [
      sql.query(`SET LOCAL ROLE ${LISTING_AUDIT_CHECKPOINT_WRITER_ROLE}`),
      sql.query(
        `INSERT INTO publication.listing_audit_checkpoint
           (checkpoint_key, bundle_format, schema_version, source_cycle_id, observed_at,
            payload_text, payload_sha256, payload_bytes, source_count, active_listing_count, updated_at)
         SELECT $1, $2, $3, cycle.cycle_id, $4::timestamptz,
           $5, $6, $7, $8, $9, clock_timestamp()
         FROM ingest.collection_cycle AS cycle
         WHERE cycle.job_name = 'rwa-listing-audit'
           AND cycle.pipeline_version = 'rwa-listing-catalog-pg-shadow/v1'
           AND cycle.bucket_at = date_trunc('day', $4::timestamptz)
           AND cycle.completed_at = $4::timestamptz
           AND cycle.status IN ('complete', 'partial')
         ON CONFLICT (checkpoint_key) DO UPDATE SET
           bundle_format = EXCLUDED.bundle_format,
           schema_version = EXCLUDED.schema_version,
           source_cycle_id = EXCLUDED.source_cycle_id,
           observed_at = EXCLUDED.observed_at,
           payload_text = EXCLUDED.payload_text,
           payload_sha256 = EXCLUDED.payload_sha256,
           payload_bytes = EXCLUDED.payload_bytes,
           source_count = EXCLUDED.source_count,
           active_listing_count = EXCLUDED.active_listing_count,
           updated_at = clock_timestamp()
         WHERE publication.listing_audit_checkpoint.observed_at < EXCLUDED.observed_at
            OR (publication.listing_audit_checkpoint.observed_at = EXCLUDED.observed_at
                AND publication.listing_audit_checkpoint.payload_sha256 = EXCLUDED.payload_sha256)
         RETURNING checkpoint_key, observed_at`,
        [prepared.checkpointKey, prepared.bundleFormat, prepared.schemaVersion, prepared.observedAt,
          prepared.payloadText, prepared.payloadSha256, prepared.payloadBytes,
          prepared.sourceCount, prepared.activeListingCount],
      ),
    ]);
    const row = rows?.[0];
    return {
      mode,
      status:row ? 'stored' : 'stale',
      observedAt:row ? new Date(row.observed_at).toISOString() : null,
      checksum:prepared.payloadSha256,
      bytes:prepared.payloadBytes,
      error:null,
    };
  } catch (error) {
    return {
      mode,
      status:'unavailable',
      observedAt:null,
      checksum:prepared.payloadSha256,
      bytes:prepared.payloadBytes,
      error:safeError(error),
    };
  }
}

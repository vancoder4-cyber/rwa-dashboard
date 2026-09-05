import {
  arbitrageDatabaseConfigured,
  runArbitrageDatabaseTransaction,
} from './database.js';
import { validateArbitrageSnapshot } from './arbitrage-analysis.js';

export const ARBITRAGE_READER_ROLE = 'rwa_arbitrage_reader';
export const ARBITRAGE_PUBLICATION_VIEW = 'publication.arbitrage_opportunity_v1';

function rowValue(row, snake, camel = snake) {
  return row?.[snake] ?? row?.[camel];
}

export function buildArbitrageAuthorityQueries(sql) {
  if (!sql || typeof sql.query !== 'function') throw new TypeError('A read-only arbitrage query builder is required');
  return [
    sql.query(`SET LOCAL ROLE ${ARBITRAGE_READER_ROLE}`),
    sql.query(
      `SELECT current_user::text AS active_role_name,
         pg_has_role(session_user, '${ARBITRAGE_READER_ROLE}', 'member') AS is_reader_member,
         session_user <> (
           SELECT pg_get_userbyid(database_row.datdba)
           FROM pg_database AS database_row
           WHERE database_row.datname = current_database()
         ) AS is_not_database_owner,
         NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = session_user), true) AS is_not_superuser,
         has_table_privilege(current_user, '${ARBITRAGE_PUBLICATION_VIEW}', 'SELECT') AS is_publication_reader,
         NOT has_table_privilege(session_user, 'fact.arbitrage_route_observation', 'SELECT') AS cannot_read_route_facts,
         NOT has_table_privilege(session_user, 'publication.arbitrage_opportunity_snapshot', 'SELECT') AS cannot_read_raw_snapshots,
         NOT has_table_privilege(session_user, 'identity.instrument_version', 'SELECT') AS cannot_read_identity_tables`,
    ),
    sql.query(
      `SELECT snapshot_id, generated_at, valid_until, payload
       FROM ${ARBITRAGE_PUBLICATION_VIEW}
       ORDER BY generated_at DESC, snapshot_id DESC
       LIMIT 1`,
    ),
  ];
}

function readerRoleValid(row) {
  return rowValue(row, 'active_role_name', 'activeRoleName') === ARBITRAGE_READER_ROLE &&
    rowValue(row, 'is_reader_member', 'isReaderMember') === true &&
    rowValue(row, 'is_not_database_owner', 'isNotDatabaseOwner') === true &&
    rowValue(row, 'is_not_superuser', 'isNotSuperuser') === true &&
    rowValue(row, 'is_publication_reader', 'isPublicationReader') === true &&
    rowValue(row, 'cannot_read_route_facts', 'cannotReadRouteFacts') === true &&
    rowValue(row, 'cannot_read_raw_snapshots', 'cannotReadRawSnapshots') === true &&
    rowValue(row, 'cannot_read_identity_tables', 'cannotReadIdentityTables') === true;
}

export function arbitrageSnapshotFromAuthorityRows(roleRows, snapshotRows, options = {}) {
  if (!readerRoleValid(Array.isArray(roleRows) ? roleRows[0] : null)) {
    throw new TypeError('Arbitrage database login is not the dedicated least-privilege reader');
  }
  const row = Array.isArray(snapshotRows) ? snapshotRows[0] : null;
  if (!row) return null;
  const payloadValue = rowValue(row, 'payload');
  const payload = typeof payloadValue === 'string' ? JSON.parse(payloadValue) : payloadValue;
  const generatedAt = new Date(rowValue(row, 'generated_at', 'generatedAt')).toISOString();
  const validUntil = new Date(rowValue(row, 'valid_until', 'validUntil')).toISOString();
  if (payload?.generatedAt !== generatedAt || Date.parse(validUntil) !== Date.parse(generatedAt) + 10 * 60_000) {
    throw new TypeError('Arbitrage publication metadata does not match its payload');
  }
  const validation = validateArbitrageSnapshot(payload, { nowMs:options.nowMs });
  if (!validation.valid) throw new TypeError(validation.reason);
  return payload;
}

export async function readAuthoritativeArbitrageSnapshot(options = {}) {
  if (!arbitrageDatabaseConfigured()) return { status:'unavailable', payload:null, reason:'reader database is not configured' };
  try {
    const results = await runArbitrageDatabaseTransaction(
      transactionSql => buildArbitrageAuthorityQueries(transactionSql),
      { timeoutMs:10_000 },
    );
    const payload = arbitrageSnapshotFromAuthorityRows(results[1], results[2], options);
    return payload
      ? { status:'stored', payload, reason:null }
      : { status:'empty', payload:null, reason:'no authoritative arbitrage snapshot has been published' };
  } catch (error) {
    return { status:'unavailable', payload:null, reason:error?.message || 'authoritative arbitrage read failed' };
  }
}

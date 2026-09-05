import { neon } from '@neondatabase/serverless';

export const DATABASE_URL_ENV_KEY = 'DATABASE_URL';
export const DATABASE_URL_UNPOOLED_ENV_KEY = 'DATABASE_URL_UNPOOLED';
export const PREVIEW_DATABASE_URL_ENV_KEY = 'PREVIEW_NEON_DATABASE_URL';
export const PREVIEW_DATABASE_URL_UNPOOLED_ENV_KEY = 'PREVIEW_NEON_DATABASE_URL_UNPOOLED';
export const LISTING_DATABASE_URL_ENV_KEY = 'LISTING_DATABASE_URL';
export const PREVIEW_LISTING_DATABASE_URL_ENV_KEY = 'PREVIEW_NEON_LISTING_DATABASE_URL';
export const ARBITRAGE_DATABASE_URL_ENV_KEY = 'ARBITRAGE_DATABASE_URL';
export const PREVIEW_ARBITRAGE_DATABASE_URL_ENV_KEY = 'PREVIEW_NEON_ARBITRAGE_DATABASE_URL';
export const DATABASE_TRANSACTION_TIMEOUT_MS = 25_000;

let databaseSql = null;
let migrationDatabaseSql = null;
let listingDatabaseSql = null;
let arbitrageDatabaseSql = null;

export function databaseEnvironmentKeys(env = process.env) {
  if (String(env?.VERCEL_ENV || '').trim().toLowerCase() === 'preview') {
    return {
      pooled: PREVIEW_DATABASE_URL_ENV_KEY,
      unpooled: PREVIEW_DATABASE_URL_UNPOOLED_ENV_KEY,
    };
  }
  return {
    pooled: DATABASE_URL_ENV_KEY,
    unpooled: DATABASE_URL_UNPOOLED_ENV_KEY,
  };
}

export function databaseConnectionString(env = process.env) {
  const { pooled } = databaseEnvironmentKeys(env);
  const value = String(env?.[pooled] || '').trim();
  return value || null;
}

export function migrationDatabaseConnectionString(env = process.env) {
  const { unpooled } = databaseEnvironmentKeys(env);
  return String(env?.[unpooled] || '').trim() || databaseConnectionString(env);
}

export function listingDatabaseEnvironmentKey(env = process.env) {
  return String(env?.VERCEL_ENV || '').trim().toLowerCase() === 'preview'
    ? PREVIEW_LISTING_DATABASE_URL_ENV_KEY
    : LISTING_DATABASE_URL_ENV_KEY;
}

export function listingDatabaseConnectionString(env = process.env) {
  const key = listingDatabaseEnvironmentKey(env);
  const value = String(env?.[key] || '').trim();
  if (!value) return null;
  if (value === databaseConnectionString(env)) {
    throw new Error(`${key} must use a dedicated read-only login, not the writer/migration owner connection`);
  }
  return value;
}

export function arbitrageDatabaseEnvironmentKey(env = process.env) {
  return String(env?.VERCEL_ENV || '').trim().toLowerCase() === 'preview'
    ? PREVIEW_ARBITRAGE_DATABASE_URL_ENV_KEY
    : ARBITRAGE_DATABASE_URL_ENV_KEY;
}

export function arbitrageDatabaseConnectionString(env = process.env) {
  const key = arbitrageDatabaseEnvironmentKey(env);
  const value = String(env?.[key] || '').trim();
  if (!value) return null;
  if (value === databaseConnectionString(env)) {
    throw new Error(`${key} must use a dedicated read-only login, not the writer/migration owner connection`);
  }
  return value;
}

export function databaseConfigured(env = process.env) {
  return databaseConnectionString(env) !== null;
}

export function migrationDatabaseConfigured(env = process.env) {
  return migrationDatabaseConnectionString(env) !== null;
}

export function listingDatabaseConfigured(env = process.env) {
  return listingDatabaseConnectionString(env) !== null;
}

export function arbitrageDatabaseConfigured(env = process.env) {
  return arbitrageDatabaseConnectionString(env) !== null;
}

export function getDatabaseSql() {
  if (databaseSql) return databaseSql;

  const connectionString = databaseConnectionString();
  if (!connectionString) {
    const { pooled } = databaseEnvironmentKeys();
    throw new Error(`${pooled} is required for database access`);
  }

  databaseSql = neon(connectionString);
  return databaseSql;
}

export function getMigrationDatabaseSql() {
  if (migrationDatabaseSql) return migrationDatabaseSql;

  const connectionString = migrationDatabaseConnectionString();
  if (!connectionString) {
    const { pooled, unpooled } = databaseEnvironmentKeys();
    throw new Error(`${unpooled} or ${pooled} is required for database migrations`);
  }

  migrationDatabaseSql = neon(connectionString);
  return migrationDatabaseSql;
}

export function getListingDatabaseSql() {
  if (listingDatabaseSql) return listingDatabaseSql;

  const connectionString = listingDatabaseConnectionString();
  if (!connectionString) {
    const key = listingDatabaseEnvironmentKey();
    throw new Error(`${key} is required for the Listing Audit durable reader`);
  }

  listingDatabaseSql = neon(connectionString);
  return listingDatabaseSql;
}

export function getArbitrageDatabaseSql() {
  if (arbitrageDatabaseSql) return arbitrageDatabaseSql;

  const connectionString = arbitrageDatabaseConnectionString();
  if (!connectionString) {
    const key = arbitrageDatabaseEnvironmentKey();
    throw new Error(`${key} is required for the arbitrage durable reader`);
  }

  arbitrageDatabaseSql = neon(connectionString);
  return arbitrageDatabaseSql;
}

async function runTransaction(sql, buildQueries, options = {}) {
  if (typeof buildQueries !== 'function') {
    throw new TypeError('buildQueries must be a synchronous function');
  }

  const timeoutMs = Number(options.timeoutMs ?? DATABASE_TRANSACTION_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new RangeError('database transaction timeoutMs must be an integer between 1 and 60000');
  }
  const fetchOptions = { ...(options.fetchOptions || {}) };
  if (!fetchOptions.signal) fetchOptions.signal = AbortSignal.timeout(timeoutMs);

  return sql.transaction((transactionSql) => {
    const queries = buildQueries(transactionSql);
    if (!Array.isArray(queries) || queries.length === 0) {
      throw new TypeError('buildQueries must return a non-empty query array');
    }
    return queries;
  }, {
    isolationLevel: options.isolationLevel || 'Serializable',
    readOnly: options.readOnly === true,
    deferrable: options.deferrable === true,
    fetchOptions,
  });
}

export async function runDatabaseTransaction(buildQueries, options = {}) {
  return runTransaction(getDatabaseSql(), buildQueries, options);
}

export async function runListingDatabaseTransaction(buildQueries, options = {}) {
  return runTransaction(getListingDatabaseSql(), buildQueries, { ...options, readOnly:true });
}

export async function runArbitrageDatabaseTransaction(buildQueries, options = {}) {
  return runTransaction(getArbitrageDatabaseSql(), buildQueries, { ...options, readOnly:true });
}

export function resetDatabaseClientForTests() {
  databaseSql = null;
  migrationDatabaseSql = null;
  listingDatabaseSql = null;
  arbitrageDatabaseSql = null;
}

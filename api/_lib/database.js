import { neon } from '@neondatabase/serverless';

export const DATABASE_URL_ENV_KEY = 'DATABASE_URL';
export const DATABASE_URL_UNPOOLED_ENV_KEY = 'DATABASE_URL_UNPOOLED';
export const DATABASE_TRANSACTION_TIMEOUT_MS = 25_000;

let databaseSql = null;
let migrationDatabaseSql = null;

function databaseUrl(env = process.env) {
  const value = String(env?.[DATABASE_URL_ENV_KEY] || '').trim();
  return value || null;
}

export function databaseConfigured(env = process.env) {
  return databaseUrl(env) !== null;
}

export function migrationDatabaseConfigured(env = process.env) {
  return String(env?.[DATABASE_URL_UNPOOLED_ENV_KEY] || '').trim().length > 0 || databaseConfigured(env);
}

export function getDatabaseSql() {
  if (databaseSql) return databaseSql;

  const connectionString = databaseUrl();
  if (!connectionString) {
    throw new Error(`${DATABASE_URL_ENV_KEY} is required for database access`);
  }

  databaseSql = neon(connectionString);
  return databaseSql;
}

export function getMigrationDatabaseSql() {
  if (migrationDatabaseSql) return migrationDatabaseSql;

  const connectionString = String(process.env[DATABASE_URL_UNPOOLED_ENV_KEY] || '').trim() || databaseUrl();
  if (!connectionString) {
    throw new Error(`${DATABASE_URL_UNPOOLED_ENV_KEY} or ${DATABASE_URL_ENV_KEY} is required for database migrations`);
  }

  migrationDatabaseSql = neon(connectionString);
  return migrationDatabaseSql;
}

export async function runDatabaseTransaction(buildQueries, options = {}) {
  if (typeof buildQueries !== 'function') {
    throw new TypeError('buildQueries must be a synchronous function');
  }

  const timeoutMs = Number(options.timeoutMs ?? DATABASE_TRANSACTION_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new RangeError('database transaction timeoutMs must be an integer between 1 and 60000');
  }
  const fetchOptions = { ...(options.fetchOptions || {}) };
  if (!fetchOptions.signal) fetchOptions.signal = AbortSignal.timeout(timeoutMs);

  const sql = getDatabaseSql();
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

export function resetDatabaseClientForTests() {
  databaseSql = null;
  migrationDatabaseSql = null;
}

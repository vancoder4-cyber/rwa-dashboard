import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMigrationDatabaseSql } from '../api/_lib/database.js';
import { loadMigrations } from '../db/migration-utils.js';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../db/migrations');
const DRY_RUN = process.argv.includes('--dry-run');

const LEDGER_BOOTSTRAP = [
  'CREATE SCHEMA IF NOT EXISTS ops',
  `CREATE TABLE IF NOT EXISTS ops.schema_migration (
    version text PRIMARY KEY,
    name text NOT NULL,
    checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    statement_count integer NOT NULL CHECK (statement_count > 0),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`,
];

function log(message) {
  process.stdout.write(`${message}\n`);
}

const migrations = await loadMigrations(MIGRATION_DIRECTORY);
if (migrations.length === 0) throw new Error('No database migrations found');

if (DRY_RUN) {
  for (const migration of migrations) {
    log(`[dry-run] ${migration.version} ${migration.name} ${migration.checksum} (${migration.statements.length} statements)`);
  }
  process.exit(0);
}

const sql = getMigrationDatabaseSql();
await sql.transaction((transactionSql) => LEDGER_BOOTSTRAP.map((statement) => transactionSql.query(statement)));

for (const migration of migrations) {
  const appliedRows = await sql.query(
    'SELECT version, checksum FROM ops.schema_migration WHERE version = $1',
    [migration.version],
  );
  if (appliedRows.length > 0) {
    if (appliedRows[0].checksum !== migration.checksum) {
      throw new Error(`Migration checksum mismatch for ${migration.version}`);
    }
    log(`[skip] ${migration.version} ${migration.name}`);
    continue;
  }

  const lockKey = `rwa-dashboard-migration:${migration.version}`;
  const transactionResults = await sql.transaction((transactionSql) => [
    transactionSql.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]),
    transactionSql.query(
      `SELECT 1 / CASE WHEN EXISTS (
        SELECT 1 FROM ops.schema_migration WHERE version = $1 AND checksum <> $2
      ) THEN 0 ELSE 1 END AS checksum_guard`,
      [migration.version, migration.checksum],
    ),
    ...migration.statements.map((statement) => transactionSql.query(statement)),
    transactionSql.query(
      `INSERT INTO ops.schema_migration (version, name, checksum, statement_count)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (version) DO NOTHING
       RETURNING version`,
      [migration.version, migration.name, migration.checksum, migration.statements.length],
    ),
  ], { isolationLevel: 'Serializable' });

  const ledgerRows = transactionResults.at(-1);
  if (ledgerRows.length === 0) {
    const concurrentRows = await sql.query(
      'SELECT checksum FROM ops.schema_migration WHERE version = $1',
      [migration.version],
    );
    if (concurrentRows[0]?.checksum !== migration.checksum) {
      throw new Error(`Concurrent migration checksum mismatch for ${migration.version}`);
    }
  }
  log(`[apply] ${migration.version} ${migration.name}`);
}

log(`Database schema is current (${migrations.length} migrations).`);

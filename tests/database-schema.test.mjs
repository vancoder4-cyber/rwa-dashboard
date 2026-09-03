import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DATABASE_URL_ENV_KEY,
  DATABASE_URL_UNPOOLED_ENV_KEY,
  DATABASE_TRANSACTION_TIMEOUT_MS,
  LISTING_DATABASE_URL_ENV_KEY,
  PREVIEW_DATABASE_URL_ENV_KEY,
  PREVIEW_DATABASE_URL_UNPOOLED_ENV_KEY,
  PREVIEW_LISTING_DATABASE_URL_ENV_KEY,
  databaseConnectionString,
  databaseConfigured,
  databaseEnvironmentKeys,
  getDatabaseSql,
  getListingDatabaseSql,
  getMigrationDatabaseSql,
  listingDatabaseConfigured,
  listingDatabaseConnectionString,
  listingDatabaseEnvironmentKey,
  migrationDatabaseConnectionString,
  migrationDatabaseConfigured,
  resetDatabaseClientForTests,
} from '../api/_lib/database.js';
import {
  MIGRATION_FILE_PATTERN,
  loadMigrations,
  migrationChecksum,
  splitSqlStatements,
} from '../db/migration-utils.js';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIRECTORY = path.resolve(TEST_DIRECTORY, '..');
const MIGRATION_DIRECTORY = path.join(ROOT_DIRECTORY, 'db/migrations');

function compactSql(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

test('migration files are ordered, immutable-checksummed, and parse into statements', async () => {
  const migrations = await loadMigrations(MIGRATION_DIRECTORY);
  assert.deepEqual(migrations.map(row => row.filename), [
    '0001_phase0_foundation.sql',
    '0002_phase1_facts_alerting.sql',
    '0003_phase1_catalog_retry_replace.sql',
    '0004_signal_history_checkpoint.sql',
    '0005_listing_audit_checkpoint.sql',
    '0006_listing_event_authority.sql',
    '0007_sk_hynix_etf_identity_correction.sql',
  ]);
  assert.deepEqual(migrations.map(row => row.version), ['0001', '0002', '0003', '0004', '0005', '0006', '0007']);
  for (const migration of migrations) {
    assert.match(migration.filename, MIGRATION_FILE_PATTERN);
    assert.match(migration.checksum, /^[0-9a-f]{64}$/);
    assert.equal(migration.checksum, migrationChecksum(migration.sql));
    const minimumStatements = ['0003', '0004', '0005', '0006', '0007'].includes(migration.version) ? 3 : 11;
    assert.ok(migration.statements.length >= minimumStatements);
    assert.ok(migration.statements.every(statement => statement.trim().length > 0));
  }
});

test('reviewed SK Hynix ETF migration corrects identity without creating lifecycle events', async () => {
  const sql = await readFile(path.join(MIGRATION_DIRECTORY, '0007_sk_hynix_etf_identity_correction.sql'), 'utf8');
  assert.match(sql, /VALUES \('etf:SKDD'\), \('etf:SKUU'\)/);
  assert.match(sql, /old_asset_version\.category = 'equity'/);
  assert.match(sql, /old_asset_version\.canonical_underlying IN \('SKDD', 'SKUU'\)/);
  assert.match(sql, /SET asset_version_id = corrected_asset_version\.asset_version_id/);
  assert.doesNotMatch(sql, /(?:INSERT INTO|UPDATE|DELETE FROM) analytics\.catalog_change_event/);
  assert.doesNotMatch(sql, /asset_key\s*=\s*'(?:equity:)?SKHY(?:NIX)?'/,
    'the ETF correction must never persist an alias to SK Hynix equity');
});

test('SQL splitter preserves comments, quoted semicolons, and dollar-quoted role blocks', () => {
  const statements = splitSqlStatements(`
    -- semicolon ; inside a comment
    CREATE TABLE example (value text DEFAULT 'a;b');
    DO $roles$
    BEGIN
      PERFORM 'inside;block';
    END
    $roles$;
    /* another ; comment */ SELECT 1;
  `);
  assert.equal(statements.length, 3);
  assert.match(statements[0], /CREATE TABLE example/);
  assert.match(statements[1], /PERFORM 'inside;block';/);
  assert.match(statements[2], /SELECT 1/);
  assert.throws(() => splitSqlStatements("SELECT 'unterminated"), /unterminated/);
});

test('listing event authority reuses the fact table and exposes only safe read-only views', async () => {
  const sql = await readFile(path.join(MIGRATION_DIRECTORY, '0006_listing_event_authority.sql'), 'utf8');
  assert.match(sql, /ALTER TABLE analytics\.catalog_change_event/);
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS analytics\..*listing/i,
    'the migration must not create a second listing event table');
  assert.match(sql, /CREATE OR REPLACE VIEW publication\.listing_change_event_v1/);
  assert.match(sql, /CREATE OR REPLACE VIEW publication\.listing_audit_run_v1/);
  assert.match(sql, /CREATE OR REPLACE VIEW publication\.listing_audit_pending_review_v1/);
  assert.match(sql, /GRANT SELECT ON[\s\S]*publication\.listing_change_event_v1[\s\S]*TO rwa_listing_audit_reader/);
  assert.match(sql, /REVOKE ALL ON analytics\.catalog_change_event FROM rwa_listing_audit_reader/);
  assert.match(sql, /REVOKE ALL ON identity\.evidence FROM rwa_listing_audit_reader/);
  assert.match(sql, /Raw event evidence is intentionally excluded/);
  assert.doesNotMatch(sql, /GRANT SELECT ON analytics\.catalog_change_event TO rwa_listing_audit_reader/);
});

test('Phase 0 schema enforces exact SCD2 identity and idempotent ingestion lineage', async () => {
  const phase0 = await readFile(path.join(MIGRATION_DIRECTORY, '0001_phase0_foundation.sql'), 'utf8');
  const sql = compactSql(phase0);

  for (const schema of ['ops', 'identity', 'ingest', 'fact', 'analytics', 'publication', 'alert']) {
    assert.match(sql, new RegExp(`CREATE SCHEMA IF NOT EXISTS ${schema}`));
  }
  for (const table of [
    'identity.source',
    'identity.asset',
    'identity.asset_version',
    'identity.instrument',
    'identity.instrument_version',
    'identity.alias_version',
    'identity.evidence',
    'identity.review_case',
    'ingest.collection_cycle',
    'ingest.collection_attempt',
    'ingest.source_run',
    'ingest.raw_artifact',
    'ingest.catalog_membership',
    'ingest.sink_commit',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\(`));
  }

  assert.match(sql, /asset_key text COLLATE "C" NOT NULL UNIQUE CHECK \(asset_key ~ '\^\[a-z\]/);
  assert.match(sql, /UNIQUE \(source_id, official_product_key\)/);
  assert.match(sql, /official_product_key text COLLATE "C"/);
  assert.match(sql, /official_venue_symbol text COLLATE "C"/);
  assert.match(sql, /normalized_venue_symbol text NOT NULL/);
  assert.match(sql, /asset_version_no_overlap EXCLUDE USING gist/);
  assert.match(sql, /verified_asset_identity_no_overlap EXCLUDE USING gist/);
  assert.match(sql, /instrument_version_no_overlap EXCLUDE USING gist/);
  assert.match(sql, /verified_official_symbol_no_overlap EXCLUDE USING gist/);
  assert.match(sql, /instrument_alias_version_no_overlap EXCLUDE USING gist/);
  assert.match(sql, /UNIQUE \(job_name, pipeline_version, bucket_at\)/);
  assert.match(sql, /UNIQUE \(attempt_id, source_id, endpoint_key\)/);
  assert.match(sql, /PRIMARY KEY \(source_run_id, instrument_version_id\)/);
  assert.match(sql, /FOREIGN KEY \(source_run_id, source_id\) REFERENCES ingest\.source_run\(source_run_id, source_id\)/);
  assert.match(sql, /FOREIGN KEY \(instrument_version_id, source_id\) REFERENCES identity\.instrument_version\(instrument_version_id, source_id\)/);
  assert.match(sql, /FOREIGN KEY \(raw_artifact_id, source_run_id\) REFERENCES ingest\.raw_artifact\(artifact_id, source_run_id\)/);
  assert.match(sql, /UNIQUE \(source_run_id, instrument_id, evidence_kind\)/);

  assert.match(sql, /category IN \('equity', 'etf', 'commodity', 'fx', 'index', 'bond', 'fund', 'pre-ipo', 'other'\)/);
  assert.doesNotMatch(sql, /category IN \([^)]*'forex'/);
  assert.doesNotMatch(sql, /category IN \([^)]*'preipo'/);
});

test('archive metadata distinguishes raw and normalized artifacts without storing bodies', async () => {
  const phase0 = await readFile(path.join(MIGRATION_DIRECTORY, '0001_phase0_foundation.sql'), 'utf8');
  const table = phase0.slice(
    phase0.indexOf('CREATE TABLE IF NOT EXISTS ingest.raw_artifact'),
    phase0.indexOf('CREATE TABLE IF NOT EXISTS ingest.sink_commit'),
  );
  for (const column of [
    'environment',
    'deployment_sha',
    'artifact_kind',
    'artifact_role',
    'artifact_format',
    'storage_provider',
    'object_uri',
    'sha256',
    'compression',
    'byte_length',
    'captured_at',
    'retention_class',
    'archive_status',
    'metadata',
  ]) {
    assert.match(table, new RegExp(`\\b${column}\\b`));
  }
  assert.match(table, /artifact_kind IN \('raw', 'normalized'\)/);
  assert.match(table, /archive_status <> 'stored'[\s\S]*object_uri IS NOT NULL[\s\S]*sha256 IS NOT NULL/);
  assert.doesNotMatch(table, /^\s*(body|payload|response_body)\s+/mi);
});

test('Phase 1 facts, cohorts, publication, and alert outbox retain versioned foreign keys', async () => {
  const phase1 = await readFile(path.join(MIGRATION_DIRECTORY, '0002_phase1_facts_alerting.sql'), 'utf8');
  const sql = compactSql(phase1);
  for (const table of [
    'fact.listing_observation_hourly',
    'fact.catalog_presence_daily',
    'fact.top_trader_observation_hourly',
    'fact.traditional_observation_daily',
    'analytics.cohort_version',
    'analytics.cohort_member',
    'analytics.asset_hourly',
    'analytics.asset_daily_volume_anchor',
    'analytics.spot_listing_daily_anchor',
    'analytics.asset_daily_oi_close',
    'analytics.signal_result',
    'analytics.catalog_change_event',
    'publication.snapshot_manifest',
    'publication.latest_pointer',
    'alert.rule',
    'alert.rule_version',
    'alert.evaluation_run',
    'alert.event',
    'alert.delivery',
    'alert.outbox',
    'alert.delivery_attempt',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\(`));
  }

  assert.match(sql, /instrument_version_id bigint NOT NULL REFERENCES identity\.instrument_version/);
  assert.match(sql, /asset_version_id bigint NOT NULL REFERENCES identity\.asset_version/);
  assert.match(sql, /cohort_fingerprint char\(64\) NOT NULL/);
  assert.match(sql, /PRIMARY KEY \(cohort_version_id, instrument_version_id\)/);
  assert.match(sql, /UNIQUE \(source_id, instrument_version_id, event_type, effective_day\)/);
  assert.match(sql, /FOREIGN KEY \(current_source_run_id, source_id\) REFERENCES ingest\.source_run\(source_run_id, source_id\)/);
  assert.match(sql, /result_key char\(64\) NOT NULL UNIQUE/);
  assert.match(sql, /dedupe_key char\(64\) NOT NULL UNIQUE/);
  assert.match(sql, /delivery_id uuid NOT NULL UNIQUE REFERENCES alert\.delivery/);
  assert.match(sql, /alert_outbox_claim_idx[\s\S]*WHERE published_at IS NULL AND dead_lettered_at IS NULL/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);

  const allMigrations = `${await readFile(path.join(MIGRATION_DIRECTORY, '0001_phase0_foundation.sql'), 'utf8')}\n${phase1}`;
  assert.doesNotMatch(allMigrations, /^\s*(ticker|symbol)\s+/gmi);
});

test('database roles are NOLOGIN and grants separate catalog, read, and dispatch duties', async () => {
  const phase1 = compactSql(await readFile(path.join(MIGRATION_DIRECTORY, '0002_phase1_facts_alerting.sql'), 'utf8'));
  const catalogRetry = compactSql(await readFile(path.join(MIGRATION_DIRECTORY, '0003_phase1_catalog_retry_replace.sql'), 'utf8'));
  const signalHistory = compactSql(await readFile(path.join(MIGRATION_DIRECTORY, '0004_signal_history_checkpoint.sql'), 'utf8'));
  const listingCheckpoint = compactSql(await readFile(path.join(MIGRATION_DIRECTORY, '0005_listing_audit_checkpoint.sql'), 'utf8'));
  for (const role of ['rwa_catalog_shadow_writer', 'rwa_analytics_reader', 'rwa_alert_dispatcher']) {
    assert.match(phase1, new RegExp(`CREATE ROLE ${role} NOLOGIN`));
  }
  assert.match(phase1, /GRANT rwa_catalog_shadow_writer TO %I/);
  assert.match(phase1, /GRANT SELECT, INSERT, UPDATE ON identity\.source,[\s\S]*analytics\.catalog_change_event TO rwa_catalog_shadow_writer/);
  assert.doesNotMatch(phase1, /GRANT SELECT, INSERT, UPDATE ON ALL TABLES[\s\S]*rwa_catalog_shadow_writer/);
  assert.match(phase1, /GRANT SELECT ON ALL TABLES[\s\S]*TO rwa_analytics_reader/);
  assert.match(phase1, /GRANT UPDATE ON alert\.delivery, alert\.outbox TO rwa_alert_dispatcher/);
  assert.match(phase1, /GRANT INSERT ON alert\.delivery_attempt TO rwa_alert_dispatcher/);
  assert.match(catalogRetry, /GRANT DELETE ON identity\.evidence, ingest\.catalog_membership TO rwa_catalog_shadow_writer/);
  assert.doesNotMatch(catalogRetry, /GRANT DELETE ON (?:ALL TABLES|identity\.asset|identity\.instrument|analytics\.)/);
  assert.match(catalogRetry, /CREATE TABLE IF NOT EXISTS ingest\.catalog_publication_lease \(/);
  assert.match(catalogRetry, /lease_key text PRIMARY KEY/);
  assert.match(catalogRetry, /owner_token uuid NOT NULL/);
  assert.match(catalogRetry, /payload_checksum char\(64\) NOT NULL/);
  assert.match(catalogRetry, /lease_expires_at timestamptz NOT NULL/);
  assert.match(catalogRetry, /last_release_status IN \('published', 'failed'\)/);
  assert.match(catalogRetry, /CHECK \(lease_expires_at >= acquired_at\)/);
  assert.match(catalogRetry, /GRANT SELECT, INSERT, UPDATE ON ingest\.catalog_publication_lease TO rwa_catalog_shadow_writer/);
  assert.doesNotMatch(catalogRetry, /GRANT (?:ALL|DELETE)[^;]*catalog_publication_lease/);
  for (const [functionName, errorCode] of [
    ['ingest.reject_stale_catalog_retry', 'STALE_TRUSTED_LISTING_RETRY'],
    ['ingest.reject_catalog_identity_downgrade', 'UNTRUSTED_CATALOG_IDENTITY_DOWNGRADE'],
    ['ingest.reject_verified_catalog_identity_conflict', 'CONFLICTING_VERIFIED_CATALOG_IDENTITY'],
  ]) {
    const escapedFunctionName = functionName.replace('.', '\\.');
    assert.match(catalogRetry, new RegExp(`CREATE OR REPLACE FUNCTION ${escapedFunctionName}\\(\\)`));
    assert.match(catalogRetry, new RegExp(`MESSAGE = '${errorCode}'`));
    assert.match(catalogRetry, new RegExp(`GRANT EXECUTE ON FUNCTION ${escapedFunctionName}\\(\\) TO rwa_catalog_shadow_writer`));
  }
  assert.match(signalHistory, /CREATE ROLE rwa_signal_history_writer NOLOGIN/);
  assert.match(signalHistory, /GRANT rwa_signal_history_writer TO %I/);
  assert.match(signalHistory, /CREATE TABLE IF NOT EXISTS publication\.signal_history_checkpoint \(/);
  assert.match(signalHistory, /namespace text PRIMARY KEY/);
  assert.match(signalHistory, /payload_bytes integer NOT NULL CHECK \(payload_bytes > 0 AND payload_bytes <= 1750000\)/);
  assert.match(signalHistory, /GRANT SELECT, INSERT, UPDATE ON publication\.signal_history_checkpoint TO rwa_signal_history_writer/);
  assert.doesNotMatch(signalHistory, /GRANT (?:ALL|DELETE)/);
  assert.match(listingCheckpoint, /CREATE ROLE rwa_listing_audit_reader NOLOGIN/);
  assert.doesNotMatch(listingCheckpoint, /GRANT rwa_listing_audit_reader TO %I/);
  assert.match(listingCheckpoint, /CREATE TABLE IF NOT EXISTS publication\.listing_audit_checkpoint \(/);
  assert.match(listingCheckpoint, /source_cycle_id uuid NOT NULL REFERENCES ingest\.collection_cycle\(cycle_id\)/);
  assert.match(listingCheckpoint, /payload_bytes integer NOT NULL CHECK \(payload_bytes > 0 AND payload_bytes <= 1750000\)/);
  assert.match(listingCheckpoint, /GRANT SELECT ON publication\.listing_audit_checkpoint TO rwa_listing_audit_reader/);
  assert.match(listingCheckpoint, /GRANT USAGE ON SCHEMA publication TO rwa_catalog_shadow_writer/);
  assert.match(listingCheckpoint, /GRANT SELECT, INSERT, UPDATE ON publication\.listing_audit_checkpoint TO rwa_catalog_shadow_writer/);
  assert.doesNotMatch(listingCheckpoint, /GRANT (?:ALL|DELETE)/);
});

test('Neon clients remain lazy and migrations prefer the unpooled URL', () => {
  assert.equal(DATABASE_TRANSACTION_TIMEOUT_MS, 25_000);
  const originalPooled = process.env[DATABASE_URL_ENV_KEY];
  const originalUnpooled = process.env[DATABASE_URL_UNPOOLED_ENV_KEY];
  const originalPreviewPooled = process.env[PREVIEW_DATABASE_URL_ENV_KEY];
  const originalPreviewUnpooled = process.env[PREVIEW_DATABASE_URL_UNPOOLED_ENV_KEY];
  const originalListing = process.env[LISTING_DATABASE_URL_ENV_KEY];
  const originalPreviewListing = process.env[PREVIEW_LISTING_DATABASE_URL_ENV_KEY];
  const originalVercelEnv = process.env.VERCEL_ENV;
  try {
    delete process.env.VERCEL_ENV;
    delete process.env[DATABASE_URL_ENV_KEY];
    delete process.env[DATABASE_URL_UNPOOLED_ENV_KEY];
    delete process.env[PREVIEW_DATABASE_URL_ENV_KEY];
    delete process.env[PREVIEW_DATABASE_URL_UNPOOLED_ENV_KEY];
    delete process.env[LISTING_DATABASE_URL_ENV_KEY];
    delete process.env[PREVIEW_LISTING_DATABASE_URL_ENV_KEY];
    resetDatabaseClientForTests();
    assert.equal(databaseConfigured(), false);
    assert.equal(migrationDatabaseConfigured(), false);
    assert.equal(listingDatabaseConfigured(), false);
    assert.throws(() => getDatabaseSql(), /DATABASE_URL is required/);
    assert.throws(() => getMigrationDatabaseSql(), /DATABASE_URL_UNPOOLED or DATABASE_URL is required/);
    assert.throws(() => getListingDatabaseSql(), /LISTING_DATABASE_URL is required/);

    process.env[DATABASE_URL_ENV_KEY] = 'postgresql://user:password@ep-pooled.example.invalid/database?sslmode=require';
    process.env[DATABASE_URL_UNPOOLED_ENV_KEY] = 'postgresql://user:password@ep-direct.example.invalid/database?sslmode=require';
    process.env[LISTING_DATABASE_URL_ENV_KEY] = 'postgresql://listing-reader:password@ep-pooled.example.invalid/database?sslmode=require';
    assert.equal(databaseConfigured(), true);
    assert.equal(migrationDatabaseConfigured(), true);
    assert.equal(listingDatabaseConfigured(), true);
    assert.equal(listingDatabaseConnectionString(), process.env[LISTING_DATABASE_URL_ENV_KEY]);
    assert.equal(typeof getDatabaseSql(), 'function');
    assert.equal(typeof getMigrationDatabaseSql(), 'function');
    assert.equal(typeof getListingDatabaseSql(), 'function');

    process.env.VERCEL_ENV = 'preview';
    resetDatabaseClientForTests();
    assert.deepEqual(databaseEnvironmentKeys(), {
      pooled: PREVIEW_DATABASE_URL_ENV_KEY,
      unpooled: PREVIEW_DATABASE_URL_UNPOOLED_ENV_KEY,
    });
    assert.equal(listingDatabaseEnvironmentKey(), PREVIEW_LISTING_DATABASE_URL_ENV_KEY);
    assert.equal(databaseConnectionString(), null);
    assert.equal(migrationDatabaseConnectionString(), null);
    assert.equal(databaseConfigured(), false);
    assert.equal(migrationDatabaseConfigured(), false);
    assert.equal(listingDatabaseConfigured(), false);
    assert.throws(() => getDatabaseSql(), /PREVIEW_NEON_DATABASE_URL is required/);
    assert.throws(() => getMigrationDatabaseSql(), /PREVIEW_NEON_DATABASE_URL_UNPOOLED or PREVIEW_NEON_DATABASE_URL is required/);
    assert.throws(() => getListingDatabaseSql(), /PREVIEW_NEON_LISTING_DATABASE_URL is required/);

    process.env[PREVIEW_DATABASE_URL_ENV_KEY] = 'postgresql://preview:password@ep-preview-pooled.example.invalid/database?sslmode=require';
    process.env[PREVIEW_DATABASE_URL_UNPOOLED_ENV_KEY] = 'postgresql://preview:password@ep-preview-direct.example.invalid/database?sslmode=require';
    process.env[PREVIEW_LISTING_DATABASE_URL_ENV_KEY] = 'postgresql://preview-listing-reader:password@ep-preview-pooled.example.invalid/database?sslmode=require';
    assert.equal(databaseConfigured(), true);
    assert.equal(migrationDatabaseConfigured(), true);
    assert.equal(listingDatabaseConfigured(), true);
    assert.equal(databaseConnectionString(), process.env[PREVIEW_DATABASE_URL_ENV_KEY]);
    assert.equal(migrationDatabaseConnectionString(), process.env[PREVIEW_DATABASE_URL_UNPOOLED_ENV_KEY]);
    assert.equal(listingDatabaseConnectionString(), process.env[PREVIEW_LISTING_DATABASE_URL_ENV_KEY]);
    assert.equal(typeof getDatabaseSql(), 'function');
    assert.equal(typeof getMigrationDatabaseSql(), 'function');
    assert.equal(typeof getListingDatabaseSql(), 'function');

    process.env[PREVIEW_LISTING_DATABASE_URL_ENV_KEY] = process.env[PREVIEW_DATABASE_URL_ENV_KEY];
    assert.throws(() => listingDatabaseConnectionString(), /dedicated read-only login/);
  } finally {
    if (originalPooled === undefined) delete process.env[DATABASE_URL_ENV_KEY];
    else process.env[DATABASE_URL_ENV_KEY] = originalPooled;
    if (originalUnpooled === undefined) delete process.env[DATABASE_URL_UNPOOLED_ENV_KEY];
    else process.env[DATABASE_URL_UNPOOLED_ENV_KEY] = originalUnpooled;
    if (originalPreviewPooled === undefined) delete process.env[PREVIEW_DATABASE_URL_ENV_KEY];
    else process.env[PREVIEW_DATABASE_URL_ENV_KEY] = originalPreviewPooled;
    if (originalPreviewUnpooled === undefined) delete process.env[PREVIEW_DATABASE_URL_UNPOOLED_ENV_KEY];
    else process.env[PREVIEW_DATABASE_URL_UNPOOLED_ENV_KEY] = originalPreviewUnpooled;
    if (originalListing === undefined) delete process.env[LISTING_DATABASE_URL_ENV_KEY];
    else process.env[LISTING_DATABASE_URL_ENV_KEY] = originalListing;
    if (originalPreviewListing === undefined) delete process.env[PREVIEW_LISTING_DATABASE_URL_ENV_KEY];
    else process.env[PREVIEW_LISTING_DATABASE_URL_ENV_KEY] = originalPreviewListing;
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
    resetDatabaseClientForTests();
  }
});

test('package exposes only an explicit migration command and safe example modes', async () => {
  const packageJson = JSON.parse(await readFile(path.join(ROOT_DIRECTORY, 'package.json'), 'utf8'));
  const envExample = await readFile(path.join(ROOT_DIRECTORY, '.env.example'), 'utf8');
  assert.equal(packageJson.scripts['db:migrate'], 'node scripts/migrate-db.mjs');
  assert.match(packageJson.dependencies['@neondatabase/serverless'], /^\^1\./);
  assert.match(envExample, /^DATABASE_URL=$/m);
  assert.match(envExample, /^DATABASE_URL_UNPOOLED=$/m);
  assert.match(envExample, /^PREVIEW_NEON_DATABASE_URL=$/m);
  assert.match(envExample, /^PREVIEW_NEON_DATABASE_URL_UNPOOLED=$/m);
  assert.match(envExample, /^LISTING_DATABASE_URL=$/m);
  assert.match(envExample, /^PREVIEW_NEON_LISTING_DATABASE_URL=$/m);
  assert.match(envExample, /^BLOB_READ_WRITE_TOKEN=$/m);
  assert.match(envExample, /^PG_WRITE_MODE=off$/m);
  assert.match(envExample, /^RAW_ARCHIVE_MODE=off$/m);
  assert.match(envExample, /^LISTING_CHECKPOINT_WRITE_MODE=off$/m);
  assert.match(envExample, /^LISTING_READ_MODE=runtime-cache$/m);
});

test('database audit verifies Listing checkpoint roles without granting identity or delete access', async () => {
  const audit = await readFile(path.join(ROOT_DIRECTORY, 'scripts/audit-db.mjs'), 'utf8');
  assert.match(audit, /'rwa_listing_audit_reader'/);
  assert.match(audit, /listing_reader_schema_usage/);
  assert.match(audit, /listing_reader_select/);
  assert.match(audit, /listing_reader_membership_select/);
  assert.match(audit, /listing_reader_raw_run_select/);
  assert.match(audit, /listing_reader_identity_evidence_select/);
  assert.match(audit, /listing_reader_raw_event_select/);
  assert.match(audit, /listing_reader_event_view_select/);
  assert.match(audit, /listing_reader_run_view_select/);
  assert.match(audit, /listing_reader_review_view_select/);
  assert.match(audit, /listing_writer_schema_usage/);
  assert.match(audit, /listing_writer_update/);
  assert.match(audit, /listing_reader_delete/);
  assert.match(audit, /listing_writer_delete/);
  assert.match(audit, /listing_checkpoints/);
});

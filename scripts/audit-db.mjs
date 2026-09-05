import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getMigrationDatabaseSql, migrationDatabaseConnectionString } from '../api/_lib/database.js';
import { loadMigrations } from '../db/migration-utils.js';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../db/migrations');
const EXPECTED_ROLES = [
  'rwa_catalog_shadow_writer',
  'rwa_analytics_reader',
  'rwa_alert_dispatcher',
  'rwa_signal_history_writer',
  'rwa_listing_audit_reader',
  'rwa_arbitrage_writer',
  'rwa_arbitrage_reader',
];

function fingerprintConnection() {
  const raw = migrationDatabaseConnectionString();
  if (!raw) return null;
  const url = new URL(raw);
  return createHash('sha256')
    .update(`${url.hostname}${url.pathname}`)
    .digest('hex')
    .slice(0, 12);
}

function fail(message) {
  throw new Error(`Database audit failed: ${message}`);
}

const sql = getMigrationDatabaseSql();
const localMigrations = await loadMigrations(MIGRATION_DIRECTORY);
const [ledger, extensions, roles, privileges, counts, latestCycle] = await Promise.all([
  sql.query('SELECT version, name, checksum, statement_count FROM ops.schema_migration ORDER BY version'),
  sql.query("SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto', 'btree_gist') ORDER BY extname"),
  sql.query('SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname', [EXPECTED_ROLES]),
  sql.query(`
    SELECT
      has_table_privilege('rwa_catalog_shadow_writer', 'identity.source', 'INSERT') AS writer_catalog_insert,
      has_table_privilege('rwa_catalog_shadow_writer', 'ingest.catalog_membership', 'INSERT') AS writer_membership_insert,
      has_table_privilege('rwa_catalog_shadow_writer', 'fact.listing_observation_hourly', 'INSERT') AS writer_fact_insert,
      has_table_privilege('rwa_catalog_shadow_writer', 'alert.event', 'INSERT') AS writer_alert_insert,
      has_table_privilege('rwa_analytics_reader', 'analytics.catalog_change_event', 'SELECT') AS reader_analytics_select,
      has_table_privilege('rwa_analytics_reader', 'identity.source', 'INSERT') AS reader_identity_insert,
      has_table_privilege('rwa_alert_dispatcher', 'alert.delivery', 'UPDATE') AS dispatcher_delivery_update,
      has_table_privilege('rwa_alert_dispatcher', 'identity.source', 'INSERT') AS dispatcher_identity_insert
      ,has_table_privilege('rwa_signal_history_writer', 'publication.signal_history_checkpoint', 'SELECT') AS history_select
      ,has_table_privilege('rwa_signal_history_writer', 'publication.signal_history_checkpoint', 'INSERT') AS history_insert
      ,has_table_privilege('rwa_signal_history_writer', 'publication.signal_history_checkpoint', 'UPDATE') AS history_update
      ,has_table_privilege('rwa_signal_history_writer', 'publication.signal_history_checkpoint', 'DELETE') AS history_delete
      ,has_schema_privilege('rwa_listing_audit_reader', 'publication', 'USAGE') AS listing_reader_schema_usage
      ,has_table_privilege('rwa_listing_audit_reader', 'publication.listing_audit_checkpoint', 'SELECT') AS listing_reader_select
      ,has_table_privilege('rwa_listing_audit_reader', 'publication.listing_audit_checkpoint', 'INSERT') AS listing_reader_insert
      ,has_table_privilege('rwa_listing_audit_reader', 'publication.listing_audit_checkpoint', 'UPDATE') AS listing_reader_update
      ,has_table_privilege('rwa_listing_audit_reader', 'publication.listing_audit_checkpoint', 'DELETE') AS listing_reader_delete
      ,has_table_privilege('rwa_listing_audit_reader', 'ingest.catalog_membership', 'SELECT') AS listing_reader_membership_select
      ,has_table_privilege('rwa_listing_audit_reader', 'ingest.source_run', 'SELECT') AS listing_reader_raw_run_select
      ,has_table_privilege('rwa_listing_audit_reader', 'identity.evidence', 'SELECT') AS listing_reader_identity_evidence_select
      ,has_table_privilege('rwa_listing_audit_reader', 'analytics.catalog_change_event', 'SELECT') AS listing_reader_raw_event_select
      ,has_table_privilege('rwa_listing_audit_reader', 'publication.listing_change_event_v1', 'SELECT') AS listing_reader_event_view_select
      ,has_table_privilege('rwa_listing_audit_reader', 'publication.listing_audit_run_v1', 'SELECT') AS listing_reader_run_view_select
      ,has_table_privilege('rwa_listing_audit_reader', 'publication.listing_audit_pending_review_v1', 'SELECT') AS listing_reader_review_view_select
      ,has_schema_privilege('rwa_catalog_shadow_writer', 'publication', 'USAGE') AS listing_writer_schema_usage
      ,has_table_privilege('rwa_catalog_shadow_writer', 'publication.listing_audit_checkpoint', 'SELECT') AS listing_writer_select
      ,has_table_privilege('rwa_catalog_shadow_writer', 'publication.listing_audit_checkpoint', 'INSERT') AS listing_writer_insert
      ,has_table_privilege('rwa_catalog_shadow_writer', 'publication.listing_audit_checkpoint', 'UPDATE') AS listing_writer_update
      ,has_table_privilege('rwa_catalog_shadow_writer', 'publication.listing_audit_checkpoint', 'DELETE') AS listing_writer_delete
      ,has_table_privilege('rwa_arbitrage_writer', 'fact.arbitrage_route_observation', 'INSERT') AS arbitrage_writer_fact_insert
      ,has_table_privilege('rwa_arbitrage_writer', 'publication.arbitrage_opportunity_snapshot', 'INSERT') AS arbitrage_writer_snapshot_insert
      ,has_table_privilege('rwa_arbitrage_writer', 'fact.arbitrage_route_observation', 'UPDATE') AS arbitrage_writer_fact_update
      ,has_table_privilege('rwa_arbitrage_writer', 'publication.arbitrage_opportunity_snapshot', 'DELETE') AS arbitrage_writer_snapshot_delete
      ,has_schema_privilege('rwa_arbitrage_reader', 'publication', 'USAGE') AS arbitrage_reader_schema_usage
      ,has_table_privilege('rwa_arbitrage_reader', 'publication.arbitrage_opportunity_v1', 'SELECT') AS arbitrage_reader_view_select
      ,has_table_privilege('rwa_arbitrage_reader', 'fact.arbitrage_route_observation', 'SELECT') AS arbitrage_reader_fact_select
      ,has_table_privilege('rwa_arbitrage_reader', 'publication.arbitrage_opportunity_snapshot', 'SELECT') AS arbitrage_reader_snapshot_select
      ,has_table_privilege('rwa_arbitrage_reader', 'identity.instrument_version', 'SELECT') AS arbitrage_reader_identity_select
  `),
  sql.query(`
    SELECT
      (SELECT count(*)::int FROM identity.source) AS sources,
      (SELECT count(*)::int FROM identity.asset) AS assets,
      (SELECT count(*)::int FROM identity.instrument) AS instruments,
      (SELECT count(*)::int FROM ingest.collection_cycle) AS cycles,
      (SELECT count(*)::int FROM ingest.source_run) AS source_runs,
      (SELECT count(*)::int FROM ingest.catalog_membership) AS memberships,
      (SELECT count(*)::int FROM ingest.raw_artifact) AS artifacts,
      (SELECT count(*)::int FROM analytics.catalog_change_event) AS listing_events,
      (SELECT count(*)::int FROM publication.listing_audit_checkpoint) AS listing_checkpoints,
      (SELECT count(*)::int FROM fact.arbitrage_route_observation) AS arbitrage_route_observations,
      (SELECT count(*)::int FROM publication.arbitrage_opportunity_snapshot) AS arbitrage_snapshots,
      (SELECT count(*)::int FROM identity.review_case WHERE status = 'open') AS open_reviews
  `),
  sql.query(`
    SELECT cycle.bucket_at, cycle.status,
      count(DISTINCT run.source_id)::int AS source_count,
      count(DISTINCT membership.instrument_version_id)::int AS membership_count,
      count(DISTINCT artifact.artifact_id)::int AS artifact_count,
      count(DISTINCT sink.sink_name)::int AS sink_count
    FROM ingest.collection_cycle AS cycle
    LEFT JOIN ingest.collection_attempt AS attempt ON attempt.cycle_id = cycle.cycle_id
    LEFT JOIN ingest.source_run AS run ON run.attempt_id = attempt.attempt_id
    LEFT JOIN ingest.catalog_membership AS membership ON membership.source_run_id = run.source_run_id
    LEFT JOIN ingest.raw_artifact AS artifact ON artifact.source_run_id = run.source_run_id
    LEFT JOIN ingest.sink_commit AS sink ON sink.attempt_id = attempt.attempt_id
    WHERE cycle.job_name = 'rwa-listing-audit'
      AND cycle.pipeline_version = 'rwa-listing-catalog-pg-shadow/v1'
    GROUP BY cycle.cycle_id
    ORDER BY cycle.bucket_at DESC
    LIMIT 1
  `),
]);

if (ledger.length !== localMigrations.length) fail('migration count does not match local files');
for (const migration of localMigrations) {
  const applied = ledger.find(row => row.version === migration.version);
  if (!applied || applied.checksum !== migration.checksum || Number(applied.statement_count) !== migration.statements.length) {
    fail(`migration ${migration.version} checksum or statement count differs`);
  }
}
if (extensions.map(row => row.extname).join(',') !== 'btree_gist,pgcrypto') fail('required extensions are unavailable');
if (roles.length !== EXPECTED_ROLES.length || roles.some(role => role.rolcanlogin)) fail('least-privilege roles are missing or LOGIN-enabled');

const privilege = privileges[0] || {};
if (!privilege.writer_catalog_insert || !privilege.writer_membership_insert) fail('catalog writer lacks required Phase 1 grants');
if (privilege.writer_fact_insert || privilege.writer_alert_insert) fail('catalog writer can mutate a later-phase table');
if (!privilege.reader_analytics_select || privilege.reader_identity_insert) fail('analytics reader grants are invalid');
if (!privilege.dispatcher_delivery_update || privilege.dispatcher_identity_insert) fail('alert dispatcher grants are invalid');
if (!privilege.history_select || !privilege.history_insert || !privilege.history_update || privilege.history_delete) {
  fail('signal history writer grants are invalid');
}
if (!privilege.listing_reader_schema_usage || !privilege.listing_reader_select ||
    privilege.listing_reader_insert || privilege.listing_reader_update || privilege.listing_reader_delete ||
    privilege.listing_reader_membership_select || privilege.listing_reader_raw_run_select ||
    privilege.listing_reader_identity_evidence_select || privilege.listing_reader_raw_event_select ||
    !privilege.listing_reader_event_view_select || !privilege.listing_reader_run_view_select ||
    !privilege.listing_reader_review_view_select) {
  fail('listing event/checkpoint reader grants are invalid');
}
if (!privilege.listing_writer_schema_usage || !privilege.listing_writer_select ||
    !privilege.listing_writer_insert || !privilege.listing_writer_update || privilege.listing_writer_delete) {
  fail('listing checkpoint writer grants are invalid');
}
if (!privilege.arbitrage_writer_fact_insert || !privilege.arbitrage_writer_snapshot_insert ||
    privilege.arbitrage_writer_fact_update || privilege.arbitrage_writer_snapshot_delete) {
  fail('arbitrage writer grants are invalid');
}
if (!privilege.arbitrage_reader_schema_usage || !privilege.arbitrage_reader_view_select ||
    privilege.arbitrage_reader_fact_select || privilege.arbitrage_reader_snapshot_select ||
    privilege.arbitrage_reader_identity_select) {
  fail('arbitrage reader grants are invalid');
}

const result = {
  status: 'pass',
  databaseFingerprint: fingerprintConnection(),
  migrations: ledger.map(row => ({ version: row.version, checksum: row.checksum, statements: Number(row.statement_count) })),
  extensions: extensions.map(row => row.extname),
  roles: roles.map(row => ({ name: row.rolname, canLogin: row.rolcanlogin })),
  counts: counts[0],
  latestListingCycle: latestCycle[0] || null,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

const EXPECTED_BRANCH = 'codex/listing-durable-read-phase2-20260831';
const ALLOWED_MIGRATION = '0006';

const requestedMigration = String(process.env.PREVIEW_SCHEMA_MIGRATION || '').trim();

if (!requestedMigration) {
  process.stdout.write('[preview-migration] skipped: no explicit migration authorization\n');
} else {
  const environment = String(process.env.VERCEL_ENV || '').trim().toLowerCase();
  const branch = String(process.env.VERCEL_GIT_COMMIT_REF || '').trim();
  const repository = String(process.env.VERCEL_GIT_REPO_SLUG || '').trim();
  const writerConfigured = Boolean(
    String(process.env.PREVIEW_NEON_DATABASE_URL_UNPOOLED || '').trim() ||
    String(process.env.PREVIEW_NEON_DATABASE_URL || '').trim()
  );

  if (requestedMigration !== ALLOWED_MIGRATION) {
    throw new Error(`Unsupported Preview migration authorization: ${requestedMigration}`);
  }
  if (environment !== 'preview' || branch !== EXPECTED_BRANCH || repository !== 'rwa-dashboard') {
    throw new Error('Preview migration authorization does not match the exact environment, branch and repository');
  }
  if (!writerConfigured) {
    throw new Error('Isolated Preview migration connection is unavailable');
  }

  process.stdout.write(`[preview-migration] applying through ${requestedMigration} on the isolated Preview database\n`);
  await import('./migrate-db.mjs');
  process.stdout.write('[preview-migration] verifying idempotent second migration pass\n');
  await import(`./migrate-db.mjs?verify=${Date.now()}`);
  process.stdout.write('[preview-migration] running least-privilege database audit\n');
  await import('./audit-db.mjs');
}

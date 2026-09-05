import assert from 'node:assert/strict';
import test from 'node:test';

import { createHermeticTestEnvironment } from '../scripts/test-environment.mjs';

test('unit-test runner strips deployment configuration and production credentials', () => {
  const sanitized = createHermeticTestEnvironment({
    PATH:'/usr/bin',
    CI:'true',
    VERCEL_ENV:'production',
    VERCEL_GIT_COMMIT_REF:'main',
    PG_WRITE_MODE:'required',
    RAW_ARCHIVE_MODE:'required',
    LISTING_CHECKPOINT_WRITE_MODE:'required',
    LISTING_READ_MODE:'durable-fallback',
    DATABASE_URL:'postgresql://production-secret',
    LISTING_DATABASE_URL:'postgresql://listing-reader-production-secret',
    PREVIEW_NEON_LISTING_DATABASE_URL:'postgresql://listing-reader-preview-secret',
    ARBITRAGE_DATABASE_URL:'postgresql://arbitrage-reader-production-secret',
    PREVIEW_NEON_ARBITRAGE_DATABASE_URL:'postgresql://arbitrage-reader-preview-secret',
    ARBITRAGE_WRITE_MODE:'required',
    CRON_SECRET:'production-secret',
    BLOB_READ_WRITE_TOKEN:'production-secret',
    BINANCE_MARKET_DATA_API_KEY:'production-secret',
  });

  assert.deepEqual(sanitized, { PATH:'/usr/bin', CI:'true' });
});

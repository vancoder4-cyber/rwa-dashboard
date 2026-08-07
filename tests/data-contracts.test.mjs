import test from 'node:test';
import assert from 'node:assert/strict';

import { historyCoverage, normalizeHistoryRows } from '../api/funding-history.js';
import { assessChecks } from '../api/_lib/health.js';
import { FX_REFERENCE_MAP, yahooSymbolFor } from '../api/_lib/reference-map.js';

test('reference map resolves non-US and commodity underlyings', () => {
  assert.equal(yahooSymbolFor('SKHYNIX'), '000660.KS');
  assert.equal(yahooSymbolFor('MINIMAX'), '0100.HK');
  assert.equal(yahooSymbolFor('XAU'), 'GC=F');
  assert.equal(yahooSymbolFor('AAPL'), 'AAPL');
  assert.equal(FX_REFERENCE_MAP.KRW.mode, 'divide');
  assert.equal(FX_REFERENCE_MAP.HKD.symbol, 'HKD=X');
});

test('funding history preserves a real zero rate and removes old rows', () => {
  const startTime = 1_800_000_000_000;
  const rows = normalizeHistoryRows('binance', [
    { fundingTime: startTime - 3_600_000, fundingRate: '0.001' },
    { fundingTime: startTime, fundingRate: '0' },
    { fundingTime: startTime + 3_600_000, fundingRate: '-0.0002' },
  ], startTime);
  assert.deepEqual(rows, [
    { fundingTime: startTime, fundingRate: 0 },
    { fundingTime: startTime + 3_600_000, fundingRate: -0.0002 },
  ]);
});

test('funding history normalizes Gate seconds and deduplicates timestamps', () => {
  const startSeconds = 1_800_000_000;
  const rows = normalizeHistoryRows('gate', [
    { t: startSeconds, r: '0.0001' },
    { t: startSeconds, r: '0.0002' },
  ], startSeconds * 1000);
  assert.deepEqual(rows, [{ fundingTime: startSeconds * 1000, fundingRate: 0.0002 }]);
});

test('funding coverage infers an 8-hour schedule without hard-coding the venue', () => {
  const rows = [0, 8, 16].map(hour => ({ fundingTime: 1_800_000_000_000 + hour * 3600_000, fundingRate: 0 }));
  assert.deepEqual(historyCoverage(rows, 24), { status: 'full', expected: 3, observed: 3 });
  assert.deepEqual(historyCoverage(rows.slice(0, 2), 24), { status: 'partial', expected: 3, observed: 2 });
});

test('health assessment distinguishes degraded from unhealthy', () => {
  assert.equal(assessChecks([{ status: 'pass' }, { status: 'warn' }]).status, 'degraded');
  assert.equal(assessChecks([{ status: 'fail', critical: false }]).status, 'degraded');
  assert.equal(assessChecks([{ status: 'fail', critical: true }]).status, 'unhealthy');
  assert.equal(assessChecks([{ status: 'fail' }, { status: 'fail' }]).status, 'unhealthy');
});

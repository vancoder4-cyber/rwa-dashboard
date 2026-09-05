import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARBITRAGE_FORMULA_VERSION,
  ARBITRAGE_SCHEMA_VERSION,
  basisPersistenceMinutes,
  buildArbitrageRoute,
  buildArbitrageSnapshot,
  calculateBasisPct,
  calculateCurrentAnnualizedPct,
  routeIdentity,
  routeMeetsNotificationPolicy,
  settledFundingMetrics,
  unavailableArbitragePayload,
  validateArbitrageSnapshot,
} from '../api/_lib/arbitrage-analysis.js';

const NOW = Date.parse('2026-09-04T10:02:00.000Z');

function fundingRows(rate = 0.00022) {
  return [24, 16, 8, 0].map(hours => ({
    fundingTime:NOW - hours * 60 * 60_000,
    fundingRate:rate,
  }));
}

function routeInput(overrides = {}) {
  return {
    asset:{ symbol:'NVDA', name:'NVIDIA', category:'equity', verified:true, eligible:true },
    spot:{
      venue:'kraken', venueSymbol:'NVDAXUSD', askPriceUsd:100,
      executableDepthUsd:25_000, observedAt:'2026-09-04T10:01:30.000Z',
    },
    perp:{
      venue:'binance', venueSymbol:'NVDAUSDT', bidPriceUsd:101.2,
      executableDepthUsd:30_000, openInterestUsd:2_000_000,
      currentFundingRate:0.0002, fundingIntervalHours:8,
      observedAt:'2026-09-04T10:01:45.000Z',
      fundingObservedAt:'2026-09-04T10:01:45.000Z',
    },
    fundingHistory:fundingRows(),
    ...overrides,
  };
}

test('basis and funding rates use percentage points exactly once', () => {
  assert.equal(calculateBasisPct(100, 101.2), 1.2);
  assert.equal(calculateCurrentAnnualizedPct(0.02, 8), 21.9);
  const metrics = settledFundingMetrics(fundingRows(), { nowMs:NOW, intervalHours:8 });
  assert.equal(metrics.average24hAnnualizedPct, 24.09);
  assert.equal(metrics.consecutivePositiveSettlements, 4);
});

test('route identity includes both exact venue symbols and stable fingerprint', () => {
  const identity = routeIdentity(
    { category:'equity', symbol:'NVDA' },
    { venue:'kraken', venueSymbol:'NVDAXUSD' },
    { venue:'okx', venueSymbol:'NVDA-USDT-SWAP' },
  );
  assert.equal(identity.assetKey, 'equity:NVDA');
  assert.equal(identity.routeId, 'equity:NVDA:kraken:NVDAXUSD:okx:NVDA-USDT-SWAP');
  assert.match(identity.routeFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(identity, routeIdentity(
    { category:'equity', symbol:'NVDA' },
    { venue:'kraken', venueSymbol:'NVDAXUSD' },
    { venue:'okx', venueSymbol:'NVDA-USDT-SWAP' },
  ));
});

test('basis persistence requires contiguous five-minute observations', () => {
  const fingerprint = 'abc';
  assert.equal(basisPersistenceMinutes(NOW, 1.2, [
    { routeFingerprint:fingerprint, bucketAt:'2026-09-04T09:55:00.000Z', basisPct:1.1 },
    { routeFingerprint:fingerprint, bucketAt:'2026-09-04T09:50:00.000Z', basisPct:1.01 },
  ], fingerprint), 10);
  assert.equal(basisPersistenceMinutes(NOW, 1.2, [
    { routeFingerprint:fingerprint, bucketAt:'2026-09-04T09:50:00.000Z', basisPct:1.1 },
  ], fingerprint), 0);
  assert.equal(basisPersistenceMinutes(NOW, 0.99, [], fingerprint), 0);
});

test('route builder rejects stale or skewed legs and incomplete settled history', () => {
  assert.throws(() => buildArbitrageRoute(routeInput({
    spot:{ ...routeInput().spot, observedAt:'2026-09-04T09:58:00.000Z' },
  }), { generatedAt:NOW }), /stale/);
  assert.throws(() => buildArbitrageRoute(routeInput({
    spot:{ ...routeInput().spot, observedAt:'2026-09-04T10:00:00.000Z' },
    perp:{ ...routeInput().perp, observedAt:'2026-09-04T10:01:30.001Z' },
  }), { generatedAt:NOW }), /stale/);
  assert.throws(() => buildArbitrageRoute(routeInput({ fundingHistory:[fundingRows()[0]] }), {
    generatedAt:NOW,
  }), /settled funding/);
});

test('route builder and policy produce the exact Push Bot field contract', () => {
  const identity = routeIdentity(routeInput().asset, routeInput().spot, routeInput().perp);
  const route = buildArbitrageRoute(routeInput(), {
    generatedAt:NOW,
    basisHistory:[
      { routeFingerprint:identity.routeFingerprint, bucketAt:'2026-09-04T09:55:00.000Z', basisPct:1.2 },
      { routeFingerprint:identity.routeFingerprint, bucketAt:'2026-09-04T09:50:00.000Z', basisPct:1.1 },
    ],
  });
  assert.equal(route.basis.pct, 1.2);
  assert.equal(route.basis.persistenceMinutes, 10);
  assert.equal(route.funding.currentRatePct, 0.02);
  assert.equal(route.funding.currentAnnualizedPct, 21.9);
  assert.equal(route.funding.shortReceives, true);
  assert.equal(routeMeetsNotificationPolicy(route), true);
});

test('authoritative empty snapshot is full while incomplete coverage fails closed', () => {
  const empty = buildArbitrageSnapshot([], {
    availableSources:5, spotAvailableSources:5, identityConflicts:0,
    rejectedListings:0, quarantinedListings:0, complete:true,
  }, { generatedAt:NOW });
  assert.equal(empty.schemaVersion, ARBITRAGE_SCHEMA_VERSION);
  assert.equal(empty.formulaVersion, ARBITRAGE_FORMULA_VERSION);
  assert.equal(empty.coverage.expectedRoutes, 0);
  assert.equal(empty.coverage.returnedRoutes, 0);
  assert.equal(empty.coverage.complete, true);
  assert.deepEqual(empty.routes, []);
  assert.equal(validateArbitrageSnapshot(empty, { nowMs:NOW }).valid, true);
  assert.throws(() => buildArbitrageSnapshot([], {
    availableSources:4, spotAvailableSources:5, identityConflicts:0,
    rejectedListings:0, quarantinedListings:0, complete:false,
  }, { generatedAt:NOW }), /incomplete/);
});

test('snapshot rejects duplicates and becomes stale after ten minutes', () => {
  const route = buildArbitrageRoute(routeInput(), { generatedAt:NOW });
  assert.throws(() => buildArbitrageSnapshot([route, route], {
    availableSources:5, spotAvailableSources:5, identityConflicts:0,
    rejectedListings:0, quarantinedListings:0, complete:true,
  }, { generatedAt:NOW }), /incomplete/);
  const snapshot = buildArbitrageSnapshot([route], {
    availableSources:5, spotAvailableSources:5, identityConflicts:0,
    rejectedListings:0, quarantinedListings:0, complete:true,
  }, { generatedAt:NOW });
  assert.equal(validateArbitrageSnapshot(snapshot, { nowMs:NOW + 10 * 60_000 }).valid, true);
  assert.equal(validateArbitrageSnapshot(snapshot, { nowMs:NOW + 10 * 60_000 + 1 }).valid, false);
});

test('unavailable envelope never masquerades as authoritative empty', () => {
  const payload = unavailableArbitragePayload('database offline');
  assert.equal(payload.status, 'unavailable');
  assert.equal(payload.coverage.expectedRoutes, null);
  assert.equal(payload.coverage.complete, false);
  assert.equal(validateArbitrageSnapshot(payload, { nowMs:NOW }).valid, false);
});

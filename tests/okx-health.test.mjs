import test from 'node:test';
import assert from 'node:assert/strict';

import {
  probeOkxMarkets,
  validateOkxPerpSnapshot,
  validateOkxSpotSnapshot,
} from '../api/health.js';

function fullCoverage(count) {
  return { status: 'full', observed: count, expected: count };
}

function makePerpSnapshot() {
  const swaps = Array.from({ length:149 }, (_, index) => ({
    instType: 'SWAP',
    instId: `STK${String(index).padStart(3, '0')}-USDT-SWAP`,
    canonicalSymbol: `STK${String(index).padStart(3, '0')}`,
    state: 'live',
    ruleType: 'normal',
    instCategory: String(3 + (index % 4)),
  }));
  const xperps = Array.from({ length:34 }, (_, index) => ({
    instType: 'FUTURES',
    instId: `XPF${String(index).padStart(3, '0')}-USD_UM_XPERP-310613`,
    canonicalSymbol: `XPF${String(index).padStart(3, '0')}`,
    state: 'live',
    ruleType: 'xperp',
    instCategory: '3',
  }));
  const instruments = [...swaps, ...xperps];
  const marketRows = instruments.map(({ instId }) => ({ instId }));
  return {
    instruments,
    tickers: marketRows.map(row => ({ ...row })),
    marks: marketRows.map(row => ({ ...row })),
    openInterest: marketRows.map(row => ({ ...row })),
    coverage: {
      tickers: fullCoverage(instruments.length),
      marks: fullCoverage(instruments.length),
      openInterest: fullCoverage(instruments.length),
    },
  };
}

function makeSpotSnapshot() {
  const uts = Array.from({ length:48 }, (_, index) => {
    const canonicalSymbol = `UTS${String(index).padStart(3, '0')}`;
    const baseCcy = `X${canonicalSymbol}`;
    return {
      instType: 'SPOT',
      instId: `${baseCcy}-USDT`,
      baseCcy,
      quoteCcy: 'USDT',
      canonicalSymbol,
      state: 'live',
      instCategory: '3',
    };
  });
  const gold = [
    { instId:'PAXG-USD', baseCcy:'PAXG', quoteCcy:'USD', canonicalSymbol:'PAXG' },
    { instId:'PAXG-USDT', baseCcy:'PAXG', quoteCcy:'USDT', canonicalSymbol:'PAXG' },
    { instId:'XAUT-USDT', baseCcy:'XAUT', quoteCcy:'USDT', canonicalSymbol:'XAUT' },
  ].map(row => ({ ...row, instType:'SPOT', state:'live', instCategory:'1' }));
  const instruments = [...uts, ...gold];
  return {
    instruments,
    tickers: instruments.map(({ instId }) => ({ instId })),
    coverage: { tickers: fullCoverage(instruments.length) },
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get() { return null; } },
    async json() { return payload; },
  };
}

test('OKX health validators require the complete official catalog and market joins', () => {
  const perp = validateOkxPerpSnapshot(makePerpSnapshot());
  assert.equal(perp.valid, true);
  assert.equal(perp.listingCount, 183);
  assert.equal(perp.swapListings, 149);
  assert.equal(perp.xPerpListings, 34);
  assert.equal(perp.coverage.openInterest.valid, true);

  const spot = validateOkxSpotSnapshot(makeSpotSnapshot());
  assert.equal(spot.valid, true);
  assert.equal(spot.listingCount, 51);
  assert.equal(spot.utsListings, 48);
  assert.equal(spot.goldListings, 3);
  assert.equal(spot.coverage.tickers.valid, true);
});

test('OKX health validators fail closed on crypto identity collisions and missing market rows', () => {
  const perpSnapshot = makePerpSnapshot();
  perpSnapshot.instruments[0] = {
    ...perpSnapshot.instruments[0],
    instId: 'QNT-USDT-SWAP',
    canonicalSymbol: 'QNT',
    instCategory: '1',
  };
  perpSnapshot.tickers[0] = { instId:'QNT-USDT-SWAP' };
  perpSnapshot.marks[0] = { instId:'QNT-USDT-SWAP' };
  perpSnapshot.openInterest[0] = { instId:'QNT-USDT-SWAP' };
  perpSnapshot.openInterest.pop();
  const perp = validateOkxPerpSnapshot(perpSnapshot);
  assert.equal(perp.valid, false);
  assert.equal(perp.identityValid, false);
  assert.equal(perp.invalidIdentitySample[0], 'QNT-USDT-SWAP');
  assert.equal(perp.coverage.openInterest.valid, false);
  assert.equal(perp.coverage.openInterest.missingCount, 1);

  const wrongCanonical = makePerpSnapshot();
  wrongCanonical.instruments[1].canonicalSymbol = 'BTC';
  assert.equal(validateOkxPerpSnapshot(wrongCanonical).identityValid, false);

  const spotSnapshot = makeSpotSnapshot();
  spotSnapshot.instruments[0] = {
    instType: 'SPOT', instId:'CAT-USDT', baseCcy:'CAT', quoteCcy:'USDT',
    canonicalSymbol:'CAT', state:'live', instCategory:'1',
  };
  spotSnapshot.tickers[0] = { instId:'CAT-USDT' };
  const spot = validateOkxSpotSnapshot(spotSnapshot);
  assert.equal(spot.valid, false);
  assert.equal(spot.identityValid, false);
  assert.equal(spot.utsListings, 47);
  assert.equal(spot.invalidIdentitySample[0], 'CAT-USDT');
});

test('OKX health probe calls perp and spot snapshots sequentially', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  let active = 0;
  let maxActive = 0;
  globalThis.fetch = async url => {
    urls.push(String(url));
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    const type = new URL(url).searchParams.get('type');
    return jsonResponse(type === 'perp-snapshot' ? makePerpSnapshot() : makeSpotSnapshot());
  };
  try {
    const checks = await probeOkxMarkets('https://example.vercel.app');
    assert.deepEqual(checks.map(check => [check.name, check.status]), [
      ['okx-perp-market', 'pass'],
      ['okx-spot-market', 'pass'],
    ]);
    assert.equal(maxActive, 1);
    assert.deepEqual(urls, [
      'https://example.vercel.app/api/okx-market?type=perp-snapshot',
      'https://example.vercel.app/api/okx-market?type=spot-snapshot',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

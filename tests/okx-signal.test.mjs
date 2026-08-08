import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateSignalListings } from '../api/_lib/signal-analysis.js';
import { PRODUCTION_BASELINES } from '../api/_lib/health.js';
import {
  categoryFromOfficialSignalType,
  normalizeSignalIdentity,
} from '../api/_lib/security-identity.js';
import {
  isSignalSnapshotComparable,
  normalizeOkxSignalSnapshot,
  tradeXyzSignalCategory,
} from '../api/signal-snapshot.js';

const AAPL_SWAP = 'AAPL-USDT-SWAP';
const AAPL_XPERP = 'AAPL-USD_UM_XPERP-310613';
const BOND_SWAP = 'US10Y-USDT-SWAP';

function marketRow(instId, fields = {}) {
  return { instId, ...fields };
}

function fullOkxPayload() {
  const instruments = [
    { instId:AAPL_SWAP, instType:'SWAP', ruleType:'normal', state:'live', instCategory:'3', ctValCcy:'AAPL', ctVal:'1' },
    { instId:AAPL_XPERP, instType:'FUTURES', ruleType:'xperp', state:'live', instCategory:'3', ctValCcy:'AAPL', ctVal:'1' },
    { instId:BOND_SWAP, instType:'SWAP', ruleType:'normal', state:'live', instCategory:'6', ctValCcy:'US10Y', ctVal:'1' },
    // Same ticker as a public company is not enough when OKX says Crypto.
    { instId:'QNT-USDT-SWAP', instType:'SWAP', ruleType:'normal', state:'live', instCategory:'1', ctValCcy:'QNT', ctVal:'1' },
    // A conventional expiry future is outside the Perpetuals/Radar universe.
    { instId:'XAU-USD_UM-260828', instType:'FUTURES', ruleType:'normal', state:'live', instCategory:'4', ctValCcy:'XAU', ctVal:'1' },
    { instId:'NVDA-USDT-SWAP', instType:'SWAP', ruleType:'normal', state:'preopen', instCategory:'3', ctValCcy:'NVDA', ctVal:'1' },
  ];
  const admittedIds = [AAPL_SWAP, AAPL_XPERP, BOND_SWAP];
  return {
    instruments,
    tickers: [
      marketRow(AAPL_SWAP, { last:'200', open24h:'190', volCcy24h:'100' }),
      marketRow(AAPL_XPERP, { last:'201', open24h:'200', volCcy24h:'10' }),
      marketRow(BOND_SWAP, { last:'99', open24h:'100', volCcy24h:'5' }),
    ],
    marks: [
      marketRow(AAPL_SWAP, { markPx:'200' }),
      marketRow(AAPL_XPERP, { markPx:'200.5' }),
      marketRow(BOND_SWAP, { markPx:'99.5' }),
    ],
    openInterest: [
      marketRow(AAPL_SWAP, { oi:'1000', oiCcy:'1000', oiUsd:'200000' }),
      marketRow(AAPL_XPERP, { oi:'125', oiCcy:'125', oiUsd:'25000' }),
      marketRow(BOND_SWAP, { oi:'20', oiCcy:'20', oiUsd:'1990' }),
    ],
    funding: admittedIds.map((instId, index) => marketRow(instId, {
      fundingRate: index === 0 ? '0' : '0.0001',
      fundingTime:'1800000000000',
      nextFundingTime:'1800028800000',
    })),
    coverage: { status:'full' },
  };
}

test('OKX Radar admits only official RWA perpetual classes and preserves both AAPL contracts', () => {
  const normalized = normalizeOkxSignalSnapshot(fullOkxPayload());
  assert.equal(normalized.completeness, 'full');
  assert.deepEqual(normalized.warnings, []);
  assert.equal(normalized.listings.length, 3);
  assert.deepEqual(normalized.listings.map(row => row.venueSymbol), [AAPL_SWAP, AAPL_XPERP, BOND_SWAP]);
  assert.equal(normalized.listings.some(row => row.venueSymbol.startsWith('QNT-')), false);
  assert.equal(normalized.listings.some(row => row.venueSymbol === 'XAU-USD_UM-260828'), false);

  const aapl = normalized.listings.filter(row => row.symbol === 'AAPL');
  assert.equal(aapl.length, 2);
  assert.equal(aapl[0].fundingRate, 0);
  assert.equal(aapl[0].fundingIntervalHours, 8);
  assert.equal(aapl[0].volume24hUsd, 20_000);
  assert.equal(aapl[1].openInterestUsd, 25_000);

  const aggregated = aggregateSignalListings(normalized.listings).assets;
  const aggregatedAapl = aggregated.find(asset => asset.symbol === 'AAPL');
  assert.equal(aggregatedAapl.listingCount, 2);
  assert.equal(aggregatedAapl.venueCount, 1);
  assert.equal(aggregatedAapl.openInterestUsd, 225_000);
  assert.deepEqual(new Set(aggregatedAapl.listings.map(row => row.venueSymbol)), new Set([AAPL_SWAP, AAPL_XPERP]));
});

test('OKX optional funding gaps downgrade the source without dropping identity-verified listings', () => {
  const payload = fullOkxPayload();
  payload.funding = payload.funding.filter(row => row.instId !== AAPL_XPERP);
  const normalized = normalizeOkxSignalSnapshot(payload);
  assert.equal(normalized.listings.length, 3);
  assert.equal(normalized.completeness, 'partial');
  assert.ok(normalized.warnings.includes('FUNDING_INCOMPLETE'));
  const xperp = normalized.listings.find(row => row.venueSymbol === AAPL_XPERP);
  assert.equal(xperp.fundingRate, null);
  assert.equal(xperp.fundingIntervalHours, null);
});

test('OKX bond identity and five-source history comparability are explicit', () => {
  assert.equal(categoryFromOfficialSignalType('bond'), 'bond');
  assert.equal(categoryFromOfficialSignalType('fixed_income'), 'bond');
  assert.deepEqual(normalizeSignalIdentity('US10Y', 'bond'), { symbol:'US10Y', category:'bond' });
  const fullSources = Object.fromEntries(
    ['gate', 'binance', 'bitget', 'tradexyz', 'okx'].map(name => [name, { status:'full' }]),
  );
  assert.equal(isSignalSnapshotComparable(fullSources), true);
  assert.equal(isSignalSnapshotComparable({ ...fullSources, okx:{ status:'partial' } }), false);
});

test('OKX broad Stocks metadata is refined only after official RWA admission', () => {
  for (const symbol of ['SHLD', 'TMF', 'XBI']) {
    assert.deepEqual(normalizeSignalIdentity(symbol, 'equity'), { symbol, category:'etf' });
  }
  assert.deepEqual(normalizeSignalIdentity('KR200', 'equity'), { symbol:'KR200', category:'index' });
  assert.deepEqual(normalizeSignalIdentity('SP500', 'equity'), { symbol:'SPX', category:'index' });
  assert.deepEqual(normalizeSignalIdentity('NDX100', 'equity'), { symbol:'NDX', category:'index' });
  assert.equal(normalizeSignalIdentity('KR200', 'crypto'), null);
});

test('Signal identity accepts Binance regional equity classes and only exact untyped trade.xyz fallbacks', () => {
  assert.equal(categoryFromOfficialSignalType('HK_EQUITY'), 'equity');
  assert.equal(categoryFromOfficialSignalType('KR_EQUITY'), 'equity');
  assert.equal(tradeXyzSignalCategory('URANIUM', ''), 'commodity');
  assert.equal(tradeXyzSignalCategory('NIFTY', ''), 'index');
  assert.equal(tradeXyzSignalCategory('CAT', ''), null);
  assert.equal(tradeXyzSignalCategory('QNT', 'crypto'), null);
});

test('OKX production baselines distinguish listings from canonical assets', () => {
  assert.equal(PRODUCTION_BASELINES.perpetuals.okx, 183);
  assert.equal(PRODUCTION_BASELINES.perpetuals.binance, 155);
  assert.equal(PRODUCTION_BASELINES.perpetuals.total, 1079);
  assert.equal(PRODUCTION_BASELINES.spot.okx, 51);
  assert.equal(PRODUCTION_BASELINES.spot.total, 973);
  assert.equal(PRODUCTION_BASELINES.canonicalPerpetualAssets, 469);
});

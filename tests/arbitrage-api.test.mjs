import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectArbitragePublication,
  executableBookSide,
  requiresBinanceOpenInterestBackfill,
} from '../api/_lib/arbitrage-collector.js';
import {
  arbitrageSnapshotFromAuthorityRows,
  buildArbitrageAuthorityQueries,
} from '../api/_lib/arbitrage-authority.js';
import {
  ARBITRAGE_SOURCE_KEYS,
  arbitrageWriteMode,
  buildArbitragePublicationQueries,
  normalizeAuthoritativeArbitrageIdentityRows,
  normalizeAuthoritativeArbitrageSourceRows,
} from '../api/_lib/arbitrage-publication.js';
import { buildArbitrageSnapshot } from '../api/_lib/arbitrage-analysis.js';
import { serveArbitrageOpportunities } from '../api/arbitrage-opportunities.js';
import { serveArbitrageSnapshotCron } from '../api/arbitrage-snapshot-cron.js';
import { probeArbitrageOpportunities } from '../api/health.js';

const NOW = Date.parse('2026-09-04T10:02:00.000Z');

function response() {
  return {
    statusCode:null,
    headers:{},
    body:null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('Binance OI backfill distinguishes missing values from a real zero', () => {
  assert.equal(requiresBinanceOpenInterestBackfill({ venue:'binance', openInterestUsd:null }), true);
  assert.equal(requiresBinanceOpenInterestBackfill({ venue:'binance' }), true);
  assert.equal(requiresBinanceOpenInterestBackfill({ venue:'binance', openInterestUsd:0 }), false);
  assert.equal(requiresBinanceOpenInterestBackfill({ venue:'okx', openInterestUsd:null }), false);
});

function emptySnapshot() {
  return buildArbitrageSnapshot([], {
    availableSources:5,
    spotAvailableSources:5,
    identityConflicts:0,
    rejectedListings:0,
    quarantinedListings:0,
    complete:true,
  }, { generatedAt:NOW });
}

test('executable depth is side-specific and uses the producer tolerance', () => {
  const asks = executableBookSide([[100, 50], [101, 60], [103, 100]], 'buy');
  assert.equal(asks.priceUsd, 100);
  assert.equal(asks.executableDepthUsd, 11_060);
  const bids = executableBookSide([[101, 40], [100, 70], [98, 100]], 'sell', 2);
  assert.equal(bids.priceUsd, 101);
  assert.equal(bids.executableDepthUsd, 22_080);
});

test('Gate perpetual object levels preserve the official p and s fields', () => {
  assert.deepEqual(executableBookSide([
    { p:'100', s:'2' },
    { p:'99', s:'3' },
  ], 'sell', 1), {
    priceUsd:100,
    executableDepthUsd:497,
  });
});

test('public API returns JSON full snapshot or explicit 503 unavailable, never synthetic empty', async () => {
  const snapshot = emptySnapshot();
  const ok = response();
  await serveArbitrageOpportunities({ method:'GET', query:{} }, ok, {
    readSnapshot:async () => ({ status:'stored', payload:snapshot }),
    nowMs:NOW,
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.status, 'full');
  assert.equal(ok.body.coverage.expectedRoutes, 0);
  assert.match(ok.headers['Vercel-CDN-Cache-Control'], /max-age=15/);

  const unavailable = response();
  await serveArbitrageOpportunities({ method:'GET', query:{} }, unavailable, {
    readSnapshot:async () => ({ status:'empty', payload:null, reason:'warming' }),
  });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.body.status, 'unavailable');
  assert.equal(unavailable.body.coverage.expectedRoutes, null);
  assert.equal(unavailable.headers['Vercel-CDN-Cache-Control'], 'no-store');

  const failedRead = response();
  await serveArbitrageOpportunities({ method:'GET', query:{} }, failedRead, {
    readSnapshot:async () => { throw new Error('postgresql://secret@internal.example.invalid/database'); },
  });
  assert.equal(failedRead.statusCode, 503);
  assert.equal(failedRead.body.reason, 'authoritative-snapshot-unavailable');
  assert.doesNotMatch(JSON.stringify(failedRead.body), /secret|internal\.example/i);
});

test('health accepts only a fresh full arbitrage contract and distinguishes unavailability', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok:true, status:200, json:async () => emptySnapshot() });
    assert.equal((await probeArbitrageOpportunities('https://dashboard.example', NOW)).status, 'pass');

    globalThis.fetch = async () => ({ ok:false, status:503, json:async () => ({ status:'unavailable' }) });
    assert.equal((await probeArbitrageOpportunities('https://dashboard.example', NOW)).status, 'warn');

    globalThis.fetch = async () => ({ ok:true, status:200, json:async () => ({ ...emptySnapshot(), status:'partial' }) });
    assert.equal((await probeArbitrageOpportunities('https://dashboard.example', NOW)).status, 'fail');

    globalThis.fetch = async () => ({ ok:true, status:200, json:async () => emptySnapshot() });
    assert.equal((await probeArbitrageOpportunities('https://dashboard.example', NOW + 10 * 60_000 + 1)).status, 'fail');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('public API and writer reject browser-controlled methods and query parameters', async () => {
  for (const req of [
    { method:'POST', query:{} },
    { method:'GET', query:{ refresh:'1' } },
  ]) {
    const res = response();
    await serveArbitrageOpportunities(req, res, { readSnapshot:async () => { throw new Error('must not read'); } });
    assert.ok([400, 405].includes(res.statusCode));
  }
  let collected = false;
  const cron = response();
  await serveArbitrageSnapshotCron({ method:'GET', query:{}, headers:{} }, cron, {
    env:{ CRON_SECRET:'secret', ARBITRAGE_WRITE_MODE:'required' },
    collect:async () => { collected = true; },
  });
  assert.equal(cron.statusCode, 401);
  assert.equal(collected, false);
});

test('writer mode defaults off and authenticated disabled cron fails before collection', async () => {
  assert.equal(arbitrageWriteMode({}), 'off');
  assert.equal(arbitrageWriteMode({ ARBITRAGE_WRITE_MODE:'SHADOW' }), 'shadow');
  let collected = false;
  const res = response();
  await serveArbitrageSnapshotCron({ method:'GET', query:{}, headers:{} }, res, {
    authorized:true,
    writeMode:'off',
    collect:async () => { collected = true; },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(collected, false);
});

test('dedicated authority reader verifies role isolation and freshness', () => {
  const snapshot = emptySnapshot();
  const role = [{
    active_role_name:'rwa_arbitrage_reader',
    is_reader_member:true,
    is_not_database_owner:true,
    is_not_superuser:true,
    is_publication_reader:true,
    cannot_read_route_facts:true,
    cannot_read_raw_snapshots:true,
    cannot_read_identity_tables:true,
  }];
  const rows = [{
    snapshot_id:'id',
    generated_at:snapshot.generatedAt,
    valid_until:new Date(NOW + 10 * 60_000).toISOString(),
    payload:snapshot,
  }];
  assert.deepEqual(arbitrageSnapshotFromAuthorityRows(role, rows, { nowMs:NOW }), snapshot);
  assert.throws(() => arbitrageSnapshotFromAuthorityRows([{ ...role[0], cannot_read_route_facts:false }], rows, {
    nowMs:NOW,
  }), /least-privilege/);
  assert.throws(() => arbitrageSnapshotFromAuthorityRows(role, rows, { nowMs:NOW + 10 * 60_000 + 1 }), /stale/);
});

test('authority and publication queries pin roles and append one exact ten-source snapshot', () => {
  const calls = [];
  const sql = { query:(text, values = []) => { calls.push({ text, values }); return { text, values }; } };
  const authority = buildArbitrageAuthorityQueries(sql);
  assert.equal(authority.length, 3);
  assert.match(calls[0].text, /SET LOCAL ROLE rwa_arbitrage_reader/);
  assert.match(calls[2].text, /publication\.arbitrage_opportunity_v1/);

  calls.length = 0;
  const snapshot = emptySnapshot();
  const publication = buildArbitragePublicationQueries(sql, {
    snapshot,
    routeFacts:[],
    sources:ARBITRAGE_SOURCE_KEYS.map(sourceKey => ({ sourceKey, status:'full', listingCount:1 })),
  });
  assert.ok(publication.length >= 10);
  assert.match(calls[0].text, /SET LOCAL ROLE rwa_arbitrage_writer/);
  assert.ok(calls.some(call => /INSERT INTO fact\.arbitrage_route_observation/.test(call.text)));
  assert.ok(calls.some(call => /INSERT INTO publication\.arbitrage_opportunity_snapshot/.test(call.text)));
  assert.ok(calls.every(call => !/UPDATE publication\.arbitrage_opportunity_snapshot/.test(call.text)));
});

test('authoritative identities accept an unambiguous normalized lookup but preserve the official symbol', () => {
  const identities = normalizeAuthoritativeArbitrageIdentityRows([{
    source_key:'spot:kraken',
    official_venue_symbol:'AAPLxUSD',
    normalized_venue_symbol:'AAPLXUSD',
    category:'equity',
    canonical_underlying:'AAPL',
    display_name:'Apple',
    instrument_version_id:11,
    asset_version_id:1,
  }]);
  assert.equal(identities.get('spot:kraken:AAPLXUSD').venueSymbol, 'AAPLxUSD');
  assert.equal(identities.get('spot:kraken:AAPLxUSD').venueSymbol, 'AAPLxUSD');
  assert.throws(() => normalizeAuthoritativeArbitrageIdentityRows([
    {
      source_key:'spot:kraken', official_venue_symbol:'AAPLxUSD', normalized_venue_symbol:'AAPLXUSD',
      category:'equity', canonical_underlying:'AAPL', display_name:'Apple',
      instrument_version_id:11, asset_version_id:1,
    },
    {
      source_key:'spot:kraken', official_venue_symbol:'AAPLXUSD', normalized_venue_symbol:'AAPLXUSD',
      category:'equity', canonical_underlying:'AAPL', display_name:'Apple duplicate',
      instrument_version_id:12, asset_version_id:1,
    },
  ]), /Duplicate authoritative identities/);
  assert.deepEqual(
    new Set(normalizeAuthoritativeArbitrageSourceRows(ARBITRAGE_SOURCE_KEYS.map(source_key => ({ source_key })))),
    new Set(ARBITRAGE_SOURCE_KEYS),
  );
});

test('successful authenticated cron publishes once and exposes no internal evidence', async () => {
  const snapshot = emptySnapshot();
  const res = response();
  let writes = 0;
  await serveArbitrageSnapshotCron({ method:'GET', query:{}, headers:{} }, res, {
    authorized:true,
    writeMode:'shadow',
    collect:async () => ({ snapshot, routeFacts:[], sources:[], diagnostics:{ candidateRoutes:0, publishedRoutes:0 } }),
    write:async () => { writes += 1; return { snapshotId:'snapshot-id', checksum:'a'.repeat(64) }; },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(writes, 1);
  assert.deepEqual(Object.keys(res.body).sort(), [
    'bucket', 'checksum', 'diagnostics', 'generatedAt', 'mode', 'routes', 'snapshotId', 'status',
  ]);
});

test('collector joins only exact database identities and emits one policy-qualified route', async () => {
  const catalog = ARBITRAGE_SOURCE_KEYS.map(sourceKey => {
    const [market, venue] = sourceKey.split(':');
    return { market, venue, status:'full', listings:[] };
  });
  const spot = {
    market:'spot', venue:'kraken', venueSymbol:'NVDAXUSD', symbol:'NVDA', category:'equity',
    askPriceUsd:100, lastPriceUsd:100, observedAt:'2026-09-04T10:01:30.000Z',
  };
  const perp = {
    market:'perp', venue:'binance', venueSymbol:'NVDAUSDT', symbol:'NVDA', category:'equity',
    priceUsd:101.2, bidPriceUsd:101.2, openInterestUsd:2_000_000,
    fundingRate:0.0002, fundingIntervalHours:8, observedAt:'2026-09-04T10:01:45.000Z',
  };
  const normalizedTradeXyz = {
    market:'perp', venue:'tradexyz', venueSymbol:'xyz:AAPL', symbol:'AAPL', category:'equity',
    priceUsd:200, bidPriceUsd:200, openInterestUsd:0,
    fundingRate:0.0001, fundingIntervalHours:1, observedAt:'2026-09-04T10:01:45.000Z',
  };
  catalog.find(row => row.market === 'spot' && row.venue === 'kraken').listings = [{
    ...spot, canonicalSymbol:'NVDA', identityStatus:'verified',
  }];
  catalog.find(row => row.market === 'perp' && row.venue === 'binance').listings = [{
    ...perp, canonicalSymbol:'NVDA', identityStatus:'verified',
  }];
  catalog.find(row => row.market === 'perp' && row.venue === 'tradexyz').listings = [{
    ...normalizedTradeXyz, venueSymbol:'XYZ:AAPL', canonicalSymbol:'AAPL', identityStatus:'verified',
  }];
  const identities = normalizeAuthoritativeArbitrageIdentityRows([
    {
      source_key:'spot:kraken', official_venue_symbol:'NVDAxUSD', normalized_venue_symbol:'NVDAXUSD',
      category:'equity', canonical_underlying:'NVDA', display_name:'NVIDIA',
      instrument_version_id:11, asset_version_id:1,
    },
    {
      source_key:'perp:binance', official_venue_symbol:'NVDAUSDT', normalized_venue_symbol:'NVDAUSDT',
      category:'equity', canonical_underlying:'NVDA', display_name:'NVIDIA',
      instrument_version_id:12, asset_version_id:1,
    },
    {
      source_key:'perp:tradexyz', official_venue_symbol:'XYZ:AAPL', normalized_venue_symbol:'XYZ:AAPL',
      category:'equity', canonical_underlying:'AAPL', display_name:'Apple',
      instrument_version_id:13, asset_version_id:2,
    },
  ]);
  const emptyPerpCollector = async () => ({ listings:[], completeness:'full', warnings:[] });
  const result = await collectArbitragePublication({ headers:{} }, {
    nowMs:NOW,
    baseUrl:'https://dashboard.example',
    readInputs:async () => ({ identities, basisHistory:[] }),
    collectCatalog:async () => catalog,
    collectSpot:async () => ({
      listings:[spot],
      sources:Object.fromEntries(['gate', 'kraken', 'bitget', 'binance', 'okx'].map(venue => [venue, { status:'full' }])),
      conflicts:[],
      quarantinedListings:0,
    }),
    perpCollectors:{
      gate:emptyPerpCollector,
      binance:async () => ({ listings:[perp], completeness:'full', warnings:[] }),
      bitget:emptyPerpCollector,
      tradexyz:async () => ({ listings:[normalizedTradeXyz], completeness:'full', warnings:[] }),
      okx:emptyPerpCollector,
    },
    fillBinanceOi:async () => 0,
    fetchOrderBook:async listing => listing.market === 'spot'
      ? { priceUsd:100, executableDepthUsd:25_000, observedAt:'2026-09-04T10:01:30.000Z' }
      : { priceUsd:101.2, executableDepthUsd:30_000, observedAt:'2026-09-04T10:01:45.000Z' },
    fetchFundingHistories:async () => new Map([['binance:NVDAUSDT', [
      { fundingTime:NOW - 24 * 60 * 60_000, fundingRate:0.00022 },
      { fundingTime:NOW - 16 * 60 * 60_000, fundingRate:0.00022 },
      { fundingTime:NOW - 8 * 60 * 60_000, fundingRate:0.00022 },
      { fundingTime:NOW, fundingRate:0.00022 },
    ]]]),
  });
  assert.equal(result.snapshot.status, 'full');
  assert.equal(result.snapshot.routes.length, 1);
  assert.equal(result.snapshot.routes[0].name, 'NVIDIA');
  assert.equal(result.snapshot.routes[0].basis.pct, 1.2);
  assert.equal(result.snapshot.routes[0].spot.venueSymbol, 'NVDAxUSD');
  assert.equal(result.routeFacts[0].authority.spotInstrumentVersionId, 11);
  assert.equal(result.routeFacts[0].authority.perpInstrumentVersionId, 12);
  assert.equal(result.sources.length, 10);

  const observedOnly = await collectArbitragePublication({ headers:{} }, {
    nowMs:NOW,
    baseUrl:'https://dashboard.example',
    readInputs:async () => ({ identities, basisHistory:[] }),
    collectCatalog:async () => catalog,
    collectSpot:async () => ({
      listings:[spot],
      sources:Object.fromEntries(['gate', 'kraken', 'bitget', 'binance', 'okx'].map(venue => [venue, { status:'full' }])),
      conflicts:[],
      quarantinedListings:0,
    }),
    perpCollectors:{
      gate:emptyPerpCollector,
      binance:async () => ({ listings:[{ ...perp, fundingRate:0.0001 }], completeness:'full', warnings:[] }),
      bitget:emptyPerpCollector,
      tradexyz:async () => ({ listings:[normalizedTradeXyz], completeness:'full', warnings:[] }),
      okx:emptyPerpCollector,
    },
    fillBinanceOi:async () => 0,
    fetchOrderBook:async listing => listing.market === 'spot'
      ? { priceUsd:100, executableDepthUsd:25_000, observedAt:'2026-09-04T10:01:30.000Z' }
      : { priceUsd:101.2, executableDepthUsd:30_000, observedAt:'2026-09-04T10:01:45.000Z' },
    fetchFundingHistories:async () => new Map([['binance:NVDAUSDT', [
      { fundingTime:NOW - 24 * 60 * 60_000, fundingRate:0.0001 },
      { fundingTime:NOW - 16 * 60 * 60_000, fundingRate:0.0001 },
      { fundingTime:NOW - 8 * 60 * 60_000, fundingRate:0.0001 },
      { fundingTime:NOW, fundingRate:0.0001 },
    ]]]),
  });
  assert.equal(observedOnly.routeFacts.length, 1);
  assert.equal(observedOnly.snapshot.routes.length, 0);
  assert.equal(observedOnly.diagnostics.observedRoutes, 1);
});

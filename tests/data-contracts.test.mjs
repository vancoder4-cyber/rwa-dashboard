import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

import { historyCoverage, normalizeHistoryRows } from '../api/funding-history.js';
import { assessChecks } from '../api/_lib/health.js';
import { FX_REFERENCE_MAP, yahooSymbolFor } from '../api/_lib/reference-map.js';
import { setNoStore, setPublicCache } from '../api/_lib/upstream.js';
import {
  SIGNAL_ASSET_LIMIT,
  aggregateSignalListings,
  attachSignalAnalysis,
  canonicalSignalSymbol,
  compactSignalSnapshot,
} from '../api/_lib/signal-analysis.js';
import {
  BROAD_STOCK_INDEX_UNDERLYINGS,
  GATE_SPOT_EXACT_LEGACY_PAIRS,
  GATE_SPOT_VERIFIED_WRAPPERS,
  SECURITY_ETF_UNDERLYINGS,
  SECURITY_LISTING_REGISTRY,
  TOKENIZED_ETF_WRAPPERS,
  categoryFromOfficialSignalType,
  normalizeSignalIdentity,
} from '../api/_lib/security-identity.js';
import gateBulkHandler from '../api/gate-bulk.js';
import signalSnapshotHandler, {
  OI_CATALOG_QUARANTINE_WARNING,
  isSignalSnapshotComparable,
  mergeSignalHistory,
  oiTriggeredBinanceSymbols,
  signalHistoryWriteSucceeded,
} from '../api/signal-snapshot.js';
import signalSnapshotCronHandler from '../api/signal-snapshot-cron.js';
import tradfiActivityHandler, {
  buildTraditionalCandidates,
  canAcceptNasdaqHistorical,
  classifyNasdaqHistoricalRange,
  classifyNasdaqHistoricalPayload,
  estimatedOptionsNotional,
  estimatedShareValue,
  findFirstNonEmptyOccReport,
  hasCompleteTraditionalAlignment,
  nasdaqHistoricalWindow,
  occDateToIso,
  optionActivityForSymbol,
  parseNasdaqDirectory,
  parseNasdaqHistoricalAverage,
  parseNasdaqHistoricalRow,
  parseOccReport,
  rankTraditionalRows,
  summarizeTraditionalAlignment,
  traditionalTotalValueState,
} from '../api/tradfi-activity.js';
import tradfiPricesHandler from '../api/tradfi-prices.js';

function responseRecorder() {
  return {
    statusCode:200,
    payload:null,
    headers:{},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
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

async function withFetchStub(stub, operation) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

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

test('signal identity gate rejects crypto types, quarantines category collisions, and preserves real zero funding', () => {
  assert.equal(canonicalSignalSymbol('QNT', 'crypto'), null);
  assert.equal(canonicalSignalSymbol('OPENAI', 'preipo'), 'OPENAI');
  assert.equal(canonicalSignalSymbol('CL', 'equity'), 'CL');
  assert.equal(canonicalSignalSymbol('CL', 'commodity'), 'WTI');
  const result = aggregateSignalListings([
    {
      symbol:'QNTX', category:'equity', venue:'binance', venueSymbol:'QNTXUSDT',
      priceUsd:100, volume24hUsd:1_000_000, openInterestUsd:null,
      fundingRate:0, fundingIntervalHours:8, change24hPct:1,
    },
    {
      symbol:'QNT', category:'crypto', venue:'malicious', venueSymbol:'QNTUSDT',
      priceUsd:1, volume24hUsd:9_999_999, openInterestUsd:9_999_999,
      fundingRate:0.1, fundingIntervalHours:8, change24hPct:99,
    },
    {
      symbol:'DUAL', category:'equity', venue:'one', venueSymbol:'DUAL-EQUITY',
      priceUsd:10, volume24hUsd:1, openInterestUsd:1, fundingRate:0, fundingIntervalHours:8,
    },
    {
      symbol:'DUAL', category:'index', venue:'two', venueSymbol:'DUAL-INDEX',
      priceUsd:1_000, volume24hUsd:1, openInterestUsd:1, fundingRate:0, fundingIntervalHours:8,
    },
  ]);
  assert.deepEqual(result.assets.map(asset => `${asset.category}:${asset.symbol}`), ['equity:QNT']);
  assert.equal(result.rejected.length, 1);
  assert.deepEqual(result.conflicts, [{
    symbol:'DUAL',
    categories:['equity', 'index'],
    venues:['one', 'two'],
    listings:[
      { venue:'one', venueSymbol:'DUAL-EQUITY', category:'equity' },
      { venue:'two', venueSymbol:'DUAL-INDEX', category:'index' },
    ],
  }]);
  assert.equal(result.assets[0].listings[0].fundingRate, 0);
  assert.equal(result.assets[0].listings[0].fundingIntervalHours, 8);
  assert.equal(result.assets[0].listings[0].fundingAnnualizedPct, 0);
  assert.equal(result.assets[0].fieldStatus.funding, 'full');
  assert.equal(result.assets[0].openInterestUsd, null);
  assert.equal(result.assets[0].fieldStatus.openInterestUsd, 'unavailable');
});

test('signal lifecycle, wrapper, and official-type identity rules match the client registry', async () => {
  assert.deepEqual(normalizeSignalIdentity('SPCXB', 'pre-ipo'), { symbol:'SPCX', category:'equity' });
  assert.deepEqual(normalizeSignalIdentity('CBRSON', 'pre-ipo'), { symbol:'CBRS', category:'equity' });
  assert.deepEqual(normalizeSignalIdentity('QNTB', 'equity'), { symbol:'QNT', category:'equity' });
  assert.deepEqual(normalizeSignalIdentity('OPENAI', 'equity'), { symbol:'OPENAI', category:'pre-ipo' });
  assert.deepEqual(normalizeSignalIdentity('ANTHROPIC', 'equity'), { symbol:'ANTHROPIC', category:'pre-ipo' });
  assert.deepEqual(normalizeSignalIdentity('AAPLB', 'equity', { allowBinanceBstock:true }), { symbol:'AAPL', category:'equity' });
  assert.deepEqual(normalizeSignalIdentity('QQQB', 'equity', { allowBinanceBstock:true }), { symbol:'QQQ', category:'etf' });
  assert.deepEqual(normalizeSignalIdentity('SOXLB', 'equity', { allowBinanceBstock:true }), { symbol:'SOXL', category:'etf' });
  assert.deepEqual(normalizeSignalIdentity('MUU', 'equity'), { symbol:'MUU', category:'etf' });
  assert.deepEqual(normalizeSignalIdentity('SPYX', 'equity'), { symbol:'SPYX', category:'etf' });
  assert.deepEqual(normalizeSignalIdentity('QQQX', 'equity'), { symbol:'QQQX', category:'equity' });
  assert.deepEqual(normalizeSignalIdentity('SPYX', 'equity', { venue:'gate' }), { symbol:'SPY', category:'etf' });
  assert.deepEqual(normalizeSignalIdentity('QQQX', 'equity', { venue:'gate' }), { symbol:'QQQ', category:'etf' });
  assert.deepEqual(normalizeSignalIdentity('SKHX', 'etf'), { symbol:'SKHX', category:'etf' });
  assert.deepEqual(normalizeSignalIdentity('QNTB', 'etf'), { symbol:'QNTB', category:'etf' });
  assert.deepEqual(normalizeSignalIdentity('SPCXB', 'etf'), { symbol:'SPCXB', category:'etf' });
  assert.deepEqual(normalizeSignalIdentity('CBRSB', 'etf'), { symbol:'CBRSB', category:'etf' });
  assert.deepEqual(normalizeSignalIdentity('SKHX', 'equity', { venue:'tradexyz' }), { symbol:'SKHYNIX', category:'equity' });
  assert.deepEqual(normalizeSignalIdentity('SP500', 'equity', { venue:'bitget' }), { symbol:'SPX', category:'index' });
  assert.deepEqual(normalizeSignalIdentity('NDX100', 'equity', { venue:'bitget' }), { symbol:'NDX', category:'index' });
  assert.deepEqual(normalizeSignalIdentity('JP225', 'equity', { venue:'bitget' }), { symbol:'JP225', category:'index' });
  assert.deepEqual(normalizeSignalIdentity('JP225', 'equity', { venue:'binance' }), { symbol:'JP225', category:'equity' });
  assert.deepEqual(normalizeSignalIdentity('FOOB', 'equity', { allowBinanceBstock:true }), { symbol:'FOOB', category:'equity' });
  assert.deepEqual(BROAD_STOCK_INDEX_UNDERLYINGS, ['SP500', 'NDX100', 'KR200', 'JP225']);
  assert.equal(categoryFromOfficialSignalType('ETF'), 'etf');
  assert.equal(categoryFromOfficialSignalType('stock_etf'), 'etf');
  assert.equal(categoryFromOfficialSignalType('CN_EQUITY'), 'equity');
  assert.equal(categoryFromOfficialSignalType('crypto_etf_token'), null);
  assert.equal(categoryFromOfficialSignalType('ETFCOIN'), null);

  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /const BROAD_STOCK_INDEX_SYMBOLS = new Set\(\['SP500','NDX100','KR200','JP225'\]\)/);
  const tradeXyzLoader = sourceBetween(html, 'async function fetchTradeXyz()', '// API: Bitget');
  assert.match(tradeXyzLoader, /u\?\.isDelisted === true[\s\S]*?continue/,
    'the main Perpetual page must exclude the same officially delisted trade.xyz rows as Radar and Listing Audit');
  const registrySource = sourceBetween(
    html,
    'const SECURITY_LISTING_REGISTRY = Object.freeze({',
    'const SECURITY_LISTING_ALIAS_MAP = Object.freeze(',
  );
  const clientCanonicals = [...registrySource.matchAll(/^\s{2}([A-Z0-9]+): Object\.freeze\(\{/gm)]
    .map(match => match[1])
    .sort();
  assert.deepEqual(clientCanonicals, Object.keys(SECURITY_LISTING_REGISTRY).sort());
  for (const [canonical, record] of Object.entries(SECURITY_LISTING_REGISTRY)) {
    const entry = registrySource.match(new RegExp(
      `\\b${canonical}: Object\\.freeze\\(\\{[\\s\\S]*?category:'([^']+)'[\\s\\S]*?aliases:Object\\.freeze\\(\\[([^\\]]*)\\]\\)`,
    ));
    assert.ok(entry, `missing client lifecycle entry for ${canonical}`);
    assert.equal(entry[1], record.category, `category drift for ${canonical}`);
    const aliases = [...entry[2].matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
    assert.deepEqual(aliases, [...record.aliases].sort(), `alias drift for ${canonical}`);
  }

  const etfSource = sourceBetween(
    html,
    'const ETF_SYMBOLS = new Set([',
    '// Venue wrapper tickers whose underlying is an ETF',
  );
  const clientEtfs = [...new Set([...etfSource.matchAll(/'([A-Z0-9-]+)'/g)].map(match => match[1]))].sort();
  assert.deepEqual(clientEtfs, [...SECURITY_ETF_UNDERLYINGS].sort(), 'ETF identity drift between client and server');
  const wrapperSource = sourceBetween(
    html,
    'const TOKENIZED_ETF_WRAPPERS = Object.freeze({',
    '// One audited lifecycle registry owns',
  );
  const clientWrappers = Object.fromEntries(
    [...wrapperSource.matchAll(/([A-Z0-9]+):'([A-Z0-9-]+)'/g)].map(match => [match[1], match[2]]),
  );
  assert.deepEqual(clientWrappers, TOKENIZED_ETF_WRAPPERS, 'tokenized ETF wrapper drift between client and server');
  const gateWrapperSource = sourceBetween(
    html,
    'const GATE_SPOT_VERIFIED_WRAPPERS = new Set([',
    'function registerSpotAssetMeta(',
  );
  const clientGateWrappers = [...new Set(
    [...gateWrapperSource.matchAll(/'([A-Z0-9.-]+)'/g)].map(match => match[1]),
  )].sort();
  assert.deepEqual(
    clientGateWrappers,
    [...GATE_SPOT_VERIFIED_WRAPPERS].sort(),
    'Gate Spot exact-wrapper identity drift between client and server',
  );
  const gateLegacySource = sourceBetween(
    html,
    'const GATE_SPOT_EXACT_LEGACY_PAIRS = Object.freeze({',
    'const GATE_SPOT_VERIFIED_WRAPPERS = new Set([',
  );
  const clientGateLegacyPairs = Object.fromEntries(
    [...gateLegacySource.matchAll(/([A-Z0-9_]+):Object\.freeze\(\{ base:'([^']+)', quote:'([^']+)', underlying:'([^']+)', category:'([^']+)' \}\)/g)]
      .map(match => [match[1], { base:match[2], quote:match[3], underlying:match[4], category:match[5] }]),
  );
  assert.deepEqual(
    clientGateLegacyPairs,
    GATE_SPOT_EXACT_LEGACY_PAIRS,
    'Gate Spot exact legacy-pair identity drift between client and server',
  );
  const gateSpotLoader = sourceBetween(html, 'async function fetchSpotRwaGate(', '// ── Kraken Spot Fetch ──');
  assert.match(gateSpotLoader, /const exactLegacy = isExactGateLegacySpotPair\(entry\)[\s\S]*?if \(!exactLegacy && !_isRwaSpotBase\(base, 'gate'\)\) continue/);
  assert.match(gateSpotLoader, /const gateUnderlying = exactLegacy\?\.underlying \|\|[\s\S]*?category:gateCategory \|\| undefined/,
    'Gate exact legacy rows must carry their canonical underlying and category into the client data row');
  const spotIdentityGate = sourceBetween(html, 'function _isRwaSpotBase(', '// ── Proxy base URLs');
  assert.match(spotIdentityGate, /const up = base\.toUpperCase\(\);[\s\S]*?if \(venue === 'gate'\) return GATE_SPOT_VERIFIED_WRAPPERS\.has\(up\);[\s\S]*?if \(typeof ASSET_META/,
    'Gate must resolve its exact wrapper gate before mutable venue metadata or commodity ticker fallbacks');
  assert.doesNotMatch(spotIdentityGate, /allowedVenues\.includes\('gate'\)/,
    'a prior refresh must not widen a Gate legacy pair through mutable ASSET_META venues');
  const spotVenueGrid = sourceBetween(html, 'function renderSpotVenueGrid()', 'function renderSpotArbRank()');
  assert.match(spotVenueGrid, /const cat = _spotAssetCategory\(a\)/,
    'Spot venue category totals must use the same asset-specific identity as tables and joins');
});

test('listing audit cache epoch is internally consistent and leaves no pre-release v1 storage key', async () => {
  const source = await readFile(new URL('../api/listing-changes.js', import.meta.url), 'utf8');
  assert.match(source, /const CACHE_NAMESPACE = 'rwa-listing-audit-v2'/);
  assert.match(source, /const BUNDLE_KEY = 'audit-bundle-v2'/);
  assert.equal((source.match(/rwa-listing-audit-v2/g) || []).length, 3);
  assert.doesNotMatch(source, /rwa-listing-audit-v1|audit-bundle-v1/);
  assert.match(source, /if \(listingSnapshotIsCacheable\(snapshot\)\) \{[\s\S]*?setPublicCache\(res, 300, 600\)[\s\S]*?Vercel-Cache-Tag[\s\S]*?\} else \{[\s\S]*?setNoStore\(res\)/,
    'an uninitialized cache epoch must never CDN-cache its empty Warming snapshot');
});

test('signal history uses idempotent hourly buckets and a bounded seven-day ring', () => {
  const hour = 3_600_000;
  const now = 2_000_000_000_000;
  const history = Array.from({ length:200 }, (_, index) => ({
    t:now - (199 - index) * hour,
    a:[[String(index), 'equity', index, index, 0, 1, 0, 0, 1]],
  }));
  const replacement = { t:now, a:[['LATEST', 'equity', 1, 1, 0, 1, 0, 0, 1]] };
  const merged = mergeSignalHistory(history, replacement, now);
  assert.equal(merged.length, 168);
  assert.equal(new Set(merged.map(snapshot => snapshot.t)).size, merged.length);
  assert.deepEqual(merged.at(-1), replacement);
  assert.equal(merged.filter(snapshot => snapshot.t < replacement.t).length, 167);
});

test('signal response and history share one activity-ranked Top 100 universe', () => {
  const listings = Array.from({ length:125 }, (_, index) => ({
    symbol:`ASSET${index}`,
    category:'equity',
    venue:'gate',
    venueSymbol:`ASSET${index}_USDT`,
    priceUsd:1,
    volume24hUsd:index,
    openInterestUsd:index,
    fundingRate:0,
    fundingIntervalHours:8,
  }));
  const assets = aggregateSignalListings(listings).assets;
  assert.equal(aggregateSignalListings(listings).totalAssetCount, 125);
  const compact = compactSignalSnapshot(assets, 2_000_000_000_000);
  assert.equal(SIGNAL_ASSET_LIMIT, 100);
  assert.equal(assets.length, SIGNAL_ASSET_LIMIT);
  assert.equal(compact.a.length, assets.length);
  assert.deepEqual(compact.a.map(row => row[0]), assets.map(asset => asset.symbol));
});

test('signal analysis exposes warming history without hiding absolute high-severity thresholds', () => {
  const aggregated = aggregateSignalListings([{
    symbol:'AAPL', category:'equity', venue:'gate', venueSymbol:'AAPL_USDT',
    priceUsd:200, volume24hUsd:5_000_000, openInterestUsd:2_000_000,
    fundingRate:0.001, fundingIntervalHours:8, change24hPct:1,
  }]).assets;
  const analyzed = attachSignalAnalysis(aggregated, [], 2_000_000_000_000)[0];
  assert.equal(analyzed.signal.baselineStatus, 'warming');
  assert.equal(analyzed.signal.level, 'high');
  assert.equal(analyzed.signal.status, 'partial');
  assert.ok(analyzed.signal.reasonCodes.includes('BASELINE_WARMING'));
  assert.ok(analyzed.signal.reasonCodes.includes('FUNDING_THRESHOLD'));
  assert.equal(analyzed.history.availableSamples, 1);
  assert.equal(compactSignalSnapshot(aggregated, 2_000_000_000_000).a.length, 1);
});

test('signal analysis keeps Full at 168 total samples and detects a zero-variance break', () => {
  const hour = 3_600_000;
  const now = 2_000_000_000_000;
  const historical = Array.from({ length:167 }, (_, index) => ({
    t:now - (167 - index) * hour,
    a:[['AAPL', 'equity', 0, 0, 0, 100, 0, null, 1]],
  }));
  const current = aggregateSignalListings([{
    symbol:'AAPL', category:'equity', venue:'gate', venueSymbol:'AAPL_USDT',
    priceUsd:112, volume24hUsd:1_000_000, openInterestUsd:500_000,
    fundingRate:0, fundingIntervalHours:8, change24hPct:12,
  }]).assets;
  const analyzed = attachSignalAnalysis(current, historical, now)[0];
  assert.equal(analyzed.history.availableSamples, 168);
  assert.equal(analyzed.signal.baselineStatus, 'full');
  assert.equal(analyzed.signal.components.volume.score, 100);
  assert.equal(analyzed.signal.components.openInterest.score, 100);
  assert.ok(analyzed.signal.reasonCodes.includes('PRICE_MOVE_THRESHOLD'));
  assert.ok(analyzed.signal.reasonCodes.includes('VOLUME_ROBUST_Z'));
});

test('incomplete five-source coverage cannot become comparable anomaly history', () => {
  const fullSources = Object.fromEntries(['gate', 'binance', 'bitget', 'tradexyz', 'okx'].map(name => [name, { status:'full' }]));
  assert.equal(isSignalSnapshotComparable(fullSources), true);
  assert.equal(isSignalSnapshotComparable({ ...fullSources, gate:{ status:'partial' } }), false);
  assert.equal(isSignalSnapshotComparable({ ...fullSources, gate:{ status:'unavailable' } }), false);
  const quarantinedBinance = {
    status:'partial', listingCount:169, catalogListingCount:170, quarantinedListings:1,
    warnings:[OI_CATALOG_QUARANTINE_WARNING, 'OPEN_INTEREST_INCOMPLETE'],
  };
  assert.equal(isSignalSnapshotComparable({ ...fullSources, binance:quarantinedBinance }), true,
    'one closed unknown-type quarantine plus asset-level OI gaps may keep verified histories writable');
  assert.equal(isSignalSnapshotComparable({
    ...fullSources,
    binance:{ ...quarantinedBinance, warnings:[
      OI_CATALOG_QUARANTINE_WARNING,
      'OPTIONAL_MARKET_FIELDS_UNAVAILABLE',
    ] },
  }), false, 'an optional upstream failure cannot hide behind the quarantine exception');
  assert.equal(isSignalSnapshotComparable({
    ...fullSources,
    binance:{ ...quarantinedBinance, catalogListingCount:171, quarantinedListings:2 },
  }), false, 'multiple unknown rows are treated as possible schema drift');
  const asset = aggregateSignalListings([{
    symbol:'AAPL', category:'equity', venue:'gate', venueSymbol:'AAPL_USDT',
    priceUsd:100, volume24hUsd:1, openInterestUsd:1, fundingRate:0, fundingIntervalHours:8,
  }]).assets;
  const analyzed = attachSignalAnalysis(asset, [], 2_000_000_000_000, { snapshotComparable:false })[0];
  assert.equal(analyzed.signal.status, 'partial');
  assert.equal(analyzed.signal.level, 'warming');
  assert.ok(analyzed.signal.reasonCodes.includes('SOURCE_SNAPSHOT_INCOMPARABLE'));
});

test('signal snapshot rejects cache-busting input before source or cache work', async () => {
  let fetchCount = 0;
  await withFetchStub(async () => {
    fetchCount += 1;
    throw new Error('invalid request reached upstream');
  }, async () => {
    const response = responseRecorder();
    await signalSnapshotHandler({ method:'GET', query:{ refresh:'1' }, headers:{} }, response);
    assert.equal(response.statusCode, 400);
    assert.equal(response.payload.error, 'Unsupported query parameter');
    assert.equal(response.headers['Cache-Control'], 'private, no-store, max-age=0');
  });
  assert.equal(fetchCount, 0);
});

test('signal snapshot cron is authenticated and never CDN cached', async () => {
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'contract-test-secret';
  try {
    const response = responseRecorder();
    await signalSnapshotCronHandler({ method:'GET', query:{}, headers:{} }, response);
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['Cache-Control'], 'private, no-store, max-age=0');
    assert.equal(response.headers['Vercel-CDN-Cache-Control'], 'no-store');
  } finally {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
});

test('public Signal Radar is read-only while the authenticated cron writes all four histories', async () => {
  const [source, cronSource] = await Promise.all([
    readFile(new URL('../api/signal-snapshot.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/signal-snapshot-cron.js', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /const DAILY_VOLUME_HISTORY_NAMESPACE = 'rwa-signal-volume-daily-v1'/);
  assert.match(source, /const DAILY_VOLUME_HISTORY_KEY = 'daily-volume-history-v1'/);
  assert.match(source, /SPOT_ANOMALY_HISTORY_NAMESPACE/);
  assert.match(source, /const SPOT_ANOMALY_HISTORY_KEY = 'spot-volume-price-daily-v1'/);
  assert.match(source, /OI_LIQUIDATION_HISTORY_NAMESPACE/);
  assert.match(source, /const OI_LIQUIDATION_HISTORY_KEY = 'oi-liquidation-hourly-v1'/);
  assert.match(source, /return serveSignalSnapshot\(req, res, \{ publicCache:true, writeHistory:false \}\)/);
  assert.match(cronSource, /serveSignalSnapshot\(req, res, \{ publicCache:false, writeHistory:true \}\)/);
  assert.match(source, /updateDailyVolumeHistory\(normalized\.allAssets/,
    'daily volume history must use the complete verified universe, not response Top 100');
  assert.match(source, /updateOiLiquidationHistory\(normalized\.allAssets/,
    'OI history must use the complete verified universe, not response Top 100');
  assert.match(source, /writeRequested:writeHistory[\s\S]*?writeAllowed:analysisComparable/);
  assert.match(source, /res\.status\(writeHistory && !writerSucceeded \? 503 : 200\)/,
    'an authenticated history writer must not report HTTP 200 when either cache write fails or is skipped');
  assert.equal(signalHistoryWriteSucceeded(
    { writeStatus:'stored' },
    { writeStatus:'stored' },
    { writeStatus:'stored' },
    { writeStatus:'stored' },
  ), true);
  assert.equal(signalHistoryWriteSucceeded({ writeStatus:'stored' }, { writeStatus:'stored' }), false);
  assert.equal(signalHistoryWriteSucceeded(
    { writeStatus:'stored' },
    { writeStatus:'skipped-incomplete-sources' },
    { writeStatus:'stored' },
    { writeStatus:'stored' },
  ), false);
  assert.equal(signalHistoryWriteSucceeded(
    { writeStatus:'stored' },
    { writeStatus:'stored' },
    { writeStatus:'unavailable' },
    { writeStatus:'stored' },
  ), false);
  assert.equal(signalHistoryWriteSucceeded(
    { writeStatus:'stored' },
    { writeStatus:'stored' },
    { writeStatus:'stored' },
    { writeStatus:'unavailable' },
  ), false);
});

test('Gate OI uses total_size and never treats long-only position_size as total open interest', async () => {
  const source = await readFile(new URL('../api/signal-snapshot.js', import.meta.url), 'utf8');
  const numericHelpers = sourceBetween(source, 'function finiteOrNull(value)', 'function hasCatalogIdentityWarning(warnings)');
  const explicitBooleanHelper = sourceBetween(source, 'function isExplicitTrue(value)', 'export function tradeXyzSignalCategory');
  const gateCollector = sourceBetween(source, 'function gateListings(payload)', 'async function collectGate(baseUrl)');
  assert.match(gateCollector, /finiteOrNull\(ticker\.total_size\)/);
  assert.match(gateCollector, /const valuationPriceMethod = markPrice !== null \? 'mark-price' : 'last-price'/);
  assert.match(gateCollector, /`total-size-x-quanto-x-\$\{valuationPriceMethod\}`/,
    'Gate OI must disclose whether the estimate used mark or last price');
  assert.doesNotMatch(gateCollector, /finiteOrNull\([^\n]*position_size/,
    'Gate position_size is aggregate long positions and must not populate OI');

  const gateContext = {
    categoryFromOfficialSignalType,
    normalizeSignalIdentity,
    payload:{
      contracts:[
        { name:'AAPL_USDT', contract_type:'stocks', quanto_multiplier:'0.5' },
        { name:'MSFT_USDT', contract_type:'stocks', quanto_multiplier:'0.5' },
        { name:'TSLA_USDT', contract_type:'stocks' },
        { name:'NVDA_USDT', contract_type:'stocks', quanto_multiplier:'0' },
        { name:'META_USDT', contract_type:'stocks', quanto_multiplier:'1' },
      ],
      tickers:[
        { contract:'AAPL_USDT', total_size:'10', mark_price:'200', last:'190', position_size:'999999' },
        { contract:'MSFT_USDT', total_size:'10', last:'300', position_size:'999999' },
        { contract:'TSLA_USDT', total_size:'10', mark_price:'250' },
        { contract:'NVDA_USDT', total_size:'10', mark_price:'250' },
        { contract:'META_USDT', total_size:'10', mark_price:'0', last:'500' },
      ],
    },
  };
  runInNewContext(`${numericHelpers}\n${explicitBooleanHelper}\n${gateCollector}\n` +
    'globalThis.rows = gateListings(payload);', gateContext);
  const gateRows = Object.fromEntries(gateContext.rows.map(row => [row.symbol,row]));
  assert.equal(gateRows.AAPL.openInterestUsd, 1_000);
  assert.equal(gateRows.AAPL.openInterestMethod, 'total-size-x-quanto-x-mark-price');
  assert.equal(gateRows.MSFT.openInterestUsd, 1_500);
  assert.equal(gateRows.MSFT.openInterestMethod, 'total-size-x-quanto-x-last-price');
  for (const symbol of ['TSLA','NVDA','META']) {
    assert.equal(gateRows[symbol].openInterestUsd, null,
      `${symbol} must fail closed when multiplier or valuation price is not positive`);
    assert.equal(gateRows[symbol].openInterestMethod, null);
    assert.equal(gateRows[symbol].openInterestStatus, 'unavailable');
  }
});

test('Binance positioning enrichment targets come from uncapped triggered states, not ranked rows', () => {
  const states = Array.from({ length:101 }, (_, index) => ({
    evaluationStatus:'triggered',
    marketContext:{
      positioning:{ venue:'binance', venueSymbol:`X${String(index).padStart(3, '0')}USDT` },
    },
  }));
  states.push({
    evaluationStatus:'triggered',
    marketContext:{ positioning:{ venue:'tradexyz', venueSymbol:'XYZ:X999' } },
  });
  states.push({
    evaluationStatus:'clear',
    currentOpenInterestUsd:20_000_000,
    trough24hOpenInterestUsd:10_000_000,
    increase24hUsd:10_000_000,
    marketContext:{ positioning:{ venue:'binance', venueSymbol:'SURGEUSDT' } },
  });
  const targets = oiTriggeredBinanceSymbols({ states, rows:[] });
  assert.equal(targets.length, 102);
  assert.ok(targets.includes('X100USDT'));
  assert.ok(targets.includes('SURGEUSDT'));
  assert.ok(!targets.includes('X999'));
});

test('Signal health allows the bounded Spot/OI cold-start budget without retrying the snapshot', async () => {
  const [health, spotAnomaly] = await Promise.all([
    readFile(new URL('../api/health.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/_lib/spot-volume-price-anomaly.js', import.meta.url), 'utf8'),
  ]);
  const budget = Number(spotAnomaly.match(/SPOT_ANOMALY_COLLECTION_BUDGET_MS = ([\d_]+)/)?.[1]?.replaceAll('_',''));
  const probe = sourceBetween(health, 'async function probeSignalRadar(baseUrl)', 'async function probeFunding(baseUrl');
  const timeout = Number(probe.match(/timeoutMs:(\d[\d_]*)/)?.[1]?.replaceAll('_',''));
  assert.ok(Number.isFinite(budget) && Number.isFinite(timeout));
  assert.ok(timeout >= budget + 5_000, 'health must outwait a valid cold Spot collection with safety margin');
  assert.equal(timeout, 50_000);
  assert.ok(timeout < 60_000, 'health probe must finish below the Vercel Function ceiling');
  assert.match(probe, /retries:0/);
});

test('traditional activity is a standalone top-level page', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /data-p="traditional" onclick="switchTopPage\('traditional'\)"/);
  assert.match(html, /<div class="page-container" id="page-traditional">[\s\S]*?id="tradfiActivitySection"/);
  assert.equal((html.match(/id="tradfiActivitySection"/g) || []).length, 1);
  assert.doesNotMatch(
    html,
    /function renderOverview\(\) \{[^}]*renderTraditionalActivity\(\)/,
  );
  assert.match(html, /\['perps','spot','traditional','cross'\]/);
  assert.match(html, /fetch\('\/api\/tradfi-activity\?limit=100'\)/);
  assert.match(html, /const TRADFI_INITIAL_VISIBLE = 50/);
  assert.match(html, /const TRADFI_MAX_VISIBLE = 100/);
  assert.match(html, /const visibleRows = rows\.slice\(0, Math\.min\(tradfiVisibleLimit, TRADFI_MAX_VISIBLE\)\)/);
  assert.match(html, /function showMoreTraditionalActivity\(\) \{[\s\S]*tradfiVisibleLimit = TRADFI_MAX_VISIBLE/);
  assert.match(html, /traditionalRankChangeHtml\(row, payload\.methodology\?\.comparisonSession\)/);
  const traditionalSearchRender = /if \(document\.querySelector\('\.top-tab\[data-p="traditional"\]'\)\?\.classList\.contains\('active'\)\) renderTraditionalActivity\(\);/g;
  assert.equal((html.match(traditionalSearchRender) || []).length, 2);
  assert.match(html, />↑\$\{change\.delta\}</);
  assert.match(html, />↓\$\{amount\}</);
  assert.match(html, />NEW</);
  assert.match(html, /row\.options\?\.hasOfficialSeries === true/);
  assert.match(html, /traditionalTotalValueStatus/);
  assert.match(html, /traditionalTotalValueObserved/);
});

test('Signal Radar and Asset Intelligence use server history and one canonical drawer', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /data-p="cross"[\s\S]*?RWA Signal Radar/);
  assert.match(html, /id="page-cross"[\s\S]*?id="radarTableRegion"/);
  const radarPage = sourceBetween(html, '<div class="page-container" id="page-cross">', '</div><!-- END page-cross -->');
  assert.match(radarPage, /id="radarKpis"[\s\S]*?id="perpVolumeAnomalySection"[\s\S]*?id="spotVolumePriceAnomalySection"[\s\S]*?id="oiLiquidationAnomalySection"[\s\S]*?id="competitorListingsSection"/,
    'Perp, Spot and OI anomaly monitors must sit ahead of competitor listings in Signal Radar');
  assert.equal((html.match(/id="perpVolumeAnomalySection"/g) || []).length, 1);
  assert.equal((html.match(/id="spotVolumePriceAnomalySection"/g) || []).length, 1);
  assert.equal((html.match(/id="oiLiquidationAnomalySection"/g) || []).length, 1);
  assert.match(radarPage, /Perpetual Volume Anomalies[\s\S]*?HIGH[\s\S]*?MEDIUM[\s\S]*?DOWN/);
  assert.match(radarPage, /id="perpVolumeAnomalyLevelFilter"[\s\S]*?id="perpVolumeAnomalyCategoryFilter"[\s\S]*?id="perpVolumeAnomalyVenueFilter"[\s\S]*?id="perpVolumeAnomalyStatusFilter"/);
  assert.match(radarPage, /id="perpVolumeAnomalyMore"[\s\S]*?More · 50 \/ 100/);
  assert.match(radarPage, /id="competitorListingsSection"[\s\S]*?Competitor New Listings/);
  assert.match(radarPage, /id="listingWindowFilter"[\s\S]*?Rolling 7 days[\s\S]*?Rolling 30 days/);
  assert.match(radarPage, /id="listingMarketFilter"[\s\S]*?Perpetuals[\s\S]*?Spot/);
  assert.equal((html.match(/id="competitorListingsSection"/g) || []).length, 1);
  assert.match(html, /fetch\('\/api\/signal-snapshot', \{ method:'GET' \}\)/);
  assert.match(html, /fetch\('\/api\/listing-changes', \{ method:'GET' \}\)/);
  assert.match(html, /function radarPageIsActive\(\)[\s\S]*?pageIsVisible\(\)/);
  assert.match(html, /const SIGNAL_SNAPSHOT_TTL = 5 \* 60 \* 1000/);
  assert.match(html, /const LISTING_CHANGES_TTL = 5 \* 60 \* 1000/);
  assert.match(html, /rows\.slice\(0, radarExpanded \? 100 : 50\)/);
  assert.match(html, /rows\.slice\(0, perpVolumeAnomalyExpanded \? 100 : 50\)/);
  assert.match(html, /const section = payload\?\.perpVolumeAnomalies/);
  assert.match(html, /assetIntelligenceTriggerAttrs\(symbol, category, 'perpetual volume anomalies'\)/);
  assert.match(html, /section\.formulaVersion !== PERP_VOLUME_ANOMALY_FORMULA_VERSION/);
  assert.match(html, /if \(!perpVolumeAnomalyContractValid\(payload\)\) \{[\s\S]*?payload\.perpVolumeAnomalies = unavailablePerpVolumeAnomalySection\(payload\)/,
    'an invalid additive volume section must fail closed without taking down the existing Radar payload');
  assert.doesNotMatch(html, /!perpVolumeAnomalyContractValid\(payload\)\) throw new Error\('Invalid signal snapshot'\)/);
  assert.match(radarPage, /RWA Spot Volume &amp; Price Anomalies[\s\S]*?\$500K/);
  assert.match(radarPage, /Volume ≥ 3×[\s\S]*?24h gain ≥ 15%/);
  assert.match(radarPage, /id="spotVolumePriceAnomalyTriggerFilter"[\s\S]*?id="spotVolumePriceAnomalyCategoryFilter"[\s\S]*?id="spotVolumePriceAnomalyVenueFilter"[\s\S]*?id="spotVolumePriceAnomalyPerpFilter"[\s\S]*?id="spotVolumePriceAnomalyStatusFilter"/);
  assert.match(radarPage, /id="spotVolumePriceAnomalyMore"[\s\S]*?More · 50 \/ 100/);
  assert.match(html, /const section = payload\?\.spotVolumePriceAnomalies/);
  assert.match(html, /section\.formulaVersion !== SPOT_VOLUME_PRICE_ANOMALY_FORMULA_VERSION/);
  assert.match(html, /if \(!spotVolumePriceAnomalyContractValid\(payload\)\) \{[\s\S]*?payload\.spotVolumePriceAnomalies = unavailableSpotVolumePriceAnomalySection\(payload\)/,
    'an invalid additive Spot child must fail closed without taking down the existing Radar or Perp panel');
  assert.doesNotMatch(html, /!spotVolumePriceAnomalyContractValid\(payload\)\) throw new Error\('Invalid signal snapshot'\)/);
  const spotTriggerReader = sourceBetween(html, 'function spotVolumePriceAnomalyTrigger(row)', 'function spotVolumePriceAnomalyValue(row, key)');
  assert.match(spotTriggerReader, /row\?\.trigger/);
  assert.doesNotMatch(spotTriggerReader, /currentVolume|yesterdayVolume|volumeRatio|priceChange|>=|<=/,
    'the browser must display the server trigger rather than reclassifying market values');
  assert.match(html, /rows\.slice\(0, spotVolumePriceAnomalyExpanded \? 100 : 50\)/);
  assert.match(html, /declaredListingKey === listingKey[\s\S]*?declaredAssetKey === expectedAssetKey/);
  assert.match(html, /countValues\.alerts === countValues\.volumeSpike \+ countValues\.priceSurge - countValues\.both/);
  assert.match(html, /Number\.isInteger\(rank\) && rank === rowIndex \+ 1/,
    'Spot child ranks must be contiguous server ranks, not optional display hints');
  assert.match(html, /const expectedRatio = yesterdayVolume !== null && yesterdayVolume > 0[\s\S]*?row\?\.volumeTriggered === expectedVolumeTriggered[\s\S]*?row\?\.priceTriggered === expectedPriceTriggered[\s\S]*?trigger === expectedTrigger/,
    'the additive-child gate must verify row arithmetic and OR-trigger booleans before rendering');
  assert.match(html, /source\.priceFieldCount/,
    'the five Spot source chips and contract must expose price-field completeness separately from volume');
  assert.match(html, /sectionStatus !== 'full'[\s\S]*?coverage\.volumeComparableListings[\s\S]*?coverage\.priceComparableListings/,
    'only complete five-source/current/history coverage may support a Full no-alert conclusion');
  assert.match(radarPage, /OI Positioning (?:&|&amp;) Large-Liquidation Proxy[\s\S]*?not a trade-by-trade liquidation feed/);
  assert.match(radarPage, /id="oiLiquidationAnomalyTypeFilter"[\s\S]*?id="oiLiquidationAnomalyCategoryFilter"[\s\S]*?id="oiLiquidationAnomalyVenueFilter"[\s\S]*?id="oiLiquidationAnomalyBiasFilter"[\s\S]*?id="oiLiquidationAnomalyStatusFilter"/);
  assert.match(radarPage, /id="oiLiquidationAnomalyMore"[\s\S]*?More · 50 \/ 100/);
  assert.match(html, /section\?\.sources\?\.\[name\][\s\S]*?openInterestFieldCount|source\.openInterestFieldCount/,
    'OI child and source chips must expose OI field completeness separately from volume');
  assert.match(html, /if \(!oiLiquidationAnomalyContractValid\(payload\)\) \{[\s\S]*?payload\.oiLiquidationAnomalies = unavailableOiLiquidationAnomalySection\(payload\)/,
    'an invalid additive OI child must fail closed without taking down established Radar panels');
  assert.doesNotMatch(html, /!oiLiquidationAnomalyContractValid\(payload\)\) throw new Error\('Invalid signal snapshot'\)/);
  const oiTriggerReader = sourceBetween(html, 'function oiLiquidationAnomalyTrigger(row)', 'function oiLiquidationAnomalyTrend(row)');
  assert.match(oiTriggerReader, /row\?\.trigger/);
  assert.doesNotMatch(oiTriggerReader, /currentVolume|currentOpenInterest|completedDaily|peak24h|drawdown|>=|<=/,
    'the browser must display the server OI trigger rather than classifying market values');
  const oiContractGate = sourceBetween(html, 'function oiLiquidationAnomalyContractValid(payload)', 'function unavailableOiLiquidationAnomalySection(payload)');
  assert.match(oiContractGate, /const expectedAssetKey = `\$\{category\}:\$\{symbol\}`;/);
  assert.doesNotMatch(oiContractGate, /expectedAssetKey = `\$\{category\}:\$\{symbol\}`\.toLowerCase\(\)/,
    'OI category:canonical identity must preserve the producer canonical symbol case');
  assert.match(oiContractGate, /const expectedTrigger = oiLiquidationExpectedTrigger\(row, thresholds\);[\s\S]*?expectedTrigger !== null && trigger === expectedTrigger/,
    'the browser validator must reject a server trigger that contradicts the published threshold fields');
  const oiExpectedTriggerSource = sourceBetween(
    html,
    'function oiLiquidationExpectedTrigger(row, thresholds)',
    'function oiLiquidationAnomalyContractValid(payload)',
  );
  const oiTriggerContext = {
    numberOrNull(value) {
      if (value === null || value === undefined || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    },
  };
  runInNewContext(`${oiExpectedTriggerSource}
    const thresholds = {
      minVolume24hUsdExclusive:1000000,
      liquidationProxyDropUsdExclusive:2000000,
      risingCompletedDays:3,
    };
    const rising = [
      {openInterestUsd:1000000},
      {openInterestUsd:2000000},
      {openInterestUsd:3000000},
    ];
    const falling = [
      {openInterestUsd:3000000},
      {openInterestUsd:2000000},
      {openInterestUsd:1000000},
    ];
    globalThis.validBoth = oiLiquidationExpectedTrigger({currentVolume24hUsd:1000000.01,completedDailyCloses:rising,drawdown24hUsd:2000000.01},thresholds);
    globalThis.exactVolumeBoundary = oiLiquidationExpectedTrigger({currentVolume24hUsd:1000000,completedDailyCloses:rising,drawdown24hUsd:2000000.01},thresholds);
    globalThis.fallingCloses = oiLiquidationExpectedTrigger({currentVolume24hUsd:1000000.01,completedDailyCloses:falling,drawdown24hUsd:2000000.01},thresholds);
    globalThis.smallDrawdown = oiLiquidationExpectedTrigger({currentVolume24hUsd:1000000.01,completedDailyCloses:falling,drawdown24hUsd:1999999.99},thresholds);
    globalThis.exactDrawdownBoundary = oiLiquidationExpectedTrigger({currentVolume24hUsd:1000000.01,completedDailyCloses:falling,drawdown24hUsd:2000000},thresholds);`, oiTriggerContext);
  assert.equal(oiTriggerContext.validBoth, 'both');
  assert.equal(oiTriggerContext.exactVolumeBoundary, null,
    'exactly $1m is ineligible, so a declared OI trigger must be rejected');
  assert.equal(oiTriggerContext.fallingCloses, 'liquidation_proxy');
  assert.notEqual(oiTriggerContext.fallingCloses, 'oi_rising',
    'falling completed-day closes cannot support a declared oi_rising trigger');
  assert.equal(oiTriggerContext.smallDrawdown, null,
    'a drawdown below $2m cannot support liquidation_proxy');
  assert.equal(oiTriggerContext.exactDrawdownBoundary, null,
    'exactly $2m cannot support liquidation_proxy');
  const oiPanelStatus = sourceBetween(html, 'function oiLiquidationAnomalyPanelStatus(section)', 'function oiLiquidationAnomalyRows(section)');
  assert.match(oiPanelStatus, /signalSnapshotError[\s\S]*?'partial'/,
    'a failed refresh must downgrade a cached Full OI section to Partial');
  const oiStatusRenderer = sourceBetween(html, 'function renderOiLiquidationAnomalyStatus(section)', 'function renderOiLiquidationAnomalySources(section)');
  assert.match(oiStatusRenderer, /panelStatus === 'full' && historyReady/,
    'only Full coverage plus ready history may make an OI no-anomaly conclusion');
  const oiPositionReaders = sourceBetween(html, 'function oiLiquidationTopTraderPositions(row)', 'function oiLiquidationTraderBiasLabel(bias)');
  const oiPositionContext = {
    radarSafeStatus(value) {
      const normalized = String(value || '').toLowerCase();
      return ['full','partial','estimated','unavailable'].includes(normalized) ? normalized : 'unavailable';
    },
    numberOrNull(value) {
      if (value === null || value === undefined || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    },
  };
  runInNewContext(`${oiPositionReaders}\n` +
    `globalThis.missingOiBias = oiLiquidationOverallTraderBias({overallTraderBias:'neutral',topTraderPositions:[{venueSymbol:'AAPLUSDT',status:'unavailable',longShortRatio:null,bias:'unavailable'}]});\n` +
    `globalThis.exactNeutralOiBias = oiLiquidationOverallTraderBias({overallTraderBias:'neutral',topTraderPositions:[{venueSymbol:'AAPLUSDT',status:'full',longShortRatio:1.05,longPositionPct:51.22,shortPositionPct:48.78,bias:'neutral'}]});`,
  oiPositionContext);
  assert.equal(oiPositionContext.missingOiBias, 'unavailable');
  assert.equal(oiPositionContext.exactNeutralOiBias, 'neutral');
  assert.match(html, /rows\.slice\(0, oiLiquidationAnomalyExpanded \? 100 : 50\)/);
  const volumeLevelReader = sourceBetween(html, 'function perpVolumeAnomalyLevel(row)', 'function perpVolumeAnomalyRowStatus(row)');
  assert.match(volumeLevelReader, /\['high','medium','down'\]\.includes\(level\)/);
  assert.doesNotMatch(volumeLevelReader, /ratio7d|currentVolume|average7d|>=|<=/,
    'the browser must display, not derive, the server anomaly level');
  const volumeStatusRenderer = sourceBetween(html, 'function renderPerpVolumeAnomalyStatus(section)', 'function renderPerpVolumeAnomalyTable(section)');
  assert.match(volumeStatusRenderer, /panelStatus === 'partial'[\s\S]*?else if \(!rows\.length\)[\s\S]*?No perpetual volume anomalies/,
    'only a Full server section may make a no-anomaly conclusion');
  const panelStatusSource = sourceBetween(html, 'function perpVolumeAnomalyPanelStatus(section)', 'function perpVolumeAnomalyLevel(row)');
  const panelContext = { signalSnapshotError:'HTTP 502' };
  runInNewContext(`${panelStatusSource}\nglobalThis.cachedFullStatus = perpVolumeAnomalyPanelStatus({status:'full'});`, panelContext);
  assert.equal(panelContext.cachedFullStatus, 'partial',
    'a failed refresh must downgrade cached Full before the volume panel can infer no anomalies');
  assert.match(html, /\.volume-anomaly-table \{ min-width:1040px; \}/);
  assert.match(html, /\.volume-anomaly-table thead th:first-child, \.volume-anomaly-table tbody td:first-child \{[\s\S]*?position:sticky/);
  assert.match(html, /if \(activePage === 'cross'\) \{[\s\S]*?await Promise\.allSettled\(\[[\s\S]*?ensureSignalSnapshot\(false\)[\s\S]*?ensureListingChanges\(false\)[\s\S]*?\]\);[\s\S]*?return;/);
  assert.match(html, /if \(activePage === 'spot' \|\| activePage === 'traditional'\) \{[\s\S]*?refreshSpotArbData\(\)/);
  assert.match(html, /Baseline warming/);
  assert.match(html, /function listingEventWithinWindow\(event, days = Number\(listingMonitorFilter\.window\) \|\| 7/);
  assert.match(html, /function listingSnapshotFresh\(payload, now = Date\.now\(\)\)[\s\S]*?36 \* 60 \* 60 \* 1000/);
  assert.match(html, /Number\.isFinite\(Date\.parse\(payload\.generatedAt\)\) && !listingSnapshotFresh\(payload\)/,
    'an uninitialized baseline is Warming, while a generated snapshot can age into Stale');
  const listingStatusText = sourceBetween(html, 'function listingMonitorStatusText(payload, weeklyEvents)', 'function renderCompetitorListings()');
  assert.match(listingStatusText, /hasGeneratedSnapshot && !listingSnapshotFresh\(payload\)[\s\S]*?history\?\.truncated === true[\s\S]*?payload\.status === 'warming'/,
    'Stale must remain visible ahead of truncated or warming status details');
  assert.match(html, /Array\.isArray\(payload\?\.pendingReviews\)/);
  assert.match(html, /event\?\.identityStatus !== 'verified'[\s\S]*?return 'review-required'/);
  const listingCoverage = sourceBetween(html, 'function listingEventWebsiteCoverage(event)', 'function listingEventInteractive');
  assert.doesNotMatch(listingCoverage, /identityMatch/);
  assert.match(listingCoverage, /assetIntelligencePerpIdentity\(asset\)\?\.assetKey === assetKey/);
  assert.match(listingCoverage, /assetIntelligenceSpotIdentity\(asset, venue\)\?\.assetKey === assetKey/);
  assert.match(listingCoverage, /return exact \? 'included' : 'pending-refresh'/);
  assert.doesNotMatch(html, /localStorage|rwa_kpi_snapshots/);

  assert.match(html, /id="assetModal" role="dialog" aria-modal="true"/);
  assert.match(html, /function openAssetIntelligence\(input = \{\}\)/);
  assert.match(html, /window\.openAssetIntelligence = openAssetIntelligence/);
  assert.match(html, /spotAssetSecurityIdentity\(row\)/);
  assert.match(html, /health\?\.status === 'stale'/);
  assert.match(html, /source:'signal radar'/);
  assert.match(html, /aria-label="Open \$\{safeSymbol\} asset intelligence"/);

  const vercelConfig = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.ok(vercelConfig.crons.some(cron => cron.path === '/api/signal-snapshot-cron' && cron.schedule === '7 * * * *'));
  assert.ok(vercelConfig.crons.some(cron =>
    cron.path === '/api/listing-audit-cron' && cron.schedule === '45 0,6,12,18 * * *'));
});

test('Competitor listings keep the newest relisting event for each venue instrument', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('function listingNewEvents(');
  const end = html.indexOf('function listingSnapshotFresh(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = html.slice(start, end) + `
    globalThis.listingRows = listingAuditEvents({
      events:[
        { listingKey:'spot:kraken:AAPLXUSD', changeType:'relisted', detectedAt:'2026-08-14T00:45:00Z' },
        { listingKey:'spot:kraken:AAPLXUSD', changeType:'new', detectedAt:'2026-07-01T00:45:00Z' },
      ],
      pendingReviews:[],
    });
  `;
  const context = { listingChangesCache:null };
  runInNewContext(source, context);
  assert.equal(context.listingRows.length, 1);
  assert.equal(context.listingRows[0].changeType, 'relisted');
  assert.equal(context.listingRows[0].detectedAt, '2026-08-14T00:45:00Z');
});

test('bilingual UI is accessible, persisted under one preference key, and switches without navigation or I/O', async () => {
  const [html, i18n] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../i18n.js', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /<html lang="en">/);
  assert.match(html, /<script src="\/i18n\.js"><\/script>/);

  const header = sourceBetween(html, '<!-- Header -->', '<div class="alert-panel"');
  const languageControl = header.match(/<div class="language-tabs"[\s\S]*?<\/div>/)?.[0] || '';
  assert.match(languageControl, /id="languageTabs" role="group" aria-label="Language"/);
  assert.match(
    languageControl,
    /<button type="button"[^>]*data-language="en"[^>]*aria-pressed="(?:true|false)"[^>]*onclick="setUiLanguage\('en'\)"[^>]*>EN<\/button>/,
  );
  assert.match(
    languageControl,
    /<button type="button"[^>]*data-language="zh-CN"[^>]*aria-pressed="(?:true|false)"[^>]*onclick="setUiLanguage\('zh-CN'\)"[^>]*>中文<\/button>/,
  );

  assert.match(i18n, /var STORAGE_KEY = 'rwa_dashboard_locale_v1';/);
  assert.doesNotMatch(i18n, /rwa_kpi_snapshots/);
  const storageCalls = [...i18n.matchAll(/localStorage\.(?:getItem|setItem|removeItem)\(\s*([^,)]+)/g)]
    .map(match => match[1].trim());
  assert.ok(storageCalls.length >= 2, 'language preference must be read and written');
  assert.ok(storageCalls.every(argument => argument === 'STORAGE_KEY'), 'i18n may only use its declared preference key');

  assert.match(i18n, /window\.setUiLanguage = setLanguage;/);
  const languageSetter = sourceBetween(i18n, 'function setLanguage(nextLanguage, options)', 'function initialize()');
  assert.match(languageSetter, /document\.documentElement\.lang = next/);
  assert.match(languageSetter, /if \(languageApplied && next === language\) return;/);
  assert.doesNotMatch(languageSetter, /\bfetch\s*\(/);
  assert.doesNotMatch(languageSetter, /\b(?:XMLHttpRequest|WebSocket|EventSource)\b|sendBeacon\s*\(/);
  assert.doesNotMatch(languageSetter, /\bswitchTopPage\s*\(/);
  assert.doesNotMatch(languageSetter, /\b(?:render|refresh|load|ensure)[A-Z]\w*\s*\(/);
  assert.doesNotMatch(languageSetter, /\blocation\b/);
  assert.doesNotMatch(
    html,
    /addEventListener\s*\(\s*['"]rwa:languagechange['"]/,
    'language switching must not invoke renderers that can fetch',
  );
  assert.match(i18n, /english\.setAttribute\('aria-pressed', String\(englishActive\)\)/);
  assert.match(i18n, /chinese\.setAttribute\('aria-pressed', String\(chineseActive\)\)/);
  assert.match(i18n, /function protectedIdentityText\(raw, parent\)[\s\S]*Uppercase values are assumed to be ticker\/contract identity/);
  assert.match(i18n, /if \(protectedIdentityText\(current, parent\)\) return;/);
  assert.match(html, /<span data-i18n-skip>\$\{escapeHtml\(row\.symbol\)\}<\/span>/);
  assert.match(html, /<span data-i18n-skip>\$\{escapeHtml\(canonical\)\} — \$\{escapeHtml\(model\.name\)\}<\/span>/);

  const sentinels = [
    ['RWA Signal Radar', 'RWA 信号雷达'],
    ['Perpetual Volume Anomalies', '合约成交量异动'],
    ['Competitor New Listings', '竞品新上线资产'],
    ['Traditional Market Activity Monitor · Top 100', '传统市场活跃度监控 · Top 100'],
    ['Asset Intelligence · canonical underlying', '资产情报 · 标准底层资产'],
  ];
  sentinels.forEach(([english, chinese]) => {
    assert.ok(html.includes(english), `missing rendered English sentinel: ${english}`);
    assert.ok(i18n.includes(`'${english}':'${chinese}'`), `missing Chinese translation sentinel: ${english}`);
  });
  assert.match(html, /OI Positioning (?:&|&amp;) Large-Liquidation Proxy/);
  assert.ok(i18n.includes("'OI Positioning & Large-Liquidation Proxy':'OI 持仓与大额清算代理'"));
  assert.match(i18n, /Perpetual volume anomaly refresh failed[\s\S]*?合约成交量异动刷新失败/);
});

test('bilingual runtime translates singular coverage and locale fragments without repeating same-language work', async () => {
  const i18n = await readFile(new URL('../i18n.js', import.meta.url), 'utf8');
  let treeWalks = 0;
  let dispatched = 0;
  const stored = [];
  class MockElement {}
  const body = {};
  const document = {
    readyState:'loading',
    body,
    documentElement:{ lang:'en' },
    title:'',
    addEventListener() {},
    getElementById() { return null; },
    createTreeWalker() {
      treeWalks += 1;
      return { nextNode() { return null; } };
    },
  };
  const window = {
    dispatchEvent() { dispatched += 1; },
  };
  runInNewContext(i18n, {
    window,
    document,
    navigator:{ language:'en-US' },
    localStorage:{
      getItem() { return null; },
      setItem(key, value) { stored.push([key, value]); },
    },
    Element:MockElement,
    Node:{ TEXT_NODE:3 },
    NodeFilter:{ SHOW_ELEMENT:1, SHOW_TEXT:4 },
    MutationObserver:class {},
    CustomEvent:class {},
    Set,
    WeakMap,
  });

  assert.equal(window.translateUi('Perp 24h volume: 1 volume field available', 'zh-CN'), '永续 24 小时成交量：1 个成交量字段可用');
  assert.equal(window.translateUi('Spot 24h volume: 1 volume field available', 'zh-CN'), '现货 24 小时成交量：1 个成交量字段可用');
  assert.equal(window.translateUi('2:15 PM', 'zh-CN'), '14:15');
  assert.equal(window.translateUi('Aug 6, 2026', 'zh-CN'), '2026年8月6日');
  assert.equal(window.translateUi('Data as of Aug 8, 2026 2:22 AM ET', 'zh-CN'), '数据截至 2026年8月8日 02:22 ET');
  assert.equal(window.translateUi('Aug 6, 2026; excludes fees, latency and points outside the 0.5×–1.5× comparability guard.', 'zh-CN'), '2026年8月6日；未计入费用、延迟及超出 0.5×–1.5× 可比区间的价格点。');
  assert.equal(window.translateUi('Activity 2:15:09 PM', 'zh-CN'), '数据活动时间 14:15:09');
  assert.equal(window.translateUi('candidate list Aug 6, 2026', 'zh-CN'), '候选列表：2026年8月6日');
  assert.equal(window.translateUi('2/3 listing value(s) available; 1 stale/unavailable snapshot(s)', 'zh-CN'), '2/3 个上市标的数据可用；1 个快照陈旧或不可用');
  assert.equal(window.translateUi('1 venue source(s) stale/unavailable', 'zh-CN'), '1 个交易场所数据源陈旧或不可用');
  assert.equal(window.translateUi('2/2 total-value legs available; share value + standard-options underlying notional', 'zh-CN'), '2/2 个总价值组成项可用；股票价值 + 标准期权底层名义价值');
  assert.equal(window.translateUi('Stale Trad quote · excluded', 'zh-CN'), '传统市场报价已陈旧 · 已排除');
  assert.equal(window.translateUi('1079/1079 listings available', 'zh-CN'), '1079/1079 个上市标的数据可用');
  assert.equal(window.translateUi('share value + option notional ·', 'zh-CN'), '股票价值 + 期权名义价值 ·');
  assert.equal(window.translateUi('RWA Spot Volume & Price Anomalies', 'zh-CN'), 'RWA 现货量价异动');
  assert.equal(window.translateUi('Vol 1/2 · Price 0/2', 'zh-CN'), '成交量 1/2 · 涨跌幅 0/2');
  assert.equal(window.translateUi('VOLUME ≥ 3×', 'zh-CN'), '成交量 ≥ 3×');
  assert.equal(window.translateUi('PRICE ≥ 15%', 'zh-CN'), '价格 ≥ 15%');
  assert.equal(window.translateUi('BOTH', 'zh-CN'), '两项同时触发');
  assert.equal(window.translateUi('OI Positioning & Large-Liquidation Proxy', 'zh-CN'), 'OI 持仓与大额清算代理');
  assert.equal(window.translateUi('OI 1/2 · Vol 2/2', 'zh-CN'), 'OI 1/2 · 成交量 2/2');
  assert.equal(window.translateUi('Large-liquidation proxy', 'zh-CN'), '大额清算代理');
  assert.equal(window.translateUi('Unavailable', 'zh-CN'), '不可用');

  window.setUiLanguage('zh-CN');
  assert.equal(treeWalks, 1);
  assert.equal(dispatched, 1);
  assert.deepEqual(stored, [['rwa_dashboard_locale_v1', 'zh-CN']]);
  window.setUiLanguage('zh-CN');
  assert.equal(treeWalks, 1, 'same-language selection must not traverse the document again');
  assert.equal(dispatched, 1, 'same-language selection must not emit another language-change event');
  assert.deepEqual(stored, [['rwa_dashboard_locale_v1', 'zh-CN']], 'same-language selection must not rewrite preference state');
});

test('English Spot source stays canonical while dynamic Traditional, Spot, and Heatmap copy has Chinese coverage', async () => {
  const [html, i18n] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../i18n.js', import.meta.url), 'utf8'),
  ]);

  const staticSpotPage = sourceBetween(
    html,
    '<div class="page-container" id="page-spot">',
    '</div><!-- END page-spot -->',
  );
  const dynamicSpotRenderers = sourceBetween(
    html,
    'function renderSpotVenueTable(venue)',
    '// ═══════════════════════════════════════════════\n// INIT',
  );
  assert.doesNotMatch(staticSpotPage, /\p{Script=Han}/u, 'the English Spot page must not embed Chinese copy');
  assert.doesNotMatch(dynamicSpotRenderers, /\p{Script=Han}/u, 'Spot renderers must emit canonical English copy');

  const dynamicSections = {
    Traditional: sourceBetween(html, 'function renderTraditionalActivity()', '// ═══════════════════════════════════════════════════\n// VENUE TABLES'),
    Spot: dynamicSpotRenderers,
    Heatmap: sourceBetween(html, 'function renderHeatmap()', '// ═══════════════════════════════════════════════\n// RWA SIGNAL RADAR'),
    OI: sourceBetween(html, 'function renderOiLiquidationAnomalySummary(section)', 'function renderRadarStatus(payload, indexedRows)'),
  };
  const sentinels = {
    Traditional: ['Trad Volume', 'Options Volume', 'Est. Total Notional', 'Need Trad + Crypto prices'],
    Spot: ['24h Volume', 'Loading spot venue catalogs…', 'Spot venue data unavailable. Refresh to retry.', 'Loading comparable Spot and Perpetual routes…', 'No combos match the current filters.'],
    Heatmap: ['Short receives', 'Long receives', 'Data coverage', 'Venue spread', 'Need 2 venues'],
    OI: ['Large-liquidation proxy', 'OI sources not loaded.', 'Binance Top Trader Position Ratio / Bias'],
  };

  const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [section, phrases] of Object.entries(sentinels)) {
    for (const phrase of phrases) {
      assert.ok(dynamicSections[section].includes(phrase), `${section} renderer lost English sentinel: ${phrase}`);
      assert.match(
        i18n,
        new RegExp(`'${escapeRegExp(phrase)}':'[^'\\n]*\\p{Script=Han}[^'\\n]*'`, 'u'),
        `${section} dynamic sentinel needs a Chinese translation: ${phrase}`,
      );
    }
  }

  const regressionPhrases = [
    'Funding settles every 1h',
    'Funding settles per contract',
    'Funding interval varies by contract',
    '⚠ Avoid',
    '✦ Ideal',
    '● Good',
    '△ Wide',
    'Intelligence',
    'Loading spot data…',
    'OI build',
    'volume robust z',
    'source snapshot incomparable',
  ];
  regressionPhrases.forEach(phrase => {
    assert.ok(i18n.includes(`'${phrase}':`), `missing Chinese regression coverage: ${phrase}`);
  });
  assert.match(i18n, /\^\(\\d\[\\d,\]\*\) High\$/);
  assert.match(i18n, /\^Spot refresh error:/);
  assert.match(i18n, /expected observations in/);
});

test('heatmap batches rows into one DOM commit for the global i18n observer', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const renderer = sourceBetween(
    html,
    'function renderHeatmap()',
    '// ═══════════════════════════════════════════════\n// RWA SIGNAL RADAR',
  );

  assert.match(renderer, /const heatmapHtml = \[/);
  assert.match(renderer, /heatmapHtml\.push\(/);
  assert.doesNotMatch(
    renderer,
    /grid\.innerHTML\s*\+=/,
    'looped innerHTML replacement makes MutationObserver traverse detached intermediate trees',
  );
  assert.equal(
    [...renderer.matchAll(/grid\.innerHTML\s*=/g)].length,
    1,
    'heatmap rows should reach the observed DOM in one atomic commit',
  );
  assert.match(renderer, /grid\.innerHTML = heatmapHtml\.join\(''\);/);
});

test('320px layout keeps navigation scrollable and alert/language controls usable', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1\.0">/);

  const styles = sourceBetween(html, '<style>', '</style>');
  assert.match(styles, /\.top-nav\s*\{[^}]*overflow-x:auto;/);
  assert.match(styles, /\.top-tab\s*\{[^}]*flex:0 0 auto;/);

  const mobileBreakpoint = styles.indexOf('@media (max-width: 640px) {');
  assert.notEqual(mobileBreakpoint, -1, 'missing <=640px rules that also apply at 320px');
  const mobile = styles.slice(mobileBreakpoint);
  assert.match(mobile, /\.logo-divider, \.logo-label, \.global-search, \.status-pill\s*\{\s*display:none;/);
  assert.match(mobile, /\.alert-badge #alertBadgeText\s*\{\s*display:none;/);
  assert.match(mobile, /\.alert-panel\s*\{[^}]*left:12px;[^}]*right:12px;[^}]*width:auto;/);
  assert.match(mobile, /\.language-tab\s*\{[^}]*min-width:34px;/);
  assert.match(mobile, /\.nav-tabs, \.sub-tabs, \.spot-sub-nav\s*\{[^}]*overflow-x:auto;/);
  assert.match(mobile, /\.nav-tab, \.sub-tab, \.spot-sub-tab\s*\{[^}]*flex:0 0 auto;/);
  assert.match(styles, /\.oi-liquidation-table\s*\{\s*min-width:1780px;/,
    'the OI table must scroll instead of collapsing at 320px');
  assert.match(styles, /\.volume-anomaly-table thead th:first-child, \.volume-anomaly-table tbody td:first-child\s*\{[^}]*position:sticky;[^}]*left:0;/,
    'the OI table inherits a sticky asset column while horizontally scrolling');
  assert.doesNotMatch(mobile, /\.(?:language-tabs|alert-badge)\s*\{[^}]*display\s*:\s*none/);
});

test('Nasdaq directory is the authority for equity and ETF identity', () => {
  const rows = parseNasdaqDirectory([
    'Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares',
    'AAPL|Apple Inc. Common Stock|Q|N|N|100|N|N',
    'QQQ|Invesco QQQ Trust, Series 1|G|N|N|100|Y|N',
    'BABA|Alibaba Group Holding Limited American Depositary Shares|Q|N|N|100|N|N',
    'ADSE|ADS-TEC ENERGY PLC Ordinary Shares|Q|N|N|100|N|N',
    'TEST|Test Security|G|Y|N|100|N|N',
    'BADW|Example Warrant|G|N|N|100|N|N',
    'File Creation Time: 0807202618:01|||||||',
  ].join('\n'), 'nasdaq');
  assert.deepEqual(rows.map(row => [row.symbol, row.category]), [
    ['AAPL', 'equity'],
    ['QQQ', 'etf'],
    ['BABA', 'equity'],
    ['ADSE', 'equity'],
  ]);
  assert.deepEqual(rows.find(row => row.symbol === 'BABA').tags, ['ADR']);
  assert.deepEqual(rows.find(row => row.symbol === 'ADSE').tags, []);
});

test('adjusted OCC roots are excluded from standard 100-share notional', () => {
  const report = parseOccReport([
    'Group\tSymbol\tEx.\tCustomer\tFirm\tCustomer/Firm Totals\tMkt Maker\tTotal',
    '2AAPL\t2AAPL\tA\t1\t0\t1\t4\t5',
    'Symbol\tTotal\t\t1\t0\t1\t4\t5',
    '\tAAPL\tA\t1\t0\t1\t9\t10',
    'Symbol\tTotal\t\t1\t0\t1\t9\t10',
  ].join('\n'));
  assert.equal(report.standardTotals.AAPL, 10);
  assert.equal(report.adjustedTotals.AAPL, 5);
});

test('OCC report discovery skips official empty days but never hides request failures', async () => {
  const emptyReport = 'Group\tSymbol\tEx.\tCustomer\tFirm\tCustomer/Firm Totals\tMkt Maker\tTotal';
  const validReport = [
    emptyReport,
    'AAPL\tAAPL\tA\t1\t0\t1\t9\t10',
    'Symbol\tTotal\t\t1\t0\t1\t9\t10',
  ].join('\n');
  const calls = [];
  const found = await findFirstNonEmptyOccReport(['20260808', '20260807'], async reportDate => {
    calls.push(reportDate);
    return reportDate === '20260808' ? emptyReport : validReport;
  });
  assert.equal(found.reportDate, '20260807');
  assert.equal(found.standardTotals.AAPL, 10);
  assert.deepEqual(calls, ['20260808', '20260807']);

  const failedCalls = [];
  await assert.rejects(
    findFirstNonEmptyOccReport(['20260808', '20260807'], async reportDate => {
      failedCalls.push(reportDate);
      throw new Error('OCC network failure');
    }),
    /OCC network failure/,
  );
  assert.deepEqual(failedCalls, ['20260808']);
});

test('traditional estimated amounts use same-session share and standard-option notionals', () => {
  assert.equal(estimatedShareValue(2500, 99.5), 248750);
  assert.equal(estimatedOptionsNotional(10, 99.5), 99500);
  assert.equal(estimatedShareValue(null, 99.5), null);
  assert.equal(estimatedOptionsNotional(10, null), null);

  const options = optionActivityForSymbol('AAPL', {
    latestTotals:{ AAPL:10 },
    latestAdjustedTotals:{ AAPL:5 },
    comparisonReports:[
      { reportDate:'20260709', standardTotals:{ AAPL:8 }, adjustedTotals:{} },
      { reportDate:'20260716', standardTotals:{ AAPL:9 }, adjustedTotals:{ AAPL:2 } },
      { reportDate:'20260723', standardTotals:{ AAPL:10 }, adjustedTotals:{} },
      { reportDate:'20260730', standardTotals:{ AAPL:11 }, adjustedTotals:{} },
    ],
  }, 99.5);
  assert.equal(options.estimatedNotional, 99500);
  assert.equal(options.averageVolume, 9.5);
  assert.equal(options.adjustedVolumeExcluded, 5);
  assert.equal(options.baselineAdjustedVolumeExcluded, 2);
  assert.deepEqual(options.adjustedBaselineReports, ['20260716']);
  assert.equal(options.status, 'partial');

  const completeZeroBundle = {
    latestTotals:{ AAPL:10 },
    latestAdjustedTotals:{},
    comparisonReports:[7, 14, 21, 28].map(days => ({
      reportDate:`202607${String(days).padStart(2, '0')}`,
      standardTotals:{ AAPL:days },
      adjustedTotals:{},
    })),
  };
  const absentRoot = optionActivityForSymbol('MSFT', completeZeroBundle, 100);
  assert.equal(absentRoot.volume, 0, 'absence from a complete OCC totals report is an observed zero');
  assert.equal(absentRoot.averageVolume, 0);
  assert.equal(absentRoot.estimatedNotional, 0);
  assert.equal(absentRoot.status, 'full');
  assert.equal(absentRoot.hasOfficialSeries, false, 'zero observation does not invent an option listing');
  assert.equal(absentRoot.currentReportAvailable, true);
  assert.equal(absentRoot.adjustedCoverageComplete, true);

  const explicitZero = optionActivityForSymbol('MSFT', {
    ...completeZeroBundle,
    latestTotals:{ ...completeZeroBundle.latestTotals, MSFT:0 },
  }, 100);
  assert.equal(explicitZero.volume, 0);
  assert.equal(explicitZero.hasOfficialSeries, true);

  const shortBaseline = optionActivityForSymbol('MSFT', {
    ...completeZeroBundle,
    comparisonReports:completeZeroBundle.comparisonReports.slice(0, 3),
  }, 100);
  assert.equal(shortBaseline.volume, 0);
  assert.equal(shortBaseline.estimatedNotional, 0);
  assert.equal(shortBaseline.status, 'partial');

  const missingAdjustedReport = optionActivityForSymbol('MSFT', {
    ...completeZeroBundle,
    latestAdjustedTotals:null,
  }, 100);
  assert.equal(missingAdjustedReport.volume, 0);
  assert.equal(missingAdjustedReport.adjustedVolumeExcluded, null);
  assert.equal(missingAdjustedReport.status, 'partial');

  const missingCurrentReport = optionActivityForSymbol('MSFT', {
    ...completeZeroBundle,
    latestTotals:null,
  }, 100);
  assert.equal(missingCurrentReport.volume, null);
  assert.equal(missingCurrentReport.estimatedNotional, null);
  assert.equal(missingCurrentReport.status, 'partial');

  assert.deepEqual(traditionalTotalValueState({
    marketValue:1_000,
    optionsValue:0,
    marketStatus:'full',
    optionsStatus:'full',
  }), { value:1_000, observed:2, expected:2, status:'estimated' });
  assert.deepEqual(traditionalTotalValueState({
    marketValue:1_000,
    optionsValue:0,
    marketStatus:'full',
    optionsStatus:'partial',
  }), { value:1_000, observed:2, expected:2, status:'partial' });
  assert.deepEqual(traditionalTotalValueState({
    marketValue:1_000,
    optionsValue:null,
    marketStatus:'full',
    optionsStatus:'unavailable',
  }), { value:null, observed:1, expected:2, status:'partial' });
  assert.deepEqual(traditionalTotalValueState({
    marketValue:null,
    optionsValue:null,
  }), { value:null, observed:0, expected:2, status:'unavailable' });
});

test('Nasdaq share volume and close parse on the OCC ranking session', () => {
  const rankingSession = occDateToIso('20260806');
  const comparisonSession = occDateToIso('20260805');
  assert.deepEqual(nasdaqHistoricalWindow(rankingSession, comparisonSession), {
    fromdate:'2026-07-02',
    todate:'2026-08-07',
  });
  const row = parseNasdaqHistoricalRow({
    data:{ tradesTable:{ rows:[
      { date:'08/07/2026', close:'$101.00', volume:'1,000' },
      { date:'08/06/2026', close:'$99.50', volume:'2,500' },
    ] } },
  }, rankingSession);
  assert.deepEqual(row, { sessionDate:'2026-08-06', close:99.5, volume:2500 });
  const previousRow = parseNasdaqHistoricalRow({
    data:{ tradesTable:{ rows:[
      { date:'08/06/2026', close:'$99.50', volume:'2,500' },
      { date:'08/05/2026', close:'$98.00', volume:'3,000' },
    ] } },
  }, comparisonSession);
  assert.deepEqual(previousRow, { sessionDate:'2026-08-05', close:98, volume:3000 });
  assert.equal(parseNasdaqHistoricalRow({
    data:{ tradesTable:{ rows:[{ date:'08/05/2026', close:'$98.00', volume:null }] } },
  }, comparisonSession), null);
  assert.deepEqual(parseNasdaqHistoricalAverage({
    data:{ tradesTable:{ rows:[
      { date:'08/06/2026', close:'$99.50', volume:'2,500' },
      { date:'08/05/2026', close:'$98.00', volume:'3,000' },
      { date:'08/04/2026', close:'$97.00', volume:'1,000' },
      { date:'08/03/2026', close:'$96.00', volume:null },
    ] } },
  }, rankingSession, 20), { averageVolume:2000, samples:2 });
  assert.deepEqual(classifyNasdaqHistoricalRange({
    status:{ rCode:200 },
    data:{ tradesTable:{ rows:[
      { date:'08/06/2026', close:'$99.50', volume:'2,500' },
      { date:'08/05/2026', close:'$98.00', volume:'3,000' },
    ] }, totalRecords:2 },
  }, rankingSession, comparisonSession), {
    current:{ status:'aligned', reason:null, row:{ sessionDate:'2026-08-06', close:99.5, volume:2500 } },
    previous:{ status:'aligned', reason:null, row:{ sessionDate:'2026-08-05', close:98, volume:3000 } },
  });
  assert.deepEqual(classifyNasdaqHistoricalRange({
    status:{ rCode:200 },
    data:{ tradesTable:{ rows:[
      { date:'08/06/2026', close:'$99.50', volume:'2,500' },
      { date:'08/05/2026', close:'$98.00', volume:null },
    ] }, totalRecords:2 },
  }, rankingSession, comparisonSession), {
    current:{ status:'aligned', reason:null, row:{ sessionDate:'2026-08-06', close:99.5, volume:2500 } },
    previous:{ status:'invalid', reason:'invalid-session-volume-or-close', row:null },
  });
  assert.deepEqual(classifyNasdaqHistoricalRange({
    status:{ rCode:200 },
    data:{ tradesTable:{ rows:[
      { date:'08/06/2026', close:'$99.50', volume:'2,500' },
    ] }, totalRecords:31 },
  }, rankingSession, comparisonSession), {
    current:{ status:'aligned', reason:null, row:{ sessionDate:'2026-08-06', close:99.5, volume:2500 } },
    previous:{ status:'invalid', reason:'historical-range-truncated', row:null },
  });
  assert.deepEqual(classifyNasdaqHistoricalRange({
    status:{ rCode:200 },
    data:{ tradesTable:{ rows:[
      { date:'08/05/2026', close:'$98.00', volume:'3,000' },
    ] }, totalRecords:1 },
  }, rankingSession, comparisonSession), {
    current:{ status:'ineligible', reason:'no-session-row', row:null },
    previous:{ status:'aligned', reason:null, row:{ sessionDate:'2026-08-05', close:98, volume:3000 } },
  });
  assert.deepEqual(classifyNasdaqHistoricalPayload({
    status:{ rCode:200 },
    data:{ tradesTable:{ rows:[] }, totalRecords:0 },
  }, rankingSession), { status:'ineligible', reason:'no-session-row', row:null });
  assert.deepEqual(classifyNasdaqHistoricalPayload({
    status:{ rCode:400 },
    data:null,
  }, rankingSession), { status:'invalid', reason:'nasdaq-business-error', row:null });
  assert.deepEqual(classifyNasdaqHistoricalPayload({
    status:{ rCode:200 },
    data:{ tradesTable:{ rows:[] }, totalRecords:5 },
  }, rankingSession), { status:'invalid', reason:'requested-session-missing', row:null });
  assert.deepEqual(classifyNasdaqHistoricalPayload({
    status:{ rCode:200 },
    data:{ tradesTable:{ rows:[] } },
  }, rankingSession), { status:'invalid', reason:'requested-session-missing', row:null });
  assert.deepEqual(classifyNasdaqHistoricalPayload({
    status:{ rCode:200 },
    data:{ tradesTable:{ rows:[{ date:'08/07/2026', close:'100', volume:'10' }] }, totalRecords:1 },
  }, rankingSession), { status:'invalid', reason:'requested-session-missing', row:null });
  assert.equal(canAcceptNasdaqHistorical({ status:'aligned' }, false), true);
  assert.equal(canAcceptNasdaqHistorical({ status:'ineligible' }, true), true);
  assert.equal(canAcceptNasdaqHistorical({ status:'ineligible' }, false), false);
  assert.equal(canAcceptNasdaqHistorical({ status:'invalid' }, true), false);
});

test('traditional candidates come from official market and options leaders without crypto input', () => {
  const directory = new Map([
    ['AAPL', { symbol:'AAPL', name:'Apple', category:'equity', tags:[] }],
    ['QQQ', { symbol:'QQQ', name:'Invesco QQQ', category:'etf', tags:[] }],
    ['SPY', { symbol:'SPY', name:'SPDR S&P 500', category:'etf', tags:[] }],
  ]);
  const rows = buildTraditionalCandidates(
    [{ symbol:'AAPL', lastSalePrice:'$200' }],
    { QQQ:1_000_000 },
    directory,
    10,
    { SPY:900_000, CRYPTO:2_000_000 },
  );
  assert.deepEqual(rows.map(row => row.symbol).sort(), ['AAPL', 'QQQ', 'SPY']);
  assert.equal(rows.find(row => row.symbol === 'QQQ').categoryHint, 'etf');
  assert.match(rows.find(row => row.symbol === 'SPY').sourceRanks[0], /Previous OCC options/);
});

test('traditional daily ranks are deterministic and distinguish movement, NEW, and unavailable', () => {
  const rows = [
    { symbol:'A', traditionalTotalValue:400, marketEstimatedValue:300, previousTraditionalTotalValue:300, previousMarketEstimatedValue:200 },
    { symbol:'B', traditionalTotalValue:300, marketEstimatedValue:200, previousTraditionalTotalValue:400, previousMarketEstimatedValue:300 },
    { symbol:'C', traditionalTotalValue:200, marketEstimatedValue:100, previousTraditionalTotalValue:200, previousMarketEstimatedValue:100 },
    { symbol:'E', traditionalTotalValue:100, marketEstimatedValue:50, previousTraditionalTotalValue:0, previousMarketEstimatedValue:0 },
    { symbol:'D', traditionalTotalValue:0, marketEstimatedValue:0, previousTraditionalTotalValue:100, previousMarketEstimatedValue:50 },
  ];
  const ranked = rankTraditionalRows(rows, 4, true, 4);
  assert.deepEqual(ranked.map(row => [row.symbol, row.rank, row.rankChange.status, row.rankChange.delta]), [
    ['A', 1, 'up', 1],
    ['B', 2, 'down', -1],
    ['C', 3, 'flat', 0],
    ['E', 4, 'new', null],
  ]);

  const unavailable = rankTraditionalRows(rows, 4, false, 4);
  assert.ok(unavailable.every(row => row.rankChange.status === 'unavailable'));
  assert.ok(unavailable.every(row => row.previousRank === null));

  const enteredFromBelow = rankTraditionalRows([
    { symbol:'A', traditionalTotalValue:400, marketEstimatedValue:1, previousTraditionalTotalValue:500, previousMarketEstimatedValue:1 },
    { symbol:'B', traditionalTotalValue:300, marketEstimatedValue:1, previousTraditionalTotalValue:400, previousMarketEstimatedValue:1 },
    { symbol:'C', traditionalTotalValue:200, marketEstimatedValue:1, previousTraditionalTotalValue:300, previousMarketEstimatedValue:1 },
    { symbol:'D', traditionalTotalValue:100, marketEstimatedValue:1, previousTraditionalTotalValue:200, previousMarketEstimatedValue:1 },
    { symbol:'Z', traditionalTotalValue:500, marketEstimatedValue:1, previousTraditionalTotalValue:100, previousMarketEstimatedValue:1 },
  ], 4, true, 4);
  assert.deepEqual(enteredFromBelow[0].rankChange, { status:'new', delta:null, previousRank:5 });

  const tied = rankTraditionalRows([
    { symbol:'ZZZ', traditionalTotalValue:100, marketEstimatedValue:50, previousTraditionalTotalValue:100, previousMarketEstimatedValue:50 },
    { symbol:'AAA', traditionalTotalValue:100, marketEstimatedValue:50, previousTraditionalTotalValue:100, previousMarketEstimatedValue:50 },
  ], 2, true, 2);
  assert.deepEqual(tied.map(row => row.symbol), ['AAA', 'ZZZ']);
  assert.ok(tied.every(row => row.rankChange.status === 'flat'));
});

test('traditional alignment exposes dropped symbols instead of silently treating them as current-session rows', () => {
  const candidates = [{ symbol:'AAPL' }, { symbol:'QQQ' }];
  const alignment = summarizeTraditionalAlignment([
    { symbol:'AAPL', market:{ sessionDate:'2026-08-06', volume:2500, lastPrice:99.5 } },
    { symbol:'QQQ', market:{ sessionDate:null, volume:null, lastPrice:null } },
  ], candidates, '2026-08-06');
  assert.deepEqual(alignment, {
    requestedCandidateCount:2,
    eligibleCandidateCount:2,
    alignedCandidateCount:1,
    ineligibleCandidateCount:0,
    ineligibleSymbols:[],
    droppedCandidateCount:1,
    droppedSymbols:['QQQ'],
    ratio:0.5,
  });
  assert.equal(hasCompleteTraditionalAlignment(alignment), false);

  const postSessionListing = summarizeTraditionalAlignment([
    { symbol:'AAPL', market:{ sessionDate:'2026-08-06', sessionEligibility:'aligned', volume:2500, lastPrice:99.5 } },
    { symbol:'NEWIPO', market:{ sessionDate:null, sessionEligibility:'ineligible', sessionExclusionReason:'no-session-row', volume:null, lastPrice:null } },
  ], [{ symbol:'AAPL' }, { symbol:'NEWIPO' }], '2026-08-06');
  assert.deepEqual(postSessionListing, {
    requestedCandidateCount:2,
    eligibleCandidateCount:1,
    alignedCandidateCount:1,
    ineligibleCandidateCount:1,
    ineligibleSymbols:['NEWIPO'],
    droppedCandidateCount:0,
    droppedSymbols:[],
    ratio:1,
  });
  assert.equal(hasCompleteTraditionalAlignment(postSessionListing), true);

  const materialHeadDrop = summarizeTraditionalAlignment(
    Array.from({ length:32 }, (_, index) => ({
      symbol:`TAIL${index + 9}`,
      market:{ sessionDate:'2026-08-06', volume:1, lastPrice:1 },
    })),
    Array.from({ length:40 }, (_, index) => ({
      symbol:index < 8 ? `OCC_TOP${index + 1}` : `TAIL${index + 1}`,
    })),
    '2026-08-06',
  );
  assert.equal(materialHeadDrop.ratio, 0.8);
  assert.deepEqual(materialHeadDrop.droppedSymbols, [
    'OCC_TOP1', 'OCC_TOP2', 'OCC_TOP3', 'OCC_TOP4',
    'OCC_TOP5', 'OCC_TOP6', 'OCC_TOP7', 'OCC_TOP8',
  ]);
  assert.equal(hasCompleteTraditionalAlignment(materialHeadDrop), false);
});

test('traditional ranking has no arbitrary share-price floor', async () => {
  const source = await readFile(new URL('../api/tradfi-activity.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /market\.lastPrice\s*[><=]+\s*[1-9]/);
  assert.match(source, /filter\(row => Number\(row\?\.traditionalTotalValue\) > 0\)/);
  assert.match(source, /!hasCompleteTraditionalAlignment\(alignment\)/);
  assert.doesNotMatch(source, /fetchOccBundle\(\)\.catch/);
  assert.match(source, /export const config = \{ maxDuration:300 \}/);
});

test('traditional endpoints reject cache-busting query parameters before upstream work', async () => {
  const omittedLimitResponse = responseRecorder();
  await tradfiActivityHandler({ method:'GET', query:{} }, omittedLimitResponse);
  assert.equal(omittedLimitResponse.statusCode, 400);
  assert.equal(omittedLimitResponse.payload.error, 'Invalid limit');

  const activityResponse = responseRecorder();
  await tradfiActivityHandler({ method:'GET', query:{ limit:'30', refresh:'123' } }, activityResponse);
  assert.equal(activityResponse.statusCode, 400);
  assert.equal(activityResponse.payload.error, 'Unsupported query parameter');

  const excessiveActivityResponse = responseRecorder();
  await tradfiActivityHandler({ method:'GET', query:{ limit:'101' } }, excessiveActivityResponse);
  assert.equal(excessiveActivityResponse.statusCode, 400);
  assert.equal(excessiveActivityResponse.payload.error, 'Invalid limit');

  const variantActivityResponse = responseRecorder();
  await tradfiActivityHandler({ method:'GET', query:{ limit:'99' } }, variantActivityResponse);
  assert.equal(variantActivityResponse.statusCode, 400);
  assert.equal(variantActivityResponse.payload.error, 'Invalid limit');

  const pricesResponse = responseRecorder();
  await tradfiPricesHandler({ method:'GET', query:{ symbols:'AAPL', refresh:'123' } }, pricesResponse);
  assert.equal(pricesResponse.statusCode, 400);
  assert.equal(pricesResponse.payload.error, 'Unsupported query parameter');

  const excessivePricesResponse = responseRecorder();
  const excessiveSymbols = Array.from({ length:101 }, (_, index) => `S${String(index).padStart(3, '0')}`).join(',');
  await tradfiPricesHandler({ method:'GET', query:{ symbols:excessiveSymbols } }, excessivePricesResponse);
  assert.equal(excessivePricesResponse.statusCode, 400);
  assert.match(excessivePricesResponse.payload.error, /maximum is 100/);
});

test('traditional spot overlay resolves venue-verified wrappers before joining', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /function spotAssetSecurityIdentity\(asset\)/);
  assert.match(html, /const securityIdentity = spotAssetSecurityIdentity\(a\)/);
  assert.match(html, /side === 'spot' \? spotAssetSecurityIdentity\(asset\) : null/);
  assert.match(html, /const isVenueVerified = Boolean\(asset\?\.underlyingSymbol\)/);
  assert.doesNotMatch(html, /isStaticWrapper \|\|/);
  assert.doesNotMatch(html, /if \(isStatic \|\| \(venue && allowedVenues\.includes\(venue\)\)\)/);
  assert.doesNotMatch(html, /OFFICIAL_TOKENIZED_UNDERLYINGS/);
  assert.match(html, /normalizeSpotDataState\(\{ \.\.\.row, venue \}\)/);
  assert.match(html, /Spot · \$\{String\(asset\.coin \|\| ''\)\.toUpperCase\(\)\}/);
  assert.match(
    html,
    /const canonical = side === 'spot'\s*\? spotIdentity\.symbol\s*:\s*canonicalSymbolForCategory\(asset\.coin, category\)/,
  );
  assert.match(html, /if \(side === 'spot' && !spotIdentity\) return/);
  assert.match(html, /if \(!resolvedVenue \|\| !hasLastGoodSnapshot\) return/);
  assert.match(html, /ratio > 0\.5 && ratio < 1\.5/);
  assert.match(html, /dataStatusBadge\('estimated', spreadStatusTitle\)/);
  assert.match(html, /tradfiPriceRefreshTimer = setInterval/);
  assert.match(html, /const hasLastGoodSnapshot = isLive \|\| health\?\.status === 'stale'/);
  assert.match(html, /function traditionalOverlayVolumeState\(coverage, side\)/);
  assert.doesNotMatch(html, /row\.perpVolume \+= Number\(asset\.volume\) \|\| 0/);
  assert.doesNotMatch(html, /row\.spotVolume \+= Number\(asset\.vol\) \|\| 0/);
  assert.match(html, /U\.S\.-listed securities in Nasdaq Trader directory/);
});

test('Traditional max spread and Drawer share one strict quote freshness gate', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const freshnessSource = sourceBetween(
    html,
    'function isUsRegularMarketWindow(now = new Date())',
    'async function loadTraditionalActivity(force = false)',
  );
  const spreadSource = sourceBetween(
    html,
    'function traditionalMaxPriceSpread(row, coverage, quote, quoteCacheTimestamp, now = Date.now())',
    'function renderTraditionalActivity()',
  );
  assert.ok(freshnessSource);
  assert.ok(spreadSource);

  const context = { Date, Intl };
  runInNewContext(`
    const TRADFI_PRICE_OPEN_TTL = 60 * 1000;
    const TRADFI_PRICE_CLOSED_TTL = 15 * 60 * 1000;
    ${freshnessSource}
    ${spreadSource}
    const openNow = Date.UTC(2026, 7, 7, 14, 0, 0);
    const closedNow = Date.UTC(2026, 7, 8, 14, 0, 0);
    const row = { category:'equity' };
    const coverage = { pricePoints:[{
      price:105, label:'Gate Perp', side:'perp', venue:'gate', currency:'USD', unit:'share',
    }] };
    const quote = { status:'full', price:100, currency:'USD', unit:'share', assetClass:'STOCKS' };
    globalThis.quoteFreshnessResults = {
      openTtl:currentTradfiPriceTtl(new Date(openNow)),
      closedTtl:currentTradfiPriceTtl(new Date(closedNow)),
      missing:isTraditionalQuoteFresh(null, closedNow),
      future:isTraditionalQuoteFresh(closedNow + 1, closedNow),
      boundary:isTraditionalQuoteFresh(closedNow - TRADFI_PRICE_CLOSED_TTL, closedNow),
      fresh:isTraditionalQuoteFresh(closedNow - TRADFI_PRICE_CLOSED_TTL + 1, closedNow),
      freshSpread:traditionalMaxPriceSpread(row, coverage, quote, closedNow - 1, closedNow)?.pct ?? null,
      staleSpread:traditionalMaxPriceSpread(row, coverage, quote, closedNow - TRADFI_PRICE_CLOSED_TTL, closedNow),
      missingTimestampSpread:traditionalMaxPriceSpread(row, coverage, quote, null, closedNow),
      futureTimestampSpread:traditionalMaxPriceSpread(row, coverage, quote, closedNow + 1, closedNow),
    };
  `, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.quoteFreshnessResults)), {
    openTtl:60_000,
    closedTtl:900_000,
    missing:false,
    future:false,
    boundary:false,
    fresh:true,
    freshSpread:5,
    staleSpread:null,
    missingTimestampSpread:null,
    futureTimestampSpread:null,
  });
  assert.match(html, /const quoteFresh = Boolean\(quoteCandidate && isTraditionalQuoteFresh\(tradfiPriceCache\?\.ts\)\)/);
  assert.match(html, /const cacheFresh = tradfiPriceCache && isTraditionalQuoteFresh\(tradfiPriceCache\.ts\)/);
  assert.match(html, /Stale Nasdaq quote .* excluded from max spread/);
  assert.match(html, /Stale Trad quote · excluded/);
});

test('shared cache helpers separate browser revalidation from Vercel CDN caching', () => {
  const cached = responseRecorder();
  setPublicCache(cached, 900, 3600);
  assert.deepEqual(cached.headers, {
    'Cache-Control':'public, max-age=0, must-revalidate',
    'Vercel-CDN-Cache-Control':'public, max-age=900, stale-while-revalidate=3600',
  });

  const uncached = responseRecorder();
  setNoStore(uncached);
  assert.deepEqual(uncached.headers, {
    'Cache-Control':'private, no-store, max-age=0',
    'Vercel-CDN-Cache-Control':'no-store',
  });

  for (const [maxAge, stale] of [
    [0, 60],
    [-1, 60],
    [1.5, 60],
    [31_536_001, 60],
    [60, -1],
    [60, 1.5],
    [60, 31_536_001],
  ]) {
    assert.throws(() => setPublicCache(responseRecorder(), maxAge, stale), /safe integer/);
  }
});

test('Gate bulk rejects unstable, oversized, and cache-busting queries before fetching', async () => {
  const tooManySymbols = Array.from(
    { length:81 },
    (_, index) => `S${String(index).padStart(3, '0')}_USDT`,
  ).join(',');
  const invalidQueries = [
    { type:'unknown' },
    { type:'growth', refresh:'1' },
    { type:'perp-snapshot', refresh:'1' },
    { type:'spot-depth', symbols:tooManySymbols, limit:'50' },
    { type:'spot-depth', symbols:'aapl_USDT', limit:'50' },
    { type:'spot-depth', symbols:'AAPL_USDT,AAPL_USDT', limit:'50' },
    { type:'spot-depth', symbols:'TSLA_USDT,AAPL_USDT', limit:'50' },
    { type:'spot-depth', symbols:'AAPL_USDT', limit:'49' },
  ];
  let fetchCount = 0;
  await withFetchStub(async () => {
    fetchCount += 1;
    throw new Error('invalid request reached upstream');
  }, async () => {
    for (const query of invalidQueries) {
      const response = responseRecorder();
      await gateBulkHandler({ method:'GET', query }, response);
      assert.equal(response.statusCode, 400, JSON.stringify(query));
      assert.match(response.payload.error, /Invalid|Unexpected|symbols/);
      assert.equal(response.headers['Cache-Control'], 'private, no-store, max-age=0');
      assert.equal(response.headers['Vercel-CDN-Cache-Control'], 'no-store');
    }
  });
  assert.equal(fetchCount, 0);
});

test('Gate fixed market snapshots replace the broad public proxy', async () => {
  const calls = [];
  await withFetchStub(async url => {
    const value = String(url);
    calls.push(value);
    if (value.endsWith('/futures/usdt/contracts')) {
      return jsonResponse([
        { name:'AAPL_USDT', status:'trading', contract_type:'stocks' },
        { name:'BTC_USDT', status:'trading', contract_type:'crypto' },
      ]);
    }
    if (value.endsWith('/futures/usdt/tickers')) {
      return jsonResponse([
        { contract:'AAPL_USDT', mark_price:'100' },
        { contract:'BTC_USDT', mark_price:'100000' },
      ]);
    }
    if (value.endsWith('/spot/currency_pairs')) {
      return jsonResponse([{ id:'AAPLX_USDT', base:'AAPLX', quote:'USDT', trade_status:'tradable' }]);
    }
    if (value.endsWith('/spot/tickers')) {
      return jsonResponse([{ currency_pair:'AAPLX_USDT', last:'100' }]);
    }
    throw new Error(`unexpected upstream ${value}`);
  }, async () => {
    const perpResponse = responseRecorder();
    await gateBulkHandler({ method:'GET', query:{ type:'perp-snapshot' } }, perpResponse);
    assert.equal(perpResponse.statusCode, 200);
    assert.equal(perpResponse.payload.contracts[0].name, 'AAPL_USDT');
    assert.equal(perpResponse.payload.tickers[0].contract, 'AAPL_USDT');
    assert.equal(perpResponse.payload.contracts.length, 1);
    assert.equal(perpResponse.payload.tickers.length, 1);
    assert.equal(
      perpResponse.headers['Vercel-CDN-Cache-Control'],
      'public, max-age=30, stale-while-revalidate=120',
    );

    const spotResponse = responseRecorder();
    await gateBulkHandler({ method:'GET', query:{ type:'spot-snapshot' } }, spotResponse);
    assert.equal(spotResponse.statusCode, 200);
    assert.equal(spotResponse.payload.pairs[0].id, 'AAPLX_USDT');
    assert.equal(spotResponse.payload.tickers[0].currency_pair, 'AAPLX_USDT');
  });
  assert.equal(calls.length, 4);

  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /fetch\('\/api\/gate-bulk\?type=perp-snapshot'\)/);
  assert.match(html, /fetchSpotResource\('\/api\/gate-bulk\?type=spot-snapshot'\)/);
  const vercelConfig = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(JSON.stringify(vercelConfig), /api\/gate(?:-spot)?\/:path/);
});

test('Gate spot snapshot fails closed when the authoritative pair catalog is unavailable', async () => {
  await withFetchStub(async url => {
    if (String(url).endsWith('/spot/currency_pairs')) throw new Error('catalog timeout');
    return jsonResponse([{ currency_pair:'AAPLX_USDT', last:'100' }]);
  }, async () => {
    const response = responseRecorder();
    await gateBulkHandler({ method:'GET', query:{ type:'spot-snapshot' } }, response);
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.payload, { error:'Gate market snapshot unavailable' });
    assert.equal(response.headers['Cache-Control'], 'private, no-store, max-age=0');
    assert.equal(response.headers['Vercel-CDN-Cache-Control'], 'no-store');
  });

  await withFetchStub(async url => {
    if (String(url).endsWith('/spot/currency_pairs')) {
      return jsonResponse([{ id:'BTC_ETH', base:'BTC', quote:'ETH', trade_status:'tradable' }]);
    }
    return jsonResponse([{ currency_pair:'BTC_ETH', last:'1' }]);
  }, async () => {
    const response = responseRecorder();
    await gateBulkHandler({ method:'GET', query:{ type:'spot-snapshot' } }, response);
    assert.equal(response.statusCode, 502);
    assert.equal(response.headers['Vercel-CDN-Cache-Control'], 'no-store');
  });
});

test('Gate spot depth serves a sorted multi-symbol request through one cached bulk response', async () => {
  const calls = [];
  await withFetchStub(async url => {
    calls.push(String(url));
    const pair = new URL(url).searchParams.get('currency_pair');
    return jsonResponse({
      id:pair,
      bids:[['100', '2']],
      asks:[['101', '3']],
    });
  }, async () => {
    const response = responseRecorder();
    await gateBulkHandler({
      method:'GET',
      query:{ type:'spot-depth', symbols:'AAPL_USDT,TSLA_USDT', limit:'50' },
    }, response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(Object.keys(response.payload), ['AAPL_USDT', 'TSLA_USDT']);
    assert.equal(response.payload.AAPL_USDT.id, 'AAPL_USDT');
    assert.equal(response.payload.TSLA_USDT.id, 'TSLA_USDT');
    assert.equal(response.headers['Cache-Control'], 'public, max-age=0, must-revalidate');
    assert.equal(
      response.headers['Vercel-CDN-Cache-Control'],
      'public, max-age=30, stale-while-revalidate=120',
    );
  });
  assert.deepEqual(
    calls.map(url => new URL(url).searchParams.get('currency_pair')),
    ['AAPL_USDT', 'TSLA_USDT'],
  );
});

test('Gate growth discovers only official RWA contract types and calculates two complete 24h halves', async () => {
  const calls = [];
  await withFetchStub(async url => {
    const value = String(url);
    calls.push(value);
    if (value.endsWith('/futures/usdt/contracts')) {
      return jsonResponse([
        { name:'BTC_USDT', status:'trading', contract_type:'crypto' },
        { name:'HALTED_USDT', status:'delisting', contract_type:'stocks' },
        { name:'XAU_USDT', status:'trading', contract_type:'metals' },
        { name:'AAPL_USDT', status:'trading', contract_type:'stocks' },
      ]);
    }
    const parsed = new URL(value);
    const contract = parsed.searchParams.get('contract');
    const from = Number(parsed.searchParams.get('from'));
    const to = Number(parsed.searchParams.get('to'));
    const midpoint = to - 24 * 60 * 60;
    const currentVolume = contract === 'AAPL_USDT' ? 3 : 1;
    const candles = [
      ...Array.from({ length:10 }, (_, index) => ({ t:from + index * 3600, v:2, c:5 })),
      ...Array.from({ length:10 }, (_, index) => ({ t:midpoint + index * 3600, v:currentVolume, c:5 })),
    ];
    return jsonResponse(candles);
  }, async () => {
    const response = responseRecorder();
    await gateBulkHandler({ method:'GET', query:{ type:'growth' } }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(Object.keys(response.payload), ['AAPL_USDT', 'XAU_USDT']);
    assert.deepEqual(response.payload.AAPL_USDT, { prevVol:100, currVol:150, growth:50 });
    assert.deepEqual(response.payload.XAU_USDT, { prevVol:100, currVol:50, growth:-50 });
    assert.equal(
      response.headers['Vercel-CDN-Cache-Control'],
      'public, max-age=900, stale-while-revalidate=3600',
    );
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.some(url => url.includes('contract=AAPL_USDT')));
  assert.ok(calls.some(url => url.includes('contract=XAU_USDT')));
  assert.ok(calls.every(url => !url.includes('BTC_USDT') && !url.includes('HALTED_USDT')));
});

test('Gate growth fails closed and is never CDN cached when every RWA candle fails', async () => {
  await withFetchStub(async url => {
    if (String(url).endsWith('/futures/usdt/contracts')) {
      return jsonResponse([{ name:'AAPL_USDT', status:'trading', contract_type:'stocks' }]);
    }
    return jsonResponse([]);
  }, async () => {
    const response = responseRecorder();
    await gateBulkHandler({ method:'GET', query:{ type:'growth' } }, response);
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.payload, { error:'Gate growth data unavailable' });
    assert.equal(response.headers['Cache-Control'], 'private, no-store, max-age=0');
    assert.equal(response.headers['Vercel-CDN-Cache-Control'], 'no-store');
  });
});

test('browser resource contracts keep Gate fan-out stable and pause polling while hidden', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /const GROWTH_FETCH_INTERVAL = 15 \* 60 \* 1000/);

  const growthSource = sourceBetween(
    html,
    'async function fetchVolumeGrowthGate()',
    '// ═══════════════════════════════════════════════\n// ASSET DETAIL MODAL',
  );
  assert.equal((growthSource.match(/fetch\(/g) || []).length, 1);
  assert.match(growthSource, /fetch\('\/api\/gate-bulk\?type=growth'\)/);
  assert.doesNotMatch(growthSource, /candlestick|symbols=|from=|to=/i);

  const gateSpotSource = sourceBetween(
    html,
    'async function fetchSpotRwaGate(',
    '// ── Kraken Spot Fetch ──',
  );
  assert.equal((gateSpotSource.match(/type=spot-depth/g) || []).length, 1);
  assert.match(gateSpotSource, /if \(!_isDev && depthAssets\.length\)/);
  assert.match(gateSpotSource, /depthAssets\.map\(asset => asset\.pair\)\.sort\(\)\.join\(','\)/);
  const productionDepthBranch = sourceBetween(
    gateSpotSource,
    'if (!_isDev && depthAssets.length)',
    '} else {',
  );
  assert.match(productionDepthBranch, /fetchSpotResource\(\s*`\/api\/gate-bulk\?type=spot-depth/);
  assert.doesNotMatch(productionDepthBranch, /GATE_SPOT_BASE.*order_book/);

  const gateTopThirtySource = sourceBetween(
    html,
    '// ── Gate.io: bulk klines via serverless function',
    '// ── trade.xyz: aggregate 1h HIP-3 candles server-side and return totals only ──',
  );
  assert.match(gateTopThirtySource, /\[\.\.\.new Set\(gateAssets\.map\(a => a\.symbol \|\| \(a\.coin \+ '_USDT'\)\)\)\]\.sort\(\)/);
  assert.match(gateTopThirtySource, /const gateToSec = Math\.floor\(nowSec \/ \(24 \* 60 \* 60\)\) \* 24 \* 60 \* 60/);
  assert.match(gateTopThirtySource, /quoteVolume !== null && quoteVolume >= 0/);
  assert.match(gateTopThirtySource, /candleMap\.set\(timestamp, c\)/);
  assert.match(gateTopThirtySource, /\[\.\.\.candleMap\.values\(\)\].*slice\(-30\)/);

  const visibilitySource = sourceBetween(
    html,
    "document.addEventListener('visibilitychange'",
    '(async function init()',
  );
  assert.match(visibilitySource, /if \(!pageIsVisible\(\)\) \{\s*stopPolling\(\);\s*return;/);
  assert.match(visibilitySource, /startPolling\(\);\s*resumeVisibleRefreshes\(\)/);
  const pollingSource = sourceBetween(html, 'function startPolling()', "document.addEventListener('visibilitychange'");
  assert.match(pollingSource, /stopPolling\(\);\s*if \(!pageIsVisible\(\)\) return;/);
  assert.match(pollingSource, /ensureTraditionalActivity\(false\)/);

  const growthCoordinator = sourceBetween(
    html,
    'async function fetchVolumeGrowthAll()',
    '// Rate-limited batch executor',
  );
  assert.match(growthCoordinator, /const previous = volumeGrowthData\[key\] \|\| \{\}/);
  assert.match(growthCoordinator, /else if \(previous\[coin\]\) merged\[coin\] = previous\[coin\]/);
  assert.match(growthCoordinator, /volumeGrowthFetchState\[key\]\.lastSuccessAt/);

  const visibleRenderer = sourceBetween(
    html,
    'function renderVisibleDataPage()',
    '// ═══════════════════════════════════════════════\n// VIEW SWITCH',
  );
  assert.match(visibleRenderer, /if \(!pageIsVisible\(\)\) return/);
  assert.match(visibleRenderer, /if \(topPageIsActive\('perps'\)\)/);
});

test('browser same-origin venue snapshots preserve shared CDN caching', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /fetch\(url, \{ cache: 'no-store', signal: AbortSignal\.timeout\(endpoint \? 12000 : 3500\) \}\)/);
  assert.doesNotMatch(html, /fetch\('\/api\/okx-market\?type=(?:perp|spot)-snapshot', \{ cache:'no-store'/);
  assert.match(html, /fetch\(url, \{ signal: AbortSignal\.timeout\(endpoint \? 12000 : 3500\) \}\)/);
  assert.match(html, /fetch\('\/api\/okx-market\?type=perp-snapshot', \{ signal:AbortSignal\.timeout\(55000\) \}\)/);
  assert.match(html, /fetchSpotResource\('\/api\/okx-market\?type=spot-snapshot', 20000\)/);
});

test('Spot cold load streams venue catalogs while optional depth enrichment stays off the critical path', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /const SPOT_CORE_REQUEST_TIMEOUT = 15000/);
  assert.match(html, /const SPOT_DEPTH_REQUEST_TIMEOUT = 5000/);
  assert.match(html, /const SPOT_VENUE_DEADLINE = 20000/);
  assert.match(html, /let spotRefreshGeneration = 0/);
  assert.doesNotMatch(html, /class="spot-cnt">(?:8|2|5|0)<\/span>/);
  assert.equal((html.match(/class="spot-cnt">—<\/span>/g) || []).length, 5);
  assert.match(html, /function updateSpotStatusLine[\s\S]*?spotEmptyStateIsLoading\(\)[\s\S]*?Loading spot venue catalogs…/);
  const krakenXStockSource = sourceBetween(
    html,
    'async function _fetchKrakenXStocks()',
    '// ── Bitget Spot Fetch ──',
  );
  assert.match(krakenXStockSource, /info\.aclass_base \|\| ''\)\.toLowerCase\(\) !== 'tokenized_asset'/);
  assert.match(krakenXStockSource, /info\.status \|\| ''\)\.toLowerCase\(\) !== 'online'/);
  assert.match(krakenXStockSource, /pair: pairInfo\.altname, venueSymbol:pairInfo\.altname/);
  assert.match(krakenXStockSource, /Ticker\?asset_class=tokenized_asset/);
  assert.match(krakenXStockSource, /Promise\.allSettled\(\[pairsRequest, tickerRequest\]\)/,
    'the fixed tokenized catalog and one full ticker snapshot should start together');
  assert.match(krakenXStockSource, /const t = tickerRows\[pairInfo\.altname\] \|\| \{\}/,
    'Kraken xStocks must join only the exact case-sensitive official altname');
  assert.match(krakenXStockSource, /volume24h \* vwap24h/);
  assert.match(krakenXStockSource, /last, chg:null, vol:volumeUsd/);
  assert.doesNotMatch(krakenXStockSource, /pairKey\.includes|\.startsWith\(|\bt\.o\b|volume24h \* last|vol24 \* last/,
    'Kraken xStocks must not use fuzzy aliases, UTC-day open, or last-price volume estimation');

  const krakenCoreSource = sourceBetween(
    html,
    'async function fetchSpotRwaKraken(',
    '// ── Kraken xStocks',
  );
  assert.match(krakenCoreSource, /Object\.prototype\.hasOwnProperty\.call\(results, alias\)/);
  assert.match(krakenCoreSource, /volume24h \* vwap24h/);
  assert.match(krakenCoreSource, /last, chg:null, vol:volumeUsd/);
  assert.doesNotMatch(krakenCoreSource, /pairKey\.startsWith|\bt\.o\b|volume24h \* last|vol24 \* last/,
    'legacy Kraken RWA rows follow the same exact-alias and rolling-volume semantics');

  const settleSource = sourceBetween(
    html,
    'async function settleSpotVenue(venue, fetcher)',
    'function scheduleSpotDepthEnhancement',
  );
  const deadlineContext = { setTimeout, clearTimeout, Promise, Error };
  runInNewContext(`
    const SPOT_VENUE_DEADLINE = 5;
    const SPOT_VENUE_NAMES = { pending:'Pending venue' };
    ${settleSource}
    globalThis.settle = settleSpotVenue;
  `, deadlineContext);
  const deadlineResult = await deadlineContext.settle('pending', () => new Promise(() => {}));
  assert.equal(deadlineResult.status, 'rejected');
  assert.match(deadlineResult.reason.message, /exceeded 0\.005s core-data deadline/);

  const switchSource = sourceBetween(
    html,
    'function switchTopPage(page)',
    '// ═══════════════════════════════════════════════\n// SPOT DATA & LOGIC',
  );
  assert.match(switchSource, /page === 'spot'[\s\S]*?refreshSpotArbData\(true\)/);

  const refreshSource = sourceBetween(
    html,
    'async function refreshSpotArbData(force = false)',
    'const SPOT_VENUE_NAMES',
  );
  assert.match(refreshSource, /const applyVenueResult = \(venue, result\) =>/);
  assert.match(refreshSource, /const refreshGeneration = \+\+spotRefreshGeneration/);
  assert.match(refreshSource, /const bitgetIdentityPromise = fetchBitgetRealityCatalog\(\)/);
  assert.match(refreshSource, /independentFetchers = \{[\s\S]*?kraken:[\s\S]*?binance:[\s\S]*?okx:/);
  assert.match(refreshSource, /applyVenueResult\(venue, result\)/);
  assert.match(refreshSource, /settleSpotVenue\('bitget', \(\) => fetchSpotRwaBitget\(refreshGeneration, bitgetIdentityPromise\)\)/);
  assert.match(refreshSource, /await bitgetIdentityPromise[\s\S]*?settleSpotVenue\('gate', \(\) => fetchSpotRwaGate\(refreshGeneration\)\)/);
  assert.match(refreshSource, /Bitget Reality identity dependency unavailable/);
  assert.doesNotMatch(refreshSource, /remainingResults = await Promise\.allSettled/);

  for (const [start, end, venue] of [
    ['async function fetchSpotRwaGate(', '// ── Kraken Spot Fetch ──', 'gate'],
    ['async function fetchSpotRwaKraken(', '// ── Kraken xStocks', 'kraken'],
    ['async function fetchSpotRwaBitget(', '// ── Binance Spot Fetch ──', 'bitget'],
    ['async function fetchSpotRwaBinance(', '// ── OKX Unified Tokenized Stocks ──', 'binance'],
  ]) {
    const source = sourceBetween(html, start, end);
    assert.match(source, new RegExp(`scheduleSpotDepthEnhancement\\('${venue}'`));
    assert.match(source, /scheduleSpotDepthEnhancement\([\s\S]*?generation\)/);
    assert.doesNotMatch(source, /await Promise\.allSettled\(depthTasks/);
  }

  const depthSource = sourceBetween(html, 'function scheduleSpotDepthEnhancement', '// ═══════════════════════════════════════════════\n// REFERENCE PRICING');
  assert.match(depthSource, /generation = spotRefreshGeneration/);
  assert.match(depthSource, /generation !== spotRefreshGeneration/);
  assert.match(depthSource, /spotDepthEnhancementInFlight\[venue\] = \{ generation, run \}/);

  const bitgetSource = sourceBetween(html, 'async function fetchBitgetRealityCatalog()', '// ── Binance Spot Fetch ──');
  assert.match(bitgetSource, /registerSpotAssetMeta\(coin, underlying, 'Reality'/);
  assert.match(bitgetSource, /const marketFeedsPromise = Promise\.allSettled\(\[\s*realityTickersPromise,\s*legacyTickersPromise/);
  assert.match(bitgetSource, /const realityCatalog = await realityCatalogPromise;\s*const \[realityTickersResult, legacyTickersResult\] = await marketFeedsPromise/);
  assert.match(bitgetSource, /keeping official listings with Unavailable market fields/);

  const referenceSource = sourceBetween(html, 'async function fetchReferencePrices(symbols)', 'function getRefPrice(coin)');
  assert.match(referenceSource, /refPricePendingSymbols\.add/);
  assert.match(referenceSource, /while \(refPricePendingSymbols\.size\)/);
  assert.match(referenceSource, /function scheduleSpotReferenceEnrichment\(\)/);
  assert.match(refreshSource, /scheduleSpotReferenceEnrichment\(\)/);

  const initSource = sourceBetween(html, '(async function init()', '</script>');
  assert.match(initSource, /overlay\.style\.display = 'none'[\s\S]*?Promise\.allSettled/);
  assert.match(initSource, /Promise\.allSettled\(\[\s*refresh\(true\),\s*refreshSpotArbData\(true\)/);
  assert.match(initSource, /SPOT_PERP = _buildSpotPerpFromAllData\(\);\s*scheduleSpotReferenceEnrichment\(\)/);
});

test('Traditional activity renders without I/O and loads only while its page is active', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const renderSource = sourceBetween(
    html,
    'function renderTraditionalActivity()',
    'function setVenueFilter(venue, cat, el)',
  );
  assert.doesNotMatch(renderSource, /\bfetch\s*\(/);
  assert.doesNotMatch(renderSource, /loadTraditional(?:Activity|Prices)\s*\(/);
  assert.doesNotMatch(renderSource, /ensureTraditionalActivity\s*\(/);

  const switchSource = sourceBetween(
    html,
    'function switchTopPage(page)',
    '// ═══════════════════════════════════════════════\n// SPOT DATA & LOGIC',
  );
  assert.match(
    switchSource,
    /if \(page === 'traditional'\) \{\s*renderTraditionalActivity\(\);\s*ensureTraditionalActivity\(false\)/,
  );

  const ensureSource = sourceBetween(
    html,
    'async function ensureTraditionalActivity(force = false)',
    'async function refreshTraditionalActivity()',
  );
  assert.match(ensureSource, /if \(!pageIsVisible\(\) \|\| !active\) return/);
  assert.match(ensureSource, /await loadTraditionalActivity\(force\)/);
  assert.match(ensureSource, /if \(!pageIsVisible\(\) \|\| !stillActive\) return/);
  assert.match(ensureSource, /await loadTraditionalPrices\(rows, force\)/);

  const activityLoader = sourceBetween(
    html,
    'async function loadTraditionalActivity(force = false)',
    'async function loadTraditionalPrices(rows, force = false)',
  );
  assert.match(activityLoader, /Date\.now\(\) < tradfiActivityRetryAt/);
  assert.match(activityLoader, /tradfiActivityRetryAt = Date\.now\(\) \+ retryDelay/);

  const priceLoader = sourceBetween(
    html,
    'async function loadTraditionalPrices(rows, force = false)',
    'async function ensureTraditionalActivity(force = false)',
  );
  assert.match(priceLoader, /const inFlightKey = tradfiPricePromiseKey/);
  assert.match(priceLoader, /if \(!force && inFlightKey === symbolsKey\) return/);

  const spotRefreshSource = sourceBetween(
    html,
    'async function refreshSpotArbData(force = false)',
    'const SPOT_VENUE_NAMES',
  );
  assert.doesNotMatch(spotRefreshSource, /renderTraditionalActivity\(\)/);
  assert.match(spotRefreshSource, /renderVisibleDataPage\(\)/);
  assert.match(spotRefreshSource, /scheduleSpotReferenceEnrichment\(\)/);
  assert.match(spotRefreshSource, /if \(topPageIsActive\('spot'\)\) renderVisibleDataPage\(\)/);
});

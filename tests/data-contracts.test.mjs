import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
  SECURITY_ETF_UNDERLYINGS,
  SECURITY_LISTING_REGISTRY,
  TOKENIZED_ETF_WRAPPERS,
  categoryFromOfficialSignalType,
  normalizeSignalIdentity,
} from '../api/_lib/security-identity.js';
import gateBulkHandler from '../api/gate-bulk.js';
import signalSnapshotHandler, {
  isSignalSnapshotComparable,
  mergeSignalHistory,
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

test('signal identity gate rejects crypto types, conflicts, and preserves real zero funding', () => {
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
  assert.deepEqual(result.assets.map(asset => asset.symbol), ['QNT']);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.conflicts.length, 1);
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
  assert.deepEqual(normalizeSignalIdentity('SPYX', 'equity'), { symbol:'SPY', category:'etf' });
  assert.deepEqual(normalizeSignalIdentity('FOOB', 'equity', { allowBinanceBstock:true }), { symbol:'FOOB', category:'equity' });
  assert.equal(categoryFromOfficialSignalType('ETF'), 'etf');
  assert.equal(categoryFromOfficialSignalType('stock_etf'), 'etf');
  assert.equal(categoryFromOfficialSignalType('crypto_etf_token'), null);
  assert.equal(categoryFromOfficialSignalType('ETFCOIN'), null);

  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
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

test('incomplete source coverage cannot become comparable anomaly history', () => {
  const fullSources = Object.fromEntries(['gate', 'binance', 'bitget', 'tradexyz'].map(name => [name, { status:'full' }]));
  assert.equal(isSignalSnapshotComparable(fullSources), true);
  assert.equal(isSignalSnapshotComparable({ ...fullSources, gate:{ status:'partial' } }), false);
  assert.equal(isSignalSnapshotComparable({ ...fullSources, gate:{ status:'unavailable' } }), false);
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
});

test('Signal Radar and Asset Intelligence use server history and one canonical drawer', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /data-p="cross"[\s\S]*?RWA Signal Radar/);
  assert.match(html, /id="page-cross"[\s\S]*?id="radarTableRegion"/);
  assert.match(html, /fetch\('\/api\/signal-snapshot', \{ method:'GET' \}\)/);
  assert.match(html, /function radarPageIsActive\(\)[\s\S]*?pageIsVisible\(\)/);
  assert.match(html, /const SIGNAL_SNAPSHOT_TTL = 5 \* 60 \* 1000/);
  assert.match(html, /rows\.slice\(0, radarExpanded \? 100 : 50\)/);
  assert.match(html, /if \(activePage === 'cross'\) \{[\s\S]*?await ensureSignalSnapshot\(false\);[\s\S]*?return;/);
  assert.match(html, /if \(activePage === 'spot' \|\| activePage === 'traditional'\) \{[\s\S]*?refreshSpotArbData\(\)/);
  assert.match(html, /Baseline warming/);
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
    ['Traditional Market Activity Monitor · Top 100', '传统市场活跃度监控 · Top 100'],
    ['Asset Intelligence · canonical underlying', '资产情报 · 标准底层资产'],
  ];
  sentinels.forEach(([english, chinese]) => {
    assert.ok(html.includes(english), `missing rendered English sentinel: ${english}`);
    assert.ok(i18n.includes(`'${english}':'${chinese}'`), `missing Chinese translation sentinel: ${english}`);
  });
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
  };
  const sentinels = {
    Traditional: ['Trad Volume', 'Options Volume', 'Est. Total Notional', 'Need Trad + Crypto prices'],
    Spot: ['24h Volume', 'No spot data loaded. Click Refresh.', 'No combos match the current filters.'],
    Heatmap: ['Short receives', 'Long receives', 'Data coverage', 'Venue spread', 'Need 2 venues'],
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
  assert.match(html, /fetch\('\/api\/gate-bulk\?type=spot-snapshot'\)/);
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
    'async function fetchSpotRwaGate()',
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
  assert.match(productionDepthBranch, /fetch\(`\/api\/gate-bulk\?type=spot-depth/);
  assert.doesNotMatch(productionDepthBranch, /GATE_SPOT_BASE.*order_book/);

  const gateTopThirtySource = sourceBetween(
    html,
    '// ── Gate.io: bulk klines via serverless function',
    '// ── trade.xyz: aggregate 1h HIP-3 candles server-side and return totals only ──',
  );
  assert.match(gateTopThirtySource, /\.map\(a => a\.symbol \|\| \(a\.coin \+ '_USDT'\)\)\.sort\(\)/);
  assert.match(gateTopThirtySource, /const gateToSec = Math\.floor\(nowSec \/ 300\) \* 300/);

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
  assert.match(spotRefreshSource, /if \(pageIsVisible\(\)\) \{\s*fetchReferencePrices/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { historyCoverage, normalizeHistoryRows } from '../api/funding-history.js';
import { assessChecks } from '../api/_lib/health.js';
import { FX_REFERENCE_MAP, yahooSymbolFor } from '../api/_lib/reference-map.js';
import tradfiActivityHandler, {
  buildTraditionalCandidates,
  canAcceptNasdaqHistorical,
  classifyNasdaqHistoricalPayload,
  estimatedOptionsNotional,
  estimatedShareValue,
  hasCompleteTraditionalAlignment,
  nasdaqHistoricalWindow,
  occDateToIso,
  optionActivityForSymbol,
  parseNasdaqDirectory,
  parseNasdaqHistoricalRow,
  parseOccReport,
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
  assert.deepEqual(nasdaqHistoricalWindow(rankingSession), {
    fromdate:'2026-08-06',
    todate:'2026-08-07',
  });
  const row = parseNasdaqHistoricalRow({
    data:{ tradesTable:{ rows:[
      { date:'08/07/2026', close:'$101.00', volume:'1,000' },
      { date:'08/06/2026', close:'$99.50', volume:'2,500' },
    ] } },
  }, rankingSession);
  assert.deepEqual(row, { sessionDate:'2026-08-06', close:99.5, volume:2500 });
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
  ]);
  const rows = buildTraditionalCandidates(
    [{ symbol:'AAPL', lastSalePrice:'$200' }],
    { QQQ:1_000_000 },
    directory,
    10,
  );
  assert.deepEqual(rows.map(row => row.symbol).sort(), ['AAPL', 'QQQ']);
  assert.equal(rows.find(row => row.symbol === 'QQQ').categoryHint, 'etf');
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
  assert.doesNotMatch(source, /market\.lastPrice\s*[><=]/);
  assert.match(source, /filter\(row => row\.traditionalTotalValue > 0\)/);
  assert.match(source, /!hasCompleteTraditionalAlignment\(alignment\)/);
  assert.doesNotMatch(source, /fetchOccBundle\(\)\.catch/);
});

test('traditional endpoints reject cache-busting query parameters before upstream work', async () => {
  const activityResponse = responseRecorder();
  await tradfiActivityHandler({ method:'GET', query:{ limit:'30', refresh:'123' } }, activityResponse);
  assert.equal(activityResponse.statusCode, 400);
  assert.equal(activityResponse.payload.error, 'Unsupported query parameter');

  const pricesResponse = responseRecorder();
  await tradfiPricesHandler({ method:'GET', query:{ symbols:'AAPL', refresh:'123' } }, pricesResponse);
  assert.equal(pricesResponse.statusCode, 400);
  assert.equal(pricesResponse.payload.error, 'Unsupported query parameter');
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

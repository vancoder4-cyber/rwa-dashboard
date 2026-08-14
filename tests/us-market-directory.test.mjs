import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

import {
  NASDAQ_LISTED_URL,
  OTHER_LISTED_URL,
  US_MARKET_DIRECTORY_MAX_SOURCE_AGE_MS,
  parseNasdaqTraderAsOf,
  parseNasdaqDirectory,
  validateUsMarketDirectoryPayload,
} from '../api/_lib/us-market-directory.js';
import usMarketDirectoryHandler, {
  compactUsMarketDirectory,
  usMarketDirectoryCachePolicy,
} from '../api/us-market-directory.js';
import { probeUsMarketDirectory, validateUsMarketDirectory } from '../api/health.js';

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

function textResponse(body, status = 200) {
  return {
    ok:status >= 200 && status < 300,
    status,
    headers:{ get() { return null; } },
    async text() { return body; },
  };
}

function nasdaqTraderStamp(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hourCycle:'h23',
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.month}${parts.day}${parts.year}${parts.hour}:${parts.minute}`;
}

function nasdaqTraderAsOf(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hourCycle:'h23',
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ET`;
}

function validDirectoryPayload(nowMs, sourceMs = nowMs) {
  const alignedSourceMs = Math.floor(sourceMs / 60_000) * 60_000;
  const asOf = nasdaqTraderAsOf(new Date(alignedSourceMs));
  const symbols = [
    'AAPL','BABA','QQQ','TSM',
    ...Array.from({ length:8000 }, (_, index) => `S${String(index).padStart(7, '0')}`),
  ].sort();
  return {
    schemaVersion:1,
    status:'full',
    generatedAt:new Date(nowMs).toISOString(),
    asOf,
    sourceAsOf:{ nasdaqListed:asOf, otherListed:asOf },
    freshness:{
      sourceEpochs:{ nasdaqListed:alignedSourceMs, otherListed:alignedSourceMs },
      oldestSourceMs:alignedSourceMs,
      newestSourceMs:alignedSourceMs,
      validUntilMs:alignedSourceMs + US_MARKET_DIRECTORY_MAX_SOURCE_AGE_MS,
    },
    symbols,
    etfs:['QQQ'],
    adrs:['BABA'],
    coverage:{
      listedSecurityCount:symbols.length,
      etfCount:1,
      adrCount:1,
      sourceCounts:{ nasdaqListed:4002, otherListed:4002 },
    },
  };
}

function nasdaqDirectoryText(rows, createdAt = new Date()) {
  return [
    'Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares',
    ...rows,
    `File Creation Time: ${nasdaqTraderStamp(createdAt)}|||||||`,
  ].join('\n');
}

function otherDirectoryText(rows, createdAt = new Date()) {
  return [
    'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
    ...rows,
    `File Creation Time: ${nasdaqTraderStamp(createdAt)}|||||||`,
  ].join('\n');
}

test('U.S. directory admits equities and ETFs but ADR classification is equity-only', () => {
  const rows = parseNasdaqDirectory(nasdaqDirectoryText([
    'AAPL|Apple Inc. Common Stock|Q|N|N|100|N|N',
    'BABA|Alibaba Group Holding Limited American Depositary Shares|Q|N|N|100|N|N',
    'API|Agora, Inc. - ADS|Q|N|N|100|N|N',
    'ADSE|ADS-TEC ENERGY PLC - Ordinary Shares|Q|N|N|100|N|N',
    'AADR|AdvisorShares Dorsey Wright ADR ETF|G|N|N|100|Y|N',
    'BND|Vanguard Total Bond Market ETF|G|N|N|100|Y|N',
    'PFF|iShares Preferred and Income Securities ETF|G|N|N|100|Y|N',
    'OBAI|Our Bond, Inc. Common Stock|Q|N|N|100|N|N',
    'PFBC|Preferred Bank Common Stock|Q|N|N|100|N|N',
    'TEST|Test Security|G|Y|N|100|N|N',
    'BADW|Example Warrant|G|N|N|100|N|N',
    'BADN|Example ETN|G|N|N|100|N|N',
    'BADP|Example Series A Preferred Stock|G|N|N|100|N|N',
    'PSNYW|Polestar Automotive Class C-1 ADS (ADW)|G|N|N|100|N|N',
  ]), 'nasdaq');
  assert.deepEqual(rows.map(row => row.symbol), ['AAPL', 'BABA', 'API', 'ADSE', 'AADR', 'BND', 'PFF', 'OBAI', 'PFBC']);
  assert.deepEqual(rows.find(row => row.symbol === 'BABA').tags, ['ADR']);
  assert.deepEqual(rows.find(row => row.symbol === 'API').tags, ['ADR']);
  assert.deepEqual(rows.find(row => row.symbol === 'ADSE').tags, []);
  assert.deepEqual(rows.find(row => row.symbol === 'AADR').tags, []);
});

test('other-listed symbols follow the official fourteen-character field limit', () => {
  const rows = parseNasdaqDirectory([
    'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
    'LONGSYMBOL1234|Fourteen Character Common Stock|N|LONGSYMBOL1234|N|100|N|LONGSYMBOL1234',
    'LONGSYMBOL12345|Fifteen Character Common Stock|N|LONGSYMBOL12345|N|100|N|LONGSYMBOL12345',
    'File Creation Time: 0808202618:02|||||||',
  ].join('\n'), 'other');
  assert.deepEqual(rows.map(row => row.symbol), ['LONGSYMBOL1234']);
});

test('other-listed preferred-class ACT symbology is excluded before ticker projection', () => {
  const rows = parseNasdaqDirectory([
    'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
    'BAC$E|Bank of America Depositary Shares|N|BAC$E|N|100|N|BAC-E',
    'MS$F|Morgan Stanley Series F|N|MS$F|N|100|N|MS-F',
    'PFBC|Preferred Bank Common Stock|N|PFBC|N|100|N|PFBC',
    `File Creation Time: ${nasdaqTraderStamp()}|||||||`,
  ].join('\n'), 'other');
  assert.deepEqual(rows.map(row => row.symbol), ['PFBC']);
});

test('Nasdaq Trader ET timestamps are strict across summer, winter, and DST boundaries', () => {
  assert.equal(parseNasdaqTraderAsOf('2026-08-08 18:01 ET'), Date.UTC(2026, 7, 8, 22, 1));
  assert.equal(parseNasdaqTraderAsOf('2026-01-08 18:01 ET'), Date.UTC(2026, 0, 8, 23, 1));
  assert.equal(parseNasdaqTraderAsOf('2026-03-08 03:30 ET'), Date.UTC(2026, 2, 8, 7, 30));
  assert.equal(parseNasdaqTraderAsOf('2026-11-01 02:30 ET'), Date.UTC(2026, 10, 1, 7, 30));
  ['2026-02-30 18:01 ET','2026-08-08 24:01 ET','2026-08-08 18:60 ET','2026-03-08 02:30 ET']
    .forEach(value => assert.equal(parseNasdaqTraderAsOf(value), null, value));
});

test('directory freshness is absolute, fail-closed, and cannot be extended by reload', () => {
  const nowMs = Date.UTC(2026, 7, 8, 22, 0);
  const fresh = validDirectoryPayload(nowMs, nowMs - 60_000);
  assert.equal(validateUsMarketDirectoryPayload(fresh, { nowMs }).valid, true);

  const boundarySource = Math.floor((nowMs - US_MARKET_DIRECTORY_MAX_SOURCE_AGE_MS) / 60_000) * 60_000;
  const boundary = validDirectoryPayload(nowMs, boundarySource);
  assert.equal(validateUsMarketDirectoryPayload(boundary, { nowMs }).valid, true);
  assert.equal(validateUsMarketDirectoryPayload(boundary, { nowMs:nowMs + 1 }).valid, false);

  const futureAllowed = validDirectoryPayload(nowMs, nowMs + 15 * 60_000);
  assert.equal(validateUsMarketDirectoryPayload(futureAllowed, { nowMs }).valid, true);
  const futureRejected = validDirectoryPayload(nowMs, nowMs + 16 * 60_000);
  assert.equal(validateUsMarketDirectoryPayload(futureRejected, { nowMs }).valid, false);

  const malformed = structuredClone(fresh);
  malformed.symbols[0] = malformed.symbols[0].toLowerCase();
  assert.equal(validateUsMarketDirectoryPayload(malformed, { nowMs }).valid, false);
  const projectedFromDifferentSource = structuredClone(fresh);
  projectedFromDifferentSource.freshness.sourceEpochs.nasdaqListed -= 60_000;
  const projectedValidation = validateUsMarketDirectoryPayload(projectedFromDifferentSource, { nowMs });
  assert.equal(projectedValidation.valid, false);
  assert.equal(projectedValidation.sourceEpochsValid, false);
  assert.ok(projectedValidation.issues.includes('freshness-projection'));
  const orphanAdr = structuredClone(fresh);
  orphanAdr.adrs.push('ZZZZ');
  orphanAdr.coverage.adrCount += 1;
  assert.equal(validateUsMarketDirectoryPayload(orphanAdr, { nowMs }).valid, false);
});

test('directory ETF membership is a sorted, unique subset with exact coverage', () => {
  const nowMs = Date.UTC(2026, 7, 8, 22, 0);
  const fresh = validDirectoryPayload(nowMs, nowMs - 60_000);
  const valid = validateUsMarketDirectoryPayload(fresh, { nowMs });
  assert.equal(valid.valid, true);
  assert.equal(valid.etfCount, 1);
  assert.equal(valid.etfCountMatches, true);
  assert.equal(valid.sortedEtfs, true);

  const orphanEtf = structuredClone(fresh);
  orphanEtf.etfs.push('ZZZZ');
  orphanEtf.coverage.etfCount += 1;
  const orphanValidation = validateUsMarketDirectoryPayload(orphanEtf, { nowMs });
  assert.equal(orphanValidation.valid, false);
  assert.ok(orphanValidation.issues.includes('etf-contract'));

  const duplicateEtf = structuredClone(fresh);
  duplicateEtf.etfs.push('QQQ');
  duplicateEtf.coverage.etfCount += 1;
  const duplicateValidation = validateUsMarketDirectoryPayload(duplicateEtf, { nowMs });
  assert.equal(duplicateValidation.valid, false);
  assert.ok(duplicateValidation.issues.includes('duplicate'));

  const unsortedEtfs = structuredClone(fresh);
  unsortedEtfs.etfs = ['QQQ', 'AAPL'];
  unsortedEtfs.coverage.etfCount = 2;
  const unsortedValidation = validateUsMarketDirectoryPayload(unsortedEtfs, { nowMs });
  assert.equal(unsortedValidation.valid, false);
  assert.equal(unsortedValidation.sortedEtfs, false);
  assert.ok(unsortedValidation.issues.includes('sort-order'));

  const wrongCount = structuredClone(fresh);
  wrongCount.coverage.etfCount = 2;
  const countValidation = validateUsMarketDirectoryPayload(wrongCount, { nowMs });
  assert.equal(countValidation.valid, false);
  assert.equal(countValidation.etfCountMatches, false);
  assert.ok(countValidation.issues.includes('coverage-count'));
});

test('directory CDN cache policy never crosses the source hard expiry', () => {
  const nowMs = Date.UTC(2026, 7, 8, 22, 0);
  assert.deepEqual(usMarketDirectoryCachePolicy(nowMs + 30_000, nowMs), { maxAge:30, staleWhileRevalidate:0 });
  assert.deepEqual(usMarketDirectoryCachePolicy(nowMs + 10 * 60 * 60_000, nowMs), { maxAge:3600, staleWhileRevalidate:21600 });
  assert.equal(usMarketDirectoryCachePolicy(nowMs, nowMs), null);
});

test('U.S. directory endpoint returns one deterministic, cacheable official identity snapshot', async () => {
  const nasdaqGenerated = Array.from({ length:4000 }, (_, index) => {
    const symbol = `S${String(index).padStart(7, '0')}`;
    return `${symbol}|Security ${index} Common Stock|Q|N|N|100|N|N`;
  });
  nasdaqGenerated.push(
    'AAPL|Apple Inc. Common Stock|Q|N|N|100|N|N',
    'QQQ|Invesco QQQ Trust Series 1|G|N|N|100|Y|N',
  );
  const otherGenerated = Array.from({ length:4000 }, (_, index) => {
    const symbol = `O${String(index).padStart(7, '0')}`;
    return `${symbol}|Security ${index} Common Stock|N|${symbol}|N|100|N|${symbol}`;
  });
  otherGenerated.push(
    'BABA|Alibaba Group Holding Limited American Depositary Shares|N|BABA|N|100|N|BABA',
    'TSM|Taiwan Semiconductor Manufacturing Company Limited|N|TSM|N|100|N|TSM',
    'BTC|Grayscale Bitcoin Mini Trust ETF|P|BTC|Y|100|N|BTC',
    'OPENAI|Future OpenAI Common Stock|N|OPENAI|N|100|N|OPENAI',
  );
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async url => {
    requested.push(String(url));
    if (String(url) === NASDAQ_LISTED_URL) return textResponse(nasdaqDirectoryText(nasdaqGenerated));
    if (String(url) === OTHER_LISTED_URL) return textResponse(otherDirectoryText(otherGenerated));
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const res = responseRecorder();
    await usMarketDirectoryHandler({ method:'GET', query:{} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.schemaVersion, 1);
    assert.equal(res.payload.status, 'full');
    assert.equal(res.payload.coverage.listedSecurityCount, 8006);
    assert.equal(res.payload.coverage.etfCount, 2);
    assert.deepEqual(res.payload.coverage.sourceCounts, { nasdaqListed:4002, otherListed:4004 });
    assert.ok(res.payload.symbols.includes('AAPL'));
    assert.deepEqual(res.payload.etfs, ['BTC', 'QQQ']);
    assert.ok(res.payload.etfs.includes('QQQ'));
    assert.ok(res.payload.adrs.includes('BABA'));
    assert.ok(res.payload.symbols.includes('BTC'), 'legitimate U.S.-listed BTC ETF ticker must not poison the directory');
    assert.ok(res.payload.symbols.includes('OPENAI'), 'directory validation must not depend on any ticker remaining absent forever');
    assert.deepEqual(requested.sort(), [NASDAQ_LISTED_URL, OTHER_LISTED_URL].sort());
    assert.match(res.headers['Vercel-CDN-Cache-Control'], /max-age=3600/);
    assert.equal(validateUsMarketDirectory(res.payload).valid, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('U.S. directory endpoint rejects a snapshot when either official source is incomplete', async () => {
  const generated = Array.from({ length:8000 }, (_, index) => {
    const symbol = `S${String(index).padStart(7, '0')}`;
    return `${symbol}|Security ${index} Common Stock|Q|N|N|100|N|N`;
  });
  generated.push(
    'AAPL|Apple Inc. Common Stock|Q|N|N|100|N|N',
    'QQQ|Invesco QQQ Trust Series 1|G|N|N|100|Y|N',
    'BABA|Alibaba Group Holding Limited American Depositary Shares|Q|N|N|100|N|N',
    'TSM|Taiwan Semiconductor Manufacturing Company Limited|Q|N|N|100|N|N',
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url) === NASDAQ_LISTED_URL
    ? textResponse(nasdaqDirectoryText(generated))
    : textResponse(otherDirectoryText([]));
  try {
    const res = responseRecorder();
    await usMarketDirectoryHandler({ method:'GET', query:{} }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['Vercel-CDN-Cache-Control'], 'no-store');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('U.S. directory endpoint rejects cache-fragmenting queries and fails closed', async () => {
  const queryRes = responseRecorder();
  await usMarketDirectoryHandler({ method:'GET', query:{ symbol:'AAPL' } }, queryRes);
  assert.equal(queryRes.statusCode, 400);
  assert.equal(queryRes.headers['Vercel-CDN-Cache-Control'], 'no-store');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => textResponse('unavailable', 503);
  try {
    const res = responseRecorder();
    await usMarketDirectoryHandler({ method:'GET', query:{} }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.payload.status, 'unavailable');
    assert.equal(res.headers['Vercel-CDN-Cache-Control'], 'no-store');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('compact directory sorts symbols and emits ETF and ADR subsets', () => {
  const payload = compactUsMarketDirectory({
    asOf:'2026-08-08T18:01:00-04:00',
    bySymbol:new Map([
      ['TSM', { symbol:'TSM', category:'equity', exchange:'N', tags:[] }],
      ['QQQ', { symbol:'QQQ', category:'etf', exchange:'NASDAQ', tags:[] }],
      ['BABA', { symbol:'BABA', category:'equity', exchange:'NASDAQ', tags:['ADR'] }],
      ['AAPL', { symbol:'AAPL', category:'equity', exchange:'NASDAQ', tags:[] }],
    ]),
  });
  assert.deepEqual(payload.symbols, ['AAPL', 'BABA', 'QQQ', 'TSM']);
  assert.deepEqual(payload.etfs, ['QQQ']);
  assert.deepEqual(payload.adrs, ['BABA']);
  assert.equal(payload.coverage.etfCount, 1);
});

test('health treats an invalid HTTP-200 U.S. directory as critical', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok:true,
    status:200,
    headers:{ get() { return 'application/json'; } },
    async json() { return { schemaVersion:1, status:'full', symbols:[], adrs:[] }; },
  });
  try {
    const result = await probeUsMarketDirectory('https://directory-health.test');
    assert.equal(result.status, 'fail');
    assert.equal(result.critical, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Perpetual and Spot market filters share official US identity and aggregate tag unions', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const spotAllSource = html.slice(
    html.indexOf('function renderSpotAllAssets()'),
    html.indexOf('function setSpotCatFilter', html.indexOf('function renderSpotAllAssets()')),
  );
  const verifiedNormalizerSource = html.slice(
    html.indexOf('function normalizeOfficialRwaSymbol'),
    html.indexOf('function isTradableRwaSymbol', html.indexOf('function normalizeOfficialRwaSymbol')),
  );
  const i18n = await readFile(new URL('../i18n.js', import.meta.url), 'utf8');
  const health = await readFile(new URL('../api/health.js', import.meta.url), 'utf8');
  assert.match(html, /fetch\('\/api\/us-market-directory'/);
  assert.doesNotMatch(html, /fetch\('\/api\/us-market-directory', \{ cache:'no-store'/);
  assert.match(html, /const MARKET_TAG_ORDER = \['US','ADR','HK','KR','TW','JP','CN'\]/);
  assert.match(html, /if \(!\['equity','etf'\]\.includes\(category\)\) return false/);
  assert.match(html, /US_MARKET_DIRECTORY\.symbols\.has\(symbol\)/);
  assert.doesNotMatch(html, /symbolSet\.has\('BTC'\)/);
  assert.match(html, /asset\.marketTags = marketTagUnion\(asset\.listings\)/);
  assert.match(html, /renderMarketTags\(a\.marketTags\)/);
  assert.match(html, /group\.marketTags = marketTagUnion\(entries\)/);
  assert.match(html, /renderMarketTags\(group\.marketTags\)/);
  assert.match(verifiedNormalizerSource, /TOKENIZED_ETF_WRAPPERS\[raw\]/);
  assert.match(verifiedNormalizerSource, /symbol:verifiedUnderlying \|\| canonicalSymbolForCategory\(raw, category\)/);
  assert.match(html, /underlyingSymbol:normalized\.underlyingSymbol/);
  assert.match(html, /venueCoin === 'SKHX' && cat === 'equity' \? 'SKHYNIX'/);
  assert.match(html, /const identity = assetAggregationIdentity\(d\)/);
  assert.match(html, /catFilter !== 'all'.*\n.*marketFilter === 'US'/);
  assert.match(html, /spotCatFilter==='all'.*\n.*spotMarketFilter!=='US'/);
  assert.match(spotAllSource, /const change = numberOrNull\(a\.chg\)/);
  assert.match(spotAllSource, /const volume = numberOrNull\(a\.vol\)/);
  assert.match(spotAllSource, /last!==null&&last>0&&change!==null/);
  assert.match(spotAllSource, /volume===null\?'—':'\$'\+spotFV\(volume\)/);
  assert.doesNotMatch(spotAllSource, /a\.chg\.toFixed\(2\)/);
  assert.doesNotMatch(spotAllSource, /spotFV\(a\.vol\)/);
  assert.match(html, /id="assetMarketFilters"/);
  assert.match(html, /id="spotArbMarketFilters"/);
  assert.match(html, /id="spotMarketFilters"/);
  assert.match(html, /id="spotVenueMarketFilters"/);
  assert.match(html, /data-market-filter="all"/);
  assert.match(html, /data-market-filter="US"/);
  assert.match(html, /role="group" aria-label="Market filter"/);
  assert.match(html, /renderMarketTags\(marketTagUnion\(c\.listings\)\)/);
  assert.match(html, /renderMarketTags\(marketTags\)/);
  assert.match(html, /ensureUsMarketDirectory\(\).*scheduled refresh failed/);
  assert.match(html, /if \(!allData\.length\) return;[\s\S]*?if \(currentView === 'asset'\)/);
  assert.match(html, /Wait for the verified venue universe instead of caching an empty result/);
  assert.match(html, /US_MARKET_DIRECTORY_MAX_STALE_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(html, /symbols\.every\(symbol => \/\^\[A-Z\]\[A-Z0-9\.\-\]\{0,13\}\$\//);
  assert.match(html, /US_MARKET_DIRECTORY\.retryAt = 0/);
  const ensureStart = html.indexOf('async function ensureUsMarketDirectory');
  const ensureEnd = html.indexOf('function marketTagsForAsset', ensureStart);
  const ensureSource = html.slice(ensureStart, ensureEnd);
  const absoluteExpiryCheck = ensureSource.indexOf('now >= US_MARKET_DIRECTORY.validUntilMs');
  assert.notEqual(absoluteExpiryCheck, -1, 'absolute expiry check must use inclusive boundary');
  assert.ok(
    absoluteExpiryCheck < ensureSource.indexOf('if (US_MARKET_DIRECTORY.promise)'),
    'absolute expiry must be cleared before returning an in-flight refresh',
  );
  const directoryRoute = await readFile(new URL('../api/us-market-directory.js', import.meta.url), 'utf8');
  assert.ok(
    directoryRoute.indexOf('const directory = await fetchUsListedDirectory()') <
      directoryRoute.indexOf('const nowMs = Date.now()'),
    'response/cache time must be captured after both upstream directory fetches',
  );
  assert.match(health, /mapWithConcurrency\(probeJobs, 5/);
  assert.doesNotMatch(health, /timeoutMs: 20000, retries: 1/);
  assert.match(i18n, /'US-listed':'美股'/);
  assert.match(i18n, /'All Markets':'全部市场'/);
  assert.match(i18n, /'Using last verified directory':'正在使用最近一次已验证目录'/);
});

test('client U.S. membership is category-gated before same-ticker directory matching', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('const MARKET_TAG_DEFS =');
  const end = html.indexOf('function rerenderMarketAwareViews()', start);
  const tagsStart = html.indexOf('function marketTagsForAsset', end);
  const tagsEnd = html.indexOf('function renderMarketTags', tagsStart);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.notEqual(tagsStart, -1);
  assert.notEqual(tagsEnd, -1);
  const source = html.slice(start, end) + html.slice(tagsStart, tagsEnd) + `
    US_MARKET_DIRECTORY.symbols = new Set(['BTC','AAPL','CL','CAT','QNT','QQQ','QQQX','TSM','AADR','ASML','OPENAI','SKHX']);
    US_MARKET_DIRECTORY.adrs = new Set(['TSM']);
    US_MARKET_DIRECTORY.validUntilMs = Date.now() + 60_000;
    globalThis.identityResults = {
      cryptoBtc:isUsListedSecurity({coin:'BTC',category:'crypto',officialType:'crypto'}),
      missingCategoryCrypto:isUsListedSecurity({coin:'BTC',officialType:'crypto'}),
      conflictingCrypto:isUsListedSecurity({coin:'QNT',category:'equity',officialType:'crypto'}),
      verifiedCryptoQnt:isUsListedSecurity({coin:'QNT',category:'equity',officialType:'crypto',identityVerified:true}),
      verifiedCryptoBtc:isUsListedSecurity({coin:'BTC',category:'etf',officialType:'crypto',identityVerified:true}),
      etfBtc:isUsListedSecurity({coin:'BTC',category:'etf',officialType:'ETF'}),
      equityWrapper:isUsListedSecurity({coin:'AAPLX',category:'equity'}),
      explicitWrapper:isUsListedSecurity({coin:'QQQX',underlyingSymbol:'QQQ',category:'etf'}),
      realQqqxFund:isUsListedSecurity({coin:'QQQX',category:'equity'}),
      explicitRealIdentity:_marketIdentityForAsset({coin:'QQQX',underlyingSymbol:'QQQX',category:'equity'}).underlying,
      commodityCollision:isUsListedSecurity({coin:'CL',category:'commodity'}),
      equityCollision:isUsListedSecurity({coin:'CL',category:'equity'}),
      preIpo:isUsListedSecurity({coin:'OPENAI',category:'pre-ipo'}),
      tsmTags:marketTagsForAsset({coin:'TSM',category:'equity',officialType:'TW_STOCK'}),
      tsmCryptoTags:marketTagsForAsset({coin:'TSM',category:'crypto',officialType:'crypto'}),
      aadrTags:marketTagsForAsset({coin:'AADR',category:'etf',officialType:'ADR ETF'}),
      asmlTags:marketTagsForAsset({coin:'ASML',category:'equity',officialType:'stock'}),
      networkTags:marketTagsForAsset({coin:'CAT',category:'equity',officialType:'NETWORK_STOCK'}),
      krakenTags:marketTagsForAsset({coin:'CAT',category:'equity',officialType:'KRAKEN_STOCK'}),
      kuaishouTags:marketTagsForAsset({coin:'KUAISHOU',category:'equity',marketType:'equity',venueMarketType:'crypto',identityVerified:true}),
      skHynixAliasTags:marketTagsForAsset({coin:'SKHX',underlyingSymbol:'SKHYNIX',category:'equity',officialType:'stock'}),
      hardExpiry:(US_MARKET_DIRECTORY.validUntilMs = Date.now(), isUsListedSecurity({coin:'AAPL',category:'equity',officialType:'stock'})),
    };
  `;
  const context = {
    Set, Date, clearTimeout, setTimeout, queueMicrotask,
    rerenderMarketAwareViews() {},
    ASSET_META:{ AAPLX:{ underlyingSymbol:'AAPL', category:'equity' } },
    _arbUnderlyingKey(symbol) {
      if (symbol === 'AAPLX') return 'AAPL';
      return symbol;
    },
    categoryForOfficialType(type) {
      const value = String(type || '').toUpperCase();
      if (value.includes('CRYPTO') || value.includes('TOKEN')) return 'other';
      if (value.includes('ETF')) return 'etf';
      if (value.includes('STOCK') || value.includes('EQUITY')) return 'equity';
      return '';
    },
    canonicalSymbol(symbol) { return symbol; },
    canonicalSymbolForCategory(symbol) { return symbol; },
  };
  runInNewContext(source, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.identityResults)), {
    cryptoBtc:false,
    missingCategoryCrypto:false,
    conflictingCrypto:false,
    verifiedCryptoQnt:false,
    verifiedCryptoBtc:false,
    etfBtc:true,
    equityWrapper:true,
    explicitWrapper:true,
    realQqqxFund:true,
    explicitRealIdentity:'QQQX',
    commodityCollision:false,
    equityCollision:true,
    preIpo:false,
    tsmTags:['US','ADR','TW'],
    tsmCryptoTags:[],
    aadrTags:['US'],
    asmlTags:['US'],
    networkTags:['US'],
    krakenTags:['US'],
    kuaishouTags:['HK'],
    skHynixAliasTags:['KR'],
    hardExpiry:false,
  });
});

test('client aggregation keys separate category collisions and honor verified underlyings', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('function assetAggregationIdentity');
  const end = html.indexOf('function inferCategory', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = html.slice(start, end) + `
    globalThis.aggregationResults = {
      equityCl:assetAggregationIdentity({coin:'CL',category:'equity'}),
      commodityCl:assetAggregationIdentity({coin:'CL',category:'commodity'}),
      verifiedSkHynix:assetAggregationIdentity({coin:'SKHX',underlyingSymbol:'SKHYNIX',category:'equity'}),
      verifiedQqqWrapper:assetAggregationIdentity({coin:'QQQX',underlyingSymbol:'QQQ',category:'etf'}),
    };
  `;
  const context = {
    canonicalSymbolForCategory(symbol, category) {
      if (category === 'commodity' && symbol === 'CL') return 'WTI';
      return symbol;
    },
    inferCategory() { return 'other'; },
  };
  runInNewContext(source, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.aggregationResults)), {
    equityCl:{ key:'equity:CL', symbol:'CL', category:'equity' },
    commodityCl:{ key:'commodity:WTI', symbol:'WTI', category:'commodity' },
    verifiedSkHynix:{ key:'equity:SKHYNIX', symbol:'SKHYNIX', category:'equity' },
    verifiedQqqWrapper:{ key:'etf:QQQ', symbol:'QQQ', category:'etf' },
  });
});

test('client lifecycle aliases never rewrite an independently categorized ETF', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('function canonicalSymbolForCategory');
  const end = html.indexOf('// Aggregation must keep category', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = html.slice(start, end) + `
    globalThis.categoryAliasResults = {
      qntbEquity:canonicalSymbolForCategory('QNTB', 'equity'),
      qntbPreIpo:canonicalSymbolForCategory('QNTB', 'pre-ipo'),
      qntbEtf:canonicalSymbolForCategory('QNTB', 'etf'),
      spcxbEtf:canonicalSymbolForCategory('SPCXB', 'etf'),
      cbrsbEtf:canonicalSymbolForCategory('CBRSB', 'etf'),
    };
  `;
  const context = {
    COMMODITY_SYMBOL_ALIASES:{}, INDEX_SYMBOL_ALIASES:{}, EQUITY_SYMBOL_ALIASES:{},
    SYMBOL_ALIASES:{},
    securityListingForSymbol(symbol) {
      const aliases = { QNTB:'QNT', SPCXB:'SPCX', CBRSB:'CBRS' };
      return aliases[symbol] ? { canonical:aliases[symbol] } : null;
    },
    canonicalSymbol(symbol) { return symbol; },
  };
  runInNewContext(source, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.categoryAliasResults)), {
    qntbEquity:'QNT',
    qntbPreIpo:'QNT',
    qntbEtf:'QNTB',
    spcxbEtf:'SPCXB',
    cbrsbEtf:'CBRSB',
  });
});

test('client security category and Spot identity gates cannot promote explicit crypto collisions', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const categoryStart = html.indexOf('function securityCategoryForUnderlying');
  const categoryEnd = html.indexOf('function normalizedOfficialType', categoryStart);
  const identityStart = html.indexOf('function spotAssetSecurityIdentity');
  const identityEnd = html.indexOf('const ISSUER_STYLES', identityStart);
  assert.notEqual(categoryStart, -1);
  assert.notEqual(categoryEnd, -1);
  assert.notEqual(identityStart, -1);
  assert.notEqual(identityEnd, -1);
  const source = html.slice(categoryStart, categoryEnd) + html.slice(identityStart, identityEnd) + `
    globalThis.spotIdentityResults = {
      qntbEtfCategory:securityCategoryForUnderlying('QNTB', 'etf'),
      qntCryptoCategory:securityCategoryForUnderlying('QNT', 'other'),
      explicitCryptoQnt:spotAssetSecurityIdentity({coin:'RQNT',underlyingSymbol:'QNT',category:'equity',marketType:'crypto',venue:'bitget'}),
      explicitCryptoBtc:spotAssetSecurityIdentity({coin:'RBTC',underlyingSymbol:'BTC',category:'etf',marketType:'crypto',venue:'bitget'}),
      verifiedEquity:spotAssetSecurityIdentity({coin:'RQNT',underlyingSymbol:'QNT',category:'equity',marketType:'stock',venue:'bitget'}),
      independentlyTypedEtf:spotAssetSecurityIdentity({coin:'QNTB',underlyingSymbol:'QNTB',category:'etf',marketType:'ETF',venue:'bitget'}),
    };
  `;
  const context = {
    ETF_SYMBOLS:new Set(), EQUITY_SYMBOL_ALIASES:{}, ASSET_META:{}, GATE_SPOT_VERIFIED_WRAPPERS:new Set(),
    securityListingForSymbol(symbol) {
      return symbol === 'QNT' || symbol === 'QNTB' ? { canonical:'QNT', category:'equity' } : null;
    },
    categoryForOfficialType(type) {
      const value = String(type || '').toUpperCase();
      if (value === 'CRYPTO') return 'other';
      if (value === 'ETF') return 'etf';
      if (value === 'STOCK') return 'equity';
      return '';
    },
    _arbUnderlyingKey(symbol) { return symbol; },
    canonicalSymbolForCategory(symbol) { return symbol; },
  };
  runInNewContext(source, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.spotIdentityResults)), {
    qntbEtfCategory:'etf',
    qntCryptoCategory:'other',
    explicitCryptoQnt:null,
    explicitCryptoBtc:null,
    verifiedEquity:{ symbol:'QNT', category:'equity' },
    independentlyTypedEtf:{ symbol:'QNTB', category:'etf' },
  });
  const bitgetSpotStart = html.indexOf('async function fetchBitgetRealityCatalog');
  const bitgetSpotEnd = html.indexOf('// Keep the legacy v2 feed', bitgetSpotStart);
  const bitgetSpotSource = html.slice(bitgetSpotStart, bitgetSpotEnd);
  assert.match(bitgetSpotSource, /if \(category === 'other'\) continue/);
  assert.match(bitgetSpotSource, /venueMarketType: instrument\.symbolType/);
});

test('venue-scoped normalization keeps real QQQX/SPYX securities distinct from Gate wrappers', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('function normalizeOfficialRwaSymbol');
  const end = html.indexOf('function isTradableRwaSymbol', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = html.slice(start, end) + `
    globalThis.normalizedResults = {
      realQqqx:normalizeOfficialRwaSymbol('QQQX', 'STOCK', '', 'binance'),
      realSpyx:normalizeOfficialRwaSymbol('SPYX', 'ETF', '', 'bitget'),
      gateQqqx:normalizeOfficialRwaSymbol('QQQX', 'STOCK', '', 'gate'),
      gateSpyx:normalizeOfficialRwaSymbol('SPYX', 'STOCK', '', 'gate'),
    };
  `;
  const context = {
    TOKENIZED_ETF_WRAPPERS:{ QQQX:'QQQ', SPYX:'SPY', TQQQX:'TQQQ', SLVON:'SLV' },
    categoryFromOfficial(type) { return type === 'ETF' ? 'etf' : 'equity'; },
    canonicalSymbolForCategory(symbol) { return symbol; },
  };
  runInNewContext(source, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.normalizedResults)), {
    realQqqx:{ symbol:'QQQX', category:'equity' },
    realSpyx:{ symbol:'SPYX', category:'etf' },
    gateQqqx:{ symbol:'QQQ', category:'etf', underlyingSymbol:'QQQ' },
    gateSpyx:{ symbol:'SPY', category:'etf', underlyingSymbol:'SPY' },
  });
});

test('Top 30 identity separates same-ticker categories and merges only audited gold components', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('const TOP30_COMMODITY_MERGE_GROUPS');
  const end = html.indexOf('function fetchReal30DayVolume', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = html.slice(start, end) + `
    globalThis.top30Results = {
      tradeSkhx:top30VolumeIdentity({coin:'SKHX',underlyingSymbol:'SKHYNIX',category:'equity'}),
      realSkhx:top30VolumeIdentity({coin:'SKHX',category:'etf'}),
      equityCl:top30VolumeIdentity({coin:'CL',category:'equity'}),
      crudeCl:top30VolumeIdentity({coin:'CL',category:'commodity'}),
      xaut:top30VolumeIdentity({coin:'XAUT',category:'commodity'}),
      paxg:top30VolumeIdentity({coin:'PAXG',category:'commodity'}),
      realQqqx:top30VolumeIdentity({coin:'QQQX',category:'equity'}),
      gateQqqx:top30VolumeIdentity({coin:'QQQX',underlyingSymbol:'QQQ',category:'etf'}),
    };
  `;
  const context = {
    Object,
    assetAggregationIdentity(asset) {
      const aliases = asset.category === 'commodity' ? { CL:'WTI' } : {};
      const symbol = asset.underlyingSymbol || aliases[asset.coin] || asset.coin;
      return { key:`${asset.category}:${symbol}`, symbol, category:asset.category };
    },
  };
  runInNewContext(source, context);
  const results = JSON.parse(JSON.stringify(context.top30Results));
  assert.equal(results.tradeSkhx.key, 'equity:SKHYNIX');
  assert.equal(results.realSkhx.key, 'etf:SKHX');
  assert.equal(results.equityCl.key, 'equity:CL');
  assert.equal(results.crudeCl.key, 'commodity:WTI');
  assert.equal(results.xaut.key, 'commodity:XAU');
  assert.equal(results.paxg.key, 'commodity:XAU');
  assert.equal(results.realQqqx.key, 'equity:QQQX');
  assert.equal(results.gateQqqx.key, 'etf:QQQ');
});

test('Top 30 Full status requires every current listing and complete confirmed candles', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('function volumeDataStatus');
  const end = html.indexOf('const statusCounts', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = html.slice(start, end) + `
    const venue = (expected, observed, method, vol30d = 0) => ({
      expectedContributions:new Set(expected), contributions:new Set(observed), method, vol30d,
    });
    globalThis.coverageResults = {
      full:volumeDataStatus({venues:{gate:venue(['A'],['A'],'real',0)}}).status,
      missingListing:volumeDataStatus({venues:{okx:venue(['A','B'],['A'],'real',100)}}).status,
      shortHistory:volumeDataStatus({venues:{bitget:venue(['A'],['A'],'partial',100)}}).status,
      estimated:volumeDataStatus({venues:{binance:venue(['A'],['A'],'est',100)}}).status,
      unavailable:volumeDataStatus({venues:{trade:venue(['A'],[],null,0)}}).status,
      staleCatalog:(() => {
        venueHealth.gate.status = 'stale';
        const status = volumeDataStatus({venues:{gate:venue(['A'],['A'],'real',100)}}).status;
        venueHealth.gate.status = 'live';
        return status;
      })(),
    };
  `;
  const context = {
    Set,
    ENABLED_PERP_VENUES:['gate','okx','bitget','binance','tradexyz'],
    venueHealth:Object.fromEntries(['gate','okx','bitget','binance','tradexyz'].map(venue => [venue,{ status:'live', lastSuccessAt:Date.now() }])),
    REFRESH_INTERVAL:60_000,
    assetIntelligenceEffectiveHealth(health) { return health; },
  };
  runInNewContext(source, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.coverageResults)), {
    full:'full', missingListing:'partial', shortHistory:'partial', estimated:'estimated', unavailable:'unavailable', staleCatalog:'partial',
  });
  const binanceProxy = await readFile(new URL('../api/binance-public.js', import.meta.url), 'utf8');
  const hyperliquidProxy = await readFile(new URL('../api/hyperliquid-klines.js', import.meta.url), 'utf8');
  assert.match(binanceProxy, /interval=1d&limit=31/);
  assert.match(binanceProxy, /filter\(row => Number\(row\?\.\[6\]\) > 0 && Number\(row\[6\]\) < Date\.now\(\)\)/);
  assert.match(hyperliquidProxy, /slice\(-\(30 \* 24\)\)/);
  assert.match(html, /expectedContributions:new Set\(\)/);
  assert.match(html, /observed < expected \|\| partial > 0/);
});

test('Spot to Perpetual joins require the full verified category and underlying identity', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('function _assetCategoryFamily');
  const end = html.indexOf('function renderSpotVenueTable', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = html.slice(start, end) + `
    globalThis.bridgeResults = {
      tradeSkHynix:Boolean(_findPerpInVenue('tradexyz', {coin:'SKHX',underlyingSymbol:'SKHYNIX',category:'equity',identityVerified:true})),
      realSkhxEtf:Boolean(_findPerpInVenue('tradexyz', {coin:'SKHX',category:'etf',identityVerified:true})),
      cryptoCat:_spotPerpMatchIdentity({coin:'CAT',category:'other',officialType:'crypto'}),
      unverifiedCat:_spotPerpMatchIdentity({coin:'CAT',category:'equity'}),
      exactEtf:Boolean(_findPerpInVenue('gate', {coin:'QQQX',category:'etf',identityVerified:true})),
      verifiedWrapper:Boolean(_findPerpInVenue('gate', {coin:'QQQX',underlyingSymbol:'QQQ',category:'etf',identityVerified:true})),
    };
  `;
  const context = {
    ASSET_META:{}, KNOWN_CATEGORIES:{},
    SPOT_PERP:{
      tradexyz:{ 'equity:SKHYNIX':{ mark:100, volume:10 } },
      gate:{ 'etf:QQQ':{ mark:500, volume:20 } },
    },
    _arbUnderlyingKey(symbol) { return symbol; },
    spotAssetSecurityIdentity(asset) {
      return asset.identityVerified
        ? { symbol:asset.underlyingSymbol || asset.coin, category:asset.category }
        : null;
    },
    assetAggregationIdentity(asset) {
      const symbol = asset.underlyingSymbol || asset.coin;
      return { key:`${asset.category}:${symbol}`, symbol, category:asset.category };
    },
  };
  runInNewContext(source, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.bridgeResults)), {
    tradeSkHynix:true,
    realSkhxEtf:false,
    cryptoCat:null,
    unverifiedCat:null,
    exactEtf:false,
    verifiedWrapper:true,
  });
});

test('Spot bridge prefers a priced contract and excludes stale snapshots from opportunity ranking', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('function _buildSpotPerpFromAllData');
  const end = html.indexOf('function updateSpotStatusLine', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = html.slice(start, end) + `
    globalThis.selectedBridge = _buildSpotPerpFromAllData().gate['equity:AAPL'];
  `;
  const context = {
    allData:[
      {venue:'gate',coin:'AAPL',category:'equity',symbol:'AAPL-HIGH',markPx:null,volume:1_000,funding:0.001,dataFreshness:'live'},
      {venue:'gate',coin:'AAPL',category:'equity',symbol:'AAPL-PRICED',markPx:100,volume:10,funding:0.001,dataFreshness:'live'},
    ],
    venueHealth:{ gate:{ status:'live' } },
    EXCLUDED_SYMBOLS:new Set(),
    assetAggregationIdentity(asset) { return { key:`${asset.category}:${asset.coin}`, symbol:asset.coin, category:asset.category }; },
    fundingIntervalHours() { return 8; },
    numberOrNull(value) { return value === null || value === undefined ? null : Number(value); },
    sortableNumber(value) { return value === null || value === undefined ? -Infinity : Number(value); },
  };
  runInNewContext(source, context);
  assert.equal(context.selectedBridge.venueSymbol, 'AAPL-PRICED');
  assert.equal(context.selectedBridge.mark, 100);
  assert.equal(context.selectedBridge.dataFreshness, 'live');
  const rankStart = html.indexOf('function renderSpotArbRank');
  const rankEnd = html.indexOf('renderSpotArbRank(); // initial render', rankStart);
  const rankSource = html.slice(rankStart, rankEnd);
  assert.match(rankSource, /if \(!isFreshMarketAsset\(a, 'spot'\)\) return/);
  assert.match(rankSource, /!isFreshMarketAsset\(p, 'perp'\)/);
});

test('missing numeric fields remain unavailable through aggregation and sorting', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('function numberOrNull');
  const end = html.indexOf('function normalizePerpDataState', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = html.slice(start, end) + `
    globalThis.nullResults = {
      allMissing:sumAvailableNumbers([null, undefined, '']),
      reportedZero:sumAvailableNumbers([null, 0]),
      partialSum:sumAvailableNumbers([null, 4, '6']),
      missingMax:maxAvailablePrice([null, 0, -1]),
      observedMax:maxAvailablePrice([null, 2, 5]),
      nullSort:sortableNumber(null),
    };
    const liveRow = (volume, status = 'full') => ({venue:'gate',dataFreshness:'live',volume,fieldStatus:{volume:status}});
    globalThis.aggregateResults = {
      full:aggregateAvailableField([liveRow(1),liveRow(2)], 'volume'),
      partial:aggregateAvailableField([liveRow(1),liveRow(null,'unavailable')], 'volume'),
      estimated:aggregateAvailableField([liveRow(1,'estimated')], 'volume'),
      stale:aggregateAvailableField([{...liveRow(1),dataFreshness:'stale'}], 'volume'),
      unavailable:aggregateAvailableField([liveRow(null,'unavailable')], 'volume'),
    };
    const freshnessNow = 1_000_000;
    globalThis.freshnessResults = {
      beforeBoundary:effectiveFreshness('live',{status:'live',lastSuccessAt:freshnessNow-119_999},60_000,freshnessNow),
      atBoundary:effectiveFreshness('live',{status:'live',lastSuccessAt:freshnessNow-120_000},60_000,freshnessNow),
      explicitStale:effectiveFreshness('stale',{status:'live',lastSuccessAt:freshnessNow},60_000,freshnessNow),
      healthUnavailable:effectiveFreshness('live',{status:'unavailable',lastSuccessAt:freshnessNow},60_000,freshnessNow),
      missingTimestamp:effectiveFreshness('live',{status:'live'},60_000,freshnessNow),
      futureTimestamp:effectiveFreshness('live',{status:'live',lastSuccessAt:freshnessNow+1},60_000,freshnessNow),
    };
  `;
  const context = {
    venueHealth:{gate:{status:'live',lastSuccessAt:Date.now()}},
    spotVenueHealth:{},
    REFRESH_INTERVAL:60_000,
    SPOT_REFRESH_INTERVAL:300_000,
  };
  runInNewContext(source, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.nullResults)), {
    allMissing:null,
    reportedZero:0,
    partialSum:10,
    missingMax:null,
    observedMax:5,
    nullSort:null,
  });
  assert.equal(context.nullResults.nullSort, -Infinity);
  assert.equal(context.aggregateResults.full.status, 'full');
  assert.equal(context.aggregateResults.full.value, 3);
  assert.equal(context.aggregateResults.partial.status, 'partial');
  assert.equal(context.aggregateResults.partial.value, 1);
  assert.equal(context.aggregateResults.estimated.status, 'estimated');
  assert.equal(context.aggregateResults.stale.status, 'partial');
  assert.equal(context.aggregateResults.unavailable.status, 'unavailable');
  assert.equal(context.aggregateResults.unavailable.value, null);
  assert.deepEqual(JSON.parse(JSON.stringify(context.freshnessResults)), {
    beforeBoundary:'live',
    atBoundary:'stale',
    explicitStale:'stale',
    healthUnavailable:'unavailable',
    missingTimestamp:'unavailable',
    futureTimestamp:'unavailable',
  });
  assert.match(html, /merged\[key\]\.totalVol30d = observedContributions > 0 \? total : null/);
  assert.match(html, /\.filter\(row => row\.totalVol30d !== null\)/);
  assert.match(html, /const cryptoVolume = sumAvailableNumbers\(\[model\.perpVolume, model\.spotVolume\]\)/);
  assert.match(html, /compareNullableNumbers\(a\.volume, b\.volume, -1\)/);
  assert.match(html, /compareNullableNumbers\(a\.vol, b\.vol, -1\)/);
  const topThirtyRender = html.slice(html.indexOf('function renderTop30Volume'), html.indexOf('// TRADITIONAL MARKET + OPTIONS ACTIVITY'));
  assert.equal((topThirtyRender.match(/<tbody>\$\{rows\}<\/tbody>/g) || []).length, 1);
  assert.match(html, /const last = numberOrNull\(t\?\.c\?\.\[0\]\)/);
  assert.match(html, /last:last !== null \? 'full' : 'unavailable'/);
  assert.match(html, /change:'unavailable'/);
});

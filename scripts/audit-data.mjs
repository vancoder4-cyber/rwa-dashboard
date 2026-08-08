import { getJsonWithRetry } from './_lib/http.mjs';

const baseUrl = String(process.env.DASHBOARD_URL || 'https://avenir-rwa-analyst.vercel.app').replace(/\/$/, '');

async function getJson(path, options = {}) {
  return (await getJsonWithRetry(`${baseUrl}${path}`, options)).payload;
}

const reference = await getJson('/api/reference-prices?symbols=AAPL,XAU,SKHYNIX,MINIMAX');
const referenceRows = Object.values(reference.rows || {});
if (referenceRows.length !== 4) throw new Error(`Reference rows: expected 4, received ${referenceRows.length}`);
if (!referenceRows.some(row => row.status === 'full')) throw new Error('Reference endpoint returned no Full rows');
if (!referenceRows.some(row => row.nativeCurrency && row.nativeCurrency !== 'USD')) throw new Error('Reference endpoint did not exercise FX conversion');

const funding = await getJson('/api/funding-history?venue=binance&hours=24&symbols=AAPLUSDT,NVDAUSDT');
const fundingResults = Object.values(funding.results || {});
if (fundingResults.length !== 2) throw new Error(`Funding rows: expected 2 symbols, received ${fundingResults.length}`);
for (const result of fundingResults) {
  const cutoff = Date.now() - 24 * 3600 * 1000 - 20 * 60 * 1000;
  if ((result.rows || []).some(row => row.fundingTime < cutoff)) throw new Error('Funding endpoint leaked data outside the requested window');
  if (result.observed >= result.expected && result.status !== 'full') throw new Error('Complete funding coverage was not labeled Full');
}

const okxPerp = await getJson('/api/okx-market?type=perp-snapshot', { timeoutMs:60_000 });
const okxPerpInstruments = Array.isArray(okxPerp.instruments) ? okxPerp.instruments : [];
if (okxPerpInstruments.length < 183) throw new Error(`OKX perp catalog regressed below 183 listings: ${okxPerpInstruments.length}`);
const okxPerpIds = new Set(okxPerpInstruments.map(row => row.instId));
if (okxPerpIds.size !== okxPerpInstruments.length) throw new Error('OKX perp catalog contains duplicate instrument IDs');
for (const row of okxPerpInstruments) {
  const validProduct = row.instType === 'SWAP' || (row.instType === 'FUTURES' && row.ruleType === 'xperp');
  if (row.state !== 'live' || !['3','4','5','6'].includes(String(row.instCategory)) || !validProduct) {
    throw new Error(`OKX non-RWA or non-perpetual product leaked into catalog: ${row.instId}`);
  }
}
const okxXPerps = okxPerpInstruments.filter(row => row.instType === 'FUTURES' && row.ruleType === 'xperp');
if (okxXPerps.length < 34 || !okxXPerps.some(row => String(row.instId).includes('_XPERP-'))) {
  throw new Error(`OKX X-Perp coverage regressed: ${okxXPerps.length}`);
}
const okxAaplContracts = okxPerpInstruments.filter(row => row.canonicalSymbol === 'AAPL');
if (okxAaplContracts.length < 2) throw new Error('OKX AAPL SWAP/X-Perp variants were collapsed');
for (const field of ['tickers','marks','openInterest','funding']) {
  const ids = new Set((okxPerp[field] || []).map(row => row.instId));
  if (okxAaplContracts.some(row => !ids.has(row.instId))) throw new Error(`OKX AAPL ${field} coverage is incomplete`);
}

const okxSpot = await getJson('/api/okx-market?type=spot-snapshot', { timeoutMs:30_000 });
const okxSpotInstruments = Array.isArray(okxSpot.instruments) ? okxSpot.instruments : [];
if (okxSpotInstruments.length < 51) throw new Error(`OKX spot catalog regressed below 51 listings: ${okxSpotInstruments.length}`);
const exactOkxGold = new Set(['PAXG-USD','PAXG-USDT','XAUT-USDT']);
for (const row of okxSpotInstruments) {
  const isUts = row.state === 'live' && row.instType === 'SPOT' && String(row.instCategory) === '3' && row.quoteCcy === 'USDT';
  const isGold = exactOkxGold.has(row.instId);
  if (!isUts && !isGold) throw new Error(`OKX crypto spot leaked into RWA catalog: ${row.instId}`);
}
if (okxSpotInstruments.some(row => ['XRP-USDT','XLM-USDT','CAT-USDT','LIT-USDT'].includes(row.instId))) {
  throw new Error('OKX same-ticker crypto collision entered the spot catalog');
}
if (new Set(okxSpotInstruments.map(row => row.canonicalSymbol)).size < 50) {
  throw new Error('OKX spot canonical coverage regressed below 50 assets');
}

const traditional = await getJson('/api/tradfi-activity?limit=100', { timeoutMs:55_000 });
const traditionalRows = Array.isArray(traditional.rows) ? traditional.rows : [];
if (!traditionalRows.length || traditionalRows.length > 100) throw new Error(`Traditional rows: expected 1-100, received ${traditionalRows.length}`);
if (Number(traditional.methodology?.directoryUniverse) < 5000) throw new Error('Traditional directory universe is unexpectedly small');
if (!String(traditional.scope || '').includes('before any crypto coverage')) throw new Error('Traditional API no longer declares market-first scope');
if (traditional.methodology?.rankingCompleteness !== 'official-candidate-set') {
  throw new Error('Traditional API does not disclose candidate-set ranking scope');
}
const alignment = traditional.methodology?.alignment || {};
const currentAlignmentCounts = [
  alignment.requestedCandidateCount,
  alignment.eligibleCandidateCount,
  alignment.alignedCandidateCount,
  alignment.ineligibleCandidateCount,
  alignment.droppedCandidateCount,
].map(Number);
if (currentAlignmentCounts.some(value => !Number.isInteger(value) || value < 0)) {
  throw new Error('Traditional current-session alignment counts are invalid');
}
if (Number(alignment.requestedCandidateCount) !== Number(traditional.methodology?.candidateCount)) {
  throw new Error('Traditional alignment denominator does not match candidate count');
}
if (Number(alignment.requestedCandidateCount) !== Number(alignment.eligibleCandidateCount) + Number(alignment.ineligibleCandidateCount)) {
  throw new Error('Traditional eligible and ineligible candidate counts do not reconcile');
}
const rankableCandidateCount = Number(traditional.methodology?.rankableCandidateCount);
if (!Number.isInteger(rankableCandidateCount) || rankableCandidateCount < 100) {
  throw new Error(`Traditional candidate set cannot support Top 100: ${rankableCandidateCount} rankable rows`);
}
const expectedTraditionalRows = 100;
if (traditionalRows.length !== expectedTraditionalRows) {
  throw new Error(`Traditional rows: expected ${expectedTraditionalRows} rankable rows, received ${traditionalRows.length}`);
}
if (Number(alignment.ratio) !== 1 || Number(alignment.droppedCandidateCount) !== 0 || Number(alignment.alignedCandidateCount) < traditionalRows.length) {
  throw new Error('Traditional same-session alignment coverage is insufficient');
}
const rankingSession = String(traditional.methodology?.rankingSession || '');
const optionsSession = String(traditional.sources?.options?.asOf || '');
const expectedRankingSession = /^\d{8}$/.test(optionsSession)
  ? `${optionsSession.slice(0, 4)}-${optionsSession.slice(4, 6)}-${optionsSession.slice(6, 8)}`
  : '';
if (!rankingSession || rankingSession !== expectedRankingSession) throw new Error('Traditional market and options sessions are not aligned');
const comparisonSession = String(traditional.methodology?.comparisonSession || '');
const previousOptionsSession = String(traditional.sources?.options?.previousAsOf || '');
const expectedComparisonSession = /^\d{8}$/.test(previousOptionsSession)
  ? `${previousOptionsSession.slice(0, 4)}-${previousOptionsSession.slice(4, 6)}-${previousOptionsSession.slice(6, 8)}`
  : '';
if (!comparisonSession || comparisonSession !== expectedComparisonSession || comparisonSession >= rankingSession) {
  throw new Error('Traditional daily-rank comparison session is not aligned to the previous OCC report');
}
const rankComparison = traditional.methodology?.rankComparison || {};
const comparisonAlignment = rankComparison.alignment || {};
const comparisonAlignmentCounts = [
  comparisonAlignment.requestedCandidateCount,
  comparisonAlignment.eligibleCandidateCount,
  comparisonAlignment.alignedCandidateCount,
  comparisonAlignment.ineligibleCandidateCount,
  comparisonAlignment.droppedCandidateCount,
].map(Number);
if (comparisonAlignmentCounts.some(value => !Number.isInteger(value) || value < 0)) {
  throw new Error('Traditional previous-session comparison counts are invalid');
}
if (Number(comparisonAlignment.requestedCandidateCount) !== Number(traditional.methodology?.candidateCount) ||
    Number(comparisonAlignment.requestedCandidateCount) !== Number(comparisonAlignment.eligibleCandidateCount) + Number(comparisonAlignment.ineligibleCandidateCount) ||
    Number(comparisonAlignment.alignedCandidateCount) !== Number(comparisonAlignment.eligibleCandidateCount)) {
  throw new Error('Traditional previous-session comparison counts do not reconcile');
}
if (rankComparison.status !== 'full' || Number(comparisonAlignment.ratio) !== 1 || Number(comparisonAlignment.droppedCandidateCount) !== 0) {
  throw new Error('Traditional previous-session rank comparison coverage is insufficient');
}
const traditionalSymbols = traditionalRows.map(row => row.symbol);
if (new Set(traditionalSymbols).size !== traditionalSymbols.length) throw new Error('Traditional ranking contains duplicate symbols');
traditionalRows.forEach((row, index) => {
  if (row.rank !== index + 1) throw new Error(`Traditional rank discontinuity at ${row.symbol}`);
  if (!['equity', 'etf'].includes(row.category)) throw new Error(`Traditional row has invalid category: ${row.symbol}`);
  if (row.market?.sessionDate !== rankingSession) throw new Error(`Traditional share session mismatch for ${row.symbol}`);
  const expectedTotal = Number(row.market?.estimatedValue || 0) + Number(row.options?.estimatedNotional || 0);
  const tolerance = Math.max(0.01, Math.abs(expectedTotal) * 1e-10);
  if (Math.abs(Number(row.traditionalTotalValue) - expectedTotal) > tolerance) {
    throw new Error(`Traditional total notional drifted for ${row.symbol}`);
  }
  const previousMarketAligned = row.previousMarket?.sessionDate === comparisonSession;
  if (previousMarketAligned) {
    const previousVolume = Number(row.previousMarket?.volume);
    const previousPrice = Number(row.previousMarket?.lastPrice);
    const previousOptionsVolume = Number(row.previousOptionsVolume);
    if (!Number.isFinite(previousVolume) || previousVolume < 0 || !(previousPrice > 0) ||
        !Number.isInteger(previousOptionsVolume) || previousOptionsVolume < 0) {
      throw new Error(`Traditional previous-session inputs are invalid for ${row.symbol}`);
    }
    const expectedPreviousMarketValue = previousVolume * previousPrice;
    const expectedPreviousOptionsNotional = previousOptionsVolume * 100 * previousPrice;
    const expectedPreviousTotal = expectedPreviousMarketValue + expectedPreviousOptionsNotional;
    const previousTolerance = Math.max(0.01, Math.abs(expectedPreviousTotal) * 1e-10);
    if (Math.abs(Number(row.previousMarket?.estimatedValue) - expectedPreviousMarketValue) > previousTolerance ||
        Math.abs(Number(row.previousOptionsNotional) - expectedPreviousOptionsNotional) > previousTolerance ||
        Math.abs(Number(row.previousTraditionalTotalValue) - expectedPreviousTotal) > previousTolerance) {
      throw new Error(`Traditional previous-session notional drifted for ${row.symbol}`);
    }
  } else {
    if (row.previousMarket?.sessionEligibility !== 'ineligible' || row.previousMarket?.estimatedValue !== null ||
        row.previousOptionsNotional !== null || Number(row.previousTraditionalTotalValue) !== 0) {
      throw new Error(`Traditional previous-session exclusion semantics drifted for ${row.symbol}`);
    }
  }
  const rankChange = row.rankChange || {};
  if (!['up', 'down', 'flat', 'new', 'unavailable'].includes(rankChange.status)) {
    throw new Error(`Traditional rank-change status is invalid for ${row.symbol}`);
  }
  if (rankChange.previousRank !== row.previousRank) throw new Error(`Traditional previous-rank fields disagree for ${row.symbol}`);
  if (rankChange.status === 'unavailable') throw new Error(`Traditional rank change is unavailable for ${row.symbol}`);
  if (rankChange.status === 'new') {
    const validNewPreviousRank = row.previousRank === null ||
      (Number.isInteger(row.previousRank) && row.previousRank > 100);
    if (!validNewPreviousRank) {
      throw new Error(`Traditional NEW row was inside the previous Top 100: ${row.symbol}`);
    }
    if (rankChange.delta !== null) throw new Error(`Traditional NEW row has a numeric delta: ${row.symbol}`);
  } else {
    if (!Number.isInteger(row.previousRank) || row.previousRank <= 0) throw new Error(`Traditional movement lacks a previous rank: ${row.symbol}`);
    const expectedDelta = Number(row.previousRank) - Number(row.rank);
    if (!Number.isInteger(rankChange.delta)) throw new Error(`Traditional rank delta is not an integer for ${row.symbol}`);
    if (Number(rankChange.delta) !== expectedDelta) throw new Error(`Traditional rank delta drifted for ${row.symbol}`);
    const expectedStatus = expectedDelta > 0 ? 'up' : expectedDelta < 0 ? 'down' : 'flat';
    if (rankChange.status !== expectedStatus) throw new Error(`Traditional rank direction drifted for ${row.symbol}`);
  }
  if (Number.isInteger(row.previousRank) && row.previousRank > 0 && !previousMarketAligned) {
    throw new Error(`Traditional previous rank is not tied to the comparison session for ${row.symbol}`);
  }
  if (index > 0) {
    const previous = traditionalRows[index - 1];
    if (Number(previous.traditionalTotalValue) < Number(row.traditionalTotalValue)) {
      throw new Error(`Traditional ranking is not descending at ${row.symbol}`);
    }
  }
});

const quoteSymbols = traditionalRows.map(row => row.symbol);
const quoteEtfs = traditionalRows.filter(row => row.category === 'etf').map(row => row.symbol);
const traditionalPrices = await getJson(
  `/api/tradfi-prices?symbols=${quoteSymbols.join(',')}&etfs=${quoteEtfs.join(',')}`,
  { timeoutMs:55_000 },
);
const traditionalQuoteRows = Array.isArray(traditionalPrices.rows) ? traditionalPrices.rows : [];
if (traditionalQuoteRows.length !== quoteSymbols.length) throw new Error('Traditional quote endpoint returned the wrong row count');
const returnedQuoteSymbols = traditionalQuoteRows.map(row => row.symbol);
if (new Set(returnedQuoteSymbols).size !== returnedQuoteSymbols.length ||
    quoteSymbols.some(symbol => !returnedQuoteSymbols.includes(symbol))) {
  throw new Error('Traditional quote endpoint returned duplicate or mismatched symbols');
}
if (traditionalQuoteRows.slice(0, 6).some(row => row.status !== 'full' || !(Number(row.price) > 0))) {
  throw new Error('Traditional quote endpoint returned an unavailable or non-positive price');
}

console.log(JSON.stringify({
  baseUrl,
  references: referenceRows.map(row => ({ status: row.status, source: row.source, currency: row.nativeCurrency, session: row.session })),
  funding: fundingResults.map(row => ({ status: row.status, observed: row.observed, firstAt: row.firstAt, lastAt: row.lastAt })),
  okx: {
    perpListings: okxPerpInstruments.length,
    xPerps: okxXPerps.length,
    canonicalPerpAssets: new Set(okxPerpInstruments.map(row => row.canonicalSymbol)).size,
    spotListings: okxSpotInstruments.length,
    canonicalSpotAssets: new Set(okxSpotInstruments.map(row => row.canonicalSymbol)).size,
    coverage: { perp:okxPerp.coverage, spot:okxSpot.coverage },
  },
  traditional: {
    scope: traditional.scope,
    rankingSession,
    comparisonSession,
    rankComparison,
    directoryUniverse: traditional.methodology.directoryUniverse,
    candidates: traditional.methodology.candidateCount,
    alignment,
    rows: traditionalRows.length,
    fullQuotes: traditionalQuoteRows.filter(row => row.status === 'full').length,
    rankMovements: traditionalRows.reduce((counts, row) => {
      counts[row.rankChange.status] = (counts[row.rankChange.status] || 0) + 1;
      return counts;
    }, {}),
    top: traditionalRows.slice(0, 5).map(row => ({
      rank: row.rank,
      symbol: row.symbol,
      category: row.category,
      totalNotional: row.traditionalTotalValue,
    })),
  },
}, null, 2));

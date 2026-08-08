import { getJsonWithRetry } from './_lib/http.mjs';

const baseUrl = String(process.env.DASHBOARD_URL || 'https://avenir-rwa-analyst.vercel.app').replace(/\/$/, '');

async function getJson(path) {
  return (await getJsonWithRetry(`${baseUrl}${path}`)).payload;
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

const traditional = await getJson('/api/tradfi-activity?limit=30');
const traditionalRows = Array.isArray(traditional.rows) ? traditional.rows : [];
if (!traditionalRows.length || traditionalRows.length > 30) throw new Error(`Traditional rows: expected 1-30, received ${traditionalRows.length}`);
if (Number(traditional.methodology?.directoryUniverse) < 5000) throw new Error('Traditional directory universe is unexpectedly small');
if (!String(traditional.scope || '').includes('before any crypto coverage')) throw new Error('Traditional API no longer declares market-first scope');
if (traditional.methodology?.rankingCompleteness !== 'official-candidate-set') {
  throw new Error('Traditional API does not disclose candidate-set ranking scope');
}
const alignment = traditional.methodology?.alignment || {};
if (Number(alignment.requestedCandidateCount) !== Number(traditional.methodology?.candidateCount)) {
  throw new Error('Traditional alignment denominator does not match candidate count');
}
if (Number(alignment.requestedCandidateCount) !== Number(alignment.eligibleCandidateCount) + Number(alignment.ineligibleCandidateCount)) {
  throw new Error('Traditional eligible and ineligible candidate counts do not reconcile');
}
const expectedTraditionalRows = Math.min(30, Number(alignment.eligibleCandidateCount));
if (traditionalRows.length !== expectedTraditionalRows) {
  throw new Error(`Traditional rows: expected ${expectedTraditionalRows} eligible rows, received ${traditionalRows.length}`);
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
});

const quoteSymbols = traditionalRows.slice(0, 6).map(row => row.symbol);
const quoteEtfs = traditionalRows.slice(0, 6).filter(row => row.category === 'etf').map(row => row.symbol);
const traditionalPrices = await getJson(`/api/tradfi-prices?symbols=${quoteSymbols.join(',')}&etfs=${quoteEtfs.join(',')}`);
const traditionalQuoteRows = Array.isArray(traditionalPrices.rows) ? traditionalPrices.rows : [];
if (traditionalQuoteRows.length !== quoteSymbols.length) throw new Error('Traditional quote endpoint returned the wrong row count');
if (traditionalQuoteRows.some(row => row.status !== 'full' || !(Number(row.price) > 0))) {
  throw new Error('Traditional quote endpoint returned an unavailable or non-positive price');
}

console.log(JSON.stringify({
  baseUrl,
  references: referenceRows.map(row => ({ status: row.status, source: row.source, currency: row.nativeCurrency, session: row.session })),
  funding: fundingResults.map(row => ({ status: row.status, observed: row.observed, firstAt: row.firstAt, lastAt: row.lastAt })),
  traditional: {
    scope: traditional.scope,
    rankingSession,
    directoryUniverse: traditional.methodology.directoryUniverse,
    candidates: traditional.methodology.candidateCount,
    alignment,
    rows: traditionalRows.length,
    fullQuotes: traditionalQuoteRows.filter(row => row.status === 'full').length,
    top: traditionalRows.slice(0, 5).map(row => ({
      rank: row.rank,
      symbol: row.symbol,
      category: row.category,
      totalNotional: row.traditionalTotalValue,
    })),
  },
}, null, 2));

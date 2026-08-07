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

console.log(JSON.stringify({
  baseUrl,
  references: referenceRows.map(row => ({ status: row.status, source: row.source, currency: row.nativeCurrency, session: row.session })),
  funding: fundingResults.map(row => ({ status: row.status, observed: row.observed, firstAt: row.firstAt, lastAt: row.lastAt })),
}, null, 2));

import { assessChecks, checkResult, PRODUCTION_BASELINES } from './_lib/health.js';
import { fetchJsonWithPolicy, fetchWithPolicy, mapWithConcurrency } from './_lib/upstream.js';

export const config = { regions: ['sin1'], maxDuration: 30 };

const REFERENCE_SYMBOLS = ['AAPL', 'XAU', 'SKHYNIX', 'MINIMAX'];
const FUNDING_PROBES = Object.freeze({
  tradexyz: 'xyz:AAPL',
  bitget: 'AAPLUSDT',
  gate: 'AAPLX_USDT',
  binance: 'AAPLUSDT',
});

function deploymentBaseUrl(req) {
  const forwarded = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').toLowerCase();
  if (/^[a-z0-9.-]+\.vercel\.app$/.test(forwarded)) return `https://${forwarded}`;
  const deployment = process.env.VERCEL_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return `https://${deployment || 'avenir-rwa-analyst.vercel.app'}`;
}

async function probePage(baseUrl) {
  const startedAt = Date.now();
  try {
    const response = await fetchWithPolicy(`${baseUrl}/`, { method: 'HEAD' }, { timeoutMs: 5000, retries: 1 });
    const valid = response.ok && String(response.headers.get('content-type') || '').includes('text/html');
    return checkResult('production-page', valid ? 'pass' : 'fail', {
      latencyMs: Date.now() - startedAt,
      httpStatus: response.status,
      reason: valid ? null : 'Dashboard shell did not return HTML',
    }, { critical: true });
  } catch (error) {
    return checkResult('production-page', 'fail', { latencyMs: Date.now() - startedAt, reason: error.message }, { critical: true });
  }
}

async function probeReferences(baseUrl) {
  const startedAt = Date.now();
  try {
    const payload = await fetchJsonWithPolicy(
      `${baseUrl}/api/reference-prices?symbols=${REFERENCE_SYMBOLS.join(',')}`,
      {},
      { timeoutMs: 20000, retries: 1 },
    );
    const rows = Object.values(payload?.rows || {});
    const unavailable = rows.filter(row => row.status === 'unavailable').length;
    const fxConverted = rows.filter(row => row.nativeCurrency && row.nativeCurrency !== 'USD' && row.currency === 'USD').length;
    const valid = rows.length === REFERENCE_SYMBOLS.length && unavailable === 0 && fxConverted >= 2;
    return checkResult('reference-prices', valid ? 'pass' : 'fail', {
      latencyMs: Date.now() - startedAt,
      requested: REFERENCE_SYMBOLS.length,
      returned: rows.length,
      full: rows.filter(row => row.status === 'full').length,
      estimated: rows.filter(row => row.status === 'estimated').length,
      unavailable,
      fxConverted,
      reason: valid ? null : 'Reference coverage or FX conversion is incomplete',
    }, { critical: true });
  } catch (error) {
    return checkResult('reference-prices', 'fail', { latencyMs: Date.now() - startedAt, reason: error.message }, { critical: true });
  }
}

async function probeFunding(baseUrl, venue, symbol) {
  const startedAt = Date.now();
  try {
    const payload = await fetchJsonWithPolicy(
      `${baseUrl}/api/funding-history?venue=${venue}&hours=24&symbols=${encodeURIComponent(symbol)}`,
      {},
      { timeoutMs: 20000, retries: 1 },
    );
    const row = payload?.results?.[symbol];
    const cutoff = Date.now() - 24 * 3600_000 - 20 * 60_000;
    const leaked = (row?.rows || []).some(item => Number(item.fundingTime) < cutoff);
    const valid = Number(row?.observed) >= 2 && !leaked;
    return checkResult(`funding-${venue}`, valid ? 'pass' : 'warn', {
      latencyMs: Date.now() - startedAt,
      symbol,
      coverageStatus: row?.status || 'unavailable',
      observed: row?.observed || 0,
      expected: row?.expected || null,
      leakedOutsideWindow: leaked,
      reason: valid ? null : row?.error || row?.reason || 'Insufficient 24h funding observations',
    });
  } catch (error) {
    return checkResult(`funding-${venue}`, 'warn', { latencyMs: Date.now() - startedAt, symbol, reason: error.message });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const baseUrl = deploymentBaseUrl(req);
  // Keep self-probes bounded. Fanning six sibling Function calls out at once
  // can create a false outage signal during cold starts or regional scaling.
  const checks = [await probePage(baseUrl), await probeReferences(baseUrl)];
  const fundingChecks = await mapWithConcurrency(Object.entries(FUNDING_PROBES), 2,
    ([venue, symbol]) => probeFunding(baseUrl, venue, symbol));
  checks.push(...fundingChecks);
  const assessment = assessChecks(checks);
  const payload = {
    service: 'avenir-rwa-analyst',
    environment: process.env.VERCEL_ENV || 'unknown',
    deployment: process.env.VERCEL_URL || null,
    commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    generatedAt: new Date().toISOString(),
    ...assessment,
    baselines: PRODUCTION_BASELINES,
    checks,
  };

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-RWA-Health-Status', assessment.status);
  const summary = { status: assessment.status, counts: assessment.counts, commit: payload.commit };
  if (assessment.status === 'unhealthy') console.error('[rwa-health]', JSON.stringify(summary));
  else console.log('[rwa-health]', JSON.stringify(summary));
  return res.status(assessment.status === 'unhealthy' ? 503 : 200).json(payload);
}

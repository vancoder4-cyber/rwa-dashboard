import { assessChecks, checkResult, PRODUCTION_BASELINES } from './_lib/health.js';
import {
  OKX_SPOT_GOLD_EXCEPTIONS,
  canonicalOkxPerpSymbol,
  canonicalOkxSpotSymbol,
  isOkxRwaPerpInstrument,
  isOkxRwaSpotInstrument,
} from './_lib/okx.js';
import { validateUsMarketDirectoryPayload } from './_lib/us-market-directory.js';
import { fetchJsonWithPolicy, fetchWithPolicy, mapWithConcurrency } from './_lib/upstream.js';

export const config = { regions: ['sin1'], maxDuration: 60 };

const REFERENCE_SYMBOLS = ['AAPL', 'XAU', 'SKHYNIX', 'MINIMAX'];
const FUNDING_PROBES = Object.freeze({
  tradexyz: 'xyz:AAPL',
  bitget: 'AAPLUSDT',
  gate: 'AAPLX_USDT',
  binance: 'AAPLUSDT',
  okx: 'AAPL-USDT-SWAP',
});
const OKX_EXPECTED_PERP_SPLIT = Object.freeze({ swap: 149, xperp: 34 });
const OKX_EXPECTED_SPOT_SPLIT = Object.freeze({ uts: 48, gold: 3 });

function deploymentBaseUrl(req) {
  const forwarded = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').toLowerCase();
  if (/^[a-z0-9.-]+\.vercel\.app$/.test(forwarded)) return `https://${forwarded}`;
  const deployment = process.env.VERCEL_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return `https://${deployment || 'avenir-rwa-analyst.vercel.app'}`;
}

async function probePage(baseUrl) {
  const startedAt = Date.now();
  try {
    const response = await fetchWithPolicy(`${baseUrl}/`, { method: 'HEAD' }, { timeoutMs: 5000, retries: 0 });
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
      { timeoutMs: 20000, retries: 0 },
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

export function validateUsMarketDirectory(payload) {
  return validateUsMarketDirectoryPayload(payload);
}

export async function probeUsMarketDirectory(baseUrl) {
  const startedAt = Date.now();
  try {
    const payload = await fetchJsonWithPolicy(
      `${baseUrl}/api/us-market-directory`,
      {},
      { timeoutMs:25_000, retries:0 },
    );
    const validation = validateUsMarketDirectory(payload);
    return checkResult('us-market-directory', validation.valid ? 'pass' : 'fail', {
      latencyMs:Date.now() - startedAt,
      asOf:payload?.asOf || null,
      ...validation,
    }, { critical:true });
  } catch (error) {
    return checkResult('us-market-directory', 'fail', {
      latencyMs:Date.now() - startedAt,
      reason:error.message,
    }, { critical:true });
  }
}

async function probeFunding(baseUrl, venue, symbol) {
  const startedAt = Date.now();
  try {
    const payload = await fetchJsonWithPolicy(
      `${baseUrl}/api/funding-history?venue=${venue}&hours=24&symbols=${encodeURIComponent(symbol)}`,
      {},
      { timeoutMs: 20000, retries: 0 },
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

function normalized(value) {
  return String(value ?? '').trim();
}

function normalizedUpper(value) {
  return normalized(value).toUpperCase();
}

function summarizeResourceCoverage(rows, expectedIds, declared) {
  const values = Array.isArray(rows) ? rows : [];
  const ids = values.map(row => normalizedUpper(row?.instId)).filter(Boolean);
  const uniqueIds = new Set(ids);
  const duplicateCount = ids.length - uniqueIds.size;
  const missingIds = [...expectedIds].filter(instId => !uniqueIds.has(instId));
  const unexpectedIds = [...uniqueIds].filter(instId => !expectedIds.has(instId));
  const declaredFull = normalized(declared?.status).toLowerCase() === 'full' &&
    Number(declared?.observed) === expectedIds.size &&
    Number(declared?.expected) === expectedIds.size;
  return {
    valid: declaredFull && duplicateCount === 0 && missingIds.length === 0 &&
      unexpectedIds.length === 0 && values.length === expectedIds.size,
    observed: values.length,
    expected: expectedIds.size,
    duplicateCount,
    missingCount: missingIds.length,
    unexpectedCount: unexpectedIds.length,
    missingSample: missingIds.slice(0, 5),
    unexpectedSample: unexpectedIds.slice(0, 5),
    declaredStatus: normalized(declared?.status).toLowerCase() || 'unavailable',
  };
}

function okxPerpIdentity(instrument) {
  const canonical = canonicalOkxPerpSymbol(instrument);
  return isOkxRwaPerpInstrument(instrument) && canonical !== null &&
    normalizedUpper(instrument?.canonicalSymbol) === canonical;
}

function okxSpotIdentity(instrument) {
  const canonical = canonicalOkxSpotSymbol(instrument);
  return isOkxRwaSpotInstrument(instrument) && canonical !== null &&
    normalizedUpper(instrument?.canonicalSymbol) === canonical;
}

function validationReason(issues) {
  return issues.length ? issues.join('; ') : null;
}

export function validateOkxPerpSnapshot(payload) {
  const instruments = Array.isArray(payload?.instruments) ? payload.instruments : [];
  const instIds = instruments.map(row => normalizedUpper(row?.instId)).filter(Boolean);
  const uniqueIds = new Set(instIds);
  const duplicateCount = instIds.length - uniqueIds.size;
  const invalidIdentityIds = instruments
    .filter(row => !okxPerpIdentity(row))
    .map(row => normalizedUpper(row?.instId) || '(missing instId)');
  const swapListings = instruments.filter(row => normalizedUpper(row?.instType) === 'SWAP').length;
  const xPerpListings = instruments.filter(row =>
    normalizedUpper(row?.instType) === 'FUTURES' &&
    normalized(row?.ruleType).toLowerCase() === 'xperp'
  ).length;
  const expectedListings = PRODUCTION_BASELINES.perpetuals.okx;
  const tickerCoverage = summarizeResourceCoverage(payload?.tickers, uniqueIds, payload?.coverage?.tickers);
  const markCoverage = summarizeResourceCoverage(payload?.marks, uniqueIds, payload?.coverage?.marks);
  const openInterestCoverage = summarizeResourceCoverage(
    payload?.openInterest,
    uniqueIds,
    payload?.coverage?.openInterest,
  );
  const identityValid = invalidIdentityIds.length === 0 && duplicateCount === 0;
  const countValid = instruments.length === expectedListings && uniqueIds.size === expectedListings &&
    swapListings === OKX_EXPECTED_PERP_SPLIT.swap &&
    xPerpListings === OKX_EXPECTED_PERP_SPLIT.xperp;
  const marketCoverageValid = tickerCoverage.valid && markCoverage.valid && openInterestCoverage.valid;
  const issues = [];
  if (!identityValid) issues.push(`identity rejected ${invalidIdentityIds.length} rows; duplicates ${duplicateCount}`);
  if (!countValid) {
    issues.push(`expected ${expectedListings} listings (${OKX_EXPECTED_PERP_SPLIT.swap} SWAP + ${OKX_EXPECTED_PERP_SPLIT.xperp} X-Perp), got ${instruments.length} (${swapListings} + ${xPerpListings})`);
  }
  if (!marketCoverageValid) issues.push('ticker, mark, or open-interest coverage is not a complete catalog join');
  return {
    valid: identityValid && countValid && marketCoverageValid,
    identityValid,
    countValid,
    marketCoverageValid,
    expectedListings,
    listingCount: instruments.length,
    uniqueListingCount: uniqueIds.size,
    swapListings,
    xPerpListings,
    duplicateCount,
    invalidIdentityCount: invalidIdentityIds.length,
    invalidIdentitySample: invalidIdentityIds.slice(0, 5),
    coverage: { tickers: tickerCoverage, marks: markCoverage, openInterest: openInterestCoverage },
    reason: validationReason(issues),
  };
}

export function validateOkxSpotSnapshot(payload) {
  const instruments = Array.isArray(payload?.instruments) ? payload.instruments : [];
  const instIds = instruments.map(row => normalizedUpper(row?.instId)).filter(Boolean);
  const uniqueIds = new Set(instIds);
  const duplicateCount = instIds.length - uniqueIds.size;
  const invalidIdentityIds = instruments
    .filter(row => !okxSpotIdentity(row))
    .map(row => normalizedUpper(row?.instId) || '(missing instId)');
  const utsListings = instruments.filter(row => normalized(row?.instCategory) === '3').length;
  const goldIds = new Set(instruments
    .filter(row => normalized(row?.instCategory) === '1' && OKX_SPOT_GOLD_EXCEPTIONS[normalizedUpper(row?.instId)])
    .map(row => normalizedUpper(row?.instId)));
  const expectedListings = PRODUCTION_BASELINES.spot.okx;
  const tickerCoverage = summarizeResourceCoverage(payload?.tickers, uniqueIds, payload?.coverage?.tickers);
  const identityValid = invalidIdentityIds.length === 0 && duplicateCount === 0;
  const countValid = instruments.length === expectedListings && uniqueIds.size === expectedListings &&
    utsListings === OKX_EXPECTED_SPOT_SPLIT.uts &&
    goldIds.size === OKX_EXPECTED_SPOT_SPLIT.gold &&
    Object.keys(OKX_SPOT_GOLD_EXCEPTIONS).every(instId => goldIds.has(instId));
  const marketCoverageValid = tickerCoverage.valid;
  const issues = [];
  if (!identityValid) issues.push(`identity rejected ${invalidIdentityIds.length} rows; duplicates ${duplicateCount}`);
  if (!countValid) {
    issues.push(`expected ${expectedListings} listings (${OKX_EXPECTED_SPOT_SPLIT.uts} UTS + ${OKX_EXPECTED_SPOT_SPLIT.gold} gold), got ${instruments.length} (${utsListings} + ${goldIds.size})`);
  }
  if (!marketCoverageValid) issues.push('ticker coverage is not a complete catalog join');
  return {
    valid: identityValid && countValid && marketCoverageValid,
    identityValid,
    countValid,
    marketCoverageValid,
    expectedListings,
    listingCount: instruments.length,
    uniqueListingCount: uniqueIds.size,
    utsListings,
    goldListings: goldIds.size,
    duplicateCount,
    invalidIdentityCount: invalidIdentityIds.length,
    invalidIdentitySample: invalidIdentityIds.slice(0, 5),
    coverage: { tickers: tickerCoverage },
    reason: validationReason(issues),
  };
}

export async function probeOkxMarkets(baseUrl) {
  const definitions = [
    ['perp', 'perp-snapshot', validateOkxPerpSnapshot],
    ['spot', 'spot-snapshot', validateOkxSpotSnapshot],
  ];
  const checks = [];
  // These self-probes deliberately run one at a time. Each route already uses
  // bulk OKX resources, so retrying or fanning them out would amplify a cold start.
  for (const [market, type, validate] of definitions) {
    const startedAt = Date.now();
    try {
      const payload = await fetchJsonWithPolicy(
        `${baseUrl}/api/okx-market?type=${type}`,
        {},
        { timeoutMs: 10_000, retries: 0 },
      );
      const validation = validate(payload);
      checks.push(checkResult(`okx-${market}-market`, validation.valid ? 'pass' : 'fail', {
        latencyMs: Date.now() - startedAt,
        ...validation,
      }, { critical: !validation.identityValid }));
    } catch (error) {
      checks.push(checkResult(`okx-${market}-market`, 'warn', {
        latencyMs: Date.now() - startedAt,
        reason: error.message,
      }));
    }
  }
  return checks;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const baseUrl = deploymentBaseUrl(req);
  // Each sibling route owns its upstream retry policy, so the health layer
  // never retries a full route again. Four-way bounded concurrency keeps the
  // worst-case self-probe wall time within this Function's 60-second budget;
  // the two OKX snapshots remain one sequential job.
  const checks = [await probePage(baseUrl)];
  const probeJobs = [
    () => probeReferences(baseUrl),
    () => probeUsMarketDirectory(baseUrl),
    () => probeOkxMarkets(baseUrl),
    ...Object.entries(FUNDING_PROBES).map(([venue, symbol]) =>
      () => probeFunding(baseUrl, venue, symbol)),
  ];
  const groupedChecks = await mapWithConcurrency(probeJobs, 4, job => job());
  checks.push(...groupedChecks.flat());
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

import {
  NASDAQ_DIRECTORY_DEFINITIONS_URL,
  NASDAQ_LISTED_URL,
  OTHER_LISTED_URL,
  US_MARKET_DIRECTORY_MAX_SOURCE_AGE_MS,
  fetchUsListedDirectory,
  parseNasdaqTraderAsOf,
  validateUsMarketDirectoryPayload,
} from './_lib/us-market-directory.js';
import { setNoStore, setPublicCache } from './_lib/upstream.js';

export const US_MARKET_DIRECTORY_SCHEMA_VERSION = 1;
export const config = { regions:['sin1'], maxDuration:30 };

export function usMarketDirectoryCachePolicy(validUntilMs, nowMs = Date.now()) {
  const remainingSeconds = Math.max(0, Math.floor((Number(validUntilMs) - nowMs) / 1000));
  if (remainingSeconds < 1) return null;
  const maxAge = Math.min(3600, remainingSeconds);
  return {
    maxAge,
    staleWhileRevalidate:Math.min(21600, Math.max(0, remainingSeconds - maxAge)),
  };
}

export function compactUsMarketDirectory(directory, nowMs = Date.now()) {
  const rows = [...directory.bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  const exchangeCounts = {};
  rows.forEach(row => {
    const exchange = String(row.exchange || 'UNKNOWN');
    exchangeCounts[exchange] = (exchangeCounts[exchange] || 0) + 1;
  });
  const sourceEpochs = Object.fromEntries(
    Object.entries(directory.sourceAsOf || {}).map(([key, value]) => [key, parseNasdaqTraderAsOf(value)]),
  );
  const sourceTimes = Object.values(sourceEpochs).filter(Number.isFinite);
  const oldestSourceMs = sourceTimes.length === 2 ? Math.min(...sourceTimes) : null;
  const newestSourceMs = sourceTimes.length === 2 ? Math.max(...sourceTimes) : null;
  return {
    schemaVersion:US_MARKET_DIRECTORY_SCHEMA_VERSION,
    status:'full',
    generatedAt:new Date(nowMs).toISOString(),
    asOf:directory.asOf,
    sourceAsOf:directory.sourceAsOf || null,
    freshness:{
      sourceEpochs,
      oldestSourceMs,
      newestSourceMs,
      validUntilMs:oldestSourceMs === null ? null : oldestSourceMs + US_MARKET_DIRECTORY_MAX_SOURCE_AGE_MS,
    },
    scope:'Nasdaq Trader confirmed U.S.-listed equities and ETFs; Test Issue=N; non-common security types excluded',
    symbols:rows.map(row => row.symbol),
    etfs:rows.filter(row => row.category === 'etf').map(row => row.symbol),
    adrs:rows.filter(row => row.tags.includes('ADR')).map(row => row.symbol),
    coverage:{
      listedSecurityCount:rows.length,
      etfCount:rows.filter(row => row.category === 'etf').length,
      adrCount:rows.filter(row => row.tags.includes('ADR')).length,
      sourceCounts:directory.sourceCounts || null,
      exchangeCounts,
    },
    sources:{
      definitions:NASDAQ_DIRECTORY_DEFINITIONS_URL,
      nasdaqListed:NASDAQ_LISTED_URL,
      otherListed:OTHER_LISTED_URL,
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    setNoStore(res);
    return res.status(405).json({ error:'Method not allowed' });
  }
  if (Object.keys(req.query || {}).length) {
    setNoStore(res);
    return res.status(400).json({ error:'Unsupported query parameter' });
  }
  try {
    const directory = await fetchUsListedDirectory();
    // Cache lifetime starts when the complete response is ready, not before
    // two bounded upstream requests. This prevents request latency from
    // carrying a near-expiry snapshot past its seven-day source hard limit.
    const nowMs = Date.now();
    const payload = compactUsMarketDirectory(directory, nowMs);
    const validation = validateUsMarketDirectoryPayload(payload, { nowMs });
    if (!validation.valid) throw new Error(validation.reason);
    const cachePolicy = usMarketDirectoryCachePolicy(validation.validUntilMs, nowMs);
    if (!cachePolicy) setNoStore(res);
    else {
      setPublicCache(res, cachePolicy.maxAge, cachePolicy.staleWhileRevalidate);
    }
    return res.status(200).json(payload);
  } catch (error) {
    console.error('[us-market-directory] request failed', error);
    setNoStore(res);
    return res.status(503).json({ status:'unavailable', error:'Official U.S. listing directory unavailable' });
  }
}

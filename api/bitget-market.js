// Fixed-purpose, same-origin Bitget Spot catalog/market snapshot.
//
// The official v3 instruments response is the identity authority. Callers
// cannot select an upstream path, category or symbol. Market rows are optional
// and are inner-joined to the live catalog before publication, so they can
// never expand the admitted instrument universe.

import {
  fetchJsonWithPolicy,
  setNoStore,
  setPublicCache,
} from './_lib/upstream.js';

const BITGET_BASE = 'https://api.bitget.com';
const SPOT_INSTRUMENTS_URL = `${BITGET_BASE}/api/v3/market/instruments?category=SPOT`;
const REALITY_TICKERS_URL = `${BITGET_BASE}/api/v3/market/tickers?category=SPOT`;
const STANDARD_TICKERS_URL = `${BITGET_BASE}/api/v2/spot/market/tickers`;
// Keep the worst-case two-attempt catalog path below the 20-second browser and
// Signal source budgets. A fast connection reset still gets one retry, while a
// hanging optional ticker cannot hold the authoritative catalog past its own
// bounded deadline.
const CATALOG_UPSTREAM_POLICY = Object.freeze({ timeoutMs:8_000, retries:1, baseDelayMs:300 });
const TICKER_UPSTREAM_POLICY = Object.freeze({ timeoutMs:6_000, retries:1, baseDelayMs:300 });
const INSTRUMENT_FIELDS = Object.freeze([
  'symbol', 'category', 'baseCoin', 'quoteCoin', 'status', 'isRwa', 'isReality',
  'symbolType', 'symbolName', 'fullName', 'instrumentType', 'marketRegion', 'isin',
  'launchTime',
]);
const REALITY_TICKER_FIELDS = Object.freeze([
  'symbol', 'lastPrice', 'openPrice24h', 'lowPrice24h', 'highPrice24h',
  'ask1Price', 'bid1Price', 'bid1Size', 'ask1Size', 'price24hPcnt',
  'turnover24h', 'volume24h', 'platformTurnover24h', 'ts',
]);
const STANDARD_TICKER_FIELDS = Object.freeze([
  'symbol', 'lastPr', 'close', 'open', 'high24h', 'low24h', 'bidPr', 'askPr',
  'bidSz', 'askSz', 'change24h', 'quoteVolume', 'baseVolume', 'ts', 'timestamp',
]);

// Listing/Signal writers are pinned to iad1, while Bitget has repeatedly reset
// long-lived catalog connections on that path. Keep this fixed-purpose fetch in
// sin1 (the same egress pattern used by OKX/Binance market proxies) and let the
// shared CDN serve the bounded response back to iad1 and browsers.
export const config = { regions:['sin1'], maxDuration:60 };

function sendError(res, status, message) {
  setNoStore(res);
  return res.status(status).json({ error:message });
}

function project(row, fields) {
  return Object.fromEntries(fields
    .filter(field => row?.[field] !== undefined)
    .map(field => [field, row[field]]));
}

function exactNormalizedSymbol(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return null;
  return value.toUpperCase();
}

function assertUniqueCatalogSymbols(rows) {
  const seen = new Set();
  for (const row of rows) {
    const symbol = exactNormalizedSymbol(row?.symbol);
    if (!symbol) throw new TypeError('Invalid Bitget Spot instrument symbol');
    if (seen.has(symbol)) throw new TypeError(`Duplicate Bitget Spot instrument symbol: ${symbol}`);
    seen.add(symbol);
  }
}

function bitgetRows(payload, label) {
  if (payload?.code !== '00000' || !Array.isArray(payload?.data)) {
    throw new TypeError(`Invalid Bitget ${label} response`);
  }
  return payload.data;
}

function statusForOptionalRows(rows, expectedSymbols) {
  if (!expectedSymbols.size) return 'full';
  if (!Array.isArray(rows)) return 'unavailable';
  const observed = new Set(rows.map(row => String(row?.symbol || '').toUpperCase()).filter(Boolean));
  const matched = [...expectedSymbols].filter(symbol => observed.has(symbol)).length;
  return matched === expectedSymbols.size ? 'full' : matched > 0 ? 'partial' : 'unavailable';
}

function projectUniqueTickerRows(payload, label, expectedSymbols, fields) {
  const projected = [];
  const seen = new Set();
  for (const row of bitgetRows(payload, label)) {
    const symbol = exactNormalizedSymbol(row?.symbol);
    if (!symbol || !expectedSymbols.has(symbol)) continue;
    if (seen.has(symbol)) throw new TypeError(`Duplicate Bitget ${label} symbol: ${symbol}`);
    seen.add(symbol);
    projected.push(project(row, fields));
  }
  return projected;
}

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendError(res, 405, 'Method not allowed');
  }
  const type = req.query?.type;
  if (Object.keys(req.query || {}).length !== 1 || !['spot-catalog', 'spot-snapshot'].includes(type)) {
    return sendError(res, 400, 'Invalid type param');
  }

  const requests = [
    fetchJsonWithPolicy(
      SPOT_INSTRUMENTS_URL,
      { headers:{ Accept:'application/json' } },
      CATALOG_UPSTREAM_POLICY,
    ),
  ];
  if (type === 'spot-snapshot') {
    requests.push(
      fetchJsonWithPolicy(
        REALITY_TICKERS_URL,
        { headers:{ Accept:'application/json' } },
        TICKER_UPSTREAM_POLICY,
      ),
      fetchJsonWithPolicy(
        STANDARD_TICKERS_URL,
        { headers:{ Accept:'application/json' } },
        TICKER_UPSTREAM_POLICY,
      ),
    );
  }
  const settled = await Promise.allSettled(requests);

  let instruments;
  try {
    if (settled[0].status !== 'fulfilled') throw settled[0].reason;
    instruments = bitgetRows(settled[0].value, 'Spot instruments')
      .filter(row => row?.status === 'online' && ['USD', 'USDT'].includes(String(row?.quoteCoin || '').toUpperCase()))
      .map(row => project(row, INSTRUMENT_FIELDS));
    assertUniqueCatalogSymbols(instruments);
  } catch (error) {
    console.error(`[bitget-market] Spot identity catalog unavailable: ${error?.message || 'unknown error'}`);
    return sendError(res, 502, 'Bitget Spot identity catalog unavailable');
  }
  if (!instruments.length) return sendError(res, 502, 'Bitget Spot identity catalog is empty');

  const catalogPayload = {
    schemaVersion:1,
    generatedAt:new Date().toISOString(),
    catalogStatus:'full',
    instruments,
    coverage:{
      instruments:{ status:'full', observed:instruments.length, expected:instruments.length },
    },
  };
  if (type === 'spot-catalog') {
    // Identity changes are monitored on a six-hour cadence. A two-minute
    // shared result absorbs concurrent Listing/Signal readers without turning
    // the cache into a long-lived source of truth; five minutes of SWR only
    // defers a change and never admits an instrument from market data.
    setPublicCache(res, 120, 300);
    return res.status(200).json(catalogPayload);
  }

  const realitySymbols = new Set(instruments
    .filter(row => String(row.isReality || '').toLowerCase() === 'yes')
    .map(row => String(row.symbol || '').toUpperCase())
    .filter(Boolean));
  const standardSymbols = new Set(instruments
    .filter(row => String(row.isReality || '').toLowerCase() !== 'yes')
    .map(row => String(row.symbol || '').toUpperCase())
    .filter(Boolean));
  let realityTickers = null;
  let standardTickers = null;
  if (settled[1].status === 'fulfilled') {
    try {
      realityTickers = projectUniqueTickerRows(
        settled[1].value,
        'Spot Reality tickers',
        realitySymbols,
        REALITY_TICKER_FIELDS,
      );
    } catch { /* explicit unavailable status below */ }
  }
  if (settled[2].status === 'fulfilled') {
    try {
      standardTickers = projectUniqueTickerRows(
        settled[2].value,
        'Spot standard tickers',
        standardSymbols,
        STANDARD_TICKER_FIELDS,
      );
    } catch { /* explicit unavailable status below */ }
  }

  const realityTickerStatus = statusForOptionalRows(realityTickers, realitySymbols);
  const standardTickerStatus = statusForOptionalRows(standardTickers, standardSymbols);
  const requiredTickerStatuses = [
    ...(realitySymbols.size ? [realityTickerStatus] : []),
    ...(standardSymbols.size ? [standardTickerStatus] : []),
  ];
  const tickerStatus = requiredTickerStatuses.every(status => status === 'full')
    ? 'full'
    : requiredTickerStatuses.every(status => status === 'unavailable')
      ? 'unavailable'
      : 'partial';
  const warnings = [];
  if (realitySymbols.size && realityTickerStatus !== 'full') warnings.push('REALITY_TICKERS_INCOMPLETE');
  if (standardSymbols.size && standardTickerStatus !== 'full') warnings.push('STANDARD_TICKERS_INCOMPLETE');

  if (tickerStatus === 'unavailable') setNoStore(res);
  else if (tickerStatus === 'partial') setPublicCache(res, 15, 45);
  else setPublicCache(res, 30, 120);
  return res.status(200).json({
    ...catalogPayload,
    tickerStatus,
    realityTickers:realityTickers || [],
    standardTickers:standardTickers || [],
    coverage:{
      ...catalogPayload.coverage,
      realityTickers:{ status:realityTickerStatus, observed:realityTickers?.length || 0, expected:realitySymbols.size },
      standardTickers:{ status:standardTickerStatus, observed:standardTickers?.length || 0, expected:standardSymbols.size },
    },
    warnings,
  });
}

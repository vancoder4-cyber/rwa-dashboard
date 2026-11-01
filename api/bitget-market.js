// Fixed-purpose, same-origin Bitget Spot catalog/market snapshot.
//
// The official v3 instruments response plus the independent Reality Stock Info
// directory are the identity authorities. Callers cannot select an upstream
// path, category or symbol. Market rows are optional and are inner-joined to
// the verified live catalog before publication, so they can never expand the
// admitted instrument universe.

import {
  fetchJsonWithPolicy,
  setNoStore,
  setPublicCache,
} from './_lib/upstream.js';

const BITGET_BASE = 'https://api.bitget.com';
const SPOT_INSTRUMENTS_URL = `${BITGET_BASE}/api/v3/market/instruments?category=SPOT`;
const REALITY_STOCK_INFO_URL = `${BITGET_BASE}/api/v3/reality/market/stock-info`;
const REALITY_TICKERS_URL = `${BITGET_BASE}/api/v3/market/tickers?category=SPOT`;
const STANDARD_TICKERS_URL = `${BITGET_BASE}/api/v2/spot/market/tickers`;
// Keep the mandatory identity path below the Listing/Signal source budgets.
// Stock Info is officially limited to 1 request/sec/IP, so concurrent catalog
// and snapshot cold starts need a >1 second 429 backoff; three bounded attempts
// still finish within the 25-second source deadline. Optional tickers keep the
// shorter independent policy below.
const CATALOG_UPSTREAM_POLICY = Object.freeze({ timeoutMs:8_000, retries:1, baseDelayMs:300 });
const STOCK_INFO_UPSTREAM_POLICY = Object.freeze({ timeoutMs:7_000, retries:2, baseDelayMs:1_100 });
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
const REALITY_VERIFICATION_METHOD = 'bitget-reality-stock-info-exact-intersection-v1';

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

function exactUniqueSymbolSet(rows, label) {
  const symbols = new Set();
  for (const row of rows) {
    const symbol = exactNormalizedSymbol(row?.symbol);
    if (!symbol) throw new TypeError(`Invalid Bitget ${label} symbol`);
    if (symbols.has(symbol)) throw new TypeError(`Duplicate Bitget ${label} symbol: ${symbol}`);
    symbols.add(symbol);
  }
  return symbols;
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
    fetchJsonWithPolicy(
      REALITY_STOCK_INFO_URL,
      { headers:{ Accept:'application/json' } },
      STOCK_INFO_UPSTREAM_POLICY,
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
  let catalogEvidence;
  try {
    if (settled[0].status !== 'fulfilled') throw settled[0].reason;
    if (settled[1].status !== 'fulfilled') throw settled[1].reason;
    const candidates = bitgetRows(settled[0].value, 'Spot instruments')
      .filter(row => row?.status === 'online' && ['USD', 'USDT'].includes(String(row?.quoteCoin || '').toUpperCase()))
      .map(row => project(row, INSTRUMENT_FIELDS));
    assertUniqueCatalogSymbols(candidates);
    const stockInfoRows = bitgetRows(settled[1].value, 'Reality stock info');
    const stockInfoSymbols = exactUniqueSymbolSet(stockInfoRows, 'Reality stock info');
    const realityCandidates = candidates
      .filter(row => String(row?.isReality || '').toLowerCase() === 'yes');
    if (!realityCandidates.length || !stockInfoSymbols.size) {
      throw new TypeError('Bitget Reality identity authorities are empty');
    }
    const unmatchedReality = realityCandidates
      .map(row => exactNormalizedSymbol(row?.symbol))
      .filter(symbol => !stockInfoSymbols.has(symbol));
    if (unmatchedReality.length) {
      throw new TypeError(`Bitget Reality stock-info coverage incomplete: ${unmatchedReality.length} unmatched instruments`);
    }
    // Reality listings require exact-symbol agreement between two independent
    // official Bitget catalogs. Non-Reality rows remain available only so the
    // downstream exact legacy-asset allowlist can admit audited metals.
    instruments = candidates.filter(row =>
      String(row?.isReality || '').toLowerCase() !== 'yes' ||
      stockInfoSymbols.has(exactNormalizedSymbol(row?.symbol)));
    assertUniqueCatalogSymbols(instruments);
    catalogEvidence = {
      status:'full',
      method:REALITY_VERIFICATION_METHOD,
      instrumentsCount:instruments.length,
      realityCandidatesCount:realityCandidates.length,
      stockInfoCount:stockInfoSymbols.size,
      matchedCount:realityCandidates.length,
    };
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
    catalogEvidence,
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
  if (settled[2].status === 'fulfilled') {
    try {
      realityTickers = projectUniqueTickerRows(
        settled[2].value,
        'Spot Reality tickers',
        realitySymbols,
        REALITY_TICKER_FIELDS,
      );
    } catch { /* explicit unavailable status below */ }
  }
  if (settled[3].status === 'fulfilled') {
    try {
      standardTickers = projectUniqueTickerRows(
        settled[3].value,
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

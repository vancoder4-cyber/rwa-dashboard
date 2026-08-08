import { fetchJsonWithPolicy } from './upstream.js';

// OKX product metadata is the identity authority for this integration. The
// generic SWAP/FUTURES/SPOT catalogs contain crypto instruments too, so callers
// must only consume rows admitted by the predicates in this module.
export const OKX_API_BASE = 'https://www.okx.com/api/v5';
export const OKX_RWA_PERP_CATEGORIES = Object.freeze(['3', '4', '5', '6']);
export const OKX_SPOT_GOLD_EXCEPTIONS = Object.freeze({
  'PAXG-USD': Object.freeze({ baseCcy: 'PAXG', quoteCcy: 'USD' }),
  'PAXG-USDT': Object.freeze({ baseCcy: 'PAXG', quoteCcy: 'USDT' }),
  'XAUT-USDT': Object.freeze({ baseCcy: 'XAUT', quoteCcy: 'USDT' }),
});

const OKX_RWA_PERP_CATEGORY_SET = new Set(OKX_RWA_PERP_CATEGORIES);
// X-Perp FUTURES IDs contain an underscore-bearing family segment, e.g.
// AAPL-USD_UM_XPERP-310613.
const OKX_INSTRUMENT_ID_RE = /^[A-Z0-9._]+(?:-[A-Z0-9._]+){1,3}$/;
const MAX_RWA_CATALOG_SIZE = 500;
const ALLOWED_PATHS = new Set([
  '/market/history-candles',
  '/market/tickers',
  '/public/funding-rate',
  '/public/funding-rate-history',
  '/public/instruments',
  '/public/mark-price',
  '/public/open-interest',
]);

export const OKX_INSTRUMENT_FIELDS = Object.freeze([
  'instType', 'instId', 'uly', 'instFamily', 'baseCcy', 'quoteCcy',
  'settleCcy', 'ctVal', 'ctMult', 'ctValCcy', 'tickSz', 'lotSz',
  'minSz', 'lever', 'state', 'ruleType', 'instCategory', 'listTime',
  'expTime', 'contTdSwTime',
]);

export const OKX_TICKER_FIELDS = Object.freeze([
  'instType', 'instId', 'last', 'lastSz', 'askPx', 'askSz', 'bidPx',
  'bidSz', 'open24h', 'high24h', 'low24h', 'volCcy24h', 'vol24h',
  'sodUtc0', 'sodUtc8', 'ts',
]);

export const OKX_MARK_FIELDS = Object.freeze([
  'instType', 'instId', 'markPx', 'ts',
]);

export const OKX_OPEN_INTEREST_FIELDS = Object.freeze([
  'instType', 'instId', 'oi', 'oiCcy', 'oiUsd', 'ts',
]);

export const OKX_FUNDING_FIELDS = Object.freeze([
  'instType', 'instId', 'fundingRate', 'nextFundingRate', 'fundingTime',
  'nextFundingTime', 'prevFundingTime', 'minFundingRate', 'maxFundingRate', 'interestRate',
  'impactValue', 'method', 'formulaType', 'settState', 'settFundingRate',
  'premium', 'ts',
]);

function normalized(value) {
  return String(value ?? '').trim();
}

function normalizedUpper(value) {
  return normalized(value).toUpperCase();
}

export function isOkxRwaPerpInstrument(instrument) {
  if (!instrument || normalized(instrument.state).toLowerCase() !== 'live') return false;
  if (!OKX_RWA_PERP_CATEGORY_SET.has(normalized(instrument.instCategory))) return false;

  const instType = normalizedUpper(instrument.instType);
  if (instType === 'SWAP') return true;
  // OKX exposes X-Perps under FUTURES. Ordinary dated futures are not RWA
  // evidence and must remain excluded even if another field resembles a stock.
  return instType === 'FUTURES' && normalized(instrument.ruleType).toLowerCase() === 'xperp';
}

export function canonicalOkxPerpSymbol(instrument) {
  if (!isOkxRwaPerpInstrument(instrument)) return null;
  const identity = normalizedUpper(
    instrument.ctValCcy || instrument.uly || instrument.instFamily || instrument.instId
  );
  const symbol = identity.split('-')[0];
  return /^[A-Z0-9.]{1,30}$/.test(symbol) ? symbol : null;
}

export function canonicalOkxSpotSymbol(instrument) {
  if (!instrument || normalizedUpper(instrument.instType) !== 'SPOT') return null;
  if (normalized(instrument.state).toLowerCase() !== 'live') return null;

  const baseCcy = normalizedUpper(instrument.baseCcy);
  const quoteCcy = normalizedUpper(instrument.quoteCcy);
  const instId = normalizedUpper(instrument.instId);
  const goldException = OKX_SPOT_GOLD_EXCEPTIONS[instId];
  if (goldException) {
    return normalized(instrument.instCategory) === '1' &&
      baseCcy === goldException.baseCcy && quoteCcy === goldException.quoteCcy
      ? baseCcy
      : null;
  }

  if (normalized(instrument.instCategory) !== '3') return null;
  if (quoteCcy !== 'USDT' || !baseCcy.startsWith('X')) return null;
  if (instId !== `${baseCcy}-${quoteCcy}` || !OKX_INSTRUMENT_ID_RE.test(instId)) return null;

  // Strip exactly the official UTS wrapper prefix. This intentionally maps
  // XXOM to XOM while never applying a generic trim of every leading X.
  const symbol = baseCcy.slice(1);
  return /^[A-Z0-9.]{1,30}$/.test(symbol) ? symbol : null;
}

export function isOkxRwaSpotInstrument(instrument) {
  return canonicalOkxSpotSymbol(instrument) !== null;
}

export function projectOkxFields(row, fields, derived = null) {
  const projected = Object.fromEntries(fields
    .filter(field => row?.[field] !== undefined)
    .map(field => [field, row[field]]));
  return derived ? { ...projected, ...derived } : projected;
}

export async function fetchOkxData(path, params = {}, policy = {}) {
  if (!ALLOWED_PATHS.has(path)) throw new TypeError('Unsupported OKX upstream path');
  const url = new URL(`${OKX_API_BASE}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  const payload = await fetchJsonWithPolicy(
    url.toString(),
    { headers: { Accept: 'application/json' } },
    { timeoutMs: 8_000, retries: 1, baseDelayMs: 250, ...policy },
  );
  if (!payload || String(payload.code) !== '0' || !Array.isArray(payload.data)) {
    throw new TypeError('Invalid OKX response envelope');
  }
  return payload.data;
}

async function fetchInstrumentType(instType) {
  return fetchOkxData('/public/instruments', { instType });
}

function uniqueSortedCatalog(rows) {
  const byId = new Map();
  for (const row of rows) {
    const instId = normalizedUpper(row?.instId);
    if (!OKX_INSTRUMENT_ID_RE.test(instId)) continue;
    byId.set(instId, row);
  }
  return [...byId.values()].sort((left, right) =>
    normalizedUpper(left.instId).localeCompare(normalizedUpper(right.instId))
  );
}

export async function fetchOkxRwaCatalog(kind) {
  let admitted;
  if (kind === 'perp') {
    const [swaps, futures] = await Promise.all([
      fetchInstrumentType('SWAP'),
      fetchInstrumentType('FUTURES'),
    ]);
    admitted = uniqueSortedCatalog([...swaps, ...futures].filter(isOkxRwaPerpInstrument));
  } else if (kind === 'spot') {
    const spot = await fetchInstrumentType('SPOT');
    admitted = uniqueSortedCatalog(spot.filter(isOkxRwaSpotInstrument));
  } else {
    throw new TypeError('Invalid OKX catalog kind');
  }

  // Empty or unexpectedly broad catalogs fail closed. A large official product
  // expansion must be reviewed before it can silently expand the dashboard.
  if (!admitted.length || admitted.length > MAX_RWA_CATALOG_SIZE) {
    throw new TypeError(`Invalid OKX ${kind} RWA catalog size`);
  }
  return admitted;
}

export function okxInstrumentId(value) {
  const instId = normalizedUpper(value);
  return OKX_INSTRUMENT_ID_RE.test(instId) ? instId : null;
}

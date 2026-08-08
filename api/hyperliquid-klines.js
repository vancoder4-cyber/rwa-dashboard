// Fixed-purpose trade.xyz (Hyperliquid HIP-3) 30-day candle snapshot. Callers
// cannot select symbols or time ranges. The server joins the official xyz DEX
// catalog to perpCategories, ranks explicitly classified RWA markets by current
// day notional, and fan-outs only that deterministic Top 80.

import { mapWithConcurrency, setNoStore, setPublicCache } from './_lib/upstream.js';

export const config = { regions: ['sin1'], maxDuration: 60 };

const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
const MAX_SYMBOLS = 80;
const TRADE_XYZ_SYMBOL_PATTERN = /^xyz:[A-Z0-9][A-Z0-9._-]{0,39}$/;
const TRADE_XYZ_ALLOWED_RWA_TYPES = new Set([
  'stock', 'stocks', 'equity', 'equities', 'etf', 'commodity', 'commodities',
  'index', 'indices', 'fx', 'forex', 'preipo', 'pre-ipo',
]);
const HOUR_MS = 60 * 60 * 1000;
const EXPECTED_HOURLY_CANDLES = 30 * 24;
const FUNCTION_BUDGET_MS = 55_000;

function rejectAnyQuery(query) {
  if (Object.keys(query || {}).length) throw new TypeError('Unexpected query param');
}

function sendError(res, status, message) {
  setNoStore(res);
  return res.status(status).json({ error: message });
}

function finiteNonnegative(value) {
  if (value === '' || value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function timeoutWithinDeadline(deadlineAt, maximumMs) {
  const remaining = deadlineAt - Date.now() - 1_000;
  if (remaining < 250) throw new Error('Hyperliquid function deadline reached');
  return Math.min(maximumMs, remaining);
}

export function selectTradeXyzKlineSymbols(marketSnapshot, categoryRows) {
  const universe = Array.isArray(marketSnapshot) && marketSnapshot.length === 2
    ? marketSnapshot[0]?.universe
    : null;
  const contexts = Array.isArray(marketSnapshot) && marketSnapshot.length === 2
    ? marketSnapshot[1]
    : null;
  if (!Array.isArray(universe) || !universe.length || !Array.isArray(contexts) || contexts.length !== universe.length) {
    throw new TypeError('Invalid trade.xyz market catalog');
  }
  if (!Array.isArray(categoryRows) || !categoryRows.length) {
    throw new TypeError('Invalid Hyperliquid perpCategories snapshot');
  }

  const categoryMap = new Map();
  for (const row of categoryRows) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const symbol = String(row[0] || '');
    if (!symbol.startsWith('xyz:')) continue;
    const officialType = String(row[1] || '').trim().toLowerCase();
    if (!TRADE_XYZ_SYMBOL_PATTERN.test(symbol) || !officialType) {
      throw new TypeError('Invalid trade.xyz category identity');
    }
    if (categoryMap.has(symbol)) throw new TypeError('Duplicate trade.xyz category identity');
    categoryMap.set(symbol, officialType);
  }
  if (!categoryMap.size) throw new TypeError('trade.xyz classifications are empty');

  const universeSeen = new Set();
  const ranked = [];
  for (let index = 0; index < universe.length; index += 1) {
    const instrument = universe[index];
    const symbol = String(instrument?.name || '');
    if (!TRADE_XYZ_SYMBOL_PATTERN.test(symbol)) {
      throw new TypeError('Invalid trade.xyz catalog identity');
    }
    if (universeSeen.has(symbol)) throw new TypeError('Duplicate trade.xyz catalog identity');
    universeSeen.add(symbol);
    if (instrument?.isDelisted === true) continue;
    if (!TRADE_XYZ_ALLOWED_RWA_TYPES.has(categoryMap.get(symbol))) continue;
    const dayNotional = finiteNonnegative(contexts[index]?.dayNtlVlm);
    if (dayNotional === null) throw new TypeError('Incomplete trade.xyz day-notional coverage');
    ranked.push([symbol, dayNotional]);
  }
  if (!ranked.length) throw new TypeError('Explicitly classified trade.xyz RWA catalog is empty');

  return ranked
    .sort(([leftSymbol, leftVolume], [rightSymbol, rightVolume]) =>
      rightVolume - leftVolume || leftSymbol.localeCompare(rightSymbol)
    )
    .slice(0, MAX_SYMBOLS)
    .map(([symbol]) => symbol);
}

export function completedUtcHourWindow(now = Date.now()) {
  if (!Number.isFinite(now) || now <= 0) throw new TypeError('Invalid clock');
  const endExclusive = Math.floor(now / HOUR_MS) * HOUR_MS;
  return {
    startInclusive: endExclusive - EXPECTED_HOURLY_CANDLES * HOUR_MS,
    endExclusive,
  };
}

export function normalizeHyperliquidHourlyCandles(rows, now = Date.now()) {
  const unavailable = {
    volume30d: null,
    candles: 0,
    observed: 0,
    expected: EXPECTED_HOURLY_CANDLES,
    method: 'estimated',
    status: 'unavailable',
  };
  if (!Array.isArray(rows)) return unavailable;

  const window = completedUtcHourWindow(now);
  const byOpenTime = new Map();
  for (const row of rows) {
    const rawOpenTime = row?.t;
    const rawBaseVolume = row?.v;
    const rawClose = row?.c;
    if (rawOpenTime === '' || rawOpenTime === null || rawOpenTime === undefined
      || rawBaseVolume === '' || rawBaseVolume === null || rawBaseVolume === undefined
      || rawClose === '' || rawClose === null || rawClose === undefined) continue;

    const openTime = Number(rawOpenTime);
    const baseVolume = Number(rawBaseVolume);
    const close = Number(rawClose);
    if (!Number.isSafeInteger(openTime) || openTime <= 0 || openTime % HOUR_MS !== 0) continue;
    if (!Number.isFinite(baseVolume) || baseVolume < 0) continue;
    if (!Number.isFinite(close) || close <= 0) continue;
    if (openTime < window.startInclusive || openTime >= window.endExclusive) continue;
    if (openTime + HOUR_MS > window.endExclusive || openTime + HOUR_MS > now) continue;

    if (row?.T !== undefined && row?.T !== null && row?.T !== '') {
      const closeTime = Number(row.T);
      if (!Number.isSafeInteger(closeTime) || closeTime <= openTime || closeTime > now || closeTime >= window.endExclusive) continue;
    }
    const quoteNotionalEstimate = baseVolume * close;
    if (!Number.isFinite(quoteNotionalEstimate) || quoteNotionalEstimate < 0) continue;
    if (!byOpenTime.has(openTime)) byOpenTime.set(openTime, quoteNotionalEstimate);
  }

  const observations = [...byOpenTime.entries()]
    .sort(([left], [right]) => left - right)
    .slice(-(30 * 24));
  if (!observations.length) return unavailable;
  const volume30d = observations.reduce((sum, [, notional]) => sum + notional, 0);
  const observed = observations.length;
  return {
    volume30d,
    candles: observed,
    observed,
    expected: EXPECTED_HOURLY_CANDLES,
    method: 'estimated',
    status: observed === EXPECTED_HOURLY_CANDLES ? 'estimated' : 'partial',
  };
}

async function fetchHyperliquidInfo(body, deadlineAt) {
  const upstream = await fetch(HYPERLIQUID_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutWithinDeadline(deadlineAt, 10_000)),
  });
  if (!upstream.ok) throw new Error(`Hyperliquid catalog HTTP ${upstream.status}`);
  return upstream.json();
}

async function discoverTradeXyzKlineSymbols(deadlineAt) {
  const [marketSnapshot, categoryRows] = await Promise.all([
    fetchHyperliquidInfo({ type:'metaAndAssetCtxs', dex:'xyz' }, deadlineAt),
    fetchHyperliquidInfo({ type:'perpCategories' }, deadlineAt),
  ]);
  return selectTradeXyzKlineSymbols(marketSnapshot, categoryRows);
}

async function fetchKlineTotals(symbols, now = Date.now(), deadlineAt = now + FUNCTION_BUDGET_MS) {
  const window = completedUtcHourWindow(now);
  let upstreamFailures = 0;
  // Five worst-case waves at 8s plus the 10s parallel catalog stage remain
  // inside the 55s application deadline without an 80-request burst.
  const entries = await mapWithConcurrency([...symbols].sort(), 16, async symbol => {
    try {
      const upstream = await fetch(HYPERLIQUID_INFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          type: 'candleSnapshot',
          req: {
            coin: symbol,
            interval: '1h',
            startTime: window.startInclusive,
            endTime: window.endExclusive - 1,
          },
        }),
        signal: AbortSignal.timeout(timeoutWithinDeadline(deadlineAt, 8_000)),
      });
      if (!upstream.ok) {
        upstreamFailures += 1;
        return [symbol, null];
      }
      const rows = await upstream.json();
      if (!Array.isArray(rows)) {
        upstreamFailures += 1;
        return [symbol, null];
      }
      return [symbol, normalizeHyperliquidHourlyCandles(rows, now)];
    } catch {
      upstreamFailures += 1;
      return [symbol, null];
    }
  });
  return { results: Object.fromEntries(entries), upstreamFailures };
}

export default async function handler(req, res) {
  const deadlineAt = Date.now() + FUNCTION_BUDGET_MS;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendError(res, 405, 'Method not allowed');
  }
  try {
    rejectAnyQuery(req.query);
  } catch (error) {
    return sendError(res, 400, error.message);
  }

  let symbols;
  try {
    symbols = await discoverTradeXyzKlineSymbols(deadlineAt);
  } catch (error) {
    console.error(`[hyperliquid-klines] fixed catalog unavailable: ${error?.message || 'unknown error'}`);
    return sendError(res, 502, 'trade.xyz RWA catalog unavailable');
  }
  const batch = await fetchKlineTotals(symbols, Date.now(), deadlineAt);
  res.setHeader('X-RWA-Upstream-Errors', String(batch.upstreamFailures));
  res.setHeader('X-RWA-Selected-Symbols', String(symbols.length));
  if (batch.upstreamFailures === symbols.length) {
    return sendError(res, 502, 'trade.xyz volume history unavailable');
  }
  if (batch.upstreamFailures) setNoStore(res);
  else setPublicCache(res, 300, 600);
  return res.status(200).json(batch.results);
}

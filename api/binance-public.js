// Fixed-purpose, read-only Binance USDⓈ-M market-data proxy. Market snapshot
// callers cannot choose paths, symbols, or time ranges. For 30-day volume the
// server discovers one deterministic Top-80 RWA set from Binance's current
// official catalog and 24h ticker before performing any candle fan-out.

import { mapWithConcurrency, setNoStore, setPublicCache } from './_lib/upstream.js';
import {
  normalizeBinanceSpotTickerCoverage,
  selectBinanceSpotRwaCatalog,
} from './_lib/binance-spot.js';

export const config = { regions: ['sin1'], maxDuration: 60 };

const BINANCE_FUTURES_BASE = 'https://fapi.binance.com/fapi/v1';
const BINANCE_SPOT_BASE = 'https://data-api.binance.vision/api/v3';
const ENDPOINTS = Object.freeze({
  exchangeInfo: '/exchangeInfo',
  premiumIndex: '/premiumIndex',
  ticker24hr: '/ticker/24hr',
  fundingInfo: '/fundingInfo',
});
const MAX_SYMBOLS = 80;
const BINANCE_SYMBOL_PATTERN = /^[A-Z0-9]{2,40}$/;
const BINANCE_BASE_PATTERN = /^[A-Z0-9-]{1,40}$/;
const AUDITED_METAL_EXCEPTIONS = new Set(['PAXG', 'XAUT']);
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPECTED_DAILY_CANDLES = 30;
const FUNCTION_BUDGET_MS = 55_000;
const SPOT_TICKER_BATCH_SIZE = 80;

function singleQueryValue(value) {
  return typeof value === 'string' ? value : null;
}

function rejectUnexpectedQueryKeys(query, allowedKeys) {
  if (Object.keys(query || {}).some(key => !allowedKeys.has(key))) {
    throw new TypeError('Unexpected query param');
  }
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
  if (remaining < 250) throw new Error('Binance function deadline reached');
  return Math.min(maximumMs, remaining);
}

function isAdmittedBinanceRwaContract(contract) {
  if (contract?.status !== 'TRADING') return false;
  if (contract?.contractType === 'TRADIFI_PERPETUAL') return true;
  return contract?.contractType === 'PERPETUAL' &&
    AUDITED_METAL_EXCEPTIONS.has(String(contract?.baseAsset || ''));
}

export function selectBinanceKlineSymbols(exchangeInfo, tickerRows) {
  if (!Array.isArray(exchangeInfo?.symbols) || !exchangeInfo.symbols.length) {
    throw new TypeError('Invalid Binance exchangeInfo catalog');
  }
  if (!Array.isArray(tickerRows) || !tickerRows.length) {
    throw new TypeError('Invalid Binance ticker24hr snapshot');
  }

  const admitted = new Set();
  for (const contract of exchangeInfo.symbols) {
    if (!isAdmittedBinanceRwaContract(contract)) continue;
    const symbol = String(contract?.symbol || '');
    const baseAsset = String(contract?.baseAsset || '');
    if (!BINANCE_SYMBOL_PATTERN.test(symbol) || !BINANCE_BASE_PATTERN.test(baseAsset)) {
      throw new TypeError('Invalid Binance RWA catalog identity');
    }
    if (admitted.has(symbol)) throw new TypeError('Duplicate Binance RWA catalog identity');
    admitted.add(symbol);
  }
  if (!admitted.size) throw new TypeError('Binance RWA catalog is empty');

  const ranked = new Map();
  for (const ticker of tickerRows) {
    const symbol = String(ticker?.symbol || '');
    if (!admitted.has(symbol)) continue;
    if (ranked.has(symbol)) throw new TypeError('Duplicate Binance RWA ticker row');
    const quoteVolume = finiteNonnegative(ticker?.quoteVolume);
    if (quoteVolume === null) throw new TypeError('Incomplete Binance RWA ticker volume');
    ranked.set(symbol, quoteVolume);
  }
  if (ranked.size !== admitted.size) {
    throw new TypeError('Incomplete Binance RWA ticker coverage');
  }

  return [...ranked.entries()]
    .sort(([leftSymbol, leftVolume], [rightSymbol, rightVolume]) =>
      rightVolume - leftVolume || leftSymbol.localeCompare(rightSymbol)
    )
    .slice(0, MAX_SYMBOLS)
    .map(([symbol]) => symbol);
}

export function completedUtcDayWindow(now = Date.now()) {
  if (!Number.isFinite(now) || now <= 0) throw new TypeError('Invalid clock');
  const endExclusive = Math.floor(now / DAY_MS) * DAY_MS;
  return {
    startInclusive: endExclusive - EXPECTED_DAILY_CANDLES * DAY_MS,
    endExclusive,
  };
}

export function normalizeBinanceDailyCandles(rows, now = Date.now()) {
  const unavailable = {
    volume30d: null,
    candles: 0,
    observed: 0,
    expected: EXPECTED_DAILY_CANDLES,
    status: 'unavailable',
  };
  if (!Array.isArray(rows)) return unavailable;

  const window = completedUtcDayWindow(now);
  const byOpenTime = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 8) continue;
    const rawOpenTime = row[0];
    const rawCloseTime = row[6];
    const rawQuoteVolume = row[7];
    if (rawOpenTime === '' || rawOpenTime === null || rawOpenTime === undefined
      || rawCloseTime === '' || rawCloseTime === null || rawCloseTime === undefined
      || rawQuoteVolume === '' || rawQuoteVolume === null || rawQuoteVolume === undefined) continue;

    const openTime = Number(rawOpenTime);
    const closeTime = Number(rawCloseTime);
    const quoteVolume = Number(rawQuoteVolume);
    if (!Number.isSafeInteger(openTime) || openTime <= 0 || openTime % DAY_MS !== 0) continue;
    if (!Number.isSafeInteger(closeTime) || closeTime <= openTime || closeTime > now) continue;
    if (!Number.isFinite(quoteVolume) || quoteVolume < 0) continue;
    if (openTime < window.startInclusive || openTime >= window.endExclusive) continue;
    if (closeTime >= window.endExclusive) continue;
    if (!byOpenTime.has(openTime)) byOpenTime.set(openTime, quoteVolume);
  }

  const observations = [...byOpenTime.entries()]
    .sort(([left], [right]) => left - right)
    .slice(-EXPECTED_DAILY_CANDLES);
  if (!observations.length) return unavailable;
  const volume30d = observations.reduce((sum, [, quoteVolume]) => sum + quoteVolume, 0);
  const observed = observations.length;
  return {
    volume30d,
    candles: observed,
    observed,
    expected: EXPECTED_DAILY_CANDLES,
    status: observed === EXPECTED_DAILY_CANDLES ? 'full' : 'partial',
  };
}

async function fetchBinanceJson(path, deadlineAt) {
  const upstream = await fetch(`${BINANCE_FUTURES_BASE}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutWithinDeadline(deadlineAt, 8_000)),
  });
  if (!upstream.ok) throw new Error(`Binance catalog HTTP ${upstream.status}`);
  return upstream.json();
}

async function fetchBinanceJsonFrom(baseUrl, path, deadlineAt, maximumMs = 8_000) {
  const upstream = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutWithinDeadline(deadlineAt, maximumMs)),
  });
  if (!upstream.ok) throw new Error(`Binance catalog HTTP ${upstream.status}`);
  // Consume the body before the request timeout expires. The public spot
  // exchangeInfo body is large upstream, but it is never forwarded to clients.
  return upstream.json();
}

async function fetchBinanceSpotTickerRows(instruments, deadlineAt) {
  const symbols = instruments.map(row => row.symbol).sort();
  const batches = [];
  for (let index = 0; index < symbols.length; index += SPOT_TICKER_BATCH_SIZE) {
    batches.push(symbols.slice(index, index + SPOT_TICKER_BATCH_SIZE));
  }
  let upstreamFailures = 0;
  const rowsByBatch = await mapWithConcurrency(batches, 3, async batch => {
    try {
      const query = encodeURIComponent(JSON.stringify(batch));
      const rows = await fetchBinanceJsonFrom(
        BINANCE_SPOT_BASE,
        `/ticker/24hr?symbols=${query}`,
        deadlineAt,
        12_000,
      );
      if (!Array.isArray(rows)) throw new TypeError('Invalid Binance spot ticker snapshot');
      return rows;
    } catch {
      upstreamFailures += 1;
      return [];
    }
  });
  return { rows: rowsByBatch.flat(), upstreamFailures, batches: batches.length };
}

async function discoverBinanceKlineSymbols(deadlineAt) {
  const [exchangeInfo, tickerRows] = await Promise.all([
    fetchBinanceJson('/exchangeInfo', deadlineAt),
    fetchBinanceJson('/ticker/24hr', deadlineAt),
  ]);
  return selectBinanceKlineSymbols(exchangeInfo, tickerRows);
}

async function fetchKlineTotals(symbols, now = Date.now(), deadlineAt = now + FUNCTION_BUDGET_MS) {
  const window = completedUtcDayWindow(now);
  let upstreamFailures = 0;
  const entries = await mapWithConcurrency([...symbols].sort(), 20, async symbol => {
    try {
      const upstream = await fetch(
        `${BINANCE_FUTURES_BASE}/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&limit=31&startTime=${window.startInclusive}&endTime=${window.endExclusive - 1}`,
        {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutWithinDeadline(deadlineAt, 8_000)),
        },
      );
      if (!upstream.ok) {
        upstreamFailures += 1;
        return [symbol, null];
      }
      const rows = await upstream.json();
      if (!Array.isArray(rows)) {
        upstreamFailures += 1;
        return [symbol, null];
      }
      const completed = rows.filter(row => Number(row?.[6]) > 0 && Number(row[6]) < Date.now());
      return [symbol, normalizeBinanceDailyCandles(completed, now)];
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

  const endpoint = singleQueryValue(req.query?.endpoint);
  const isKlines = endpoint === 'klines';
  const isSpotSnapshot = endpoint === 'spot-snapshot';
  const path = endpoint ? ENDPOINTS[endpoint] : null;
  if (!isKlines && !isSpotSnapshot && !path) return sendError(res, 400, 'Invalid endpoint');
  try {
    rejectUnexpectedQueryKeys(req.query, new Set(['endpoint']));
  } catch (error) {
    return sendError(res, 400, error.message);
  }

  if (isKlines) {
    let symbols;
    try {
      symbols = await discoverBinanceKlineSymbols(deadlineAt);
    } catch (error) {
      console.error(`[binance-public] fixed kline catalog unavailable: ${error?.message || 'unknown error'}`);
      return sendError(res, 502, 'Binance RWA catalog unavailable');
    }
    const batch = await fetchKlineTotals(symbols, Date.now(), deadlineAt);
    res.setHeader('X-RWA-Upstream-Errors', String(batch.upstreamFailures));
    res.setHeader('X-RWA-Selected-Symbols', String(symbols.length));
    if (batch.upstreamFailures === symbols.length) {
      return sendError(res, 502, 'Binance volume history unavailable');
    }
    if (batch.upstreamFailures) setNoStore(res);
    else setPublicCache(res, 300, 600);
    return res.status(200).json(batch.results);
  }

  if (isSpotSnapshot) {
    let catalog;
    try {
      const [spotExchangeInfo, futuresExchangeInfo] = await Promise.all([
        fetchBinanceJsonFrom(BINANCE_SPOT_BASE, '/exchangeInfo', deadlineAt, 15_000),
        fetchBinanceJsonFrom(BINANCE_FUTURES_BASE, '/exchangeInfo', deadlineAt, 10_000),
      ]);
      catalog = selectBinanceSpotRwaCatalog(spotExchangeInfo, futuresExchangeInfo);
    } catch (error) {
      console.error(`[binance-public] fixed spot catalog unavailable: ${error?.message || 'unknown error'}`);
      return sendError(res, 502, 'Binance RWA spot catalog unavailable');
    }

    const tickerBatch = await fetchBinanceSpotTickerRows(catalog.instruments, deadlineAt);
    const tickerSnapshot = normalizeBinanceSpotTickerCoverage(catalog.instruments, tickerBatch.rows);
    const payload = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      catalogStatus: 'full',
      tickerStatus: tickerSnapshot.coverage.status,
      catalogCoverage: catalog.coverage,
      tickerCoverage: {
        ...tickerSnapshot.coverage,
        upstreamFailures: tickerBatch.upstreamFailures,
        upstreamBatches: tickerBatch.batches,
      },
      instruments: catalog.instruments,
      tickers: tickerSnapshot.tickers,
    };
    res.setHeader('X-RWA-Catalog-Rows', String(catalog.instruments.length));
    res.setHeader('X-RWA-Ticker-Rows', String(tickerSnapshot.coverage.observed));
    res.setHeader('X-RWA-Ticker-Status', tickerSnapshot.coverage.status);
    if (tickerSnapshot.coverage.status === 'full') setPublicCache(res, 60, 300);
    else if (tickerSnapshot.coverage.status === 'partial') setPublicCache(res, 15, 45);
    else setNoStore(res);
    return res.status(200).json(payload);
  }

  try {
    const upstream = await fetch(`${BINANCE_FUTURES_BASE}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    const body = await upstream.text();
    if (!upstream.ok) return sendError(res, 502, 'Binance upstream unavailable');

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    setPublicCache(res, 20, 120);
    return res.status(200).send(body);
  } catch {
    return sendError(res, 504, 'Binance upstream timeout');
  }
}

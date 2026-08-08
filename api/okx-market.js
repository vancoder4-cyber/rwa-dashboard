// Fixed-purpose OKX RWA market-data endpoint. User input can select one of the
// documented response types and, for 30-day volume, a bounded list of already
// admitted instrument IDs. It can never select an upstream host or path.

import {
  OKX_FUNDING_FIELDS,
  OKX_INSTRUMENT_FIELDS,
  OKX_MARK_FIELDS,
  OKX_OPEN_INTEREST_FIELDS,
  OKX_TICKER_FIELDS,
  canonicalOkxPerpSymbol,
  canonicalOkxSpotSymbol,
  fetchOkxData,
  fetchOkxRwaCatalog,
  okxInstrumentId,
  projectOkxFields,
} from './_lib/okx.js';
import { mapWithConcurrency, setNoStore, setPublicCache } from './_lib/upstream.js';

export const config = { regions: ['sin1'], maxDuration: 60 };

const MAX_SYMBOLS = 80;
const MAX_SYMBOL_PARAM_LENGTH = 5_000;
const CANDLE_CONCURRENCY = 4;
const TYPE_CONFIG = Object.freeze({
  'perp-snapshot': Object.freeze({ queryKeys: new Set(['type']), cacheSeconds: 30, staleSeconds: 120 }),
  'spot-snapshot': Object.freeze({ queryKeys: new Set(['type']), cacheSeconds: 30, staleSeconds: 120 }),
  volume30d: Object.freeze({ queryKeys: new Set(['type', 'symbols']), cacheSeconds: 300, staleSeconds: 900 }),
});

function sendError(res, status, message) {
  setNoStore(res);
  return res.status(status).json({ error: message });
}

function singleQueryValue(value) {
  return typeof value === 'string' ? value : null;
}

function rejectUnexpectedQueryKeys(query, allowedKeys) {
  if (Object.keys(query || {}).some(key => !allowedKeys.has(key))) {
    throw new TypeError('Unexpected query param');
  }
}

function parseSymbols(value) {
  const raw = singleQueryValue(value);
  if (!raw || raw.length > MAX_SYMBOL_PARAM_LENGTH) {
    throw new TypeError('Invalid symbols param');
  }
  const candidates = raw.split(',');
  if (!candidates.length || candidates.length > MAX_SYMBOLS) {
    throw new TypeError(`symbols must contain 1-${MAX_SYMBOLS} entries`);
  }

  const symbols = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const symbol = okxInstrumentId(candidate);
    if (!symbol || candidate !== symbol || seen.has(symbol)) {
      throw new TypeError('symbols must be unique uppercase OKX instrument IDs');
    }
    seen.add(symbol);
    symbols.push(symbol);
  }
  const sorted = [...symbols].sort();
  if (symbols.some((symbol, index) => symbol !== sorted[index])) {
    throw new TypeError('symbols must be in lexical order');
  }
  return symbols;
}

function projectRows(rows, allowedIds, fields) {
  const byId = new Map();
  for (const row of rows) {
    const instId = String(row?.instId || '').trim().toUpperCase();
    if (!allowedIds.has(instId)) continue;
    byId.set(instId, projectOkxFields(row, fields));
  }
  return [...byId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, row]) => row);
}

function resourceCoverage(observed, expected) {
  return {
    status: observed >= expected ? 'full' : observed > 0 ? 'partial' : 'unavailable',
    observed,
    expected,
  };
}

function overallCoverage(resources) {
  const statuses = resources.map(resource => resource.status);
  if (statuses.every(status => status === 'full')) return 'full';
  return statuses.some(status => status !== 'unavailable') ? 'partial' : 'unavailable';
}

async function fetchForInstrumentTypes(path, instTypes) {
  const batches = await Promise.all(instTypes.map(instType =>
    fetchOkxData(path, { instType }, { timeoutMs: 8_000, retries: 1 })
  ));
  return batches.flat();
}

async function fetchPerpSnapshot() {
  const catalog = await fetchOkxRwaCatalog('perp');
  const allowedIds = new Set(catalog.map(row => row.instId));
  const instTypes = [...new Set(catalog.map(row => row.instType))].sort();

  const fundingPromise = fetchOkxData(
    '/public/funding-rate',
    { instId: 'ANY' },
    { timeoutMs: 10_000, retries: 1 },
  ).then(data => ({ data, failed: false })).catch(() => ({ data: [], failed: true }));

  const [rawTickers, rawMarks, rawOpenInterest, fundingResult] = await Promise.all([
    fetchForInstrumentTypes('/market/tickers', instTypes),
    fetchForInstrumentTypes('/public/mark-price', instTypes),
    fetchForInstrumentTypes('/public/open-interest', instTypes),
    fundingPromise,
  ]);

  // All market resources are inner-joined to the current live official catalog.
  // This also removes expired X-Perps returned by a lagging bulk endpoint.
  const instruments = catalog.map(row => projectOkxFields(
    row,
    OKX_INSTRUMENT_FIELDS,
    { canonicalSymbol: canonicalOkxPerpSymbol(row) },
  ));
  const tickers = projectRows(rawTickers, allowedIds, OKX_TICKER_FIELDS);
  const marks = projectRows(rawMarks, allowedIds, OKX_MARK_FIELDS);
  const openInterest = projectRows(rawOpenInterest, allowedIds, OKX_OPEN_INTEREST_FIELDS);
  // Do not use truthiness here: the official string "0" is a valid funding rate.
  const funding = projectRows(fundingResult.data, allowedIds, OKX_FUNDING_FIELDS);

  const coverage = {
    instruments: resourceCoverage(instruments.length, instruments.length),
    tickers: resourceCoverage(tickers.length, instruments.length),
    marks: resourceCoverage(marks.length, instruments.length),
    openInterest: resourceCoverage(openInterest.length, instruments.length),
    funding: {
      ...resourceCoverage(funding.length, instruments.length),
      upstreamFailed: fundingResult.failed,
    },
  };
  coverage.status = overallCoverage([
    coverage.instruments,
    coverage.tickers,
    coverage.marks,
    coverage.openInterest,
    coverage.funding,
  ]);

  return {
    payload: {
      generatedAt: new Date().toISOString(),
      instruments,
      tickers,
      marks,
      openInterest,
      funding,
      coverage,
    },
    cacheable: !fundingResult.failed && ![
      coverage.tickers,
      coverage.marks,
      coverage.openInterest,
    ].some(resource => resource.status === 'unavailable'),
  };
}

async function fetchSpotSnapshot() {
  const catalog = await fetchOkxRwaCatalog('spot');
  const allowedIds = new Set(catalog.map(row => row.instId));
  const rawTickers = await fetchOkxData('/market/tickers', { instType: 'SPOT' });
  const instruments = catalog.map(row => projectOkxFields(
    row,
    OKX_INSTRUMENT_FIELDS,
    { canonicalSymbol: canonicalOkxSpotSymbol(row) },
  ));
  const tickers = projectRows(rawTickers, allowedIds, OKX_TICKER_FIELDS);
  const coverage = {
    instruments: resourceCoverage(instruments.length, instruments.length),
    tickers: resourceCoverage(tickers.length, instruments.length),
  };
  coverage.status = overallCoverage([coverage.instruments, coverage.tickers]);
  return {
    payload: {
      generatedAt: new Date().toISOString(),
      instruments,
      tickers,
      coverage,
    },
    cacheable: coverage.tickers.status !== 'unavailable',
  };
}

export function normalizeOkxVolumeCandles(rows) {
  const unavailable = { volume30d: null, status: 'unavailable', observed: 0, expected: 30 };
  if (!Array.isArray(rows)) return unavailable;
  const byTimestamp = new Map();
  for (const row of rows) {
    // Index 7 is official quote-currency volume; index 8 confirms the UTC
    // daily candle is complete. Never mix the current partial day into 30d.
    if (!Array.isArray(row) || row.length < 9 || String(row[8]) !== '1') continue;
    const timestamp = String(row[0] ?? '');
    const rawQuoteVolume = row[7];
    if (!timestamp || rawQuoteVolume === '' || rawQuoteVolume === null || rawQuoteVolume === undefined) continue;
    const quoteVolume = Number(rawQuoteVolume);
    if (!Number.isFinite(quoteVolume) || quoteVolume < 0) continue;
    byTimestamp.set(timestamp, { timestamp: Number(timestamp), quoteVolume });
  }

  const observations = [...byTimestamp.values()]
    .filter(row => Number.isFinite(row.timestamp) && row.timestamp > 0)
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, 30);
  if (!observations.length) return unavailable;
  return {
    volume30d: observations.reduce((sum, row) => sum + row.quoteVolume, 0),
    status: observations.length >= 30 ? 'full' : 'partial',
    observed: observations.length,
    expected: 30,
  };
}

async function fetchVolume30d(symbols) {
  const catalog = await fetchOkxRwaCatalog('perp');
  const allowedIds = new Set(catalog.map(row => row.instId));
  if (symbols.some(symbol => !allowedIds.has(symbol))) {
    throw new RangeError('Every symbol must belong to the current OKX RWA catalog');
  }

  let upstreamFailures = 0;
  const entries = await mapWithConcurrency(symbols, CANDLE_CONCURRENCY, async symbol => {
    try {
      const candles = await fetchOkxData(
        '/market/history-candles',
        { instId: symbol, bar: '1Dutc', limit: 31 },
        { timeoutMs: 6_000, retries: 0 },
      );
      return [symbol, normalizeOkxVolumeCandles(candles)];
    } catch {
      upstreamFailures += 1;
      return [symbol, { volume30d: null, status: 'unavailable', observed: 0, expected: 30 }];
    }
  });
  return { results: Object.fromEntries(entries), upstreamFailures };
}

function setSuccessCache(res, typeConfig, status) {
  if (status === 'unavailable') {
    setNoStore(res);
    return;
  }
  if (status === 'partial') {
    setPublicCache(res, Math.min(typeConfig.cacheSeconds, 30), Math.min(typeConfig.staleSeconds, 120));
    return;
  }
  setPublicCache(res, typeConfig.cacheSeconds, typeConfig.staleSeconds);
}

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendError(res, 405, 'Method not allowed');
  }

  const type = singleQueryValue(req.query?.type);
  const typeConfig = type ? TYPE_CONFIG[type] : null;
  if (!typeConfig) return sendError(res, 400, 'Invalid type param');

  let symbols;
  try {
    rejectUnexpectedQueryKeys(req.query, typeConfig.queryKeys);
    if (type === 'volume30d') symbols = parseSymbols(req.query.symbols);
  } catch (error) {
    return sendError(res, 400, error.message);
  }

  try {
    if (type === 'perp-snapshot') {
      const snapshot = await fetchPerpSnapshot();
      if (snapshot.cacheable) setSuccessCache(res, typeConfig, snapshot.payload.coverage.status);
      else setNoStore(res);
      return res.status(200).json(snapshot.payload);
    }
    if (type === 'spot-snapshot') {
      const snapshot = await fetchSpotSnapshot();
      if (snapshot.cacheable) setSuccessCache(res, typeConfig, snapshot.payload.coverage.status);
      else setNoStore(res);
      return res.status(200).json(snapshot.payload);
    }

    const batch = await fetchVolume30d(symbols);
    const statuses = Object.values(batch.results).map(result => result.status);
    if (statuses.every(status => status === 'unavailable')) {
      return sendError(res, 502, 'OKX volume history unavailable');
    }
    const status = statuses.every(value => value === 'full') ? 'full' : 'partial';
    res.setHeader('X-RWA-Upstream-Errors', String(batch.upstreamFailures));
    if (batch.upstreamFailures) setNoStore(res);
    else setSuccessCache(res, typeConfig, status);
    return res.status(200).json(batch.results);
  } catch (error) {
    if (error instanceof RangeError) return sendError(res, 400, error.message);
    console.error(`[okx-market] ${type} unavailable: ${error?.message || 'unknown error'}`);
    return sendError(res, 502, 'OKX market data unavailable');
  }
}

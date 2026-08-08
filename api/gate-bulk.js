// Serverless function: batch-fetch a bounded set of Gate.io public-market data.
// The upstream host and endpoint paths are constants; user input is only ever
// encoded into documented query parameters, so this route cannot become an
// arbitrary proxy.

import {
  fetchJsonWithPolicy,
  mapWithConcurrency,
  setNoStore,
  setPublicCache,
} from './_lib/upstream.js';

const GATE_API_BASE = 'https://api.gateio.ws/api/v4';
const GATE_FUTURES_BASE = `${GATE_API_BASE}/futures/usdt`;
const GATE_SPOT_BASE = `${GATE_API_BASE}/spot`;

const MAX_SYMBOLS = 80;
const MAX_SYMBOL_PARAM_LENGTH = 3_400;
const MAX_KLINE_RANGE_SECONDS = 35 * 24 * 60 * 60;
const MAX_KLINE_AGE_SECONDS = 36 * 24 * 60 * 60;
const MAX_KLINE_POINTS = 100;
const MAX_FUTURE_SKEW_SECONDS = 5 * 60;
const UPSTREAM_TIMEOUT_MS = 4_000;
const UPSTREAM_CONCURRENCY = 10;
const GROWTH_CANDLE_TIMEOUT_MS = 2_000;
const GROWTH_CONCURRENCY = 32;
const GROWTH_BUCKET_SECONDS = 5 * 60;
const GROWTH_WINDOW_SECONDS = 48 * 60 * 60;
const GROWTH_HALF_SECONDS = 24 * 60 * 60;
const MIN_GROWTH_SAMPLES_PER_HALF = 10;
const MAX_GROWTH_CONTRACTS = 500;

const FUTURES_SYMBOL_RE = /^[A-Z0-9]{1,30}_USDT$/;
const SPOT_SYMBOL_RE = /^[A-Z0-9]{1,30}_(?:USDT|USD)$/;
const DEPTH_LIMITS = new Set([5, 10, 20, 50, 100]);
const FUNDING_LIMITS = new Set([10, 20, 50, 100, 200, 500, 1_000]);
const GATE_RWA_CONTRACT_TYPES = new Set(['stocks', 'metals', 'commodities', 'indices', 'forex']);
const PERP_CONTRACT_FIELDS = ['name', 'status', 'contract_type', 'is_pre_market', 'maker_fee_rate', 'taker_fee_rate', 'quanto_multiplier', 'funding_interval', 'mark_price', 'index_price', 'last_price', 'position_size', 'funding_rate', 'funding_rate_indicative'];
const PERP_TICKER_FIELDS = ['contract', 'mark_price', 'index_price', 'last', 'change_percentage', 'volume_24h_quote', 'volume_24h_usd', 'total_size', 'funding_rate', 'funding_rate_indicative'];
const SPOT_PAIR_FIELDS = ['id', 'base', 'quote', 'trade_status'];
const SPOT_TICKER_FIELDS = ['currency_pair', 'last', 'change_percentage', 'quote_volume', 'base_volume', 'high_24h', 'low_24h', 'highest_bid', 'lowest_ask'];
const KLINE_INTERVAL_SECONDS = Object.freeze({
  '1m': 60,
  '5m': 5 * 60,
  '15m': 15 * 60,
  '30m': 30 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '8h': 8 * 60 * 60,
  '1d': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
});

const TYPE_CONFIG = Object.freeze({
  depth: {
    queryKeys: new Set(['type', 'symbols', 'limit']),
    symbolPattern: FUTURES_SYMBOL_RE,
    defaultLimit: 50,
    allowedLimits: DEPTH_LIMITS,
    cacheSeconds: 30,
    staleSeconds: 120,
  },
  funding: {
    queryKeys: new Set(['type', 'symbols', 'limit']),
    symbolPattern: FUTURES_SYMBOL_RE,
    defaultLimit: 100,
    allowedLimits: FUNDING_LIMITS,
    cacheSeconds: 60,
    staleSeconds: 300,
  },
  klines: {
    queryKeys: new Set(['type', 'symbols', 'from', 'to', 'interval']),
    symbolPattern: FUTURES_SYMBOL_RE,
    cacheSeconds: 300,
    staleSeconds: 900,
  },
  'spot-depth': {
    queryKeys: new Set(['type', 'symbols', 'limit']),
    symbolPattern: SPOT_SYMBOL_RE,
    defaultLimit: 50,
    allowedLimits: DEPTH_LIMITS,
    cacheSeconds: 30,
    staleSeconds: 120,
  },
  growth: {
    queryKeys: new Set(['type']),
    cacheSeconds: 900,
    staleSeconds: 3_600,
    partialCacheSeconds: 900,
    partialStaleSeconds: 3_600,
  },
  'perp-snapshot': {
    queryKeys: new Set(['type']),
    cacheSeconds: 30,
    staleSeconds: 120,
  },
  'spot-snapshot': {
    queryKeys: new Set(['type']),
    cacheSeconds: 30,
    staleSeconds: 120,
  },
});

const FIXED_TYPES = new Set(['growth', 'perp-snapshot', 'spot-snapshot']);

export const config = { maxDuration: 60 };

function sendError(res, status, message) {
  setNoStore(res);
  return res.status(status).json({ error: message });
}

function singleQueryValue(value) {
  return typeof value === 'string' ? value : null;
}

function parseStrictInteger(value, name) {
  const raw = singleQueryValue(value);
  if (raw === null || !/^\d+$/.test(raw)) {
    throw new TypeError(`Invalid ${name} param`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`Invalid ${name} param`);
  return parsed;
}

function parseSymbols(value, pattern) {
  const raw = singleQueryValue(value);
  if (!raw || raw.length > MAX_SYMBOL_PARAM_LENGTH) {
    throw new TypeError('Invalid symbols param');
  }

  const candidates = raw.split(',');
  if (candidates.length === 0 || candidates.length > MAX_SYMBOLS) {
    throw new TypeError(`symbols must contain 1-${MAX_SYMBOLS} entries`);
  }

  const symbols = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const symbol = candidate.toUpperCase();
    if (!symbol || candidate !== symbol || !pattern.test(symbol) || seen.has(symbol)) {
      throw new TypeError('Invalid symbols param');
    }
    seen.add(symbol);
    symbols.push(symbol);
  }
  const sorted = [...symbols].sort();
  if (symbols.some((symbol, index) => symbol !== sorted[index])) {
    throw new TypeError('symbols must be unique uppercase values in lexical order');
  }
  return symbols;
}

function rejectUnexpectedQueryKeys(query, allowedKeys) {
  if (Object.keys(query || {}).some(key => !allowedKeys.has(key))) {
    throw new TypeError('Unexpected query param');
  }
}

function parseLimit(value, config) {
  if (value === undefined) return config.defaultLimit;
  const limit = parseStrictInteger(value, 'limit');
  if (!config.allowedLimits.has(limit)) {
    throw new TypeError(`Invalid limit param; allowed: ${[...config.allowedLimits].join(',')}`);
  }
  return limit;
}

function parseKlineWindow(query) {
  const from = parseStrictInteger(query.from, 'from');
  const to = parseStrictInteger(query.to, 'to');
  const interval = singleQueryValue(query.interval);
  const intervalSeconds = KLINE_INTERVAL_SECONDS[interval];
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (!intervalSeconds) throw new TypeError('Invalid interval param');
  if (from <= 0 || to <= from) throw new TypeError('Invalid kline time range');
  if (from % GROWTH_BUCKET_SECONDS !== 0 || to % GROWTH_BUCKET_SECONDS !== 0) {
    throw new TypeError('Kline from/to must align to a 5-minute bucket');
  }
  if (to - from > MAX_KLINE_RANGE_SECONDS) {
    throw new TypeError('Kline time range exceeds 35 days');
  }
  if (from < nowSeconds - MAX_KLINE_AGE_SECONDS || to > nowSeconds + MAX_FUTURE_SKEW_SECONDS) {
    throw new TypeError('Kline time range must cover recent market data');
  }

  // Raw candles are returned for as many as 80 symbols. Keep each symbol well
  // below Gate's own 2,000-point ceiling to bound the cached response size.
  const estimatedPoints = Math.ceil((to - from) / intervalSeconds) + 1;
  if (estimatedPoints > MAX_KLINE_POINTS) {
    throw new TypeError(`Kline time range exceeds ${MAX_KLINE_POINTS} points`);
  }
  return { from, to, interval };
}

function buildUrl(type, symbol, options) {
  const params = new URLSearchParams();
  if (type === 'depth') {
    params.set('contract', symbol);
    params.set('limit', String(options.limit));
    return `${GATE_FUTURES_BASE}/order_book?${params}`;
  }
  if (type === 'funding') {
    params.set('contract', symbol);
    params.set('limit', String(options.limit));
    return `${GATE_FUTURES_BASE}/funding_rate?${params}`;
  }
  if (type === 'klines') {
    params.set('contract', symbol);
    params.set('from', String(options.from));
    params.set('to', String(options.to));
    params.set('interval', options.interval);
    return `${GATE_FUTURES_BASE}/candlesticks?${params}`;
  }
  if (type === 'spot-depth') {
    params.set('currency_pair', symbol);
    params.set('limit', String(options.limit));
    return `${GATE_SPOT_BASE}/order_book?${params}`;
  }
  throw new TypeError('Invalid type param');
}

function isExpectedPayload(type, payload) {
  if (type === 'funding' || type === 'klines') return Array.isArray(payload);
  return Boolean(
    payload &&
    !Array.isArray(payload) &&
    Array.isArray(payload.bids) &&
    Array.isArray(payload.asks)
  );
}

function setResultCache(res, typeConfig, failureCount, totalCount) {
  if (failureCount > 0 && failureCount < totalCount) {
    setPublicCache(
      res,
      typeConfig.partialCacheSeconds ?? Math.min(typeConfig.cacheSeconds, 30),
      typeConfig.partialStaleSeconds ?? Math.min(typeConfig.staleSeconds, 120)
    );
    return;
  }
  setPublicCache(res, typeConfig.cacheSeconds, typeConfig.staleSeconds);
}

function projectFields(row, fields) {
  return Object.fromEntries(fields
    .filter(field => row?.[field] !== undefined)
    .map(field => [field, row[field]]));
}

function normalizeGrowthCandles(candles, from, midpoint, to) {
  if (!Array.isArray(candles)) return null;
  let prevVol = 0;
  let currVol = 0;
  let prevSamples = 0;
  let currSamples = 0;

  for (const candle of candles) {
    const timestamp = Number(candle?.t);
    const volume = Number(candle?.v);
    const close = Number(candle?.c);
    if (!Number.isFinite(timestamp) || timestamp < from || timestamp >= to ||
        !Number.isFinite(volume) || volume < 0 || !Number.isFinite(close) || close <= 0) {
      continue;
    }
    const notional = volume * close;
    if (!Number.isFinite(notional)) continue;
    if (timestamp < midpoint) {
      prevVol += notional;
      prevSamples += 1;
    } else {
      currVol += notional;
      currSamples += 1;
    }
  }

  if (prevSamples < MIN_GROWTH_SAMPLES_PER_HALF || currSamples < MIN_GROWTH_SAMPLES_PER_HALF || prevVol <= 0) {
    return null;
  }
  return {
    prevVol,
    currVol,
    growth: ((currVol - prevVol) / prevVol) * 100,
  };
}

async function fetchGrowthBatch() {
  const catalog = await fetchJsonWithPolicy(
    `${GATE_FUTURES_BASE}/contracts`,
    { headers: { Accept: 'application/json' } },
    { timeoutMs: 5_000, retries: 1, baseDelayMs: 200 }
  );
  if (!Array.isArray(catalog)) throw new TypeError('Invalid Gate contracts catalog');

  const contracts = [...new Set(catalog
    .filter(contract => contract?.status === 'trading' && GATE_RWA_CONTRACT_TYPES.has(contract?.contract_type))
    .map(contract => String(contract?.name || ''))
    .filter(symbol => FUTURES_SYMBOL_RE.test(symbol)))]
    .sort();
  if (contracts.length === 0 || contracts.length > MAX_GROWTH_CONTRACTS) {
    throw new TypeError('Invalid Gate RWA contract catalog size');
  }

  const to = Math.floor(Date.now() / 1000 / GROWTH_BUCKET_SECONDS) * GROWTH_BUCKET_SECONDS;
  const from = to - GROWTH_WINDOW_SECONDS;
  const midpoint = to - GROWTH_HALF_SECONDS;
  // Hard budget: at most ceil(500/32) * 2s plus at most ~10.2s catalog
  // retries, leaving margin inside the 60-second function duration.
  const entries = await mapWithConcurrency(contracts, GROWTH_CONCURRENCY, async symbol => {
    try {
      const candles = await fetchJsonWithPolicy(
        buildUrl('klines', symbol, { from, to, interval: '1h' }),
        { headers: { Accept: 'application/json' } },
        { timeoutMs: GROWTH_CANDLE_TIMEOUT_MS, retries: 0 }
      );
      return [symbol, normalizeGrowthCandles(candles, from, midpoint, to)];
    } catch {
      return [symbol, null];
    }
  });

  return {
    results: Object.fromEntries(entries),
    failureCount: entries.reduce((count, [, payload]) => count + (payload === null ? 1 : 0), 0),
    totalCount: entries.length,
  };
}

async function fetchMarketSnapshot(type) {
  const resources = type === 'perp-snapshot'
    ? [
        ['contracts', `${GATE_FUTURES_BASE}/contracts`],
        ['tickers', `${GATE_FUTURES_BASE}/tickers`],
      ]
    : [
        ['pairs', `${GATE_SPOT_BASE}/currency_pairs`],
        ['tickers', `${GATE_SPOT_BASE}/tickers`],
      ];
  const settled = await Promise.allSettled(resources.map(([, url]) => fetchJsonWithPolicy(
    url,
    { headers: { Accept: 'application/json' } },
    { timeoutMs: UPSTREAM_TIMEOUT_MS, retries: 1, baseDelayMs: 200 }
  )));
  const results = Object.fromEntries(resources.map(([key], index) => [
    key,
    settled[index].status === 'fulfilled' && Array.isArray(settled[index].value)
      ? settled[index].value
      : null,
  ]));
  const failureCount = Object.values(results).filter(value => value === null).length;
  if (type === 'perp-snapshot' && !results.contracts?.length) {
    throw new TypeError('Gate contracts unavailable');
  }
  if (type === 'spot-snapshot' && !results.pairs?.length) {
    throw new TypeError('Gate spot catalog unavailable');
  }
  Object.keys(results).forEach(key => {
    if (results[key] === null) results[key] = [];
  });
  if (type === 'perp-snapshot') {
    results.contracts = results.contracts.filter(contract =>
      contract?.status === 'trading' && GATE_RWA_CONTRACT_TYPES.has(contract?.contract_type)
    );
    if (!results.contracts.length || results.contracts.length > MAX_GROWTH_CONTRACTS) {
      throw new TypeError('Invalid Gate RWA contract catalog size');
    }
    const allowedContracts = new Set(results.contracts.map(contract => contract.name));
    results.contracts = results.contracts.map(contract => projectFields(contract, PERP_CONTRACT_FIELDS));
    results.tickers = results.tickers
      .filter(ticker => allowedContracts.has(ticker?.contract))
      .map(ticker => projectFields(ticker, PERP_TICKER_FIELDS));
  } else {
    results.pairs = results.pairs
      .filter(pair => ['USDT', 'USD'].includes(String(pair?.quote || '').toUpperCase()) && pair?.trade_status === 'tradable')
      .map(pair => projectFields(pair, SPOT_PAIR_FIELDS));
    if (!results.pairs.length) throw new TypeError('Gate spot catalog has no tradable USD pairs');
    const allowedPairs = new Set(results.pairs.map(pair => pair.id));
    results.tickers = results.tickers
      .filter(ticker => allowedPairs.size
        ? allowedPairs.has(ticker?.currency_pair)
        : /_(?:USDT|USD)$/.test(String(ticker?.currency_pair || '')))
      .map(ticker => projectFields(ticker, SPOT_TICKER_FIELDS));
  }
  return { results, failureCount, totalCount: resources.length };
}

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendError(res, 405, 'Method not allowed');
  }

  const type = singleQueryValue(req.query?.type);
  const config = type ? TYPE_CONFIG[type] : null;
  if (!config) return sendError(res, 400, 'Invalid type param');

  let symbols;
  let options;
  try {
    rejectUnexpectedQueryKeys(req.query, config.queryKeys);
    if (!FIXED_TYPES.has(type)) {
      symbols = parseSymbols(req.query.symbols, config.symbolPattern);
      options = type === 'klines'
        ? parseKlineWindow(req.query)
        : { limit: parseLimit(req.query.limit, config) };
    }
  } catch (error) {
    return sendError(res, 400, error.message);
  }

  if (type === 'growth') {
    try {
      const batch = await fetchGrowthBatch();
      if (batch.failureCount === batch.totalCount) {
        return sendError(res, 502, 'Gate growth data unavailable');
      }
      if (batch.failureCount > 0) {
        console.warn(`[gate-bulk] growth: ${batch.failureCount}/${batch.totalCount} contracts unavailable`);
      }
      setResultCache(res, config, batch.failureCount, batch.totalCount);
      return res.status(200).json(batch.results);
    } catch (error) {
      console.error(`[gate-bulk] growth catalog unavailable: ${error?.message || 'unknown error'}`);
      return sendError(res, 502, 'Gate contracts catalog unavailable');
    }
  }

  if (type === 'perp-snapshot' || type === 'spot-snapshot') {
    try {
      const batch = await fetchMarketSnapshot(type);
      if (batch.failureCount > 0) {
        console.warn(`[gate-bulk] ${type}: ${batch.failureCount}/${batch.totalCount} resources unavailable`);
      }
      setResultCache(res, config, batch.failureCount, batch.totalCount);
      return res.status(200).json(batch.results);
    } catch (error) {
      console.error(`[gate-bulk] ${type} unavailable: ${error?.message || 'unknown error'}`);
      return sendError(res, 502, 'Gate market snapshot unavailable');
    }
  }

  const entries = await mapWithConcurrency(symbols, UPSTREAM_CONCURRENCY, async symbol => {
    try {
      const payload = await fetchJsonWithPolicy(
        buildUrl(type, symbol, options),
        { headers: { Accept: 'application/json' } },
        { timeoutMs: UPSTREAM_TIMEOUT_MS, retries: 0 }
      );
      return [symbol, isExpectedPayload(type, payload) ? payload : null];
    } catch {
      return [symbol, null];
    }
  });

  const results = Object.fromEntries(entries);
  const failureCount = entries.reduce((count, [, payload]) => count + (payload === null ? 1 : 0), 0);
  if (failureCount > 0) {
    console.warn(`[gate-bulk] ${type}: ${failureCount}/${symbols.length} upstream requests unavailable`);
  }
  if (failureCount === symbols.length) {
    return sendError(res, 502, 'Gate upstream unavailable');
  }

  setResultCache(res, config, failureCount, symbols.length);
  return res.status(200).json(results);
}

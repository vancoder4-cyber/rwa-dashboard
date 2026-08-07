import { fetchJsonWithPolicy, mapWithConcurrency, setPublicCache } from './_lib/upstream.js';
import { FX_REFERENCE_MAP, yahooSymbolFor } from './_lib/reference-map.js';

export const config = { regions: ['sin1'], maxDuration: 30 };

const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const MAX_SYMBOLS = 80;

function lastFinite(values = []) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = Number(values[index]);
    if (Number.isFinite(value) && value > 0) return { value, index };
  }
  return null;
}

function sessionForTimestamp(meta, timestampSeconds) {
  const periods = meta?.currentTradingPeriod || {};
  for (const [name, period] of Object.entries(periods)) {
    if (timestampSeconds >= Number(period?.start) && timestampSeconds <= Number(period?.end)) {
      return name === 'regular' ? 'REGULAR' : name.toUpperCase();
    }
  }
  return 'CLOSED';
}

async function fetchYahooChart(yahooSymbol) {
  let lastError = null;
  for (const host of YAHOO_HOSTS) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=5m&range=5d&includePrePost=true&events=div%2Csplits`;
      const payload = await fetchJsonWithPolicy(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; Avenir-RWA-Analyst/1.0)',
        },
      }, { timeoutMs: 10000, retries: 1 });
      const result = payload?.chart?.result?.[0];
      if (!result?.meta) throw new Error('Missing Yahoo chart metadata');
      return result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Yahoo reference unavailable');
}

function parseChart(result) {
  const meta = result?.meta || {};
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const lastBar = lastFinite(closes);
  const regularPrice = Number(meta.regularMarketPrice);
  const regularTime = Number(meta.regularMarketTime);
  const barTime = lastBar ? Number(timestamps[lastBar.index]) : 0;
  const useBar = lastBar && barTime >= regularTime && Date.now() / 1000 - barTime < 5 * 24 * 3600;
  const price = useBar ? lastBar.value : regularPrice;
  const asOfSeconds = useBar ? barTime : regularTime;
  if (!Number.isFinite(price) || price <= 0) throw new Error('No positive reference price');
  return {
    price,
    asOfSeconds,
    session: sessionForTimestamp(meta, asOfSeconds),
    currency: String(meta.currency || 'USD'),
    exchange: meta.fullExchangeName || meta.exchangeName || null,
    instrumentType: meta.instrumentType || null,
    delaySeconds: Number(meta.exchangeDataDelayedBy) || 0,
    previousClose: Number(meta.chartPreviousClose ?? meta.previousClose) || null,
    priceKind: useBar && barTime > regularTime ? 'extended-hours' : 'regular-market',
  };
}

async function buildFxResolver() {
  const cache = new Map();
  return async function resolveFx(currency) {
    if (currency === 'USD') return { rate: 1, mode: 'identity', symbol: 'USD' };
    const spec = FX_REFERENCE_MAP[currency];
    if (!spec) return null;
    if (!cache.has(currency)) {
      cache.set(currency, fetchYahooChart(spec.symbol).then(parseChart).then(row => ({
        rate: row.price,
        mode: spec.mode,
        symbol: spec.symbol,
        asOfSeconds: row.asOfSeconds,
      })).catch(() => null));
    }
    return cache.get(currency);
  };
}

function convertToUsd(price, fx) {
  if (!fx || !Number.isFinite(fx.rate) || fx.rate <= 0) return null;
  if (fx.mode === 'identity') return price;
  if (fx.mode === 'divide') return price / fx.rate;
  if (fx.mode === 'multiply') return price * fx.rate;
  if (fx.mode === 'pence-multiply') return (price / 100) * fx.rate;
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const symbols = [...new Set(String(req.query.symbols || '')
    .split(',')
    .map(symbol => symbol.trim().toUpperCase())
    .filter(symbol => /^[A-Z0-9.^=-]{1,20}$/.test(symbol)))]
    .slice(0, MAX_SYMBOLS);
  if (!symbols.length) return res.status(400).json({ error: 'No valid symbols' });

  const resolveFx = await buildFxResolver();
  const rows = await mapWithConcurrency(symbols, 8, async symbol => {
    const yahooSymbol = yahooSymbolFor(symbol);
    try {
      const native = parseChart(await fetchYahooChart(yahooSymbol));
      const fx = await resolveFx(native.currency);
      const usdPrice = convertToUsd(native.price, fx);
      if (!usdPrice) {
        return [symbol, {
          status: 'unavailable', source: 'Yahoo Finance', yahooSymbol,
          reason: `Unsupported reference currency ${native.currency}`,
        }];
      }
      return [symbol, {
        price: usdPrice,
        nativePrice: native.price,
        nativeCurrency: native.currency,
        currency: 'USD',
        source: 'Yahoo Finance',
        yahooSymbol,
        status: native.currency === 'USD' ? 'full' : 'estimated',
        derived: native.currency !== 'USD',
        fxSymbol: native.currency === 'USD' ? null : fx?.symbol || null,
        fxRate: native.currency === 'USD' ? null : fx?.rate || null,
        exchange: native.exchange,
        instrumentType: native.instrumentType,
        session: native.session,
        priceKind: native.priceKind,
        delayedBySeconds: native.delaySeconds,
        previousClose: native.previousClose,
        asOf: native.asOfSeconds ? new Date(native.asOfSeconds * 1000).toISOString() : null,
      }];
    } catch (error) {
      return [symbol, {
        status: 'unavailable', source: 'Yahoo Finance', yahooSymbol,
        reason: error.message,
      }];
    }
  });

  const generatedAt = new Date().toISOString();
  setPublicCache(res, 120, 600);
  return res.status(200).json({ generatedAt, rows: Object.fromEntries(rows) });
}

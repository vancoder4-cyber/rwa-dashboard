import { fetchJsonWithPolicy, mapWithConcurrency, setPublicCache } from './_lib/upstream.js';

export const config = { regions: ['sin1'], maxDuration: 30 };

const HYPERLIQUID_INFO = 'https://api.hyperliquid.xyz/info';
const BINANCE_FUTURES = 'https://fapi.binance.com/fapi/v1';
const BITGET_FUTURES = 'https://api.bitget.com';
const GATE_FUTURES = 'https://api.gateio.ws/api/v4/futures/usdt';
const SUPPORTED_VENUES = new Set(['tradexyz', 'binance', 'bitget', 'gate']);

function normalizedRow(time, rate) {
  const numericTime = Number(time);
  const numericRate = Number(rate);
  if (!Number.isFinite(numericTime) || numericTime <= 0 || !Number.isFinite(numericRate)) return null;
  return {
    fundingTime: numericTime < 1e12 ? numericTime * 1000 : numericTime,
    fundingRate: numericRate,
  };
}

export function normalizeHistoryRows(venue, payload, startTime) {
  const sourceRows = Array.isArray(payload) ? payload : [];
  const rows = sourceRows.map(row => {
    if (venue === 'gate') return normalizedRow(row?.t, row?.r ?? row?.rate);
    if (venue === 'bitget') return normalizedRow(row?.fundingTime ?? row?.settleTime, row?.fundingRate ?? row?.fundRate);
    return normalizedRow(row?.fundingTime ?? row?.time, row?.fundingRate ?? row?.fundRate);
  }).filter(Boolean)
    .filter(row => row.fundingTime >= startTime - 15 * 60 * 1000)
    .sort((a, b) => a.fundingTime - b.fundingTime);

  const deduped = [];
  for (const row of rows) {
    const previous = deduped[deduped.length - 1];
    if (previous?.fundingTime === row.fundingTime) previous.fundingRate = row.fundingRate;
    else deduped.push(row);
  }
  return deduped;
}

export function historyCoverage(rows, hours) {
  if (!Array.isArray(rows) || rows.length < 2) {
    return { status: 'unavailable', expected: null, observed: rows?.length || 0 };
  }
  const gaps = rows.slice(1).map((row, index) => row.fundingTime - rows[index].fundingTime)
    .filter(gap => Number.isFinite(gap) && gap > 0)
    .sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)] || 8 * 3600 * 1000;
  const intervalHours = Math.max(1, medianGap / 3600_000);
  const expected = Math.max(1, Math.floor(hours / intervalHours));
  const observed = rows.length;
  return {
    status: observed >= Math.max(2, Math.ceil(expected * 0.8)) ? 'full' : 'partial',
    expected,
    observed,
  };
}

async function fetchTradexyz(symbol, startTime) {
  const candidates = symbol.includes(':') ? [symbol] : [`xyz:${symbol}`, symbol];
  let lastError = null;
  for (const coin of candidates) {
    try {
      const data = await fetchJsonWithPolicy(HYPERLIQUID_INFO, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'fundingHistory', coin, startTime }),
      }, { timeoutMs: 12000, retries: 2, baseDelayMs: 500 });
      if (Array.isArray(data) && data.length) return data;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return [];
}

async function fetchVenueHistory(venue, symbol, startTime, limit) {
  if (venue === 'tradexyz') return fetchTradexyz(symbol, startTime);
  if (venue === 'binance') {
    return fetchJsonWithPolicy(`${BINANCE_FUTURES}/fundingRate?symbol=${encodeURIComponent(symbol)}&startTime=${startTime}&limit=${limit}`, {}, { timeoutMs: 10000, retries: 2 });
  }
  if (venue === 'bitget') {
    const payload = await fetchJsonWithPolicy(`${BITGET_FUTURES}/api/v2/mix/market/history-fund-rate?symbol=${encodeURIComponent(symbol)}&productType=USDT-FUTURES&limit=${Math.min(limit, 100)}`, {}, { timeoutMs: 10000, retries: 2 });
    if (payload?.code !== '00000') throw new Error(`Bitget API ${payload?.code || 'unknown'}`);
    return payload.data || [];
  }
  const gateUrl = `${GATE_FUTURES}/funding_rate?contract=${encodeURIComponent(symbol)}&limit=${Math.min(limit, 1000)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const payload = await fetchJsonWithPolicy(gateUrl, {}, { timeoutMs: 10000, retries: 2 });
    if (Array.isArray(payload) && payload.length) return payload;
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250));
  }
  return [];
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const venue = String(req.query.venue || '').toLowerCase();
  if (!SUPPORTED_VENUES.has(venue)) return res.status(400).json({ error: 'Unsupported venue' });
  const symbols = [...new Set(String(req.query.symbols || '')
    .split(',')
    .map(symbol => symbol.trim())
    .filter(symbol => /^[A-Za-z0-9:_-]{2,50}$/.test(symbol)))]
    .slice(0, 40);
  if (!symbols.length) return res.status(400).json({ error: 'No valid symbols' });
  const requestedHours = Number(req.query.hours);
  const hours = Number.isFinite(requestedHours) ? Math.min(Math.max(Math.floor(requestedHours), 1), 720) : 24;
  const startTime = Date.now() - hours * 3600 * 1000;
  const limit = Math.min(Math.max(Math.ceil(hours) + 4, 24), 1000);

  // Hyperliquid applies a relatively tight POST budget. Keep trade.xyz at two
  // concurrent histories even when multiple CDN chunks arrive together.
  const concurrency = venue === 'tradexyz' || venue === 'gate' ? 2 : venue === 'bitget' ? 4 : 6;
  const pairs = await mapWithConcurrency(symbols, concurrency, async symbol => {
    try {
      const payload = await fetchVenueHistory(venue, symbol, startTime, limit);
      const rows = normalizeHistoryRows(venue, payload, startTime);
      const coverage = historyCoverage(rows, hours);
      return [symbol, {
        rows,
        observed: coverage.observed,
        expected: coverage.expected,
        firstAt: rows[0]?.fundingTime || null,
        lastAt: rows[rows.length - 1]?.fundingTime || null,
        status: coverage.status,
        ...(rows.length ? {} : { reason: 'No observations in the requested window' }),
      }];
    } catch (error) {
      return [symbol, { rows: [], observed: 0, firstAt: null, lastAt: null, status: 'unavailable', error: error.message }];
    }
  });

  const failedCount = pairs.filter(([, result]) => result.status === 'unavailable' && result.error).length;
  res.setHeader('X-RWA-Upstream-Errors', String(failedCount));
  setPublicCache(res, failedCount ? 15 : 60, failedCount ? 30 : 300);
  return res.status(200).json({ venue, hours, generatedAt: new Date().toISOString(), results: Object.fromEntries(pairs) });
}

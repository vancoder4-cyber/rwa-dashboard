// Read-only Binance USDⓈ-M market-data proxy. Running this function from
// Singapore avoids client-region blocks while keeping the browser on same-origin
// requests. Only the four public endpoints used by the dashboard are allowed.

export const config = { regions: ['sin1'], maxDuration: 15 };

const BINANCE_FUTURES_BASE = 'https://fapi.binance.com/fapi/v1';
const ENDPOINTS = {
  exchangeInfo: '/exchangeInfo',
  premiumIndex: '/premiumIndex',
  ticker24hr: '/ticker/24hr',
  fundingInfo: '/fundingInfo',
};

async function fetchKlineTotals(symbols) {
  const results = {};
  const concurrency = 10;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < symbols.length) {
      const symbol = symbols[nextIndex++];
      try {
        const upstream = await fetch(`${BINANCE_FUTURES_BASE}/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&limit=30`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(10000),
        });
        if (!upstream.ok) { results[symbol] = null; continue; }
        const rows = await upstream.json();
        if (!Array.isArray(rows)) { results[symbol] = null; continue; }
        const volume30d = rows.reduce((sum, row) => sum + (Number(row?.[7]) || 0), 0);
        results[symbol] = volume30d > 0 ? { volume30d, candles: rows.length } : null;
      } catch {
        results[symbol] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, worker));
  return results;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const endpoint = String(req.query.endpoint || '');
  if (endpoint === 'klines') {
    const symbols = String(req.query.symbols || '')
      .split(',')
      .map(symbol => symbol.trim().toUpperCase())
      .filter(symbol => /^[A-Z0-9_-]{2,40}$/.test(symbol))
      .slice(0, 80);
    if (!symbols.length) return res.status(400).json({ error: 'No valid symbols' });
    const results = await fetchKlineTotals(symbols);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json(results);
  }

  const path = ENDPOINTS[endpoint];
  if (!path) return res.status(400).json({ error: 'Invalid endpoint' });

  try {
    const upstream = await fetch(`${BINANCE_FUTURES_BASE}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    const body = await upstream.text();
    if (!upstream.ok) {
      return res.status(502).json({ error: 'Binance upstream unavailable', upstreamStatus: upstream.status });
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=120');
    return res.status(200).send(body);
  } catch (error) {
    return res.status(504).json({ error: 'Binance upstream timeout' });
  }
}

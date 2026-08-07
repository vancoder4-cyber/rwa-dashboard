// Aggregate trade.xyz (Hyperliquid HIP-3) 30-day candles server-side. Returning
// totals instead of raw candles keeps the dashboard response compact and avoids
// dozens of large, rate-limit-prone browser requests.

export const config = { regions: ['sin1'], maxDuration: 30 };

const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
const MAX_RANGE_MS = 35 * 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const symbols = String(req.query.symbols || '')
    .split(',')
    .map(symbol => symbol.trim())
    .filter(symbol => /^[A-Za-z0-9:_-]{2,50}$/.test(symbol))
    .slice(0, 80);
  const startTime = Number(req.query.startTime);
  const endTime = Number(req.query.endTime);
  if (!symbols.length) return res.status(400).json({ error: 'No valid symbols' });
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime <= 0 || endTime <= startTime || endTime - startTime > MAX_RANGE_MS) {
    return res.status(400).json({ error: 'Invalid time range' });
  }

  const results = {};
  const concurrency = 8;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < symbols.length) {
      const symbol = symbols[nextIndex++];
      const coin = symbol.includes(':') ? symbol : `xyz:${symbol}`;
      try {
        const upstream = await fetch(HYPERLIQUID_INFO_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'candleSnapshot',
            req: { coin, interval: '1h', startTime, endTime },
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!upstream.ok) { results[symbol] = null; continue; }
        const rows = await upstream.json();
        if (!Array.isArray(rows) || rows.length < 10) { results[symbol] = null; continue; }
        const volume30d = rows.reduce((sum, row) => {
          const baseVolume = Number(row?.v) || 0;
          const close = Number(row?.c) || 0;
          return sum + baseVolume * close;
        }, 0);
        results[symbol] = volume30d > 0 ? { volume30d, candles: rows.length } : null;
      } catch {
        results[symbol] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, worker));
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  return res.status(200).json(results);
}

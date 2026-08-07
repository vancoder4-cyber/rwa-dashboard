// Serverless function: batch-fetch Gate.io data to reduce Vercel edge requests
// Instead of 55+ individual proxy calls, the dashboard makes 1 call here.
// Usage: /api/gate-bulk?type=depth&symbols=XAU_USDT,XAG_USDT,...
//        /api/gate-bulk?type=funding&symbols=XAU_USDT,XAG_USDT,...&limit=100

const GATE_BASE = 'https://api.gateio.ws/api/v4/futures/usdt';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { type, symbols, limit, from, to, interval } = req.query;

  if (!type || !symbols) {
    return res.status(400).json({ error: 'Missing type or symbols param' });
  }

  if (!['depth', 'funding', 'klines'].includes(type)) {
    return res.status(400).json({ error: 'Invalid type param' });
  }
  const symList = String(symbols).split(',')
    .map(s => s.toUpperCase())
    .filter(s => /^[A-Z0-9_-]{2,40}$/.test(s))
    .slice(0, 80);
  if (symList.length === 0) return res.status(400).json({ error: 'No valid symbols' });
  const limitNumber = limit === undefined ? 50 : Number(limit);
  if (!Number.isFinite(limitNumber)) return res.status(400).json({ error: 'Invalid limit param' });
  const safeLimit = Math.min(Math.max(Math.floor(limitNumber), 1), 1000);
  const fromNumber = Number(from);
  const toNumber = Number(to);
  const MAX_KLINE_RANGE_SECONDS = 35 * 24 * 60 * 60;
  if (type === 'klines' && (
    !Number.isFinite(fromNumber) || !Number.isFinite(toNumber) ||
    fromNumber <= 0 || toNumber <= fromNumber || toNumber - fromNumber > MAX_KLINE_RANGE_SECONDS
  )) {
    return res.status(400).json({ error: 'Invalid or excessive kline time range' });
  }
  const safeFrom = type === 'klines' ? Math.floor(fromNumber) : 0;
  const safeTo = type === 'klines' ? Math.floor(toNumber) : 0;
  const safeInterval = ['10s','1m','5m','15m','30m','1h','4h','8h','1d','7d'].includes(interval) ? interval : '1d';
  const results = {};

  // Build URL for each symbol based on type
  function buildUrl(sym) {
    switch (type) {
      case 'depth':
        return `${GATE_BASE}/order_book?contract=${encodeURIComponent(sym)}&limit=${Math.min(safeLimit, 100)}`;
      case 'funding':
        return `${GATE_BASE}/funding_rate?contract=${encodeURIComponent(sym)}&limit=${safeLimit}`;
      case 'klines':
        if (!safeFrom || !safeTo) return null;
        return `${GATE_BASE}/candlesticks?contract=${encodeURIComponent(sym)}&from=${safeFrom}&to=${safeTo}&interval=${safeInterval}`;
      default:
        return null;
    }
  }

  // Fetch in parallel batches of 10
  const BATCH_SIZE = 10;
  for (let i = 0; i < symList.length; i += BATCH_SIZE) {
    const batch = symList.slice(i, i + BATCH_SIZE);
    const fetches = batch.map(async (sym) => {
      const url = buildUrl(sym);
      if (!url) { results[sym] = null; return; }
      try {
        const r = await fetch(url);
        if (!r.ok) { results[sym] = null; return; }
        results[sym] = await r.json();
      } catch {
        results[sym] = null;
      }
    });
    await Promise.all(fetches);
  }

  // Cache the response at Vercel CDN for 30s, serve stale for 60s while revalidating
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  return res.status(200).json(results);
}

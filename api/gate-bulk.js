// Serverless function: batch-fetch Gate.io data to reduce Vercel edge requests
// Instead of 55+ individual proxy calls, the dashboard makes 1 call here.
// Usage: /api/gate-bulk?type=depth&symbols=XAU_USDT,XAG_USDT,...
//        /api/gate-bulk?type=funding&symbols=XAU_USDT,XAG_USDT,...&limit=100

const GATE_BASE = 'https://api.gateio.ws/api/v4/futures/usdt';

export default async function handler(req, res) {
  const { type, symbols, limit, from, to, interval } = req.query;

  if (!type || !symbols) {
    return res.status(400).json({ error: 'Missing type or symbols param' });
  }

  const symList = symbols.split(',').filter(Boolean).slice(0, 80); // cap at 80
  const results = {};

  // Build URL for each symbol based on type
  function buildUrl(sym) {
    switch (type) {
      case 'depth':
        return `${GATE_BASE}/order_book?contract=${encodeURIComponent(sym)}&limit=${limit || 50}`;
      case 'funding':
        return `${GATE_BASE}/funding_rate?contract=${encodeURIComponent(sym)}&limit=${limit || 100}`;
      case 'klines':
        return `${GATE_BASE}/candlesticks?contract=${encodeURIComponent(sym)}&from=${from}&to=${to}&interval=${interval || '1d'}`;
      case 'tickers':
        // For tickers, just fetch all at once (no per-symbol needed)
        return `${GATE_BASE}/tickers`;
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).json(results);
}

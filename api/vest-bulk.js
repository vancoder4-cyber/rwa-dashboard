// Serverless function: batch-fetch Vest data to reduce Vercel edge requests
// Usage: /api/vest-bulk?type=depth&symbols=TSLA-USD,AAPL-USD,...

const VEST_BASE = 'https://server-prod.hz.vestmarkets.com/v2';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { type, symbols, limit } = req.query;

  if (!type || !symbols) {
    return res.status(400).json({ error: 'Missing type or symbols param' });
  }

  if (!['depth', 'ticker', 'oi'].includes(type)) {
    return res.status(400).json({ error: 'Invalid type param' });
  }
  const symList = String(symbols).split(',')
    .map(s => s.toUpperCase())
    .filter(s => /^[A-Z0-9_-]{2,50}$/.test(s))
    .slice(0, 60);
  if (symList.length === 0) return res.status(400).json({ error: 'No valid symbols' });
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const results = {};

  function buildUrl(sym) {
    switch (type) {
      case 'depth':
        return `${VEST_BASE}/depth?symbol=${encodeURIComponent(sym)}&limit=${safeLimit}`;
      case 'ticker':
        return `${VEST_BASE}/ticker/24hr?symbols=${encodeURIComponent(sym)}`;
      case 'oi':
        return `${VEST_BASE}/oi?symbols=${encodeURIComponent(sym)}`;
      default:
        return null;
    }
  }

  const BATCH_SIZE = 10;
  for (let i = 0; i < symList.length; i += BATCH_SIZE) {
    const batch = symList.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (sym) => {
      const url = buildUrl(sym);
      if (!url) { results[sym] = null; return; }
      try {
        const r = await fetch(url);
        if (!r.ok) { results[sym] = null; return; }
        results[sym] = await r.json();
      } catch {
        results[sym] = null;
      }
    }));
  }

  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  return res.status(200).json(results);
}

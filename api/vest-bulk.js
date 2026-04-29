// Serverless function: batch-fetch Vest data to reduce Vercel edge requests
// Usage: /api/vest-bulk?type=depth&symbols=TSLA-USD,AAPL-USD,...

const VEST_BASE = 'https://server-prod.hz.vestmarkets.com/v2';

export default async function handler(req, res) {
  const { type, symbols, limit } = req.query;

  if (!type || !symbols) {
    return res.status(400).json({ error: 'Missing type or symbols param' });
  }

  const symList = symbols.split(',').filter(Boolean).slice(0, 60);
  const results = {};

  function buildUrl(sym) {
    switch (type) {
      case 'depth':
        return `${VEST_BASE}/depth?symbol=${encodeURIComponent(sym)}&limit=${limit || 50}`;
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).json(results);
}

// Batch-fetch trade.xyz (Hyperliquid HIP-3) funding history server-side.
// This keeps the browser from issuing 100+ direct POST requests and being
// throttled by Hyperliquid. Results are short-lived CDN cached.

const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const symbols = String(req.query.symbols || '')
    .split(',')
    .map(symbol => symbol.trim())
    .filter(symbol => /^[A-Za-z0-9:_-]{2,50}$/.test(symbol))
    .slice(0, 40);
  const hoursNumber = Number(req.query.hours);
  const hours = Number.isFinite(hoursNumber)
    ? Math.min(Math.max(Math.floor(hoursNumber), 1), 168)
    : 24;

  if (symbols.length === 0) {
    return res.status(400).json({ error: 'No valid symbols' });
  }

  const startTime = Date.now() - hours * 60 * 60 * 1000;
  const results = {};

  async function fetchHistory(symbol) {
    const candidates = symbol.includes(':') ? [symbol] : [`xyz:${symbol}`, symbol];
    for (const coin of candidates) {
      try {
        const response = await fetch(HYPERLIQUID_INFO_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'fundingHistory', coin, startTime }),
        });
        if (!response.ok) continue;
        const data = await response.json();
        if (Array.isArray(data) && data.length > 0) return data;
      } catch { /* try the next canonical form */ }
    }
    return [];
  }

  // Limit upstream concurrency per function invocation. The browser splits the
  // full catalog into a few cached chunks, so the whole table still fills fast.
  const concurrency = 5;
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < symbols.length) {
      const index = nextIndex++;
      const symbol = symbols[index];
      results[symbol] = await fetchHistory(symbol);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, worker));

  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
  return res.status(200).json(results);
}

// Same-origin cached snapshot of the trade.xyz HIP-3 market catalog/context.
// Keeping this server-side avoids browser-IP throttling deleting the venue.

const INFO_URL = 'https://api.hyperliquid.xyz/info';

async function postInfo(body) {
  const response = await fetch(INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) return null;
  return response.json();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const categoriesPromise = postInfo({ type: 'perpCategories' }).catch(() => []);
  let data = null;
  let source = '';
  for (const dex of ['xyz', 'XYZ', 'tradexyz']) {
    try {
      const candidate = await postInfo({ type: 'metaAndAssetCtxs', dex });
      const universe = Array.isArray(candidate) && candidate.length === 2
        ? (candidate[0]?.universe || candidate[0])
        : null;
      if (Array.isArray(universe) && universe.length > 0 && Array.isArray(candidate[1])) {
        data = candidate;
        source = `dex:${dex}`;
        break;
      }
    } catch { /* try the next canonical DEX name */ }
  }

  // Never fall back to the global Hyperliquid universe here. Joining a bare
  // global ticker such as QNT to xyz:QNT's official stock category can turn an
  // unrelated crypto perpetual into a false RWA listing.
  if (!data) return res.status(502).json({ error: 'Dedicated trade.xyz market data unavailable' });
  const categories = await categoriesPromise;
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');
  return res.status(200).json({ data, categories: Array.isArray(categories) ? categories : [], source });
}

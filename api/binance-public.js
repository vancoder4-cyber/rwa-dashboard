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

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const endpoint = String(req.query.endpoint || '');
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

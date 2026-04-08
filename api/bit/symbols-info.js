// Vercel Serverless Function: proxy Bit.com /symbols-info
// API key is stored in Vercel Environment Variable BIT_API_KEY
const BIT_API_BASE = 'https://mapi.matrixport.com/trader/v2/api';

export default async function handler(req, res) {
  const apiKey = process.env.BIT_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'BIT_API_KEY not configured' });
  }

  try {
    const resp = await fetch(`${BIT_API_BASE}/symbols-info`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Bit-Access-Key': apiKey,
      },
    });
    const data = await resp.json();
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}

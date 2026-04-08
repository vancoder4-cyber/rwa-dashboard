// Vercel Serverless Function: proxy Bit.com /rfq-price with server-side HMAC signing
// Environment Variables: BIT_API_KEY, BIT_API_SECRET
import { createHmac } from 'crypto';

const BIT_API_BASE = 'https://mapi.matrixport.com/trader/v2/api';

export default async function handler(req, res) {
  const apiKey = process.env.BIT_API_KEY;
  const apiSecret = process.env.BIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    return res.status(500).json({ error: 'BIT_API_KEY or BIT_API_SECRET not configured' });
  }

  // Accept query params: symbol, side (default 0=BUY), cash (default 100)
  const symbol = req.query.symbol;
  if (!symbol) {
    return res.status(400).json({ error: 'symbol parameter required' });
  }
  const side = req.query.side || '0';
  const cash = req.query.cash || '100';
  const timestamp = String(Date.now());

  // Build params and compute HMAC-SHA256 signature
  const params = { symbol, side, cash, timestamp };
  const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const signature = createHmac('sha256', apiSecret).update(sorted).digest('hex');

  const qs = `${sorted}&signature=${signature}`;

  try {
    const resp = await fetch(`${BIT_API_BASE}/rfq-price?${qs}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Bit-Access-Key': apiKey,
      },
    });
    const data = await resp.json();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}

// Vercel Serverless Function: proxy Bit.com /rfq-price with server-side HMAC signing
// Matrixport signing: prehash = timestamp + METHOD + path + "&" + body
import { createHmac } from 'crypto';

const BIT_API_HOST = 'https://mapi.matrixport.com';
const API_PATH = '/trader/v2/api/rfq-price';

export default async function handler(req, res) {
  const apiKey = (process.env.BIT_API_KEY || '').trim();
  const apiSecret = (process.env.BIT_API_SECRET || '').trim();
  if (!apiKey || !apiSecret) {
    return res.status(500).json({ error: 'BIT_API_KEY or BIT_API_SECRET not configured' });
  }

  const symbol = req.query.symbol;
  if (!symbol) {
    return res.status(400).json({ error: 'symbol parameter required' });
  }
  const side = req.query.side || '0';
  const cash = req.query.cash || '100';
  const timestamp = String(Date.now());

  // Matrixport sign: timestamp + METHOD + request_path + "&" + body
  // For GET requests, body is empty; query params go in the URL
  const prehash = timestamp + 'GET' + API_PATH + '&';
  const signature = createHmac('sha256', apiSecret).update(prehash).digest('hex');

  const qs = `symbol=${encodeURIComponent(symbol)}&side=${side}&cash=${cash}&timestamp=${timestamp}&signature=${signature}`;

  try {
    const resp = await fetch(`${BIT_API_HOST}${API_PATH}?${qs}`, {
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

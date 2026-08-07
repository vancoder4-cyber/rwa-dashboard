// Vercel Serverless Function: proxy Bit.com /rfq-price with Matrixport Auth V2.
import { createHmac } from 'crypto';

const BIT_API_HOST = 'https://mapi.matrixport.com';
const API_PATH = '/trader/v2/api/rfq-price';
const RFQ_WINDOW_MS = 60_000;
const RFQ_LIMIT_PER_IP = 240;
const rfqWindows = new Map();

function withinRateLimit(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const current = rfqWindows.get(ip);
  if (!current || now - current.startedAt >= RFQ_WINDOW_MS) {
    rfqWindows.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  if (rfqWindows.size > 1000) {
    for (const [key, value] of rfqWindows) {
      if (now - value.startedAt >= RFQ_WINDOW_MS) rfqWindows.delete(key);
    }
  }
  return current.count <= RFQ_LIMIT_PER_IP;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!withinRateLimit(req)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }
  const apiKey = (process.env.BIT_API_KEY || '').trim();
  const apiSecret = (process.env.BIT_API_SECRET || '').trim();
  if (!apiKey || !apiSecret) {
    return res.status(500).json({ error: 'BIT_API_KEY or BIT_API_SECRET not configured' });
  }

  const symbol = String(req.query.symbol || '').toUpperCase();
  if (!/^[A-Z0-9._-]{2,40}$/.test(symbol)) {
    return res.status(400).json({ error: 'invalid symbol parameter' });
  }
  const side = String(req.query.side || '0');
  const cashNumber = Number(req.query.cash || 100);
  if (!['0', '1'].includes(side) || !Number.isFinite(cashNumber) || cashNumber <= 0 || cashNumber > 100000) {
    return res.status(400).json({ error: 'invalid side or cash parameter' });
  }
  const cash = String(cashNumber);
  const timestamp = String(Date.now());

  const params = { cash, side, symbol };
  const query = Object.keys(params)
    .sort()
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&');
  const prehash = `${timestamp}GET${API_PATH}&${query}`;
  const signature = createHmac('sha256', apiSecret).update(prehash).digest('hex');

  try {
    const resp = await fetch(`${BIT_API_HOST}${API_PATH}?${query}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-MatrixPort-Access-Key': apiKey,
        'X-Signature': signature,
        'X-Timestamp': timestamp,
        'X-Auth-Version': 'v2',
      },
    });
    const data = await resp.json();
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}

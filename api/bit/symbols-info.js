// Vercel Serverless Function: proxy Bit.com /symbols-info with HMAC signing
// Matrixport signing: prehash = timestamp + METHOD + path + "&" + body
// signature = HMAC-SHA256(prehash, secret).hex()
import { createHmac } from 'crypto';

const BIT_API_HOST = 'https://mapi.matrixport.com';
const API_PATH = '/trader/v2/api/symbols-info';

export default async function handler(req, res) {
  const apiKey = (process.env.BIT_API_KEY || '').trim();
  const apiSecret = (process.env.BIT_API_SECRET || '').trim();
  if (!apiKey || !apiSecret) {
    return res.status(500).json({ error: 'BIT_API_KEY or BIT_API_SECRET not configured' });
  }

  const timestamp = String(Date.now());
  // Matrixport sign: timestamp + METHOD + request_path + "&" + body
  const prehash = timestamp + 'GET' + API_PATH + '&';
  const signature = createHmac('sha256', apiSecret).update(prehash).digest('hex');

  try {
    const resp = await fetch(`${BIT_API_HOST}${API_PATH}?timestamp=${timestamp}&signature=${signature}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Bit-Access-Key': apiKey,
      },
    });
    const data = await resp.json();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}

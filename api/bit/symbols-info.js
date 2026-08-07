// Vercel Serverless Function: proxy Bit.com /symbols-info with Matrixport Auth V2.
import { createHmac } from 'crypto';

const BIT_API_HOST = 'https://mapi.matrixport.com';
const API_PATH = '/trader/v2/api/symbols-info';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const apiKey = (process.env.BIT_API_KEY || '').trim();
  const apiSecret = (process.env.BIT_API_SECRET || '').trim();
  if (!apiKey || !apiSecret) {
    return res.status(500).json({ error: 'BIT_API_KEY or BIT_API_SECRET not configured' });
  }

  const timestamp = String(Date.now());
  const signature = createHmac('sha256', apiSecret)
    .update(`${timestamp}GET${API_PATH}&`)
    .digest('hex');

  try {
    const resp = await fetch(`${BIT_API_HOST}${API_PATH}`, {
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
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}

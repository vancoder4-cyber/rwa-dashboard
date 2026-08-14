import { timingSafeEqual } from 'node:crypto';

import { setNoStore } from './_lib/upstream.js';
import { serveSignalSnapshot } from './signal-snapshot.js';

export const config = { regions: ['iad1'], maxDuration: 60 };

function authorizedCronRequest(req) {
  const secret = process.env.CRON_SECRET;
  const authorization = typeof req.headers?.authorization === 'string'
    ? req.headers.authorization
    : '';
  if (!secret || !authorization) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const provided = Buffer.from(authorization);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export default function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  setNoStore(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!authorizedCronRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized cron request' });
  }
  // This route is intentionally never CDN cached. If the hourly scheduler hit
  // the public read endpoint, a fresh CDN response could prevent the Function
  // from executing and leave a gap in Runtime Cache history.
  return serveSignalSnapshot(req, res, { publicCache:false, writeHistory:true });
}

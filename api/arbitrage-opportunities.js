import { readAuthoritativeArbitrageSnapshot } from './_lib/arbitrage-authority.js';
import { setNoStore, setPublicCache } from './_lib/upstream.js';
import { unavailableArbitragePayload } from './_lib/arbitrage-analysis.js';

export const config = { regions:['iad1'], maxDuration:15 };

export async function serveArbitrageOpportunities(req, res, options = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    setNoStore(res);
    return res.status(405).json({ error:'Method not allowed' });
  }
  if (Object.keys(req.query || {}).length > 0) {
    setNoStore(res);
    return res.status(400).json({ error:'Unexpected query param' });
  }
  const readSnapshot = options.readSnapshot || readAuthoritativeArbitrageSnapshot;
  let result;
  try {
    result = await readSnapshot({ nowMs:options.nowMs });
  } catch (error) {
    console.error('[arbitrage-opportunities] authoritative read failed', error?.name || 'Error');
    result = { status:'unavailable', payload:null };
  }
  if (result?.status !== 'stored' || !result?.payload) {
    setNoStore(res);
    return res.status(503).json(unavailableArbitragePayload('authoritative-snapshot-unavailable'));
  }
  setPublicCache(res, 15, 30);
  return res.status(200).json(result.payload);
}

export default function handler(req, res) {
  return serveArbitrageOpportunities(req, res);
}

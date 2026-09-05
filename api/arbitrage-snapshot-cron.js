import { timingSafeEqual } from 'node:crypto';

import { collectArbitragePublication } from './_lib/arbitrage-collector.js';
import {
  arbitrageWriteMode,
  writeAuthoritativeArbitragePublication,
} from './_lib/arbitrage-publication.js';
import { setNoStore } from './_lib/upstream.js';

export const config = { regions:['sin1'], maxDuration:300 };

function authorizedCronRequest(req, env = process.env) {
  const secret = String(env?.CRON_SECRET || '');
  const authorization = typeof req.headers?.authorization === 'string' ? req.headers.authorization : '';
  if (!secret || !authorization) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const provided = Buffer.from(authorization);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export async function serveArbitrageSnapshotCron(req, res, options = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  setNoStore(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error:'Method not allowed' });
  }
  if (Object.keys(req.query || {}).length > 0) return res.status(400).json({ error:'Unexpected query param' });
  if (!(options.authorized ?? authorizedCronRequest(req, options.env))) {
    return res.status(401).json({ error:'Unauthorized cron request' });
  }
  const mode = options.writeMode || arbitrageWriteMode(options.env);
  if (!['shadow', 'required'].includes(mode)) {
    return res.status(503).json({ error:'Arbitrage publication writer is disabled' });
  }
  try {
    const collect = options.collect || collectArbitragePublication;
    const write = options.write || writeAuthoritativeArbitragePublication;
    const publication = await collect(req, options.collectOptions);
    const stored = await write(publication);
    return res.status(200).json({
      status:'stored',
      mode,
      generatedAt:publication.snapshot.generatedAt,
      bucket:publication.snapshot.bucket,
      routes:publication.snapshot.routes.length,
      diagnostics:publication.diagnostics,
      snapshotId:stored.snapshotId,
      checksum:stored.checksum,
    });
  } catch (error) {
    console.error('[arbitrage-snapshot-cron] publication failed closed', error);
    return res.status(503).json({
      status:'unavailable',
      error:'Authoritative arbitrage publication failed closed',
      reason:String(error?.message || 'unknown failure').slice(0, 300),
    });
  }
}

export default function handler(req, res) {
  return serveArbitrageSnapshotCron(req, res);
}

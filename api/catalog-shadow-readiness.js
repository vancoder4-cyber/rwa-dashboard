import { timingSafeEqual } from 'node:crypto';

import {
  CATALOG_SHADOW_READINESS_SCHEMA_VERSION,
  catalogShadowRemediation,
  runCatalogShadowReadinessQueries,
} from './_lib/catalog-shadow-readiness.js';
import { readListingAuditCheckpoint } from './_lib/listing-audit-checkpoint.js';
import { fetchJsonWithPolicy, setNoStore } from './_lib/upstream.js';

export const config = { regions: ['iad1'], maxDuration: 60 };

function authorizedReadinessRequest(req, env = process.env) {
  const secret = env.CRON_SECRET;
  const authorization = typeof req.headers?.authorization === 'string'
    ? req.headers.authorization
    : '';
  if (!secret || !authorization) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const provided = Buffer.from(authorization);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function deploymentBaseUrl(req, env = process.env) {
  const forwarded = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').toLowerCase();
  if (/^[a-z0-9.-]+\.vercel\.app$/.test(forwarded)) return `https://${forwarded}`;
  const deployment = env.VERCEL_URL || env.VERCEL_PROJECT_PRODUCTION_URL;
  return `https://${deployment || 'avenir-rwa-analyst.vercel.app'}`;
}

function safeError(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, '[redacted-url]')
    .slice(0, 500);
}

function unavailableReport(error) {
  return {
    schemaVersion:CATALOG_SHADOW_READINESS_SCHEMA_VERSION,
    generatedAt:new Date().toISOString(),
    status:'fail',
    readyForPhase2:false,
    readyForPhase2DesignReview:false,
    decision:'The in-region read-only catalog reconciliation could not run; no writer or read cutover is authorized.',
    scope:{
      phase:'phase1-catalog-shadow',
      marketFactsChecked:false,
      rollingMarketHistoryVerified:false,
      phase2DesignElapsedGate:false,
      laterPhaseTablesConfirmedEmpty:false,
    },
    remediation:catalogShadowRemediation({ status:'fail', hasCurrentCycle:true }),
    error:safeError(error),
    limitations:[
      'This authenticated endpoint performs read-only PostgreSQL reconciliation in the deployed iad1 Function region.',
      'It does not mutate Runtime Cache, PostgreSQL, Blob, deployment state, or notification state.',
    ],
  };
}

function checkpointReaderDiagnostic(result) {
  const status = ['stored', 'empty', 'unavailable'].includes(result?.status)
    ? result.status
    : 'unavailable';
  return {
    status,
    observedAt:status === 'stored' ? result?.observedAt || null : null,
    checksum:status === 'stored' ? result?.checksum || null : null,
    bytes:status === 'stored' && Number.isInteger(result?.bytes) ? result.bytes : null,
    error:result?.error ? safeError(result.error) : null,
  };
}

async function loadRuntimeSnapshot(baseUrl) {
  return fetchJsonWithPolicy(
    `${baseUrl}/api/listing-changes`,
    { headers:{ Accept:'application/json' } },
    { timeoutMs:15_000, retries:1 },
  );
}

export async function serveCatalogShadowReadiness(req, res, {
  env = process.env,
  runReadiness = runCatalogShadowReadinessQueries,
  loadSnapshot = loadRuntimeSnapshot,
  readCheckpoint = readListingAuditCheckpoint,
} = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  setNoStore(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error:'Method not allowed' });
  }
  if (Object.keys(req.query || {}).length > 0) {
    return res.status(400).json({ error:'Unexpected query param' });
  }
  if (!authorizedReadinessRequest(req, env)) {
    return res.status(401).json({ error:'Unauthorized readiness request' });
  }

  const baseUrl = deploymentBaseUrl(req, env);
  let runtimeSnapshot = null;
  let runtimeError = null;
  try {
    runtimeSnapshot = await loadSnapshot(baseUrl);
  } catch (error) {
    runtimeError = new Error(safeError(error));
  }

  let durableCheckpointReader;
  try {
    durableCheckpointReader = checkpointReaderDiagnostic(await readCheckpoint({ env }));
  } catch (error) {
    durableCheckpointReader = checkpointReaderDiagnostic({ status:'unavailable', error });
  }

  try {
    const report = await runReadiness({
      now:new Date().toISOString(),
      runtimeSnapshot,
      runtimeError,
    });
    return res.status(report.status === 'pass' ? 200 : 503).json({
      ...report,
      durableCheckpointReader,
    });
  } catch (error) {
    return res.status(503).json(unavailableReport(error));
  }
}

export default function handler(req, res) {
  return serveCatalogShadowReadiness(req, res);
}

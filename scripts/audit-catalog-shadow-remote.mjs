import { CATALOG_SHADOW_READINESS_SCHEMA_VERSION } from '../api/_lib/catalog-shadow-readiness.js';

const baseUrl = String(process.env.DASHBOARD_URL || 'https://avenir-rwa-analyst.vercel.app').replace(/\/$/, '');
const secret = String(process.env.CRON_SECRET || '');
if (!secret) throw new Error('CRON_SECRET is required for the authenticated read-only readiness probe');

const response = await fetch(`${baseUrl}/api/catalog-shadow-readiness`, {
  method:'GET',
  headers:{
    Accept:'application/json',
    Authorization:`Bearer ${secret}`,
  },
  redirect:'error',
  signal:AbortSignal.timeout(65_000),
});
let payload;
try {
  payload = await response.json();
} catch {
  throw new Error(`Catalog shadow readiness returned invalid JSON (HTTP ${response.status})`);
}
if (payload?.schemaVersion !== CATALOG_SHADOW_READINESS_SCHEMA_VERSION) {
  throw new Error(`Catalog shadow readiness returned an invalid schema (HTTP ${response.status})`);
}

process.stdout.write(`${JSON.stringify({
  baseUrl,
  transport:'vercel-function-iad1-to-neon-read-only',
  httpStatus:response.status,
  ...payload,
}, null, 2)}\n`);
if (!response.ok || payload.status === 'fail') process.exitCode = 1;

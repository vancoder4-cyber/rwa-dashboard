import { getJsonWithRetry } from './_lib/http.mjs';

const baseUrl = String(process.env.DASHBOARD_URL || 'https://avenir-rwa-analyst.vercel.app').replace(/\/$/, '');
const { response, payload } = await getJsonWithRetry(`${baseUrl}/api/health`, { allowErrorResponse: true });

if (!payload?.status || !Array.isArray(payload.checks)) {
  throw new Error(`Health endpoint returned an invalid payload (HTTP ${response.status})`);
}

console.log(JSON.stringify({
  baseUrl,
  status: payload.status,
  counts: payload.counts,
  generatedAt: payload.generatedAt,
  commit: payload.commit,
  checks: payload.checks.map(check => ({
    name: check.name,
    status: check.status,
    latencyMs: check.latencyMs,
    reason: check.reason || null,
  })),
}, null, 2));

if (payload.status === 'unhealthy' || !response.ok) process.exitCode = 1;

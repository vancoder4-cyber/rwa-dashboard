import {
  CATALOG_SHADOW_READINESS_SCHEMA_VERSION,
  runCatalogShadowReadinessQueries,
} from '../api/_lib/catalog-shadow-readiness.js';
import { getJsonWithRetry } from './_lib/http.mjs';

const baseUrl = String(process.env.DASHBOARD_URL || 'https://avenir-rwa-analyst.vercel.app').replace(/\/$/, '');
const generatedAt = new Date().toISOString();

function safeError(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, '[redacted-url]')
    .slice(0, 500);
}

function fatalReport(error) {
  return {
    schemaVersion: CATALOG_SHADOW_READINESS_SCHEMA_VERSION,
    generatedAt,
    status: 'fail',
    readyForPhase2: false,
    decision: 'Phase 1 daily reconciliation could not run; no Phase 2 writer or read cutover is authorized.',
    scope: {
      phase: 'phase1-catalog-shadow',
      marketFactsChecked: false,
      rollingMarketHistoryVerified: false,
      laterPhaseTablesConfirmedEmpty: false,
    },
    error: safeError(error),
    limitations: [
      'This failure report contains no market-fact verification and does not authorize Phase 2.',
      'No rolling 14-day market history exists in Phase 1 for this check to reconcile.',
    ],
  };
}

try {
  let runtimeSnapshot = null;
  let runtimeError = null;
  try {
    const { response, payload } = await getJsonWithRetry(`${baseUrl}/api/listing-changes`, {
      attempts: 2,
      timeoutMs: 15_000,
      allowErrorResponse: true,
    });
    if (!response.ok) throw new Error(`listing-changes returned HTTP ${response.status}`);
    runtimeSnapshot = payload;
  } catch (error) {
    runtimeError = new Error(safeError(error));
  }

  const report = await runCatalogShadowReadinessQueries({
    now: generatedAt,
    runtimeSnapshot,
    runtimeError,
  });
  process.stdout.write(`${JSON.stringify({ baseUrl, ...report }, null, 2)}\n`);
  if (report.status === 'fail') process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ baseUrl, ...fatalReport(error) }, null, 2)}\n`);
  process.exitCode = 1;
}

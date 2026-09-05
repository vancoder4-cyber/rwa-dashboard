export const PRODUCTION_BASELINES = Object.freeze({
  perpetuals: Object.freeze({ tradexyz: 108, bitget: 273, gate: 360, binance: 155, okx: 183, total: 1079 }),
  spot: Object.freeze({ gate: 60, kraken: 167, bitget: 627, binance: 68, okx: 51, total: 973 }),
  // Recompute this dynamically after OKX is present in the cross-venue audit;
  // raw OKX listings cannot be added because many share an existing canonical.
  canonicalPerpetualAssets: 469,
  reviewedAt: '2026-08-08',
});

const REMEDIATIONS = Object.freeze({
  'deployment-provenance': Object.freeze({
    code: 'RESTORE_VERIFIED_MAIN_DEPLOYMENT',
    summary: 'Production is not running a verified main-branch artifact.',
    actions: Object.freeze([
      'Promote the last verified main deployment to restore the public alias.',
      'Rebase or recreate the intended change from current origin/main; do not reuse a dirty or stale worktree.',
      'Run the build and health gates on a Preview, then merge through the Git integration.',
      'Confirm /api/health reports the intended main ref and full commit SHA after release.',
    ]),
  }),
  'production-page': Object.freeze({
    code: 'RESTORE_DASHBOARD_SHELL',
    summary: 'The public dashboard shell is unavailable or is not HTML.',
    actions: Object.freeze([
      'Inspect the deployment build and Function logs for the first failing request.',
      'Promote the last verified main deployment if the current artifact is broken.',
      'Reproduce the shell request on a Preview before releasing a forward fix.',
    ]),
  }),
  'reference-prices': Object.freeze({
    code: 'REPAIR_REFERENCE_COVERAGE',
    summary: 'Reference-price or FX-conversion coverage is incomplete.',
    actions: Object.freeze([
      'Inspect the failed symbol, native currency, FX source and freshness evidence.',
      'Repair the bounded server-side source mapping without substituting another asset or stale value.',
      'Verify all reference sentinels on a Preview before release.',
    ]),
  }),
  'us-market-directory': Object.freeze({
    code: 'REPAIR_US_DIRECTORY',
    summary: 'The official U.S. listing identity snapshot is unavailable or invalid.',
    actions: Object.freeze([
      'Inspect Nasdaq Trader source status, schema, timestamps and completeness counts.',
      'Keep the directory unavailable rather than admitting an unverified fallback identity.',
      'Verify the fixed identity sentinels and count reconciliation after the source recovers.',
    ]),
  }),
  'daily-listing-audit': Object.freeze({
    code: 'REBUILD_LISTING_AUDIT',
    summary: 'The daily ten-source listing audit is stale, incomplete or internally inconsistent.',
    actions: Object.freeze([
      'Inspect the exact unavailable source, retention state and Runtime Cache writer result.',
      'Run one authenticated listing-audit Cron retry for the same UTC bucket; do not trigger it from a browser.',
      'Reconcile the ten source counts and PostgreSQL shadow evidence before declaring recovery.',
    ]),
  }),
  'signal-radar-volume': Object.freeze({
    code: 'REBUILD_SIGNAL_SNAPSHOT',
    summary: 'The Signal Radar snapshot is stale or violates a source, identity, history or formula contract.',
    actions: Object.freeze([
      'Inspect the failing child contract and its source/reason codes.',
      'Run one authenticated signal-snapshot Cron retry for the current UTC bucket after fixing the source.',
      'Require all four history writers to report stored before treating the retry as recovered.',
    ]),
  }),
  'arbitrage-opportunities': Object.freeze({
    code: 'REBUILD_ARBITRAGE_SNAPSHOT',
    summary: 'The authoritative five-minute arbitrage publication is stale, incomplete or unavailable.',
    actions: Object.freeze([
      'Inspect ten-source catalog, exact order-book, open-interest and settled funding coverage.',
      'Run one authenticated arbitrage-snapshot Cron retry; never trigger publication from a browser.',
      'Require a full PostgreSQL snapshot and a passing Push Bot contract before restoring consumption.',
    ]),
  }),
});

export function remediationForCheck(name, status, reason = null) {
  if (status === 'pass') return null;
  const key = String(name || 'unknown');
  const template = REMEDIATIONS[key] ||
    (key.startsWith('funding-') ? {
      code: 'REPAIR_FUNDING_COVERAGE',
      summary: 'Funding-history coverage is incomplete.',
      actions: [
        'Inspect the exact venue contract, observation cadence and freshness window.',
        'Keep missing rows unavailable; do not fill them from another venue or contract.',
        'Re-run the fixed 24-hour funding probe after the upstream source recovers.',
      ],
    } : key.startsWith('okx-') ? {
      code: 'REPAIR_OKX_SNAPSHOT',
      summary: 'The fixed OKX catalog/market snapshot is incomplete or inconsistent.',
      actions: [
        'Inspect official identity, listing count and exact ticker/mark/OI join coverage.',
        'Repair the fixed server-side snapshot without accepting caller-selected symbols.',
        'Verify the reviewed lower bounds and complete joins on a Preview.',
      ],
    } : {
      code: 'INVESTIGATE_HEALTH_CHECK',
      summary: 'A health contract needs operator investigation.',
      actions: [
        'Inspect the check reason and the first failing Function or audit log.',
        'Reproduce the exact fixed request on a Preview and repair the earliest broken boundary.',
        'Run the build and production health gates before release.',
      ],
    });
  return {
    code: template.code,
    summary: template.summary,
    reason: reason || null,
    actions: [...template.actions],
  };
}

export function assessChecks(checks) {
  const rows = Array.isArray(checks) ? checks : [];
  const failed = rows.filter(check => check.status === 'fail');
  const warned = rows.filter(check => check.status === 'warn');
  const criticalFailure = failed.some(check => check.critical);
  const status = criticalFailure || failed.length >= 2
    ? 'unhealthy'
    : failed.length || warned.length ? 'degraded' : 'healthy';
  return {
    status,
    ok: status !== 'unhealthy',
    counts: {
      pass: rows.filter(check => check.status === 'pass').length,
      warn: warned.length,
      fail: failed.length,
    },
  };
}

export function checkResult(name, status, details = {}, options = {}) {
  const normalizedStatus = ['pass', 'warn', 'fail'].includes(status) ? status : 'fail';
  const remediation = details.remediation === undefined
    ? remediationForCheck(name, normalizedStatus, details.reason)
    : details.remediation;
  return {
    ...details,
    name,
    status: normalizedStatus,
    critical: Boolean(options.critical),
    checkedAt: new Date().toISOString(),
    remediation,
  };
}

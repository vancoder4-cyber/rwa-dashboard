export const PRODUCTION_BASELINES = Object.freeze({
  perpetuals: Object.freeze({ tradexyz: 108, bitget: 273, gate: 360, binance: 155, total: 896 }),
  spot: Object.freeze({ gate: 60, kraken: 167, bitget: 627, binance: 68, total: 922 }),
  canonicalPerpetualAssets: 471,
  reviewedAt: '2026-08-08',
});

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
  return {
    name,
    status: ['pass', 'warn', 'fail'].includes(status) ? status : 'fail',
    critical: Boolean(options.critical),
    checkedAt: new Date().toISOString(),
    ...details,
  };
}

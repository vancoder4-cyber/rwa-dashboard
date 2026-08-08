export const PRODUCTION_BASELINES = Object.freeze({
  perpetuals: Object.freeze({ tradexyz: 108, bitget: 273, gate: 360, binance: 155, okx: 183, total: 1079 }),
  spot: Object.freeze({ gate: 60, kraken: 167, bitget: 627, binance: 68, okx: 51, total: 973 }),
  // Recompute this dynamically after OKX is present in the cross-venue audit;
  // raw OKX listings cannot be added because many share an existing canonical.
  canonicalPerpetualAssets: 469,
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

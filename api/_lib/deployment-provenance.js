export const PRODUCTION_GIT_REF = 'main';

function normalized(value) {
  return String(value || '').trim();
}

export function validateDeploymentProvenance(env = {}, { requireProductionRef = false } = {}) {
  const environment = normalized(env.VERCEL_ENV).toLowerCase() || 'unknown';
  const ref = normalized(env.VERCEL_GIT_COMMIT_REF);
  const commit = normalized(env.VERCEL_GIT_COMMIT_SHA).toLowerCase();
  const production = environment === 'production' || requireProductionRef;
  const commitValid = /^[0-9a-f]{40}$/.test(commit);
  const refValid = ref === PRODUCTION_GIT_REF;
  const valid = !production || (refValid && commitValid);

  let reason = null;
  if (production && !refValid) {
    reason = `Production deployment source must be ${PRODUCTION_GIT_REF}; received ${ref || 'unknown'}`;
  } else if (production && !commitValid) {
    reason = 'Production deployment is missing a full Git commit SHA';
  }

  return {
    valid,
    production,
    environment,
    ref: ref || null,
    commit: commitValid ? commit : null,
    expectedRef: PRODUCTION_GIT_REF,
    reason,
  };
}

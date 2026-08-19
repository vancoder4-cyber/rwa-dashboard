import { validateDeploymentProvenance } from '../api/_lib/deployment-provenance.js';

const result = validateDeploymentProvenance(process.env);

if (!result.valid) {
  console.error('[deployment-source]', JSON.stringify({
    status: 'rejected',
    environment: result.environment,
    ref: result.ref,
    commit: result.commit,
    expectedRef: result.expectedRef,
    reason: result.reason,
  }));
  process.exitCode = 1;
} else {
  console.log('[deployment-source]', JSON.stringify({
    status: result.production ? 'verified' : 'not-production',
    environment: result.environment,
    ref: result.ref,
    commit: result.commit,
  }));
}

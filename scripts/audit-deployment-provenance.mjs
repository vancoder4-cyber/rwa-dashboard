import {
  ProductionDeploymentGuardError,
  auditProductionDeployment,
} from './_lib/production-deployment-guard.mjs';

try {
  const report = await auditProductionDeployment();
  console.log(JSON.stringify({
    status:report.valid ? 'pass' : 'fail',
    expectedSha:report.expectedSha,
    deploymentSha:report.deploymentSha,
    healthCommit:report.healthCommit,
    deploymentId:report.deploymentId,
    deploymentSource:report.deploymentSource,
    gitDirty:report.gitDirty,
    artifacts:report.artifacts,
    reasons:report.reasons,
  }, null, 2));
  if (!report.valid) process.exitCode = 1;
} catch (error) {
  const code = error instanceof ProductionDeploymentGuardError ? error.code : 'PROVENANCE_GUARD_INTERNAL_ERROR';
  console.error('[production-deployment-guard]', JSON.stringify({
    status:'error',
    code,
    reason:String(error?.message || error),
  }));
  process.exitCode = 1;
}

import { validateDeploymentProvenance } from './_lib/deployment-provenance.js';

const EXPECTED_GITHUB_OWNER = 'vancoder4-cyber';
const EXPECTED_GITHUB_REPOSITORY = 'rwa-dashboard';

export function buildDeploymentProvenancePayload(env = process.env, now = new Date()) {
  const provenance = validateDeploymentProvenance(env, { requireProductionRef:true });
  const deploymentUrl = String(env.VERCEL_URL || '').trim().toLowerCase();
  const deploymentId = String(env.VERCEL_DEPLOYMENT_ID || '').trim();
  const projectId = String(env.VERCEL_PROJECT_ID || '').trim();
  const gitProvider = String(env.VERCEL_GIT_PROVIDER || '').trim().toLowerCase();
  const repositoryOwner = String(env.VERCEL_GIT_REPO_OWNER || '').trim();
  const repositorySlug = String(env.VERCEL_GIT_REPO_SLUG || '').trim();
  const repositoryId = String(env.VERCEL_GIT_REPO_ID || '').trim();
  const identityValid = /^dpl_[A-Za-z0-9]+$/.test(deploymentId) &&
    /^prj_[A-Za-z0-9]+$/.test(projectId) &&
    /^[a-z0-9-]+\.vercel\.app$/.test(deploymentUrl) &&
    gitProvider === 'github' &&
    repositoryOwner === EXPECTED_GITHUB_OWNER &&
    repositorySlug === EXPECTED_GITHUB_REPOSITORY &&
    /^\d+$/.test(repositoryId);
  const valid = provenance.valid && identityValid;
  const check = {
    name:'deployment-provenance',
    status:valid ? 'pass' : 'fail',
    critical:true,
    environment:provenance.environment,
    ref:provenance.ref,
    commit:provenance.commit,
    deploymentId:deploymentId || null,
    deploymentUrl:deploymentUrl ? `https://${deploymentUrl}` : null,
    projectId:projectId || null,
    gitProvider:gitProvider || null,
    repositoryOwner:repositoryOwner || null,
    repositorySlug:repositorySlug || null,
    repositoryId:repositoryId || null,
    expectedRef:provenance.expectedRef,
    reason:provenance.reason || (identityValid ? null : 'Production deployment identity is incomplete or unexpected'),
  };
  return {
    httpStatus:valid ? 200 : 503,
    payload:{
      schemaVersion:'rwa-deployment-provenance/v1',
      service:'avenir-rwa-analyst',
      status:check.status,
      generatedAt:now.toISOString(),
      environment:provenance.environment,
      ref:provenance.ref,
      commit:provenance.commit,
      deploymentId:check.deploymentId,
      deploymentUrl:check.deploymentUrl,
      projectId:check.projectId,
      gitProvider:check.gitProvider,
      repositoryOwner:check.repositoryOwner,
      repositorySlug:check.repositorySlug,
      repositoryId:check.repositoryId,
      checks:[check],
    },
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error:'Method not allowed' });
  }
  if (Object.keys(req.query || {}).length) return res.status(400).json({ error:'Query parameters are not supported' });

  const result = buildDeploymentProvenancePayload();
  return res.status(result.httpStatus).json(result.payload);
}

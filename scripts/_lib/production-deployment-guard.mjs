import { createHash } from 'node:crypto';

export const PRODUCTION_DASHBOARD_ORIGIN = 'https://avenir-rwa-analyst.vercel.app';
export const PRODUCTION_GITHUB_OWNER = 'vancoder4-cyber';
export const PRODUCTION_GITHUB_REPOSITORY = 'rwa-dashboard';
export const PRODUCTION_GIT_REF = 'main';
export const PRODUCTION_STATIC_FILES = Object.freeze(['index.html', 'i18n.js']);

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class ProductionDeploymentGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProductionDeploymentGuardError';
    this.code = code;
  }
}

function normalized(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return normalized(value).toLowerCase();
}

function cleanDeploymentMetadata(value) {
  return value === 0 || value === false || ['0', 'false'].includes(lower(value));
}

function deploymentRepositoryMatches(gitSource, repository) {
  const byId = normalized(gitSource?.repoId) &&
    normalized(gitSource.repoId) === normalized(repository?.id);
  const byName = lower(gitSource?.org) === lower(repository?.owner?.login) &&
    lower(gitSource?.repo) === lower(repository?.name);
  return Boolean(byId || byName);
}

function healthProvenance(payload) {
  return Array.isArray(payload?.checks)
    ? payload.checks.find(check => check?.name === 'deployment-provenance')
    : null;
}

export function validateProductionDeploymentEvidence({
  repository,
  mainCommit,
  deployment,
  health,
  artifacts,
  expectedProjectId,
} = {}) {
  const reasons = [];
  const expectedSha = lower(mainCommit?.sha);
  const gitSource = deployment?.gitSource;
  const deploymentSha = lower(gitSource?.sha);
  const healthCommit = lower(health?.commit);
  const provenance = healthProvenance(health);

  if (lower(repository?.full_name) !== `${PRODUCTION_GITHUB_OWNER}/${PRODUCTION_GITHUB_REPOSITORY}`) {
    reasons.push('GITHUB_REPOSITORY_MISMATCH');
  }
  if (repository?.default_branch !== PRODUCTION_GIT_REF) reasons.push('GITHUB_DEFAULT_BRANCH_MISMATCH');
  if (!FULL_SHA.test(expectedSha)) reasons.push('GITHUB_MAIN_SHA_INVALID');

  if (deployment?.source !== 'git') reasons.push('VERCEL_SOURCE_NOT_GIT');
  if (deployment?.target !== 'production') reasons.push('VERCEL_TARGET_NOT_PRODUCTION');
  if (deployment?.readyState !== 'READY' && deployment?.status !== 'READY') {
    reasons.push('VERCEL_DEPLOYMENT_NOT_READY');
  }
  if (expectedProjectId && normalized(deployment?.project?.id) !== normalized(expectedProjectId)) {
    reasons.push('VERCEL_PROJECT_MISMATCH');
  }
  if (gitSource?.type !== 'github') reasons.push('VERCEL_GIT_PROVIDER_MISMATCH');
  if (!deploymentRepositoryMatches(gitSource, repository)) reasons.push('VERCEL_GIT_REPOSITORY_MISMATCH');
  if (gitSource?.ref !== PRODUCTION_GIT_REF) reasons.push('VERCEL_GIT_REF_MISMATCH');
  if (!FULL_SHA.test(deploymentSha) || deploymentSha !== expectedSha) reasons.push('VERCEL_GIT_SHA_MISMATCH');
  if (!Object.prototype.hasOwnProperty.call(deployment?.meta || {}, 'gitDirty')) {
    reasons.push('VERCEL_GIT_DIRTY_MISSING');
  } else if (!cleanDeploymentMetadata(deployment.meta.gitDirty)) {
    reasons.push('VERCEL_GIT_DIRTY');
  }

  if (!provenance || provenance.status !== 'pass') reasons.push('HEALTH_PROVENANCE_NOT_PASSING');
  if (provenance?.environment !== 'production') reasons.push('HEALTH_ENVIRONMENT_MISMATCH');
  if (provenance?.ref !== PRODUCTION_GIT_REF) reasons.push('HEALTH_GIT_REF_MISMATCH');
  if (lower(provenance?.commit) !== expectedSha || healthCommit !== expectedSha) {
    reasons.push('HEALTH_GIT_SHA_MISMATCH');
  }

  const artifactRows = Array.isArray(artifacts) ? artifacts : [];
  if (artifactRows.length !== PRODUCTION_STATIC_FILES.length) reasons.push('STATIC_ARTIFACT_SET_MISMATCH');
  for (const filename of PRODUCTION_STATIC_FILES) {
    const row = artifactRows.find(item => item?.path === filename);
    if (!row || !SHA256.test(lower(row.productionSha256)) ||
        lower(row.productionSha256) !== lower(row.repositorySha256)) {
      reasons.push(`STATIC_ARTIFACT_MISMATCH:${filename}`);
    }
  }

  return Object.freeze({
    valid: reasons.length === 0,
    reasons:Object.freeze([...new Set(reasons)]),
    expectedSha:FULL_SHA.test(expectedSha) ? expectedSha : null,
    deploymentSha:FULL_SHA.test(deploymentSha) ? deploymentSha : null,
    healthCommit:FULL_SHA.test(healthCommit) ? healthCommit : null,
    deploymentId:normalized(deployment?.id || deployment?.uid) || null,
    deploymentSource:normalized(deployment?.source) || null,
    gitDirty:Object.prototype.hasOwnProperty.call(deployment?.meta || {}, 'gitDirty')
      ? normalized(deployment.meta.gitDirty)
      : null,
    artifacts:Object.freeze(artifactRows.map(row => Object.freeze({
      path:row.path,
      productionSha256:lower(row.productionSha256),
      repositorySha256:lower(row.repositorySha256),
    }))),
  });
}

function requestHeaders(token = '') {
  return {
    Accept:'application/json',
    'User-Agent':'rwa-dashboard-production-guard/1.0',
    ...(token ? { Authorization:`Bearer ${token}` } : {}),
    'X-GitHub-Api-Version':'2022-11-28',
  };
}

async function request(fetchImpl, url, { token = '', json = true, allowError = false } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method:'GET',
      headers:requestHeaders(token),
      redirect:'error',
      signal:AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ProductionDeploymentGuardError('PROVENANCE_NETWORK_ERROR', `${new URL(url).hostname} request failed`);
  }
  if (!response.ok && !allowError) {
    throw new ProductionDeploymentGuardError(
      'PROVENANCE_HTTP_ERROR',
      `${new URL(url).hostname}${new URL(url).pathname} returned HTTP ${response.status}`,
    );
  }
  if (!json) return response;
  try {
    return await response.json();
  } catch {
    throw new ProductionDeploymentGuardError('PROVENANCE_INVALID_JSON', `${new URL(url).hostname} returned invalid JSON`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validatedDashboardOrigin(value) {
  let url;
  try {
    url = new URL(value || PRODUCTION_DASHBOARD_ORIGIN);
  } catch {
    throw new ProductionDeploymentGuardError('INVALID_DASHBOARD_ORIGIN', 'Production dashboard origin is invalid');
  }
  if (url.origin !== PRODUCTION_DASHBOARD_ORIGIN || url.pathname !== '/' || url.search || url.hash) {
    throw new ProductionDeploymentGuardError('INVALID_DASHBOARD_ORIGIN', 'Production dashboard origin is not allowlisted');
  }
  return url.origin;
}

async function repositoryArtifact(fetchImpl, filename, commit, githubToken) {
  const url = new URL(
    `/repos/${PRODUCTION_GITHUB_OWNER}/${PRODUCTION_GITHUB_REPOSITORY}/contents/${filename}`,
    'https://api.github.com',
  );
  url.searchParams.set('ref', commit);
  const payload = await request(fetchImpl, url, { token:githubToken });
  if (payload?.encoding !== 'base64' || typeof payload?.content !== 'string') {
    throw new ProductionDeploymentGuardError('GITHUB_CONTENT_INVALID', `GitHub content is invalid for ${filename}`);
  }
  return Buffer.from(payload.content.replace(/\s+/g, ''), 'base64');
}

export async function auditProductionDeployment({ env = process.env, fetchImpl = fetch } = {}) {
  const vercelToken = normalized(env.VERCEL_TOKEN);
  const projectId = normalized(env.VERCEL_PROJECT_ID);
  const teamId = normalized(env.VERCEL_TEAM_ID || env.VERCEL_ORG_ID);
  const githubToken = normalized(env.GITHUB_TOKEN);
  const dashboardOrigin = validatedDashboardOrigin(env.PRODUCTION_DASHBOARD_URL || PRODUCTION_DASHBOARD_ORIGIN);
  if (!vercelToken) throw new ProductionDeploymentGuardError('VERCEL_TOKEN_MISSING', 'VERCEL_TOKEN is required');
  if (!projectId) throw new ProductionDeploymentGuardError('VERCEL_PROJECT_ID_MISSING', 'VERCEL_PROJECT_ID is required');

  const githubBase = `https://api.github.com/repos/${PRODUCTION_GITHUB_OWNER}/${PRODUCTION_GITHUB_REPOSITORY}`;
  const deploymentUrl = new URL(`/v13/deployments/${new URL(dashboardOrigin).hostname}`, 'https://api.vercel.com');
  deploymentUrl.searchParams.set('withGitRepoInfo', 'true');
  if (teamId) deploymentUrl.searchParams.set('teamId', teamId);

  const [repository, mainCommit, deployment, health] = await Promise.all([
    request(fetchImpl, githubBase, { token:githubToken }),
    request(fetchImpl, `${githubBase}/commits/${PRODUCTION_GIT_REF}`, { token:githubToken }),
    request(fetchImpl, deploymentUrl, { token:vercelToken }),
    request(fetchImpl, `${dashboardOrigin}/api/deployment-provenance`, { allowError:true }),
  ]);
  const expectedSha = lower(mainCommit?.sha);
  if (!FULL_SHA.test(expectedSha)) {
    throw new ProductionDeploymentGuardError('GITHUB_MAIN_SHA_INVALID', 'GitHub main returned an invalid commit SHA');
  }

  const artifacts = await Promise.all(PRODUCTION_STATIC_FILES.map(async filename => {
    const [productionResponse, repositoryBytes] = await Promise.all([
      request(fetchImpl, `${dashboardOrigin}/${filename === 'index.html' ? '' : filename}`, { json:false }),
      repositoryArtifact(fetchImpl, filename, expectedSha, githubToken),
    ]);
    const productionBytes = Buffer.from(await productionResponse.arrayBuffer());
    return {
      path:filename,
      productionSha256:sha256(productionBytes),
      repositorySha256:sha256(repositoryBytes),
    };
  }));

  return validateProductionDeploymentEvidence({
    repository,
    mainCommit,
    deployment,
    health,
    artifacts,
    expectedProjectId:projectId,
  });
}

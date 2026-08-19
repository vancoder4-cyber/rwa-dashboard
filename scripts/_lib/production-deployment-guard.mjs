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

function normalizedUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        url.pathname !== '/' || url.search || url.hash) return null;
    return url.toString().toLowerCase();
  } catch {
    return null;
  }
}

function healthProvenance(payload) {
  return Array.isArray(payload?.checks)
    ? payload.checks.find(check => check?.name === 'deployment-provenance')
    : null;
}

export function validateProductionDeploymentEvidence({
  repository,
  mainCommit,
  productionDeployments,
  deploymentStatuses,
  health,
  artifacts,
  expectedProjectId,
} = {}) {
  const reasons = [];
  const expectedSha = lower(mainCommit?.sha);
  const deployment = Array.isArray(productionDeployments) ? productionDeployments[0] : null;
  const deploymentStatus = Array.isArray(deploymentStatuses) ? deploymentStatuses[0] : null;
  const deploymentSha = lower(deployment?.sha);
  const healthCommit = lower(health?.commit);
  const provenance = healthProvenance(health);
  const runtimeUrl = normalizedUrl(health?.deploymentUrl);
  const registeredUrl = normalizedUrl(deploymentStatus?.environment_url || deploymentStatus?.target_url);

  if (lower(repository?.full_name) !== `${PRODUCTION_GITHUB_OWNER}/${PRODUCTION_GITHUB_REPOSITORY}`) {
    reasons.push('GITHUB_REPOSITORY_MISMATCH');
  }
  if (repository?.default_branch !== PRODUCTION_GIT_REF) reasons.push('GITHUB_DEFAULT_BRANCH_MISMATCH');
  if (!FULL_SHA.test(expectedSha)) reasons.push('GITHUB_MAIN_SHA_INVALID');

  if (!deployment) reasons.push('GITHUB_PRODUCTION_DEPLOYMENT_MISSING');
  if (deployment?.environment !== 'Production' || deployment?.task !== 'deploy') {
    reasons.push('GITHUB_PRODUCTION_DEPLOYMENT_INVALID');
  }
  if (deployment?.creator?.login !== 'vercel[bot]') reasons.push('GITHUB_DEPLOYMENT_CREATOR_MISMATCH');
  if (!FULL_SHA.test(deploymentSha) || deploymentSha !== expectedSha) {
    reasons.push('GITHUB_DEPLOYMENT_SHA_MISMATCH');
  }
  if (deploymentStatus?.state !== 'success') reasons.push('GITHUB_DEPLOYMENT_NOT_SUCCESSFUL');
  if (!runtimeUrl || !registeredUrl || runtimeUrl !== registeredUrl) {
    reasons.push('GITHUB_DEPLOYMENT_URL_MISMATCH');
  }

  if (expectedProjectId && normalized(health?.projectId) !== normalized(expectedProjectId)) {
    reasons.push('VERCEL_PROJECT_MISMATCH');
  }
  if (!/^dpl_[A-Za-z0-9]+$/.test(normalized(health?.deploymentId))) {
    reasons.push('VERCEL_DEPLOYMENT_ID_INVALID');
  }
  if (health?.gitProvider !== 'github') reasons.push('VERCEL_GIT_PROVIDER_MISMATCH');
  if (lower(health?.repositoryOwner) !== lower(repository?.owner?.login) ||
      lower(health?.repositorySlug) !== lower(repository?.name) ||
      normalized(health?.repositoryId) !== normalized(repository?.id)) {
    reasons.push('VERCEL_GIT_REPOSITORY_MISMATCH');
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
    deploymentUrl:runtimeUrl,
    registeredDeploymentUrl:registeredUrl,
    deploymentSource:deployment?.creator?.login === 'vercel[bot]' && runtimeUrl === registeredUrl
      ? 'git'
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
  const projectId = normalized(env.VERCEL_PROJECT_ID);
  const githubToken = normalized(env.GITHUB_TOKEN);
  const dashboardOrigin = validatedDashboardOrigin(env.PRODUCTION_DASHBOARD_URL || PRODUCTION_DASHBOARD_ORIGIN);
  if (!projectId) throw new ProductionDeploymentGuardError('VERCEL_PROJECT_ID_MISSING', 'VERCEL_PROJECT_ID is required');

  const githubBase = `https://api.github.com/repos/${PRODUCTION_GITHUB_OWNER}/${PRODUCTION_GITHUB_REPOSITORY}`;
  const deploymentsUrl = new URL(`${githubBase}/deployments`);
  deploymentsUrl.searchParams.set('environment', 'Production');
  deploymentsUrl.searchParams.set('per_page', '10');

  const [repository, mainCommit, productionDeployments, health] = await Promise.all([
    request(fetchImpl, githubBase, { token:githubToken }),
    request(fetchImpl, `${githubBase}/commits/${PRODUCTION_GIT_REF}`, { token:githubToken }),
    request(fetchImpl, deploymentsUrl, { token:githubToken }),
    request(fetchImpl, `${dashboardOrigin}/api/deployment-provenance`, { allowError:true }),
  ]);
  const expectedSha = lower(mainCommit?.sha);
  if (!FULL_SHA.test(expectedSha)) {
    throw new ProductionDeploymentGuardError('GITHUB_MAIN_SHA_INVALID', 'GitHub main returned an invalid commit SHA');
  }
  const latestDeployment = Array.isArray(productionDeployments) ? productionDeployments[0] : null;
  const deploymentStatuses = latestDeployment?.id
    ? await request(fetchImpl, `${githubBase}/deployments/${latestDeployment.id}/statuses`, { token:githubToken })
    : [];

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
    productionDeployments,
    deploymentStatuses,
    health,
    artifacts,
    expectedProjectId:projectId,
  });
}

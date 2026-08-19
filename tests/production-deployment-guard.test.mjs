import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  PRODUCTION_DASHBOARD_ORIGIN,
  auditProductionDeployment,
  validateProductionDeploymentEvidence,
} from '../scripts/_lib/production-deployment-guard.mjs';

const SHA = 'f449a7592b0b07192171eea89410c23993dda1b7';
const HASH = 'a'.repeat(64);
const DEPLOYMENT_URL = 'https://deploy-git-main.vercel.app/';

function evidence(overrides = {}) {
  return {
    repository: {
      id:12345,
      name:'rwa-dashboard',
      full_name:'vancoder4-cyber/rwa-dashboard',
      default_branch:'main',
      owner:{ login:'vancoder4-cyber' },
    },
    mainCommit:{ sha:SHA },
    productionDeployments:[{
      id:5975369386,
      sha:SHA,
      ref:SHA,
      environment:'Production',
      task:'deploy',
      creator:{ login:'vercel[bot]' },
    }],
    deploymentStatuses:[{
      state:'success',
      environment:'Production',
      environment_url:DEPLOYMENT_URL,
      target_url:DEPLOYMENT_URL,
    }],
    health: {
      commit:SHA,
      deploymentId:'dpl_verified123',
      deploymentUrl:DEPLOYMENT_URL,
      projectId:'prj_expected',
      gitProvider:'github',
      repositoryOwner:'vancoder4-cyber',
      repositorySlug:'rwa-dashboard',
      repositoryId:'12345',
      checks:[{
        name:'deployment-provenance', status:'pass', critical:true,
        environment:'production', ref:'main', commit:SHA,
      }],
    },
    artifacts:[
      { path:'index.html', productionSha256:HASH, repositorySha256:HASH },
      { path:'i18n.js', productionSha256:HASH, repositorySha256:HASH },
    ],
    expectedProjectId:'prj_expected',
    ...overrides,
  };
}

test('production guard binds current main to the exact Vercel-bot deployment and runtime URL', () => {
  const valid = validateProductionDeploymentEvidence(evidence());
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.reasons, []);
  assert.equal(valid.expectedSha, SHA);

  const localCli = validateProductionDeploymentEvidence(evidence({
    health:{ ...evidence().health, deploymentUrl:'https://local-cli-overwrite.vercel.app/' },
  }));
  assert.equal(localCli.valid, false);
  assert.ok(localCli.reasons.includes('GITHUB_DEPLOYMENT_URL_MISMATCH'));

  const untrustedCreator = validateProductionDeploymentEvidence(evidence({
    productionDeployments:[{ ...evidence().productionDeployments[0], creator:{ login:'someone' } }],
  }));
  assert.ok(untrustedCreator.reasons.includes('GITHUB_DEPLOYMENT_CREATOR_MISMATCH'));

  const missingDeploymentIdentity = validateProductionDeploymentEvidence(evidence({
    health:{ ...evidence().health, deploymentId:null },
  }));
  assert.ok(missingDeploymentIdentity.reasons.includes('VERCEL_DEPLOYMENT_ID_INVALID'));
});

test('production guard rejects wrong repository, stale SHA and changed published artifacts independently', () => {
  const wrongRepository = validateProductionDeploymentEvidence(evidence({
    health:{ ...evidence().health, repositoryOwner:'someone', repositorySlug:'other', repositoryId:'99999' },
  }));
  assert.ok(wrongRepository.reasons.includes('VERCEL_GIT_REPOSITORY_MISMATCH'));

  const staleSha = validateProductionDeploymentEvidence(evidence({
    productionDeployments:[{ ...evidence().productionDeployments[0], sha:'0'.repeat(40) }],
  }));
  assert.ok(staleSha.reasons.includes('GITHUB_DEPLOYMENT_SHA_MISMATCH'));

  const changedArtifact = validateProductionDeploymentEvidence(evidence({
    artifacts:[
      { path:'index.html', productionSha256:'b'.repeat(64), repositorySha256:HASH },
      { path:'i18n.js', productionSha256:HASH, repositorySha256:HASH },
    ],
  }));
  assert.ok(changedArtifact.reasons.includes('STATIC_ARTIFACT_MISMATCH:index.html'));
});

test('external audit joins GitHub deployment attestation, runtime and exact bytes without a Vercel token', async () => {
  const files = {
    'index.html':Buffer.from('<!doctype html><title>RWA</title>'),
    'i18n.js':Buffer.from('export const locale = "en";'),
  };
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ url:url.toString(), authorization:options.headers?.Authorization || null });
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/rwa-dashboard')) {
      return Response.json(evidence().repository);
    }
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/commits/main')) {
      return Response.json({ sha:SHA });
    }
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/deployments')) {
      return Response.json(evidence().productionDeployments);
    }
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/deployments/5975369386/statuses')) {
      return Response.json(evidence().deploymentStatuses);
    }
    if (url.hostname === 'api.github.com' && url.pathname.includes('/contents/')) {
      const filename = url.pathname.endsWith('/i18n.js') ? 'i18n.js' : 'index.html';
      return Response.json({ encoding:'base64', content:files[filename].toString('base64') });
    }
    if (url.pathname === '/api/deployment-provenance') return Response.json(evidence().health);
    if (url.origin === PRODUCTION_DASHBOARD_ORIGIN) {
      const filename = url.pathname === '/i18n.js' ? 'i18n.js' : 'index.html';
      return new Response(files[filename]);
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const report = await auditProductionDeployment({
    env:{
      VERCEL_PROJECT_ID:'prj_expected',
      GITHUB_TOKEN:'github-secret',
    },
    fetchImpl,
  });
  assert.equal(report.valid, true);
  assert.equal(report.artifacts.length, 2);
  assert.equal(report.artifacts[0].productionSha256,
    createHash('sha256').update(files['index.html']).digest('hex'));
  assert.ok(calls.some(call => call.url.includes('environment=Production')));
  assert.ok(calls.some(call => call.url.includes('/deployments/5975369386/statuses')));
  assert.ok(calls.some(call => call.authorization === 'Bearer github-secret'));
  assert.ok(calls.every(call => !call.url.includes('api.vercel.com')));
  assert.equal(calls.find(call => call.url.includes('vercel.app/api/'))?.authorization, null);
  assert.ok(calls.every(call => !call.url.includes('secret')));
});

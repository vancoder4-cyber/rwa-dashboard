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
    deployment: {
      id:'dpl_verified',
      source:'git',
      target:'production',
      readyState:'READY',
      project:{ id:'prj_expected' },
      gitSource:{ type:'github', repoId:12345, ref:'main', sha:SHA },
      meta:{ gitDirty:'0' },
    },
    health: {
      commit:SHA,
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

test('production guard requires Git-origin clean main with exact repo, SHA, health and artifacts', () => {
  const valid = validateProductionDeploymentEvidence(evidence());
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.reasons, []);
  assert.equal(valid.expectedSha, SHA);

  const dirty = validateProductionDeploymentEvidence(evidence({
    deployment:{ ...evidence().deployment, meta:{ gitDirty:'1' } },
  }));
  assert.equal(dirty.valid, false);
  assert.ok(dirty.reasons.includes('VERCEL_GIT_DIRTY'));

  const localCli = validateProductionDeploymentEvidence(evidence({
    deployment:{ ...evidence().deployment, source:'cli' },
  }));
  assert.ok(localCli.reasons.includes('VERCEL_SOURCE_NOT_GIT'));

  const missingDirtyEvidence = validateProductionDeploymentEvidence(evidence({
    deployment:{ ...evidence().deployment, meta:{} },
  }));
  assert.ok(missingDirtyEvidence.reasons.includes('VERCEL_GIT_DIRTY_MISSING'));
});

test('production guard rejects wrong repository, stale SHA and changed published artifacts independently', () => {
  const wrongRepository = validateProductionDeploymentEvidence(evidence({
    deployment:{
      ...evidence().deployment,
      gitSource:{ ...evidence().deployment.gitSource, repoId:99999, org:'someone', repo:'other' },
    },
  }));
  assert.ok(wrongRepository.reasons.includes('VERCEL_GIT_REPOSITORY_MISMATCH'));

  const staleSha = validateProductionDeploymentEvidence(evidence({
    deployment:{
      ...evidence().deployment,
      gitSource:{ ...evidence().deployment.gitSource, sha:'0'.repeat(40) },
    },
  }));
  assert.ok(staleSha.reasons.includes('VERCEL_GIT_SHA_MISMATCH'));

  const changedArtifact = validateProductionDeploymentEvidence(evidence({
    artifacts:[
      { path:'index.html', productionSha256:'b'.repeat(64), repositorySha256:HASH },
      { path:'i18n.js', productionSha256:HASH, repositorySha256:HASH },
    ],
  }));
  assert.ok(changedArtifact.reasons.includes('STATIC_ARTIFACT_MISMATCH:index.html'));
});

test('external audit joins GitHub, Vercel, Health and exact production bytes without exposing tokens', async () => {
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
    if (url.hostname === 'api.github.com' && url.pathname.includes('/contents/')) {
      const filename = url.pathname.endsWith('/i18n.js') ? 'i18n.js' : 'index.html';
      return Response.json({ encoding:'base64', content:files[filename].toString('base64') });
    }
    if (url.hostname === 'api.vercel.com') return Response.json(evidence().deployment);
    if (url.pathname === '/api/deployment-provenance') return Response.json(evidence().health);
    if (url.origin === PRODUCTION_DASHBOARD_ORIGIN) {
      const filename = url.pathname === '/i18n.js' ? 'i18n.js' : 'index.html';
      return new Response(files[filename]);
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const report = await auditProductionDeployment({
    env:{
      VERCEL_TOKEN:'vercel-secret',
      VERCEL_PROJECT_ID:'prj_expected',
      VERCEL_TEAM_ID:'team_expected',
      GITHUB_TOKEN:'github-secret',
    },
    fetchImpl,
  });
  assert.equal(report.valid, true);
  assert.equal(report.artifacts.length, 2);
  assert.equal(report.artifacts[0].productionSha256,
    createHash('sha256').update(files['index.html']).digest('hex'));
  assert.ok(calls.some(call => call.url.includes('withGitRepoInfo=true')));
  assert.ok(calls.some(call => call.authorization === 'Bearer vercel-secret'));
  assert.ok(calls.some(call => call.authorization === 'Bearer github-secret'));
  assert.ok(calls.every(call => !call.url.includes('secret')));
});

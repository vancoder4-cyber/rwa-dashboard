import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  PRODUCTION_GIT_REF,
  validateDeploymentProvenance,
} from '../api/_lib/deployment-provenance.js';
import { deploymentProvenanceCheck } from '../api/health.js';

const SHA = '30e31e60efaac238d39a0bb2880474611f200485';

test('production provenance accepts only a full commit from main', () => {
  assert.equal(PRODUCTION_GIT_REF, 'main');
  assert.equal(validateDeploymentProvenance({
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'main',
    VERCEL_GIT_COMMIT_SHA: SHA,
  }).valid, true);

  const oldBranch = validateDeploymentProvenance({
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'agent/daily-db-reconciliation',
    VERCEL_GIT_COMMIT_SHA: SHA,
  });
  assert.equal(oldBranch.valid, false);
  assert.match(oldBranch.reason, /must be main/);

  const missingCommit = validateDeploymentProvenance({
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'main',
  });
  assert.equal(missingCommit.valid, false);
  assert.match(missingCommit.reason, /missing a full Git commit SHA/);
});

test('preview provenance stays non-blocking while production health fails closed with repair steps', () => {
  assert.equal(validateDeploymentProvenance({ VERCEL_ENV: 'preview' }).valid, true);
  assert.equal(validateDeploymentProvenance({
    VERCEL_ENV: 'preview',
    VERCEL_GIT_COMMIT_REF: 'feature',
    VERCEL_GIT_COMMIT_SHA: SHA,
  }, { requireProductionRef: true }).valid, false, 'promoting a feature Preview must not bypass provenance');
  const check = deploymentProvenanceCheck({
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'old-feature',
    VERCEL_GIT_COMMIT_SHA: SHA,
  });
  assert.equal(check.status, 'fail');
  assert.equal(check.critical, true);
  assert.equal(check.remediation.code, 'RESTORE_VERIFIED_MAIN_DEPLOYMENT');
  assert.ok(check.remediation.actions.some(action => /Promote the last verified main deployment/.test(action)));
});

test('the production build guard exits nonzero for an old branch', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-deployment-source.mjs'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      VERCEL_ENV: 'production',
      VERCEL_GIT_COMMIT_REF: 'agent/daily-db-reconciliation',
      VERCEL_GIT_COMMIT_SHA: SHA,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\"status\":\"rejected\"/);
  assert.doesNotMatch(result.stderr, /vancoder4@gmail\.com/);
});

test('Vercel publishes only the generated dashboard shell after the build gate', async () => {
  const root = new URL('..', import.meta.url);
  const vercel = JSON.parse(await readFile(new URL('vercel.json', root), 'utf8'));
  const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const buildScript = await readFile(new URL('scripts/build-static.mjs', root), 'utf8');
  assert.equal(vercel.outputDirectory, 'public');
  assert.equal(vercel.buildCommand, 'npm run build');
  assert.match(packageJson.scripts.build, /verify:deploy-source/);
  assert.match(packageJson.scripts.build, /build-static\.mjs/);
  assert.match(buildScript, /\['index\.html', 'i18n\.js'\]/);
  assert.doesNotMatch(buildScript, /node_modules|tests|api/);
});

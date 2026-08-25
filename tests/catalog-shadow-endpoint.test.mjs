import test from 'node:test';
import assert from 'node:assert/strict';

import { serveCatalogShadowReadiness } from '../api/catalog-shadow-readiness.js';

function responseRecorder() {
  return {
    headers:{},
    statusCode:null,
    payload:null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

const env = {
  CRON_SECRET:'readiness-test-secret',
  VERCEL_URL:'preview-main.vercel.app',
};

test('in-region catalog readiness rejects unauthenticated, non-GET, and query-bearing requests', async () => {
  const unauthorized = responseRecorder();
  await serveCatalogShadowReadiness({ method:'GET', query:{}, headers:{} }, unauthorized, { env });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.headers['Cache-Control'], 'private, no-store, max-age=0');

  const method = responseRecorder();
  await serveCatalogShadowReadiness({ method:'POST', query:{}, headers:{} }, method, { env });
  assert.equal(method.statusCode, 405);

  const query = responseRecorder();
  await serveCatalogShadowReadiness({
    method:'GET', query:{ repair:'1' }, headers:{ authorization:'Bearer readiness-test-secret' },
  }, query, { env });
  assert.equal(query.statusCode, 400);
});

test('in-region catalog readiness is read-only and returns the sanitized reconciliation report', async () => {
  const calls = [];
  const response = responseRecorder();
  const report = {
    schemaVersion:'rwa-catalog-shadow-readiness/v2',
    generatedAt:'2026-08-25T13:00:00.000Z',
    status:'pass',
    readyForPhase2:true,
    scope:{ marketFactsChecked:false, rollingMarketHistoryVerified:false },
  };
  await serveCatalogShadowReadiness({
    method:'GET', query:{}, headers:{ authorization:'Bearer readiness-test-secret' },
  }, response, {
    env,
    loadSnapshot:async baseUrl => {
      calls.push(['snapshot', baseUrl]);
      return { schemaVersion:'rwa-listing-audit/v1' };
    },
    runReadiness:async input => {
      calls.push(['readiness', input]);
      return report;
    },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, report);
  assert.equal(calls[0][1], 'https://preview-main.vercel.app');
  assert.equal(calls[1][1].runtimeSnapshot.schemaVersion, 'rwa-listing-audit/v1');
  assert.equal(calls[1][1].runtimeError, null);
});

test('in-region catalog readiness fails closed without leaking connection URLs', async () => {
  const response = responseRecorder();
  await serveCatalogShadowReadiness({
    method:'GET', query:{}, headers:{ authorization:'Bearer readiness-test-secret' },
  }, response, {
    env,
    loadSnapshot:async () => ({ schemaVersion:'rwa-listing-audit/v1' }),
    runReadiness:async () => { throw new Error('postgres://secret@host/database timed out'); },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.payload.status, 'fail');
  assert.equal(response.payload.scope.marketFactsChecked, false);
  assert.doesNotMatch(response.payload.error, /secret|postgres:\/\//);
});

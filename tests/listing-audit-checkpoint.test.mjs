import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LISTING_SOURCE_KEYS,
  mergeListingAudit,
} from '../api/_lib/listing-audit.js';
import {
  LISTING_AUDIT_BUNDLE_FORMAT,
  LISTING_AUDIT_CHECKPOINT_KEY,
  prepareListingAuditCheckpoint,
  readListingAuditCheckpoint,
  resolveListingCheckpointWriteMode,
  resolveListingReadMode,
  writeListingAuditCheckpoint,
} from '../api/_lib/listing-audit-checkpoint.js';
import {
  compactListingAuditBundle,
  readListingChangesSnapshot,
  runListingAudit,
  selectListingAuditBundle,
} from '../api/listing-changes.js';
import {
  probeListingAudit,
  validateListingAuditReadPath,
  validateListingAuditSnapshot,
} from '../api/health.js';

function transaction(results, calls = []) {
  return async build => {
    const sql = {
      query(text, params = []) {
        const query = { text, params };
        calls.push(query);
        return query;
      },
    };
    return build(sql).map((query, index) => results[index] ?? []);
  };
}

const DEDICATED_READER_IDENTITY = Object.freeze({
  session_user_name:'rwa_listing_reader_app',
  active_role_name:'rwa_listing_audit_reader',
  is_not_database_owner:true,
  is_not_superuser:true,
  is_not_catalog_writer:true,
  is_checkpoint_reader:true,
});

function listing(sourceKey, symbol = 'AAPL') {
  const [market, venue] = sourceKey.split(':');
  return {
    market,
    venue,
    venueSymbol:`${symbol}-${venue.toUpperCase()}-${market.toUpperCase()}`,
    canonicalSymbol:symbol,
    category:'equity',
    venueCategory:'equity',
    lifecycleStatus:'public',
    name:`${symbol} Inc.`,
    identityStatus:'verified',
    identityEvidence:`${venue} exact official product metadata`,
  };
}

function observations(extra = null) {
  return LISTING_SOURCE_KEYS.map(sourceKey => {
    const [market, venue] = sourceKey.split(':');
    return {
      market,
      venue,
      status:'full',
      reason:null,
      listings:[listing(sourceKey), ...(extra?.sourceKey === sourceKey ? [listing(sourceKey, extra.symbol)] : [])],
    };
  });
}

function bundleAt(at, previousState = null, extra = null) {
  const merged = mergeListingAudit(previousState, observations(extra), new Date(at));
  return { merged, bundle:compactListingAuditBundle(merged.state, merged.snapshot) };
}

function runtime(bundle, status = bundle ? 'stored' : 'empty') {
  if (!bundle) return { status, bundle:null, observedAt:null, checksum:null, error:null };
  const prepared = prepareListingAuditCheckpoint(bundle);
  return {
    status,
    bundle,
    observedAt:prepared.observedAt,
    checksum:prepared.payloadSha256,
    error:null,
  };
}

function durable(bundle, status = bundle ? 'stored' : 'empty') {
  return runtime(bundle, status);
}

function responseRecorder() {
  return {
    statusCode:200,
    payload:null,
    headers:{},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

test('Listing Audit durable switches are explicit and default to current Runtime Cache behavior', () => {
  assert.equal(resolveListingCheckpointWriteMode({}), 'off');
  assert.equal(resolveListingReadMode({}), 'runtime-cache');
  assert.equal(resolveListingCheckpointWriteMode({ LISTING_CHECKPOINT_WRITE_MODE:'SHADOW' }), 'shadow');
  assert.equal(resolveListingReadMode({ LISTING_READ_MODE:'dual-read' }), 'dual-read');
  assert.equal(resolveListingReadMode({ LISTING_READ_MODE:'durable-fallback' }), 'durable-fallback');
  assert.throws(() => resolveListingCheckpointWriteMode({ LISTING_CHECKPOINT_WRITE_MODE:'on' }), /off, shadow, or required/);
  assert.throws(() => resolveListingReadMode({ LISTING_READ_MODE:'postgres' }), /runtime-cache, dual-read, or durable-fallback/);
});

test('checkpoint accepts only an exact compact ten-source bundle with matching timestamp', () => {
  const { bundle } = bundleAt('2026-08-31T00:45:00.000Z');
  const prepared = prepareListingAuditCheckpoint(bundle);
  assert.equal(prepared.checkpointKey, LISTING_AUDIT_CHECKPOINT_KEY);
  assert.equal(prepared.bundleFormat, LISTING_AUDIT_BUNDLE_FORMAT);
  assert.equal(prepared.sourceCount, 10);
  assert.equal(prepared.activeListingCount, 10);
  assert.match(prepared.payloadSha256, /^[0-9a-f]{64}$/);
  assert.throws(
    () => prepareListingAuditCheckpoint(bundle, '2026-08-31T00:46:00.000Z'),
    /timestamp does not match/,
  );
  const missingSource = structuredClone(bundle);
  missingSource.snapshot.sources.pop();
  assert.throws(() => prepareListingAuditCheckpoint(missingSource), /exact ten-source set/);
  const incompatible = structuredClone(bundle);
  incompatible.snapshot.schemaVersion = 'rwa-listing-audit/v0';
  assert.throws(() => prepareListingAuditCheckpoint(incompatible), /schema is incompatible/);
  const inconsistentCount = structuredClone(bundle);
  inconsistentCount.snapshot.counts.activeListings += 1;
  assert.throws(() => prepareListingAuditCheckpoint(inconsistentCount), /state and public counts do not reconcile/);
  const detachedListing = structuredClone(bundle);
  detachedListing.state.sources['perp:binance'].listingKeys = [];
  assert.throws(() => prepareListingAuditCheckpoint(detachedListing), /active listings do not reconcile/);
});

test('durable checkpoint read validates checksum, bytes, schema, source set, and least-privilege role', async () => {
  const calls = [];
  const { bundle } = bundleAt('2026-08-31T00:45:00.000Z');
  const prepared = prepareListingAuditCheckpoint(bundle);
  const row = {
    checkpoint_key:prepared.checkpointKey,
    bundle_format:prepared.bundleFormat,
    schema_version:prepared.schemaVersion,
    observed_at:prepared.observedAt,
    payload_text:prepared.payloadText,
    payload_sha256:prepared.payloadSha256,
    payload_bytes:prepared.payloadBytes,
    source_count:prepared.sourceCount,
    active_listing_count:prepared.activeListingCount,
  };
  const result = await readListingAuditCheckpoint({
    env:{ LISTING_DATABASE_URL:'postgresql://reader.test.invalid/database' },
    runTransaction:transaction([[], [DEDICATED_READER_IDENTITY], [row]], calls),
  });
  assert.equal(result.status, 'stored');
  assert.deepEqual(result.bundle, bundle);
  assert.match(calls[0].text, /^SET LOCAL ROLE rwa_listing_audit_reader$/);
  assert.match(calls[1].text, /session_user::text/);
  assert.match(calls[1].text, /is_not_catalog_writer/);
  assert.match(calls[2].text, /FROM publication\.listing_audit_checkpoint/);

  const dateResult = await readListingAuditCheckpoint({
    env:{ LISTING_DATABASE_URL:'postgresql://reader.test.invalid/database' },
    runTransaction:transaction([[], [DEDICATED_READER_IDENTITY], [{
      ...row,
      observed_at:new Date(prepared.observedAt),
    }]]),
  });
  assert.equal(dateResult.status, 'stored');
  assert.equal(dateResult.observedAt, prepared.observedAt);

  const corrupt = await readListingAuditCheckpoint({
    env:{ LISTING_DATABASE_URL:'postgresql://reader.test.invalid/database' },
    runTransaction:transaction([[], [DEDICATED_READER_IDENTITY], [{ ...row, payload_sha256:'0'.repeat(64) }]]),
  });
  assert.equal(corrupt.status, 'unavailable');
  assert.equal(corrupt.bundle, null);

  const ownerConnection = await readListingAuditCheckpoint({
    env:{ LISTING_DATABASE_URL:'postgresql://reader.test.invalid/database' },
    runTransaction:transaction([[], [{ ...DEDICATED_READER_IDENTITY, is_not_catalog_writer:false }], [row]]),
  });
  assert.equal(ownerConnection.status, 'unavailable');
  assert.match(ownerConnection.error, /dedicated least-privilege reader/);
});

test('checkpoint writer is bounded, cycle-linked, idempotent, and stale-fenced', async () => {
  const calls = [];
  const { bundle } = bundleAt('2026-08-31T00:45:00.000Z');
  const result = await writeListingAuditCheckpoint(bundle, bundle.snapshot.generatedAt, {
    env:{
      LISTING_CHECKPOINT_WRITE_MODE:'required',
      DATABASE_URL:'postgresql://test.invalid/database',
    },
    runTransaction:transaction([[], [{
      checkpoint_key:LISTING_AUDIT_CHECKPOINT_KEY,
      observed_at:bundle.snapshot.generatedAt,
    }]], calls),
  });
  assert.equal(result.status, 'stored');
  assert.match(calls[0].text, /^SET LOCAL ROLE rwa_catalog_shadow_writer$/);
  assert.match(calls[1].text, /FROM ingest\.collection_cycle/);
  assert.match(calls[1].text, /cycle\.completed_at = \$4::timestamptz/);
  assert.match(calls[1].text, /observed_at < EXCLUDED\.observed_at/);
  assert.match(calls[1].text, /payload_sha256 = EXCLUDED\.payload_sha256/);

  const stale = await writeListingAuditCheckpoint(bundle, bundle.snapshot.generatedAt, {
    env:{
      LISTING_CHECKPOINT_WRITE_MODE:'required',
      DATABASE_URL:'postgresql://test.invalid/database',
    },
    runTransaction:transaction([[], []]),
  });
  assert.equal(stale.status, 'stale');
});

test('dual-read observes without changing the served source; durable fallback restores only an exact checkpoint', () => {
  const first = bundleAt('2026-08-30T00:45:00.000Z');
  const second = bundleAt('2026-08-31T00:45:00.000Z', first.merged.state);
  const dual = selectListingAuditBundle({
    mode:'dual-read',
    runtime:runtime(first.bundle),
    durable:durable(second.bundle),
  });
  assert.deepEqual(dual.bundle, first.bundle);
  assert.equal(dual.readPath.source, 'runtime-cache');
  assert.equal(dual.readPath.reconciliation, 'runtime-behind');

  const recovered = selectListingAuditBundle({
    mode:'durable-fallback',
    runtime:runtime(null),
    durable:durable(second.bundle),
  });
  assert.deepEqual(recovered.bundle, second.bundle);
  assert.equal(recovered.readPath.source, 'postgres-checkpoint');
  assert.equal(recovered.readPath.reconciliation, 'runtime-empty');

  assert.throws(() => selectListingAuditBundle({
    mode:'durable-fallback',
    runtime:runtime(second.bundle),
    durable:durable(first.bundle),
  }), /runtime-ahead/);

  const divergent = structuredClone(second.bundle);
  divergent.snapshot.persistence.status = 'unavailable';
  assert.throws(() => selectListingAuditBundle({
    mode:'durable-fallback',
    runtime:runtime(second.bundle),
    durable:durable(divergent),
  }), /checksum-mismatch/);
});

test('public fallback exposes its source while dual-read keeps a cache miss warming', async () => {
  const { bundle } = bundleAt('2026-08-31T00:45:00.000Z');
  const prepared = prepareListingAuditCheckpoint(bundle);
  const checkpoint = { ...durable(bundle), bytes:prepared.payloadBytes };
  const fallback = await readListingChangesSnapshot({
    env:{ LISTING_READ_MODE:'durable-fallback' },
    cache:{ async get() { return null; } },
    readCheckpoint:async () => checkpoint,
  });
  assert.equal(fallback.generatedAt, bundle.snapshot.generatedAt);
  assert.equal(fallback.persistence.readPath.source, 'postgres-checkpoint');

  const shadow = await readListingChangesSnapshot({
    env:{ LISTING_READ_MODE:'dual-read' },
    cache:{ async get() { return null; } },
    readCheckpoint:async () => checkpoint,
  });
  assert.equal(shadow.generatedAt, null);
  assert.equal(shadow.persistence.readPath.source, 'empty');
  assert.equal(shadow.persistence.readPath.durableCheckpoint.status, 'stored');
});

test('durable fallback tolerates a Runtime Cache read error but fails closed on an invalid checkpoint', async () => {
  const { bundle } = bundleAt('2026-08-31T00:45:00.000Z');
  const recovered = await readListingChangesSnapshot({
    env:{ LISTING_READ_MODE:'durable-fallback' },
    cache:{ async get() { throw new Error('regional cache unavailable'); } },
    readCheckpoint:async () => durable(bundle),
  });
  assert.equal(recovered.persistence.readPath.source, 'postgres-checkpoint');
  assert.equal(recovered.persistence.readPath.reconciliation, 'runtime-unavailable');

  await assert.rejects(
    readListingChangesSnapshot({
      env:{ LISTING_READ_MODE:'durable-fallback' },
      cache:{ async get() { return null; } },
      readCheckpoint:async () => ({
        status:'unavailable', bundle:null, observedAt:null, checksum:null, error:'checksum mismatch',
      }),
    }),
    /durable checkpoint unavailable/,
  );
});

test('Health requires a coherent configured read path and warns while the disposable replica is degraded', async () => {
  const { bundle } = bundleAt('2026-08-31T00:45:00.000Z');
  const snapshot = await readListingChangesSnapshot({
    env:{ LISTING_READ_MODE:'durable-fallback' },
    cache:{ async get() { return null; } },
    readCheckpoint:async () => durable(bundle),
  });
  const readPath = validateListingAuditReadPath(snapshot, 'durable-fallback');
  assert.equal(readPath.valid, true);
  assert.equal(readPath.degraded, true);
  const health = validateListingAuditSnapshot(snapshot, Date.parse('2026-08-31T01:00:00Z'), {
    requireReadPath:true,
    expectedReadMode:'durable-fallback',
  });
  assert.equal(health.readPathContractValid, true);
  assert.equal(health.readPathSource, 'postgres-checkpoint');
  assert.equal(health.status, 'warn');

  const impossible = structuredClone(snapshot);
  impossible.persistence.readPath.source = 'runtime-cache';
  assert.equal(validateListingAuditSnapshot(impossible, Date.parse('2026-08-31T01:00:00Z'), {
    requireReadPath:true,
    expectedReadMode:'durable-fallback',
  }).status, 'fail');
});

test('Health Listing probe bypasses stale CDN responses before validating the read path', async () => {
  const previousFetch = globalThis.fetch;
  let requestedUrl = null;
  let requestedHeaders = null;
  globalThis.fetch = async (url, options = {}) => {
    requestedUrl = url;
    requestedHeaders = options.headers;
    return new Response(JSON.stringify({ error:'synthetic response' }), {
      status:503,
      headers:{ 'content-type':'application/json' },
    });
  };
  try {
    const result = await probeListingAudit('https://preview.example.invalid');
    assert.equal(result.status, 'fail');
    assert.equal(requestedUrl, 'https://preview.example.invalid/api/listing-changes');
    assert.equal(requestedHeaders.Accept, 'application/json');
    assert.equal(requestedHeaders['Cache-Control'], 'no-cache');
    assert.equal(requestedHeaders.Pragma, 'no-cache');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('required checkpoint failure blocks Runtime Cache publication while shadow failure remains diagnostic', async () => {
  const request = { headers:{ host:'example.invalid' } };
  let requiredCacheWrites = 0;
  const requiredResponse = responseRecorder();
  await runListingAudit(request, requiredResponse, {
    env:{ LISTING_CHECKPOINT_WRITE_MODE:'required' },
    cache:{
      async get() { return null; },
      async set() { requiredCacheWrites += 1; },
    },
    collectObservations:async () => observations(),
    now:() => '2026-08-31T00:45:00.000Z',
    writeCheckpoint:async () => ({ mode:'required', status:'unavailable', error:'database unavailable' }),
  });
  assert.equal(requiredResponse.statusCode, 503);
  assert.equal(requiredCacheWrites, 0);

  let shadowBundle = null;
  const shadowResponse = responseRecorder();
  await runListingAudit(request, shadowResponse, {
    env:{ LISTING_CHECKPOINT_WRITE_MODE:'shadow' },
    cache:{
      async get() { return shadowBundle; },
      async set(_key, value) { shadowBundle = value; },
    },
    collectObservations:async () => observations(),
    now:() => '2026-08-31T00:45:00.000Z',
    writeCheckpoint:async () => ({ mode:'shadow', status:'unavailable', error:'database unavailable' }),
  });
  assert.equal(shadowResponse.statusCode, 200);
  assert.ok(shadowBundle);
  assert.equal(shadowResponse.payload.persistence.durableCheckpoint.writeStatus, 'unavailable');
});

test('writer recovers the exact durable state after cache eviction without synthesizing the current catalog as New', async () => {
  const first = bundleAt('2026-08-30T00:45:00.000Z');
  const nextObservations = observations({ sourceKey:'perp:binance', symbol:'NEWCO' });
  let cached = null;
  const response = responseRecorder();
  await runListingAudit({ headers:{ host:'example.invalid' } }, response, {
    env:{ LISTING_READ_MODE:'durable-fallback' },
    cache:{
      async get() { return cached; },
      async set(_key, value) { cached = value; },
    },
    readCheckpoint:async () => durable(first.bundle),
    collectObservations:async () => nextObservations,
    now:() => '2026-08-31T00:45:00.000Z',
  });
  assert.equal(response.statusCode, 200);
  assert.ok(cached);
  const newEvents = response.payload.events.filter(event => event.changeType === 'new');
  assert.equal(newEvents.length, 1);
  assert.equal(newEvents[0].venue, 'binance');
  assert.equal(newEvents[0].venueSymbol, 'NEWCO-BINANCE-PERP');
});

test('lease-protected writer reselects the durable checkpoint after cache eviction', async () => {
  const first = bundleAt('2026-08-30T00:45:00.000Z');
  let cached = null;
  let checkpointReads = 0;
  const releases = [];
  const response = responseRecorder();
  await runListingAudit({ headers:{ host:'example.invalid' } }, response, {
    env:{ PG_WRITE_MODE:'shadow', LISTING_READ_MODE:'durable-fallback' },
    cache:{
      async get() { return cached; },
      async set(_key, value) { cached = value; },
    },
    readCheckpoint:async () => { checkpointReads += 1; return durable(first.bundle); },
    collectObservations:async () => observations({ sourceKey:'perp:binance', symbol:'NEWCO' }),
    now:() => '2026-08-31T00:45:00.000Z',
    acquirePublicationLease:async input => ({
      mode:'shadow', acquired:true, enforced:true, status:'acquired',
      ownerToken:'00000000-0000-4000-8000-000000000031',
      observedAt:input.observedAt, checksum:input.checksum,
    }),
    durableWrite:async () => ({ pgMode:'shadow', status:'stored', publishAllowed:true }),
    renewPublicationLease:async lease => ({ ...lease, status:'renewed' }),
    recordRuntimeCacheCommit:async commit => ({ mode:'shadow', status:commit.status }),
    releasePublicationLease:async (_lease, options) => { releases.push(options.status); },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(checkpointReads, 2, 'initial read plus post-lease revalidation');
  assert.equal(response.payload.events.filter(event => event.changeType === 'new').length, 1);
  assert.deepEqual(releases, ['published']);
});

import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LISTING_SOURCE_KEYS,
  mergeListingAudit,
} from '../api/_lib/listing-audit.js';
import {
  LISTING_NORMALIZED_ARTIFACT_FORMAT,
  archiveListingAuditArtifacts,
  buildListingAuditPgBatch,
  buildListingAuditPgQueries,
  putContentAddressedCatalogBlob,
  recordListingAuditRuntimeCacheCommit,
  resolvePgWriteMode,
  resolveRawArchiveMode,
  runOptionalListingAuditPgWrite,
  utcListingAuditBucket,
} from '../api/_lib/listing-pg-shadow.js';
import { runListingAudit } from '../api/listing-changes.js';

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function listing(sourceKey, symbol = 'AAPL', overrides = {}) {
  const [market, venue] = sourceKey.split(':');
  const krakenTokenized = market === 'spot' && venue === 'kraken';
  const venueSymbol = krakenTokenized
    ? `${symbol}XUSD`
    : market === 'perp' ? `${symbol}-${venue.toUpperCase()}-PERP` : `${symbol}-${venue.toUpperCase()}-SPOT`;
  return {
    market,
    venue,
    venueSymbol,
    ...(krakenTokenized ? { marketQuerySymbol: `${symbol}xUSD` } : {}),
    canonicalSymbol: symbol,
    category: 'equity',
    name: `${symbol} Inc.`,
    identityStatus: 'verified',
    identityEvidence: `${venue} exact official product metadata`,
    ...overrides,
  };
}

function fullObservations(overrides = {}) {
  return LISTING_SOURCE_KEYS.map(sourceKey => {
    const [market, venue] = sourceKey.split(':');
    return overrides[sourceKey] || {
      market,
      venue,
      status: 'full',
      listings: [listing(sourceKey)],
      reason: null,
    };
  });
}

function mergeAt(previousState, observations, at) {
  return mergeListingAudit(previousState, observations, new Date(at));
}

function baselineInput(observations = fullObservations(), at = '2026-08-15T00:45:00.000Z') {
  return {
    observations,
    merged: mergeAt(null, observations, at),
    observedAt: at,
  };
}

function storedArtifacts(batch) {
  return batch.sourceRuns.map(sourceRun => ({
    sourceKey: sourceRun.sourceKey,
    ...sourceRun.artifact,
    body: undefined,
    storageProvider: 'vercel-blob',
    objectUri: `https://blob.example/${sourceRun.artifact.pathname}`,
    archivedAt: batch.observedAt,
    archiveStatus: 'stored',
    errorSummary: null,
  }));
}

test('PostgreSQL and normalized archive switches default off and reject invalid configuration', () => {
  assert.equal(resolvePgWriteMode({}), 'off');
  assert.equal(resolveRawArchiveMode({}), 'off');
  assert.equal(resolvePgWriteMode({ PG_WRITE_MODE: 'SHADOW' }), 'shadow');
  assert.equal(resolveRawArchiveMode({ RAW_ARCHIVE_MODE: 'required' }), 'required');
  assert.throws(() => resolvePgWriteMode({ PG_WRITE_MODE: 'write' }), /off, shadow, or required/);
  assert.throws(() => resolveRawArchiveMode({ RAW_ARCHIVE_MODE: 'yes' }), /off, shadow, or required/);
  assert.equal(utcListingAuditBucket('2026-08-15T23:59:59Z'), '2026-08-15T00:00:00.000Z');
});

test('first daily baseline creates ten exact source runs and memberships without lifecycle events', () => {
  const input = baselineInput();
  const batch = buildListingAuditPgBatch({
    ...input,
    env: { VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_SHA: 'abcdef1234567' },
  });

  assert.equal(input.merged.snapshot.status, 'warming');
  assert.equal(input.merged.newEvents.length, 0);
  assert.equal(batch.sourceRuns.length, 10);
  assert.deepEqual(batch.sourceRuns.map(row => row.sourceKey), LISTING_SOURCE_KEYS);
  assert.equal(batch.sourceRuns.reduce((sum, row) => sum + row.memberships.length, 0), 10);
  assert.equal(batch.events.length, 0);
  assert.equal(batch.status, 'complete');

  const kraken = batch.sourceRuns.find(row => row.listingSourceKey === 'spot:kraken');
  assert.equal(kraken.sourceKey, 'spot:kraken');
  assert.equal(kraken.memberships[0].officialProductKey, 'AAPLxUSD');
  assert.equal(kraken.memberships[0].officialVenueSymbol, 'AAPLxUSD');
  assert.equal(kraken.memberships[0].normalizedVenueSymbol, 'AAPLXUSD');
  assert.equal(kraken.memberships[0].assetKey, 'equity:AAPL');
  assert.match(kraken.artifact.pathname, /^catalog\/preview\/rwa-listing-audit\/2026-08-15\/spot:kraken\/[0-9a-f]{64}\.json$/);

  const artifact = JSON.parse(kraken.artifact.body);
  assert.equal(artifact.schemaVersion, LISTING_NORMALIZED_ARTIFACT_FORMAT);
  assert.equal(artifact.artifactKind, 'normalized');
  assert.equal(artifact.environment, 'preview');
  assert.equal(artifact.source.sourceKey, 'spot:kraken');
  assert.equal(artifact.listings[0].officialProductKey, 'AAPLxUSD');
  assert.equal(createHash('sha256').update(kraken.artifact.body).digest('hex'), kraken.artifact.sha256);
});

test('review-required candidates enter only review_case and do not suppress verified memberships', () => {
  const observations = fullObservations({
    'spot:gate': {
      market: 'spot',
      venue: 'gate',
      status: 'full',
      listings: [
        listing('spot:gate'),
        listing('spot:gate', 'FUTURE', {
          identityStatus: 'review-required',
          identityEvidence: 'same canonical appears on another official RWA catalog; exact Gate wrapper pending',
        }),
      ],
    },
  });
  const batch = buildListingAuditPgBatch(baselineInput(observations));
  const gate = batch.sourceRuns.find(row => row.listingSourceKey === 'spot:gate');

  assert.equal(gate.catalogStatus, 'full');
  assert.equal(gate.identityStatus, 'partial');
  assert.equal(gate.status, 'partial');
  assert.equal(gate.admittedListingCount, 1);
  assert.equal(gate.rejectedListingCount, 1);
  assert.deepEqual(gate.memberships.map(row => row.canonicalUnderlying), ['AAPL']);
  assert.deepEqual(gate.reviewCases.map(row => row.officialProductKey), ['FUTURE-GATE-SPOT']);
  assert.equal(gate.memberships.some(row => row.canonicalUnderlying === 'FUTURE'), false);
  assert.equal(batch.status, 'partial');
});

test('pending-removal Partial persists only explicitly observed present rows and never manufactures absence', () => {
  const baselineObservations = fullObservations({
    'perp:gate': {
      market: 'perp', venue: 'gate', status: 'full',
      listings: [listing('perp:gate', 'AAPL'), listing('perp:gate', 'MSFT')],
    },
  });
  const first = mergeAt(null, baselineObservations, '2026-08-14T00:45:00Z');
  const partialObservations = fullObservations({
    'perp:gate': {
      market: 'perp', venue: 'gate', status: 'full',
      listings: [listing('perp:gate', 'AAPL')],
    },
  });
  const partial = mergeAt(first.state, partialObservations, '2026-08-15T00:45:00Z');
  const batch = buildListingAuditPgBatch({
    observations: partialObservations,
    merged: partial,
    observedAt: partial.snapshot.generatedAt,
  });
  const gate = batch.sourceRuns.find(row => row.listingSourceKey === 'perp:gate');

  assert.equal(partial.snapshot.sources.find(row => row.sourceKey === 'perp:gate').status, 'partial');
  assert.equal(gate.status, 'partial');
  assert.equal(gate.catalogStatus, 'partial');
  assert.deepEqual(gate.memberships.map(row => row.canonicalUnderlying), ['AAPL']);
  assert.equal(gate.memberships.some(row => row.canonicalUnderlying === 'MSFT'), false);

  const calls = [];
  buildListingAuditPgQueries({ query(text, params = []) { calls.push({ text, params }); return { text, params }; } }, batch, []);
  const membershipSql = calls.find(call => call.text.includes('INSERT INTO ingest.catalog_membership')).text;
  assert.match(membershipSql, /source_id, presence_status/);
  assert.match(membershipSql, /'present'/);
  assert.doesNotMatch(membershipSql, /'absent'/);
  assert.doesNotMatch(membershipSql, /DELETE FROM ingest\.catalog_membership/i);
});

test('Unavailable and invalid Crypto observations fail closed without identity or membership writes', () => {
  const firstInput = baselineInput();
  const unavailableObservations = fullObservations({
    'spot:okx': {
      market: 'spot', venue: 'okx', status: 'unavailable', listings: [], reason: 'official catalog timeout',
    },
  });
  const unavailableMerged = mergeAt(firstInput.merged.state, unavailableObservations, '2026-08-16T00:45:00Z');
  const unavailableBatch = buildListingAuditPgBatch({ observations: unavailableObservations, merged: unavailableMerged });
  const okx = unavailableBatch.sourceRuns.find(row => row.listingSourceKey === 'spot:okx');
  assert.equal(okx.status, 'unavailable');
  assert.equal(okx.memberships.length, 0);
  assert.equal(okx.reviewCases.length, 0);

  const invalidObservations = fullObservations({
    'spot:gate': {
      market: 'spot', venue: 'gate', status: 'full',
      listings: [listing('spot:gate', 'BTC', { category: 'crypto' })],
    },
  });
  const invalidMerged = mergeAt(null, invalidObservations, '2026-08-15T00:45:00Z');
  const invalidBatch = buildListingAuditPgBatch({ observations: invalidObservations, merged: invalidMerged });
  const gate = invalidBatch.sourceRuns.find(row => row.listingSourceKey === 'spot:gate');
  assert.equal(gate.status, 'unavailable');
  assert.equal(gate.memberships.length, 0);
  assert.equal(gate.reviewCases.length, 0);
  assert.equal(gate.rejectedRows[0].reasonCode, 'IDENTITY_NORMALIZATION_REJECTED');
});

test('lifecycle shadow rows exclude review candidates and are empty on baseline and same-day retry', () => {
  const baseline = baselineInput();
  assert.equal(buildListingAuditPgBatch(baseline).events.length, 0);

  const changedObservations = fullObservations({
    'perp:gate': {
      market: 'perp', venue: 'gate', status: 'full',
      listings: [
        listing('perp:gate'),
        listing('perp:gate', 'NEW'),
        listing('perp:gate', 'PENDING', { identityStatus: 'review-required' }),
      ],
    },
  });
  const changed = mergeAt(baseline.merged.state, changedObservations, '2026-08-16T00:45:00Z');
  assert.equal(changed.newEvents.length, 2);
  const changedBatch = buildListingAuditPgBatch({ observations: changedObservations, merged: changed });
  assert.deepEqual(changedBatch.events.map(row => row.eventType), ['listed']);
  assert.equal(changedBatch.events[0].normalizedVenueSymbol, 'NEW-GATE-PERP');

  const repeated = mergeAt(changed.state, changedObservations, '2026-08-16T01:45:00Z');
  assert.equal(repeated.newEvents.length, 0);
  assert.equal(buildListingAuditPgBatch({ observations: changedObservations, merged: repeated }).events.length, 0);
});

test('confirmed delisting closes the exact current instrument version after event capture and relisting creates a new present version', () => {
  const baselineObservations = fullObservations({
    'perp:gate': {
      market:'perp', venue:'gate', status:'full',
      listings:[listing('perp:gate'), listing('perp:gate', 'RETURN')],
    },
  });
  const baseline = mergeAt(null, baselineObservations, '2026-08-14T00:45:00Z');
  const missingObservations = fullObservations();
  const pending = mergeAt(baseline.state, missingObservations, '2026-08-15T00:45:00Z');
  const delisted = mergeAt(pending.state, missingObservations, '2026-08-16T00:45:00Z');
  const delistedBatch = buildListingAuditPgBatch({ observations:missingObservations, merged:delisted });
  assert.deepEqual(delistedBatch.events.map(row => [row.eventType, row.normalizedVenueSymbol]), [
    ['delisted', 'RETURN-GATE-PERP'],
  ]);
  const calls = [];
  buildListingAuditPgQueries({ query(text, params = []) { calls.push({ text, params }); return { text, params }; } }, delistedBatch, []);
  const eventIndex = calls.findIndex(call => call.text.includes('INSERT INTO analytics.catalog_change_event'));
  const closeIndex = calls.findIndex(call => call.text.includes("incoming.event_type = 'delisted'"));
  assert.ok(eventIndex > 0 && closeIndex > eventIndex, 'event evidence must bind the old current version before SCD2 close');
  assert.match(calls[closeIndex].text, /SET valid_to = incoming\.observed_at/);
  assert.match(calls[closeIndex].text, /current\.valid_to IS NULL/);

  const sameDayRetry = mergeAt(delisted.state, missingObservations, '2026-08-16T01:45:00Z');
  assert.equal(buildListingAuditPgBatch({ observations:missingObservations, merged:sameDayRetry }).events.length, 0);

  const relistedObservations = fullObservations({
    'perp:gate': {
      market:'perp', venue:'gate', status:'full',
      listings:[listing('perp:gate'), listing('perp:gate', 'RETURN')],
    },
  });
  const relisted = mergeAt(delisted.state, relistedObservations, '2026-08-17T00:45:00Z');
  const relistedBatch = buildListingAuditPgBatch({ observations:relistedObservations, merged:relisted });
  assert.deepEqual(relistedBatch.events.map(row => [row.eventType, row.normalizedVenueSymbol]), [
    ['relisted', 'RETURN-GATE-PERP'],
  ]);
  assert.equal(
    relistedBatch.sourceRuns.find(row => row.listingSourceKey === 'perp:gate')
      .memberships.some(row => row.normalizedVenueSymbol === 'RETURN-GATE-PERP'),
    true,
  );
  const relistCalls = [];
  buildListingAuditPgQueries({ query(text, params = []) { relistCalls.push({ text, params }); return { text, params }; } }, relistedBatch, []);
  const instrumentVersionInsert = relistCalls.find(call => call.text.includes('INSERT INTO identity.instrument_version'));
  assert.match(instrumentVersionInsert.text, /WHERE NOT EXISTS/);
  assert.match(instrumentVersionInsert.text, /current\.valid_to IS NULL/);
});

test('transaction queries are least-privilege, idempotent, exact-case, and include evidence and lifecycle lineage', async () => {
  const input = baselineInput();
  const batch = buildListingAuditPgBatch(input);
  const artifacts = storedArtifacts(batch);
  const calls = [];
  const queries = buildListingAuditPgQueries({
    query(text, params = []) {
      const query = { text, params };
      calls.push(query);
      return query;
    },
  }, batch, artifacts);

  assert.equal(queries.length, calls.length);
  assert.match(calls[0].text, /^SET LOCAL ROLE rwa_catalog_shadow_writer$/);
  assert.match(calls[1].text, /statement_timeout = '15s'/);
  assert.match(calls[2].text, /lock_timeout = '3s'/);
  assert.ok(calls.slice(3).every(call => /ON CONFLICT|UPDATE identity\.|WHERE NOT EXISTS/.test(call.text)));

  const sourceInsert = calls.find(call => call.text.includes('INSERT INTO identity.source'));
  const sourcePayload = JSON.parse(sourceInsert.params[0]);
  assert.deepEqual(sourcePayload.map(row => row.source_key), LISTING_SOURCE_KEYS);
  assert.equal(sourcePayload.some(row => row.source_key.endsWith(':official-catalog')), false);

  const instrumentInsert = calls.find(call => call.text.includes('INSERT INTO identity.instrument ('));
  const instrumentPayload = JSON.parse(instrumentInsert.params[0]);
  assert.equal(instrumentPayload.find(row => row.source_key === 'spot:kraken').official_product_key, 'AAPLxUSD');

  const membershipInsert = calls.find(call => call.text.includes('INSERT INTO ingest.catalog_membership'));
  assert.match(membershipInsert.text, /source_id, presence_status/);
  assert.match(membershipInsert.text, /ON CONFLICT \(source_run_id, instrument_version_id\)/);
  const evidenceInsert = calls.find(call => call.text.includes('INSERT INTO identity.evidence'));
  assert.match(evidenceInsert.text, /'official-catalog'/);
  assert.match(evidenceInsert.text, /ON CONFLICT \(source_run_id, instrument_id, evidence_kind\)/);
  const eventInsert = calls.find(call => call.text.includes('INSERT INTO analytics.catalog_change_event'));
  assert.match(eventInsert.text, /ON CONFLICT \(source_id, instrument_version_id, event_type, effective_day\)/);
  assert.match(eventInsert.text, /previous_source_run_id/);
  assert.match(eventInsert.text, /LEFT JOIN LATERAL/);
  assert.match(eventInsert.text, /prior_cycle\.bucket_at < \$3::timestamptz/);
});

test('same UTC bucket and catalog produce stable natural keys, artifacts, and checksums', () => {
  const input = baselineInput();
  const left = buildListingAuditPgBatch(input);
  const right = buildListingAuditPgBatch(input);
  assert.equal(left.bucketAt, right.bucketAt);
  assert.equal(left.checksum, right.checksum);
  assert.deepEqual(
    left.sourceRuns.map(row => [row.sourceKey, row.artifact.pathname, row.artifact.sha256]),
    right.sourceRuns.map(row => [row.sourceKey, row.artifact.pathname, row.artifact.sha256]),
  );
});

test('content-addressed private Blob writes never overwrite and accept only a matching retry', async () => {
  const body = '{"schemaVersion":"normalized-catalog-v1"}\n';
  const artifact = { byteLength: Buffer.byteLength(body) };
  const pathname = `catalog/preview/rwa-listing-audit/2026-08-15/spot:kraken/${'a'.repeat(64)}.json`;
  let putOptions;
  const first = await putContentAddressedCatalogBlob(pathname, body, {
    artifact,
    blobClient: {
      async put(path, value, options) {
        assert.equal(path, pathname);
        assert.equal(value, body);
        putOptions = options;
        return { pathname:path, size:artifact.byteLength, url:'https://blob.example/object' };
      },
      async head() { throw new Error('head must not run after a successful immutable create'); },
    },
  });
  assert.equal(first.url, 'https://blob.example/object');
  assert.deepEqual(
    { access:putOptions.access, addRandomSuffix:putOptions.addRandomSuffix, allowOverwrite:putOptions.allowOverwrite },
    { access:'private', addRandomSuffix:false, allowOverwrite:false },
  );

  const retry = await putContentAddressedCatalogBlob(pathname, body, {
    artifact,
    blobClient: {
      async put(_path, _value, options) {
        assert.equal(options.allowOverwrite, false);
        throw new Error('blob already exists');
      },
      async head(path) {
        return { pathname:path, size:artifact.byteLength, url:'https://blob.example/object' };
      },
    },
  });
  assert.equal(retry.url, 'https://blob.example/object');

  await assert.rejects(() => putContentAddressedCatalogBlob(pathname, body, {
    artifact,
    blobClient: {
      async put() { throw new Error('blob already exists'); },
      async head(path) { return { pathname:path, size:artifact.byteLength + 1, url:'https://blob.example/object' }; },
    },
  }), /does not match/);
});

test('archive off skips Blob loading, while shadow and required preserve their failure semantics', async () => {
  const batch = buildListingAuditPgBatch(baselineInput());
  let putCalls = 0;
  const skipped = await archiveListingAuditArtifacts(batch, {
    mode: 'off',
    putArtifact: async () => { putCalls += 1; },
  });
  assert.equal(putCalls, 0);
  assert.ok(skipped.every(row => row.archiveStatus === 'pending' && row.metadata.archiveDisposition === 'skipped'));

  const shadow = await archiveListingAuditArtifacts(batch, {
    mode: 'shadow',
    putArtifact: async () => { throw new Error('Blob offline'); },
  });
  assert.ok(shadow.every(row => row.archiveStatus === 'failed'));
  await assert.rejects(() => archiveListingAuditArtifacts(batch, {
    mode: 'required',
    putArtifact: async () => { throw new Error('Blob offline'); },
  }), /Blob offline/);
});

test('independent PG and archive modes do not load or call the disabled sink', async () => {
  const input = baselineInput();
  let archiveCalls = 0;
  let writeCalls = 0;
  const bothOff = await runOptionalListingAuditPgWrite(input, {
    env: { PG_WRITE_MODE:'off', RAW_ARCHIVE_MODE:'off' },
    archiveArtifacts: async () => { archiveCalls += 1; return []; },
    writeBatch: async () => { writeCalls += 1; },
  });
  assert.deepEqual(bothOff, { pgMode:'off', archiveMode:'off', status:'off' });
  assert.equal(archiveCalls, 0);
  assert.equal(writeCalls, 0);

  const archiveOnly = await runOptionalListingAuditPgWrite(input, {
    env: { PG_WRITE_MODE:'off', RAW_ARCHIVE_MODE:'shadow' },
    archiveArtifacts: async batch => {
      archiveCalls += 1;
      return storedArtifacts(batch);
    },
    writeBatch: async () => { writeCalls += 1; },
  });
  assert.equal(archiveOnly.status, 'stored');
  assert.equal(writeCalls, 0);

  const pgOnly = await runOptionalListingAuditPgWrite(input, {
    env: { PG_WRITE_MODE:'shadow', RAW_ARCHIVE_MODE:'off' },
    archiveArtifacts: async (batch, { mode }) => {
      archiveCalls += 1;
      assert.equal(mode, 'off');
      return archiveListingAuditArtifacts(batch, { mode:'off' });
    },
    writeBatch: async (_batch, artifacts) => {
      writeCalls += 1;
      assert.ok(artifacts.every(row => row.archiveStatus === 'pending'));
      return { membershipCount:10 };
    },
  });
  assert.equal(pgOnly.status, 'stored');
  assert.equal(writeCalls, 1);
});

test('required sink failures reject, while shadow failures remain diagnostic-only', async () => {
  const input = baselineInput();
  await assert.rejects(() => runOptionalListingAuditPgWrite(input, {
    env: { PG_WRITE_MODE:'required', RAW_ARCHIVE_MODE:'off' },
    archiveArtifacts: batch => archiveListingAuditArtifacts(batch, { mode:'off' }),
    writeBatch: async () => { throw new Error('database offline'); },
  }), /Required PostgreSQL listing write failed/);

  let writeCalls = 0;
  await assert.rejects(() => runOptionalListingAuditPgWrite(input, {
    env: { PG_WRITE_MODE:'off', RAW_ARCHIVE_MODE:'required' },
    archiveArtifacts: async () => { throw new Error('archive offline'); },
    writeBatch: async () => { writeCalls += 1; },
  }), /Required normalized catalog archive failed/);
  assert.equal(writeCalls, 0);

  const errors = [];
  const shadow = await runOptionalListingAuditPgWrite(input, {
    env: { PG_WRITE_MODE:'shadow', RAW_ARCHIVE_MODE:'off' },
    logger: { error(...parts) { errors.push(parts.join(' ')); } },
    archiveArtifacts: batch => archiveListingAuditArtifacts(batch, { mode:'off' }),
    writeBatch: async () => { throw new Error('database offline'); },
  });
  assert.equal(shadow.status, 'partial');
  assert.match(shadow.error, /database offline/);
  assert.equal(errors.length, 1);
});

test('Runtime Cache sink commit uses the same daily attempt and preserves mode failure semantics', async () => {
  let transactionCalls = 0;
  const recorded = await recordListingAuditRuntimeCacheCommit({
    observedAt:'2026-08-15T00:45:00Z',
    status:'stored',
    rowCount:10,
    checksum:'a'.repeat(64),
  }, {
    env:{ PG_WRITE_MODE:'shadow' },
    runTransaction: async builder => {
      transactionCalls += 1;
      const calls = [];
      const queries = builder({ query(text, params = []) { calls.push({ text, params }); return { text, params }; } });
      assert.match(calls[0].text, /^SET LOCAL ROLE rwa_catalog_shadow_writer$/);
      assert.match(calls.at(-1).text, /runtime-cache-listing-audit/);
      assert.equal(calls.at(-1).params[2], '2026-08-15T00:00:00.000Z');
      assert.equal(calls.at(-1).params[4], 'stored');
      return queries.map((_query, index) => index === queries.length - 1 ? [{ sink_commit_id:'commit' }] : []);
    },
  });
  assert.deepEqual(recorded, { mode:'shadow', status:'stored' });
  assert.equal(transactionCalls, 1);

  const off = await recordListingAuditRuntimeCacheCommit({
    observedAt:'2026-08-15T00:45:00Z', status:'stored',
  }, {
    env:{ PG_WRITE_MODE:'off' },
    runTransaction: async () => { transactionCalls += 1; },
  });
  assert.deepEqual(off, { mode:'off', status:'off' });
  assert.equal(transactionCalls, 1);

  const shadow = await recordListingAuditRuntimeCacheCommit({
    observedAt:'2026-08-15T00:45:00Z', status:'failed', errorSummary:'cache failed',
  }, {
    env:{ PG_WRITE_MODE:'shadow' },
    logger:{ error() {} },
    runTransaction: async () => { throw new Error('database offline'); },
  });
  assert.equal(shadow.status, 'failed');
  const requiredBookkeepingFailure = await recordListingAuditRuntimeCacheCommit({
    observedAt:'2026-08-15T00:45:00Z', status:'stored',
  }, {
    env:{ PG_WRITE_MODE:'required' },
    logger:{ error() {} },
    runTransaction: async () => { throw new Error('database offline'); },
  });
  assert.equal(requiredBookkeepingFailure.status, 'failed');
});

test('required durable failure prevents Runtime Cache mutation, while shadow failure preserves current writer', async () => {
  const observations = fullObservations();
  const request = { headers:{ host:'avenir-rwa-analyst.vercel.app' } };
  let cacheWrites = 0;
  const cache = {
    async get() { return null; },
    async set() { cacheWrites += 1; },
  };
  const requiredResponse = responseRecorder();
  await runListingAudit(request, requiredResponse, {
    cache,
    collectObservations: async () => observations,
    now: () => '2026-08-15T00:45:00Z',
    durableWrite: async () => { throw new Error('required database failure'); },
  });
  assert.equal(requiredResponse.statusCode, 503);
  assert.equal(cacheWrites, 0);

  const shadowResponse = responseRecorder();
  const runtimeCommits = [];
  await runListingAudit(request, shadowResponse, {
    cache,
    collectObservations: async () => observations,
    now: () => '2026-08-15T00:45:00Z',
    durableWrite: async () => ({ pgMode:'shadow', archiveMode:'shadow', status:'failed' }),
    recordRuntimeCacheCommit: async commit => { runtimeCommits.push(commit); return { mode:'shadow', status:commit.status }; },
  });
  assert.equal(shadowResponse.statusCode, 200);
  assert.equal(shadowResponse.payload.status, 'warming');
  assert.equal(cacheWrites, 1);
  assert.deepEqual(runtimeCommits.map(row => row.status), ['stored']);

  const postCacheBookkeepingResponse = responseRecorder();
  await runListingAudit(request, postCacheBookkeepingResponse, {
    cache,
    collectObservations: async () => observations,
    now: () => '2026-08-15T00:45:00Z',
    durableWrite: async () => ({ pgMode:'required', archiveMode:'off', status:'stored' }),
    recordRuntimeCacheCommit: async () => { throw new Error('post-cache bookkeeping unavailable'); },
  });
  assert.equal(postCacheBookkeepingResponse.statusCode, 200);
  assert.equal(postCacheBookkeepingResponse.payload.status, 'warming');
  assert.equal(cacheWrites, 2);

  const failedCacheResponse = responseRecorder();
  const failedCacheCommits = [];
  await runListingAudit(request, failedCacheResponse, {
    cache: {
      async get() { return null; },
      async set() { throw new Error('Runtime Cache offline'); },
    },
    collectObservations: async () => observations,
    now: () => '2026-08-15T00:45:00Z',
    durableWrite: async () => ({ pgMode:'shadow', archiveMode:'off', status:'stored' }),
    recordRuntimeCacheCommit: async commit => { failedCacheCommits.push(commit); return { mode:'shadow', status:commit.status }; },
  });
  assert.equal(failedCacheResponse.statusCode, 503);
  assert.deepEqual(failedCacheCommits.map(row => row.status), ['failed']);
});

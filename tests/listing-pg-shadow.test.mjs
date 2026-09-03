import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LISTING_SOURCE_KEYS,
  mergeListingAudit,
} from '../api/_lib/listing-audit.js';
import {
  LISTING_NORMALIZED_ARTIFACT_FORMAT,
  LISTING_PG_IDENTITY_DOWNGRADE_ERROR_CODE,
  LISTING_PG_PUBLICATION_LEASE_LOST_ERROR_CODE,
  LISTING_PG_PUBLICATION_LEASE_KEY,
  LISTING_PG_PUBLICATION_LEASE_SECONDS,
  LISTING_PG_STALE_RETRY_ERROR_CODE,
  LISTING_PG_VERIFIED_IDENTITY_CONFLICT_ERROR_CODE,
  acquireListingAuditPublicationLease,
  archiveListingAuditArtifacts,
  buildListingAuditPgBatch,
  buildListingAuditPgQueries,
  classifyListingAuditSourceRunWritePolicy,
  findListingAuditVerifiedIdentityConflicts,
  listingAuditPersistenceChecksum,
  putContentAddressedCatalogBlob,
  recordListingAuditRuntimeCacheCommit,
  releaseListingAuditPublicationLease,
  renewListingAuditPublicationLease,
  resolvePgWriteMode,
  resolveRawArchiveMode,
  runOptionalListingAuditPgWrite,
  utcListingAuditBucket,
  writeListingAuditPgBatch,
} from '../api/_lib/listing-pg-shadow.js';
import {
  compactListingAuditBundle,
  config as listingChangesConfig,
  runListingAudit,
} from '../api/listing-changes.js';

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
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

function targetObservation(sourceKey, rows, overrides = {}) {
  const [market, venue] = sourceKey.split(':');
  return {
    market,
    venue,
    status: 'full',
    listings: rows,
    reason: null,
    ...overrides,
  };
}

function sourceRun(batch, sourceKey = 'perp:gate') {
  return batch.sourceRuns.find(row => row.listingSourceKey === sourceKey);
}

function pgCalls(batch, artifacts = []) {
  const calls = [];
  buildListingAuditPgQueries({
    query(text, params = []) {
      const query = { text, params };
      calls.push(query);
      return query;
    },
  }, batch, artifacts);
  return calls;
}

function sameDayRetry({
  sourceKey = 'perp:gate',
  initialRows = [listing(sourceKey, 'AAPL')],
  retryRows = initialRows,
  retryStatus = 'full',
  retryReason = null,
} = {}) {
  const priorObservations = fullObservations({
    [sourceKey]: targetObservation(sourceKey, initialRows),
  });
  const prior = mergeAt(null, priorObservations, '2026-08-14T00:45:00.000Z');
  const first = mergeAt(prior.state, priorObservations, '2026-08-15T00:45:00.000Z');
  const retryObservations = fullObservations({
    [sourceKey]: targetObservation(sourceKey, retryRows, {
      status: retryStatus,
      reason: retryReason,
    }),
  });
  const retry = mergeAt(first.state, retryObservations, '2026-08-15T01:45:00.000Z');
  return {
    sourceKey,
    first,
    firstBatch: buildListingAuditPgBatch({ observations:priorObservations, merged:first }),
    retry,
    retryBatch: buildListingAuditPgBatch({ observations:retryObservations, merged:retry }),
    retryObservations,
  };
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
  assert.equal(kraken.metadata.baselineAt, '2026-08-15T00:45:00.000Z');
  assert.equal(kraken.metadata.lifecycleComparable, false);
  assert.match(kraken.artifact.pathname, /^catalog\/preview\/rwa-listing-audit\/2026-08-15\/spot:kraken\/[0-9a-f]{64}\.json$/);

  const artifact = JSON.parse(kraken.artifact.body);
  assert.equal(artifact.schemaVersion, LISTING_NORMALIZED_ARTIFACT_FORMAT);
  assert.equal(artifact.artifactKind, 'normalized');
  assert.equal(artifact.environment, 'preview');
  assert.equal(artifact.source.sourceKey, 'spot:kraken');
  assert.equal(artifact.listings[0].officialProductKey, 'AAPLxUSD');
  assert.equal(createHash('sha256').update(kraken.artifact.body).digest('hex'), kraken.artifact.sha256);
});

test('same-day retry after a Runtime Cache baseline reset remains non-comparable for lifecycle events', () => {
  const first = baselineInput();
  const retryAt = '2026-08-15T01:45:00.000Z';
  const retry = mergeAt(first.merged.state, first.observations, retryAt);
  const batch = buildListingAuditPgBatch({
    observations:first.observations,
    merged:retry,
    observedAt:retryAt,
  });

  assert.equal(retry.snapshot.status, 'full');
  assert.equal(retry.newEvents.length, 0);
  for (const run of batch.sourceRuns) {
    assert.equal(run.mergedStatus, 'full');
    assert.equal(run.metadata.baseline, false);
    assert.equal(run.metadata.baselineAt, '2026-08-15T00:45:00.000Z');
    assert.equal(run.metadata.lifecycleComparable, false);
  }

  const nextDayAt = '2026-08-16T00:45:00.000Z';
  const nextDay = mergeAt(retry.state, first.observations, nextDayAt);
  const nextDayBatch = buildListingAuditPgBatch({
    observations:first.observations,
    merged:nextDay,
    observedAt:nextDayAt,
  });
  assert.ok(nextDayBatch.sourceRuns.every(run => run.metadata.lifecycleComparable === true));
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

test('same-day write policy accepts only exact trusted Full, pending, review, and pending-review snapshots', () => {
  const pending = sameDayRetry({
    initialRows: [listing('perp:gate', 'AAPL'), listing('perp:gate', 'MSFT')],
    retryRows: [listing('perp:gate', 'AAPL')],
  });
  const pendingRun = sourceRun(pending.retryBatch);
  assert.deepEqual(pendingRun.writePolicy, {
    trustedLatest: true,
    disposition: 'latest-trusted',
    pendingRemoval: true,
    reviewIsolation: false,
    reasonCodes: [],
  });
  assert.equal(pendingRun.pendingRemovalCount, 1);
  assert.deepEqual(pendingRun.pendingRemovalVenueSymbols, ['MSFT-GATE-PERP']);
  assert.deepEqual(pendingRun.memberships.map(row => row.canonicalUnderlying), ['AAPL']);

  const reviewCandidate = listing('perp:gate', 'FUTURE', {
    identityStatus: 'review-required',
    identityEvidence: 'exact official product pending identity review',
  });
  const review = sameDayRetry({
    retryRows: [listing('perp:gate', 'AAPL'), reviewCandidate],
  });
  const reviewRun = sourceRun(review.retryBatch);
  assert.deepEqual(reviewRun.writePolicy, {
    trustedLatest: true,
    disposition: 'latest-trusted',
    pendingRemoval: false,
    reviewIsolation: true,
    reasonCodes: [],
  });
  assert.equal(reviewRun.memberships.length, 1);
  assert.deepEqual(reviewRun.reviewCases.map(row => row.officialProductKey), ['FUTURE-GATE-PERP']);

  const pendingReview = sameDayRetry({
    initialRows: [listing('perp:gate', 'AAPL'), listing('perp:gate', 'MSFT')],
    retryRows: [listing('perp:gate', 'AAPL'), reviewCandidate],
  });
  const pendingReviewRun = sourceRun(pendingReview.retryBatch);
  assert.equal(pendingReviewRun.writePolicy.trustedLatest, true);
  assert.equal(pendingReviewRun.writePolicy.pendingRemoval, true);
  assert.equal(pendingReviewRun.writePolicy.reviewIsolation, true);
  assert.deepEqual(pendingReviewRun.errorCodes, [
    'CATALOG_PARTIAL',
    'SOURCE_IDENTITY_PARTIAL',
    'IDENTITY_REVIEW_REQUIRED',
  ]);
  assert.deepEqual(pendingReviewRun.pendingRemovalVenueSymbols, ['MSFT-GATE-PERP']);

  const pristine = sourceRun(sameDayRetry().retryBatch);
  assert.deepEqual(classifyListingAuditSourceRunWritePolicy(pristine), pristine.writePolicy);
  const extraError = classifyListingAuditSourceRunWritePolicy({
    ...pristine,
    errorCodes: ['UPSTREAM_UNAVAILABLE'],
  });
  assert.equal(extraError.trustedLatest, false);
  assert.equal(extraError.disposition, 'preserve-last-good');
  assert.ok(extraError.reasonCodes.includes('UNEXPECTED_SOURCE_ERRORS'));
});

test('same-day Unavailable and identity-normalization rejects preserve last-good and never enter replacement payloads', () => {
  const unavailable = sameDayRetry({
    initialRows: [listing('perp:gate', 'AAPL'), listing('perp:gate', 'MSFT')],
    retryRows: [],
    retryStatus: 'unavailable',
    retryReason: 'official catalog timeout',
  });
  const invalidCrypto = sameDayRetry({
    retryRows: [listing('perp:gate', 'BTC', { category:'crypto' })],
  });

  for (const [label, sequence, expectedError] of [
    ['Unavailable', unavailable, 'UPSTREAM_UNAVAILABLE'],
    ['identity reject', invalidCrypto, 'IDENTITY_NORMALIZATION_REJECTED'],
  ]) {
    const run = sourceRun(sequence.retryBatch);
    assert.equal(run.writePolicy.trustedLatest, false, label);
    assert.equal(run.writeDisposition, 'preserve-last-good', label);
    assert.equal(run.memberships.length, 0, label);
    assert.equal(run.reviewCases.length, 0, label);
    assert.ok(run.errorCodes.includes(expectedError), label);

    const calls = pgCalls(sequence.retryBatch);
    const sourceUpsert = calls.find(call => call.text.includes('INSERT INTO ingest.source_run'));
    const sourcePayload = JSON.parse(sourceUpsert.params.at(-1));
    const target = sourcePayload.find(row => row.source_key === sequence.sourceKey);
    assert.equal(target.metadata.writeDisposition, 'preserve-last-good', label);
    assert.match(sourceUpsert.text, /ELSE ingest\.source_run\.completed_at/, label);
    assert.match(sourceUpsert.text, /ELSE ingest\.source_run\.metadata/, label);

    const evidenceDelete = calls.find(call => call.text.includes('DELETE FROM identity.evidence'));
    const membershipDelete = calls.find(call => call.text.includes('DELETE FROM ingest.catalog_membership'));
    for (const deletion of [evidenceDelete, membershipDelete]) {
      const replacementSources = JSON.parse(deletion.params.at(-1));
      assert.equal(replacementSources.some(row => row.source_key === sequence.sourceKey), false, label);
    }
    const membershipInsert = calls.find(call => call.text.includes('INSERT INTO ingest.catalog_membership'));
    const incomingMemberships = JSON.parse(membershipInsert.params.at(-1));
    assert.equal(incomingMemberships.some(row => row.source_key === sequence.sourceKey), false, label);
  }
});

test('stale trusted and stale untrusted arrivals are rejected before Runtime Cache publication', async () => {
  const sequences = [
    ['trusted', sameDayRetry()],
    ['untrusted', sameDayRetry({
      retryRows: [],
      retryStatus: 'unavailable',
      retryReason: 'late official catalog timeout',
    })],
  ];

  for (const [label, sequence] of sequences) {
    const target = sourceRun(sequence.retryBatch);
    assert.equal(target.writePolicy.trustedLatest, label === 'trusted', label);
    const result = await runOptionalListingAuditPgWrite({
      observations: sequence.retryObservations,
      merged: sequence.retry,
      observedAt: sequence.retry.snapshot.generatedAt,
    }, {
      env: { PG_WRITE_MODE:'shadow', RAW_ARCHIVE_MODE:'off' },
      logger: { warn() {}, error() {} },
      writeBatch: async () => { throw new Error(`database: ${LISTING_PG_STALE_RETRY_ERROR_CODE}`); },
    });
    assert.equal(result.status, 'stale', label);
    assert.equal(result.staleRetry, true, label);
    assert.equal(result.consistencyRejected, true, label);
    assert.equal(result.publishAllowed, false, label);

    let cacheWrites = 0;
    const response = responseRecorder();
    await runListingAudit({ headers:{ host:'example.invalid' } }, response, {
      cache: {
        async get() { return null; },
        async set() { cacheWrites += 1; },
      },
      collectObservations: async () => sequence.retryObservations,
      now: () => sequence.retry.snapshot.generatedAt,
      durableWrite: async () => result,
    });
    assert.equal(response.statusCode, 409, label);
    assert.equal(response.payload.error, 'Stale listing audit retry rejected', label);
    assert.equal(cacheWrites, 0, label);
  }
});

test('same-timestamp catalog retries are idempotent only when the archived catalog checksum is identical', () => {
  const sequence = sameDayRetry();
  const batch = sequence.retryBatch;
  const retryGuard = pgCalls(batch).find(call => call.text.includes('retry_order_guard'));
  assert.ok(retryGuard);
  assert.equal(retryGuard.params[4], batch.observedAt);
  assert.equal(retryGuard.params[5], batch.checksum);
  assert.match(retryGuard.text, />\s*\$5::timestamptz/);
  assert.match(
    retryGuard.text,
    /=\s*\$5::timestamptz\s+AND\s+archive_sink\.checksum IS NOT NULL\s+AND\s+archive_sink\.checksum <> \$6/,
  );
  assert.doesNotMatch(retryGuard.text, />=\s*\$5::timestamptz/);
});

test('an accepted exact identity downgrade preserves PG last-good and publishes an Unavailable diagnostic overlay', async () => {
  const downgrade = sameDayRetry({
    retryRows: [listing('perp:gate', 'AAPL', {
      identityStatus:'review-required',
      identityEvidence:'ambiguous retry must not replace accepted identity',
    })],
  });
  const run = sourceRun(downgrade.retryBatch);
  assert.equal(run.writePolicy.trustedLatest, false);
  assert.equal(run.writeDisposition, 'preserve-last-good');
  assert.equal(run.status, 'unavailable');
  assert.match(run.reason, /identity drift/i);

  const calls = pgCalls(downgrade.retryBatch);
  const downgradeGuard = calls.find(call => call.text.includes('identity_downgrade_guard'));
  assert.ok(downgradeGuard);
  assert.match(downgradeGuard.text, /current\.valid_to IS NULL/);
  assert.match(downgradeGuard.text, /current\.identity_status = 'verified'/);
  assert.match(downgradeGuard.text, /ingest\.reject_catalog_identity_downgrade\(\)/);
  assert.equal(
    JSON.parse(downgradeGuard.params[0]).some(row =>
      row.source_key === downgrade.sourceKey && row.official_product_key === 'AAPL-GATE-PERP'),
    false,
    'a normal merge-detected downgrade never enters trusted review rows',
  );

  let cacheWrites = 0;
  let storedBundle = null;
  const response = responseRecorder();
  await runListingAudit({ headers:{ host:'example.invalid' } }, response, {
    cache: {
      async get() {
        return storedBundle || compactListingAuditBundle(downgrade.first.state, downgrade.first.snapshot);
      },
      async set(_key, value) { cacheWrites += 1; storedBundle = value; },
    },
    collectObservations: async () => downgrade.retryObservations,
    now: () => downgrade.retry.snapshot.generatedAt,
    durableWrite: async input => {
      const batch = buildListingAuditPgBatch(input);
      assert.equal(sourceRun(batch).writeDisposition, 'preserve-last-good');
      return { pgMode:'shadow', archiveMode:'off', status:'stored', publishAllowed:true };
    },
    recordRuntimeCacheCommit: async () => ({ mode:'shadow', status:'stored' }),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.sources.find(row => row.sourceKey === downgrade.sourceKey).status, 'unavailable');
  assert.equal(cacheWrites, 1);
  assert.ok(storedBundle);

  const invariantConflict = sameDayRetry({
    retryRows: [
      listing('perp:gate', 'AAPL'),
      listing('perp:gate', 'FUTURE', {
        identityStatus:'review-required',
        identityEvidence:'new isolated candidate',
      }),
    ],
  });
  assert.equal(sourceRun(invariantConflict.retryBatch).writePolicy.trustedLatest, true);
  const invariantGuard = pgCalls(invariantConflict.retryBatch)
    .find(call => call.text.includes('identity_downgrade_guard'));
  assert.equal(JSON.parse(invariantGuard.params[0]).some(row =>
    row.official_product_key === 'FUTURE-GATE-PERP'), true);

  const result = await runOptionalListingAuditPgWrite({
    observations: invariantConflict.retryObservations,
    merged: invariantConflict.retry,
    observedAt: invariantConflict.retry.snapshot.generatedAt,
  }, {
    env: { PG_WRITE_MODE:'shadow', RAW_ARCHIVE_MODE:'off' },
    logger: { warn() {}, error() {} },
    writeBatch: async () => { throw new Error(LISTING_PG_IDENTITY_DOWNGRADE_ERROR_CODE); },
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.staleRetry, false);
  assert.equal(result.consistencyRejected, true);
  assert.equal(result.publishAllowed, false);
});

test('verified identity guard rejects category/canonical drift but permits non-identity metadata SCD2 changes', async () => {
  const sequence = sameDayRetry();
  const metadataOnlyBatch = structuredClone(sequence.retryBatch);
  const metadataMembership = sourceRun(metadataOnlyBatch).memberships[0];
  metadataMembership.displayName = 'Apple Incorporated';
  metadataMembership.name = 'Apple Inc. renamed display metadata';
  metadataMembership.quoteCurrency = 'USD';
  metadataMembership.officialStatus = 'suspended';
  metadataMembership.assetFingerprint = 'a'.repeat(64);
  metadataMembership.instrumentFingerprint = 'b'.repeat(64);

  const metadataCalls = pgCalls(metadataOnlyBatch);
  const metadataGuard = metadataCalls.find(call => call.text.includes('verified_identity_guard'));
  assert.ok(metadataGuard);
  assert.match(metadataGuard.text, /current_asset\.asset_key <> incoming\.asset_key/);
  assert.match(metadataGuard.text, /current_asset_version\.category <> incoming\.category/);
  assert.match(metadataGuard.text, /current_asset_version\.canonical_underlying <> incoming\.canonical_underlying/);
  assert.match(metadataGuard.text, /incoming\.lifecycle_status = 'public'/);
  assert.match(metadataGuard.text, /incoming\.canonical_underlying = ANY\(\$2::text\[\]\)/);
  assert.match(metadataGuard.text, /current_asset_version\.category = 'pre-ipo'/);
  assert.ok(metadataGuard.params[1].includes('UNITREE'));
  assert.doesNotMatch(metadataGuard.text, /incoming\.(?:display_name|name|quote_currency|official_status|asset_fingerprint|instrument_fingerprint)/);
  const metadataPayload = JSON.parse(metadataGuard.params[0]);
  const metadataGuardRow = metadataPayload.find(row => row.official_product_key === 'AAPL-GATE-PERP');
  assert.deepEqual(
    Object.fromEntries([
      'source_key',
      'official_product_key',
      'asset_key',
      'category',
      'canonical_underlying',
      'venue_category',
      'lifecycle_status',
    ].map(key => [key, metadataGuardRow[key]])),
    {
      source_key:'perp:gate',
      official_product_key:'AAPL-GATE-PERP',
      asset_key:'equity:AAPL',
      category:'equity',
      canonical_underlying:'AAPL',
      venue_category:'equity',
      lifecycle_status:null,
    },
  );
  assert.ok(metadataCalls.some(call =>
    call.text.includes('UPDATE identity.asset_version AS current') &&
    call.text.includes('current.identity_fingerprint <> incoming.asset_fingerprint')));
  assert.ok(metadataCalls.some(call =>
    call.text.includes('UPDATE identity.instrument_version AS current') &&
    call.text.includes('current.identity_fingerprint <> incoming.instrument_fingerprint')));

  const reviewedLifecycleBatch = structuredClone(sequence.retryBatch);
  const reviewedLifecycleMembership = sourceRun(reviewedLifecycleBatch).memberships[0];
  reviewedLifecycleMembership.assetKey = 'equity:UNITREE';
  reviewedLifecycleMembership.category = 'equity';
  reviewedLifecycleMembership.canonicalUnderlying = 'UNITREE';
  reviewedLifecycleMembership.venueCategory = 'equity';
  reviewedLifecycleMembership.lifecycleStatus = 'public';
  const reviewedLifecycleGuard = pgCalls(reviewedLifecycleBatch)
    .find(call => call.text.includes('verified_identity_guard'));
  const reviewedLifecycleRow = JSON.parse(reviewedLifecycleGuard.params[0])
    .find(row => row.official_product_key === 'AAPL-GATE-PERP');
  assert.deepEqual({
    assetKey:reviewedLifecycleRow.asset_key,
    category:reviewedLifecycleRow.category,
    canonicalUnderlying:reviewedLifecycleRow.canonical_underlying,
    venueCategory:reviewedLifecycleRow.venue_category,
    lifecycleStatus:reviewedLifecycleRow.lifecycle_status,
  }, {
    assetKey:'equity:UNITREE',
    category:'equity',
    canonicalUnderlying:'UNITREE',
    venueCategory:'equity',
    lifecycleStatus:'public',
  });

  const conflictingBatch = structuredClone(sequence.retryBatch);
  const conflictingMembership = sourceRun(conflictingBatch).memberships[0];
  conflictingMembership.assetKey = 'etf:MSFT';
  conflictingMembership.category = 'etf';
  conflictingMembership.canonicalUnderlying = 'MSFT';
  const conflictingGuard = pgCalls(conflictingBatch).find(call => call.text.includes('verified_identity_guard'));
  assert.match(conflictingGuard.text, /ingest\.reject_verified_catalog_identity_conflict\(\)/);
  const conflictingGuardRow = JSON.parse(conflictingGuard.params[0])
    .find(row => row.official_product_key === 'AAPL-GATE-PERP');
  assert.deepEqual(
    Object.fromEntries([
      'source_key',
      'official_product_key',
      'asset_key',
      'category',
      'canonical_underlying',
    ].map(key => [key, conflictingGuardRow[key]])),
    {
      source_key:'perp:gate',
      official_product_key:'AAPL-GATE-PERP',
      asset_key:'etf:MSFT',
      category:'etf',
      canonical_underlying:'MSFT',
    },
  );

  const rejected = await runOptionalListingAuditPgWrite({
    observations:sequence.retryObservations,
    merged:sequence.retry,
    observedAt:sequence.retry.snapshot.generatedAt,
  }, {
    env: { PG_WRITE_MODE:'shadow', RAW_ARCHIVE_MODE:'off' },
    logger: { warn() {}, error() {} },
    writeBatch: async () => { throw new Error(LISTING_PG_VERIFIED_IDENTITY_CONFLICT_ERROR_CODE); },
    findIdentityConflicts: async () => [{
      sourceKey:'perp:gate',
      officialProductKey:'AAPL-GATE-PERP',
      existing:{ assetKey:'equity:AAPL', category:'equity', canonicalUnderlying:'AAPL' },
      incoming:{ assetKey:'etf:MSFT', category:'etf', canonicalUnderlying:'MSFT' },
    }],
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.consistencyRejected, true);
  assert.equal(rejected.publishAllowed, false);
  assert.equal(rejected.error, LISTING_PG_VERIFIED_IDENTITY_CONFLICT_ERROR_CODE);
  assert.deepEqual(rejected.identityConflicts, [{
    sourceKey:'perp:gate',
    officialProductKey:'AAPL-GATE-PERP',
    existing:{ assetKey:'equity:AAPL', category:'equity', canonicalUnderlying:'AAPL' },
    incoming:{ assetKey:'etf:MSFT', category:'etf', canonicalUnderlying:'MSFT' },
  }]);
});

test('verified identity conflict diagnostics are read-only, bounded, and expose only catalog identity fields', async () => {
  const sequence = sameDayRetry();
  const results = await findListingAuditVerifiedIdentityConflicts(sequence.retryBatch, {
    runTransaction: async (builder, options) => {
      assert.deepEqual(options, { isolationLevel:'Serializable', readOnly:true });
      const calls = [];
      const queries = builder({ query(text, params = []) { calls.push({ text, params }); return { text, params }; } });
      assert.match(calls[0].text, /^SET LOCAL ROLE rwa_catalog_shadow_writer$/);
      assert.match(calls[2].text, /LIMIT 20/);
      assert.match(calls[2].text, /current_asset\.asset_key <> incoming\.asset_key/);
      assert.match(calls[2].text, /incoming\.lifecycle_status = 'public'/);
      assert.match(calls[2].text, /incoming\.canonical_underlying = ANY\(\$2::text\[\]\)/);
      assert.match(calls[2].text, /current_asset_version\.category = 'pre-ipo'/);
      const incoming = JSON.parse(calls[2].params[0]);
      assert.ok(incoming.length > 0);
      assert.ok(calls[2].params[1].includes('UNITREE'));
      return queries.map((_query, index) => index === 2 ? [{
        source_key:'perp:gate',
        official_product_key:'AAPL-GATE-PERP',
        existing_asset_key:'equity:AAPL',
        existing_category:'equity',
        existing_canonical_underlying:'AAPL',
        incoming_asset_key:'etf:AAPL',
        incoming_category:'etf',
        incoming_canonical_underlying:'AAPL',
      }] : []);
    },
  });
  assert.deepEqual(results, [{
    sourceKey:'perp:gate',
    officialProductKey:'AAPL-GATE-PERP',
    existing:{ assetKey:'equity:AAPL', category:'equity', canonicalUnderlying:'AAPL' },
    incoming:{ assetKey:'etf:AAPL', category:'etf', canonicalUnderlying:'AAPL' },
  }]);
});

test('trusted same-day retries replace exact evidence and membership before reinsertion', () => {
  const variants = [
    sameDayRetry({
      initialRows: [listing('perp:gate', 'AAPL'), listing('perp:gate', 'MSFT')],
      retryRows: [listing('perp:gate', 'AAPL')],
    }),
    sameDayRetry({
      retryRows: [
        listing('perp:gate', 'AAPL'),
        listing('perp:gate', 'FUTURE', { identityStatus:'review-required' }),
      ],
    }),
    sameDayRetry({
      initialRows: [listing('perp:gate', 'AAPL'), listing('perp:gate', 'MSFT')],
      retryRows: [
        listing('perp:gate', 'AAPL'),
        listing('perp:gate', 'FUTURE', { identityStatus:'review-required' }),
      ],
    }),
  ];

  for (const sequence of variants) {
    const calls = pgCalls(sequence.retryBatch);
    const evidenceDeleteIndex = calls.findIndex(call => call.text.includes('DELETE FROM identity.evidence'));
    const membershipDeleteIndex = calls.findIndex(call => call.text.includes('DELETE FROM ingest.catalog_membership'));
    const membershipInsertIndex = calls.findIndex(call => call.text.includes('INSERT INTO ingest.catalog_membership'));
    const evidenceInsertIndex = calls.findIndex(call => call.text.includes('INSERT INTO identity.evidence'));
    assert.ok(evidenceDeleteIndex > 0 && evidenceDeleteIndex < membershipDeleteIndex);
    assert.ok(membershipDeleteIndex < membershipInsertIndex);
    assert.ok(membershipInsertIndex < evidenceInsertIndex);

    const replacementSources = JSON.parse(calls[membershipDeleteIndex].params.at(-1));
    assert.equal(replacementSources.some(row => row.source_key === sequence.sourceKey), true);
    const incomingMemberships = JSON.parse(calls[membershipInsertIndex].params.at(-1));
    assert.deepEqual(
      incomingMemberships.filter(row => row.source_key === sequence.sourceKey)
        .map(row => row.official_product_key),
      ['AAPL-GATE-PERP'],
    );
  }

  const sinkSql = pgCalls(variants[0].retryBatch)
    .find(call => call.text.includes("'postgres-catalog-shadow', 'stored'"));
  assert.match(sinkSql.text, /SELECT count\(\*\)::int\s+FROM ingest\.catalog_membership/);
  assert.match(sinkSql.text, /SELECT count\(\*\)::int\s+FROM analytics\.catalog_change_event/);
  assert.match(sinkSql.text, /run\.metadata->>'artifactSha256'/);
  assert.match(sinkSql.text, /RETURNING sink_name, row_count, checksum/);
});

test('a later trusted exact listing resolves its open review while preserving verified siblings', () => {
  const sourceKey = 'perp:gate';
  const priorObservations = fullObservations({
    [sourceKey]: targetObservation(sourceKey, [listing(sourceKey, 'AAPL')]),
  });
  const prior = mergeAt(null, priorObservations, '2026-08-14T00:45:00.000Z');
  const reviewObservations = fullObservations({
    [sourceKey]: targetObservation(sourceKey, [
      listing(sourceKey, 'AAPL'),
      listing(sourceKey, 'FUTURE', {
        identityStatus:'review-required',
        identityEvidence:'exact official product pending identity review',
      }),
    ]),
  });
  const review = mergeAt(prior.state, reviewObservations, '2026-08-15T00:45:00.000Z');
  const reviewBatch = buildListingAuditPgBatch({ observations:reviewObservations, merged:review });
  assert.equal(sourceRun(reviewBatch).writePolicy.reviewIsolation, true);
  assert.deepEqual(sourceRun(reviewBatch).memberships.map(row => row.canonicalUnderlying), ['AAPL']);

  const verifiedObservations = fullObservations({
    [sourceKey]: targetObservation(sourceKey, [
      listing(sourceKey, 'AAPL'),
      listing(sourceKey, 'FUTURE', {
        identityStatus:'verified',
        identityEvidence:'later exact official identity confirmation',
      }),
    ]),
  });
  const verified = mergeAt(review.state, verifiedObservations, '2026-08-15T01:45:00.000Z');
  const verifiedBatch = buildListingAuditPgBatch({ observations:verifiedObservations, merged:verified });
  const verifiedRun = sourceRun(verifiedBatch);
  assert.equal(verifiedRun.writePolicy.trustedLatest, true);
  assert.equal(verifiedRun.writePolicy.reviewIsolation, false);
  assert.deepEqual(
    verifiedRun.memberships.map(row => row.canonicalUnderlying),
    ['AAPL', 'FUTURE'],
  );
  assert.equal(verifiedRun.reviewCases.length, 0);

  const reviewCalls = pgCalls(reviewBatch);
  assert.equal(reviewCalls.some(call =>
    call.text.includes('UPDATE identity.instrument_version AS current') &&
    call.params.some(param => typeof param === 'string' &&
      param.includes('FUTURE-GATE-PERP'))), false,
  'a review-only candidate must not close or mutate an accepted verified version');

  const verifiedCalls = pgCalls(verifiedBatch);
  const membershipInsertIndex = verifiedCalls.findIndex(call => call.text.includes('INSERT INTO ingest.catalog_membership'));
  const resolveReviewIndex = verifiedCalls.findIndex(call =>
    call.text.includes('UPDATE identity.review_case AS review') && call.text.includes("status = 'verified'"));
  assert.ok(resolveReviewIndex > membershipInsertIndex);
  const resolveInput = JSON.parse(verifiedCalls[resolveReviewIndex].params[0]);
  assert.equal(resolveInput.some(row => row.official_product_key === 'FUTURE-GATE-PERP'), true);
  assert.match(verifiedCalls[resolveReviewIndex].text, /resolved_asset_id = asset_version\.asset_id/);
  assert.match(verifiedCalls[resolveReviewIndex].text, /resolved_instrument_id = instrument\.instrument_id/);

  const supersedeReview = verifiedCalls.find(call =>
    call.text.includes('UPDATE identity.review_case AS review') && call.text.includes("status = 'superseded'"));
  assert.match(supersedeReview.text, /pending_venue_symbols text\[\]/);
  assert.match(supersedeReview.text, /ANY\(COALESCE\(replacement\.pending_venue_symbols/);
});

test('review candidate pending then confirmed or recovered never becomes an accepted lifecycle event', () => {
  const sourceKey = 'perp:gate';
  const accepted = listing(sourceKey, 'AAPL');
  const reviewCandidate = listing(sourceKey, 'FUTURE', {
    identityStatus:'review-required',
    identityEvidence:'exact official product pending identity review',
  });
  const baselineObservations = fullObservations({
    [sourceKey]: targetObservation(sourceKey, [accepted]),
  });
  const baseline = mergeAt(null, baselineObservations, '2026-08-14T00:45:00.000Z');
  const reviewObservations = fullObservations({
    [sourceKey]: targetObservation(sourceKey, [accepted, reviewCandidate]),
  });
  const review = mergeAt(baseline.state, reviewObservations, '2026-08-15T00:45:00.000Z');
  const reviewBatch = buildListingAuditPgBatch({ observations:reviewObservations, merged:review });
  assert.equal(sourceRun(reviewBatch, sourceKey).writePolicy.reviewIsolation, true);
  assert.equal(reviewBatch.events.length, 0);

  const missingReviewObservations = fullObservations({
    [sourceKey]: targetObservation(sourceKey, [accepted]),
  });
  const pending = mergeAt(review.state, missingReviewObservations, '2026-08-15T01:45:00.000Z');
  const pendingBatch = buildListingAuditPgBatch({ observations:missingReviewObservations, merged:pending });
  const pendingRun = sourceRun(pendingBatch, sourceKey);
  assert.equal(pendingRun.writePolicy.pendingRemoval, true);
  assert.equal(pendingRun.writePolicy.reviewIsolation, false);
  assert.deepEqual(pendingRun.pendingRemovalVenueSymbols, ['FUTURE-GATE-PERP']);
  assert.deepEqual(pendingRun.memberships.map(row => row.canonicalUnderlying), ['AAPL']);
  assert.equal(pendingRun.reviewCases.length, 0);
  assert.equal(pendingBatch.events.length, 0);

  const confirmed = mergeAt(pending.state, missingReviewObservations, '2026-08-16T00:45:00.000Z');
  assert.deepEqual(
    confirmed.newEvents.map(row => [row.changeType, row.identityStatus]),
    [['delisted', 'review-required']],
  );
  const confirmedBatch = buildListingAuditPgBatch({ observations:missingReviewObservations, merged:confirmed });
  assert.equal(sourceRun(confirmedBatch, sourceKey).writePolicy.trustedLatest, true);
  assert.equal(sourceRun(confirmedBatch, sourceKey).writePolicy.pendingRemoval, false);
  assert.equal(confirmedBatch.events.length, 0, 'review-only disappearance cannot create an accepted delisted event');

  const recovered = mergeAt(pending.state, reviewObservations, '2026-08-16T00:45:00.000Z');
  const recoveredBatch = buildListingAuditPgBatch({ observations:reviewObservations, merged:recovered });
  assert.equal(recovered.newEvents.length, 0);
  assert.equal(sourceRun(recoveredBatch, sourceKey).writePolicy.reviewIsolation, true);
  assert.deepEqual(sourceRun(recoveredBatch, sourceKey).reviewCases.map(row => row.officialProductKey), ['FUTURE-GATE-PERP']);
  assert.equal(recoveredBatch.events.length, 0);
});

test('review resolution followed by same-day pending preserves the resolved identity without a listed event', () => {
  const sourceKey = 'perp:gate';
  const accepted = listing(sourceKey, 'AAPL');
  const reviewCandidate = listing(sourceKey, 'FUTURE', {
    identityStatus:'review-required',
    identityEvidence:'exact official product pending identity review',
  });
  const baselineObservations = fullObservations({
    [sourceKey]: targetObservation(sourceKey, [accepted]),
  });
  const baseline = mergeAt(null, baselineObservations, '2026-08-14T00:45:00.000Z');
  const reviewObservations = fullObservations({
    [sourceKey]: targetObservation(sourceKey, [accepted, reviewCandidate]),
  });
  const review = mergeAt(baseline.state, reviewObservations, '2026-08-15T00:45:00.000Z');
  const verifiedObservations = fullObservations({
    [sourceKey]: targetObservation(sourceKey, [accepted, listing(sourceKey, 'FUTURE', {
      identityEvidence:'later exact official identity confirmation',
    })]),
  });
  const verified = mergeAt(review.state, verifiedObservations, '2026-08-15T01:15:00.000Z');
  const verifiedBatch = buildListingAuditPgBatch({ observations:verifiedObservations, merged:verified });
  assert.deepEqual(sourceRun(verifiedBatch, sourceKey).memberships.map(row => row.canonicalUnderlying), ['AAPL', 'FUTURE']);
  assert.equal(verifiedBatch.events.length, 0);

  const pendingObservations = fullObservations({
    [sourceKey]: targetObservation(sourceKey, [accepted]),
  });
  const pending = mergeAt(verified.state, pendingObservations, '2026-08-15T01:45:00.000Z');
  const pendingBatch = buildListingAuditPgBatch({ observations:pendingObservations, merged:pending });
  const pendingRun = sourceRun(pendingBatch, sourceKey);
  assert.equal(pendingRun.writePolicy.pendingRemoval, true);
  assert.deepEqual(pendingRun.pendingRemovalVenueSymbols, ['FUTURE-GATE-PERP']);
  assert.deepEqual(pendingRun.memberships.map(row => row.canonicalUnderlying), ['AAPL']);
  assert.equal(pendingBatch.events.length, 0);
});

test('Day 1 baseline listing that becomes pending on a same-day retry emits no lifecycle event', () => {
  const sourceKey = 'perp:gate';
  const baselineObservations = fullObservations({
    [sourceKey]: targetObservation(sourceKey, [
      listing(sourceKey, 'AAPL'),
      listing(sourceKey, 'TEMP'),
    ]),
  });
  const baseline = mergeAt(null, baselineObservations, '2026-08-15T00:45:00.000Z');
  assert.equal(baseline.newEvents.length, 0);
  assert.equal(buildListingAuditPgBatch({ observations:baselineObservations, merged:baseline }).events.length, 0);

  const retryObservations = fullObservations({
    [sourceKey]: targetObservation(sourceKey, [listing(sourceKey, 'AAPL')]),
  });
  const pending = mergeAt(baseline.state, retryObservations, '2026-08-15T01:45:00.000Z');
  const pendingBatch = buildListingAuditPgBatch({ observations:retryObservations, merged:pending });
  const pendingRun = sourceRun(pendingBatch, sourceKey);
  assert.equal(pendingRun.writePolicy.pendingRemoval, true);
  assert.deepEqual(pendingRun.pendingRemovalVenueSymbols, ['TEMP-GATE-PERP']);
  assert.equal(pendingBatch.events.length, 0);
});

test('same-day replacement is deterministic and one Serializable transaction rolls back as a unit', async () => {
  const sequence = sameDayRetry({
    initialRows: [listing('perp:gate', 'AAPL'), listing('perp:gate', 'MSFT')],
    retryRows: [listing('perp:gate', 'AAPL')],
  });
  const batch = sequence.retryBatch;
  assert.deepEqual(pgCalls(batch), pgCalls(batch), 'same batch must build byte-identical idempotent queries');

  let transactionCalls = 0;
  let committedState = 'last-good';
  await assert.rejects(() => writeListingAuditPgBatch(batch, [], {
    runTransaction: async (builder, options) => {
      transactionCalls += 1;
      assert.deepEqual(options, { isolationLevel:'Serializable' });
      const stagedQueries = builder({ query(text, params = []) { return { text, params }; } });
      assert.ok(stagedQueries.some(query => query.text.includes('DELETE FROM ingest.catalog_membership')));
      assert.ok(stagedQueries.some(query => query.text.includes('INSERT INTO ingest.catalog_membership')));
      throw new Error('simulated statement failure before atomic commit');
    },
  }), /simulated statement failure/);
  assert.equal(transactionCalls, 1);
  assert.equal(committedState, 'last-good', 'no partial state is published when the transaction rejects');

  const actualChecksum = 'c'.repeat(64);
  const stored = await writeListingAuditPgBatch(batch, [], {
    runTransaction: async (builder, options) => {
      transactionCalls += 1;
      assert.equal(options.isolationLevel, 'Serializable');
      const queries = builder({ query(text, params = []) { return { text, params }; } });
      committedState = 'latest-trusted';
      return queries.map(query => query.text.includes("'postgres-catalog-shadow', 'stored'")
        ? [{
          sink_name:'postgres-catalog-shadow',
          row_count:10,
          checksum:actualChecksum,
          membership_count:10,
          lifecycle_count:0,
        }]
        : []);
    },
  });
  assert.equal(transactionCalls, 2);
  assert.equal(committedState, 'latest-trusted');
  assert.equal(stored.membershipCount, 10);
  assert.equal(stored.lifecycleCount, 0);
  assert.equal(stored.postgresRowCount, 10);
  assert.equal(stored.checksum, actualChecksum);
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

test('concurrent duplicate lifecycle inserts preserve first observation and only allow official-time enrichment', () => {
  const baseline = baselineInput();
  const changedObservations = fullObservations({
    'perp:gate': targetObservation('perp:gate', [
      listing('perp:gate'),
      listing('perp:gate', 'NEW'),
    ]),
  });
  const changed = mergeAt(baseline.merged.state, changedObservations, '2026-08-16T00:45:00.000Z');
  const firstBatch = buildListingAuditPgBatch({ observations:changedObservations, merged:changed });
  const laterConcurrentBatch = structuredClone(firstBatch);
  laterConcurrentBatch.events[0].observedAt = '2026-08-16T00:45:30.000Z';

  const firstEvent = firstBatch.events[0];
  const laterEvent = laterConcurrentBatch.events[0];
  assert.deepEqual(
    [firstEvent.sourceKey, firstEvent.normalizedVenueSymbol, firstEvent.eventType, firstEvent.effectiveDay],
    [laterEvent.sourceKey, laterEvent.normalizedVenueSymbol, laterEvent.eventType, laterEvent.effectiveDay],
  );
  assert.notEqual(firstEvent.observedAt, laterEvent.observedAt);

  for (const batch of [firstBatch, laterConcurrentBatch]) {
    const calls = pgCalls(batch);
    const eventInsert = calls.find(call => call.text.includes('INSERT INTO analytics.catalog_change_event'));
    assert.match(eventInsert.text, /ON CONFLICT \(source_id, instrument_version_id, event_type, effective_day\)\s+DO UPDATE SET/);
    assert.doesNotMatch(eventInsert.text, /DO UPDATE SET[\s\S]*observed_at\s*=/);
    assert.match(eventInsert.text, /official_listed_at = COALESCE/);
    assert.match(eventInsert.text, /evidence = CASE[\s\S]*'officialListedAt'/);
    const sinkSql = calls.find(call => call.text.includes("'postgres-catalog-shadow', 'stored'"));
    assert.match(sinkSql.text, /actual_counts\.membership_count \+ actual_counts\.lifecycle_count/);
    assert.match(sinkSql.text, /SELECT stored\.sink_name, stored\.row_count, stored\.checksum,[\s\S]*actual_counts\.membership_count, actual_counts\.lifecycle_count/);
  }
});

test('a Runtime Cache baseline reset never synthesizes PostgreSQL lifecycle events', () => {
  const calls = pgCalls(buildListingAuditPgBatch(baselineInput()));
  assert.equal(calls.some(call => call.text.includes('durable-membership-fallback')), false);
  assert.equal(
    calls.filter(call => call.text.includes('INSERT INTO analytics.catalog_change_event')).length,
    1,
    'only producer-declared lifecycle events may enter the shadow database',
  );
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
  for (const call of calls) {
    const referenced = [...new Set([...call.text.matchAll(/\$(\d+)/g)].map(match => Number(match[1])))].sort((a, b) => a - b);
    assert.deepEqual(
      referenced,
      Array.from({ length: call.params.length }, (_unused, index) => index + 1),
      `SQL parameters must be contiguous: ${call.text.slice(0, 80)}`,
    );
  }
  assert.match(calls[0].text, /^SET LOCAL ROLE rwa_catalog_shadow_writer$/);
  assert.match(calls[1].text, /statement_timeout = '15s'/);
  assert.match(calls[2].text, /lock_timeout = '3s'/);
  assert.ok(calls.slice(3).every(call => !/\b(?:TRUNCATE|DROP|ALTER)\b/i.test(call.text)));
  assert.deepEqual(
    calls.filter(call => /^DELETE FROM /m.test(call.text)).map(call =>
      call.text.match(/^DELETE FROM ([a-z_.]+)/m)?.[1]),
    ['identity.evidence', 'ingest.catalog_membership'],
  );

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
  const retryInput = baselineInput(fullObservations(), '2026-08-15T02:30:00.000Z');
  const right = buildListingAuditPgBatch(retryInput);
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

test('publication lease is a 180-second least-privilege owner fence with crash expiry and PG-off no-op semantics', async () => {
  const observedAt = '2026-08-15T00:45:00.000Z';
  const checksum = 'd'.repeat(64);
  const ownerToken = '00000000-0000-4000-8000-000000000001';
  assert.equal(LISTING_PG_PUBLICATION_LEASE_KEY, 'listing-audit-runtime-cache');
  assert.equal(LISTING_PG_PUBLICATION_LEASE_SECONDS, 180);
  assert.ok(LISTING_PG_PUBLICATION_LEASE_SECONDS > listingChangesConfig.maxDuration);

  let transactionCalls = 0;
  const off = await acquireListingAuditPublicationLease({ observedAt, checksum }, {
    env:{ PG_WRITE_MODE:'off' },
    ownerToken,
    runTransaction:async () => { transactionCalls += 1; },
  });
  assert.deepEqual(off, {
    mode:'off',
    acquired:true,
    status:'off',
    leaseKey:LISTING_PG_PUBLICATION_LEASE_KEY,
    ownerToken:null,
    observedAt,
    checksum,
    expiresAt:null,
  });
  assert.equal(transactionCalls, 0);
  assert.equal((await renewListingAuditPublicationLease(off, {
    env:{ PG_WRITE_MODE:'off' },
    runTransaction:async () => { transactionCalls += 1; },
  })).status, 'off');
  assert.deepEqual(await releaseListingAuditPublicationLease(off, {
    env:{ PG_WRITE_MODE:'off' },
    runTransaction:async () => { transactionCalls += 1; },
  }), { mode:'off', released:true, status:'off' });
  assert.equal(transactionCalls, 0);

  const acquireCalls = [];
  let transactionOptions;
  const acquired = await acquireListingAuditPublicationLease({ observedAt, checksum }, {
    env:{ PG_WRITE_MODE:'shadow' },
    ownerToken,
    runTransaction:async (builder, options) => {
      transactionOptions = options;
      const queries = builder({ query(text, params = []) {
        const query = { text, params };
        acquireCalls.push(query);
        return query;
      } });
      return queries.map((_query, index) => index === queries.length - 1 ? [{
        lease_key:LISTING_PG_PUBLICATION_LEASE_KEY,
        owner_token:ownerToken,
        observed_at:observedAt,
        payload_checksum:checksum,
        lease_expires_at:'2026-08-15T00:48:00.000Z',
        acquired:true,
        lease_status:'acquired',
      }] : []);
    },
  });
  assert.deepEqual(transactionOptions, { isolationLevel:'Serializable' });
  assert.match(acquireCalls[0].text, /^SET LOCAL ROLE rwa_catalog_shadow_writer$/);
  assert.match(acquireCalls[1].text, /statement_timeout = '15s'/);
  assert.match(acquireCalls[2].text, /lock_timeout = '3s'/);
  const claimSql = acquireCalls.at(-1);
  assert.deepEqual(claimSql.params, [
    LISTING_PG_PUBLICATION_LEASE_KEY,
    ownerToken,
    observedAt,
    checksum,
    LISTING_PG_PUBLICATION_LEASE_SECONDS,
  ]);
  assert.match(claimSql.text, /lease_expires_at <= clock_timestamp\(\)/);
  assert.match(claimSql.text, /EXCLUDED\.observed_at > ingest\.catalog_publication_lease\.observed_at/);
  assert.match(claimSql.text, /EXCLUDED\.observed_at = ingest\.catalog_publication_lease\.observed_at[\s\S]*EXCLUDED\.payload_checksum = ingest\.catalog_publication_lease\.payload_checksum/);
  assert.match(claimSql.text, /existing\.lease_expires_at > clock_timestamp\(\) THEN 'busy'/);
  assert.match(claimSql.text, /existing\.observed_at > \$3::timestamptz THEN 'stale'/);
  assert.match(claimSql.text, /existing\.payload_checksum <> \$4 THEN 'conflict'/);
  assert.equal(acquired.acquired, true);
  assert.equal(acquired.ownerToken, ownerToken);

  const renewed = await renewListingAuditPublicationLease(acquired, {
    env:{ PG_WRITE_MODE:'shadow' },
    runTransaction:async builder => {
      const queries = builder({ query(text, params = []) { return { text, params }; } });
      const renewal = queries.at(-1);
      assert.match(renewal.text, /owner_token = \$2::uuid/);
      assert.match(renewal.text, /lease_expires_at > clock_timestamp\(\)/);
      return queries.map((_query, index) => index === queries.length - 1 ? [{
        lease_key:LISTING_PG_PUBLICATION_LEASE_KEY,
        lease_expires_at:'2026-08-15T00:49:00.000Z',
        renewed:true,
      }] : []);
    },
  });
  assert.equal(renewed.status, 'renewed');

  await assert.rejects(() => renewListingAuditPublicationLease(acquired, {
    env:{ PG_WRITE_MODE:'shadow' },
    runTransaction:async builder => builder({ query(text, params = []) { return { text, params }; } }).map(() => []),
  }), new RegExp(LISTING_PG_PUBLICATION_LEASE_LOST_ERROR_CODE));

  const ownerMismatch = await releaseListingAuditPublicationLease(acquired, {
    status:'failed',
    env:{ PG_WRITE_MODE:'shadow' },
    runTransaction:async builder => builder({ query(text, params = []) { return { text, params }; } }).map(() => []),
  });
  assert.deepEqual(ownerMismatch, { mode:'shadow', released:false, status:'owner-mismatch' });

  let releaseSql;
  const published = await releaseListingAuditPublicationLease(acquired, {
    status:'published',
    checksum,
    env:{ PG_WRITE_MODE:'shadow' },
    runTransaction:async builder => {
      const queries = builder({ query(text, params = []) { return { text, params }; } });
      releaseSql = queries.at(-1);
      return queries.map((_query, index) => index === queries.length - 1
        ? [{ lease_key:LISTING_PG_PUBLICATION_LEASE_KEY, released:true }]
        : []);
    },
  });
  assert.deepEqual(published, { mode:'shadow', released:true, status:'published' });
  assert.match(releaseSql.text, /SET payload_checksum = CASE WHEN \$5 = 'published' THEN \$6/);
  assert.match(releaseSql.text, /last_published_checksum = CASE WHEN \$5 = 'published' THEN \$6/);
  assert.equal(releaseSql.params[3], checksum, 'owner fence checksum');
  assert.equal(releaseSql.params[5], checksum, 'last published checksum');

  for (const status of ['busy', 'stale', 'conflict']) {
    const rejected = await acquireListingAuditPublicationLease({ observedAt, checksum }, {
      env:{ PG_WRITE_MODE:'shadow' },
      ownerToken,
      runTransaction:async builder => {
        const queries = builder({ query(text, params = []) { return { text, params }; } });
        return queries.map((_query, index) => index === queries.length - 1 ? [{
          lease_key:LISTING_PG_PUBLICATION_LEASE_KEY,
          acquired:false,
          lease_status:status,
          lease_expires_at:'2026-08-15T00:48:00.000Z',
        }] : []);
      },
    });
    assert.equal(rejected.acquired, false, status);
    assert.equal(rejected.status, status, status);
    assert.equal(rejected.ownerToken, null, status);
  }
});

test('Listing Audit holds the publication lease through durable write, cache, sink acknowledgement, and release', async () => {
  const observations = fullObservations();
  const request = { headers:{ host:'avenir-rwa-analyst.vercel.app' } };
  const response = responseRecorder();
  const calls = [];
  let cacheWrites = 0;
  let cachedBundle = null;
  let acquiredChecksum = null;
  let runtimeSinkChecksum = null;
  let releasedChecksum = null;
  const leaseOwner = '00000000-0000-4000-8000-000000000002';
  await runListingAudit(request, response, {
    env:{ PG_WRITE_MODE:'shadow', RAW_ARCHIVE_MODE:'off' },
    cache: {
      async get() { calls.push('cache:get'); return cachedBundle; },
      async set(_key, bundle) {
        calls.push('cache:set');
        cachedBundle = bundle;
        cacheWrites += 1;
      },
    },
    collectObservations:async () => observations,
    now:() => '2026-08-15T00:45:00.000Z',
    acquirePublicationLease:async input => {
      calls.push('lease:acquire');
      acquiredChecksum = input.checksum;
      return {
        mode:'shadow',
        acquired:true,
        status:'acquired',
        ownerToken:leaseOwner,
        observedAt:input.observedAt,
        checksum:input.checksum,
      };
    },
    durableWrite:async () => {
      calls.push('durable:stored');
      return { pgMode:'shadow', archiveMode:'shadow', status:'stored', publishAllowed:true };
    },
    renewPublicationLease:async lease => {
      calls.push('lease:renew');
      return { ...lease, renewed:true, status:'renewed' };
    },
    recordRuntimeCacheCommit:async commit => {
      calls.push(`sink:${commit.status}`);
      runtimeSinkChecksum = commit.checksum;
      return { mode:'shadow', status:commit.status };
    },
    releasePublicationLease:async (_lease, options) => {
      calls.push(`lease:release:${options.status}`);
      releasedChecksum = options.checksum;
      return { mode:'shadow', released:true, status:options.status };
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(cacheWrites, 1);
  assert.ok(cachedBundle);
  assert.deepEqual(cachedBundle.snapshot.persistence.publicationLease, {
    mode:'postgres-distributed-lease',
    status:'enforced',
    enforced:true,
    ttlSeconds:LISTING_PG_PUBLICATION_LEASE_SECONDS,
  });
  assert.equal(response.payload.persistence.publicationLease.status, 'enforced');
  const publishedChecksum = listingAuditPersistenceChecksum(cachedBundle);
  assert.equal(acquiredChecksum, publishedChecksum);
  assert.equal(runtimeSinkChecksum, publishedChecksum);
  assert.equal(releasedChecksum, publishedChecksum);
  assert.deepEqual(calls, [
    'cache:get',
    'lease:acquire',
    'cache:get',
    'durable:stored',
    'lease:renew',
    'cache:set',
    'cache:get',
    'sink:stored',
    'lease:release:published',
  ]);
});

test('shadow renewal service failure publishes only a fixed degraded diagnostic with the final cache checksum', async () => {
  const observations = fullObservations();
  const response = responseRecorder();
  const secret = 'postgres://lease_user:super-secret@db.internal.example/rwa';
  let acquiredChecksum = null;
  let cachedBundle = null;
  let sinkChecksum = null;
  let releasedOwnerChecksum = null;
  let releasedPublishedChecksum = null;
  await runListingAudit({ headers:{ host:'avenir-rwa-analyst.vercel.app' } }, response, {
    env:{ PG_WRITE_MODE:'shadow', RAW_ARCHIVE_MODE:'off' },
    cache:{
      async get() { return cachedBundle; },
      async set(_key, bundle) { cachedBundle = bundle; },
    },
    collectObservations:async () => observations,
    now:() => '2026-08-15T00:45:00.000Z',
    acquirePublicationLease:async input => {
      acquiredChecksum = input.checksum;
      return {
        mode:'shadow', acquired:true, enforced:true, status:'acquired',
        ownerToken:'00000000-0000-4000-8000-000000000020',
        observedAt:input.observedAt, checksum:input.checksum,
      };
    },
    durableWrite:async () => ({ pgMode:'shadow', status:'stored', publishAllowed:true }),
    renewPublicationLease:async () => {
      const error = new Error(`database unavailable at ${secret}`);
      error.code = 'ECONNRESET';
      throw error;
    },
    recordRuntimeCacheCommit:async commit => {
      sinkChecksum = commit.checksum;
      return { mode:'shadow', status:commit.status };
    },
    releasePublicationLease:async (lease, options) => {
      releasedOwnerChecksum = lease.checksum;
      releasedPublishedChecksum = options.checksum;
      return { mode:'shadow', released:true, status:options.status };
    },
  });

  assert.equal(response.statusCode, 200);
  assert.ok(cachedBundle);
  assert.deepEqual(cachedBundle.snapshot.persistence.publicationLease, {
    mode:'postgres-distributed-lease',
    status:'degraded',
    enforced:false,
    ttlSeconds:LISTING_PG_PUBLICATION_LEASE_SECONDS,
    errorCode:'LEASE_SERVICE_UNAVAILABLE',
  });
  assert.deepEqual(response.payload.persistence.publicationLease, cachedBundle.snapshot.persistence.publicationLease);
  assert.doesNotMatch(JSON.stringify(cachedBundle), /super-secret|db\.internal\.example/);
  assert.doesNotMatch(JSON.stringify(response.payload), /super-secret|db\.internal\.example/);
  const finalChecksum = listingAuditPersistenceChecksum(cachedBundle);
  assert.notEqual(acquiredChecksum, finalChecksum, 'degraded publication metadata changes the cached payload');
  assert.equal(releasedOwnerChecksum, acquiredChecksum, 'release still fences on the originally acquired payload');
  assert.equal(sinkChecksum, finalChecksum);
  assert.equal(releasedPublishedChecksum, finalChecksum);
});

test('shadow acquisition service failure skips renewal and redacts the database error from the degraded cache', async () => {
  const observations = fullObservations();
  const response = responseRecorder();
  const secret = 'postgres://lease_user:acquire-secret@db.internal.example/rwa';
  let attemptedChecksum = null;
  let cachedBundle = null;
  let sinkChecksum = null;
  let renewCalls = 0;
  let releaseCalls = 0;
  await runListingAudit({ headers:{ host:'avenir-rwa-analyst.vercel.app' } }, response, {
    env:{ PG_WRITE_MODE:'shadow', RAW_ARCHIVE_MODE:'off' },
    cache:{
      async get() { return cachedBundle; },
      async set(_key, bundle) { cachedBundle = bundle; },
    },
    collectObservations:async () => observations,
    now:() => '2026-08-15T00:45:00.000Z',
    acquirePublicationLease:async input => {
      attemptedChecksum = input.checksum;
      const error = new Error(`database unavailable at ${secret}`);
      error.code = 'ECONNREFUSED';
      throw error;
    },
    durableWrite:async () => ({ pgMode:'shadow', status:'failed', publishAllowed:true }),
    renewPublicationLease:async lease => { renewCalls += 1; return lease; },
    recordRuntimeCacheCommit:async commit => {
      sinkChecksum = commit.checksum;
      return { mode:'shadow', status:commit.status };
    },
    releasePublicationLease:async () => { releaseCalls += 1; },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(renewCalls, 0);
  assert.equal(releaseCalls, 0);
  assert.ok(cachedBundle);
  assert.deepEqual(cachedBundle.snapshot.persistence.publicationLease, {
    mode:'postgres-distributed-lease',
    status:'degraded',
    enforced:false,
    ttlSeconds:LISTING_PG_PUBLICATION_LEASE_SECONDS,
    errorCode:'LEASE_SERVICE_UNAVAILABLE',
  });
  assert.deepEqual(response.payload.persistence.publicationLease, cachedBundle.snapshot.persistence.publicationLease);
  assert.doesNotMatch(JSON.stringify(cachedBundle), /acquire-secret|db\.internal\.example/);
  assert.doesNotMatch(JSON.stringify(response.payload), /acquire-secret|db\.internal\.example/);
  const finalChecksum = listingAuditPersistenceChecksum(cachedBundle);
  assert.notEqual(attemptedChecksum, finalChecksum);
  assert.equal(sinkChecksum, finalChecksum);
});

test('shadow lease SQL and validation failures hard-block publication instead of masquerading as service degradation', async () => {
  const request = { headers:{ host:'avenir-rwa-analyst.vercel.app' } };
  const observations = fullObservations();

  const acquireResponse = responseRecorder();
  let acquireCacheWrites = 0;
  let acquireDurableWrites = 0;
  await runListingAudit(request, acquireResponse, {
    env:{ PG_WRITE_MODE:'shadow', RAW_ARCHIVE_MODE:'off' },
    cache:{ async get() { return null; }, async set() { acquireCacheWrites += 1; } },
    collectObservations:async () => observations,
    now:() => '2026-08-15T00:45:00.000Z',
    acquirePublicationLease:async () => {
      const error = new Error('invalid publication lease SQL');
      error.code = '42601';
      throw error;
    },
    durableWrite:async () => { acquireDurableWrites += 1; },
  });
  assert.equal(acquireResponse.statusCode, 503);
  assert.equal(acquireCacheWrites, 0);
  assert.equal(acquireDurableWrites, 0);

  const renewResponse = responseRecorder();
  let renewCacheWrites = 0;
  const releaseStatuses = [];
  await runListingAudit(request, renewResponse, {
    env:{ PG_WRITE_MODE:'shadow', RAW_ARCHIVE_MODE:'off' },
    cache:{ async get() { return null; }, async set() { renewCacheWrites += 1; } },
    collectObservations:async () => observations,
    now:() => '2026-08-15T00:45:00.000Z',
    acquirePublicationLease:async input => ({
      mode:'shadow', acquired:true, enforced:true, status:'acquired',
      ownerToken:'00000000-0000-4000-8000-000000000021',
      observedAt:input.observedAt, checksum:input.checksum,
    }),
    durableWrite:async () => ({ pgMode:'shadow', status:'stored', publishAllowed:true }),
    renewPublicationLease:async () => { throw new TypeError('invalid lease owner'); },
    releasePublicationLease:async (_lease, options) => { releaseStatuses.push(options.status); },
  });
  assert.equal(renewResponse.statusCode, 503);
  assert.equal(renewCacheWrites, 0);
  assert.deepEqual(releaseStatuses, ['failed']);
});

test('busy, stale, or conflicting publication leases return 409 without durable/cache/sink mutation', async () => {
  const observations = fullObservations();
  for (const leaseStatus of ['busy', 'stale', 'conflict']) {
    const response = responseRecorder();
    const calls = { durable:0, cache:0, sink:0, renew:0, release:0 };
    await runListingAudit({ headers:{ host:'avenir-rwa-analyst.vercel.app' } }, response, {
      cache: {
        async get() { return null; },
        async set() { calls.cache += 1; },
      },
      collectObservations:async () => observations,
      now:() => '2026-08-15T00:45:00.000Z',
      acquirePublicationLease:async () => ({ mode:'shadow', acquired:false, status:leaseStatus }),
      durableWrite:async () => { calls.durable += 1; },
      renewPublicationLease:async () => { calls.renew += 1; },
      recordRuntimeCacheCommit:async () => { calls.sink += 1; },
      releasePublicationLease:async () => { calls.release += 1; },
    });
    assert.equal(response.statusCode, 409, leaseStatus);
    assert.match(response.payload.error, new RegExp(leaseStatus), leaseStatus);
    assert.deepEqual(calls, { durable:0, cache:0, sink:0, renew:0, release:0 }, leaseStatus);
  }
});

test('separate serverless instances cannot publish while another owner holds the lease', async () => {
  const nonce = `${Date.now()}-${Math.random()}`;
  const [{ runListingAudit:runInstanceA }, { runListingAudit:runInstanceB }] = await Promise.all([
    import(`../api/listing-changes.js?lease-busy-a=${nonce}`),
    import(`../api/listing-changes.js?lease-busy-b=${nonce}`),
  ]);
  const observations = fullObservations();
  const durableGate = deferred();
  const acquiredA = deferred();
  let cacheWrites = 0;
  let cachedBundle = null;
  let bDurable = 0;
  let bSink = 0;
  const cache = {
    async get() { return cachedBundle; },
    async set(_key, bundle) { cachedBundle = bundle; cacheWrites += 1; },
  };
  const responseA = responseRecorder();
  const responseB = responseRecorder();
  const request = { headers:{ host:'avenir-rwa-analyst.vercel.app' } };
  const runA = runInstanceA(request, responseA, {
    cache,
    collectObservations:async () => observations,
    now:() => '2026-08-15T00:45:00.000Z',
    acquirePublicationLease:async input => {
      acquiredA.resolve();
      return {
        mode:'shadow', acquired:true, status:'acquired',
        ownerToken:'00000000-0000-4000-8000-000000000010',
        observedAt:input.observedAt, checksum:input.checksum,
      };
    },
    durableWrite:async () => {
      await durableGate.promise;
      return { pgMode:'shadow', status:'stored', publishAllowed:true };
    },
    renewPublicationLease:async lease => ({ ...lease, renewed:true, status:'renewed' }),
    recordRuntimeCacheCommit:async commit => ({ status:commit.status }),
    releasePublicationLease:async (_lease, options) => ({ released:true, status:options.status }),
  });
  await acquiredA.promise;

  await runInstanceB(request, responseB, {
    cache,
    collectObservations:async () => observations,
    now:() => '2026-08-15T00:45:30.000Z',
    acquirePublicationLease:async () => ({ mode:'shadow', acquired:false, status:'busy' }),
    durableWrite:async () => { bDurable += 1; },
    recordRuntimeCacheCommit:async () => { bSink += 1; },
  });
  assert.equal(responseB.statusCode, 409);
  assert.match(responseB.payload.error, /lease busy/);
  assert.equal(bDurable, 0);
  assert.equal(bSink, 0);
  assert.equal(cacheWrites, 0);

  durableGate.resolve();
  await runA;
  assert.equal(responseA.statusCode, 200);
  assert.equal(cacheWrites, 1);
});

test('post-acquire cache re-read rejects a stale B0 baseline after instance A publishes B1', async () => {
  const nonce = `${Date.now()}-${Math.random()}`;
  const [{ runListingAudit:runInstanceA }, { runListingAudit:runInstanceB }] = await Promise.all([
    import(`../api/listing-changes.js?lease-reread-a=${nonce}`),
    import(`../api/listing-changes.js?lease-reread-b=${nonce}`),
  ]);
  const observations = fullObservations();
  const bInitialRead = deferred();
  const aReleased = deferred();
  let currentBundle = null;
  let aCacheWrites = 0;
  let bCacheWrites = 0;
  let bDurable = 0;
  let bSink = 0;
  let bRenew = 0;
  const cacheA = {
    async get() { return currentBundle; },
    async set(_key, bundle) { currentBundle = bundle; aCacheWrites += 1; },
  };
  let bGetCount = 0;
  const cacheB = {
    async get() {
      bGetCount += 1;
      if (bGetCount === 1) bInitialRead.resolve();
      return currentBundle;
    },
    async set() { bCacheWrites += 1; },
  };
  const request = { headers:{ host:'avenir-rwa-analyst.vercel.app' } };
  const responseA = responseRecorder();
  const responseB = responseRecorder();

  const runB = runInstanceB(request, responseB, {
    cache:cacheB,
    collectObservations:async () => {
      await aReleased.promise;
      return observations;
    },
    now:() => '2026-08-15T01:45:00.000Z',
    acquirePublicationLease:async input => ({
      mode:'shadow', acquired:true, status:'acquired',
      ownerToken:'00000000-0000-4000-8000-000000000012',
      observedAt:input.observedAt, checksum:input.checksum,
    }),
    durableWrite:async () => { bDurable += 1; },
    renewPublicationLease:async lease => { bRenew += 1; return lease; },
    recordRuntimeCacheCommit:async () => { bSink += 1; },
    releasePublicationLease:async (_lease, options) => ({ released:true, status:options.status }),
  });
  await bInitialRead.promise;

  await runInstanceA(request, responseA, {
    cache:cacheA,
    collectObservations:async () => observations,
    now:() => '2026-08-15T00:45:00.000Z',
    acquirePublicationLease:async input => ({
      mode:'shadow', acquired:true, status:'acquired',
      ownerToken:'00000000-0000-4000-8000-000000000011',
      observedAt:input.observedAt, checksum:input.checksum,
    }),
    durableWrite:async () => ({ pgMode:'shadow', status:'stored', publishAllowed:true }),
    renewPublicationLease:async lease => ({ ...lease, renewed:true, status:'renewed' }),
    recordRuntimeCacheCommit:async commit => ({ status:commit.status }),
    releasePublicationLease:async (_lease, options) => {
      aReleased.resolve();
      return { released:true, status:options.status };
    },
  });
  assert.equal(responseA.statusCode, 200);
  assert.equal(aCacheWrites, 1);
  assert.ok(currentBundle);

  await runB;
  assert.equal(responseB.statusCode, 409);
  assert.equal(responseB.payload.error, 'Listing audit state advanced before publication lease acquisition');
  assert.equal(bGetCount, 2);
  assert.equal(bDurable, 0);
  assert.equal(bRenew, 0);
  assert.equal(bCacheWrites, 0);
  assert.equal(bSink, 0);
});

test('durable failure, lost lease renewal, and cache failure release failed without an unsafe cache write', async () => {
  const observations = fullObservations();
  const request = { headers:{ host:'avenir-rwa-analyst.vercel.app' } };
  const baseLease = {
    mode:'shadow',
    acquired:true,
    status:'acquired',
    ownerToken:'00000000-0000-4000-8000-000000000003',
    observedAt:'2026-08-15T00:45:00.000Z',
    checksum:'e'.repeat(64),
  };

  const durableFailure = responseRecorder();
  const durableRelease = [];
  let durableCacheWrites = 0;
  await runListingAudit(request, durableFailure, {
    cache:{ async get() { return null; }, async set() { durableCacheWrites += 1; } },
    collectObservations:async () => observations,
    now:() => baseLease.observedAt,
    acquirePublicationLease:async () => baseLease,
    durableWrite:async () => { throw new Error('durable write failed'); },
    renewPublicationLease:async () => { throw new Error('renew must not run'); },
    releasePublicationLease:async (_lease, options) => { durableRelease.push(options.status); },
  });
  assert.equal(durableFailure.statusCode, 503);
  assert.equal(durableCacheWrites, 0);
  assert.deepEqual(durableRelease, ['failed']);

  const lostRenewal = responseRecorder();
  const lostRelease = [];
  let lostCacheWrites = 0;
  await runListingAudit(request, lostRenewal, {
    env:{ PG_WRITE_MODE:'shadow', RAW_ARCHIVE_MODE:'off' },
    cache:{ async get() { return null; }, async set() { lostCacheWrites += 1; } },
    collectObservations:async () => observations,
    now:() => baseLease.observedAt,
    acquirePublicationLease:async () => baseLease,
    durableWrite:async () => ({ pgMode:'shadow', status:'stored', publishAllowed:true }),
    renewPublicationLease:async () => { throw new Error(LISTING_PG_PUBLICATION_LEASE_LOST_ERROR_CODE); },
    releasePublicationLease:async (_lease, options) => { lostRelease.push(options.status); },
  });
  assert.equal(lostRenewal.statusCode, 503);
  assert.equal(lostCacheWrites, 0);
  assert.deepEqual(lostRelease, ['failed']);

  const cacheFailure = responseRecorder();
  const cacheRelease = [];
  const cacheSink = [];
  await runListingAudit(request, cacheFailure, {
    cache:{ async get() { return null; }, async set() { throw new Error('cache offline'); } },
    collectObservations:async () => observations,
    now:() => baseLease.observedAt,
    acquirePublicationLease:async () => baseLease,
    durableWrite:async () => ({ pgMode:'shadow', status:'stored', publishAllowed:true }),
    renewPublicationLease:async lease => ({ ...lease, renewed:true, status:'renewed' }),
    recordRuntimeCacheCommit:async commit => { cacheSink.push(commit.status); return { status:commit.status }; },
    releasePublicationLease:async (_lease, options) => { cacheRelease.push(options.status); },
  });
  assert.equal(cacheFailure.statusCode, 503);
  assert.deepEqual(cacheSink, ['failed']);
  assert.deepEqual(cacheRelease, ['failed']);
});

test('a successful Runtime Cache set without a matching read-back is a failed publication', async () => {
  const observations = fullObservations();
  const response = responseRecorder();
  const commits = [];
  const releases = [];
  let cacheWrites = 0;
  await runListingAudit({ headers:{ host:'avenir-rwa-analyst.vercel.app' } }, response, {
    env:{ PG_WRITE_MODE:'shadow', RAW_ARCHIVE_MODE:'off' },
    cache:{
      async get() { return null; },
      async set() { cacheWrites += 1; },
    },
    collectObservations:async () => observations,
    now:() => '2026-08-15T00:45:00.000Z',
    acquirePublicationLease:async input => ({
      mode:'shadow', acquired:true, enforced:true, status:'acquired',
      ownerToken:'00000000-0000-4000-8000-000000000030',
      observedAt:input.observedAt, checksum:input.checksum,
    }),
    durableWrite:async () => ({ pgMode:'shadow', status:'stored', publishAllowed:true }),
    renewPublicationLease:async lease => ({ ...lease, renewed:true, status:'renewed' }),
    recordRuntimeCacheCommit:async commit => {
      commits.push(commit.status);
      return { mode:'shadow', status:commit.status };
    },
    releasePublicationLease:async (_lease, options) => {
      releases.push(options.status);
      return { mode:'shadow', released:true, status:options.status };
    },
  });
  assert.equal(cacheWrites, 1);
  assert.equal(response.statusCode, 503);
  assert.equal(response.payload.error, 'Listing audit persistence unavailable');
  assert.deepEqual(commits, ['failed']);
  assert.deepEqual(releases, ['failed']);
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
    verifyRuntimeCacheWrite:async (_cache, checksum) => ({ status:'verified', checksum }),
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
    verifyRuntimeCacheWrite:async (_cache, checksum) => ({ status:'verified', checksum }),
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

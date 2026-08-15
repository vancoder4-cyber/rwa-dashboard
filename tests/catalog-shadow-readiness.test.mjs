import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { LISTING_SOURCE_KEYS } from '../api/_lib/listing-audit.js';
import {
  CATALOG_SHADOW_EXPECTED_SINKS,
  CATALOG_SHADOW_READINESS_SCHEMA_VERSION,
  CATALOG_SHADOW_REQUIRED_UTC_CYCLES,
  buildCatalogShadowReadiness,
  buildCatalogShadowReadinessQueries,
  runCatalogShadowReadinessQueries,
} from '../api/_lib/catalog-shadow-readiness.js';

const DAY_MS = 86_400_000;
const LATEST_DAY = '2026-08-14';

function isoDay(offsetFromLatest) {
  return new Date(Date.parse(`${LATEST_DAY}T00:00:00.000Z`) + offsetFromLatest * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function toCamelRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
    value,
  ]));
}

function readinessFixture(dayCount = CATALOG_SHADOW_REQUIRED_UTC_CYCLES, { camelCase = false } = {}) {
  const cycleRows = [];
  const attemptRows = [];
  const sourceRows = [];
  const membershipRows = [];
  const sinkRows = [];
  const changeRows = [];
  let previousCycleId = null;

  for (let offset = -(dayCount - 1); offset <= 0; offset += 1) {
    const day = isoDay(offset);
    const cycleId = `cycle-${day}`;
    const attemptId = `attempt-${day}`;
    const bucketAt = `${day}T00:00:00.000Z`;
    const completedAt = `${day}T00:45:00.000Z`;
    cycleRows.push({ cycle_id: cycleId, bucket_at: bucketAt, cycle_status: 'complete', trigger_kind: 'cron' });
    attemptRows.push({
      cycle_id: cycleId,
      attempt_id: attemptId,
      attempt_no: 1,
      attempt_status: 'complete',
      attempt_started_at: `${day}T00:00:30.000Z`,
      attempt_completed_at: completedAt,
    });
    for (const sourceKey of LISTING_SOURCE_KEYS) {
      sourceRows.push({
        cycle_id: cycleId,
        source_key: sourceKey,
        source_run_id: `run-${day}-${sourceKey}`,
        endpoint_key: 'official-catalog',
        run_status: 'full',
        catalog_status: 'full',
        identity_status: 'full',
        listing_count: 1,
        admitted_listing_count: 1,
        rejected_listing_count: 0,
        merged_status: 'full',
        withheld_from_membership: 0,
        stored_artifact_count: 1,
        official_evidence_count: 1,
        missing_official_evidence_count: 0,
      });
      membershipRows.push({
        cycle_id: cycleId,
        source_key: sourceKey,
        membership_count: 1,
        distinct_instrument_count: 1,
        membership_fingerprint: `sha256:${day}:${sourceKey}`,
      });
      changeRows.push({
        cycle_id: cycleId,
        previous_cycle_id: previousCycleId,
        source_key: sourceKey,
        added_count: previousCycleId ? 0 : null,
        removed_count: previousCycleId ? 0 : null,
      });
    }
    for (const sinkName of CATALOG_SHADOW_EXPECTED_SINKS) {
      sinkRows.push({
        cycle_id: cycleId,
        sink_name: sinkName,
        sink_status: 'stored',
        row_count: 10,
        checksum: `sha256:${day}:${sinkName}`,
        committed_at: completedAt,
        error_summary: null,
      });
    }
    previousCycleId = cycleId;
  }

  const latestCycleId = `cycle-${LATEST_DAY}`;
  const latestCompletedAt = `${LATEST_DAY}T00:45:00.000Z`;
  const fixture = {
    now: `${LATEST_DAY}T01:45:00.000Z`,
    cycleRows,
    attemptRows,
    sourceRows,
    membershipRows,
    sinkRows,
    changeRows,
    eventRows: [],
    integrityRow: {
      invalid_membership_count: 0,
      open_review_accepted_count: 0,
      duplicate_current_version_count: 0,
      overlapping_version_count: 0,
      event_source_cycle_mismatch_count: 0,
    },
    laterPhaseRow: {
      market_fact_rows: 0,
      derived_analytics_rows: 0,
      publication_rows: 0,
      alert_rows: 0,
    },
    runtimeSnapshot: {
      schemaVersion: 'rwa-listing-audit/v1',
      generatedAt: latestCompletedAt,
      status: 'full',
      counts: { activeListings: 10 },
      history: { truncated: false },
      sources: LISTING_SOURCE_KEYS.map(sourceKey => ({ sourceKey, status: 'full', listingCount: 1 })),
    },
    runtimeError: null,
  };

  assert.equal(fixture.cycleRows.at(-1).cycle_id, latestCycleId);
  if (!camelCase) return fixture;
  for (const key of ['cycleRows', 'attemptRows', 'sourceRows', 'membershipRows', 'sinkRows', 'changeRows', 'eventRows']) {
    fixture[key] = fixture[key].map(toCamelRow);
  }
  fixture.integrityRow = toCamelRow(fixture.integrityRow);
  fixture.laterPhaseRow = toCamelRow(fixture.laterPhaseRow);
  return fixture;
}

function latestRows(fixture, collection) {
  return fixture[collection].filter(row => (row.cycle_id ?? row.cycleId) === `cycle-${LATEST_DAY}`);
}

function findLatestSource(fixture, sourceKey = LISTING_SOURCE_KEYS[0]) {
  return latestRows(fixture, 'sourceRows').find(row => (row.source_key ?? row.sourceKey) === sourceKey);
}

function findLatestMembership(fixture, sourceKey = LISTING_SOURCE_KEYS[0]) {
  return latestRows(fixture, 'membershipRows').find(row => (row.source_key ?? row.sourceKey) === sourceKey);
}

function setLatestListingCount(fixture, sourceKey, count) {
  const source = findLatestSource(fixture, sourceKey);
  source.listing_count = count;
  source.admitted_listing_count = count;
  source.official_evidence_count = count;
  const membership = findLatestMembership(fixture, sourceKey);
  membership.membership_count = count;
  membership.distinct_instrument_count = count;
  const runtimeSource = fixture.runtimeSnapshot.sources.find(row => row.sourceKey === sourceKey);
  runtimeSource.listingCount = count;
  fixture.runtimeSnapshot.counts.activeListings = 9 + count;
  const runtimeSink = latestRows(fixture, 'sinkRows').find(row => row.sink_name === 'runtime-cache-listing-audit');
  runtimeSink.row_count = 9 + count;
}

function setLatestPostgresRows(fixture, count) {
  latestRows(fixture, 'sinkRows')
    .find(row => row.sink_name === 'postgres-catalog-shadow')
    .row_count = count;
}

function matchingLifecycleEvent(fixture, eventType, overrides = {}) {
  const observedAt = `${LATEST_DAY}T00:45:00.000Z`;
  const priorDay = isoDay(-1);
  return {
    catalog_change_event_id: `event-${eventType}`,
    cycle_id: `cycle-${LATEST_DAY}`,
    source_key: LISTING_SOURCE_KEYS[0],
    event_type: eventType,
    event_status: 'confirmed',
    baseline: false,
    observed_at: observedAt,
    valid_from: eventType === 'delisted' ? `${priorDay}T00:45:00.000Z` : observedAt,
    valid_to: eventType === 'delisted' ? observedAt : null,
    previous_bucket_at: `${priorDay}T00:00:00.000Z`,
    current_bucket_at: `${LATEST_DAY}T00:00:00.000Z`,
    ...overrides,
  };
}

function queryResults(fixture) {
  return [
    fixture.cycleRows,
    fixture.attemptRows,
    fixture.sourceRows,
    fixture.membershipRows,
    fixture.sinkRows,
    fixture.changeRows,
    fixture.eventRows,
    [fixture.integrityRow],
    [fixture.laterPhaseRow],
  ];
}

test('fourteen distinct consecutive Full UTC catalog cycles pass only a Phase 2 design-readiness gate', () => {
  const report = buildCatalogShadowReadiness(readinessFixture());

  assert.equal(CATALOG_SHADOW_READINESS_SCHEMA_VERSION, 'rwa-catalog-shadow-readiness/v1');
  assert.equal(CATALOG_SHADOW_REQUIRED_UTC_CYCLES, 14);
  assert.equal(report.schemaVersion, CATALOG_SHADOW_READINESS_SCHEMA_VERSION);
  assert.equal(report.status, 'pass');
  assert.equal(report.readyForPhase2, true);
  assert.equal(report.progress.evaluatedUtcCycles, 14);
  assert.equal(report.progress.successfulUtcCycles, 14);
  assert.equal(report.progress.consecutiveSuccessfulUtcCycles, 14);
  assert.equal(report.progress.remainingSuccessfulUtcCycles, 0);
  assert.equal(new Set(report.cycles.map(row => row.utcDay)).size, 14);
  assert.equal(report.scope.marketFactsChecked, false);
  assert.equal(report.scope.rollingMarketHistoryVerified, false);
  assert.equal(report.scope.laterPhaseTablesConfirmedEmpty, true);
  assert.match(report.decision, /design review/i);
  assert.match(report.decision, /does not enable a writer or read cutover/i);
  assert.ok(report.limitations.some(line => /No rolling 14-day market history is stored/i.test(line)));
  assert.ok(report.limitations.some(line => /does not collect or validate price, volume, OI, funding/i.test(line)));
});

test('thirteen successful UTC days remain Warming and do not authorize Phase 2', () => {
  const report = buildCatalogShadowReadiness(readinessFixture(13));
  assert.equal(report.status, 'warming');
  assert.equal(report.readyForPhase2, false);
  assert.equal(report.progress.consecutiveSuccessfulUtcCycles, 13);
  assert.equal(report.progress.remainingSuccessfulUtcCycles, 1);
  assert.match(report.decision, /still warming/i);
});

test('same cycle retry is deduplicated, while a second attempt or second cycle on one UTC day fails', () => {
  const retry = readinessFixture(13);
  retry.cycleRows.push({ ...retry.cycleRows.at(-1) });
  let report = buildCatalogShadowReadiness(retry);
  assert.equal(report.status, 'warming');
  assert.equal(report.progress.evaluatedUtcCycles, 13);

  const secondAttempt = readinessFixture();
  secondAttempt.attemptRows.push({
    ...secondAttempt.attemptRows.at(-1),
    attempt_id: 'attempt-retry',
    attempt_no: 2,
  });
  report = buildCatalogShadowReadiness(secondAttempt);
  assert.equal(report.status, 'fail');
  assert.equal(report.readyForPhase2, false);
  assert.ok(report.cycles[0].reasons.some(reason => /attempt_no=1/.test(reason)));

  const duplicateDay = readinessFixture(13);
  duplicateDay.cycleRows.push({
    ...duplicateDay.cycleRows.at(-1),
    cycle_id: 'different-cycle-same-utc-day',
  });
  report = buildCatalogShadowReadiness(duplicateDay);
  assert.equal(report.status, 'fail');
  assert.ok(report.failures.includes('duplicate UTC collection cycles exist'));
});

test('calendar gaps reset the consecutive success window and fail the readiness audit', () => {
  const fixture = readinessFixture();
  const removedCycleId = fixture.cycleRows[5].cycle_id;
  fixture.cycleRows.splice(5, 1);
  for (const key of ['attemptRows', 'sourceRows', 'membershipRows', 'sinkRows', 'changeRows', 'eventRows']) {
    fixture[key] = fixture[key].filter(row => row.cycle_id !== removedCycleId);
  }
  const report = buildCatalogShadowReadiness(fixture);
  assert.equal(report.status, 'fail');
  assert.equal(report.readyForPhase2, false);
  assert.ok(report.failures.includes('the evaluated UTC cycle window has calendar gaps'));
});

test('Partial, Unavailable, incomplete identity, or wrong endpoint source runs cannot count as successful', () => {
  const cases = [
    ['run_status', 'partial'],
    ['run_status', 'unavailable'],
    ['catalog_status', 'partial'],
    ['identity_status', 'partial'],
    ['endpoint_key', 'ticker'],
  ];
  for (const [field, value] of cases) {
    const fixture = readinessFixture();
    findLatestSource(fixture)[field] = value;
    const report = buildCatalogShadowReadiness(fixture);
    assert.equal(report.status, 'fail', `${field}=${value}`);
    assert.equal(report.readyForPhase2, false, `${field}=${value}`);
    assert.equal(report.cycles[0].success, false, `${field}=${value}`);
  }
});

test('all three independently stored sinks are mandatory for a successful cycle', () => {
  for (const badStatus of ['partial', 'unavailable', 'failed']) {
    const fixture = readinessFixture();
    latestRows(fixture, 'sinkRows')[0].sink_status = badStatus;
    const report = buildCatalogShadowReadiness(fixture);
    assert.equal(report.status, 'fail', badStatus);
    assert.equal(report.readyForPhase2, false, badStatus);
  }
  const missing = readinessFixture();
  missing.sinkRows = missing.sinkRows.filter(row => !(
    row.cycle_id === `cycle-${LATEST_DAY}` && row.sink_name === 'blob-normalized-catalog'
  ));
  assert.equal(buildCatalogShadowReadiness(missing).status, 'fail');
});

test('source count, exact membership, and Runtime Cache count/timestamp mismatches fail closed', () => {
  const sourceMismatch = readinessFixture();
  findLatestSource(sourceMismatch).listing_count = 2;
  assert.equal(buildCatalogShadowReadiness(sourceMismatch).status, 'fail');

  const membershipMismatch = readinessFixture();
  findLatestMembership(membershipMismatch).membership_count = 0;
  assert.equal(buildCatalogShadowReadiness(membershipMismatch).status, 'fail');

  const duplicateMembership = readinessFixture();
  findLatestMembership(duplicateMembership).distinct_instrument_count = 0;
  assert.equal(buildCatalogShadowReadiness(duplicateMembership).status, 'fail');

  const cacheCountMismatch = readinessFixture();
  cacheCountMismatch.runtimeSnapshot.counts.activeListings = 11;
  assert.equal(buildCatalogShadowReadiness(cacheCountMismatch).status, 'fail');

  const cacheSourceMismatch = readinessFixture();
  cacheSourceMismatch.runtimeSnapshot.sources[0].listingCount = 2;
  assert.equal(buildCatalogShadowReadiness(cacheSourceMismatch).status, 'fail');

  const cacheTimestampMismatch = readinessFixture();
  cacheTimestampMismatch.runtimeSnapshot.generatedAt = `${LATEST_DAY}T00:46:00.000Z`;
  assert.equal(buildCatalogShadowReadiness(cacheTimestampMismatch).status, 'fail');

  const truncated = readinessFixture();
  truncated.runtimeSnapshot.history.truncated = true;
  assert.equal(buildCatalogShadowReadiness(truncated).status, 'fail');

  const unavailable = readinessFixture();
  unavailable.runtimeSnapshot = null;
  unavailable.runtimeError = new Error('cache unavailable');
  assert.equal(buildCatalogShadowReadiness(unavailable).status, 'fail');
});

test('missing source counts, normalized artifacts, or exact official evidence never pass readiness', () => {
  const cases = [
    ['listing_count', null],
    ['admitted_listing_count', null],
    ['rejected_listing_count', null],
    ['stored_artifact_count', null],
    ['stored_artifact_count', 0],
    ['official_evidence_count', null],
    ['official_evidence_count', 0],
    ['missing_official_evidence_count', null],
    ['missing_official_evidence_count', 1],
  ];
  for (const [field, value] of cases) {
    const fixture = readinessFixture();
    findLatestSource(fixture)[field] = value;
    const report = buildCatalogShadowReadiness(fixture);
    assert.equal(report.status, 'fail', `${field}=${value}`);
    assert.equal(report.readyForPhase2, false, `${field}=${value}`);
    assert.equal(report.cycles[0].success, false, `${field}=${value}`);
  }

  const missingMembershipRow = readinessFixture();
  missingMembershipRow.membershipRows = missingMembershipRow.membershipRows.filter(row => !(
    row.cycle_id === `cycle-${LATEST_DAY}` && row.source_key === LISTING_SOURCE_KEYS[0]
  ));
  assert.equal(buildCatalogShadowReadiness(missingMembershipRow).status, 'fail');
});

test('sink row counts conserve accepted membership, lifecycle events, and archived manifests', () => {
  const badPostgresCount = readinessFixture();
  setLatestPostgresRows(badPostgresCount, 9);
  let report = buildCatalogShadowReadiness(badPostgresCount);
  assert.equal(report.status, 'fail');
  assert.ok(report.cycles[0].reasons.some(reason => /PostgreSQL sink row count/.test(reason)));

  const tooFewBlobRows = readinessFixture();
  latestRows(tooFewBlobRows, 'sinkRows').find(row => row.sink_name === 'blob-normalized-catalog').row_count = 9;
  report = buildCatalogShadowReadiness(tooFewBlobRows);
  assert.equal(report.status, 'fail');
  assert.ok(report.cycles[0].reasons.some(reason => /normalized catalog sink row count/.test(reason)));

  const moreBlobRowsThanStoredManifests = readinessFixture();
  latestRows(moreBlobRowsThanStoredManifests, 'sinkRows').find(row => row.sink_name === 'blob-normalized-catalog').row_count = 11;
  report = buildCatalogShadowReadiness(moreBlobRowsThanStoredManifests);
  assert.equal(report.status, 'fail');
  assert.ok(report.cycles[0].reasons.some(reason => /normalized catalog sink row count/.test(reason)));
});

test('Runtime Cache must use the exact listing-audit schema and admitted-plus-withheld active cohort', () => {
  const wrongSchema = readinessFixture();
  wrongSchema.runtimeSnapshot.schemaVersion = 'rwa-listing-audit/v0';
  let report = buildCatalogShadowReadiness(wrongSchema);
  assert.equal(report.status, 'fail');
  assert.ok(report.runtimeCache.reasons.some(reason => /schema version/.test(reason)));

  const validWithheld = readinessFixture();
  const source = findLatestSource(validWithheld);
  source.withheld_from_membership = 1;
  validWithheld.runtimeSnapshot.sources[0].listingCount = 2;
  validWithheld.runtimeSnapshot.counts.activeListings = 11;
  latestRows(validWithheld, 'sinkRows').find(row => row.sink_name === 'runtime-cache-listing-audit').row_count = 11;
  report = buildCatalogShadowReadiness(validWithheld);
  assert.equal(report.status, 'pass');
  assert.equal(report.runtimeCache.match, true);

  const wrongCohort = readinessFixture();
  findLatestSource(wrongCohort).withheld_from_membership = 1;
  report = buildCatalogShadowReadiness(wrongCohort);
  assert.equal(report.status, 'fail');
  assert.ok(report.runtimeCache.reasons.some(reason => /exact source cohort total/.test(reason)));
});

test('first baseline with no lifecycle event is valid but remains Warming', () => {
  const report = buildCatalogShadowReadiness(readinessFixture(1));
  assert.equal(report.status, 'warming');
  assert.equal(report.readyForPhase2, false);
  assert.equal(report.cycles[0].success, true);
  assert.equal(report.cycles[0].changes.comparableSources, 0);
  assert.equal(report.cycles[0].lifecycle.total, 0);
  assert.equal(report.cycles[0].lifecycle.invalid, 0);
});

test('cross-day additions require matching confirmed listed or relisted SCD2 events', () => {
  for (const eventType of ['listed', 'relisted']) {
    const fixture = readinessFixture();
    const change = latestRows(fixture, 'changeRows')[0];
    change.added_count = 1;
    setLatestListingCount(fixture, LISTING_SOURCE_KEYS[0], 2);
    fixture.eventRows.push(matchingLifecycleEvent(fixture, eventType));
    setLatestPostgresRows(fixture, 12);
    const report = buildCatalogShadowReadiness(fixture);
    assert.equal(report.status, 'pass', `${eventType}: ${JSON.stringify({ failures: report.failures, reasons: report.cycles[0].reasons })}`);
    assert.equal(report.cycles[0].changes.added, 1);
    assert.equal(report.cycles[0].lifecycle[eventType], 1);
  }

  const missingEvent = readinessFixture();
  latestRows(missingEvent, 'changeRows')[0].added_count = 1;
  setLatestListingCount(missingEvent, LISTING_SOURCE_KEYS[0], 2);
  assert.equal(buildCatalogShadowReadiness(missingEvent).status, 'fail');

  const extraEvent = readinessFixture();
  extraEvent.eventRows.push(matchingLifecycleEvent(extraEvent, 'listed'));
  assert.equal(buildCatalogShadowReadiness(extraEvent).status, 'fail');
});

test('per-source lifecycle conservation rejects cross-source cancellation even when global totals match', () => {
  const fixture = readinessFixture();
  const sourceA = LISTING_SOURCE_KEYS[0];
  const sourceB = LISTING_SOURCE_KEYS[1];
  latestRows(fixture, 'changeRows').find(row => row.source_key === sourceA).added_count = 1;
  setLatestListingCount(fixture, sourceA, 2);
  fixture.eventRows.push(matchingLifecycleEvent(fixture, 'listed', { source_key: sourceB }));
  setLatestPostgresRows(fixture, 12);

  const report = buildCatalogShadowReadiness(fixture);
  const latest = report.cycles[0];
  assert.equal(latest.changes.added, 1);
  assert.equal(latest.lifecycle.listed, 1);
  assert.equal(report.status, 'fail');
  assert.equal(report.readyForPhase2, false);
  assert.ok(latest.reasons.some(reason => reason.startsWith(`${sourceA} accepted membership additions`)));
  assert.ok(latest.reasons.some(reason => reason.startsWith(`${sourceB} accepted membership additions`)));
  assert.deepEqual(
    latest.changes.sources.find(row => row.sourceKey === sourceA),
    { sourceKey: sourceA, comparable: true, added: 1, removed: 0 },
  );
  assert.deepEqual(
    latest.changes.sources.find(row => row.sourceKey === sourceB),
    { sourceKey: sourceB, comparable: true, added: 0, removed: 0 },
  );
  assert.deepEqual(
    latest.lifecycle.sources.find(row => row.sourceKey === sourceA),
    { sourceKey: sourceA, listed: 0, delisted: 0, relisted: 0, invalid: 0 },
  );
  assert.deepEqual(
    latest.lifecycle.sources.find(row => row.sourceKey === sourceB),
    { sourceKey: sourceB, listed: 1, delisted: 0, relisted: 0, invalid: 0 },
  );
});

test('pending removal is not misreported as a delist; confirmed delist requires exact cross-day SCD2 closure', () => {
  const pending = readinessFixture();
  const source = findLatestSource(pending);
  source.run_status = 'partial';
  source.catalog_status = 'partial';
  source.merged_status = 'partial';
  pending.runtimeSnapshot.sources[0].status = 'partial';
  latestRows(pending, 'changeRows')[0].removed_count = 1;
  const pendingReport = buildCatalogShadowReadiness(pending);
  assert.equal(pendingReport.status, 'fail');
  assert.equal(pendingReport.cycles[0].lifecycle.delisted, 0);
  assert.equal(pendingReport.cycles[0].lifecycle.invalid, 0);

  const confirmed = readinessFixture();
  confirmed.eventRows.push(matchingLifecycleEvent(confirmed, 'delisted'));
  setLatestPostgresRows(confirmed, 11);
  const confirmedReport = buildCatalogShadowReadiness(confirmed);
  assert.equal(confirmedReport.status, 'pass');
  assert.equal(confirmedReport.cycles[0].changes.removed, 0);
  assert.equal(confirmedReport.cycles[0].lifecycle.delisted, 1);

  const wrongClosure = readinessFixture();
  wrongClosure.eventRows.push(matchingLifecycleEvent(wrongClosure, 'delisted', {
    valid_to: `${LATEST_DAY}T00:44:59.000Z`,
  }));
  assert.equal(buildCatalogShadowReadiness(wrongClosure).status, 'fail');

  const noPriorCycle = readinessFixture();
  noPriorCycle.eventRows.push(matchingLifecycleEvent(noPriorCycle, 'delisted', {
    previous_bucket_at: null,
  }));
  assert.equal(buildCatalogShadowReadiness(noPriorCycle).status, 'fail');
});

test('identity lineage violations and any later-phase rows fail without claiming market facts were checked', () => {
  const integrity = readinessFixture();
  integrity.integrityRow.overlapping_version_count = 1;
  let report = buildCatalogShadowReadiness(integrity);
  assert.equal(report.status, 'fail');
  assert.ok(report.failures.some(reason => /SCD2 validity intervals overlap/i.test(reason)));

  const laterPhase = readinessFixture();
  laterPhase.laterPhaseRow.market_fact_rows = 1;
  report = buildCatalogShadowReadiness(laterPhase);
  assert.equal(report.status, 'fail');
  assert.equal(report.scope.laterPhaseTablesConfirmedEmpty, false);
  assert.equal(report.scope.marketFactsChecked, false);
  assert.equal(report.scope.rollingMarketHistoryVerified, false);
  assert.ok(report.failures.includes('later-phase fact/analytics/publication/alert tables are not empty'));
});

test('pure readiness builder accepts the documented camelCase fixture aliases', () => {
  const report = buildCatalogShadowReadiness(readinessFixture(14, { camelCase: true }));
  assert.equal(report.status, 'pass');
  assert.equal(report.readyForPhase2, true);
});

test('read-only query bundle is fixed at nine bounded catalog-reconciliation queries', () => {
  const calls = [];
  const sql = {
    query(text, params = []) {
      calls.push({ text, params });
      return { text, params };
    },
  };
  const queries = buildCatalogShadowReadinessQueries(sql, 30);
  assert.equal(queries.length, 9);
  assert.equal(calls.length, 9);
  assert.ok(calls.every(call => /SELECT|WITH/.test(call.text)));
  assert.ok(calls.every(call => !/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(call.text)));
  assert.ok(calls.slice(0, 7).every(call => call.text.includes('rwa-listing-audit')));
  assert.ok(calls.slice(0, 7).every(call => call.text.includes('rwa-listing-catalog-pg-shadow/v1')));
  assert.deepEqual(calls[5].params[1], [...LISTING_SOURCE_KEYS].sort());
  assert.throws(() => buildCatalogShadowReadinessQueries(sql, 13), /14 through 90/);
  assert.throws(() => buildCatalogShadowReadinessQueries(sql, 91), /14 through 90/);
  assert.throws(() => buildCatalogShadowReadinessQueries(sql, 14.5), /14 through 90/);
});

test('query runner uses a Serializable read-only transaction and rejects an incomplete bundle', async () => {
  const fixture = readinessFixture();
  let transactionOptions = null;
  const report = await runCatalogShadowReadinessQueries({
    now: fixture.now,
    runtimeSnapshot: fixture.runtimeSnapshot,
    runTransaction(builder, options) {
      transactionOptions = options;
      const queries = builder({ query(text, params = []) { return { text, params }; } });
      assert.equal(queries.length, 9);
      return queryResults(fixture);
    },
  });
  assert.equal(report.status, 'pass');
  assert.deepEqual(transactionOptions, {
    isolationLevel: 'Serializable',
    readOnly: true,
    deferrable: true,
    timeoutMs: 25_000,
  });

  await assert.rejects(() => runCatalogShadowReadinessQueries({
    runtimeSnapshot: fixture.runtimeSnapshot,
    runTransaction: () => queryResults(fixture).slice(0, 8),
  }), /query bundle is incomplete/);
});

test('CLI exits zero for Warming, nonzero only for Fail, and never promotes market-history readiness', async () => {
  const cli = await readFile(new URL('../scripts/audit-catalog-shadow.mjs', import.meta.url), 'utf8');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts['audit:catalog-shadow'], 'node scripts/audit-catalog-shadow.mjs');
  assert.match(cli, /if \(report\.status === 'fail'\) process\.exitCode = 1;/);
  assert.doesNotMatch(cli, /report\.status === 'warming'[^\n]*exitCode/);
  assert.match(cli, /catch \(error\)[\s\S]*process\.exitCode = 1;/);
  assert.match(cli, /marketFactsChecked:\s*false/);
  assert.match(cli, /rollingMarketHistoryVerified:\s*false/);
  assert.doesNotMatch(cli, /readyForPhase2[^\n]*(?:write|cutover)\s*=\s*true/i);
});

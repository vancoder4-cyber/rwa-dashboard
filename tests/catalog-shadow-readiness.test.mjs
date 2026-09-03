import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { LISTING_SOURCE_KEYS } from '../api/_lib/listing-audit.js';
import {
  CATALOG_SHADOW_CAPABILITY_MINIMUMS,
  CATALOG_SHADOW_EXPECTED_SINKS,
  CATALOG_SHADOW_OPERATIONAL_POLICY,
  CATALOG_SHADOW_READINESS_SCHEMA_VERSION,
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

function readinessFixture(dayCount = CATALOG_SHADOW_OPERATIONAL_POLICY.readCutover, { camelCase = false } = {}) {
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
        raw_status: 'full',
        error_codes: [],
        review_case_count: 0,
        listing_count: 1,
        admitted_listing_count: 1,
        rejected_listing_count: 0,
        merged_status: 'full',
        withheld_from_membership: 0,
        persisted_pending_removal_count: 0,
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
        event_eligible_added_count: previousCycleId ? 0 : null,
        pending_event_added_count: 0,
        pending_review_count: 0,
        pending_identity_resolved_count: 0,
        identity_resolved_added_count: previousCycleId ? 0 : null,
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
      market_fact_rows_present: false,
      derived_analytics_rows_present: false,
      publication_rows_present: false,
      alert_rows_present: false,
    },
    runtimeSnapshot: {
      schemaVersion: 'rwa-listing-audit/v1',
      generatedAt: latestCompletedAt,
      status: 'full',
      counts: { activeListings: 10 },
      history: { truncated: false },
      persistence: {
        publicationLease: {
          mode: 'postgres-distributed-lease',
          status: 'enforced',
          enforced: true,
          ttlSeconds: 180,
        },
        readPath: {
          mode:'runtime-cache',
          source:'runtime-cache',
          reconciliation:'durable-not-requested',
          runtimeCache:{ status:'stored', observedAt:latestCompletedAt },
          durableCheckpoint:{ status:'not-requested', observedAt:null },
        },
      },
      sources: LISTING_SOURCE_KEYS.map(sourceKey => ({
        sourceKey,
        status: 'full',
        listingCount: 1,
        pendingRemovalCount: 0,
      })),
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

function rowsForDay(fixture, collection, day) {
  return fixture[collection].filter(row => (row.cycle_id ?? row.cycleId) === `cycle-${day}`);
}

function sourceForDay(fixture, day, sourceKey = LISTING_SOURCE_KEYS[0]) {
  return rowsForDay(fixture, 'sourceRows', day)
    .find(row => (row.source_key ?? row.sourceKey) === sourceKey);
}

function membershipForDay(fixture, day, sourceKey = LISTING_SOURCE_KEYS[0]) {
  return rowsForDay(fixture, 'membershipRows', day)
    .find(row => (row.source_key ?? row.sourceKey) === sourceKey);
}

function setCycleListingCount(fixture, day, sourceKey, count) {
  const source = sourceForDay(fixture, day, sourceKey);
  source.listing_count = count;
  source.admitted_listing_count = count;
  source.official_evidence_count = count;
  const membership = membershipForDay(fixture, day, sourceKey);
  membership.membership_count = count;
  membership.distinct_instrument_count = count;
  rowsForDay(fixture, 'sinkRows', day)
    .find(row => row.sink_name === 'postgres-catalog-shadow')
    .row_count = 9 + count + rowsForDay(fixture, 'eventRows', day).length;
}

function markTrustedPendingRemoval(fixture, day = LATEST_DAY, sourceKey = LISTING_SOURCE_KEYS[0]) {
  const source = sourceForDay(fixture, day, sourceKey);
  source.run_status = 'partial';
  source.catalog_status = 'partial';
  source.identity_status = 'full';
  source.raw_status = 'full';
  source.merged_status = 'partial';
  source.error_codes = ['CATALOG_PARTIAL'];
  source.withheld_from_membership = 0;
  source.persisted_pending_removal_count = 1;
  fixture.cycleRows.find(row => row.cycle_id === `cycle-${day}`).cycle_status = 'partial';
  fixture.attemptRows.find(row => row.cycle_id === `cycle-${day}`).attempt_status = 'partial';
  rowsForDay(fixture, 'changeRows', day)
    .find(row => row.source_key === sourceKey)
    .removed_count = 1;
  if (day === LATEST_DAY) {
    const publicSource = fixture.runtimeSnapshot.sources.find(row => row.sourceKey === sourceKey);
    publicSource.status = 'partial';
    publicSource.pendingRemovalCount = 1;
    fixture.runtimeSnapshot.counts.activeListings += 1;
    rowsForDay(fixture, 'sinkRows', day)
      .find(row => row.sink_name === 'runtime-cache-listing-audit')
      .row_count += 1;
  }
}

function markTrustedReviewIsolation(fixture, {
  day = LATEST_DAY,
  sourceKey = LISTING_SOURCE_KEYS[0],
  pendingRemoval = false,
} = {}) {
  const source = sourceForDay(fixture, day, sourceKey);
  source.run_status = 'partial';
  source.catalog_status = pendingRemoval ? 'partial' : 'full';
  source.identity_status = 'partial';
  source.raw_status = 'full';
  source.merged_status = pendingRemoval ? 'partial' : 'full';
  source.error_codes = [
    ...(pendingRemoval ? ['CATALOG_PARTIAL'] : []),
    'SOURCE_IDENTITY_PARTIAL',
    'IDENTITY_REVIEW_REQUIRED',
  ];
  source.rejected_listing_count = 1;
  source.review_case_count = 1;
  source.listing_count = source.admitted_listing_count + source.rejected_listing_count;
  source.withheld_from_membership = 1;
  source.persisted_pending_removal_count = pendingRemoval ? 1 : 0;
  fixture.cycleRows.find(row => row.cycle_id === `cycle-${day}`).cycle_status = 'partial';
  fixture.attemptRows.find(row => row.cycle_id === `cycle-${day}`).attempt_status = 'partial';
  if (pendingRemoval) {
    source.withheld_from_membership = 1;
    rowsForDay(fixture, 'changeRows', day)
      .find(row => row.source_key === sourceKey)
      .removed_count = 1;
  }
  if (day === LATEST_DAY) {
    const publicSource = fixture.runtimeSnapshot.sources.find(row => row.sourceKey === sourceKey);
    publicSource.status = source.merged_status;
    publicSource.listingCount += 1;
    fixture.runtimeSnapshot.counts.activeListings += 1;
    rowsForDay(fixture, 'sinkRows', day)
      .find(row => row.sink_name === 'runtime-cache-listing-audit')
      .row_count += 1;
    if (pendingRemoval) {
      publicSource.pendingRemovalCount = 1;
      fixture.runtimeSnapshot.counts.activeListings += 1;
      rowsForDay(fixture, 'sinkRows', day)
        .find(row => row.sink_name === 'runtime-cache-listing-audit')
        .row_count += 1;
    }
  }
}

function markUnavailableCycle(fixture, day, sourceKey = LISTING_SOURCE_KEYS[0]) {
  const source = sourceForDay(fixture, day, sourceKey);
  source.run_status = 'unavailable';
  source.catalog_status = 'unavailable';
  source.identity_status = 'unavailable';
  source.raw_status = 'unavailable';
  source.merged_status = 'full';
  source.error_codes = ['CATALOG_UNAVAILABLE', 'UPSTREAM_UNAVAILABLE'];
  source.listing_count = 0;
  source.admitted_listing_count = 0;
  source.rejected_listing_count = 0;
  source.review_case_count = 0;
  source.withheld_from_membership = 0;
  source.persisted_pending_removal_count = 0;
  source.stored_artifact_count = 0;
  source.official_evidence_count = 0;
  source.missing_official_evidence_count = 0;
  fixture.cycleRows.find(row => row.cycle_id === `cycle-${day}`).cycle_status = 'partial';
  fixture.attemptRows.find(row => row.cycle_id === `cycle-${day}`).attempt_status = 'partial';
  fixture.membershipRows = fixture.membershipRows.filter(row => !(
    row.cycle_id === `cycle-${day}` && row.source_key === sourceKey
  ));
  rowsForDay(fixture, 'sinkRows', day)
    .find(row => row.sink_name === 'postgres-catalog-shadow')
    .row_count = 9;
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

test('v2 exposes independent 1/2/3 capability minima and 3/7/7 operational policies', () => {
  const report = buildCatalogShadowReadiness(readinessFixture());

  assert.equal(CATALOG_SHADOW_READINESS_SCHEMA_VERSION, 'rwa-catalog-shadow-readiness/v2');
  assert.deepEqual(CATALOG_SHADOW_CAPABILITY_MINIMUMS, {
    baselineCatalog: 1,
    newListingDetection: 2,
    confirmedDelistLiveWindow: 3,
  });
  assert.deepEqual(CATALOG_SHADOW_OPERATIONAL_POLICY, {
    shadowExpansion: 3,
    requiredMode: 7,
    readCutover: 7,
  });
  assert.equal(report.schemaVersion, CATALOG_SHADOW_READINESS_SCHEMA_VERSION);
  assert.equal(report.status, 'pass');
  assert.equal(report.remediation, null);
  assert.equal(report.readyForPhase2, true);
  assert.equal(report.readyForPhase2DesignReview, true);
  assert.equal(report.capabilities.phase2DesignReview.elapsedGate, false);
  assert.equal(report.capabilities.phase2DesignReview.ready, true);
  assert.equal(report.capabilities.baselineCatalog.ready, true);
  assert.equal(report.capabilities.newListingDetection.ready, true);
  assert.equal(report.capabilities.confirmedDelistLiveWindow.ready, true);
  assert.equal(report.operations.policies.shadowExpansion.ready, true);
  assert.equal(report.operations.policies.requiredMode.ready, true);
  assert.equal(report.operations.policies.readCutover.ready, true);
  assert.equal(report.progress.evaluatedUtcCycles, 7);
  assert.equal(report.progress.healthyUtcCycles, 7);
  assert.equal(report.progress.consecutiveHealthyUtcCycles, 7);
  assert.equal(new Set(report.cycles.map(row => row.utcDay)).size, 7);
  assert.equal(report.scope.marketFactsChecked, false);
  assert.equal(report.scope.rollingMarketHistoryVerified, false);
  assert.equal(report.scope.phase2DesignElapsedGate, false);
  assert.equal(report.scope.laterPhaseTablesConfirmedEmpty, true);
  assert.match(report.decision, /design review/i);
  assert.match(report.decision, /does not enable a writer or read cutover/i);
  assert.ok(report.limitations.some(line => /No rolling market history is stored/i.test(line)));
  assert.ok(report.limitations.some(line => /does not collect or validate price, volume, OI, funding/i.test(line)));
});

test('Day 1 healthy baseline permits design review without claiming lifecycle or operational maturity', () => {
  const report = buildCatalogShadowReadiness(readinessFixture(1));
  assert.equal(report.status, 'pass');
  assert.equal(report.readyForPhase2, true);
  assert.equal(report.readyForPhase2DesignReview, true);
  assert.deepEqual(report.capabilities.baselineCatalog, {
    minimumHealthyUtcCycles: 1,
    observedHealthyUtcCycles: 1,
    totalHealthyUtcCycles: 1,
    ready: true,
    status: 'ready',
    detail: report.capabilities.baselineCatalog.detail,
  });
  assert.equal(report.capabilities.newListingDetection.ready, false);
  assert.equal(report.capabilities.newListingDetection.status, 'warming');
  assert.equal(report.capabilities.confirmedDelistLiveWindow.ready, false);
  assert.equal(report.capabilities.confirmedDelistLiveWindow.status, 'warming');
  assert.equal(report.capabilities.phase2DesignReview.elapsedGate, false);
  assert.equal(report.operations.consecutiveHealthyUtcCycles, 1);
  assert.equal(report.operations.policies.shadowExpansion.ready, false);
  assert.equal(report.operations.policies.requiredMode.ready, false);
  assert.equal(report.operations.policies.readCutover.ready, false);
  assert.ok(Object.values(report.operations.policies).every(policy => policy.policyOnly === true));
  assert.match(report.decision, /design review/i);
});

test('an empty catalog shadow reports a bounded baseline repair instead of authorizing a cutover', () => {
  const report = buildCatalogShadowReadiness({
    now: `${LATEST_DAY}T01:45:00.000Z`,
    laterPhaseRow: {
      market_fact_rows_present: false,
      derived_analytics_rows_present: false,
      publication_rows_present: false,
      alert_rows_present: false,
    },
  });
  assert.equal(report.status, 'warming');
  assert.equal(report.readyForPhase2, false);
  assert.equal(report.remediation.code, 'ESTABLISH_CATALOG_BASELINE');
  assert.ok(report.remediation.actions.some(action => /authenticated listing-audit Cron/.test(action)));
});

test('a Runtime Cache warming baseline does not require lifecycle events from older PostgreSQL membership', () => {
  const fixture = readinessFixture(2);
  for (const source of latestRows(fixture, 'sourceRows')) source.merged_status = 'warming';
  for (const source of fixture.runtimeSnapshot.sources) source.status = 'warming';
  for (const change of latestRows(fixture, 'changeRows')) {
    change.added_count = 1;
    change.event_eligible_added_count = 0;
    change.identity_resolved_added_count = 0;
  }

  const report = buildCatalogShadowReadiness(fixture);
  assert.equal(report.status, 'pass');
  assert.equal(report.cycles[0].changes.added, LISTING_SOURCE_KEYS.length);
  assert.equal(report.cycles[0].changes.eventEligibleAdded, 0);
  assert.equal(report.cycles[0].lifecycle.total, 0);
});

test('new-listing and confirmed-delist capabilities require exact 2- and 3-cycle comparison windows', () => {
  let report = buildCatalogShadowReadiness(readinessFixture(2));
  assert.equal(report.status, 'pass');
  assert.equal(report.capabilities.newListingDetection.ready, true);
  assert.equal(report.capabilities.newListingDetection.observedHealthyUtcCycles, 2);
  assert.equal(report.capabilities.confirmedDelistLiveWindow.ready, false);

  report = buildCatalogShadowReadiness(readinessFixture(3));
  assert.equal(report.status, 'pass');
  assert.equal(report.capabilities.confirmedDelistLiveWindow.ready, true);
  assert.match(report.capabilities.confirmedDelistLiveWindow.detail, /does not claim|real delist/i);
  assert.equal(report.operations.policies.shadowExpansion.ready, true);
  assert.equal(report.operations.policies.requiredMode.ready, false);

  const incompleteComparison = readinessFixture(2);
  latestRows(incompleteComparison, 'changeRows')[0].previous_cycle_id = null;
  report = buildCatalogShadowReadiness(incompleteComparison);
  assert.equal(report.status, 'fail');
  assert.equal(report.capabilities.newListingDetection.ready, false);
  assert.equal(report.capabilities.newListingDetection.status, 'blocked');
  assert.ok(report.cycles[0].reasons.some(reason => /comparison is incomplete across sources/.test(reason)));
});

test('same cycle retry is deduplicated, while a second attempt or second cycle on one UTC day fails', () => {
  const retry = readinessFixture(1);
  retry.cycleRows.push({ ...retry.cycleRows.at(-1) });
  let report = buildCatalogShadowReadiness(retry);
  assert.equal(report.status, 'pass');
  assert.equal(report.progress.evaluatedUtcCycles, 1);

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

  const duplicateDay = readinessFixture(1);
  duplicateDay.cycleRows.push({
    ...duplicateDay.cycleRows.at(-1),
    cycle_id: 'different-cycle-same-utc-day',
  });
  report = buildCatalogShadowReadiness(duplicateDay);
  assert.equal(report.status, 'fail');
  assert.ok(report.failures.includes('duplicate UTC collection cycles exist'));
});

test('calendar gaps reset only operational streaks while a healthy current catalog still passes', () => {
  const fixture = readinessFixture(4);
  const removedCycleId = fixture.cycleRows.at(-2).cycle_id;
  fixture.cycleRows = fixture.cycleRows.filter(row => row.cycle_id !== removedCycleId);
  for (const key of ['attemptRows', 'sourceRows', 'membershipRows', 'sinkRows', 'changeRows', 'eventRows']) {
    fixture[key] = fixture[key].filter(row => row.cycle_id !== removedCycleId);
  }
  const report = buildCatalogShadowReadiness(fixture);
  assert.equal(report.status, 'pass');
  assert.equal(report.readyForPhase2DesignReview, true);
  assert.equal(report.capabilities.baselineCatalog.ready, true);
  assert.equal(report.capabilities.newListingDetection.ready, false);
  assert.equal(report.capabilities.newListingDetection.status, 'warming');
  assert.equal(report.capabilities.newListingDetection.observedHealthyUtcCycles, 1);
  assert.equal(report.capabilities.newListingDetection.totalHealthyUtcCycles, 3);
  assert.equal(report.capabilities.confirmedDelistLiveWindow.ready, false);
  assert.equal(report.capabilities.confirmedDelistLiveWindow.status, 'warming');
  assert.equal(report.operations.gapReset, true);
  assert.equal(report.operations.consecutiveHealthyUtcCycles, 1);
  assert.equal(report.operations.policies.shadowExpansion.ready, false);
  assert.equal(report.checks.find(row => row.id === 'utc-cycle-continuity').status, 'warming');
  assert.equal(report.failures.includes('the evaluated UTC cycle window has calendar gaps'), false);
  assert.ok(report.notices.some(notice => /operational continuity reset by UTC gaps/.test(notice)));
});

test('a historical infrastructure failure resets policy streaks without invalidating the current healthy catalog', () => {
  const fixture = readinessFixture(4);
  rowsForDay(fixture, 'sinkRows', isoDay(-1))
    .find(row => row.sink_name === 'blob-normalized-catalog')
    .sink_status = 'failed';
  const report = buildCatalogShadowReadiness(fixture);
  assert.equal(report.status, 'pass');
  assert.equal(report.readyForPhase2DesignReview, true);
  assert.equal(report.progress.currentCycleHealthy, true);
  assert.equal(report.capabilities.baselineCatalog.ready, true);
  assert.equal(report.capabilities.newListingDetection.ready, false);
  assert.equal(report.capabilities.newListingDetection.observedHealthyUtcCycles, 1);
  assert.equal(report.capabilities.confirmedDelistLiveWindow.ready, false);
  assert.equal(report.operations.gapReset, true);
  assert.equal(report.operations.consecutiveHealthyUtcCycles, 1);
  assert.equal(report.operations.policies.shadowExpansion.ready, false);
  assert.equal(report.failures.length, 0);
  assert.ok(report.notices.some(notice => /historical failed cycle/.test(notice)));

  const recovered = readinessFixture(4);
  rowsForDay(recovered, 'sinkRows', isoDay(-3))
    .find(row => row.sink_name === 'blob-normalized-catalog')
    .sink_status = 'failed';
  const recoveredReport = buildCatalogShadowReadiness(recovered);
  assert.equal(recoveredReport.status, 'pass');
  assert.equal(recoveredReport.operations.consecutiveHealthyUtcCycles, 3);
  assert.equal(recoveredReport.capabilities.newListingDetection.observedHealthyUtcCycles, 3);
  assert.equal(recoveredReport.capabilities.newListingDetection.ready, true);
  assert.equal(recoveredReport.capabilities.confirmedDelistLiveWindow.ready, true);
  assert.equal(recoveredReport.operations.policies.shadowExpansion.ready, true);
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
  const cacheCountReport = buildCatalogShadowReadiness(cacheCountMismatch);
  assert.equal(cacheCountReport.status, 'fail');
  assert.equal(cacheCountReport.remediation.code, 'REBUILD_RUNTIME_CACHE_BASELINE');
  assert.ok(cacheCountReport.remediation.actions.some(action => /Do not synthesize New\/Re-listed/.test(action)));

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

  const databaseFallback = readinessFixture();
  Object.assign(databaseFallback.runtimeSnapshot.persistence.readPath, {
    mode:'durable-fallback',
    source:'postgres-checkpoint',
    reconciliation:'runtime-empty',
    runtimeCache:{ status:'empty', observedAt:null },
    durableCheckpoint:{ status:'stored', observedAt:databaseFallback.runtimeSnapshot.generatedAt },
  });
  const fallbackReport = buildCatalogShadowReadiness(databaseFallback);
  assert.equal(fallbackReport.status, 'fail');
  assert.ok(fallbackReport.runtimeCache.reasons.some(reason => /not served from the stored Runtime Cache/.test(reason)));

  const matchedDurableReplica = readinessFixture();
  Object.assign(matchedDurableReplica.runtimeSnapshot.persistence.readPath, {
    mode:'durable-fallback',
    source:'runtime-cache',
    reconciliation:'match',
    durableCheckpoint:{ status:'stored', observedAt:matchedDurableReplica.runtimeSnapshot.generatedAt },
  });
  assert.equal(buildCatalogShadowReadiness(matchedDurableReplica).status, 'pass');
});

test('missing source counts, normalized artifacts, or exact official evidence never pass readiness', () => {
  const cases = [
    ['listing_count', null],
    ['admitted_listing_count', null],
    ['rejected_listing_count', null],
    ['review_case_count', null],
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

test('Runtime Cache readiness requires the exact enforced PostgreSQL publication lease contract', () => {
  const cases = [
    ['missing', snapshot => { delete snapshot.persistence; }],
    ['degraded', snapshot => {
      snapshot.persistence.publicationLease.status = 'degraded';
      snapshot.persistence.publicationLease.enforced = false;
    }],
    ['off', snapshot => {
      snapshot.persistence.publicationLease = {
        mode: 'off', status: 'off', enforced: false, ttlSeconds: 180,
      };
    }],
    ['wrong ttl', snapshot => { snapshot.persistence.publicationLease.ttlSeconds = 179; }],
  ];
  for (const [label, mutate] of cases) {
    const fixture = readinessFixture();
    mutate(fixture.runtimeSnapshot);
    const report = buildCatalogShadowReadiness(fixture);
    assert.equal(report.status, 'fail', label);
    assert.equal(report.readyForPhase2, false, label);
    assert.equal(report.runtimeCache.match, false, label);
    assert.ok(
      report.runtimeCache.reasons.some(reason => /180-second PostgreSQL lease/.test(reason)),
      `${label}: ${JSON.stringify(report.runtimeCache.reasons)}`,
    );
  }
});

test('first baseline with no lifecycle event is valid and ready only for baseline/design capability', () => {
  const report = buildCatalogShadowReadiness(readinessFixture(1));
  assert.equal(report.status, 'pass');
  assert.equal(report.readyForPhase2DesignReview, true);
  assert.equal(report.capabilities.baselineCatalog.ready, true);
  assert.equal(report.capabilities.newListingDetection.ready, false);
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
    change.event_eligible_added_count = 1;
    setLatestListingCount(fixture, LISTING_SOURCE_KEYS[0], 2);
    fixture.eventRows.push(matchingLifecycleEvent(fixture, eventType));
    setLatestPostgresRows(fixture, 12);
    const report = buildCatalogShadowReadiness(fixture);
    assert.equal(report.status, 'pass', `${eventType}: ${JSON.stringify({ failures: report.failures, reasons: report.cycles[0].reasons })}`);
    assert.equal(report.cycles[0].changes.added, 1);
    assert.equal(report.cycles[0].changes.eventEligibleAdded, 1);
    assert.equal(report.cycles[0].lifecycle[eventType], 1);
  }

  const missingEvent = readinessFixture();
  latestRows(missingEvent, 'changeRows')[0].added_count = 1;
  latestRows(missingEvent, 'changeRows')[0].event_eligible_added_count = 1;
  setLatestListingCount(missingEvent, LISTING_SOURCE_KEYS[0], 2);
  assert.equal(buildCatalogShadowReadiness(missingEvent).status, 'fail');

  const extraEvent = readinessFixture();
  extraEvent.eventRows.push(matchingLifecycleEvent(extraEvent, 'listed'));
  assert.equal(buildCatalogShadowReadiness(extraEvent).status, 'fail');
});

test('same UTC-day retry keeps a first-run New version event-eligible after source completion time advances', () => {
  const fixture = readinessFixture(2);
  const sourceKey = LISTING_SOURCE_KEYS[0];
  const change = latestRows(fixture, 'changeRows').find(row => row.source_key === sourceKey);
  change.added_count = 1;
  change.event_eligible_added_count = 1;
  change.cycle_bucket_at = `${LATEST_DAY}T00:00:00.000Z`;
  change.source_observed_at = `${LATEST_DAY}T01:15:00.000Z`;
  setLatestListingCount(fixture, sourceKey, 2);
  fixture.eventRows.push(matchingLifecycleEvent(fixture, 'listed', {
    observed_at: `${LATEST_DAY}T00:45:00.000Z`,
    valid_from: `${LATEST_DAY}T00:45:00.000Z`,
  }));
  setLatestPostgresRows(fixture, 12);

  const retryCompletedAt = `${LATEST_DAY}T01:15:00.000Z`;
  fixture.attemptRows.find(row => row.cycle_id === `cycle-${LATEST_DAY}`).attempt_completed_at = retryCompletedAt;
  fixture.runtimeSnapshot.generatedAt = retryCompletedAt;
  fixture.runtimeSnapshot.persistence.readPath.runtimeCache.observedAt = retryCompletedAt;
  latestRows(fixture, 'sinkRows')
    .find(row => row.sink_name === 'runtime-cache-listing-audit')
    .committed_at = retryCompletedAt;

  const report = buildCatalogShadowReadiness(fixture);
  assert.equal(report.status, 'pass');
  assert.equal(report.cycles[0].attempts.count, 1);
  assert.equal(report.cycles[0].changes.added, 1);
  assert.equal(report.cycles[0].changes.eventEligibleAdded, 1);
  assert.equal(report.cycles[0].lifecycle.listed, 1);
});

test('a same-day New that becomes pending remains an exact lifecycle event without entering current membership', () => {
  const fixture = readinessFixture(3);
  const sourceKey = LISTING_SOURCE_KEYS[0];
  markTrustedPendingRemoval(fixture, LATEST_DAY, sourceKey);
  const change = latestRows(fixture, 'changeRows').find(row => row.source_key === sourceKey);
  change.added_count = 0;
  change.removed_count = 0;
  change.pending_event_added_count = 1;
  change.event_eligible_added_count = 1;
  fixture.eventRows.push(matchingLifecycleEvent(fixture, 'listed'));
  setLatestPostgresRows(fixture, 11);

  const report = buildCatalogShadowReadiness(fixture);
  assert.equal(report.status, 'pass', JSON.stringify(report.cycles[0].reasons));
  const latest = report.cycles[0];
  assert.equal(latest.healthStatus, 'trusted-pending-removal');
  assert.equal(latest.changes.added, 0);
  assert.equal(latest.changes.removed, 0);
  assert.equal(latest.changes.pendingEventAdded, 1);
  assert.equal(latest.changes.eventEligibleAdded, 1);
  assert.equal(latest.lifecycle.listed, 1);
  assert.equal(findLatestSource(fixture, sourceKey).persisted_pending_removal_count, 1);
  assert.equal(fixture.runtimeSnapshot.sources[0].pendingRemovalCount, 1);
});

test('a verified sibling plus one same-day pending New conserves membership, event, and Runtime cohorts independently', () => {
  const fixture = readinessFixture(3);
  const sourceKey = LISTING_SOURCE_KEYS[0];
  setLatestListingCount(fixture, sourceKey, 2);
  markTrustedPendingRemoval(fixture, LATEST_DAY, sourceKey);
  const change = latestRows(fixture, 'changeRows').find(row => row.source_key === sourceKey);
  change.added_count = 1;
  change.removed_count = 0;
  change.pending_event_added_count = 1;
  change.event_eligible_added_count = 2;
  fixture.eventRows.push(
    matchingLifecycleEvent(fixture, 'listed', { catalog_change_event_id:'event-listed-current-sibling' }),
    matchingLifecycleEvent(fixture, 'listed', { catalog_change_event_id:'event-listed-pending-new' }),
  );
  setLatestPostgresRows(fixture, 13);

  const report = buildCatalogShadowReadiness(fixture);
  assert.equal(report.status, 'pass', JSON.stringify(report.cycles[0].reasons));
  const latest = report.cycles[0];
  assert.deepEqual(
    latest.changes.sources.find(row => row.sourceKey === sourceKey),
    {
      sourceKey,
      comparable: true,
      added: 1,
      removed: 0,
      eventEligibleAdded: 2,
      pendingEventAdded: 1,
      pendingReview: 0,
      pendingIdentityResolved: 0,
      identityResolvedAdded: 0,
    },
  );
  assert.equal(latest.lifecycle.listed, 2);
  assert.equal(findLatestMembership(fixture, sourceKey).membership_count, 2);
  assert.equal(fixture.runtimeSnapshot.counts.activeListings, 12);
});

test('Day 1 baseline accepts trusted pending and isolated review cohorts without inventing lifecycle history', () => {
  const pending = readinessFixture(1);
  const sourceKey = LISTING_SOURCE_KEYS[0];
  markTrustedPendingRemoval(pending, LATEST_DAY, sourceKey);
  const pendingChange = latestRows(pending, 'changeRows').find(row => row.source_key === sourceKey);
  pendingChange.removed_count = null;
  const pendingReport = buildCatalogShadowReadiness(pending);
  assert.equal(pendingReport.status, 'pass', JSON.stringify(pendingReport.cycles[0].reasons));
  assert.equal(pendingReport.cycles[0].changes.comparableSources, 0);
  assert.equal(pendingReport.cycles[0].changes.pendingEventAdded, 0);
  assert.equal(pendingReport.cycles[0].changes.pendingReview, 0);
  assert.equal(pendingReport.cycles[0].changes.pendingIdentityResolved, 0);
  assert.equal(pendingReport.cycles[0].lifecycle.total, 0);
  assert.equal(pendingReport.runtimeCache.match, true);
  assert.equal(pendingReport.runtimeCache.sources[0].pendingRemovalCount, 1);

  const review = readinessFixture(1);
  markTrustedReviewIsolation(review, { sourceKey });
  const reviewReport = buildCatalogShadowReadiness(review);
  assert.equal(reviewReport.status, 'pass', JSON.stringify(reviewReport.cycles[0].reasons));
  assert.equal(reviewReport.cycles[0].healthStatus, 'trusted-review-isolation');
  assert.equal(reviewReport.cycles[0].changes.comparableSources, 0);
  assert.equal(reviewReport.cycles[0].lifecycle.total, 0);
  assert.equal(reviewReport.runtimeCache.match, true);
});

test('review-required to pending to confirmed disappearance or recovery stays outside accepted lifecycle events', () => {
  const sourceKey = LISTING_SOURCE_KEYS[0];
  const reviewDay = isoDay(-2);
  const pendingDay = isoDay(-1);

  const buildSequence = () => {
    const fixture = readinessFixture(3);
    markTrustedReviewIsolation(fixture, { day:reviewDay, sourceKey });
    markTrustedPendingRemoval(fixture, pendingDay, sourceKey);
    const pendingChange = rowsForDay(fixture, 'changeRows', pendingDay)
      .find(row => row.source_key === sourceKey);
    pendingChange.removed_count = 0;
    pendingChange.pending_review_count = 1;
    return fixture;
  };

  const confirmed = buildSequence();
  let report = buildCatalogShadowReadiness(confirmed);
  assert.equal(report.status, 'pass', JSON.stringify(report.cycles.flatMap(row => row.reasons)));
  const confirmedPendingCycle = report.cycles.find(row => row.utcDay === pendingDay);
  assert.equal(confirmedPendingCycle.healthStatus, 'trusted-pending-removal');
  assert.equal(confirmedPendingCycle.changes.pendingReview, 1);
  assert.equal(confirmedPendingCycle.changes.removed, 0);
  assert.equal(confirmedPendingCycle.lifecycle.total, 0);
  assert.equal(report.cycles[0].pendingRemoval.active, false);
  assert.equal(report.cycles[0].lifecycle.total, 0);

  const recovered = buildSequence();
  markTrustedReviewIsolation(recovered, { sourceKey });
  report = buildCatalogShadowReadiness(recovered);
  assert.equal(report.status, 'pass', JSON.stringify(report.cycles.flatMap(row => row.reasons)));
  assert.equal(report.cycles[0].healthStatus, 'trusted-review-isolation');
  assert.equal(report.cycles[0].changes.added, 0);
  assert.equal(report.cycles[0].changes.eventEligibleAdded, 0);
  assert.equal(report.cycles[0].changes.identityResolvedAdded, 0);
  assert.equal(report.cycles[0].lifecycle.total, 0);
});

test('review resolution is an identity addition, never a synthetic listed lifecycle event', () => {
  const fixture = readinessFixture(2);
  const sourceKey = LISTING_SOURCE_KEYS[0];
  markTrustedReviewIsolation(fixture, { day:isoDay(-1), sourceKey });
  setLatestListingCount(fixture, sourceKey, 2);
  const change = latestRows(fixture, 'changeRows').find(row => row.source_key === sourceKey);
  change.added_count = 1;
  change.event_eligible_added_count = 0;
  change.identity_resolved_added_count = 1;
  setLatestPostgresRows(fixture, 11);

  const report = buildCatalogShadowReadiness(fixture);
  assert.equal(report.status, 'pass', JSON.stringify(report.cycles[0].reasons));
  const sourceChange = report.cycles[0].changes.sources.find(row => row.sourceKey === sourceKey);
  assert.equal(sourceChange.added, 1);
  assert.equal(sourceChange.identityResolvedAdded, 1);
  assert.equal(sourceChange.eventEligibleAdded, 0);
  assert.equal(report.cycles[0].lifecycle.listed, 0);
  assert.equal(report.cycles[0].lifecycle.relisted, 0);
  assert.equal(report.cycles[0].membership.rows, 11);
});

test('review resolved and then pending in the same UTC day is conserved only as pendingIdentityResolved', () => {
  const fixture = readinessFixture(2);
  const sourceKey = LISTING_SOURCE_KEYS[0];
  markTrustedReviewIsolation(fixture, { day:isoDay(-1), sourceKey });
  markTrustedPendingRemoval(fixture, LATEST_DAY, sourceKey);
  const change = latestRows(fixture, 'changeRows').find(row => row.source_key === sourceKey);
  change.added_count = 0;
  change.removed_count = 0;
  change.event_eligible_added_count = 0;
  change.pending_identity_resolved_count = 1;

  const report = buildCatalogShadowReadiness(fixture);
  assert.equal(report.status, 'pass', JSON.stringify(report.cycles[0].reasons));
  const sourceChange = report.cycles[0].changes.sources.find(row => row.sourceKey === sourceKey);
  assert.equal(sourceChange.pendingIdentityResolved, 1);
  assert.equal(sourceChange.pendingReview, 0);
  assert.equal(sourceChange.pendingEventAdded, 0);
  assert.equal(sourceChange.identityResolvedAdded, 0);
  assert.equal(report.cycles[0].lifecycle.total, 0);
  assert.equal(report.runtimeCache.sources[0].pendingRemovalCount, 1);
});

test('per-source lifecycle conservation rejects cross-source cancellation even when global totals match', () => {
  const fixture = readinessFixture();
  const sourceA = LISTING_SOURCE_KEYS[0];
  const sourceB = LISTING_SOURCE_KEYS[1];
  const sourceAChange = latestRows(fixture, 'changeRows').find(row => row.source_key === sourceA);
  sourceAChange.added_count = 1;
  sourceAChange.event_eligible_added_count = 1;
  setLatestListingCount(fixture, sourceA, 2);
  fixture.eventRows.push(matchingLifecycleEvent(fixture, 'listed', { source_key: sourceB }));
  setLatestPostgresRows(fixture, 12);

  const report = buildCatalogShadowReadiness(fixture);
  const latest = report.cycles[0];
  assert.equal(latest.changes.added, 1);
  assert.equal(latest.changes.eventEligibleAdded, 1);
  assert.equal(latest.lifecycle.listed, 1);
  assert.equal(report.status, 'fail');
  assert.equal(report.readyForPhase2, false);
  assert.ok(latest.reasons.some(reason => reason.startsWith(`${sourceA} accepted membership additions`)));
  assert.ok(latest.reasons.some(reason => reason.startsWith(`${sourceB} accepted membership additions`)));
  assert.deepEqual(
    latest.changes.sources.find(row => row.sourceKey === sourceA),
    {
      sourceKey: sourceA,
      comparable: true,
      added: 1,
      eventEligibleAdded: 1,
      pendingEventAdded: 0,
      pendingReview: 0,
      pendingIdentityResolved: 0,
      identityResolvedAdded: 0,
      removed: 0,
    },
  );
  assert.deepEqual(
    latest.changes.sources.find(row => row.sourceKey === sourceB),
    {
      sourceKey: sourceB,
      comparable: true,
      added: 0,
      eventEligibleAdded: 0,
      pendingEventAdded: 0,
      pendingReview: 0,
      pendingIdentityResolved: 0,
      identityResolvedAdded: 0,
      removed: 0,
    },
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

test('trusted pending-removal Partial stays infrastructure healthy and does not reset operational continuity', () => {
  const pending = readinessFixture(3);
  markTrustedPendingRemoval(pending);
  const report = buildCatalogShadowReadiness(pending);
  assert.equal(report.status, 'pass');
  assert.equal(report.readyForPhase2DesignReview, true);
  assert.equal(report.cycles[0].infrastructureHealthy, true);
  assert.equal(report.cycles[0].healthStatus, 'trusted-pending-removal');
  assert.deepEqual(report.cycles[0].pendingRemoval, {
    active: true,
    count: 1,
    sources: [LISTING_SOURCE_KEYS[0]],
  });
  assert.equal(report.cycles[0].sourceRuns.trusted, LISTING_SOURCE_KEYS.length);
  assert.equal(report.cycles[0].sourceRuns.trustedPendingRemoval, 1);
  assert.equal(report.cycles[0].changes.removed, 1);
  assert.equal(report.cycles[0].lifecycle.delisted, 0);
  assert.equal(report.operations.consecutiveHealthyUtcCycles, 3);
  assert.equal(report.operations.gapReset, false);
  assert.equal(report.operations.policies.shadowExpansion.ready, true);
  assert.equal(findLatestSource(pending).withheld_from_membership, 0);
  assert.equal(pending.runtimeSnapshot.sources[0].listingCount, 1);
  assert.equal(pending.runtimeSnapshot.sources[0].pendingRemovalCount, 1);
  assert.equal(pending.runtimeSnapshot.counts.activeListings, 11);
  assert.ok(report.notices.some(notice => /trusted pending removals/.test(notice)));
});

test('review-required candidates stay isolated while verified siblings keep the infrastructure streak healthy', () => {
  const reviewOnly = readinessFixture(3);
  markTrustedReviewIsolation(reviewOnly);
  let report = buildCatalogShadowReadiness(reviewOnly);
  assert.equal(report.status, 'pass');
  assert.equal(report.cycles[0].infrastructureHealthy, true);
  assert.equal(report.cycles[0].healthStatus, 'trusted-review-isolation');
  assert.equal(report.cycles[0].sourceRuns.trustedReviewIsolation, 1);
  assert.equal(report.cycles[0].sourceRuns.trusted, LISTING_SOURCE_KEYS.length);
  assert.equal(report.cycles[0].membership.rows, LISTING_SOURCE_KEYS.length);
  assert.equal(report.cycles[0].sourceRuns.sources.find(row => row.sourceKey === LISTING_SOURCE_KEYS[0]).reviewCaseCount, 1);
  assert.equal(report.operations.consecutiveHealthyUtcCycles, 3);
  assert.equal(report.operations.gapReset, false);
  assert.equal(reviewOnly.runtimeSnapshot.sources[0].listingCount, 2);
  assert.equal(reviewOnly.runtimeSnapshot.sources[0].pendingRemovalCount, 0);
  assert.equal(reviewOnly.runtimeSnapshot.counts.activeListings, 11);

  const reviewAndPending = readinessFixture(3);
  markTrustedReviewIsolation(reviewAndPending, { pendingRemoval: true });
  report = buildCatalogShadowReadiness(reviewAndPending);
  assert.equal(report.status, 'pass');
  assert.equal(report.cycles[0].infrastructureHealthy, true);
  assert.equal(report.cycles[0].healthStatus, 'trusted-pending-removal-review-isolation');
  assert.equal(report.cycles[0].sourceRuns.trustedPendingRemoval, 1);
  assert.equal(report.cycles[0].sourceRuns.trustedReviewIsolation, 1);
  assert.equal(report.operations.consecutiveHealthyUtcCycles, 3);
  assert.equal(reviewAndPending.runtimeSnapshot.sources[0].listingCount, 2);
  assert.equal(reviewAndPending.runtimeSnapshot.sources[0].pendingRemovalCount, 1);
  assert.equal(reviewAndPending.runtimeSnapshot.counts.activeListings, 12);
});

test('pending-removal Runtime counts are explicit, non-negative, exact, and forbidden on non-pending sources', () => {
  const invalidPendingCases = [
    ['missing', publicSource => { delete publicSource.pendingRemovalCount; }],
    ['negative', publicSource => { publicSource.pendingRemovalCount = -1; }],
    ['zero', publicSource => { publicSource.pendingRemovalCount = 0; }],
    ['different from removed change', publicSource => { publicSource.pendingRemovalCount = 2; }],
  ];
  for (const [label, mutate] of invalidPendingCases) {
    const fixture = readinessFixture(3);
    markTrustedPendingRemoval(fixture);
    mutate(fixture.runtimeSnapshot.sources[0]);
    const report = buildCatalogShadowReadiness(fixture);
    assert.equal(report.status, 'fail', label);
    assert.ok(report.runtimeCache.reasons.some(reason => /pending.removal/i.test(reason)), label);
  }

  const changeMismatch = readinessFixture(3);
  markTrustedPendingRemoval(changeMismatch);
  latestRows(changeMismatch, 'changeRows')[0].removed_count = 0;
  let report = buildCatalogShadowReadiness(changeMismatch);
  assert.equal(report.status, 'fail');
  assert.ok(report.runtimeCache.reasons.some(reason => /pending.removal/i.test(reason)));

  const nonPending = readinessFixture(3);
  nonPending.runtimeSnapshot.sources[0].pendingRemovalCount = 1;
  nonPending.runtimeSnapshot.counts.activeListings += 1;
  latestRows(nonPending, 'sinkRows')
    .find(row => row.sink_name === 'runtime-cache-listing-audit')
    .row_count += 1;
  report = buildCatalogShadowReadiness(nonPending);
  assert.equal(report.status, 'fail');
  assert.ok(report.runtimeCache.reasons.some(reason => /pending.removal/i.test(reason)));
});

test('upstream and identity-normalization failures are never reclassified as trusted review isolation', () => {
  for (const extraError of ['UPSTREAM_UNAVAILABLE', 'IDENTITY_NORMALIZATION_REJECTED']) {
    const fixture = readinessFixture(3);
    markTrustedReviewIsolation(fixture);
    findLatestSource(fixture).error_codes.push(extraError);
    const report = buildCatalogShadowReadiness(fixture);
    assert.equal(report.status, 'fail', extraError);
    assert.equal(report.readyForPhase2DesignReview, false, extraError);
    assert.equal(report.cycles[0].infrastructureHealthy, false, extraError);
    assert.equal(report.cycles[0].sourceRuns.sources.find(row => row.sourceKey === LISTING_SOURCE_KEYS[0]).healthStatus, 'failed', extraError);
  }

  const reviewCountMismatch = readinessFixture(3);
  markTrustedReviewIsolation(reviewCountMismatch);
  findLatestSource(reviewCountMismatch).review_case_count = 0;
  const mismatchReport = buildCatalogShadowReadiness(reviewCountMismatch);
  assert.equal(mismatchReport.status, 'fail');
  assert.equal(mismatchReport.cycles[0].infrastructureHealthy, false);
});

test('D0 present, D1 trusted pending removal, and D2 confirmation preserve the live delist state machine', () => {
  const confirmed = readinessFixture(3);
  const day0 = isoDay(-2);
  const day1 = isoDay(-1);
  setCycleListingCount(confirmed, day0, LISTING_SOURCE_KEYS[0], 2);
  markTrustedPendingRemoval(confirmed, day1);
  confirmed.eventRows.push(matchingLifecycleEvent(confirmed, 'delisted', {
    valid_from: `${day0}T00:45:00.000Z`,
  }));
  setLatestPostgresRows(confirmed, 11);
  const confirmedReport = buildCatalogShadowReadiness(confirmed);
  assert.equal(confirmedReport.status, 'pass');
  assert.equal(confirmedReport.capabilities.confirmedDelistLiveWindow.ready, true);
  const pendingCycle = confirmedReport.cycles.find(row => row.utcDay === day1);
  assert.equal(pendingCycle.infrastructureHealthy, true);
  assert.equal(pendingCycle.healthStatus, 'trusted-pending-removal');
  assert.equal(pendingCycle.changes.removed, 1);
  assert.equal(pendingCycle.lifecycle.delisted, 0);
  assert.equal(confirmedReport.cycles[0].changes.removed, 0);
  assert.equal(confirmedReport.cycles[0].lifecycle.delisted, 1);
  assert.equal(confirmedReport.operations.consecutiveHealthyUtcCycles, 3);

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

test('D0 present, D1 pending, and D2 restored old open version does not synthesize a listed or relisted event', () => {
  const fixture = readinessFixture(3);
  const day0 = isoDay(-2);
  const day1 = isoDay(-1);
  const sourceKey = LISTING_SOURCE_KEYS[0];
  setCycleListingCount(fixture, day0, sourceKey, 2);
  markTrustedPendingRemoval(fixture, day1, sourceKey);
  setLatestListingCount(fixture, sourceKey, 2);
  const restored = latestRows(fixture, 'changeRows').find(row => row.source_key === sourceKey);
  restored.added_count = 1;
  restored.event_eligible_added_count = 0;
  setLatestPostgresRows(fixture, 11);

  const report = buildCatalogShadowReadiness(fixture);
  assert.equal(report.status, 'pass');
  assert.equal(report.readyForPhase2DesignReview, true);
  assert.equal(report.cycles[0].changes.added, 1);
  assert.equal(report.cycles[0].changes.eventEligibleAdded, 0);
  assert.equal(report.cycles[0].lifecycle.listed, 0);
  assert.equal(report.cycles[0].lifecycle.relisted, 0);
  assert.deepEqual(
    report.cycles[0].changes.sources.find(row => row.sourceKey === sourceKey),
    {
      sourceKey,
      comparable: true,
      added: 1,
      eventEligibleAdded: 0,
      pendingEventAdded: 0,
      pendingReview: 0,
      pendingIdentityResolved: 0,
      identityResolvedAdded: 0,
      removed: 0,
    },
  );
  assert.equal(report.cycles.find(row => row.utcDay === day1).healthStatus, 'trusted-pending-removal');
});

test('restoring an old version plus one distinct new listing conserves raw additions separately from event-eligible additions', () => {
  const fixture = readinessFixture(3);
  const day0 = isoDay(-2);
  const day1 = isoDay(-1);
  const sourceKey = LISTING_SOURCE_KEYS[0];
  setCycleListingCount(fixture, day0, sourceKey, 2);
  markTrustedPendingRemoval(fixture, day1, sourceKey);
  setLatestListingCount(fixture, sourceKey, 3);
  const mixed = latestRows(fixture, 'changeRows').find(row => row.source_key === sourceKey);
  mixed.added_count = 2;
  mixed.event_eligible_added_count = 1;
  fixture.eventRows.push(matchingLifecycleEvent(fixture, 'listed'));
  setLatestPostgresRows(fixture, 13);

  const report = buildCatalogShadowReadiness(fixture);
  assert.equal(report.status, 'pass');
  assert.equal(report.cycles[0].changes.added, 2);
  assert.equal(report.cycles[0].changes.eventEligibleAdded, 1);
  assert.equal(report.cycles[0].lifecycle.listed, 1);
  assert.equal(report.cycles[0].lifecycle.relisted, 0);
});

test('an unavailable prior cycle can recover old open versions without listing events and restarts continuity', () => {
  const fixture = readinessFixture(3);
  const day0 = isoDay(-2);
  const day1 = isoDay(-1);
  const sourceKey = LISTING_SOURCE_KEYS[0];
  setCycleListingCount(fixture, day0, sourceKey, 2);
  markUnavailableCycle(fixture, day1, sourceKey);
  rowsForDay(fixture, 'changeRows', day1)
    .find(row => row.source_key === sourceKey)
    .removed_count = 2;
  setLatestListingCount(fixture, sourceKey, 2);
  const restored = latestRows(fixture, 'changeRows').find(row => row.source_key === sourceKey);
  restored.added_count = 2;
  restored.event_eligible_added_count = 0;
  setLatestPostgresRows(fixture, 11);

  const report = buildCatalogShadowReadiness(fixture);
  assert.equal(report.status, 'pass');
  assert.equal(report.readyForPhase2DesignReview, true);
  assert.equal(report.cycles[0].changes.added, 2);
  assert.equal(report.cycles[0].changes.eventEligibleAdded, 0);
  assert.equal(report.cycles[0].lifecycle.total, 0);
  assert.equal(report.operations.consecutiveHealthyUtcCycles, 1);
  assert.equal(report.capabilities.newListingDetection.ready, false);
  assert.equal(report.capabilities.confirmedDelistLiveWindow.ready, false);
  assert.ok(report.notices.some(notice => /historical failed cycle/.test(notice)));
});

test('identity lineage violations fail, while later-phase rows are a non-blocking handoff observation', () => {
  const integrity = readinessFixture();
  integrity.integrityRow.overlapping_version_count = 1;
  let report = buildCatalogShadowReadiness(integrity);
  assert.equal(report.status, 'fail');
  assert.ok(report.failures.some(reason => /SCD2 validity intervals overlap/i.test(reason)));

  const laterPhase = readinessFixture();
  laterPhase.laterPhaseRow.market_fact_rows_present = true;
  report = buildCatalogShadowReadiness(laterPhase);
  assert.equal(report.status, 'pass');
  assert.equal(report.readyForPhase2DesignReview, true);
  assert.equal(report.scope.laterPhaseTablesConfirmedEmpty, false);
  assert.equal(report.scope.marketFactsChecked, false);
  assert.equal(report.scope.rollingMarketHistoryVerified, false);
  assert.equal(report.handoff.status, 'active');
  assert.equal(report.handoff.blocking, false);
  assert.equal(report.handoff.presenceOnly, true);
  assert.equal(report.handoff.laterPhaseDomainsPresent, 1);
  assert.equal(report.handoff.laterPhaseTables.marketFactRowsPresent, true);
  assert.equal(Object.hasOwn(report.handoff, 'laterPhaseTotalRows'), false);
  assert.equal(report.checks.find(row => row.id === 'later-phase-handoff').status, 'informational');
  assert.equal(report.failures.includes('later-phase fact/analytics/publication/alert tables are not empty'), false);
  assert.ok(report.notices.some(notice => /bounded presence probe.*informational handoff/.test(notice)));
});

test('pure readiness builder accepts the documented camelCase fixture aliases', () => {
  const report = buildCatalogShadowReadiness(readinessFixture(7, { camelCase: true }));
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
  assert.match(queries[5].text, /metadata->>'mergedStatus', ''\) <> 'warming'/);
  assert.match(queries[5].text, /metadata->>'lifecycleComparable'/);
  assert.match(queries[5].text, /THEN 'false' ELSE 'true' END/);
  assert.equal(calls.length, 9);
  assert.ok(calls.every(call => /SELECT|WITH/.test(call.text)));
  assert.ok(calls.every(call => !/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(call.text)));
  assert.ok(calls.slice(0, 7).every(call => call.text.includes('rwa-listing-audit')));
  assert.ok(calls.slice(0, 7).every(call => call.text.includes('rwa-listing-catalog-pg-shadow/v1')));
  assert.match(calls[2].text, /run\.error_codes/);
  assert.match(calls[2].text, /rawStatus/);
  assert.match(calls[2].text, /review_case_count/);
  assert.deepEqual(calls[5].params[1], [...LISTING_SOURCE_KEYS].sort());
  assert.match(calls[5].text, /event_eligible_added_count/);
  assert.match(calls[5].text, /pending_event_added_count/);
  assert.match(calls[5].text, /pending_review_count/);
  assert.match(calls[5].text, /pending_identity_resolved_count/);
  assert.match(calls[5].text, /identity_resolved_added_count/);
  assert.match(calls[5].text, /review\.status = 'open'/);
  assert.match(calls[5].text, /resolved_review\.status = 'verified'/);
  assert.match(calls[5].text, /added_members AS MATERIALIZED/);
  assert.match(calls[5].text, /identity_resolved_additions AS MATERIALIZED/);
  assert.doesNotMatch(calls[5].text, /\bNOT EXISTS\b/i);
  assert.match(calls[5].text, /LEFT JOIN identity_resolved_additions AS resolved/);
  assert.match(calls[5].text, /WHERE resolved\.instrument_id IS NULL/);
  assert.match(calls[5].text, /added\.valid_from\s*>=\s*added\.cycle_bucket_at/);
  assert.match(calls[5].text, /added\.valid_from\s*<\s*added\.cycle_bucket_at\s*\+\s*interval\s+'1 day'/);
  assert.doesNotMatch(calls[5].text, /valid_from\s*=\s*added\.source_observed_at/);
  const handoffSql = calls[8].text;
  const existsCount = (handoffSql.match(/\bEXISTS\s*\(/gi) || []).length;
  const boundedProbeCount = (handoffSql.match(/\bLIMIT\s+1\b/gi) || []).length;
  assert.ok(existsCount >= 4);
  assert.equal(boundedProbeCount, existsCount);
  assert.doesNotMatch(handoffSql, /\bcount\s*\(\s*\*\s*\)/i);
  assert.match(handoffSql, /market_fact_rows_present/);
  assert.match(handoffSql, /derived_analytics_rows_present/);
  assert.match(handoffSql, /publication_rows_present/);
  assert.match(handoffSql, /alert_rows_present/);
  assert.throws(() => buildCatalogShadowReadinessQueries(sql, 6), /7 through 90/);
  assert.throws(() => buildCatalogShadowReadinessQueries(sql, 91), /7 through 90/);
  assert.throws(() => buildCatalogShadowReadinessQueries(sql, 7.5), /7 through 90/);
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

test('CLI exits nonzero only for Fail and never adds elapsed or market-history authorization', async () => {
  const cli = await readFile(new URL('../scripts/audit-catalog-shadow.mjs', import.meta.url), 'utf8');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts['audit:catalog-shadow'], 'node scripts/audit-catalog-shadow.mjs');
  assert.match(cli, /if \(report\.status === 'fail'\) process\.exitCode = 1;/);
  assert.doesNotMatch(cli, /report\.status === 'warming'[^\n]*exitCode/);
  assert.match(cli, /catch \(error\)[\s\S]*process\.exitCode = 1;/);
  assert.match(cli, /marketFactsChecked:\s*false/);
  assert.match(cli, /rollingMarketHistoryVerified:\s*false/);
  assert.match(cli, /phase2DesignElapsedGate:\s*false/);
  assert.match(cli, /elapsedGate:\s*false/);
  assert.doesNotMatch(cli, /readyForPhase2[^\n]*(?:write|cutover)\s*=\s*true/i);
  assert.doesNotMatch(cli, /14[- ](?:day|cycle)|requiredConsecutiveUtcCycles/i);
});

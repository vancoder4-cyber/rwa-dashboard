import { LISTING_AUDIT_SCHEMA_VERSION, LISTING_SOURCE_KEYS } from './listing-audit.js';
import {
  LISTING_PG_ENDPOINT_KEY,
  LISTING_PG_JOB_NAME,
  LISTING_NORMALIZED_ARTIFACT_FORMAT,
  LISTING_PG_PIPELINE_VERSION,
} from './listing-pg-shadow.js';
import { runDatabaseTransaction } from './database.js';

export const CATALOG_SHADOW_READINESS_SCHEMA_VERSION = 'rwa-catalog-shadow-readiness/v1';
export const CATALOG_SHADOW_REQUIRED_UTC_CYCLES = 14;
export const CATALOG_SHADOW_QUERY_CYCLE_LIMIT = 30;
export const CATALOG_SHADOW_MAX_LATEST_AGE_HOURS = 36;
export const CATALOG_SHADOW_EXPECTED_SINKS = Object.freeze([
  'postgres-catalog-shadow',
  'blob-normalized-catalog',
  'runtime-cache-listing-audit',
]);

const EXPECTED_SOURCE_KEYS = Object.freeze([...LISTING_SOURCE_KEYS].sort());
const DAY_MS = 86_400_000;

function camelCaseKey(key) {
  return String(key).replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function value(row, snake, camel = camelCaseKey(snake)) {
  return row?.[snake] ?? row?.[camel] ?? null;
}

function integer(input) {
  const number = Number(input);
  return Number.isInteger(number) ? number : 0;
}

function nonNegativeInteger(input) {
  if (input === null || input === undefined || input === '') return null;
  const number = Number(input);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function isoTimestamp(input) {
  if (input === null || input === undefined || input === '') return null;
  const time = new Date(input).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function utcDay(input) {
  return isoTimestamp(input)?.slice(0, 10) || null;
}

function sortedUnique(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort();
}

function sameStrings(left, right) {
  return JSON.stringify(sortedUnique(left)) === JSON.stringify(sortedUnique(right));
}

function check(id, status, detail, evidence = {}) {
  return { id, status, detail, evidence };
}

function group(rows, key) {
  const output = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const groupKey = String(value(row, key) || '');
    if (!output.has(groupKey)) output.set(groupKey, []);
    output.get(groupKey).push(row);
  }
  return output;
}

function normalizedRuntime(runtimeSnapshot, runtimeError) {
  if (!runtimeSnapshot || typeof runtimeSnapshot !== 'object') {
    return {
      available: false,
      status: 'unavailable',
      generatedAt: null,
      utcDay: null,
      activeListings: null,
      sources: [],
      historyTruncated: null,
      error: runtimeError ? String(runtimeError?.message || runtimeError) : 'Runtime Cache snapshot was not supplied',
    };
  }
  return {
    available: true,
    status: String(runtimeSnapshot.status || 'unknown'),
    generatedAt: isoTimestamp(runtimeSnapshot.generatedAt),
    utcDay: utcDay(runtimeSnapshot.generatedAt),
    activeListings: Number.isInteger(Number(runtimeSnapshot?.counts?.activeListings))
      ? Number(runtimeSnapshot.counts.activeListings)
      : null,
    sources: Array.isArray(runtimeSnapshot.sources) ? runtimeSnapshot.sources : [],
    historyTruncated: runtimeSnapshot?.history?.truncated === true,
    schemaVersion: runtimeSnapshot.schemaVersion || null,
    error: null,
  };
}

function lifecycleSummary(eventRows) {
  const counts = { listed: 0, delisted: 0, relisted: 0, invalid: 0 };
  const sourceCounts = new Map(EXPECTED_SOURCE_KEYS.map(sourceKey => [
    sourceKey,
    { sourceKey, listed: 0, delisted: 0, relisted: 0, invalid: 0 },
  ]));
  const reasons = [];
  for (const row of eventRows) {
    const sourceKey = String(value(row, 'source_key', 'sourceKey') || '');
    const eventType = String(value(row, 'event_type', 'eventType') || '');
    const status = String(value(row, 'event_status', 'eventStatus') || '');
    const baseline = value(row, 'baseline', 'baseline') === true;
    const observedAt = isoTimestamp(value(row, 'observed_at', 'observedAt'));
    const validFrom = isoTimestamp(value(row, 'valid_from', 'validFrom'));
    const validTo = isoTimestamp(value(row, 'valid_to', 'validTo'));
    const previousBucket = isoTimestamp(value(row, 'previous_bucket_at', 'previousBucketAt'));
    const currentBucket = isoTimestamp(value(row, 'current_bucket_at', 'currentBucketAt'));
    if (Object.hasOwn(counts, eventType)) counts[eventType] += 1;
    if (!sourceCounts.has(sourceKey)) sourceCounts.set(sourceKey, { sourceKey, listed: 0, delisted: 0, relisted: 0, invalid: 0 });
    const source = sourceCounts.get(sourceKey);
    if (Object.hasOwn(source, eventType)) source[eventType] += 1;
    let valid = status === 'confirmed' && !baseline && observedAt !== null;
    if (eventType === 'delisted') valid = valid && validTo === observedAt;
    else if (eventType === 'listed' || eventType === 'relisted') {
      valid = valid && validFrom === observedAt && (validTo === null || Date.parse(validTo) > Date.parse(observedAt));
    } else valid = false;
    if (!previousBucket || !currentBucket || Date.parse(previousBucket) >= Date.parse(currentBucket)) valid = false;
    if (observedAt && currentBucket && utcDay(observedAt) !== utcDay(currentBucket)) valid = false;
    if (!valid) {
      counts.invalid += 1;
      source.invalid += 1;
      reasons.push(`invalid lifecycle event ${value(row, 'catalog_change_event_id', 'catalogChangeEventId') || eventType || 'unknown'}`);
    }
  }
  return {
    ...counts,
    total: eventRows.length,
    reasons,
    sources: [...sourceCounts.values()].sort((left, right) => left.sourceKey.localeCompare(right.sourceKey)),
  };
}

function cycleDetail(cycleRow, context) {
  const cycleId = String(value(cycleRow, 'cycle_id', 'cycleId') || '');
  const bucketAt = isoTimestamp(value(cycleRow, 'bucket_at', 'bucketAt'));
  const attempts = context.attempts.get(cycleId) || [];
  const sources = context.sources.get(cycleId) || [];
  const memberships = context.memberships.get(cycleId) || [];
  const sinks = context.sinks.get(cycleId) || [];
  const changes = context.changes.get(cycleId) || [];
  const events = context.events.get(cycleId) || [];
  const reasons = [];

  const attemptIds = sortedUnique(attempts.map(row => value(row, 'attempt_id', 'attemptId')));
  const attemptNos = sortedUnique(attempts.map(row => String(value(row, 'attempt_no', 'attemptNo') ?? '')));
  const attemptStatuses = sortedUnique(attempts.map(row => value(row, 'attempt_status', 'attemptStatus')));
  const attemptCompletedAt = isoTimestamp(value(attempts[0], 'attempt_completed_at', 'attemptCompletedAt'));
  if (attemptIds.length !== 1 || attemptNos.length !== 1 || attemptNos[0] !== '1' || attemptStatuses[0] !== 'complete' || !attemptCompletedAt) {
    reasons.push('same-day retry did not conserve one complete idempotent attempt_no=1');
  }

  const sourceKeys = sources.map(row => value(row, 'source_key', 'sourceKey'));
  const duplicateSources = sourceKeys.filter((sourceKey, index) => sourceKeys.indexOf(sourceKey) !== index);
  const fullSourceCount = sources.filter(row =>
    value(row, 'run_status', 'runStatus') === 'full' &&
    value(row, 'catalog_status', 'catalogStatus') === 'full' &&
    value(row, 'identity_status', 'identityStatus') === 'full' &&
    value(row, 'endpoint_key', 'endpointKey') === LISTING_PG_ENDPOINT_KEY
  ).length;
  if (sources.length !== EXPECTED_SOURCE_KEYS.length || duplicateSources.length || !sameStrings(sourceKeys, EXPECTED_SOURCE_KEYS)) {
    reasons.push('source_run set is not the exact ten-source catalog set');
  }
  if (fullSourceCount !== EXPECTED_SOURCE_KEYS.length) reasons.push('one or more source_run rows are not fully admitted');
  let storedArtifactCount = 0;
  let officialEvidenceCount = 0;
  for (const row of sources) {
    const sourceKey = value(row, 'source_key', 'sourceKey');
    const listingCount = nonNegativeInteger(value(row, 'listing_count', 'listingCount'));
    const admitted = nonNegativeInteger(value(row, 'admitted_listing_count', 'admittedListingCount'));
    const rejected = nonNegativeInteger(value(row, 'rejected_listing_count', 'rejectedListingCount'));
    const artifacts = nonNegativeInteger(value(row, 'stored_artifact_count', 'storedArtifactCount'));
    const evidence = nonNegativeInteger(value(row, 'official_evidence_count', 'officialEvidenceCount'));
    const missingEvidence = nonNegativeInteger(value(row, 'missing_official_evidence_count', 'missingOfficialEvidenceCount'));
    if (listingCount === null || listingCount <= 0 || admitted === null || rejected === null) {
      reasons.push(`${sourceKey} source counts are missing or invalid`);
    } else if (listingCount !== admitted + rejected) {
      reasons.push(`${sourceKey} source counts do not conserve`);
    }
    if (artifacts === null || artifacts < 1) reasons.push(`${sourceKey} has no stored ${LISTING_NORMALIZED_ARTIFACT_FORMAT} artifact`);
    if (evidence === null || missingEvidence === null || admitted === null || evidence !== admitted || missingEvidence !== 0) {
      reasons.push(`${sourceKey} official-catalog evidence does not cover accepted membership`);
    }
    storedArtifactCount += artifacts || 0;
    officialEvidenceCount += evidence || 0;
  }

  const membershipBySource = new Map(memberships.map(row => [
    String(value(row, 'source_key', 'sourceKey') || ''),
    row,
  ]));
  let membershipCount = 0;
  for (const source of sources) {
    const sourceKey = String(value(source, 'source_key', 'sourceKey') || '');
    const admitted = nonNegativeInteger(value(source, 'admitted_listing_count', 'admittedListingCount'));
    const membership = membershipBySource.get(sourceKey);
    const rows = nonNegativeInteger(value(membership, 'membership_count', 'membershipCount'));
    const distinct = nonNegativeInteger(value(membership, 'distinct_instrument_count', 'distinctInstrumentCount'));
    membershipCount += rows || 0;
    if (!membership || admitted === null || rows === null || distinct === null || rows !== admitted || rows !== distinct) {
      reasons.push(`${sourceKey} accepted membership does not match admitted source rows`);
    }
  }

  const sinkNames = sinks.map(row => value(row, 'sink_name', 'sinkName'));
  const sinkStatuses = Object.fromEntries(sinks.map(row => [
    value(row, 'sink_name', 'sinkName'),
    value(row, 'sink_status', 'sinkStatus'),
  ]));
  if (sinks.length !== CATALOG_SHADOW_EXPECTED_SINKS.length || !sameStrings(sinkNames, CATALOG_SHADOW_EXPECTED_SINKS)) {
    reasons.push('sink set is not the exact three Phase 1 sinks');
  }
  if (CATALOG_SHADOW_EXPECTED_SINKS.some(name => sinkStatuses[name] !== 'stored')) {
    reasons.push('one or more Phase 1 sinks are not stored');
  }

  const lifecycle = lifecycleSummary(events);
  reasons.push(...lifecycle.reasons);
  const changeBySource = new Map(changes.map(row => [String(value(row, 'source_key', 'sourceKey') || ''), row]));
  const changeSummary = {
    added: changes.reduce((sum, row) => sum + integer(value(row, 'added_count', 'addedCount')), 0),
    removed: changes.reduce((sum, row) => sum + integer(value(row, 'removed_count', 'removedCount')), 0),
    changedSources: changes.filter(row => integer(value(row, 'added_count', 'addedCount')) || integer(value(row, 'removed_count', 'removedCount'))).length,
    comparableSources: changes.filter(row => value(row, 'previous_cycle_id', 'previousCycleId')).length,
    sources: EXPECTED_SOURCE_KEYS.map(sourceKey => {
      const row = changeBySource.get(sourceKey);
      return {
        sourceKey,
        comparable: Boolean(value(row, 'previous_cycle_id', 'previousCycleId')),
        added: nonNegativeInteger(value(row, 'added_count', 'addedCount')),
        removed: nonNegativeInteger(value(row, 'removed_count', 'removedCount')),
      };
    }),
  };
  const changeSourceKeys = changes.map(row => value(row, 'source_key', 'sourceKey'));
  if (changes.length !== EXPECTED_SOURCE_KEYS.length || !sameStrings(changeSourceKeys, EXPECTED_SOURCE_KEYS)) {
    reasons.push('catalog membership change set is not the exact ten-source set');
  }
  if (![0, EXPECTED_SOURCE_KEYS.length].includes(changeSummary.comparableSources)) {
    reasons.push('catalog membership comparison is incomplete across sources');
  }
  if (changeSummary.comparableSources === 0 && lifecycle.total !== 0) {
    reasons.push('baseline catalog cycle emitted lifecycle events');
  }
  const lifecycleBySource = new Map(lifecycle.sources.map(row => [row.sourceKey, row]));
  for (const lifecycleSource of lifecycle.sources) {
    if (!EXPECTED_SOURCE_KEYS.includes(lifecycleSource.sourceKey)) reasons.push(`${lifecycleSource.sourceKey || 'unknown'} lifecycle event source is outside the exact ten-source set`);
  }
  if (changeSummary.comparableSources === EXPECTED_SOURCE_KEYS.length) {
    for (const change of changeSummary.sources) {
      const sourceLifecycle = lifecycleBySource.get(change.sourceKey) || { listed: 0, relisted: 0 };
      if (change.added === null || change.removed === null) {
        reasons.push(`${change.sourceKey} catalog membership change counts are missing`);
      } else if (change.added !== sourceLifecycle.listed + sourceLifecycle.relisted) {
        reasons.push(`${change.sourceKey} accepted membership additions do not match listed and relisted lifecycle events`);
      }
    }
  }

  const sinkByName = new Map(sinks.map(row => [String(value(row, 'sink_name', 'sinkName') || ''), row]));
  const postgresRows = nonNegativeInteger(value(sinkByName.get('postgres-catalog-shadow'), 'row_count', 'rowCount'));
  const blobRows = nonNegativeInteger(value(sinkByName.get('blob-normalized-catalog'), 'row_count', 'rowCount'));
  if (postgresRows === null || postgresRows !== membershipCount + lifecycle.total) {
    reasons.push('PostgreSQL sink row count does not conserve membership plus lifecycle events');
  }
  if (blobRows === null || blobRows < EXPECTED_SOURCE_KEYS.length || blobRows > storedArtifactCount) {
    reasons.push('normalized catalog sink row count is not covered by stored artifact manifests');
  }

  if (value(cycleRow, 'cycle_status', 'cycleStatus') !== 'complete') reasons.push('collection_cycle is not complete');
  return {
    cycleId,
    utcDay: utcDay(bucketAt),
    bucketAt,
    status: value(cycleRow, 'cycle_status', 'cycleStatus') || 'unknown',
    success: reasons.length === 0,
    reasons: sortedUnique(reasons),
    attempts: {
      count: attemptIds.length,
      attemptNos: attemptNos.map(Number).filter(Number.isInteger),
      statuses: attemptStatuses,
      completedAt: attemptCompletedAt,
      idempotent: attemptIds.length === 1 && attemptNos.length === 1 && attemptNos[0] === '1' && attemptStatuses[0] === 'complete' && Boolean(attemptCompletedAt),
    },
    sourceRuns: {
      expected: EXPECTED_SOURCE_KEYS.length,
      observed: sources.length,
      full: fullSourceCount,
      keys: sortedUnique(sourceKeys),
      duplicates: sortedUnique(duplicateSources),
      storedArtifacts: storedArtifactCount,
      officialEvidence: officialEvidenceCount,
      sources: sources.map(row => ({
        sourceKey: value(row, 'source_key', 'sourceKey'),
        listingCount: nonNegativeInteger(value(row, 'listing_count', 'listingCount')),
        admittedListingCount: nonNegativeInteger(value(row, 'admitted_listing_count', 'admittedListingCount')),
        rejectedListingCount: nonNegativeInteger(value(row, 'rejected_listing_count', 'rejectedListingCount')),
        storedArtifactCount: nonNegativeInteger(value(row, 'stored_artifact_count', 'storedArtifactCount')),
        officialEvidenceCount: nonNegativeInteger(value(row, 'official_evidence_count', 'officialEvidenceCount')),
        missingOfficialEvidenceCount: nonNegativeInteger(value(row, 'missing_official_evidence_count', 'missingOfficialEvidenceCount')),
      })).sort((left, right) => String(left.sourceKey).localeCompare(String(right.sourceKey))),
    },
    sinks: {
      expected: [...CATALOG_SHADOW_EXPECTED_SINKS],
      observed: sinks.length,
      statuses: sinkStatuses,
    },
    membership: {
      rows: membershipCount,
      sources: memberships.map(row => ({
        sourceKey: value(row, 'source_key', 'sourceKey'),
        rows: integer(value(row, 'membership_count', 'membershipCount')),
        fingerprint: value(row, 'membership_fingerprint', 'membershipFingerprint'),
      })).sort((left, right) => String(left.sourceKey).localeCompare(String(right.sourceKey))),
    },
    changes: changeSummary,
    lifecycle,
  };
}

function runtimeComparison(runtime, latestCycle, sourceRows, membershipRows, sinkRows) {
  if (!latestCycle) {
    return {
      status: 'warming',
      ...runtime,
      match: null,
      reasons: ['No PostgreSQL catalog cycle exists yet'],
      checksumComparison: 'not-exposed-by-public-runtime-payload',
    };
  }
  const reasons = [];
  if (!runtime.available) reasons.push(runtime.error || 'Runtime Cache snapshot unavailable');
  if (runtime.schemaVersion !== LISTING_AUDIT_SCHEMA_VERSION) reasons.push('Runtime Cache schema version is not the expected listing audit contract');
  if (runtime.historyTruncated) reasons.push('Runtime Cache listing history is truncated');
  if (runtime.utcDay !== latestCycle.utcDay) reasons.push('Runtime Cache and PostgreSQL latest UTC days differ');
  const latestSources = sourceRows.filter(row => String(value(row, 'cycle_id', 'cycleId')) === latestCycle.cycleId);
  const latestMemberships = new Map(membershipRows
    .filter(row => String(value(row, 'cycle_id', 'cycleId')) === latestCycle.cycleId)
    .map(row => [String(value(row, 'source_key', 'sourceKey')), row]));
  const runtimeSources = new Map(runtime.sources.map(row => [String(row?.sourceKey || ''), row]));
  if (!sameStrings([...runtimeSources.keys()], EXPECTED_SOURCE_KEYS)) reasons.push('Runtime Cache source set is not the exact ten sources');
  for (const source of latestSources) {
    const sourceKey = String(value(source, 'source_key', 'sourceKey') || '');
    const publicSource = runtimeSources.get(sourceKey);
    const membership = latestMemberships.get(sourceKey);
    const admitted = integer(value(source, 'admitted_listing_count', 'admittedListingCount'));
    const withheld = integer(value(source, 'withheld_from_membership', 'withheldFromMembership'));
    if (!publicSource) continue;
    if (publicSource.status !== value(source, 'merged_status', 'mergedStatus')) reasons.push(`${sourceKey} Runtime status differs from stored merge status`);
    if (integer(publicSource.listingCount) !== admitted + withheld) reasons.push(`${sourceKey} Runtime listing count does not conserve admitted + withheld rows`);
    if (integer(value(membership, 'membership_count', 'membershipCount')) !== admitted) reasons.push(`${sourceKey} database membership differs from admitted rows`);
  }
  const expectedActiveListings = latestSources.reduce((sum, source) => {
    const admitted = nonNegativeInteger(value(source, 'admitted_listing_count', 'admittedListingCount'));
    const withheld = nonNegativeInteger(value(source, 'withheld_from_membership', 'withheldFromMembership'));
    return admitted === null || withheld === null ? NaN : sum + admitted + withheld;
  }, 0);
  if (!Number.isFinite(expectedActiveListings) || runtime.activeListings !== expectedActiveListings) {
    reasons.push('Runtime active listing count does not equal the exact source cohort total');
  }
  const runtimeSink = sinkRows.find(row =>
    String(value(row, 'cycle_id', 'cycleId')) === latestCycle.cycleId &&
    value(row, 'sink_name', 'sinkName') === 'runtime-cache-listing-audit'
  );
  const sinkRowCount = runtimeSink ? integer(value(runtimeSink, 'row_count', 'rowCount')) : null;
  const sinkCommittedAt = isoTimestamp(value(runtimeSink, 'committed_at', 'committedAt'));
  if (!runtimeSink || value(runtimeSink, 'sink_status', 'sinkStatus') !== 'stored') reasons.push('Runtime Cache sink evidence is not stored');
  if (runtime.activeListings === null || sinkRowCount === null || runtime.activeListings !== sinkRowCount) reasons.push('Runtime active listing count differs from sink evidence');
  if (runtime.generatedAt !== latestCycle.attempts.completedAt || runtime.generatedAt !== sinkCommittedAt) reasons.push('Runtime generatedAt differs from PostgreSQL attempt/sink time');
  return {
    ...runtime,
    status: reasons.length ? 'mismatch' : 'match',
    match: reasons.length === 0,
    reasons: sortedUnique(reasons),
    database: {
      cycleId: latestCycle.cycleId,
      utcDay: latestCycle.utcDay,
      recordedRowCount: sinkRowCount,
      committedAt: sinkCommittedAt,
    },
    checksumComparison: 'not-exposed-by-public-runtime-payload',
  };
}

function integrityReasons(row) {
  const fields = [
    ['invalid_membership_count', 'non-verified or non-present catalog membership exists'],
    ['open_review_accepted_count', 'an unresolved review case overlaps an accepted current instrument'],
    ['duplicate_current_version_count', 'an instrument has duplicate current versions'],
    ['overlapping_version_count', 'instrument SCD2 validity intervals overlap'],
    ['event_source_cycle_mismatch_count', 'a lifecycle event source run does not belong to its detection cycle'],
  ];
  return fields.flatMap(([field, message]) => integer(value(row, field, field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()))) ? [message] : []);
}

export function buildCatalogShadowReadiness({
  now = new Date(),
  cycleRows = [],
  attemptRows = [],
  sourceRows = [],
  membershipRows = [],
  sinkRows = [],
  changeRows = [],
  eventRows = [],
  integrityRow = {},
  laterPhaseRow = {},
  runtimeSnapshot = null,
  runtimeError = null,
} = {}) {
  const nowIso = isoTimestamp(now);
  if (!nowIso) throw new TypeError('Catalog shadow readiness requires a valid current timestamp');
  const distinctCycles = [...new Map((Array.isArray(cycleRows) ? cycleRows : [])
    .map(row => [String(value(row, 'cycle_id', 'cycleId') || ''), row])
    .filter(([cycleId]) => cycleId)).values()]
    .sort((left, right) => Date.parse(value(right, 'bucket_at', 'bucketAt')) - Date.parse(value(left, 'bucket_at', 'bucketAt')))
    .slice(0, CATALOG_SHADOW_REQUIRED_UTC_CYCLES);
  const context = {
    attempts: group(attemptRows, 'cycle_id'),
    sources: group(sourceRows, 'cycle_id'),
    memberships: group(membershipRows, 'cycle_id'),
    sinks: group(sinkRows, 'cycle_id'),
    changes: group(changeRows, 'cycle_id'),
    events: group(eventRows, 'cycle_id'),
  };
  const cycles = distinctCycles.map(row => cycleDetail(row, context));
  const duplicateUtcDays = cycles.map(row => row.utcDay).filter((day, index, days) => day && days.indexOf(day) !== index);
  const gaps = [];
  for (let index = 1; index < cycles.length; index += 1) {
    const newer = Date.parse(`${cycles[index - 1].utcDay}T00:00:00Z`);
    const older = Date.parse(`${cycles[index].utcDay}T00:00:00Z`);
    if (newer - older !== DAY_MS) gaps.push(`${cycles[index].utcDay}->${cycles[index - 1].utcDay}`);
  }
  let consecutive = 0;
  for (let index = 0; index < cycles.length; index += 1) {
    if (!cycles[index].success) break;
    if (index > 0 && Date.parse(`${cycles[index - 1].utcDay}T00:00:00Z`) - Date.parse(`${cycles[index].utcDay}T00:00:00Z`) !== DAY_MS) break;
    consecutive += 1;
  }
  const latest = cycles[0] || null;
  const latestAgeHours = latest ? (Date.parse(nowIso) - Date.parse(latest.attempts.completedAt || latest.bucketAt)) / 3_600_000 : null;
  const runtime = runtimeComparison(normalizedRuntime(runtimeSnapshot, runtimeError), latest, sourceRows, membershipRows, sinkRows);
  const integrityFailures = integrityReasons(integrityRow);
  const laterPhaseTables = {
    marketFactRows: integer(value(laterPhaseRow, 'market_fact_rows', 'marketFactRows')),
    derivedAnalyticsRows: integer(value(laterPhaseRow, 'derived_analytics_rows', 'derivedAnalyticsRows')),
    publicationRows: integer(value(laterPhaseRow, 'publication_rows', 'publicationRows')),
    alertRows: integer(value(laterPhaseRow, 'alert_rows', 'alertRows')),
  };
  const laterPhaseTotal = Object.values(laterPhaseTables).reduce((sum, count) => sum + count, 0);
  const hardFailures = [];
  if (duplicateUtcDays.length) hardFailures.push('duplicate UTC collection cycles exist');
  if (gaps.length) hardFailures.push('the evaluated UTC cycle window has calendar gaps');
  if (cycles.some(row => !row.success)) hardFailures.push('one or more evaluated cycles failed Phase 1 conservation');
  if (latestAgeHours !== null && (latestAgeHours < -0.1 || latestAgeHours > CATALOG_SHADOW_MAX_LATEST_AGE_HOURS)) hardFailures.push('latest PostgreSQL cycle is stale or future-dated');
  if (cycles.length && runtime.match !== true) hardFailures.push('latest Runtime Cache snapshot does not reconcile with PostgreSQL');
  hardFailures.push(...integrityFailures);
  if (laterPhaseTotal !== 0) hardFailures.push('later-phase fact/analytics/publication/alert tables are not empty');

  const readyForPhase2 = hardFailures.length === 0 && consecutive >= CATALOG_SHADOW_REQUIRED_UTC_CYCLES;
  const status = hardFailures.length ? 'fail' : readyForPhase2 ? 'pass' : 'warming';
  const checks = [
    check('utc-cycle-continuity', duplicateUtcDays.length || gaps.length ? 'fail' : cycles.length ? 'pass' : 'warming',
      cycles.length ? `${consecutive}/${CATALOG_SHADOW_REQUIRED_UTC_CYCLES} latest UTC cycles are consecutive successes` : 'No PostgreSQL catalog cycle exists yet',
      { duplicateUtcDays: sortedUnique(duplicateUtcDays), gaps }),
    check('ten-source-runs', cycles.some(row => row.sourceRuns.observed !== 10 || row.sourceRuns.full !== 10 || row.reasons.some(reason => reason.includes('source counts'))) ? 'fail' : cycles.length ? 'pass' : 'warming',
      'Every evaluated successful cycle must contain the exact ten Full source runs'),
    check('three-sink-outcomes', cycles.some(row => CATALOG_SHADOW_EXPECTED_SINKS.some(name => row.sinks.statuses[name] !== 'stored') || row.reasons.some(reason => reason.includes('sink row count'))) ? 'fail' : cycles.length ? 'pass' : 'warming',
      'PostgreSQL, normalized artifact and Runtime Cache sinks are independently stored'),
    check('artifact-evidence-lineage', cycles.some(row => row.reasons.some(reason => reason.includes('artifact') || reason.includes('official-catalog evidence'))) ? 'fail' : cycles.length ? 'pass' : 'warming',
      'Every source run has a stored normalized-catalog-v1 artifact manifest and exact official-catalog evidence for accepted membership'),
    check('membership-conservation', cycles.some(row => row.reasons.some(reason => reason.includes('membership'))) ? 'fail' : cycles.length ? 'pass' : 'warming',
      'Accepted source counts equal exact verified membership rows'),
    check('runtime-cache-reconciliation', runtime.match === true ? 'pass' : cycles.length ? 'fail' : 'warming',
      runtime.match === true ? 'Latest public Runtime Cache counts, sources and timestamp match sink evidence' : runtime.reasons.join('; ')),
    check('same-day-idempotency', cycles.some(row => !row.attempts.idempotent) ? 'fail' : cycles.length ? 'pass' : 'warming',
      'Same UTC day reuses one attempt_no=1 and unique source/sink/membership keys'),
    check('lifecycle-scd2', integrityFailures.length || cycles.some(row => row.lifecycle.invalid || row.reasons.some(reason => reason.includes('lifecycle event') || reason.includes('membership additions'))) ? 'fail' : cycles.length ? 'pass' : 'warming',
      'Cross-day catalog events and instrument SCD2 intervals retain exact source/version lineage', { integrityFailures }),
    check('later-phase-boundary', laterPhaseTotal === 0 ? 'pass' : 'fail',
      laterPhaseTotal === 0 ? 'All later-phase tables remain empty' : `${laterPhaseTotal} later-phase rows exist`, laterPhaseTables),
  ];

  return {
    schemaVersion: CATALOG_SHADOW_READINESS_SCHEMA_VERSION,
    generatedAt: nowIso,
    status,
    readyForPhase2,
    decision: readyForPhase2
      ? 'Eligible for Phase 2 design review; this does not enable a writer or read cutover.'
      : status === 'warming'
        ? 'Phase 1 observation is still warming; no writer or read cutover is authorized.'
        : 'Phase 1 reconciliation failed; investigate before continuing the observation window.',
    scope: {
      phase: 'phase1-catalog-shadow',
      requiredConsecutiveUtcCycles: CATALOG_SHADOW_REQUIRED_UTC_CYCLES,
      expectedSourcesPerCycle: EXPECTED_SOURCE_KEYS.length,
      expectedSourceKeys: [...EXPECTED_SOURCE_KEYS],
      expectedSinks: [...CATALOG_SHADOW_EXPECTED_SINKS],
      marketFactsChecked: false,
      rollingMarketHistoryVerified: false,
      laterPhaseTablesConfirmedEmpty: laterPhaseTotal === 0,
    },
    progress: {
      windowKind: 'latest-14-utc-cycles',
      evaluatedUtcCycles: cycles.length,
      successfulUtcCycles: cycles.filter(row => row.success).length,
      consecutiveSuccessfulUtcCycles: consecutive,
      remainingSuccessfulUtcCycles: Math.max(0, CATALOG_SHADOW_REQUIRED_UTC_CYCLES - consecutive),
      latestUtcDay: latest?.utcDay || null,
      latestAgeHours: latestAgeHours === null || !Number.isFinite(latestAgeHours) ? null : Number(latestAgeHours.toFixed(2)),
      observationStartedAt: cycles.at(-1)?.bucketAt || null,
    },
    checks,
    runtimeCache: runtime,
    cycles,
    failures: sortedUnique(hardFailures),
    limitations: [
      'Phase 1 checks catalog shadow data only; it does not collect or validate price, volume, OI, funding, reference or traditional-market facts.',
      'No rolling 14-day market history is stored in Phase 1, so this report does not claim to reconcile or replay such history.',
      'The public Runtime Cache payload does not expose the private bundle checksum; reconciliation uses exact source keys, timestamps, active counts and recorded sink evidence.',
      'Stored normalized-catalog artifact manifests and official-catalog evidence are checked by metadata and foreign-key lineage only; this report does not download and replay Blob contents.',
      'readyForPhase2 means eligible for a separate Phase 2 design review only; it never enables a writer, read cutover or alert delivery.',
    ],
  };
}

function recentCyclesCte() {
  return `WITH recent_cycles AS (
    SELECT cycle_id, bucket_at, status, trigger_kind
    FROM ingest.collection_cycle
    WHERE job_name = '${LISTING_PG_JOB_NAME}'
      AND pipeline_version = '${LISTING_PG_PIPELINE_VERSION}'
    ORDER BY bucket_at DESC
    LIMIT $1
  )`;
}

export function buildCatalogShadowReadinessQueries(sql, limit = CATALOG_SHADOW_QUERY_CYCLE_LIMIT) {
  if (!sql || typeof sql.query !== 'function') throw new TypeError('A Neon query builder is required');
  if (!Number.isInteger(limit) || limit < CATALOG_SHADOW_REQUIRED_UTC_CYCLES || limit > 90) throw new RangeError('cycle query limit must be an integer from 14 through 90');
  const cte = recentCyclesCte();
  return [
    sql.query(`${cte}
      SELECT cycle_id::text, bucket_at, status AS cycle_status, trigger_kind
      FROM recent_cycles ORDER BY bucket_at DESC`, [limit]),
    sql.query(`${cte}
      SELECT cycle.cycle_id::text, attempt.attempt_id::text, attempt.attempt_no,
        attempt.status AS attempt_status, attempt.started_at AS attempt_started_at,
        attempt.completed_at AS attempt_completed_at
      FROM recent_cycles AS cycle
      LEFT JOIN ingest.collection_attempt AS attempt ON attempt.cycle_id = cycle.cycle_id
      ORDER BY cycle.bucket_at DESC, attempt.attempt_no`, [limit]),
    sql.query(`${cte}
      SELECT cycle.cycle_id::text, source.source_key, run.source_run_id::text,
        run.endpoint_key, run.status AS run_status, run.catalog_status,
        run.identity_status, run.listing_count, run.admitted_listing_count,
        run.rejected_listing_count, run.metadata->>'mergedStatus' AS merged_status,
        COALESCE((run.metadata->>'withheldFromMembership')::int, 0) AS withheld_from_membership,
        (SELECT count(*)::int
          FROM ingest.raw_artifact AS artifact
          WHERE artifact.source_run_id = run.source_run_id
            AND artifact.artifact_kind = 'normalized'
            AND artifact.artifact_role = 'catalog'
            AND artifact.artifact_format = '${LISTING_NORMALIZED_ARTIFACT_FORMAT}'
            AND artifact.archive_status = 'stored') AS stored_artifact_count,
        (SELECT count(DISTINCT evidence.instrument_id)::int
          FROM identity.evidence AS evidence
          JOIN ingest.raw_artifact AS artifact
            ON artifact.artifact_id = evidence.raw_artifact_id
           AND artifact.source_run_id = evidence.source_run_id
           AND artifact.artifact_kind = 'normalized'
           AND artifact.artifact_role = 'catalog'
           AND artifact.artifact_format = '${LISTING_NORMALIZED_ARTIFACT_FORMAT}'
           AND artifact.archive_status = 'stored'
          WHERE evidence.source_run_id = run.source_run_id
            AND evidence.evidence_kind = 'official-catalog') AS official_evidence_count,
        (SELECT count(*)::int
          FROM ingest.catalog_membership AS membership
          JOIN identity.instrument_version AS instrument_version
            ON instrument_version.instrument_version_id = membership.instrument_version_id
          WHERE membership.source_run_id = run.source_run_id
            AND NOT EXISTS (
              SELECT 1
              FROM identity.evidence AS evidence
              JOIN ingest.raw_artifact AS artifact
                ON artifact.artifact_id = evidence.raw_artifact_id
               AND artifact.source_run_id = evidence.source_run_id
               AND artifact.artifact_kind = 'normalized'
               AND artifact.artifact_role = 'catalog'
               AND artifact.artifact_format = '${LISTING_NORMALIZED_ARTIFACT_FORMAT}'
               AND artifact.archive_status = 'stored'
              WHERE evidence.source_run_id = run.source_run_id
                AND evidence.instrument_id = instrument_version.instrument_id
                AND evidence.evidence_kind = 'official-catalog'
            )) AS missing_official_evidence_count
      FROM recent_cycles AS cycle
      JOIN ingest.collection_attempt AS attempt ON attempt.cycle_id = cycle.cycle_id
      JOIN ingest.source_run AS run ON run.attempt_id = attempt.attempt_id
      JOIN identity.source AS source ON source.source_id = run.source_id
      ORDER BY cycle.bucket_at DESC, source.source_key`, [limit]),
    sql.query(`${cte}
      SELECT cycle.cycle_id::text, source.source_key,
        count(*)::int AS membership_count,
        count(DISTINCT instrument_version.instrument_id)::int AS distinct_instrument_count,
        encode(digest(COALESCE(string_agg(concat_ws(chr(31), instrument.official_product_key,
          asset.asset_key, instrument_version.identity_fingerprint), E'\\n'
          ORDER BY instrument.official_product_key COLLATE "C"), ''), 'sha256'), 'hex') AS membership_fingerprint
      FROM recent_cycles AS cycle
      JOIN ingest.collection_attempt AS attempt ON attempt.cycle_id = cycle.cycle_id
      JOIN ingest.source_run AS run ON run.attempt_id = attempt.attempt_id
      JOIN identity.source AS source ON source.source_id = run.source_id
      JOIN ingest.catalog_membership AS membership ON membership.source_run_id = run.source_run_id
      JOIN identity.instrument_version AS instrument_version ON instrument_version.instrument_version_id = membership.instrument_version_id
      JOIN identity.instrument AS instrument ON instrument.instrument_id = instrument_version.instrument_id
      JOIN identity.asset_version AS asset_version ON asset_version.asset_version_id = instrument_version.asset_version_id
      JOIN identity.asset AS asset ON asset.asset_id = asset_version.asset_id
      GROUP BY cycle.cycle_id, cycle.bucket_at, source.source_key
      ORDER BY cycle.bucket_at DESC, source.source_key`, [limit]),
    sql.query(`${cte}
      SELECT cycle.cycle_id::text, sink.sink_name, sink.status AS sink_status,
        sink.row_count, sink.checksum, sink.committed_at, sink.error_summary
      FROM recent_cycles AS cycle
      JOIN ingest.collection_attempt AS attempt ON attempt.cycle_id = cycle.cycle_id
      JOIN ingest.sink_commit AS sink ON sink.attempt_id = attempt.attempt_id
      ORDER BY cycle.bucket_at DESC, sink.sink_name`, [limit]),
    sql.query(`${cte}, ordered_cycles AS (
        SELECT cycle_id, bucket_at, lag(cycle_id) OVER (ORDER BY bucket_at) AS previous_cycle_id
        FROM recent_cycles
      ), membership_set AS (
        SELECT cycle.cycle_id, run.source_id, instrument_version.instrument_id
        FROM recent_cycles AS cycle
        JOIN ingest.collection_attempt AS attempt ON attempt.cycle_id = cycle.cycle_id
        JOIN ingest.source_run AS run ON run.attempt_id = attempt.attempt_id
        JOIN ingest.catalog_membership AS membership ON membership.source_run_id = run.source_run_id
        JOIN identity.instrument_version AS instrument_version ON instrument_version.instrument_version_id = membership.instrument_version_id
      )
      SELECT current.cycle_id::text, previous_cycle_id::text, source.source_key,
        CASE WHEN previous_cycle_id IS NULL THEN NULL ELSE (
          SELECT count(*)::int FROM membership_set AS current_member
          WHERE current_member.cycle_id = current.cycle_id AND current_member.source_id = source.source_id
            AND NOT EXISTS (SELECT 1 FROM membership_set AS previous_member
              WHERE previous_member.cycle_id = current.previous_cycle_id
                AND previous_member.source_id = current_member.source_id
                AND previous_member.instrument_id = current_member.instrument_id)
        ) END AS added_count,
        CASE WHEN previous_cycle_id IS NULL THEN NULL ELSE (
          SELECT count(*)::int FROM membership_set AS previous_member
          WHERE previous_member.cycle_id = current.previous_cycle_id AND previous_member.source_id = source.source_id
            AND NOT EXISTS (SELECT 1 FROM membership_set AS current_member
              WHERE current_member.cycle_id = current.cycle_id
                AND current_member.source_id = previous_member.source_id
                AND current_member.instrument_id = previous_member.instrument_id)
        ) END AS removed_count
      FROM ordered_cycles AS current CROSS JOIN identity.source AS source
      WHERE source.source_key = ANY($2::text[])
      ORDER BY current.bucket_at DESC, source.source_key`, [limit, EXPECTED_SOURCE_KEYS]),
    sql.query(`${cte}
      SELECT event.catalog_change_event_id::text, event.detection_cycle_id::text AS cycle_id,
        source.source_key, event.event_type, event.status AS event_status, event.baseline,
        event.observed_at, instrument_version.valid_from, instrument_version.valid_to,
        previous_cycle.bucket_at AS previous_bucket_at, current_cycle.bucket_at AS current_bucket_at
      FROM recent_cycles AS cycle
      JOIN analytics.catalog_change_event AS event ON event.detection_cycle_id = cycle.cycle_id
      JOIN identity.source AS source ON source.source_id = event.source_id
      JOIN identity.instrument_version AS instrument_version ON instrument_version.instrument_version_id = event.instrument_version_id
      LEFT JOIN ingest.source_run AS previous_run ON previous_run.source_run_id = event.previous_source_run_id
      LEFT JOIN ingest.collection_attempt AS previous_attempt ON previous_attempt.attempt_id = previous_run.attempt_id
      LEFT JOIN ingest.collection_cycle AS previous_cycle ON previous_cycle.cycle_id = previous_attempt.cycle_id
      JOIN ingest.source_run AS current_run ON current_run.source_run_id = event.current_source_run_id
      JOIN ingest.collection_attempt AS current_attempt ON current_attempt.attempt_id = current_run.attempt_id
      JOIN ingest.collection_cycle AS current_cycle ON current_cycle.cycle_id = current_attempt.cycle_id
      ORDER BY cycle.bucket_at DESC, source.source_key, event.event_type`, [limit]),
    sql.query(`SELECT
        (SELECT count(*)::int FROM ingest.catalog_membership AS membership
          JOIN identity.instrument_version AS instrument_version ON instrument_version.instrument_version_id = membership.instrument_version_id
          JOIN identity.asset_version AS asset_version ON asset_version.asset_version_id = instrument_version.asset_version_id
          WHERE membership.presence_status <> 'present' OR instrument_version.identity_status <> 'verified' OR asset_version.identity_status <> 'verified') AS invalid_membership_count,
        (SELECT count(*)::int FROM identity.review_case AS review
          JOIN identity.instrument AS instrument ON instrument.source_id = review.source_id
            AND instrument.official_product_key = review.candidate_official_product_key
          JOIN identity.instrument_version AS version ON version.instrument_id = instrument.instrument_id AND version.valid_to IS NULL
          WHERE review.status = 'open' AND version.identity_status = 'verified') AS open_review_accepted_count,
        (SELECT count(*)::int FROM (SELECT instrument_id FROM identity.instrument_version WHERE valid_to IS NULL GROUP BY instrument_id HAVING count(*) > 1) AS duplicates) AS duplicate_current_version_count,
        (SELECT count(*)::int FROM identity.instrument_version AS left_version
          JOIN identity.instrument_version AS right_version ON left_version.instrument_id = right_version.instrument_id
            AND left_version.instrument_version_id < right_version.instrument_version_id
            AND tstzrange(left_version.valid_from, left_version.valid_to, '[)') && tstzrange(right_version.valid_from, right_version.valid_to, '[)')) AS overlapping_version_count,
        (SELECT count(*)::int FROM analytics.catalog_change_event AS event
          JOIN ingest.source_run AS run ON run.source_run_id = event.current_source_run_id
          JOIN ingest.collection_attempt AS attempt ON attempt.attempt_id = run.attempt_id
          WHERE attempt.cycle_id <> event.detection_cycle_id OR run.source_id <> event.source_id) AS event_source_cycle_mismatch_count`),
    sql.query(`SELECT
        ((SELECT count(*) FROM fact.listing_observation_hourly) +
         (SELECT count(*) FROM fact.catalog_presence_daily) +
         (SELECT count(*) FROM fact.top_trader_observation_hourly) +
         (SELECT count(*) FROM fact.traditional_observation_daily))::int AS market_fact_rows,
        ((SELECT count(*) FROM analytics.cohort_version) +
         (SELECT count(*) FROM analytics.cohort_member) +
         (SELECT count(*) FROM analytics.asset_hourly) +
         (SELECT count(*) FROM analytics.asset_daily_volume_anchor) +
         (SELECT count(*) FROM analytics.spot_listing_daily_anchor) +
         (SELECT count(*) FROM analytics.asset_daily_oi_close) +
         (SELECT count(*) FROM analytics.signal_result))::int AS derived_analytics_rows,
        ((SELECT count(*) FROM publication.snapshot_manifest) +
         (SELECT count(*) FROM publication.latest_pointer))::int AS publication_rows,
        ((SELECT count(*) FROM alert.rule) + (SELECT count(*) FROM alert.rule_version) +
         (SELECT count(*) FROM alert.evaluation_run) + (SELECT count(*) FROM alert.event) +
         (SELECT count(*) FROM alert.event_evidence) + (SELECT count(*) FROM alert.incident) +
         (SELECT count(*) FROM alert.incident_event) + (SELECT count(*) FROM alert.destination) +
         (SELECT count(*) FROM alert.subscription) + (SELECT count(*) FROM alert.delivery) +
         (SELECT count(*) FROM alert.outbox) + (SELECT count(*) FROM alert.delivery_attempt))::int AS alert_rows`),
  ];
}

export async function runCatalogShadowReadinessQueries({
  now = new Date(),
  runtimeSnapshot = null,
  runtimeError = null,
  runTransaction = runDatabaseTransaction,
  limit = CATALOG_SHADOW_QUERY_CYCLE_LIMIT,
} = {}) {
  const results = await runTransaction(
    sql => buildCatalogShadowReadinessQueries(sql, limit),
    { isolationLevel: 'Serializable', readOnly: true, deferrable: true, timeoutMs: 25_000 },
  );
  if (!Array.isArray(results) || results.length !== 9) throw new Error('Catalog shadow readiness query bundle is incomplete');
  return buildCatalogShadowReadiness({
    now,
    cycleRows: results[0],
    attemptRows: results[1],
    sourceRows: results[2],
    membershipRows: results[3],
    sinkRows: results[4],
    changeRows: results[5],
    eventRows: results[6],
    integrityRow: results[7]?.[0] || {},
    laterPhaseRow: results[8]?.[0] || {},
    runtimeSnapshot,
    runtimeError,
  });
}

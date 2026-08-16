import { LISTING_AUDIT_SCHEMA_VERSION, LISTING_SOURCE_KEYS } from './listing-audit.js';
import {
  LISTING_PG_ENDPOINT_KEY,
  LISTING_PG_JOB_NAME,
  LISTING_NORMALIZED_ARTIFACT_FORMAT,
  LISTING_PG_PIPELINE_VERSION,
  LISTING_PG_PUBLICATION_LEASE_SECONDS,
} from './listing-pg-shadow.js';
import { runDatabaseTransaction } from './database.js';

export const CATALOG_SHADOW_READINESS_SCHEMA_VERSION = 'rwa-catalog-shadow-readiness/v2';
export const CATALOG_SHADOW_CAPABILITY_MINIMUMS = Object.freeze({
  baselineCatalog: 1,
  newListingDetection: 2,
  confirmedDelistLiveWindow: 3,
});
export const CATALOG_SHADOW_OPERATIONAL_POLICY = Object.freeze({
  shadowExpansion: 3,
  requiredMode: 7,
  readCutover: 7,
});
export const CATALOG_SHADOW_QUERY_CYCLE_LIMIT = 30;
export const CATALOG_SHADOW_MAX_LATEST_AGE_HOURS = 36;
export const CATALOG_SHADOW_EXPECTED_SINKS = Object.freeze([
  'postgres-catalog-shadow',
  'blob-normalized-catalog',
  'runtime-cache-listing-audit',
]);

const EXPECTED_SOURCE_KEYS = Object.freeze([...LISTING_SOURCE_KEYS].sort());
const DAY_MS = 86_400_000;
const MIN_QUERY_CYCLES = Math.max(...Object.values(CATALOG_SHADOW_OPERATIONAL_POLICY));

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

function optionalBoolean(input) {
  if (input === true || input === false) return input;
  if (input === 1 || input === '1' || input === 't' || input === 'true') return true;
  if (input === 0 || input === '0' || input === 'f' || input === 'false') return false;
  return null;
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

function stringArray(input) {
  if (Array.isArray(input)) return sortedUnique(input);
  if (typeof input !== 'string' || !input.trim()) return [];
  try {
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed)) return sortedUnique(parsed);
  } catch {
    // PostgreSQL text arrays are returned as `{A,B}` by some clients.
  }
  const value = input.trim();
  if (value.startsWith('{') && value.endsWith('}')) {
    return sortedUnique(value.slice(1, -1).split(',').map(item => item.replace(/^"|"$/g, '').trim()));
  }
  return [value];
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
      publicationLease: null,
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
    publicationLease: runtimeSnapshot?.persistence?.publicationLease &&
      typeof runtimeSnapshot.persistence.publicationLease === 'object'
      ? {
          mode:String(runtimeSnapshot.persistence.publicationLease.mode || ''),
          status:String(runtimeSnapshot.persistence.publicationLease.status || ''),
          enforced:optionalBoolean(runtimeSnapshot.persistence.publicationLease.enforced),
          ttlSeconds:nonNegativeInteger(runtimeSnapshot.persistence.publicationLease.ttlSeconds),
        }
      : null,
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

function sourceRunHealth(row) {
  const endpointKey = value(row, 'endpoint_key', 'endpointKey');
  const runStatus = value(row, 'run_status', 'runStatus');
  const catalogStatus = value(row, 'catalog_status', 'catalogStatus');
  const identityStatus = value(row, 'identity_status', 'identityStatus');
  const rawStatus = value(row, 'raw_status', 'rawStatus');
  const mergedStatus = value(row, 'merged_status', 'mergedStatus');
  const errorCodes = stringArray(value(row, 'error_codes', 'errorCodes'));
  const rejectedListingCount = nonNegativeInteger(value(row, 'rejected_listing_count', 'rejectedListingCount'));
  const reviewCaseCount = nonNegativeInteger(value(row, 'review_case_count', 'reviewCaseCount'));
  const persistedPendingRemovalCount = nonNegativeInteger(
    value(row, 'persisted_pending_removal_count', 'persistedPendingRemovalCount'),
  );
  const endpointValid = endpointKey === LISTING_PG_ENDPOINT_KEY;
  const pendingRemoval = catalogStatus === 'partial' && mergedStatus === 'partial' &&
    errorCodes.includes('CATALOG_PARTIAL') && persistedPendingRemovalCount > 0;
  const reviewIsolation = identityStatus === 'partial' &&
    errorCodes.includes('SOURCE_IDENTITY_PARTIAL') &&
    errorCodes.includes('IDENTITY_REVIEW_REQUIRED') &&
    reviewCaseCount !== null && reviewCaseCount > 0 &&
    rejectedListingCount === reviewCaseCount;
  const expectedErrors = sortedUnique([
    ...(pendingRemoval ? ['CATALOG_PARTIAL'] : []),
    ...(reviewIsolation ? ['SOURCE_IDENTITY_PARTIAL', 'IDENTITY_REVIEW_REQUIRED'] : []),
  ]);
  const catalogTrusted = pendingRemoval ||
    (catalogStatus === 'full' && ['full', 'warming'].includes(mergedStatus));
  const identityTrusted = reviewIsolation ||
    (identityStatus === 'full' && reviewCaseCount === 0 && rejectedListingCount === 0);
  const expectedRunStatus = pendingRemoval || reviewIsolation ? 'partial' : 'full';
  const trusted = endpointValid && persistedPendingRemovalCount !== null &&
    rawStatus === 'full' && catalogTrusted && identityTrusted &&
    runStatus === expectedRunStatus && sameStrings(errorCodes, expectedErrors);
  const full = trusted && !pendingRemoval && !reviewIsolation;
  return {
    full,
    pendingRemoval,
    reviewIsolation,
    trustedPendingRemoval: trusted && pendingRemoval,
    trustedReviewIsolation: trusted && reviewIsolation,
    trusted,
    endpointValid,
    runStatus,
    catalogStatus,
    identityStatus,
    rawStatus,
    mergedStatus,
    errorCodes,
    rejectedListingCount,
    reviewCaseCount,
    persistedPendingRemovalCount,
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
  const notes = [];

  const attemptIds = sortedUnique(attempts.map(row => value(row, 'attempt_id', 'attemptId')));
  const attemptNos = sortedUnique(attempts.map(row => String(value(row, 'attempt_no', 'attemptNo') ?? '')));
  const attemptStatuses = sortedUnique(attempts.map(row => value(row, 'attempt_status', 'attemptStatus')));
  const attemptCompletedAt = isoTimestamp(value(attempts[0], 'attempt_completed_at', 'attemptCompletedAt'));

  const sourceKeys = sources.map(row => value(row, 'source_key', 'sourceKey'));
  const duplicateSources = sourceKeys.filter((sourceKey, index) => sourceKeys.indexOf(sourceKey) !== index);
  const sourceHealth = sources.map(row => ({ row, ...sourceRunHealth(row) }));
  const fullSourceCount = sourceHealth.filter(row => row.full).length;
  const pendingRemovalSources = sourceHealth
    .filter(row => row.trusted && row.pendingRemoval)
    .map(row => String(value(row.row, 'source_key', 'sourceKey') || ''))
    .sort();
  const reviewIsolationSources = sourceHealth
    .filter(row => row.trusted && row.reviewIsolation)
    .map(row => String(value(row.row, 'source_key', 'sourceKey') || ''))
    .sort();
  const trustedSourceCount = sourceHealth.filter(row => row.trusted).length;
  if (sources.length !== EXPECTED_SOURCE_KEYS.length || duplicateSources.length || !sameStrings(sourceKeys, EXPECTED_SOURCE_KEYS)) {
    reasons.push('source_run set is not the exact ten-source catalog set');
  }
  if (trustedSourceCount !== EXPECTED_SOURCE_KEYS.length) {
    reasons.push('one or more source_run rows are neither Full nor a trusted pending-removal Partial');
  }
  if (pendingRemovalSources.length) {
    notes.push(`trusted pending-removal observation: ${pendingRemovalSources.join(', ')}`);
  }
  if (reviewIsolationSources.length) {
    notes.push(`trusted review isolation: ${reviewIsolationSources.join(', ')}`);
  }
  const expectedAttemptStatus = fullSourceCount === EXPECTED_SOURCE_KEYS.length ? 'complete' : 'partial';
  const attemptIdempotent = attemptIds.length === 1 && attemptNos.length === 1 &&
    attemptNos[0] === '1' && attemptStatuses.length === 1 &&
    attemptStatuses[0] === expectedAttemptStatus && Boolean(attemptCompletedAt);
  if (!attemptIdempotent) {
    reasons.push(`same-day retry did not conserve one ${expectedAttemptStatus} idempotent attempt_no=1`);
  }
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
    eventEligibleAdded: changes.reduce((sum, row) => sum + integer(value(row, 'event_eligible_added_count', 'eventEligibleAddedCount')), 0),
    pendingEventAdded: changes.reduce((sum, row) => sum + integer(value(row, 'pending_event_added_count', 'pendingEventAddedCount')), 0),
    pendingReview: changes.reduce((sum, row) => sum + integer(value(row, 'pending_review_count', 'pendingReviewCount')), 0),
    pendingIdentityResolved: changes.reduce((sum, row) => sum + integer(value(row, 'pending_identity_resolved_count', 'pendingIdentityResolvedCount')), 0),
    identityResolvedAdded: changes.reduce((sum, row) => sum + integer(value(row, 'identity_resolved_added_count', 'identityResolvedAddedCount')), 0),
    changedSources: changes.filter(row => integer(value(row, 'added_count', 'addedCount')) || integer(value(row, 'removed_count', 'removedCount'))).length,
    comparableSources: changes.filter(row => value(row, 'previous_cycle_id', 'previousCycleId')).length,
    sources: EXPECTED_SOURCE_KEYS.map(sourceKey => {
      const row = changeBySource.get(sourceKey);
      return {
        sourceKey,
        comparable: Boolean(value(row, 'previous_cycle_id', 'previousCycleId')),
        added: nonNegativeInteger(value(row, 'added_count', 'addedCount')),
        removed: nonNegativeInteger(value(row, 'removed_count', 'removedCount')),
        eventEligibleAdded: nonNegativeInteger(value(row, 'event_eligible_added_count', 'eventEligibleAddedCount')),
        pendingEventAdded: nonNegativeInteger(value(row, 'pending_event_added_count', 'pendingEventAddedCount')),
        pendingReview: nonNegativeInteger(value(row, 'pending_review_count', 'pendingReviewCount')),
        pendingIdentityResolved: nonNegativeInteger(value(row, 'pending_identity_resolved_count', 'pendingIdentityResolvedCount')),
        identityResolvedAdded: nonNegativeInteger(value(row, 'identity_resolved_added_count', 'identityResolvedAddedCount')),
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
  const sourceHealthByKey = new Map(sourceHealth.map(row => [
    String(value(row.row, 'source_key', 'sourceKey') || ''),
    row,
  ]));
  for (const lifecycleSource of lifecycle.sources) {
    if (!EXPECTED_SOURCE_KEYS.includes(lifecycleSource.sourceKey)) reasons.push(`${lifecycleSource.sourceKey || 'unknown'} lifecycle event source is outside the exact ten-source set`);
  }
  for (const change of changeSummary.sources) {
    const currentSourceHealth = sourceHealthByKey.get(change.sourceKey);
    if (!currentSourceHealth?.trustedPendingRemoval) continue;
    const classifiedPending = [
      change.pendingEventAdded,
      change.pendingReview,
      change.pendingIdentityResolved,
    ];
    if (classifiedPending.some(count => count === null)) {
      reasons.push(`${change.sourceKey} pending-removal classification counts are missing`);
      continue;
    }
    const classifiedPendingCount = classifiedPending.reduce((sum, count) => sum + count, 0);
    if (!change.comparable) {
      // A first-day source can have an accepted member become pending after
      // its baseline write. Without a prior cycle that accepted candidate is
      // intentionally not called a removal, but exact review/event/resolution
      // subclasses must still be present and may never exceed the persisted
      // pending cohort.
      if (currentSourceHealth.persistedPendingRemovalCount === null ||
        classifiedPendingCount > currentSourceHealth.persistedPendingRemovalCount) {
        reasons.push(`${change.sourceKey} baseline pending-removal classifications exceed the persisted pending cohort`);
      }
    }
  }
  if (changeSummary.comparableSources === EXPECTED_SOURCE_KEYS.length) {
    for (const change of changeSummary.sources) {
      const sourceLifecycle = lifecycleBySource.get(change.sourceKey) || { listed: 0, relisted: 0 };
      const currentSourceHealth = sourceHealthByKey.get(change.sourceKey);
      const pendingAdditionAllowance = currentSourceHealth?.trustedPendingRemoval
        ? change.pendingEventAdded
        : 0;
      if (change.added === null || change.removed === null || change.eventEligibleAdded === null ||
        change.pendingEventAdded === null || change.pendingReview === null || change.pendingIdentityResolved === null ||
        change.identityResolvedAdded === null) {
        reasons.push(`${change.sourceKey} catalog membership change counts are missing`);
      } else if (currentSourceHealth?.trustedPendingRemoval &&
        currentSourceHealth.persistedPendingRemovalCount !== change.removed + change.pendingEventAdded +
          change.pendingReview + change.pendingIdentityResolved) {
        reasons.push(`${change.sourceKey} persisted pending cohort does not equal prior removals plus same-day pending listed/review/resolved candidates`);
      } else if (change.eventEligibleAdded + change.identityResolvedAdded > change.added + pendingAdditionAllowance) {
        reasons.push(`${change.sourceKey} event-eligible plus identity-resolved additions exceed accepted plus exact pending additions`);
      } else if (change.eventEligibleAdded !== sourceLifecycle.listed + sourceLifecycle.relisted) {
        reasons.push(`${change.sourceKey} accepted membership additions eligible for lifecycle events do not match listed and relisted lifecycle events`);
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

  const expectedCycleStatus = fullSourceCount === EXPECTED_SOURCE_KEYS.length ? 'complete' : 'partial';
  if (value(cycleRow, 'cycle_status', 'cycleStatus') !== expectedCycleStatus) {
    reasons.push(`collection_cycle is not ${expectedCycleStatus} for its source state`);
  }
  const infrastructureHealthy = reasons.length === 0;
  const healthStatus = !infrastructureHealthy
    ? 'failed'
    : pendingRemovalSources.length && reviewIsolationSources.length
      ? 'trusted-pending-removal-review-isolation'
      : pendingRemovalSources.length
        ? 'trusted-pending-removal'
        : reviewIsolationSources.length ? 'trusted-review-isolation' : 'healthy';
  return {
    cycleId,
    utcDay: utcDay(bucketAt),
    bucketAt,
    status: value(cycleRow, 'cycle_status', 'cycleStatus') || 'unknown',
    success: infrastructureHealthy,
    infrastructureHealthy,
    healthStatus,
    reasons: sortedUnique(reasons),
    notes: sortedUnique(notes),
    pendingRemoval: {
      active: pendingRemovalSources.length > 0,
      count: pendingRemovalSources.length,
      sources: pendingRemovalSources,
    },
    reviewIsolation: {
      active: reviewIsolationSources.length > 0,
      count: reviewIsolationSources.length,
      sources: reviewIsolationSources,
    },
    attempts: {
      count: attemptIds.length,
      attemptNos: attemptNos.map(Number).filter(Number.isInteger),
      statuses: attemptStatuses,
      completedAt: attemptCompletedAt,
      idempotent: attemptIdempotent,
    },
    sourceRuns: {
      expected: EXPECTED_SOURCE_KEYS.length,
      observed: sources.length,
      full: fullSourceCount,
      trusted: trustedSourceCount,
      trustedPendingRemoval: pendingRemovalSources.length,
      trustedReviewIsolation: reviewIsolationSources.length,
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
        reviewCaseCount: nonNegativeInteger(value(row, 'review_case_count', 'reviewCaseCount')),
        healthStatus: (() => {
          const health = sourceRunHealth(row);
          if (health.full) return 'full';
          if (health.trustedPendingRemoval && health.trustedReviewIsolation) return 'trusted-pending-removal-review-isolation';
          if (health.trustedPendingRemoval) return 'trusted-pending-removal';
          if (health.trustedReviewIsolation) return 'trusted-review-isolation';
          return 'failed';
        })(),
        rawStatus: value(row, 'raw_status', 'rawStatus'),
        mergedStatus: value(row, 'merged_status', 'mergedStatus'),
        errorCodes: stringArray(value(row, 'error_codes', 'errorCodes')),
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
  if (runtime.publicationLease?.mode !== 'postgres-distributed-lease' ||
    runtime.publicationLease?.status !== 'enforced' ||
    runtime.publicationLease?.enforced !== true ||
    runtime.publicationLease?.ttlSeconds !== LISTING_PG_PUBLICATION_LEASE_SECONDS) {
    reasons.push(`Runtime Cache publication was not protected by the required ${LISTING_PG_PUBLICATION_LEASE_SECONDS}-second PostgreSQL lease`);
  }
  const latestSources = sourceRows.filter(row => String(value(row, 'cycle_id', 'cycleId')) === latestCycle.cycleId);
  const latestMemberships = new Map(membershipRows
    .filter(row => String(value(row, 'cycle_id', 'cycleId')) === latestCycle.cycleId)
    .map(row => [String(value(row, 'source_key', 'sourceKey')), row]));
  const latestChanges = new Map(latestCycle.changes.sources.map(row => [row.sourceKey, row]));
  const runtimeSources = new Map(runtime.sources.map(row => [String(row?.sourceKey || ''), row]));
  if (!sameStrings([...runtimeSources.keys()], EXPECTED_SOURCE_KEYS)) reasons.push('Runtime Cache source set is not the exact ten sources');
  let expectedActiveListings = 0;
  for (const source of latestSources) {
    const sourceKey = String(value(source, 'source_key', 'sourceKey') || '');
    const publicSource = runtimeSources.get(sourceKey);
    const membership = latestMemberships.get(sourceKey);
    const admitted = nonNegativeInteger(value(source, 'admitted_listing_count', 'admittedListingCount'));
    const withheld = nonNegativeInteger(value(source, 'withheld_from_membership', 'withheldFromMembership'));
    const sourceHealth = sourceRunHealth(source);
    const sourceChange = latestChanges.get(sourceKey);
    if (!publicSource) continue;
    if (publicSource.status !== value(source, 'merged_status', 'mergedStatus')) reasons.push(`${sourceKey} Runtime status differs from stored merge status`);
    const runtimeListingCount = nonNegativeInteger(publicSource.listingCount);
    const membershipCount = nonNegativeInteger(value(membership, 'membership_count', 'membershipCount'));
    const pendingRemovalCount = nonNegativeInteger(publicSource.pendingRemovalCount);
    if (admitted === null || withheld === null || runtimeListingCount === null || runtimeListingCount !== admitted + withheld) {
      reasons.push(`${sourceKey} Runtime listing count does not equal the exact source cohort total (admitted + withheld rows)`);
    }
    if (admitted === null || membershipCount === null || membershipCount !== admitted) {
      reasons.push(`${sourceKey} database membership differs from admitted rows`);
    }
    if (pendingRemovalCount === null) {
      reasons.push(`${sourceKey} Runtime pending-removal count is missing or invalid`);
    } else if (sourceHealth.trustedPendingRemoval) {
      const expectedPendingCount = !sourceChange?.comparable || sourceChange?.removed === null ||
        sourceChange?.pendingEventAdded === null || sourceChange?.pendingReview === null ||
        sourceChange?.pendingIdentityResolved === null
        ? null
        : sourceChange.removed + sourceChange.pendingEventAdded + sourceChange.pendingReview +
          sourceChange.pendingIdentityResolved;
      if (pendingRemovalCount <= 0 || pendingRemovalCount !== sourceHealth.persistedPendingRemovalCount ||
        (sourceChange?.comparable && (expectedPendingCount === null || pendingRemovalCount !== expectedPendingCount))) {
        reasons.push(`${sourceKey} Runtime pending-removal count does not match prior removals plus same-day pending listed/review candidates`);
      }
    } else if (pendingRemovalCount !== 0) {
      reasons.push(`${sourceKey} Runtime reports pending removals for a non-pending source run`);
    }
    if (admitted === null || withheld === null || pendingRemovalCount === null) expectedActiveListings = NaN;
    else if (Number.isFinite(expectedActiveListings)) expectedActiveListings += admitted + withheld + pendingRemovalCount;
  }
  if (!Number.isFinite(expectedActiveListings) || runtime.activeListings !== expectedActiveListings) {
    reasons.push('Runtime active listing count does not equal admitted + withheld + pending-removal rows');
  }
  const runtimeSink = sinkRows.find(row =>
    String(value(row, 'cycle_id', 'cycleId')) === latestCycle.cycleId &&
    value(row, 'sink_name', 'sinkName') === 'runtime-cache-listing-audit'
  );
  const sinkRowCount = runtimeSink
    ? nonNegativeInteger(value(runtimeSink, 'row_count', 'rowCount'))
    : null;
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

function capabilityState(minimumHealthyUtcCycles, observedHealthyUtcCycles, totalHealthyUtcCycles, ready, blocked, detail) {
  return {
    minimumHealthyUtcCycles,
    observedHealthyUtcCycles,
    totalHealthyUtcCycles,
    ready: Boolean(ready && !blocked),
    status: blocked ? 'blocked' : ready ? 'ready' : 'warming',
    detail,
  };
}

function operationalPolicyState(minimumConsecutiveHealthyUtcCycles, observedConsecutiveHealthyUtcCycles, blocked) {
  const ready = !blocked && observedConsecutiveHealthyUtcCycles >= minimumConsecutiveHealthyUtcCycles;
  return {
    minimumConsecutiveHealthyUtcCycles,
    observedConsecutiveHealthyUtcCycles,
    ready,
    status: blocked ? 'blocked' : ready ? 'ready' : 'warming',
    policyOnly: true,
  };
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
    .sort((left, right) => Date.parse(value(right, 'bucket_at', 'bucketAt')) - Date.parse(value(left, 'bucket_at', 'bucketAt')));
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
    if (!cycles[index].infrastructureHealthy) break;
    if (index > 0 && Date.parse(`${cycles[index - 1].utcDay}T00:00:00Z`) - Date.parse(`${cycles[index].utcDay}T00:00:00Z`) !== DAY_MS) break;
    consecutive += 1;
  }
  const latest = cycles[0] || null;
  const latestAgeHours = latest ? (Date.parse(nowIso) - Date.parse(latest.attempts.completedAt || latest.bucketAt)) / 3_600_000 : null;
  const runtime = runtimeComparison(normalizedRuntime(runtimeSnapshot, runtimeError), latest, sourceRows, membershipRows, sinkRows);
  const integrityFailures = integrityReasons(integrityRow);
  const laterPhaseTables = {
    marketFactRowsPresent: optionalBoolean(value(laterPhaseRow, 'market_fact_rows_present', 'marketFactRowsPresent')),
    derivedAnalyticsRowsPresent: optionalBoolean(value(laterPhaseRow, 'derived_analytics_rows_present', 'derivedAnalyticsRowsPresent')),
    publicationRowsPresent: optionalBoolean(value(laterPhaseRow, 'publication_rows_present', 'publicationRowsPresent')),
    alertRowsPresent: optionalBoolean(value(laterPhaseRow, 'alert_rows_present', 'alertRowsPresent')),
  };
  const laterPhasePresenceKnown = Object.values(laterPhaseTables).every(present => present !== null);
  const laterPhaseDomainsPresent = laterPhasePresenceKnown
    ? Object.values(laterPhaseTables).filter(Boolean).length
    : null;
  const laterPhaseTablesEmpty = laterPhasePresenceKnown ? laterPhaseDomainsPresent === 0 : null;
  const historicalFailedCycles = cycles.filter(row => !row.infrastructureHealthy);
  const healthyCycles = cycles.filter(row => row.infrastructureHealthy);
  const latestConsecutiveHealthyCycles = cycles.slice(0, consecutive);
  const hardFailures = [];
  if (duplicateUtcDays.length) hardFailures.push('duplicate UTC collection cycles exist');
  if (latest && !latest.infrastructureHealthy) hardFailures.push('latest catalog cycle failed current Phase 1 conservation');
  if (latestAgeHours !== null && (latestAgeHours < -0.1 || latestAgeHours > CATALOG_SHADOW_MAX_LATEST_AGE_HOURS)) hardFailures.push('latest PostgreSQL cycle is stale or future-dated');
  if (cycles.length && runtime.match !== true) hardFailures.push('latest Runtime Cache snapshot does not reconcile with PostgreSQL');
  hardFailures.push(...integrityFailures);
  const currentEvidenceHealthy = Boolean(latest && latest.infrastructureHealthy && hardFailures.length === 0);
  const baselineReady = currentEvidenceHealthy && consecutive >= CATALOG_SHADOW_CAPABILITY_MINIMUMS.baselineCatalog;
  const newListingReady = currentEvidenceHealthy &&
    consecutive >= CATALOG_SHADOW_CAPABILITY_MINIMUMS.newListingDetection &&
    latestConsecutiveHealthyCycles[0]?.changes?.comparableSources === EXPECTED_SOURCE_KEYS.length;
  const confirmedDelistWindowReady = currentEvidenceHealthy &&
    consecutive >= CATALOG_SHADOW_CAPABILITY_MINIMUMS.confirmedDelistLiveWindow &&
    latestConsecutiveHealthyCycles.slice(0, 2).every(row =>
      row.changes.comparableSources === EXPECTED_SOURCE_KEYS.length);
  const readyForPhase2DesignReview = currentEvidenceHealthy;
  const status = hardFailures.length ? 'fail' : latest ? 'pass' : 'warming';
  const capabilityBlocked = hardFailures.length > 0;
  const capabilities = {
    baselineCatalog: capabilityState(
      CATALOG_SHADOW_CAPABILITY_MINIMUMS.baselineCatalog,
      consecutive,
      healthyCycles.length,
      baselineReady,
      capabilityBlocked,
      baselineReady
        ? 'The minimum healthy observation needed to establish a current catalog baseline is available.'
        : 'One healthy current catalog observation is required to establish the baseline.',
    ),
    newListingDetection: capabilityState(
      CATALOG_SHADOW_CAPABILITY_MINIMUMS.newListingDetection,
      consecutive,
      healthyCycles.length,
      newListingReady,
      capabilityBlocked,
      newListingReady
        ? 'The minimum two-observation comparison window is available; this does not claim that a new listing occurred.'
        : 'The latest two scheduled UTC observations must be consecutive and the newest must have an exact ten-source previous-cycle comparison. A comparison across a gap can still show changes since the last good observation but does not meet the 0–24 hour live-detection window.',
    ),
    confirmedDelistLiveWindow: capabilityState(
      CATALOG_SHADOW_CAPABILITY_MINIMUMS.confirmedDelistLiveWindow,
      consecutive,
      healthyCycles.length,
      confirmedDelistWindowReady,
      capabilityBlocked,
      confirmedDelistWindowReady
        ? 'The minimum live state-machine window is available; a real delist still requires D0 present and the same exact listing missing on D1 and D2.'
        : 'The latest three scheduled UTC observations must be consecutive and the newest two must each have exact ten-source comparisons. Older comparisons can still show changes since the last good observation but do not meet the 0–24/24–48 hour live-confirmation window.',
    ),
    phase2DesignReview: {
      elapsedGate: false,
      ready: readyForPhase2DesignReview,
      status: capabilityBlocked ? 'blocked' : readyForPhase2DesignReview ? 'ready' : 'warming',
      detail: readyForPhase2DesignReview
        ? 'Current catalog shadow evidence is healthy enough for a separate Phase 2 design review; no writer or read path is enabled.'
        : 'A healthy current catalog cycle and Runtime Cache reconciliation are required; elapsed time is not a gate.',
    },
  };
  const operationalPolicies = Object.fromEntries(Object.entries(CATALOG_SHADOW_OPERATIONAL_POLICY).map(([name, minimum]) => [
    name,
    operationalPolicyState(minimum, consecutive, capabilityBlocked),
  ]));
  const handoff = {
    laterPhaseTables,
    laterPhaseDomainsPresent,
    laterPhaseTablesEmpty,
    presenceOnly: true,
    status: !laterPhasePresenceKnown ? 'unavailable' : laterPhaseTablesEmpty ? 'clear' : 'active',
    blocking: false,
    detail: !laterPhasePresenceKnown
      ? 'Later-phase table presence was not available for this informational handoff check.'
      : laterPhaseTablesEmpty
        ? 'Later-phase tables are empty at this handoff observation.'
        : 'One or more later-phase domains contain rows. This bounded presence probe is not an exact row count and is not a permanent self-failing readiness gate after Phase 2 starts.',
  };
  const checks = [
    check('current-cycle-health', !latest ? 'warming' : latest.infrastructureHealthy ? 'pass' : 'fail',
      !latest ? 'No PostgreSQL catalog cycle exists yet' : latest.infrastructureHealthy
        ? `Latest cycle is ${latest.healthStatus}` : latest.reasons.join('; ')),
    check('utc-cycle-continuity', duplicateUtcDays.length ? 'fail' : !cycles.length ? 'warming' : gaps.length || historicalFailedCycles.length ? 'warming' : 'pass',
      !cycles.length
        ? 'No PostgreSQL catalog cycle exists yet'
        : `${consecutive} latest UTC cycles are consecutive infrastructure-healthy observations; gaps or failed historical cycles reset only operational policy streaks`,
      { duplicateUtcDays: sortedUnique(duplicateUtcDays), gaps, historicalFailedCycleIds:historicalFailedCycles.map(row => row.cycleId) }),
    check('ten-source-runs', latest && (latest.sourceRuns.observed !== 10 || latest.sourceRuns.trusted !== 10 || latest.reasons.some(reason => reason.includes('source counts'))) ? 'fail' : latest ? 'pass' : 'warming',
      'The current cycle contains ten trusted source runs; pending-removal and review-isolation Partials are accepted only with Full upstream plus exact membership, review and identity evidence'),
    check('three-sink-outcomes', latest && (CATALOG_SHADOW_EXPECTED_SINKS.some(name => latest.sinks.statuses[name] !== 'stored') || latest.reasons.some(reason => reason.includes('sink row count'))) ? 'fail' : latest ? 'pass' : 'warming',
      'PostgreSQL, normalized artifact and Runtime Cache sinks are independently stored'),
    check('artifact-evidence-lineage', latest?.reasons.some(reason => reason.includes('artifact') || reason.includes('official-catalog evidence')) ? 'fail' : latest ? 'pass' : 'warming',
      'Every source run has a stored normalized-catalog-v1 artifact manifest and exact official-catalog evidence for accepted membership'),
    check('membership-conservation', latest?.reasons.some(reason => reason.includes('membership')) ? 'fail' : latest ? 'pass' : 'warming',
      'Accepted source counts equal exact verified membership rows'),
    check('runtime-cache-reconciliation', runtime.match === true ? 'pass' : cycles.length ? 'fail' : 'warming',
      runtime.match === true ? 'Latest public Runtime Cache counts, sources and timestamp match sink evidence' : runtime.reasons.join('; ')),
    check('same-day-idempotency', latest && !latest.attempts.idempotent ? 'fail' : latest ? 'pass' : 'warming',
      'Same UTC day reuses one attempt_no=1 and unique source/sink/membership keys'),
    check('lifecycle-scd2', integrityFailures.length || latest?.lifecycle.invalid || latest?.reasons.some(reason => reason.includes('lifecycle event') || reason.includes('membership additions')) ? 'fail' : latest ? 'pass' : 'warming',
      'Cross-day catalog events and instrument SCD2 intervals retain exact source/version lineage', { integrityFailures }),
    check('later-phase-handoff', !laterPhasePresenceKnown ? 'warming' : laterPhaseTablesEmpty ? 'pass' : 'informational',
      handoff.detail, { ...laterPhaseTables, blocking:false }),
  ];

  return {
    schemaVersion: CATALOG_SHADOW_READINESS_SCHEMA_VERSION,
    generatedAt: nowIso,
    status,
    readyForPhase2: readyForPhase2DesignReview,
    readyForPhase2DesignReview,
    decision: readyForPhase2DesignReview
      ? 'Eligible for Phase 2 design review; this does not enable a writer or read cutover.'
      : status === 'warming'
        ? 'No healthy current catalog observation exists yet; no writer or read cutover is authorized.'
        : 'Current Phase 1 reconciliation failed; investigate before any design handoff.',
    scope: {
      phase: 'phase1-catalog-shadow',
      expectedSourcesPerCycle: EXPECTED_SOURCE_KEYS.length,
      expectedSourceKeys: [...EXPECTED_SOURCE_KEYS],
      expectedSinks: [...CATALOG_SHADOW_EXPECTED_SINKS],
      marketFactsChecked: false,
      rollingMarketHistoryVerified: false,
      phase2DesignElapsedGate: false,
      laterPhaseTablesConfirmedEmpty: laterPhaseTablesEmpty === true,
    },
    capabilities,
    operations: {
      cadence:'utc-daily',
      consecutiveHealthyUtcCycles:consecutive,
      gapReset:gaps.length > 0 || historicalFailedCycles.length > 0,
      gaps,
      policies:operationalPolicies,
    },
    handoff,
    progress: {
      windowKind: 'latest-utc-cycle-observations',
      evaluatedUtcCycles: cycles.length,
      healthyUtcCycles: healthyCycles.length,
      consecutiveHealthyUtcCycles: consecutive,
      currentCycleHealthy: latest?.infrastructureHealthy ?? null,
      currentCycleHealthStatus: latest?.healthStatus || 'warming',
      latestUtcDay: latest?.utcDay || null,
      latestAgeHours: latestAgeHours === null || !Number.isFinite(latestAgeHours) ? null : Number(latestAgeHours.toFixed(2)),
      observationStartedAt: cycles.at(-1)?.bucketAt || null,
    },
    checks,
    runtimeCache: runtime,
    cycles,
    failures: sortedUnique(hardFailures),
    notices: sortedUnique([
      ...(gaps.length ? [`operational continuity reset by UTC gaps: ${gaps.join(', ')}`] : []),
      ...(historicalFailedCycles.length ? [`operational continuity reset by ${historicalFailedCycles.length} historical failed cycle(s)`] : []),
      ...(latest?.pendingRemoval?.active ? [`latest cycle contains trusted pending removals for ${latest.pendingRemoval.sources.join(', ')}`] : []),
      ...(latest?.reviewIsolation?.active ? [`latest cycle contains trusted review isolation for ${latest.reviewIsolation.sources.join(', ')}`] : []),
      ...(laterPhasePresenceKnown && !laterPhaseTablesEmpty ? [`${laterPhaseDomainsPresent} later-phase domain(s) contain rows; bounded presence probe for informational handoff only`] : []),
    ]),
    limitations: [
      'Phase 1 checks catalog shadow data only; it does not collect or validate price, volume, OI, funding, reference or traditional-market facts.',
      'No rolling market history is stored in Phase 1, so this report does not claim to reconcile or replay market-history revisions.',
      'The public Runtime Cache payload does not expose the private bundle checksum; reconciliation uses exact source keys, timestamps, active counts and recorded sink evidence.',
      'Stored normalized-catalog artifact manifests and official-catalog evidence are checked by metadata and foreign-key lineage only; this report does not download and replay Blob contents.',
      'Capability readiness means the minimum comparison window exists; it does not claim that a new listing or delisting occurred.',
      'Operational 3/7/7 streaks are policy gates only. readyForPhase2DesignReview has no elapsed-time gate and never enables a writer, read cutover or alert delivery.',
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
  if (!Number.isInteger(limit) || limit < MIN_QUERY_CYCLES || limit > 90) {
    throw new RangeError(`cycle query limit must be an integer from ${MIN_QUERY_CYCLES} through 90`);
  }
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
        run.rejected_listing_count, run.error_codes,
        run.metadata->>'rawStatus' AS raw_status,
        run.metadata->>'mergedStatus' AS merged_status,
        COALESCE((run.metadata->>'withheldFromMembership')::int, 0) AS withheld_from_membership,
        COALESCE((run.metadata->>'pendingRemovalCount')::int, 0) AS persisted_pending_removal_count,
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
            )) AS missing_official_evidence_count,
        (SELECT count(*)::int
          FROM identity.review_case AS review
          WHERE review.source_id = run.source_id
            AND review.status = 'open'
            AND review.candidate_payload->>'listingSourceKey' = source.source_key
            AND NULLIF(review.candidate_payload->>'observedAt', '')::timestamptz = run.completed_at
        ) AS review_case_count
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
        SELECT cycle.cycle_id, run.source_id, instrument_version.instrument_id,
          instrument_version.valid_from, cycle.bucket_at AS cycle_bucket_at
        FROM recent_cycles AS cycle
        JOIN ingest.collection_attempt AS attempt ON attempt.cycle_id = cycle.cycle_id
        JOIN ingest.source_run AS run ON run.attempt_id = attempt.attempt_id
        JOIN ingest.catalog_membership AS membership ON membership.source_run_id = run.source_run_id
        JOIN identity.instrument_version AS instrument_version ON instrument_version.instrument_version_id = membership.instrument_version_id
      ), pending_set AS (
        SELECT cycle.cycle_id, run.source_id,
          pending.normalized_venue_symbol
        FROM recent_cycles AS cycle
        JOIN ingest.collection_attempt AS attempt ON attempt.cycle_id = cycle.cycle_id
        JOIN ingest.source_run AS run ON run.attempt_id = attempt.attempt_id
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(run.metadata->'pendingRemovalVenueSymbols') = 'array'
            THEN run.metadata->'pendingRemovalVenueSymbols'
            ELSE '[]'::jsonb
          END
        ) AS pending(normalized_venue_symbol)
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
        ) END AS removed_count,
        (
          SELECT count(DISTINCT pending_version.instrument_id)::int
          FROM analytics.catalog_change_event AS pending_event
          JOIN identity.instrument_version AS pending_version
            ON pending_version.instrument_version_id = pending_event.instrument_version_id
          JOIN pending_set AS pending
            ON pending.cycle_id = current.cycle_id
           AND pending.source_id = pending_event.source_id
           AND pending.normalized_venue_symbol = pending_version.normalized_venue_symbol
          WHERE pending_event.detection_cycle_id = current.cycle_id
            AND pending_event.source_id = source.source_id
            AND pending_event.event_type IN ('listed', 'relisted')
            AND pending_event.status = 'confirmed'
            AND pending_version.valid_from >= current.bucket_at
            AND pending_version.valid_from < current.bucket_at + interval '1 day'
            AND NOT EXISTS (
              SELECT 1 FROM membership_set AS previous_member
              WHERE previous_member.cycle_id = current.previous_cycle_id
                AND previous_member.source_id = pending_event.source_id
                AND previous_member.instrument_id = pending_version.instrument_id
            )
        ) AS pending_event_added_count,
        (
          SELECT count(DISTINCT review.review_case_id)::int
          FROM pending_set AS pending
          JOIN identity.review_case AS review
            ON review.source_id = pending.source_id
           AND review.status = 'open'
           AND review.candidate_payload->>'normalizedVenueSymbol' = pending.normalized_venue_symbol
          WHERE pending.cycle_id = current.cycle_id
            AND pending.source_id = source.source_id
            AND NOT EXISTS (
              SELECT 1
              FROM identity.instrument AS accepted_instrument
              JOIN identity.instrument_version AS accepted_version
                ON accepted_version.instrument_id = accepted_instrument.instrument_id
               AND accepted_version.valid_to IS NULL
               AND accepted_version.identity_status = 'verified'
              WHERE accepted_instrument.source_id = review.source_id
                AND accepted_instrument.official_product_key = review.candidate_official_product_key
            )
        ) AS pending_review_count,
        (
          SELECT count(DISTINCT resolved_review.review_case_id)::int
          FROM pending_set AS pending
          JOIN identity.review_case AS resolved_review
            ON resolved_review.source_id = pending.source_id
           AND resolved_review.status = 'verified'
           AND resolved_review.decided_at >= current.bucket_at
           AND resolved_review.decided_at < current.bucket_at + interval '1 day'
          JOIN identity.instrument_version AS resolved_version
            ON resolved_version.instrument_id = resolved_review.resolved_instrument_id
           AND resolved_version.normalized_venue_symbol = pending.normalized_venue_symbol
          WHERE pending.cycle_id = current.cycle_id
            AND pending.source_id = source.source_id
            AND NOT EXISTS (
              SELECT 1 FROM membership_set AS previous_member
              WHERE previous_member.cycle_id = current.previous_cycle_id
                AND previous_member.source_id = pending.source_id
                AND previous_member.instrument_id = resolved_review.resolved_instrument_id
            )
        ) AS pending_identity_resolved_count,
        CASE WHEN previous_cycle_id IS NULL THEN NULL ELSE (
          SELECT count(*)::int
          FROM membership_set AS current_member
          WHERE current_member.cycle_id = current.cycle_id
            AND current_member.source_id = source.source_id
            AND current_member.valid_from >= current_member.cycle_bucket_at
            AND current_member.valid_from < current_member.cycle_bucket_at + interval '1 day'
            AND NOT EXISTS (
              SELECT 1 FROM membership_set AS previous_member
              WHERE previous_member.cycle_id = current.previous_cycle_id
                AND previous_member.source_id = current_member.source_id
                AND previous_member.instrument_id = current_member.instrument_id
            )
            AND EXISTS (
              SELECT 1 FROM identity.review_case AS resolved_review
              WHERE resolved_review.source_id = current_member.source_id
                AND resolved_review.resolved_instrument_id = current_member.instrument_id
                AND resolved_review.status = 'verified'
                AND resolved_review.decided_at >= current_member.cycle_bucket_at
                AND resolved_review.decided_at < current_member.cycle_bucket_at + interval '1 day'
            )
        ) END AS identity_resolved_added_count,
        CASE WHEN previous_cycle_id IS NULL THEN NULL ELSE (
          SELECT count(*)::int FROM (
            SELECT current_member.instrument_id
            FROM membership_set AS current_member
            WHERE current_member.cycle_id = current.cycle_id
              AND current_member.source_id = source.source_id
              AND current_member.valid_from >= current_member.cycle_bucket_at
              AND current_member.valid_from < current_member.cycle_bucket_at + interval '1 day'
              AND NOT EXISTS (SELECT 1 FROM membership_set AS previous_member
                WHERE previous_member.cycle_id = current.previous_cycle_id
                  AND previous_member.source_id = current_member.source_id
                  AND previous_member.instrument_id = current_member.instrument_id)
              AND NOT EXISTS (
                SELECT 1 FROM identity.review_case AS resolved_review
                WHERE resolved_review.source_id = current_member.source_id
                  AND resolved_review.resolved_instrument_id = current_member.instrument_id
                  AND resolved_review.status = 'verified'
                  AND resolved_review.decided_at >= current_member.cycle_bucket_at
                  AND resolved_review.decided_at < current_member.cycle_bucket_at + interval '1 day'
              )
            UNION
            SELECT pending_version.instrument_id
            FROM analytics.catalog_change_event AS pending_event
            JOIN identity.instrument_version AS pending_version
              ON pending_version.instrument_version_id = pending_event.instrument_version_id
            JOIN pending_set AS pending
              ON pending.cycle_id = current.cycle_id
             AND pending.source_id = pending_event.source_id
             AND pending.normalized_venue_symbol = pending_version.normalized_venue_symbol
            WHERE pending_event.detection_cycle_id = current.cycle_id
              AND pending_event.source_id = source.source_id
              AND pending_event.event_type IN ('listed', 'relisted')
              AND pending_event.status = 'confirmed'
              AND pending_version.valid_from >= current.bucket_at
              AND pending_version.valid_from < current.bucket_at + interval '1 day'
              AND NOT EXISTS (
                SELECT 1 FROM membership_set AS previous_member
                WHERE previous_member.cycle_id = current.previous_cycle_id
                  AND previous_member.source_id = pending_event.source_id
                  AND previous_member.instrument_id = pending_version.instrument_id
              )
          ) AS event_eligible
        ) END AS event_eligible_added_count
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
        EXISTS(SELECT 1 FROM (
          SELECT 1 FROM fact.listing_observation_hourly
          UNION ALL SELECT 1 FROM fact.catalog_presence_daily
          UNION ALL SELECT 1 FROM fact.top_trader_observation_hourly
          UNION ALL SELECT 1 FROM fact.traditional_observation_daily
        ) AS market_fact_presence LIMIT 1) AS market_fact_rows_present,
        EXISTS(SELECT 1 FROM (
          SELECT 1 FROM analytics.cohort_version
          UNION ALL SELECT 1 FROM analytics.cohort_member
          UNION ALL SELECT 1 FROM analytics.asset_hourly
          UNION ALL SELECT 1 FROM analytics.asset_daily_volume_anchor
          UNION ALL SELECT 1 FROM analytics.spot_listing_daily_anchor
          UNION ALL SELECT 1 FROM analytics.asset_daily_oi_close
          UNION ALL SELECT 1 FROM analytics.signal_result
        ) AS derived_analytics_presence LIMIT 1) AS derived_analytics_rows_present,
        EXISTS(SELECT 1 FROM (
          SELECT 1 FROM publication.snapshot_manifest
          UNION ALL SELECT 1 FROM publication.latest_pointer
        ) AS publication_presence LIMIT 1) AS publication_rows_present,
        EXISTS(SELECT 1 FROM (
          SELECT 1 FROM alert.rule
          UNION ALL SELECT 1 FROM alert.rule_version
          UNION ALL SELECT 1 FROM alert.evaluation_run
          UNION ALL SELECT 1 FROM alert.event
          UNION ALL SELECT 1 FROM alert.event_evidence
          UNION ALL SELECT 1 FROM alert.incident
          UNION ALL SELECT 1 FROM alert.incident_event
          UNION ALL SELECT 1 FROM alert.destination
          UNION ALL SELECT 1 FROM alert.subscription
          UNION ALL SELECT 1 FROM alert.delivery
          UNION ALL SELECT 1 FROM alert.outbox
          UNION ALL SELECT 1 FROM alert.delivery_attempt
        ) AS alert_presence LIMIT 1) AS alert_rows_present`),
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

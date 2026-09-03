import { createHash, randomUUID } from 'node:crypto';

import {
  LISTING_SOURCE_KEYS,
  normalizeListingObservation,
  REVIEWED_PUBLIC_LIFECYCLE_CORRECTIONS,
} from './listing-audit.js';

export const LISTING_PG_JOB_NAME = 'rwa-listing-audit';
export const LISTING_PG_PIPELINE_VERSION = 'rwa-listing-catalog-pg-shadow/v1';
export const LISTING_PG_ENDPOINT_KEY = 'official-catalog';
export const LISTING_NORMALIZED_ARTIFACT_FORMAT = 'normalized-catalog-v1';
export const LISTING_PG_STALE_RETRY_ERROR_CODE = 'STALE_TRUSTED_LISTING_RETRY';
export const LISTING_PG_IDENTITY_DOWNGRADE_ERROR_CODE = 'UNTRUSTED_CATALOG_IDENTITY_DOWNGRADE';
export const LISTING_PG_VERIFIED_IDENTITY_CONFLICT_ERROR_CODE = 'CONFLICTING_VERIFIED_CATALOG_IDENTITY';
export const LISTING_PG_PUBLICATION_LEASE_LOST_ERROR_CODE = 'LISTING_AUDIT_PUBLICATION_LEASE_LOST';
export const LISTING_PG_PUBLICATION_LEASE_KEY = 'listing-audit-runtime-cache';
export const LISTING_PG_PUBLICATION_LEASE_SECONDS = 180;

const PG_WRITE_MODES = new Set(['off', 'shadow', 'required']);
const TRUSTED_SOURCE_STATUSES = new Set(['warming', 'full']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATABASE_CATEGORY = Object.freeze({
  equity: 'equity',
  etf: 'etf',
  commodity: 'commodity',
  index: 'index',
  fx: 'fx',
  bond: 'bond',
  'pre-ipo': 'pre-ipo',
});

function normalized(value) {
  return String(value ?? '').trim();
}

function compareExact(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalized).filter(Boolean))].sort(compareExact);
}

function sameStrings(left, right) {
  const a = sortedUniqueStrings(left);
  const b = sortedUniqueStrings(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function classifyListingAuditSourceRunWritePolicy(sourceRun) {
  const errorCodes = sortedUniqueStrings(sourceRun?.errorCodes);
  const reviewCaseCount = Array.isArray(sourceRun?.reviewCases) ? sourceRun.reviewCases.length : 0;
  const rejectedRowCount = Array.isArray(sourceRun?.rejectedRows) ? sourceRun.rejectedRows.length : 0;
  const pendingRemovalCount = Number.isInteger(sourceRun?.pendingRemovalCount) && sourceRun.pendingRemovalCount >= 0
    ? sourceRun.pendingRemovalCount
    : null;
  const pendingRemoval = sourceRun?.catalogStatus === 'partial' && sourceRun?.mergedStatus === 'partial' &&
    errorCodes.includes('CATALOG_PARTIAL') && pendingRemovalCount !== null && pendingRemovalCount > 0;
  const reviewIsolation = sourceRun?.identityStatus === 'partial' && reviewCaseCount > 0 &&
    rejectedRowCount === 0 && sourceRun?.rejectedListingCount === reviewCaseCount &&
    errorCodes.includes('SOURCE_IDENTITY_PARTIAL') && errorCodes.includes('IDENTITY_REVIEW_REQUIRED');
  const expectedErrors = sortedUniqueStrings([
    ...(pendingRemoval ? ['CATALOG_PARTIAL'] : []),
    ...(reviewIsolation ? ['SOURCE_IDENTITY_PARTIAL', 'IDENTITY_REVIEW_REQUIRED'] : []),
  ]);
  const catalogTrusted = pendingRemoval ||
    (sourceRun?.catalogStatus === 'full' && ['full', 'warming'].includes(sourceRun?.mergedStatus));
  const identityTrusted = reviewIsolation ||
    (sourceRun?.identityStatus === 'full' && reviewCaseCount === 0 &&
      rejectedRowCount === 0 && sourceRun?.rejectedListingCount === 0);
  const expectedStatus = pendingRemoval || reviewIsolation ? 'partial' : 'full';
  const countsConserve = Number.isInteger(sourceRun?.listingCount) && sourceRun.listingCount > 0 &&
    Number.isInteger(sourceRun?.admittedListingCount) && sourceRun.admittedListingCount >= 0 &&
    Number.isInteger(sourceRun?.rejectedListingCount) && sourceRun.rejectedListingCount >= 0 &&
    sourceRun.listingCount === sourceRun.admittedListingCount + sourceRun.rejectedListingCount &&
    Array.isArray(sourceRun?.memberships) && sourceRun.memberships.length === sourceRun.admittedListingCount;
  const trustedLatest = sourceRun?.endpointKey === LISTING_PG_ENDPOINT_KEY && sourceRun?.rawStatus === 'full' &&
    sourceRun?.trustedForMembership === true && catalogTrusted && identityTrusted && countsConserve &&
    sourceRun?.status === expectedStatus && sameStrings(errorCodes, expectedErrors);
  const reasonCodes = [];
  if (sourceRun?.rawStatus !== 'full') reasonCodes.push('RAW_CATALOG_NOT_FULL');
  if (!catalogTrusted) reasonCodes.push('CATALOG_OBSERVATION_UNTRUSTED');
  if (!identityTrusted) reasonCodes.push('IDENTITY_OBSERVATION_UNTRUSTED');
  if (!countsConserve) reasonCodes.push('SOURCE_COUNTS_DO_NOT_CONSERVE');
  if (!sameStrings(errorCodes, expectedErrors)) reasonCodes.push('UNEXPECTED_SOURCE_ERRORS');
  return Object.freeze({
    trustedLatest,
    disposition: trustedLatest ? 'latest-trusted' : 'preserve-last-good',
    pendingRemoval,
    reviewIsolation,
    reasonCodes: sortedUniqueStrings(reasonCodes),
  });
}

function isoTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('A valid listing audit timestamp is required');
  return date.toISOString();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeError(error) {
  return normalized(error?.message || error || 'unknown error').slice(0, 500);
}

function persistenceConsistencyError(error) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const message = String(current?.message || current);
    if (message.includes(LISTING_PG_STALE_RETRY_ERROR_CODE)) return LISTING_PG_STALE_RETRY_ERROR_CODE;
    if (message.includes(LISTING_PG_IDENTITY_DOWNGRADE_ERROR_CODE)) return LISTING_PG_IDENTITY_DOWNGRADE_ERROR_CODE;
    if (message.includes(LISTING_PG_VERIFIED_IDENTITY_CONFLICT_ERROR_CODE)) return LISTING_PG_VERIFIED_IDENTITY_CONFLICT_ERROR_CODE;
    current = current?.cause;
  }
  return null;
}

function sourceKeyForDatabase(sourceKey) {
  return sourceKey;
}

function exactOfficialProductKey(raw, listing) {
  const officialProductKey = normalized(raw?.marketQuerySymbol || raw?.venueSymbol);
  if (!officialProductKey || officialProductKey.toUpperCase() !== listing.venueSymbol) return null;
  return officialProductKey;
}

function databaseEnvironment(env) {
  const value = normalized(env?.VERCEL_ENV || 'development').toLowerCase();
  return ['production', 'preview', 'development', 'test'].includes(value) ? value : 'other';
}

function deploymentSha(env) {
  const value = normalized(env?.VERCEL_GIT_COMMIT_SHA);
  return /^[0-9a-f]{7,64}$/i.test(value) ? value : null;
}

function sourceStatus(summary) {
  if (TRUSTED_SOURCE_STATUSES.has(summary?.status)) return 'full';
  return summary?.status === 'partial' ? 'partial' : 'unavailable';
}

function cycleStatus(snapshotStatus) {
  if (snapshotStatus === 'full' || snapshotStatus === 'warming') return 'complete';
  return snapshotStatus === 'partial' ? 'partial' : 'failed';
}

function stableArtifactPayload(sourceRun, batch) {
  return {
    schemaVersion: LISTING_NORMALIZED_ARTIFACT_FORMAT,
    artifactKind: 'normalized',
    // Content-address the logical daily catalog, not the physical retry time.
    // The exact capture timestamp remains in ingest.raw_artifact.captured_at.
    generatedAt: batch.bucketAt,
    bucketAt: batch.bucketAt,
    environment: batch.environment,
    deploymentSha: batch.deploymentSha,
    jobName: batch.jobName,
    pipelineVersion: batch.pipelineVersion,
    source: {
      listingSourceKey: sourceRun.listingSourceKey,
      sourceKey: sourceRun.sourceKey,
      market: sourceRun.market,
      venue: sourceRun.venue,
      endpointKey: sourceRun.endpointKey,
      authority: 'official',
    },
    observation: {
      rawStatus: sourceRun.rawStatus,
      mergedStatus: sourceRun.mergedStatus,
      trustedForMembership: sourceRun.trustedForMembership,
      writeDisposition: sourceRun.writeDisposition,
      pendingRemovalCount: sourceRun.pendingRemovalCount,
      reason: sourceRun.reason,
    },
    counts: {
      observed: sourceRun.listingCount,
      admitted: sourceRun.admittedListingCount,
      reviewRequired: sourceRun.reviewCases.length,
      rejected: sourceRun.rejectedListingCount,
    },
    listings: sourceRun.normalizedRows,
    rejectedRows: sourceRun.rejectedRows,
  };
}

function buildSourceRun(sourceKey, rawObservation, summary, mergedState, observedAt) {
  const [market, venue] = sourceKey.split(':');
  const rawRows = Array.isArray(rawObservation?.listings) ? rawObservation.listings : [];
  const normalizedRows = [];
  const rejectedRows = [];
  const duplicateKeys = new Set();
  const seenListingKeys = new Set();

  rawRows.forEach((raw, position) => {
    const listing = normalizeListingObservation({ ...raw, market, venue });
    const officialProductKey = listing ? exactOfficialProductKey(raw, listing) : null;
    if (!listing || !officialProductKey) {
      rejectedRows.push({
        officialProductKey: normalized(raw?.marketQuerySymbol || raw?.venueSymbol) || null,
        normalizedVenueSymbol: normalized(raw?.venueSymbol).toUpperCase() || null,
        canonicalUnderlying: normalized(raw?.canonicalSymbol).toUpperCase() || null,
        category: normalized(raw?.category).toLowerCase() || null,
        reasonCode: 'IDENTITY_NORMALIZATION_REJECTED',
        officialCatalogPosition: String(position + 1),
      });
      return;
    }
    if (seenListingKeys.has(listing.key)) {
      duplicateKeys.add(listing.key);
      rejectedRows.push({
        officialProductKey,
        normalizedVenueSymbol: listing.venueSymbol,
        canonicalUnderlying: listing.canonicalSymbol,
        category: listing.category,
        reasonCode: 'DUPLICATE_NORMALIZED_LISTING',
        officialCatalogPosition: String(position + 1),
      });
      return;
    }
    seenListingKeys.add(listing.key);
    const category = DATABASE_CATEGORY[listing.category];
    if (!category) {
      rejectedRows.push({
        officialProductKey,
        normalizedVenueSymbol: listing.venueSymbol,
        canonicalUnderlying: listing.canonicalSymbol,
        category: listing.category,
        reasonCode: 'UNSUPPORTED_DATABASE_CATEGORY',
        officialCatalogPosition: String(position + 1),
      });
      return;
    }
    const reviewRequired = listing.identityStatus !== 'verified';
    const assetKey = `${category}:${listing.canonicalSymbol}`;
    // Keep the cross-venue asset-version identity stable even when venues use
    // different display-name spellings. The exact event snapshots its own
    // admitted venue name in evidence below.
    const displayName = listing.canonicalSymbol;
    const assetFingerprint = sha256(JSON.stringify([
      assetKey,
      category,
      listing.canonicalSymbol,
      displayName,
      'unknown',
      'verified',
    ]));
    const instrumentType = market === 'perp' ? 'perpetual' : 'spot';
    const instrumentFingerprint = sha256(JSON.stringify([
      sourceKeyForDatabase(sourceKey),
      officialProductKey,
      listing.venueSymbol,
      instrumentType,
      assetFingerprint,
      'online',
      'verified',
    ]));
    normalizedRows.push({
      listingKey: listing.key,
      officialProductKey,
      officialVenueSymbol: officialProductKey,
      normalizedVenueSymbol: listing.venueSymbol,
      officialCatalogPosition: String(position + 1),
      assetKey,
      category,
      canonicalUnderlying: listing.canonicalSymbol,
      venueCategory: listing.venueCategory,
      lifecycleStatus: listing.lifecycleStatus,
      displayName,
      marketOrigin: 'unknown',
      assetFingerprint,
      instrumentType,
      quoteCurrency: null,
      officialStatus: 'online',
      instrumentFingerprint,
      identityStatus: reviewRequired ? 'review-required' : 'verified',
      name: listing.name || null,
      identityEvidence: listing.identityEvidence || null,
    });
  });

  const mergedStatus = summary?.status || 'unavailable';
  const rawStatus = normalized(rawObservation?.status || 'unavailable').toLowerCase();
  const catalogObserved = (TRUSTED_SOURCE_STATUSES.has(mergedStatus) || mergedStatus === 'partial') && rawStatus === 'full';
  const expectedListingKeys = new Set(mergedState?.sources?.[sourceKey]?.listingKeys || []);
  const pendingRemovalKeys = Object.keys(mergedState?.sources?.[sourceKey]?.pendingRemovals || {}).sort(compareExact);
  const pendingRemovalVenueSymbols = pendingRemovalKeys.map(key =>
    normalized(mergedState?.known?.[key]?.venueSymbol || key.slice(`${sourceKey}:`.length)).toUpperCase(),
  ).filter(Boolean).sort(compareExact);
  const normalizedListingKeys = new Set(normalizedRows.map(row => row.listingKey));
  const reconciled = catalogObserved
    ? rejectedRows.length === 0 &&
      duplicateKeys.size === 0 &&
      Number(summary?.listingCount) === normalizedRows.length &&
      (mergedStatus === 'partial' || expectedListingKeys.size === normalizedListingKeys.size) &&
      [...normalizedListingKeys].every(key => expectedListingKeys.has(key))
    : true;
  if (!reconciled) {
    throw new TypeError(`${sourceKey} raw catalog does not reconcile with its trusted Listing Audit merge`);
  }

  const verifiedRows = catalogObserved
    ? normalizedRows.filter(row => row.identityStatus === 'verified')
    : [];
  const reviewRows = catalogObserved
    ? normalizedRows.filter(row => row.identityStatus === 'review-required')
    : [];
  const identityComplete = catalogObserved && reviewRows.length === 0 && rejectedRows.length === 0;
  const catalogSourceStatus = sourceStatus(summary);
  const status = catalogSourceStatus === 'full' && !identityComplete ? 'partial' : catalogSourceStatus;
  const baselineAt = summary?.baselineAt ? isoTimestamp(summary.baselineAt) : null;
  // The Runtime Cache producer owns lifecycle-event semantics. A source whose
  // current public baseline was established in this UTC bucket is not
  // comparable for New/Re-listed events, even when a same-day retry has
  // already advanced its presentation status from Warming to Full.
  const lifecycleComparable = Boolean(
    baselineAt && baselineAt.slice(0, 10) < observedAt.slice(0, 10) && mergedStatus !== 'warming',
  );
  const errorCodes = [];
  if (catalogSourceStatus === 'partial') errorCodes.push('CATALOG_PARTIAL');
  if (catalogSourceStatus === 'unavailable') errorCodes.push('CATALOG_UNAVAILABLE');
  if (catalogObserved && !identityComplete) errorCodes.push('SOURCE_IDENTITY_PARTIAL');
  if (rawStatus !== 'full') errorCodes.push('UPSTREAM_UNAVAILABLE');
  if (reviewRows.length) errorCodes.push('IDENTITY_REVIEW_REQUIRED');
  if (rejectedRows.length) errorCodes.push('IDENTITY_NORMALIZATION_REJECTED');

  const sourceRun = {
    listingSourceKey: sourceKey,
    sourceKey: sourceKeyForDatabase(sourceKey),
    market,
    venue,
    endpointKey: LISTING_PG_ENDPOINT_KEY,
    rawStatus,
    mergedStatus,
    status,
    catalogStatus: catalogSourceStatus,
    identityStatus: catalogObserved
      ? identityComplete ? 'full' : 'partial'
      : 'unavailable',
    dataStatus: 'not-applicable',
    trustedForMembership: catalogObserved,
    pendingRemovalCount: pendingRemovalKeys.length,
    pendingRemovalVenueSymbols,
    listingCount: rawRows.length,
    admittedListingCount: verifiedRows.length,
    rejectedListingCount: reviewRows.length + rejectedRows.length,
    reason: normalized(summary?.reason || rawObservation?.reason) || null,
    errorCodes: [...new Set(errorCodes)],
    metadata: {
      listingSourceKey: sourceKey,
      rawStatus,
      mergedStatus,
      baseline: mergedStatus === 'warming',
      baselineAt,
      lifecycleComparable,
      withheldFromMembership: normalizedRows.length - verifiedRows.length,
      pendingRemovalCount: pendingRemovalKeys.length,
      pendingRemovalVenueSymbols,
      observedAt,
    },
    normalizedRows: normalizedRows
      .map(row => ({ ...row }))
      .sort((left, right) => compareExact(left.officialProductKey, right.officialProductKey)),
    memberships: verifiedRows
      .map(row => ({ ...row }))
      .sort((left, right) => compareExact(left.officialProductKey, right.officialProductKey)),
    reviewCases: reviewRows
      .map(row => ({
        officialProductKey: row.officialProductKey,
        payload: {
          listingSourceKey: sourceKey,
          normalizedVenueSymbol: row.normalizedVenueSymbol,
          canonicalUnderlying: row.canonicalUnderlying,
          category: row.category,
          name: row.name,
          identityEvidence: row.identityEvidence,
          observedAt,
        },
        reasonCodes: ['IDENTITY_REVIEW_REQUIRED'],
      }))
      .sort((left, right) => compareExact(left.officialProductKey, right.officialProductKey)),
    rejectedRows: rejectedRows.sort((left, right) =>
      compareExact(left.officialProductKey, right.officialProductKey)),
  };
  const writePolicy = classifyListingAuditSourceRunWritePolicy(sourceRun);
  sourceRun.writePolicy = writePolicy;
  sourceRun.writeDisposition = writePolicy.disposition;
  sourceRun.metadata.writeDisposition = writePolicy.disposition;
  sourceRun.metadata.writePolicyReasons = writePolicy.reasonCodes;
  return sourceRun;
}

export function resolvePgWriteMode(env = process.env) {
  const value = normalized(env?.PG_WRITE_MODE || 'off').toLowerCase();
  if (!PG_WRITE_MODES.has(value)) {
    throw new TypeError('PG_WRITE_MODE must be off, shadow, or required');
  }
  return value;
}

export function resolveRawArchiveMode(env = process.env) {
  const value = normalized(env?.RAW_ARCHIVE_MODE || 'off').toLowerCase();
  if (!PG_WRITE_MODES.has(value)) {
    throw new TypeError('RAW_ARCHIVE_MODE must be off, shadow, or required');
  }
  return value;
}

export function utcListingAuditBucket(value = new Date()) {
  return `${isoTimestamp(value).slice(0, 10)}T00:00:00.000Z`;
}

export function listingAuditPersistenceChecksum(value) {
  return sha256(JSON.stringify(value));
}

export function buildListingAuditPgBatch({ observations, merged, observedAt, env = process.env }) {
  if (!merged?.snapshot || !merged?.state) throw new TypeError('A merged Listing Audit result is required');
  const generatedAt = isoTimestamp(observedAt || merged.snapshot.generatedAt);
  const observationMap = new Map((Array.isArray(observations) ? observations : []).map(row => [
    `${normalized(row?.market).toLowerCase()}:${normalized(row?.venue).toLowerCase()}`,
    row,
  ]));
  const summaryMap = new Map((Array.isArray(merged.snapshot.sources) ? merged.snapshot.sources : []).map(row => [
    row?.sourceKey,
    row,
  ]));
  const batch = {
    jobName: LISTING_PG_JOB_NAME,
    pipelineVersion: LISTING_PG_PIPELINE_VERSION,
    bucketAt: utcListingAuditBucket(generatedAt),
    observedAt: generatedAt,
    attemptNo: 1,
    triggerKind: 'cron',
    status: cycleStatus(merged.snapshot.status),
    environment: databaseEnvironment(env),
    deploymentSha: deploymentSha(env),
    sourceRuns: [],
    events: [],
  };
  batch.sourceRuns = LISTING_SOURCE_KEYS.map(sourceKey => buildSourceRun(
    sourceKey,
    observationMap.get(sourceKey),
    summaryMap.get(sourceKey),
    merged.state,
    generatedAt,
  ));
  if (batch.sourceRuns.length !== LISTING_SOURCE_KEYS.length) {
    throw new TypeError('Listing Audit PostgreSQL batch must contain all ten sources');
  }
  batch.trustedLatestSourceCount = batch.sourceRuns.filter(row => row.writePolicy?.trustedLatest).length;
  const fullSourceRuns = batch.sourceRuns.filter(row => row.status === 'full').length;
  batch.status = fullSourceRuns === batch.sourceRuns.length
    ? 'complete'
    : fullSourceRuns === 0 && batch.sourceRuns.every(row => row.status === 'unavailable')
      ? 'failed'
      : 'partial';
  for (const sourceRun of batch.sourceRuns) {
    const payload = stableArtifactPayload(sourceRun, batch);
    const body = `${JSON.stringify(payload)}\n`;
    const digest = sha256(body);
    sourceRun.artifact = {
      artifactKind: 'normalized',
      artifactRole: 'catalog',
      artifactFormat: LISTING_NORMALIZED_ARTIFACT_FORMAT,
      contentType: 'application/json',
      compression: 'none',
      body,
      sha256: digest,
      byteLength: Buffer.byteLength(body, 'utf8'),
      capturedAt: generatedAt,
      retentionClass: 'standard',
      pathname: `catalog/${batch.environment}/${batch.jobName}/${batch.bucketAt.slice(0, 10)}/${sourceRun.listingSourceKey}/${digest}.json`,
      metadata: {
        listingSourceKey: sourceRun.listingSourceKey,
        schemaVersion: LISTING_NORMALIZED_ARTIFACT_FORMAT,
        trustedForMembership: sourceRun.trustedForMembership,
      },
    };
    sourceRun.metadata.artifactSha256 = digest;
    sourceRun.metadata.artifactCapturedAt = generatedAt;
  }
  batch.events = (Array.isArray(merged.newEvents) ? merged.newEvents : [])
    .filter(event => event?.identityStatus === 'verified')
    .flatMap(event => {
      const eventType = event.changeType === 'new'
        ? 'listed'
        : event.changeType === 'relisted'
          ? 'relisted'
          : event.changeType === 'delisted' ? 'delisted' : null;
      const listingSourceKey = `${normalized(event?.market).toLowerCase()}:${normalized(event?.venue).toLowerCase()}`;
      if (!eventType || !LISTING_SOURCE_KEYS.includes(listingSourceKey)) return [];
      return [{
        sourceKey: listingSourceKey,
        normalizedVenueSymbol: normalized(event?.venueSymbol).toUpperCase(),
        eventType,
        effectiveDay: generatedAt.slice(0, 10),
        observedAt: generatedAt,
        evidence: {
          eventId: normalized(event?.eventId) || null,
          listingKey: normalized(event?.listingKey) || null,
          changeType: event.changeType,
          canonicalUnderlying: normalized(event?.canonicalSymbol).toUpperCase() || null,
          name: normalized(event?.name) || null,
          category: normalized(event?.category).toLowerCase() || null,
          venueCategory: normalized(event?.venueCategory).toLowerCase() || null,
          lifecycleStatus: normalized(event?.lifecycleStatus).toLowerCase() || null,
          identityStatus: event.identityStatus,
          inclusionStatus: event?.inclusionStatus || (eventType === 'delisted' ? 'removed' : 'eligible'),
          identityEvidence: normalized(event?.identityEvidence) || null,
          observedAt: generatedAt,
          officialListedAt: event?.officialListedAt || null,
          timeBasis: event?.officialListedAt ? 'official' : 'first_observed',
        },
        officialListedAt:event?.officialListedAt || null,
        timeBasis:event?.officialListedAt ? 'official' : 'first_observed',
      }];
    })
    .sort((left, right) =>
      compareExact(`${left.sourceKey}:${left.normalizedVenueSymbol}:${left.eventType}`, `${right.sourceKey}:${right.normalizedVenueSymbol}:${right.eventType}`));
  batch.checksum = sha256(batch.sourceRuns
    .slice()
    .sort((left, right) => compareExact(left.sourceKey, right.sourceKey))
    .map(row => `${row.sourceKey}:${row.artifact.sha256}`)
    .join('\n'));
  return batch;
}

export async function putContentAddressedCatalogBlob(pathname, body, { artifact, blobClient = null }) {
  const { head, put } = blobClient || await import('@vercel/blob');
  try {
    return await put(pathname, body, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: 'application/json',
    });
  } catch (putError) {
    let existing;
    try {
      existing = await head(pathname);
    } catch {
      throw putError;
    }
    if (existing?.pathname !== pathname || existing?.size !== artifact.byteLength || !existing?.url) {
      throw new TypeError('Existing content-addressed Blob metadata does not match the normalized artifact', { cause: putError });
    }
    return existing;
  }
}

export async function archiveListingAuditArtifacts(batch, {
  mode = 'shadow',
  putArtifact = putContentAddressedCatalogBlob,
  now = new Date(),
} = {}) {
  if (mode === 'off') {
    return batch.sourceRuns.map(sourceRun => ({
      sourceKey: sourceRun.sourceKey,
      ...sourceRun.artifact,
      body: undefined,
      storageProvider: 'vercel-blob',
      objectUri: null,
      archivedAt: null,
      archiveStatus: 'pending',
      errorSummary: null,
      metadata: {
        ...sourceRun.artifact.metadata,
        archiveDisposition: 'skipped',
        archiveMode: 'off',
      },
    }));
  }
  const archivedAt = isoTimestamp(now);
  const results = await Promise.all(batch.sourceRuns.map(async sourceRun => {
    const artifact = sourceRun.artifact;
    try {
      const stored = await putArtifact(artifact.pathname, artifact.body, {
        sourceRun,
        artifact,
        batch,
      });
      const objectUri = normalized(stored?.url || stored?.downloadUrl);
      if (!objectUri) throw new TypeError('Blob upload did not return an object URI');
      return {
        sourceKey: sourceRun.sourceKey,
        ...artifact,
        body: undefined,
        storageProvider: 'vercel-blob',
        objectUri,
        archivedAt,
        archiveStatus: 'stored',
        errorSummary: null,
      };
    } catch (error) {
      if (mode === 'required') throw error;
      return {
        sourceKey: sourceRun.sourceKey,
        ...artifact,
        body: undefined,
        storageProvider: 'vercel-blob',
        objectUri: null,
        archivedAt: null,
        archiveStatus: 'failed',
        errorSummary: safeError(error),
      };
    }
  }));
  return results;
}

function json(value) {
  return JSON.stringify(value);
}

function sourceRows(batch) {
  return batch.sourceRuns.map(row => ({
    source_key: row.sourceKey,
    market: row.market,
    venue: row.venue,
    data_domain: LISTING_PG_ENDPOINT_KEY,
  }));
}

function sourceRunRows(batch) {
  return batch.sourceRuns.map(row => ({
    source_key: row.sourceKey,
    endpoint_key: row.endpointKey,
    status: row.status,
    catalog_status: row.catalogStatus,
    identity_status: row.identityStatus,
    data_status: row.dataStatus,
    listing_count: row.listingCount,
    admitted_listing_count: row.admittedListingCount,
    rejected_listing_count: row.rejectedListingCount,
    error_codes: row.errorCodes,
    metadata: row.metadata,
    replace_snapshot: row.writePolicy?.trustedLatest === true,
  }));
}

function membershipRows(batch) {
  return batch.sourceRuns
    .filter(sourceRun => sourceRun.writePolicy?.trustedLatest === true)
    .flatMap(sourceRun => sourceRun.memberships.map(row => ({
    source_key: sourceRun.sourceKey,
    official_product_key: row.officialProductKey,
    asset_key: row.assetKey,
    category: row.category,
    canonical_underlying: row.canonicalUnderlying,
    venue_category: row.venueCategory,
    lifecycle_status: row.lifecycleStatus,
    display_name: row.displayName,
    market_origin: row.marketOrigin,
    asset_fingerprint: row.assetFingerprint,
    official_venue_symbol: row.officialVenueSymbol,
    normalized_venue_symbol: row.normalizedVenueSymbol,
    instrument_type: row.instrumentType,
    quote_currency: row.quoteCurrency,
    official_status: row.officialStatus,
    instrument_fingerprint: row.instrumentFingerprint,
    evidence_sha256: sha256(JSON.stringify([
      sourceRun.sourceKey,
      row.officialProductKey,
      row.identityEvidence || null,
      sourceRun.artifact.sha256,
    ])),
    artifact_sha256: sourceRun.artifact.sha256,
    evidence_notes: row.identityEvidence || 'Verified by normalized official catalog admission',
    official_catalog_position: row.officialCatalogPosition,
    normalized_attributes: {
      listingKey: row.listingKey,
      name: row.name,
      identityEvidence: row.identityEvidence,
      identityStatus: row.identityStatus,
      venueCategory: row.venueCategory,
      lifecycleStatus: row.lifecycleStatus,
      artifactFormat: LISTING_NORMALIZED_ARTIFACT_FORMAT,
    },
  })));
}

function eventRows(batch) {
  const trustedSourceKeys = new Set(batch.sourceRuns
    .filter(sourceRun => sourceRun.writePolicy?.trustedLatest === true)
    .map(sourceRun => sourceRun.sourceKey));
  return batch.events.filter(row => trustedSourceKeys.has(row.sourceKey)).map(row => ({
    source_key: row.sourceKey,
    normalized_venue_symbol: row.normalizedVenueSymbol,
    event_type: row.eventType,
    effective_day: row.effectiveDay,
    observed_at: row.observedAt,
    official_listed_at: row.officialListedAt,
    time_basis: row.timeBasis,
    evidence: row.evidence,
  }));
}

function reviewRows(batch) {
  return batch.sourceRuns
    .filter(sourceRun => sourceRun.writePolicy?.trustedLatest === true)
    .flatMap(sourceRun => sourceRun.reviewCases.map(row => ({
    source_key: sourceRun.sourceKey,
    official_product_key: row.officialProductKey,
    payload: row.payload,
    reason_codes: row.reasonCodes,
  })));
}

function replacementSourceRows(batch) {
  return batch.sourceRuns
    .filter(sourceRun => sourceRun.writePolicy?.trustedLatest === true)
    .map(sourceRun => ({
      source_key: sourceRun.sourceKey,
      pending_venue_symbols: sourceRun.pendingRemovalVenueSymbols,
      artifact_sha256: sourceRun.artifact.sha256,
    }));
}

export function buildListingAuditPgQueries(sql, batch, archivedArtifacts = []) {
  if (!sql || typeof sql.query !== 'function') throw new TypeError('A Neon transaction query builder is required');
  const sources = sourceRows(batch);
  const runs = sourceRunRows(batch);
  const memberships = membershipRows(batch);
  const reviews = reviewRows(batch);
  const events = eventRows(batch);
  const replacementSources = replacementSourceRows(batch);
  const artifacts = archivedArtifacts.map(row => ({
    source_key: row.sourceKey,
    environment: batch.environment,
    deployment_sha: batch.deploymentSha,
    artifact_kind: row.artifactKind,
    artifact_role: row.artifactRole,
    artifact_format: row.artifactFormat,
    storage_provider: row.storageProvider,
    object_uri: row.objectUri,
    sha256: row.sha256,
    content_type: row.contentType,
    compression: row.compression,
    byte_length: row.byteLength,
    captured_at: row.capturedAt,
    archived_at: row.archivedAt,
    retention_class: row.retentionClass,
    archive_status: row.archiveStatus,
    error_summary: row.errorSummary,
    metadata: row.metadata,
  }));
  const cycleLookup = `
    SELECT cycle_id FROM ingest.collection_cycle
    WHERE job_name = $1 AND pipeline_version = $2 AND bucket_at = $3::timestamptz`;
  const attemptLookup = `
    SELECT attempt_id FROM ingest.collection_attempt
    WHERE cycle_id = (${cycleLookup}) AND attempt_no = $4`;
  const common = [batch.jobName, batch.pipelineVersion, batch.bucketAt, batch.attemptNo];
  const errorSummary = batch.sourceRuns
    .filter(row => row.status !== 'full')
    .map(row => `${row.listingSourceKey}:${row.reason || row.status}`)
    .join('; ')
    .slice(0, 2_000) || null;

  return [
    sql.query(`SET LOCAL ROLE rwa_catalog_shadow_writer`),
    sql.query(`SET LOCAL statement_timeout = '15s'`),
    sql.query(`SET LOCAL lock_timeout = '3s'`),
    sql.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(
         $1 || chr(31) || $2 || chr(31) || $3::text, 0
       )) AS catalog_retry_lock`,
      [batch.jobName, batch.pipelineVersion, batch.bucketAt],
    ),
    sql.query(
      `INSERT INTO identity.source (source_key, market, venue, data_domain, catalog_authority, enabled)
       SELECT x.source_key, x.market, x.venue, x.data_domain, 'official', true
       FROM jsonb_to_recordset($1::jsonb) AS x(source_key text, market text, venue text, data_domain text)
       ON CONFLICT (source_key) DO UPDATE SET
         market = EXCLUDED.market,
         venue = EXCLUDED.venue,
         data_domain = EXCLUDED.data_domain,
         catalog_authority = 'official',
         enabled = true,
         updated_at = clock_timestamp()`,
      [json(sources)],
    ),
    sql.query(
      `SELECT CASE WHEN EXISTS (
         SELECT 1
         FROM ingest.collection_attempt AS attempt
         JOIN ingest.collection_cycle AS cycle ON cycle.cycle_id = attempt.cycle_id
         LEFT JOIN ingest.sink_commit AS archive_sink
           ON archive_sink.attempt_id = attempt.attempt_id
          AND archive_sink.sink_name = 'blob-normalized-catalog'
         LEFT JOIN ingest.sink_commit AS runtime_sink
           ON runtime_sink.attempt_id = attempt.attempt_id
          AND runtime_sink.sink_name = 'runtime-cache-listing-audit'
         WHERE cycle.job_name = $1
           AND cycle.pipeline_version = $2
           AND cycle.bucket_at = $3::timestamptz
           AND attempt.attempt_no = $4
           AND (
             GREATEST(attempt.completed_at, COALESCE(runtime_sink.committed_at, attempt.completed_at)) > $5::timestamptz
             OR (GREATEST(attempt.completed_at, COALESCE(runtime_sink.committed_at, attempt.completed_at)) = $5::timestamptz AND
               archive_sink.checksum IS NOT NULL AND archive_sink.checksum <> $6)
           )
       ) THEN ingest.reject_stale_catalog_retry() ELSE 1 END AS retry_order_guard`,
      [...common, batch.observedAt, batch.checksum],
    ),
    sql.query(
      `SELECT CASE WHEN EXISTS (
         SELECT 1
         FROM jsonb_to_recordset($1::jsonb) AS incoming(
           source_key text, official_product_key text
         )
         JOIN identity.source AS source ON source.source_key = incoming.source_key
         JOIN identity.instrument AS instrument
           ON instrument.source_id = source.source_id
          AND instrument.official_product_key = incoming.official_product_key
         JOIN identity.instrument_version AS current
           ON current.instrument_id = instrument.instrument_id
          AND current.valid_to IS NULL
          AND current.identity_status = 'verified'
       ) THEN ingest.reject_catalog_identity_downgrade() ELSE 1 END AS identity_downgrade_guard`,
      [json(reviews)],
    ),
    sql.query(
      `SELECT CASE WHEN EXISTS (
         SELECT 1
         FROM jsonb_to_recordset($1::jsonb) AS incoming(
           source_key text, official_product_key text, asset_key text,
           category text, canonical_underlying text, venue_category text,
           lifecycle_status text
         )
         JOIN identity.source AS source ON source.source_key = incoming.source_key
         JOIN identity.instrument AS instrument
           ON instrument.source_id = source.source_id
          AND instrument.official_product_key = incoming.official_product_key
         JOIN identity.instrument_version AS current
           ON current.instrument_id = instrument.instrument_id
          AND current.valid_to IS NULL
          AND current.identity_status = 'verified'
         JOIN identity.asset_version AS current_asset_version
           ON current_asset_version.asset_version_id = current.asset_version_id
         JOIN identity.asset AS current_asset
           ON current_asset.asset_id = current_asset_version.asset_id
         WHERE (
           current_asset.asset_key <> incoming.asset_key
           OR current_asset_version.category <> incoming.category
           OR current_asset_version.canonical_underlying <> incoming.canonical_underlying
         )
         AND NOT (
           incoming.canonical_underlying = ANY($2::text[])
           AND current_asset_version.canonical_underlying = incoming.canonical_underlying
           AND current_asset_version.category = 'pre-ipo'
           AND incoming.category = 'equity'
           AND current_asset.asset_key = current_asset_version.category || ':' || current_asset_version.canonical_underlying
           AND incoming.asset_key = incoming.category || ':' || incoming.canonical_underlying
           AND incoming.venue_category IN ('equity', 'pre-ipo')
           AND incoming.lifecycle_status = 'public'
         )
       ) THEN ingest.reject_verified_catalog_identity_conflict() ELSE 1 END AS verified_identity_guard`,
      [json(memberships), REVIEWED_PUBLIC_LIFECYCLE_CORRECTIONS],
    ),
    sql.query(
      `INSERT INTO ingest.collection_cycle
         (job_name, pipeline_version, bucket_at, scheduled_at, started_at, completed_at, status, trigger_kind)
       VALUES ($1, $2, $3::timestamptz, $3::timestamptz, $4::timestamptz, $4::timestamptz, $5, $6)
       ON CONFLICT (job_name, pipeline_version, bucket_at) DO UPDATE SET
         started_at = LEAST(ingest.collection_cycle.started_at, EXCLUDED.started_at),
         completed_at = GREATEST(ingest.collection_cycle.completed_at, EXCLUDED.completed_at),
         status = CASE
           WHEN ingest.collection_cycle.status = 'complete' OR EXCLUDED.status = 'complete' THEN 'complete'
           WHEN ingest.collection_cycle.status = 'partial' OR EXCLUDED.status = 'partial' THEN 'partial'
           ELSE 'failed'
         END`,
      [batch.jobName, batch.pipelineVersion, batch.bucketAt, batch.observedAt, batch.status, batch.triggerKind],
    ),
    sql.query(
      `INSERT INTO ingest.collection_attempt
         (cycle_id, attempt_no, started_at, completed_at, status, error_summary)
       SELECT cycle_id, $4, $5::timestamptz, $5::timestamptz, $6, $7
       FROM (${cycleLookup}) AS cycle
       ON CONFLICT (cycle_id, attempt_no) DO UPDATE SET
         started_at = LEAST(ingest.collection_attempt.started_at, EXCLUDED.started_at),
         completed_at = GREATEST(ingest.collection_attempt.completed_at, EXCLUDED.completed_at),
         status = CASE
           WHEN ingest.collection_attempt.status = 'complete' OR EXCLUDED.status = 'complete' THEN 'complete'
           WHEN ingest.collection_attempt.status = 'partial' OR EXCLUDED.status = 'partial' THEN 'partial'
           ELSE 'failed'
         END,
         error_summary = CASE
           WHEN ingest.collection_attempt.status = 'complete' THEN ingest.collection_attempt.error_summary
           ELSE EXCLUDED.error_summary
         END`,
      [...common, batch.observedAt, batch.status, errorSummary],
    ),
    sql.query(
      `INSERT INTO ingest.source_run
         (attempt_id, source_id, endpoint_key, started_at, completed_at, status,
          catalog_status, identity_status, data_status, listing_count,
          admitted_listing_count, rejected_listing_count, error_codes, metadata)
       SELECT (${attemptLookup}), source.source_id, x.endpoint_key, $5::timestamptz,
         $5::timestamptz, x.status, x.catalog_status, x.identity_status,
         x.data_status, x.listing_count, x.admitted_listing_count,
         x.rejected_listing_count, x.error_codes, x.metadata
       FROM jsonb_to_recordset($6::jsonb) AS x(
         source_key text, endpoint_key text, status text, catalog_status text,
         identity_status text, data_status text, listing_count integer,
         admitted_listing_count integer, rejected_listing_count integer,
         error_codes text[], metadata jsonb
       )
       JOIN identity.source AS source ON source.source_key = x.source_key
       ON CONFLICT (attempt_id, source_id, endpoint_key) DO UPDATE SET
         completed_at = CASE
           WHEN EXCLUDED.metadata->>'writeDisposition' = 'latest-trusted' THEN EXCLUDED.completed_at
           ELSE ingest.source_run.completed_at
         END,
         status = CASE
           WHEN EXCLUDED.metadata->>'writeDisposition' = 'latest-trusted' THEN EXCLUDED.status
           ELSE ingest.source_run.status
         END,
         catalog_status = CASE
           WHEN EXCLUDED.metadata->>'writeDisposition' = 'latest-trusted' THEN EXCLUDED.catalog_status
           ELSE ingest.source_run.catalog_status
         END,
         identity_status = CASE
           WHEN EXCLUDED.metadata->>'writeDisposition' = 'latest-trusted' THEN EXCLUDED.identity_status
           ELSE ingest.source_run.identity_status
         END,
         data_status = 'not-applicable',
         listing_count = CASE
           WHEN EXCLUDED.metadata->>'writeDisposition' = 'latest-trusted' THEN EXCLUDED.listing_count
           ELSE ingest.source_run.listing_count
         END,
         admitted_listing_count = CASE
           WHEN EXCLUDED.metadata->>'writeDisposition' = 'latest-trusted' THEN EXCLUDED.admitted_listing_count
           ELSE ingest.source_run.admitted_listing_count
         END,
         rejected_listing_count = CASE
           WHEN EXCLUDED.metadata->>'writeDisposition' = 'latest-trusted' THEN EXCLUDED.rejected_listing_count
           ELSE ingest.source_run.rejected_listing_count
         END,
         error_codes = CASE
           WHEN EXCLUDED.metadata->>'writeDisposition' = 'latest-trusted' THEN EXCLUDED.error_codes
           ELSE ingest.source_run.error_codes
         END,
         metadata = CASE
           WHEN EXCLUDED.metadata->>'writeDisposition' = 'latest-trusted' THEN EXCLUDED.metadata
           ELSE ingest.source_run.metadata
         END`,
      [...common, batch.observedAt, json(runs)],
    ),
    sql.query(
      `WITH source_summary AS (
         SELECT count(*)::int AS source_count,
           (count(*) FILTER (WHERE run.status = 'full'))::int AS full_count,
           (count(*) FILTER (WHERE run.status = 'unavailable'))::int AS unavailable_count,
           NULLIF(string_agg(
             CASE WHEN run.status = 'full' THEN NULL
               ELSE source.source_key || ':' || COALESCE(array_to_string(run.error_codes, ','), run.status)
             END,
             '; ' ORDER BY source.source_key COLLATE "C"
           ), '') AS error_summary
         FROM ingest.source_run AS run
         JOIN identity.source AS source ON source.source_id = run.source_id
         WHERE run.attempt_id = (${attemptLookup})
           AND run.endpoint_key = '${LISTING_PG_ENDPOINT_KEY}'
       )
       UPDATE ingest.collection_attempt AS attempt
       SET status = CASE
           WHEN summary.source_count = ${LISTING_SOURCE_KEYS.length} AND summary.full_count = ${LISTING_SOURCE_KEYS.length} THEN 'complete'
           WHEN summary.source_count = ${LISTING_SOURCE_KEYS.length} AND summary.unavailable_count = ${LISTING_SOURCE_KEYS.length} THEN 'failed'
           ELSE 'partial'
         END,
         error_summary = summary.error_summary
       FROM source_summary AS summary
       WHERE attempt.attempt_id = (${attemptLookup})`,
      common,
    ),
    sql.query(
      `UPDATE ingest.collection_cycle AS cycle
       SET status = attempt.status,
         completed_at = attempt.completed_at
       FROM ingest.collection_attempt AS attempt
       WHERE attempt.attempt_id = (${attemptLookup})
         AND cycle.cycle_id = attempt.cycle_id`,
      common,
    ),
    sql.query(
      `DELETE FROM identity.evidence AS evidence
       USING identity.source AS source,
         ingest.source_run AS source_run,
         jsonb_to_recordset($5::jsonb) AS incoming(source_key text)
       WHERE source.source_key = incoming.source_key
         AND source_run.source_id = source.source_id
         AND source_run.endpoint_key = '${LISTING_PG_ENDPOINT_KEY}'
         AND source_run.attempt_id = (${attemptLookup})
         AND evidence.source_run_id = source_run.source_run_id
         AND evidence.source_id = source.source_id
         AND evidence.evidence_kind = 'official-catalog'`,
      [...common, json(replacementSources)],
    ),
    sql.query(
      `DELETE FROM ingest.catalog_membership AS membership
       USING identity.source AS source,
         ingest.source_run AS source_run,
         jsonb_to_recordset($5::jsonb) AS incoming(source_key text)
       WHERE source.source_key = incoming.source_key
         AND source_run.source_id = source.source_id
         AND source_run.endpoint_key = '${LISTING_PG_ENDPOINT_KEY}'
         AND source_run.attempt_id = (${attemptLookup})
         AND membership.source_run_id = source_run.source_run_id
         AND membership.source_id = source.source_id`,
      [...common, json(replacementSources)],
    ),
    sql.query(
      `INSERT INTO identity.asset (asset_key)
       SELECT DISTINCT x.asset_key
       FROM jsonb_to_recordset($1::jsonb) AS x(asset_key text)
       ON CONFLICT (asset_key) DO NOTHING`,
      [json(memberships)],
    ),
    sql.query(
      `UPDATE identity.asset_version AS current
       SET valid_to = $2::timestamptz
       FROM identity.asset AS asset
       JOIN (
         SELECT DISTINCT ON (asset_key) asset_key, asset_fingerprint
         FROM jsonb_to_recordset($1::jsonb) AS x(asset_key text, asset_fingerprint text)
         ORDER BY asset_key, asset_fingerprint
       ) AS incoming ON incoming.asset_key = asset.asset_key
       WHERE current.asset_id = asset.asset_id
         AND current.valid_to IS NULL
         AND current.identity_fingerprint <> incoming.asset_fingerprint
         AND current.valid_from < $2::timestamptz`,
      [json(memberships), batch.observedAt],
    ),
    sql.query(
      `INSERT INTO identity.asset_version
         (asset_id, category, canonical_underlying, display_name, market_origin,
          identity_status, identity_fingerprint, valid_from)
       SELECT asset.asset_id, incoming.category, incoming.canonical_underlying,
         incoming.display_name, incoming.market_origin, 'verified',
         incoming.asset_fingerprint, $2::timestamptz
       FROM identity.asset AS asset
       JOIN (
         SELECT DISTINCT ON (asset_key) asset_key, category, canonical_underlying,
           display_name, market_origin, asset_fingerprint
         FROM jsonb_to_recordset($1::jsonb) AS x(
           asset_key text, category text, canonical_underlying text,
           display_name text, market_origin text, asset_fingerprint text
         )
         ORDER BY asset_key, asset_fingerprint
       ) AS incoming ON incoming.asset_key = asset.asset_key
       WHERE NOT EXISTS (
         SELECT 1 FROM identity.asset_version AS current
         WHERE current.asset_id = asset.asset_id AND current.valid_to IS NULL
       )`,
      [json(memberships), batch.observedAt],
    ),
    sql.query(
      `INSERT INTO identity.instrument (source_id, official_product_key)
       SELECT source.source_id, incoming.official_product_key
       FROM (
         SELECT DISTINCT source_key, official_product_key
         FROM jsonb_to_recordset($1::jsonb) AS x(source_key text, official_product_key text)
       ) AS incoming
       JOIN identity.source AS source ON source.source_key = incoming.source_key
       ON CONFLICT (source_id, official_product_key) DO NOTHING`,
      [json(memberships)],
    ),
    sql.query(
      `UPDATE identity.instrument_version AS current
       SET valid_to = $2::timestamptz
       FROM identity.instrument AS instrument
       JOIN identity.source AS source ON source.source_id = instrument.source_id
       JOIN jsonb_to_recordset($1::jsonb) AS incoming(
         source_key text, official_product_key text, instrument_fingerprint text
       ) ON incoming.source_key = source.source_key
          AND incoming.official_product_key = instrument.official_product_key
       WHERE current.instrument_id = instrument.instrument_id
         AND current.valid_to IS NULL
         AND current.identity_fingerprint <> incoming.instrument_fingerprint
         AND current.valid_from < $2::timestamptz`,
      [json(memberships), batch.observedAt],
    ),
    sql.query(
      `INSERT INTO identity.instrument_version
         (instrument_id, source_id, asset_version_id, official_venue_symbol,
          normalized_venue_symbol, instrument_type, quote_currency,
          official_status, identity_status, identity_fingerprint, valid_from)
       SELECT instrument.instrument_id, source.source_id, asset_version.asset_version_id,
         incoming.official_venue_symbol, incoming.normalized_venue_symbol,
         incoming.instrument_type, incoming.quote_currency, incoming.official_status,
         'verified', incoming.instrument_fingerprint, $2::timestamptz
       FROM jsonb_to_recordset($1::jsonb) AS incoming(
         source_key text, official_product_key text, asset_key text,
         official_venue_symbol text, normalized_venue_symbol text,
         instrument_type text, quote_currency text, official_status text,
         instrument_fingerprint text
       )
       JOIN identity.source AS source ON source.source_key = incoming.source_key
       JOIN identity.instrument AS instrument
         ON instrument.source_id = source.source_id
        AND instrument.official_product_key = incoming.official_product_key
       JOIN identity.asset AS asset ON asset.asset_key = incoming.asset_key
       JOIN identity.asset_version AS asset_version
         ON asset_version.asset_id = asset.asset_id AND asset_version.valid_to IS NULL
       WHERE NOT EXISTS (
         SELECT 1 FROM identity.instrument_version AS current
         WHERE current.instrument_id = instrument.instrument_id AND current.valid_to IS NULL
       )`,
      [json(memberships), batch.observedAt],
    ),
    sql.query(
      `INSERT INTO ingest.catalog_membership
         (source_run_id, instrument_version_id, source_id, presence_status,
          official_catalog_position, normalized_attributes, observed_at)
       SELECT source_run.source_run_id, instrument_version.instrument_version_id,
         source.source_id, 'present', incoming.official_catalog_position,
         incoming.normalized_attributes, $5::timestamptz
       FROM jsonb_to_recordset($6::jsonb) AS incoming(
         source_key text, official_product_key text, instrument_fingerprint text,
         official_catalog_position text, normalized_attributes jsonb
       )
       JOIN identity.source AS source ON source.source_key = incoming.source_key
       JOIN identity.instrument AS instrument
         ON instrument.source_id = source.source_id
        AND instrument.official_product_key = incoming.official_product_key
       JOIN identity.instrument_version AS instrument_version
         ON instrument_version.instrument_id = instrument.instrument_id
        AND instrument_version.valid_to IS NULL
        AND instrument_version.identity_fingerprint = incoming.instrument_fingerprint
       JOIN ingest.source_run AS source_run
         ON source_run.source_id = source.source_id
        AND source_run.endpoint_key = '${LISTING_PG_ENDPOINT_KEY}'
        AND source_run.attempt_id = (${attemptLookup})
       ON CONFLICT (source_run_id, instrument_version_id) DO UPDATE SET
         presence_status = 'present',
         official_catalog_position = EXCLUDED.official_catalog_position,
         normalized_attributes = EXCLUDED.normalized_attributes,
         observed_at = EXCLUDED.observed_at`,
      [...common, batch.observedAt, json(memberships)],
    ),
    sql.query(
      `INSERT INTO identity.review_case
         (source_id, candidate_official_product_key, candidate_payload,
          reason_codes, status, opened_at)
       SELECT source.source_id, incoming.official_product_key,
         incoming.payload, incoming.reason_codes, 'open', $2::timestamptz
       FROM jsonb_to_recordset($1::jsonb) AS incoming(
         source_key text, official_product_key text, payload jsonb, reason_codes text[]
       )
       JOIN identity.source AS source ON source.source_key = incoming.source_key
       WHERE NOT EXISTS (
         SELECT 1 FROM identity.review_case AS decided
         WHERE decided.source_id = source.source_id
           AND decided.candidate_official_product_key = incoming.official_product_key
           AND decided.status IN ('verified', 'rejected')
       )
       ON CONFLICT (source_id, candidate_official_product_key, status) DO UPDATE SET
         candidate_payload = EXCLUDED.candidate_payload,
         reason_codes = EXCLUDED.reason_codes`,
      [json(reviews), batch.observedAt],
    ),
    sql.query(
      `UPDATE identity.review_case AS review
       SET status = 'verified',
         resolved_asset_id = asset_version.asset_id,
         resolved_instrument_id = instrument.instrument_id,
         decided_at = $2::timestamptz,
         decision_note = 'Auto-verified by a later trusted exact official catalog observation'
       FROM jsonb_to_recordset($1::jsonb) AS incoming(
         source_key text, official_product_key text
       )
       JOIN identity.source AS source ON source.source_key = incoming.source_key
       JOIN identity.instrument AS instrument
         ON instrument.source_id = source.source_id
        AND instrument.official_product_key = incoming.official_product_key
       JOIN identity.instrument_version AS instrument_version
         ON instrument_version.instrument_id = instrument.instrument_id
        AND instrument_version.valid_to IS NULL
        AND instrument_version.identity_status = 'verified'
       JOIN identity.asset_version AS asset_version
         ON asset_version.asset_version_id = instrument_version.asset_version_id
       WHERE review.source_id = source.source_id
         AND review.candidate_official_product_key = incoming.official_product_key
         AND review.status = 'open'
         AND NOT EXISTS (
           SELECT 1 FROM identity.review_case AS decided
           WHERE decided.source_id = review.source_id
             AND decided.candidate_official_product_key = review.candidate_official_product_key
             AND decided.status = 'verified'
             AND decided.review_case_id <> review.review_case_id
         )`,
      [json(memberships), batch.observedAt],
    ),
    sql.query(
      `UPDATE identity.review_case AS review
       SET status = 'superseded',
         decided_at = $3::timestamptz,
         decision_note = 'Superseded by a later trusted exact official catalog observation'
       FROM jsonb_to_recordset($1::jsonb) AS replacement(
         source_key text, pending_venue_symbols text[]
       )
       JOIN identity.source AS source ON source.source_key = replacement.source_key
       WHERE review.source_id = source.source_id
         AND review.status = 'open'
         AND NOT (
           COALESCE(review.candidate_payload->>'normalizedVenueSymbol', '') =
           ANY(COALESCE(replacement.pending_venue_symbols, ARRAY[]::text[]))
         )
         AND NOT EXISTS (
           SELECT 1
           FROM jsonb_to_recordset($2::jsonb) AS current_review(
             source_key text, official_product_key text
           )
           WHERE current_review.source_key = source.source_key
             AND current_review.official_product_key = review.candidate_official_product_key
         )`,
      [json(replacementSources), json(reviews), batch.observedAt],
    ),
    sql.query(
      `INSERT INTO ingest.raw_artifact
         (source_run_id, environment, deployment_sha, artifact_kind, artifact_role,
          artifact_format, storage_provider, object_uri, sha256, content_type,
          compression, byte_length, captured_at, archived_at, retention_class,
          archive_status, error_summary, metadata)
       SELECT source_run.source_run_id, incoming.environment,
         incoming.deployment_sha, incoming.artifact_kind, incoming.artifact_role,
         incoming.artifact_format, incoming.storage_provider, incoming.object_uri,
         incoming.sha256, incoming.content_type, incoming.compression,
         incoming.byte_length, incoming.captured_at, incoming.archived_at,
         incoming.retention_class, incoming.archive_status,
         incoming.error_summary, incoming.metadata
       FROM jsonb_to_recordset($5::jsonb) AS incoming(
         source_key text, environment text, deployment_sha text,
         artifact_kind text, artifact_role text, artifact_format text,
         storage_provider text, object_uri text, sha256 text, content_type text,
         compression text, byte_length bigint, captured_at timestamptz,
         archived_at timestamptz, retention_class text, archive_status text,
         error_summary text, metadata jsonb
       )
       JOIN identity.source AS source ON source.source_key = incoming.source_key
       JOIN ingest.source_run AS source_run
         ON source_run.source_id = source.source_id
        AND source_run.endpoint_key = '${LISTING_PG_ENDPOINT_KEY}'
        AND source_run.attempt_id = (${attemptLookup})
       ON CONFLICT (source_run_id, artifact_kind, artifact_role, artifact_format, sha256)
       DO UPDATE SET
         object_uri = CASE
           WHEN ingest.raw_artifact.archive_status = 'stored' THEN ingest.raw_artifact.object_uri
           ELSE EXCLUDED.object_uri
         END,
         archived_at = CASE
           WHEN ingest.raw_artifact.archive_status = 'stored' THEN ingest.raw_artifact.archived_at
           ELSE EXCLUDED.archived_at
         END,
         archive_status = CASE
           WHEN ingest.raw_artifact.archive_status = 'stored' OR EXCLUDED.archive_status = 'stored' THEN 'stored'
           ELSE EXCLUDED.archive_status
         END,
         error_summary = CASE
           WHEN ingest.raw_artifact.archive_status = 'stored' OR EXCLUDED.archive_status = 'stored' THEN NULL
           ELSE EXCLUDED.error_summary
         END,
         metadata = EXCLUDED.metadata`,
      [...common, json(artifacts)],
    ),
    sql.query(
      `INSERT INTO identity.evidence
         (source_id, source_run_id, instrument_id, raw_artifact_id,
          evidence_kind, official_uri, observed_at, evidence_sha256, notes)
       SELECT source.source_id, source_run.source_run_id, instrument.instrument_id,
         artifact.artifact_id, 'official-catalog', artifact.object_uri,
         $5::timestamptz, incoming.evidence_sha256, incoming.evidence_notes
       FROM jsonb_to_recordset($6::jsonb) AS incoming(
         source_key text, official_product_key text, evidence_sha256 text,
         artifact_sha256 text, evidence_notes text
       )
       JOIN identity.source AS source ON source.source_key = incoming.source_key
       JOIN identity.instrument AS instrument
         ON instrument.source_id = source.source_id
        AND instrument.official_product_key = incoming.official_product_key
       JOIN ingest.source_run AS source_run
         ON source_run.source_id = source.source_id
        AND source_run.endpoint_key = '${LISTING_PG_ENDPOINT_KEY}'
        AND source_run.attempt_id = (${attemptLookup})
       LEFT JOIN ingest.raw_artifact AS artifact
         ON artifact.source_run_id = source_run.source_run_id
        AND artifact.artifact_kind = 'normalized'
        AND artifact.artifact_role = 'catalog'
        AND artifact.artifact_format = '${LISTING_NORMALIZED_ARTIFACT_FORMAT}'
        AND artifact.sha256 = incoming.artifact_sha256
        AND artifact.archive_status = 'stored'
       ON CONFLICT (source_run_id, instrument_id, evidence_kind) DO UPDATE SET
         raw_artifact_id = COALESCE(identity.evidence.raw_artifact_id, EXCLUDED.raw_artifact_id),
         official_uri = COALESCE(identity.evidence.official_uri, EXCLUDED.official_uri),
         evidence_sha256 = EXCLUDED.evidence_sha256,
         notes = EXCLUDED.notes`,
      [...common, batch.observedAt, json(memberships)],
    ),
    sql.query(
       `INSERT INTO analytics.catalog_change_event AS stored_event
         (source_id, instrument_version_id, detection_cycle_id,
          previous_source_run_id, current_source_run_id, event_type, effective_day, baseline,
          status, observed_at, official_listed_at, time_basis, evidence)
       SELECT source.source_id, instrument_version.instrument_version_id,
         cycle.cycle_id, previous_source_run.source_run_id,
         source_run.source_run_id, incoming.event_type,
         incoming.effective_day, false, 'confirmed', incoming.observed_at,
         incoming.official_listed_at, incoming.time_basis, incoming.evidence
       FROM jsonb_to_recordset($5::jsonb) AS incoming(
         source_key text, normalized_venue_symbol text, event_type text,
         effective_day date, observed_at timestamptz, official_listed_at timestamptz,
         time_basis text, evidence jsonb
       )
       JOIN identity.source AS source ON source.source_key = incoming.source_key
       JOIN identity.instrument_version AS instrument_version
         ON instrument_version.source_id = source.source_id
        AND instrument_version.normalized_venue_symbol = incoming.normalized_venue_symbol
        AND instrument_version.valid_to IS NULL
        AND instrument_version.identity_status = 'verified'
       JOIN (${cycleLookup}) AS cycle ON true
       JOIN ingest.source_run AS source_run
         ON source_run.source_id = source.source_id
        AND source_run.endpoint_key = '${LISTING_PG_ENDPOINT_KEY}'
        AND source_run.attempt_id = (${attemptLookup})
       LEFT JOIN LATERAL (
         SELECT prior.source_run_id
         FROM ingest.source_run AS prior
         JOIN ingest.collection_attempt AS prior_attempt
           ON prior_attempt.attempt_id = prior.attempt_id
         JOIN ingest.collection_cycle AS prior_cycle
           ON prior_cycle.cycle_id = prior_attempt.cycle_id
         WHERE prior.source_id = source.source_id
           AND prior.endpoint_key = '${LISTING_PG_ENDPOINT_KEY}'
           AND prior_cycle.job_name = $1
           AND prior_cycle.pipeline_version = $2
           AND prior_cycle.bucket_at < $3::timestamptz
         ORDER BY prior_cycle.bucket_at DESC, prior.completed_at DESC NULLS LAST
         LIMIT 1
       ) AS previous_source_run ON true
       ON CONFLICT (source_id, instrument_version_id, event_type, effective_day)
       DO UPDATE SET
         official_listed_at = COALESCE(
           stored_event.official_listed_at,
           EXCLUDED.official_listed_at
         ),
         time_basis = CASE
           WHEN stored_event.official_listed_at IS NOT NULL
             OR EXCLUDED.official_listed_at IS NOT NULL
           THEN 'official'
           ELSE 'first_observed'
         END,
         evidence = CASE
           WHEN stored_event.official_listed_at IS NULL
             AND EXCLUDED.official_listed_at IS NOT NULL
           THEN stored_event.evidence || jsonb_build_object(
             'officialListedAt', EXCLUDED.official_listed_at,
             'timeBasis', 'official'
           )
           ELSE stored_event.evidence
         END`,
      [...common, json(events)],
    ),
    sql.query(
      `UPDATE identity.instrument_version AS current
       SET valid_to = incoming.observed_at
       FROM jsonb_to_recordset($4::jsonb) AS incoming(
         source_key text, normalized_venue_symbol text, event_type text,
         effective_day date, observed_at timestamptz
       )
       JOIN identity.source AS source ON source.source_key = incoming.source_key
       JOIN analytics.catalog_change_event AS event
         ON event.source_id = source.source_id
        AND event.event_type = 'delisted'
        AND event.effective_day = incoming.effective_day
        AND event.detection_cycle_id = (${cycleLookup})
       WHERE incoming.event_type = 'delisted'
         AND current.source_id = source.source_id
         AND current.instrument_version_id = event.instrument_version_id
         AND current.normalized_venue_symbol = incoming.normalized_venue_symbol
         AND current.identity_status = 'verified'
         AND current.valid_to IS NULL
         AND current.valid_from < incoming.observed_at`,
      [batch.jobName, batch.pipelineVersion, batch.bucketAt, json(events)],
    ),
    sql.query(
      `WITH actual_counts AS (
         SELECT
           (SELECT count(*)::int
              FROM ingest.catalog_membership AS membership
              JOIN ingest.source_run AS run ON run.source_run_id = membership.source_run_id
             WHERE run.attempt_id = (${attemptLookup})) AS membership_count,
           (SELECT count(*)::int
              FROM analytics.catalog_change_event AS event
             WHERE event.detection_cycle_id = (${cycleLookup})) AS lifecycle_count
       ), actual_checksum AS (
         SELECT CASE
           WHEN count(*) = ${LISTING_SOURCE_KEYS.length}
             AND bool_and((run.metadata->>'artifactSha256') ~ '^[0-9a-f]{64}$')
           THEN encode(digest(string_agg(
             source.source_key || ':' || (run.metadata->>'artifactSha256'),
             E'\\n' ORDER BY source.source_key COLLATE "C"
           ), 'sha256'), 'hex')
           ELSE NULL
         END AS checksum
         FROM ingest.source_run AS run
         JOIN identity.source AS source ON source.source_id = run.source_id
         WHERE run.attempt_id = (${attemptLookup})
           AND run.endpoint_key = '${LISTING_PG_ENDPOINT_KEY}'
       ), stored AS (
         INSERT INTO ingest.sink_commit
           (attempt_id, sink_name, status, row_count, checksum, committed_at, error_summary)
         SELECT (${attemptLookup}), 'postgres-catalog-shadow', 'stored',
           actual_counts.membership_count + actual_counts.lifecycle_count,
           actual_checksum.checksum,
           $5::timestamptz, NULL
         FROM actual_counts CROSS JOIN actual_checksum
         ON CONFLICT (attempt_id, sink_name) DO UPDATE SET
           status = 'stored',
           row_count = EXCLUDED.row_count,
           checksum = EXCLUDED.checksum,
           committed_at = EXCLUDED.committed_at,
           error_summary = NULL
         RETURNING sink_name, row_count, checksum
       )
       SELECT stored.sink_name, stored.row_count, stored.checksum,
         actual_counts.membership_count, actual_counts.lifecycle_count
       FROM stored CROSS JOIN actual_counts`,
      [...common, batch.observedAt],
    ),
    sql.query(
      `INSERT INTO ingest.sink_commit
         (attempt_id, sink_name, status, row_count, checksum, committed_at, error_summary)
       SELECT (${attemptLookup}), incoming.sink_name, incoming.status,
         incoming.row_count, incoming.checksum,
         CASE WHEN incoming.status = 'pending' THEN NULL ELSE $5::timestamptz END,
         incoming.error_summary
       FROM jsonb_to_recordset($6::jsonb) AS incoming(
         sink_name text, status text, row_count integer, checksum text, error_summary text
       )
       ON CONFLICT (attempt_id, sink_name) DO UPDATE SET
         status = EXCLUDED.status,
         row_count = EXCLUDED.row_count,
         checksum = EXCLUDED.checksum,
         committed_at = EXCLUDED.committed_at,
         error_summary = EXCLUDED.error_summary`,
      [...common, batch.observedAt, json([
        {
          sink_name: 'blob-normalized-catalog',
          status: artifacts.length === 0 || artifacts.every(row => row.archive_status === 'pending')
            ? 'skipped'
            : artifacts.every(row => row.archive_status === 'stored') ? 'stored' : 'failed',
          row_count: artifacts.filter(row => row.archive_status === 'stored').length,
          checksum: batch.checksum,
          error_summary: artifacts.length === 0 || artifacts.every(row => row.archive_status === 'pending')
            ? 'RAW_ARCHIVE_MODE=off'
            : artifacts.every(row => row.archive_status === 'stored')
            ? null
            : `${artifacts.filter(row => row.archive_status !== 'stored').length} normalized catalog artifacts were not archived`,
        },
        {
          // The Runtime Cache write happens after this transaction. Persist a
          // pending intent now so a post-cache bookkeeping outage cannot make
          // the already-committed operational baseline look transactional.
          sink_name: 'runtime-cache-listing-audit',
          status: 'pending',
          row_count: null,
          checksum: null,
          error_summary: null,
        },
      ])],
    ),
  ];
}

export async function writeListingAuditPgBatch(batch, archivedArtifacts, { runTransaction } = {}) {
  let transaction = runTransaction;
  if (!transaction) {
    const database = await import('./database.js');
    transaction = database.runDatabaseTransaction;
  }
  const results = await transaction(
    sql => buildListingAuditPgQueries(sql, batch, archivedArtifacts),
    { isolationLevel: 'Serializable' },
  );
  const postgresSink = (Array.isArray(results) ? results.flat() : [])
    .find(row => row?.sink_name === 'postgres-catalog-shadow');
  return {
    queryCount: Array.isArray(results) ? results.length : null,
    sourceRunCount: batch.sourceRuns.length,
    membershipCount: Number.isInteger(postgresSink?.membership_count)
      ? postgresSink.membership_count
      : null,
    lifecycleCount: Number.isInteger(postgresSink?.lifecycle_count)
      ? postgresSink.lifecycle_count
      : null,
    postgresRowCount: Number.isInteger(postgresSink?.row_count) ? postgresSink.row_count : null,
    reviewCaseCount: reviewRows(batch).length,
    artifactCount: archivedArtifacts.length,
    checksum: postgresSink?.checksum || batch.checksum,
  };
}

export async function findListingAuditVerifiedIdentityConflicts(batch, { runTransaction } = {}) {
  let transaction = runTransaction;
  if (!transaction) {
    const database = await import('./database.js');
    transaction = database.runDatabaseTransaction;
  }
  const memberships = membershipRows(batch);
  if (memberships.length === 0) return [];
  const results = await transaction(sql => [
    sql.query(`SET LOCAL ROLE rwa_catalog_shadow_writer`),
    sql.query(`SET LOCAL statement_timeout = '15s'`),
    sql.query(
      `SELECT source.source_key, instrument.official_product_key,
         current_asset.asset_key AS existing_asset_key,
         current_asset_version.category AS existing_category,
         current_asset_version.canonical_underlying AS existing_canonical_underlying,
         incoming.asset_key AS incoming_asset_key,
         incoming.category AS incoming_category,
         incoming.canonical_underlying AS incoming_canonical_underlying
       FROM jsonb_to_recordset($1::jsonb) AS incoming(
         source_key text, official_product_key text, asset_key text,
         category text, canonical_underlying text, venue_category text,
         lifecycle_status text
       )
       JOIN identity.source AS source ON source.source_key = incoming.source_key
       JOIN identity.instrument AS instrument
         ON instrument.source_id = source.source_id
        AND instrument.official_product_key = incoming.official_product_key
       JOIN identity.instrument_version AS current
         ON current.instrument_id = instrument.instrument_id
        AND current.valid_to IS NULL
        AND current.identity_status = 'verified'
       JOIN identity.asset_version AS current_asset_version
         ON current_asset_version.asset_version_id = current.asset_version_id
       JOIN identity.asset AS current_asset
         ON current_asset.asset_id = current_asset_version.asset_id
       WHERE (
         current_asset.asset_key <> incoming.asset_key
         OR current_asset_version.category <> incoming.category
         OR current_asset_version.canonical_underlying <> incoming.canonical_underlying
       )
       AND NOT (
         incoming.canonical_underlying = ANY($2::text[])
         AND current_asset_version.canonical_underlying = incoming.canonical_underlying
         AND current_asset_version.category = 'pre-ipo'
         AND incoming.category = 'equity'
         AND current_asset.asset_key = current_asset_version.category || ':' || current_asset_version.canonical_underlying
         AND incoming.asset_key = incoming.category || ':' || incoming.canonical_underlying
         AND incoming.venue_category IN ('equity', 'pre-ipo')
         AND incoming.lifecycle_status = 'public'
       )
       ORDER BY source.source_key COLLATE "C", instrument.official_product_key COLLATE "C"
       LIMIT 20`,
      [json(memberships), REVIEWED_PUBLIC_LIFECYCLE_CORRECTIONS],
    ),
  ], { isolationLevel:'Serializable', readOnly:true });
  const rows = Array.isArray(results?.[2]) ? results[2] : [];
  return rows.map(row => ({
    sourceKey:normalized(row.source_key),
    officialProductKey:normalized(row.official_product_key),
    existing:{
      assetKey:normalized(row.existing_asset_key),
      category:normalized(row.existing_category),
      canonicalUnderlying:normalized(row.existing_canonical_underlying),
    },
    incoming:{
      assetKey:normalized(row.incoming_asset_key),
      category:normalized(row.incoming_category),
      canonicalUnderlying:normalized(row.incoming_canonical_underlying),
    },
  }));
}

function leaseResultRow(results) {
  return (Array.isArray(results) ? results.flat() : [])
    .find(row => row && (row.lease_key || row.leaseKey));
}

function validLeaseChecksum(value) {
  const checksum = normalized(value).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(checksum)) {
    throw new TypeError('Listing Audit publication lease requires a SHA-256 payload checksum');
  }
  return checksum;
}

function validLeaseOwnerToken(value = randomUUID()) {
  const ownerToken = normalized(value);
  if (!UUID_PATTERN.test(ownerToken)) {
    throw new TypeError('Listing Audit publication lease owner token must be a UUID');
  }
  return ownerToken;
}

async function publicationLeaseTransaction(runTransaction, buildQueries) {
  let transaction = runTransaction;
  if (!transaction) {
    const database = await import('./database.js');
    transaction = database.runDatabaseTransaction;
  }
  return transaction(buildQueries, { isolationLevel:'Serializable' });
}

export async function acquireListingAuditPublicationLease({ observedAt, checksum }, {
  env = process.env,
  ownerToken = randomUUID(),
  runTransaction = null,
} = {}) {
  const pgMode = resolvePgWriteMode(env);
  const capturedAt = isoTimestamp(observedAt);
  const payloadChecksum = validLeaseChecksum(checksum);
  const token = validLeaseOwnerToken(ownerToken);
  if (pgMode === 'off') {
    return {
      mode:pgMode,
      acquired:true,
      status:'off',
      leaseKey:LISTING_PG_PUBLICATION_LEASE_KEY,
      ownerToken:null,
      observedAt:capturedAt,
      checksum:payloadChecksum,
      expiresAt:null,
    };
  }
  const results = await publicationLeaseTransaction(runTransaction, sql => [
    sql.query(`SET LOCAL ROLE rwa_catalog_shadow_writer`),
    sql.query(`SET LOCAL statement_timeout = '15s'`),
    sql.query(`SET LOCAL lock_timeout = '3s'`),
    sql.query(
      `WITH claimed AS (
         INSERT INTO ingest.catalog_publication_lease
           (lease_key, owner_token, observed_at, payload_checksum,
            acquired_at, lease_expires_at, released_at, last_release_status, updated_at)
         VALUES ($1, $2::uuid, $3::timestamptz, $4,
           clock_timestamp(), clock_timestamp() + ($5::int * interval '1 second'),
           NULL, NULL, clock_timestamp())
         ON CONFLICT (lease_key) DO UPDATE SET
           owner_token = EXCLUDED.owner_token,
           observed_at = EXCLUDED.observed_at,
           payload_checksum = EXCLUDED.payload_checksum,
           acquired_at = clock_timestamp(),
           lease_expires_at = clock_timestamp() + ($5::int * interval '1 second'),
           released_at = NULL,
           last_release_status = NULL,
           updated_at = clock_timestamp()
         WHERE ingest.catalog_publication_lease.lease_expires_at <= clock_timestamp()
           AND (
             EXCLUDED.observed_at > ingest.catalog_publication_lease.observed_at
             OR (
               EXCLUDED.observed_at = ingest.catalog_publication_lease.observed_at
               AND EXCLUDED.payload_checksum = ingest.catalog_publication_lease.payload_checksum
             )
           )
         RETURNING lease_key, owner_token::text, observed_at, payload_checksum,
           lease_expires_at, true AS acquired, 'acquired'::text AS lease_status
       )
       SELECT * FROM claimed
       UNION ALL
       SELECT existing.lease_key, existing.owner_token::text, existing.observed_at,
         existing.payload_checksum, existing.lease_expires_at, false AS acquired,
         CASE
           WHEN existing.lease_expires_at > clock_timestamp() THEN 'busy'
           WHEN existing.observed_at > $3::timestamptz THEN 'stale'
           WHEN existing.observed_at = $3::timestamptz
             AND existing.payload_checksum <> $4 THEN 'conflict'
           ELSE 'rejected'
         END AS lease_status
       FROM ingest.catalog_publication_lease AS existing
       WHERE existing.lease_key = $1
         AND NOT EXISTS (SELECT 1 FROM claimed)
       LIMIT 1`,
      [
        LISTING_PG_PUBLICATION_LEASE_KEY,
        token,
        capturedAt,
        payloadChecksum,
        LISTING_PG_PUBLICATION_LEASE_SECONDS,
      ],
    ),
  ]);
  const row = leaseResultRow(results);
  if (!row) throw new Error('Listing Audit publication lease did not return an outcome');
  const acquired = row.acquired === true || row.acquired === 't' || row.acquired === 1;
  return {
    mode:pgMode,
    acquired,
    status:normalized(row.lease_status || row.leaseStatus || (acquired ? 'acquired' : 'rejected')),
    leaseKey:LISTING_PG_PUBLICATION_LEASE_KEY,
    ownerToken:acquired ? token : null,
    observedAt:capturedAt,
    checksum:payloadChecksum,
    expiresAt:row.lease_expires_at || row.leaseExpiresAt || null,
  };
}

export async function renewListingAuditPublicationLease(lease, {
  env = process.env,
  runTransaction = null,
} = {}) {
  const pgMode = resolvePgWriteMode(env);
  if (pgMode === 'off' || lease?.mode === 'off') return { ...lease, renewed:true, status:'off' };
  const ownerToken = validLeaseOwnerToken(lease?.ownerToken);
  const observedAt = isoTimestamp(lease?.observedAt);
  const checksum = validLeaseChecksum(lease?.checksum);
  const results = await publicationLeaseTransaction(runTransaction, sql => [
    sql.query(`SET LOCAL ROLE rwa_catalog_shadow_writer`),
    sql.query(`SET LOCAL statement_timeout = '15s'`),
    sql.query(`SET LOCAL lock_timeout = '3s'`),
    sql.query(
      `UPDATE ingest.catalog_publication_lease
       SET lease_expires_at = clock_timestamp() + ($5::int * interval '1 second'),
         updated_at = clock_timestamp()
       WHERE lease_key = $1
         AND owner_token = $2::uuid
         AND observed_at = $3::timestamptz
         AND payload_checksum = $4
         AND lease_expires_at > clock_timestamp()
       RETURNING lease_key, owner_token::text, observed_at, payload_checksum,
         lease_expires_at, true AS renewed`,
      [
        LISTING_PG_PUBLICATION_LEASE_KEY,
        ownerToken,
        observedAt,
        checksum,
        LISTING_PG_PUBLICATION_LEASE_SECONDS,
      ],
    ),
  ]);
  const row = leaseResultRow(results);
  if (!row) throw new Error(LISTING_PG_PUBLICATION_LEASE_LOST_ERROR_CODE);
  return {
    ...lease,
    renewed:true,
    status:'renewed',
    expiresAt:row.lease_expires_at || row.leaseExpiresAt || null,
  };
}

export async function releaseListingAuditPublicationLease(lease, {
  status = 'failed',
  checksum: publishedChecksum = null,
  env = process.env,
  runTransaction = null,
} = {}) {
  const pgMode = resolvePgWriteMode(env);
  if (pgMode === 'off' || lease?.mode === 'off') return { mode:'off', released:true, status:'off' };
  if (!['published', 'failed'].includes(status)) {
    throw new TypeError('Listing Audit publication lease release status must be published or failed');
  }
  const ownerToken = validLeaseOwnerToken(lease?.ownerToken);
  const observedAt = isoTimestamp(lease?.observedAt);
  const checksum = validLeaseChecksum(lease?.checksum);
  const finalChecksum = status === 'published'
    ? validLeaseChecksum(publishedChecksum || checksum)
    : checksum;
  const results = await publicationLeaseTransaction(runTransaction, sql => [
    sql.query(`SET LOCAL ROLE rwa_catalog_shadow_writer`),
    sql.query(`SET LOCAL statement_timeout = '15s'`),
    sql.query(`SET LOCAL lock_timeout = '3s'`),
    sql.query(
      `UPDATE ingest.catalog_publication_lease
       SET payload_checksum = CASE WHEN $5 = 'published' THEN $6 ELSE payload_checksum END,
         lease_expires_at = GREATEST(acquired_at, clock_timestamp()),
         released_at = clock_timestamp(),
         last_release_status = $5,
         last_published_at = CASE WHEN $5 = 'published' THEN $3::timestamptz ELSE last_published_at END,
         last_published_checksum = CASE WHEN $5 = 'published' THEN $6 ELSE last_published_checksum END,
         updated_at = clock_timestamp()
       WHERE lease_key = $1
         AND owner_token = $2::uuid
         AND observed_at = $3::timestamptz
         AND payload_checksum = $4
       RETURNING lease_key, true AS released`,
      [LISTING_PG_PUBLICATION_LEASE_KEY, ownerToken, observedAt, checksum, status, finalChecksum],
    ),
  ]);
  const released = Boolean(leaseResultRow(results));
  return { mode:pgMode, released, status:released ? status : 'owner-mismatch' };
}

export async function recordListingAuditRuntimeCacheCommit({
  observedAt,
  status,
  rowCount = null,
  checksum = null,
  errorSummary = null,
}, {
  env = process.env,
  logger = console,
  runTransaction = null,
} = {}) {
  const pgMode = resolvePgWriteMode(env);
  if (pgMode === 'off') return { mode:pgMode, status:'off' };
  if (!['stored', 'failed'].includes(status)) {
    throw new TypeError('Runtime Cache sink status must be stored or failed');
  }
  const completedAt = isoTimestamp(observedAt);
  const bucketAt = utcListingAuditBucket(completedAt);
  const safeChecksum = /^[0-9a-f]{64}$/.test(normalized(checksum)) ? checksum : null;
  const safeRowCount = Number.isInteger(rowCount) && rowCount >= 0 ? rowCount : null;
  let transaction = runTransaction;
  if (!transaction) {
    const database = await import('./database.js');
    transaction = database.runDatabaseTransaction;
  }
  try {
    const results = await transaction(sql => [
      sql.query(`SET LOCAL ROLE rwa_catalog_shadow_writer`),
      sql.query(`SET LOCAL statement_timeout = '15s'`),
      sql.query(`SET LOCAL lock_timeout = '3s'`),
      sql.query(
        `INSERT INTO ingest.sink_commit
           (attempt_id, sink_name, status, row_count, checksum, committed_at, error_summary)
         SELECT attempt.attempt_id, 'runtime-cache-listing-audit', $5,
           $6, $7, $8::timestamptz, $9
         FROM ingest.collection_cycle AS cycle
         JOIN ingest.collection_attempt AS attempt
           ON attempt.cycle_id = cycle.cycle_id AND attempt.attempt_no = $4
         WHERE cycle.job_name = $1
           AND cycle.pipeline_version = $2
           AND cycle.bucket_at = $3::timestamptz
         ON CONFLICT (attempt_id, sink_name) DO UPDATE SET
           status = EXCLUDED.status,
           row_count = EXCLUDED.row_count,
           checksum = EXCLUDED.checksum,
           committed_at = EXCLUDED.committed_at,
           error_summary = EXCLUDED.error_summary
         RETURNING sink_commit_id`,
        [
          LISTING_PG_JOB_NAME,
          LISTING_PG_PIPELINE_VERSION,
          bucketAt,
          1,
          status,
          safeRowCount,
          safeChecksum,
          completedAt,
          status === 'failed' ? safeError(errorSummary) : null,
        ],
      ),
    ], { isolationLevel:'Serializable' });
    if (!Array.isArray(results?.at?.(-1)) || results.at(-1).length !== 1) {
      throw new Error('Listing Audit PostgreSQL attempt is unavailable for Runtime Cache sink commit');
    }
    return { mode:pgMode, status };
  } catch (error) {
    // This is post-cache bookkeeping. The Runtime Cache baseline has already
    // committed and cannot be rolled back with PostgreSQL, so never turn its
    // success into a false 503 even when the pre-cache catalog write was
    // required. The pending row from the primary transaction remains visible.
    logger?.error?.('[listing-audit] Runtime Cache sink commit shadow write failed', safeError(error));
    return { mode:pgMode, status:'failed', error:safeError(error) };
  }
}

export async function runOptionalListingAuditPgWrite(input, {
  env = process.env,
  logger = console,
  archiveArtifacts = archiveListingAuditArtifacts,
  writeBatch = writeListingAuditPgBatch,
  findIdentityConflicts = findListingAuditVerifiedIdentityConflicts,
} = {}) {
  const pgMode = resolvePgWriteMode(env);
  const archiveMode = resolveRawArchiveMode(env);
  if (pgMode === 'off' && archiveMode === 'off') {
    return { pgMode, archiveMode, status: 'off' };
  }
  let batch;
  try {
    batch = buildListingAuditPgBatch({ ...input, env });
  } catch (error) {
    if (pgMode === 'required' || archiveMode === 'required') {
      throw new Error(`Required listing persistence preparation failed: ${safeError(error)}`, { cause: error });
    }
    logger?.error?.('[listing-audit] shadow persistence preparation failed', safeError(error));
    return { pgMode, archiveMode, status: 'failed', error: safeError(error) };
  }

  let archivedArtifacts;
  try {
    archivedArtifacts = await archiveArtifacts(batch, { mode: archiveMode });
  } catch (error) {
    if (archiveMode === 'required') {
      throw new Error(`Required normalized catalog archive failed: ${safeError(error)}`, { cause: error });
    }
    logger?.error?.('[listing-audit] normalized catalog shadow archive failed', safeError(error));
    archivedArtifacts = await archiveListingAuditArtifacts(batch, { mode: 'off' });
  }

  const archiveFailures = archivedArtifacts.filter(row => row.archiveStatus === 'failed').length;
  let writeResult = null;
  if (pgMode !== 'off') {
    try {
      writeResult = await writeBatch(batch, archivedArtifacts);
    } catch (error) {
      const consistencyError = persistenceConsistencyError(error);
      if (consistencyError) {
        let identityConflicts = [];
        if (consistencyError === LISTING_PG_VERIFIED_IDENTITY_CONFLICT_ERROR_CODE) {
          try {
            identityConflicts = await findIdentityConflicts(batch);
          } catch (diagnosticError) {
            logger?.error?.('[listing-audit] identity conflict diagnostic failed', safeError(diagnosticError));
          }
        }
        logger?.warn?.(
          '[listing-audit] consistency-conflicting retry rejected before Runtime Cache publication',
          JSON.stringify({ code:consistencyError, identityConflicts }),
        );
        return {
          pgMode,
          archiveMode,
          status: consistencyError === LISTING_PG_STALE_RETRY_ERROR_CODE ? 'stale' : 'rejected',
          staleRetry: consistencyError === LISTING_PG_STALE_RETRY_ERROR_CODE,
          consistencyRejected: true,
          publishAllowed: false,
          archiveFailures,
          error: consistencyError,
          identityConflicts,
        };
      }
      if (pgMode === 'required') {
        throw new Error(`Required PostgreSQL listing write failed: ${safeError(error)}`, { cause: error });
      }
      logger?.error?.('[listing-audit] PostgreSQL shadow write failed', safeError(error));
      return {
        pgMode,
        archiveMode,
        status: archiveFailures ? 'failed' : 'partial',
        archiveFailures,
        error: safeError(error),
      };
    }
  }

  return {
    pgMode,
    archiveMode,
    status: archiveFailures ? (pgMode === 'off' ? 'failed' : 'partial') : 'stored',
    staleRetry: false,
    publishAllowed: true,
    archiveFailures,
    ...(writeResult || {
      sourceRunCount: batch.sourceRuns.length,
      artifactCount: archivedArtifacts.length,
      checksum: batch.checksum,
    }),
  };
}

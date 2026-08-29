export const LISTING_AUDIT_SCHEMA_VERSION = 'rwa-listing-audit/v1';
export const LISTING_AUDIT_STATE_VERSION = 1;
export const LISTING_EVENT_RETENTION_DAYS = 45;
export const LISTING_EVENT_MAX = 2_000;
export const LISTING_KNOWN_RETENTION_DAYS = 180;
export const LISTING_SOURCE_DRIFT_RATIO = 0.10;
export const LISTING_SOURCE_DRIFT_ALLOWANCE = 5;
export const LISTING_SOURCE_EXTREME_GROWTH_RATIO = 0.50;
export const LISTING_SOURCE_EXTREME_GROWTH_ALLOWANCE = 50;
export const LISTING_SOURCE_KEYS = Object.freeze([
  'perp:tradexyz',
  'perp:bitget',
  'perp:gate',
  'perp:binance',
  'perp:okx',
  'spot:bitget',
  'spot:gate',
  'spot:kraken',
  'spot:binance',
  'spot:okx',
]);

const MARKETS = new Set(['perp', 'spot']);
const VENUES = new Set(['tradexyz', 'bitget', 'gate', 'kraken', 'binance', 'okx']);
const CATEGORIES = new Set(['equity', 'etf', 'commodity', 'index', 'fx', 'bond', 'pre-ipo']);
const LIFECYCLE_STATUSES = new Set(['public', 'pre-ipo', 'ipo-registered']);
const IDENTITY_STATUSES = new Set(['verified', 'review-required']);
const LISTING_KEY_PATTERN = /^[A-Z0-9._:-]{1,90}$/;
const CANONICAL_PATTERN = /^[A-Z0-9.-]{1,40}$/;

function normalized(value) {
  return String(value ?? '').trim();
}

function normalizedUpper(value) {
  return normalized(value).toUpperCase();
}

function isoTimestamp(value, fallback = null) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

export function listingSourceKey(market, venue) {
  const normalizedMarket = normalized(market).toLowerCase();
  const normalizedVenue = normalized(venue).toLowerCase();
  return `${normalizedMarket}:${normalizedVenue}`;
}

export function normalizeListingObservation(input) {
  const market = normalized(input?.market).toLowerCase();
  const venue = normalized(input?.venue).toLowerCase();
  const venueSymbol = normalizedUpper(input?.venueSymbol);
  const canonicalSymbol = normalizedUpper(input?.canonicalSymbol);
  const category = normalized(input?.category).toLowerCase();
  const rawVenueCategory = normalized(input?.venueCategory).toLowerCase();
  const venueCategory = rawVenueCategory || category;
  const rawLifecycleStatus = normalized(input?.lifecycleStatus).toLowerCase();
  const lifecycleStatus = rawLifecycleStatus || null;
  const identityStatus = normalized(input?.identityStatus || 'verified').toLowerCase();
  if (!MARKETS.has(market) || !VENUES.has(venue)) return null;
  if (!LISTING_KEY_PATTERN.test(venueSymbol) || !CANONICAL_PATTERN.test(canonicalSymbol)) return null;
  if (
    !CATEGORIES.has(category) ||
    !CATEGORIES.has(venueCategory) ||
    (lifecycleStatus !== null && !LIFECYCLE_STATUSES.has(lifecycleStatus)) ||
    !IDENTITY_STATUSES.has(identityStatus)
  ) return null;
  const sourceKey = listingSourceKey(market, venue);
  return Object.freeze({
    key: `${sourceKey}:${venueSymbol}`,
    sourceKey,
    market,
    venue,
    venueSymbol,
    canonicalSymbol,
    category,
    venueCategory,
    lifecycleStatus,
    name: normalized(input?.name) || null,
    identityStatus,
    identityEvidence: normalized(input?.identityEvidence) || null,
    inclusionStatus: identityStatus === 'verified' ? 'eligible' : 'review-required',
  });
}

export function normalizeSourceObservation(input) {
  const market = normalized(input?.market).toLowerCase();
  const venue = normalized(input?.venue).toLowerCase();
  const sourceKey = listingSourceKey(market, venue);
  if (!LISTING_SOURCE_KEYS.includes(sourceKey)) return null;
  const rawRows = Array.isArray(input?.listings) ? input.listings : null;
  const rows = new Map();
  let invalidCount = 0;
  let duplicateCount = 0;
  for (const raw of rawRows || []) {
    const listing = normalizeListingObservation({ ...raw, market, venue });
    if (!listing) { invalidCount += 1; continue; }
    if (rows.has(listing.key)) { duplicateCount += 1; continue; }
    rows.set(listing.key, listing);
  }
  const requestedStatus = normalized(input?.status || 'full').toLowerCase();
  const invalidCatalog = !rawRows || invalidCount > 0 || duplicateCount > 0;
  const status = requestedStatus === 'full' && !invalidCatalog ? 'full' : 'unavailable';
  const validationReason = invalidCatalog
    ? `catalog normalization rejected ${invalidCount} invalid and ${duplicateCount} duplicate listings`
    : null;
  return {
    sourceKey,
    market,
    venue,
    status,
    reason: normalized(input?.reason) || validationReason,
    listings: [...rows.values()].sort((left, right) => left.key.localeCompare(right.key)),
  };
}

function sourceStateRows(sourceState, known = {}) {
  if (Array.isArray(sourceState?.listingKeys)) {
    return sourceState.listingKeys
      .map(key => normalizeListingObservation(known?.[key]))
      .filter(Boolean);
  }
  // Backward-compatible migration for any pre-compaction state written by an
  // earlier preview build.
  return Array.isArray(sourceState?.listings)
    ? sourceState.listings.map(normalizeListingObservation).filter(Boolean)
    : [];
}

function eventFromListing(changeType, listing, detectedAt, previous = null) {
  const active = changeType !== 'delisted';
  const row = active ? listing : previous;
  return {
    eventId: `${changeType}:${row.key}:${detectedAt}`,
    listingKey: row.key,
    changeType,
    detectedAt,
    market: row.market,
    venue: row.venue,
    venueSymbol: row.venueSymbol,
    canonicalSymbol: row.canonicalSymbol,
    category: row.category,
    venueCategory: row.venueCategory,
    lifecycleStatus: row.lifecycleStatus,
    name: row.name || null,
    identityStatus: row.identityStatus,
    identityEvidence: row.identityEvidence || null,
    inclusionStatus: active ? row.inclusionStatus : 'removed',
  };
}

function retainedEventHistory(events, nowMs, previousHistory = null) {
  const cutoff = nowMs - LISTING_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
  const unique = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const detectedAt = isoTimestamp(event?.detectedAt);
    if (!detectedAt || Date.parse(detectedAt) < cutoff) continue;
    const eventId = normalized(event?.eventId);
    if (!eventId) continue;
    unique.set(eventId, { ...event, eventId, detectedAt });
  }
  const sorted = [...unique.values()]
    .sort((left, right) => Date.parse(right.detectedAt) - Date.parse(left.detectedAt) || left.eventId.localeCompare(right.eventId));
  const eventsWithinBudget = sorted.slice(0, LISTING_EVENT_MAX);
  const droppedNow = Math.max(0, sorted.length - eventsWithinBudget.length);
  const previousDroppedThrough = isoTimestamp(previousHistory?.droppedThrough);
  const carryPreviousTruncation = Boolean(
    previousHistory?.truncated &&
    previousDroppedThrough &&
    Date.parse(previousDroppedThrough) >= cutoff
  );
  const newestDroppedNow = droppedNow ? sorted[LISTING_EVENT_MAX]?.detectedAt || null : null;
  const droppedThrough = [carryPreviousTruncation ? previousDroppedThrough : null, newestDroppedNow]
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
  const droppedAtLeast = (carryPreviousTruncation ? Number(previousHistory?.droppedAtLeast || 1) : 0) + droppedNow;
  return {
    events: eventsWithinBudget,
    history: {
      retentionDays: LISTING_EVENT_RETENTION_DAYS,
      maxEvents: LISTING_EVENT_MAX,
      truncated: droppedAtLeast > 0,
      droppedAtLeast,
      droppedThrough,
      retainedFrom: eventsWithinBudget.at(-1)?.detectedAt || null,
    },
  };
}

function retainedKnown(known, nowMs) {
  const cutoff = nowMs - LISTING_KNOWN_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
  return Object.fromEntries(Object.entries(known || {}).filter(([, row]) => {
    if (row?.active) return true;
    const lastRelevantAt = Date.parse(row?.removedAt || row?.lastSeenAt || '');
    return Number.isFinite(lastRelevantAt) && lastRelevantAt >= cutoff;
  }));
}

function identityFingerprint(row) {
  return `${normalized(row?.canonicalSymbol)}|${normalized(row?.category)}`;
}

function dailyEventTimestamp(value) {
  const detectedAt = isoTimestamp(value, new Date().toISOString());
  return { detectedAt, eventBucket:detectedAt.slice(0, 10) };
}

function emptyState() {
  return {
    version: LISTING_AUDIT_STATE_VERSION,
    initializedAt: null,
    updatedAt: null,
    sources: {},
    known: {},
    events: [],
    eventHistory: null,
  };
}

export function mergeListingAudit(previousState, rawObservations, now = new Date()) {
  const { detectedAt:nowIso, eventBucket } = dailyEventTimestamp(now);
  const nowMs = Date.parse(nowIso);
  const previous = previousState?.version === LISTING_AUDIT_STATE_VERSION
    ? previousState
    : emptyState();
  const retainedPreviousEvents = retainedEventHistory(previous.events, nowMs, previous.eventHistory);
  const next = {
    version: LISTING_AUDIT_STATE_VERSION,
    initializedAt: previous.initializedAt || nowIso,
    updatedAt: nowIso,
    sources: { ...(previous.sources || {}) },
    known: retainedKnown(previous.known, nowMs),
    events: retainedPreviousEvents.events,
    eventHistory: retainedPreviousEvents.history,
  };
  const observationMap = new Map();
  for (const raw of Array.isArray(rawObservations) ? rawObservations : []) {
    const observation = normalizeSourceObservation(raw);
    if (observation) observationMap.set(observation.sourceKey, observation);
  }

  const sourceSummaries = [];
  const newEvents = [];
  for (const sourceKey of LISTING_SOURCE_KEYS) {
    const [market, venue] = sourceKey.split(':');
    const observation = observationMap.get(sourceKey);
    const previousSource = previous.sources?.[sourceKey] || null;
    if (!observation || observation.status !== 'full') {
      const retainedCount = sourceStateRows(previousSource, previous.known).length;
      sourceSummaries.push({
        sourceKey,
        market,
        venue,
        status: 'unavailable',
        listingCount: retainedCount,
        previousCount: retainedCount,
        added: 0,
        removed: 0,
        baselineAt: previousSource?.baselineAt || null,
        observedAt: previousSource?.observedAt || null,
        reason: observation?.reason || 'source observation unavailable',
      });
      continue;
    }

    const currentRows = observation.listings;
    const currentByKey = new Map(currentRows.map(row => [row.key, row]));
    const previousRows = sourceStateRows(previousSource, previous.known);
    const previousByKey = new Map(previousRows.map(row => [row.key, row]));
    const warming = !previousSource?.baselineAt;
    const activeIdentityDrift = warming ? [] : currentRows.filter(row => {
      const previousRow = previousByKey.get(row.key);
      return previousRow && (
        identityFingerprint(previousRow) !== identityFingerprint(row) ||
        (previousRow.identityStatus === 'verified' && row.identityStatus !== 'verified')
      );
    });
    const observedAddedRows = warming ? [] : currentRows.filter(row => !previousByKey.has(row.key));
    const observedMissingRows = warming ? [] : previousRows.filter(row => !currentByKey.has(row.key));
    const reusedIdentityDrift = warming ? [] : observedAddedRows.filter(row => {
      const known = previous.known?.[row.key];
      return known?.everSeen && known.active === false && (
        identityFingerprint(known) !== identityFingerprint(row) ||
        (known.identityStatus === 'verified' && row.identityStatus !== 'verified')
      );
    });
    const identityDrift = [...activeIdentityDrift, ...reusedIdentityDrift];
    const driftRatio = previousRows.length
      ? (observedAddedRows.length + observedMissingRows.length) / previousRows.length
      : 0;
    const changedListings = observedAddedRows.length + observedMissingRows.length;
    const hasRemovals = observedMissingRows.length > 0;
    const removalDrift = !warming && hasRemovals &&
      changedListings > LISTING_SOURCE_DRIFT_ALLOWANCE && driftRatio > LISTING_SOURCE_DRIFT_RATIO;
    const extremePureGrowth = !warming && !hasRemovals &&
      observedAddedRows.length > LISTING_SOURCE_EXTREME_GROWTH_ALLOWANCE &&
      driftRatio > LISTING_SOURCE_EXTREME_GROWTH_RATIO;
    if (identityDrift.length || removalDrift || extremePureGrowth) {
      const reason = identityDrift.length
        ? `identity drift for ${identityDrift.slice(0, 3).map(row => row.venueSymbol).join(', ')}`
        : removalDrift
          ? `catalog changed ${(driftRatio * 100).toFixed(1)}% with removals, above the ${(LISTING_SOURCE_DRIFT_RATIO * 100).toFixed(0)}% daily review threshold`
          : `catalog grew ${(driftRatio * 100).toFixed(1)}% by ${observedAddedRows.length} listings, above the extreme-growth review threshold`;
      sourceSummaries.push({
        sourceKey,
        market,
        venue,
        status: 'unavailable',
        listingCount: currentRows.length,
        previousCount: previousRows.length,
        added: observedAddedRows.length,
        removed: observedMissingRows.length,
        baselineAt: previousSource?.baselineAt || null,
        observedAt: nowIso,
        reason,
      });
      continue;
    }

    const previousPendingRemovals = previousSource?.pendingRemovals && typeof previousSource.pendingRemovals === 'object'
      ? previousSource.pendingRemovals
      : {};
    const pendingRemovals = {};
    const removedRows = [];
    const retainedMissingRows = [];
    for (const row of observedMissingRows) {
      const firstMissingAt = isoTimestamp(previousPendingRemovals[row.key]);
      // Retries or manual verification runs within the same UTC day are not
      // independent observations. Confirm a delisting only after a later
      // daily catalog pass still cannot find the instrument.
      if (firstMissingAt && firstMissingAt.slice(0, 10) !== eventBucket) removedRows.push(row);
      else {
        pendingRemovals[row.key] = firstMissingAt || nowIso;
        retainedMissingRows.push(row);
      }
    }
    const addedRows = observedAddedRows;
    const effectiveRows = [...currentRows, ...retainedMissingRows]
      .sort((left, right) => left.key.localeCompare(right.key));

    for (const listing of addedRows) {
      const known = next.known[listing.key];
      const changeType = known?.everSeen ? 'relisted' : 'new';
      const event = eventFromListing(changeType, listing, eventBucket);
      event.detectedAt = nowIso;
      newEvents.push(event);
      next.known[listing.key] = {
        ...listing,
        everSeen: true,
        active: true,
        firstSeenAt: known?.firstSeenAt || nowIso,
        lastSeenAt: nowIso,
      };
    }
    for (const listing of removedRows) {
      const known = next.known[listing.key] || listing;
      const event = eventFromListing('delisted', null, eventBucket, known);
      event.detectedAt = nowIso;
      newEvents.push(event);
      next.known[listing.key] = {
        ...known,
        everSeen: true,
        active: false,
        firstSeenAt: known.firstSeenAt || previousSource?.baselineAt || nowIso,
        lastSeenAt: known.lastSeenAt || previousSource?.observedAt || nowIso,
        removedAt: nowIso,
      };
    }
    for (const listing of currentRows) {
      const known = next.known[listing.key];
      next.known[listing.key] = {
        ...listing,
        everSeen: true,
        active: true,
        firstSeenAt: known?.firstSeenAt || previousSource?.baselineAt || nowIso,
        lastSeenAt: nowIso,
        removedAt: null,
      };
    }

    const baselineAt = previousSource?.baselineAt || nowIso;
    next.sources[sourceKey] = {
      sourceKey,
      market,
      venue,
      baselineAt,
      observedAt: nowIso,
      // Store only keys here. Full identity rows live once in `known`, which
      // keeps the Runtime Cache bundle safely below its size budget.
      listingKeys: effectiveRows.map(row => row.key),
      pendingRemovals,
    };
    sourceSummaries.push({
      sourceKey,
      market,
      venue,
      status: warming ? 'warming' : Object.keys(pendingRemovals).length ? 'partial' : 'full',
      listingCount: currentRows.length,
      previousCount: previousRows.length,
      added: addedRows.length,
      removed: removedRows.length,
      pendingRemovalCount: Object.keys(pendingRemovals).length,
      baselineAt,
      observedAt: nowIso,
      reason: null,
    });
  }

  const retainedCurrentEvents = retainedEventHistory(
    [...newEvents, ...next.events],
    nowMs,
    next.eventHistory,
  );
  next.eventHistory = retainedCurrentEvents.history;
  next.events = retainedCurrentEvents.events.map(event => {
    if (!['new', 'relisted'].includes(event.changeType)) return event;
    const known = next.known[event.listingKey];
    if (!known) return event;
    return {
      ...event,
      canonicalSymbol: known.canonicalSymbol,
      category: known.category,
      venueCategory: known.venueCategory,
      lifecycleStatus: known.lifecycleStatus,
      name: known.name || null,
      identityStatus: known.identityStatus,
      identityEvidence: known.identityEvidence || null,
      inclusionStatus: known.active ? known.inclusionStatus : 'removed',
    };
  });
  const availableSources = sourceSummaries.filter(source => source.status !== 'unavailable').length;
  const warmingSources = sourceSummaries.filter(source => source.status === 'warming').length;
  const partialSources = sourceSummaries.filter(source => source.status === 'partial').length;
  const unavailableSources = sourceSummaries.filter(source => source.status === 'unavailable').length;
  const sourceStatus = unavailableSources
    ? (availableSources ? 'partial' : 'unavailable')
    : partialSources ? 'partial'
      : warmingSources ? 'warming' : 'full';
  const status = next.eventHistory.truncated && sourceStatus !== 'unavailable'
    ? 'partial'
    : sourceStatus;
  const pendingReviews = Object.values(next.known)
    .filter(row => row?.active && row?.identityStatus === 'review-required')
    .map(row => ({
      listingKey:row.key,
      market:row.market,
      venue:row.venue,
      venueSymbol:row.venueSymbol,
      canonicalSymbol:row.canonicalSymbol,
      category:row.category,
      venueCategory:row.venueCategory,
      lifecycleStatus:row.lifecycleStatus,
      name:row.name || null,
      identityStatus:row.identityStatus,
      identityEvidence:row.identityEvidence || null,
      inclusionStatus:'review-required',
      firstSeenAt:row.firstSeenAt || null,
      lastSeenAt:row.lastSeenAt || null,
    }))
    .sort((left, right) => String(left.listingKey).localeCompare(String(right.listingKey)));
  const publicSnapshot = {
    schemaVersion: LISTING_AUDIT_SCHEMA_VERSION,
    generatedAt: nowIso,
    status,
    scope: 'Daily official-catalog diff for RWA perpetual and spot listings',
    methodology: {
      identity: 'Official venue product metadata is authoritative; ambiguous Gate Spot suffix candidates remain review-required',
      baseline: 'First successful observation per venue and market establishes a baseline and emits no false new-listing events',
      failurePolicy: 'Unavailable sources retain their last-good catalog and never emit synthetic delistings',
    },
    coverage: {
      expectedSources: LISTING_SOURCE_KEYS.length,
      availableSources,
      warmingSources,
      partialSources,
      unavailableSources,
    },
    counts: {
      activeListings: Object.values(next.known).filter(row => row?.active).length,
      retainedEvents: next.events.length,
      new: next.events.filter(event => event.changeType === 'new').length,
      relisted: next.events.filter(event => event.changeType === 'relisted').length,
      delisted: next.events.filter(event => event.changeType === 'delisted').length,
      reviewRequired: pendingReviews.length,
    },
    sources: sourceSummaries,
    events: next.events,
    pendingReviews,
    history: next.eventHistory,
    persistence: {
      mode: 'vercel-runtime-cache',
      status: 'partial',
      continuity: 'regional best effort; survives deployments but can be evicted and is not a permanent database',
      retentionDays: LISTING_EVENT_RETENTION_DAYS,
    },
  };
  return { state: next, snapshot: publicSnapshot, newEvents };
}

export function emptyListingAuditSnapshot(now = new Date()) {
  return {
    schemaVersion: LISTING_AUDIT_SCHEMA_VERSION,
    generatedAt: null,
    status: 'warming',
    scope: 'Daily official-catalog diff for RWA perpetual and spot listings',
    methodology: {
      identity: 'Official venue product metadata is authoritative',
      baseline: 'Waiting for the first successful daily catalog observation',
      failurePolicy: 'No event is inferred without an official source observation',
    },
    coverage: { expectedSources: LISTING_SOURCE_KEYS.length, availableSources: 0, warmingSources: 0, partialSources: 0, unavailableSources: LISTING_SOURCE_KEYS.length },
    counts: { activeListings: 0, retainedEvents: 0, new: 0, relisted: 0, delisted: 0, reviewRequired: 0 },
    sources: LISTING_SOURCE_KEYS.map(sourceKey => {
      const [market, venue] = sourceKey.split(':');
      return { sourceKey, market, venue, status: 'warming', listingCount: 0, previousCount: 0, added: 0, removed: 0, baselineAt: null, observedAt: null, reason: 'baseline not initialized' };
    }),
    events: [],
    pendingReviews: [],
    history: {
      retentionDays: LISTING_EVENT_RETENTION_DAYS,
      maxEvents: LISTING_EVENT_MAX,
      truncated: false,
      droppedAtLeast: 0,
      droppedThrough: null,
      retainedFrom: null,
    },
    persistence: {
      mode: 'vercel-runtime-cache',
      status: 'partial',
      continuity: 'regional best effort; survives deployments but can be evicted and is not a permanent database',
      retentionDays: LISTING_EVENT_RETENTION_DAYS,
    },
  };
}

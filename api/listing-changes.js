import { getCache } from '@vercel/functions';

import {
  emptyListingAuditSnapshot,
  mergeListingAudit,
} from './_lib/listing-audit.js';
import { collectListingSourceObservations } from './_lib/listing-sources.js';
import {
  setNoStore,
  setPublicCache,
} from './_lib/upstream.js';

export const config = { regions: ['iad1'], maxDuration: 120 };

const CACHE_NAMESPACE = 'rwa-listing-audit-v1';
const BUNDLE_KEY = 'audit-bundle-v1';
const CACHE_TTL_SECONDS = 90 * 24 * 60 * 60;
const MAX_STATE_BYTES = 1_750_000;
let listingAuditRunning = false;

function deploymentBaseUrl(req) {
  const forwarded = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').toLowerCase();
  if (/^[a-z0-9.-]+\.vercel\.app$/.test(forwarded)) return `https://${forwarded}`;
  const deployment = process.env.VERCEL_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return `https://${deployment || 'avenir-rwa-analyst.vercel.app'}`;
}

function hasUnexpectedQuery(req) {
  return Object.keys(req.query || {}).length > 0;
}

function cacheOptions(name) {
  return {
    ttl: CACHE_TTL_SECONDS,
    tags: ['rwa-listing-audit-v1'],
    name,
  };
}

function stateSizeBytes(state) {
  return Buffer.byteLength(JSON.stringify(state), 'utf8');
}

const COMPACT_KNOWN_ENCODING = 'listing-row-array/v1';
const COMPACT_EVENTS_ENCODING = 'listing-event-array/v1';

function listingKeyParts(key) {
  const [market, venue, ...venueParts] = String(key || '').split(':');
  return { market, venue, venueSymbol:venueParts.join(':') };
}

export function compactListingAuditState(state) {
  const known = Object.fromEntries(Object.entries(state?.known || {}).map(([key, row]) => [key, [
    row?.canonicalSymbol || null,
    row?.category || null,
    row?.name || null,
    row?.identityStatus === 'review-required' ? 'r' : 'v',
    row?.identityEvidence || null,
    row?.active ? 1 : 0,
    row?.firstSeenAt || null,
    row?.lastSeenAt || null,
    row?.removedAt || null,
  ]]));
  const events = (Array.isArray(state?.events) ? state.events : []).map(event => [
    event?.eventId || null,
    event?.listingKey || null,
    event?.changeType === 'relisted' ? 'r' : event?.changeType === 'delisted' ? 'd' : 'n',
    event?.detectedAt || null,
    event?.canonicalSymbol || null,
    event?.category || null,
    event?.name || null,
    event?.identityStatus === 'review-required' ? 'r' : 'v',
    event?.identityEvidence || null,
    event?.inclusionStatus === 'review-required' ? 'r' : event?.inclusionStatus === 'removed' ? 'm' : 'e',
  ]);
  return {
    ...state,
    knownEncoding: COMPACT_KNOWN_ENCODING,
    eventsEncoding: COMPACT_EVENTS_ENCODING,
    known,
    events,
  };
}

export function hydrateListingAuditState(state) {
  if (!state) return null;
  const known = state.knownEncoding === COMPACT_KNOWN_ENCODING
    ? Object.fromEntries(Object.entries(state.known || {}).flatMap(([key, compact]) => {
      if (!Array.isArray(compact) || compact.length < 9) return [];
      const { market, venue, venueSymbol } = listingKeyParts(key);
      const identityStatus = compact[3] === 'r' ? 'review-required' : 'verified';
      return [[key, {
        key,
        sourceKey:`${market}:${venue}`,
        market,
        venue,
        venueSymbol,
        canonicalSymbol:compact[0],
        category:compact[1],
        name:compact[2],
        identityStatus,
        identityEvidence:compact[4],
        inclusionStatus:identityStatus === 'verified' ? 'eligible' : 'review-required',
        everSeen:true,
        active:compact[5] === 1,
        firstSeenAt:compact[6],
        lastSeenAt:compact[7],
        removedAt:compact[8],
      }]];
    }))
    : state.known;
  const events = state.eventsEncoding === COMPACT_EVENTS_ENCODING
    ? (Array.isArray(state.events) ? state.events : []).flatMap(compact => {
      if (!Array.isArray(compact) || compact.length < 10) return [];
      const [eventId, listingKey, changeCode, detectedAt, canonicalSymbol, category, name, identityCode, identityEvidence, inclusionCode] = compact;
      const { market, venue, venueSymbol } = listingKeyParts(listingKey);
      return [{
        eventId,
        listingKey,
        changeType:changeCode === 'r' ? 'relisted' : changeCode === 'd' ? 'delisted' : 'new',
        detectedAt,
        market,
        venue,
        venueSymbol,
        canonicalSymbol,
        category,
        name,
        identityStatus:identityCode === 'r' ? 'review-required' : 'verified',
        identityEvidence,
        inclusionStatus:inclusionCode === 'r' ? 'review-required' : inclusionCode === 'm' ? 'removed' : 'eligible',
      }];
    })
    : state.events;
  const {
    knownEncoding: _knownEncoding,
    eventsEncoding: _eventsEncoding,
    ...rest
  } = state;
  return { ...rest, known, events };
}

export function compactListingAuditBundle(state, snapshot) {
  const { events: _events, ...snapshotWithoutEvents } = snapshot || {};
  return {
    version: 2,
    state:compactListingAuditState(state),
    snapshot: snapshotWithoutEvents,
  };
}

export function hydrateListingAuditSnapshot(bundle) {
  const snapshot = bundle?.snapshot;
  if (!snapshot || typeof snapshot !== 'object') return null;
  const hydratedState = hydrateListingAuditState(bundle?.state);
  const events = Array.isArray(hydratedState?.events)
    ? hydratedState.events
    : Array.isArray(snapshot.events) ? snapshot.events : [];
  return { ...snapshot, events };
}

function responseSnapshot(snapshot) {
  return {
    ...snapshot,
    persistence: {
      ...snapshot.persistence,
      region: process.env.VERCEL_REGION || 'iad1',
    },
  };
}

export async function readListingChangesSnapshot() {
  const cache = getCache({ namespace: CACHE_NAMESPACE });
  const bundle = await cache.get(BUNDLE_KEY);
  const snapshot = hydrateListingAuditSnapshot(bundle);
  return snapshot
    ? responseSnapshot(snapshot)
    : responseSnapshot(emptyListingAuditSnapshot());
}

export async function runListingAudit(req, res) {
  if (listingAuditRunning) {
    setNoStore(res);
    return res.status(409).json({ error: 'Listing audit already in progress' });
  }
  listingAuditRunning = true;
  const cache = getCache({ namespace: CACHE_NAMESPACE });
  let previousBundle;
  try {
    previousBundle = await cache.get(BUNDLE_KEY);
  } catch (error) {
    console.error('[listing-audit] runtime state read failed', error);
    setNoStore(res);
    listingAuditRunning = false;
    return res.status(503).json({
      error: 'Listing audit persistence unavailable',
      ...responseSnapshot(emptyListingAuditSnapshot()),
    });
  }

  try {
    const observations = await collectListingSourceObservations(deploymentBaseUrl(req));
    const merged = mergeListingAudit(hydrateListingAuditState(previousBundle?.state), observations, new Date());
    const snapshot = responseSnapshot(merged.snapshot);
    // Events are persisted once in state and injected into the public snapshot
    // at read time. Persisting them in both branches materially reduces the
    // 45-day history capacity of Runtime Cache.
    const bundle = compactListingAuditBundle(merged.state, snapshot);
    const stateBytes = stateSizeBytes(bundle);
    if (stateBytes > MAX_STATE_BYTES) {
      console.error('[listing-audit] bundle exceeds Runtime Cache safety budget', { stateBytes });
      setNoStore(res);
      return res.status(503).json({ error: 'Listing audit state exceeds persistence budget' });
    }
    // State and the public snapshot are one cache value, so a partial write can
    // never expose a snapshot that disagrees with the next comparison state.
    await cache.set(BUNDLE_KEY, bundle, cacheOptions('RWA daily listing audit bundle'));

    const summary = {
      status: snapshot.status,
      generatedAt: snapshot.generatedAt,
      availableSources: snapshot.coverage.availableSources,
      newEvents: merged.newEvents.map(event => ({
        changeType: event.changeType,
        market: event.market,
        venue: event.venue,
        venueSymbol: event.venueSymbol,
        identityStatus: event.identityStatus,
      })),
    };
    if (snapshot.status === 'full' || snapshot.status === 'warming') {
      console.log('[listing-audit]', JSON.stringify(summary));
    } else {
      console.warn('[listing-audit]', JSON.stringify(summary));
    }
    setNoStore(res);
    return res.status(snapshot.status === 'unavailable' ? 503 : 200).json(snapshot);
  } catch (error) {
    console.error('[listing-audit] run or atomic bundle write failed', error);
    setNoStore(res);
    const fallback = hydrateListingAuditSnapshot(previousBundle) || responseSnapshot(emptyListingAuditSnapshot());
    return res.status(503).json({
      error: 'Listing audit persistence unavailable',
      ...fallback,
      persistence: { ...fallback.persistence, status: 'unavailable' },
    });
  } finally {
    listingAuditRunning = false;
  }
}

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    setNoStore(res);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (hasUnexpectedQuery(req)) {
    setNoStore(res);
    return res.status(400).json({ error: 'Unexpected query param' });
  }
  try {
    const snapshot = await readListingChangesSnapshot();
    setPublicCache(res, 300, 600);
    res.setHeader('Vercel-Cache-Tag', 'rwa-listing-audit-v1');
    return res.status(200).json(snapshot);
  } catch (error) {
    console.error('[listing-changes] runtime snapshot unavailable', error);
    setNoStore(res);
    return res.status(503).json({
      error: 'Listing change snapshot unavailable',
      ...responseSnapshot(emptyListingAuditSnapshot()),
      persistence: {
        ...emptyListingAuditSnapshot().persistence,
        status: 'unavailable',
        region: process.env.VERCEL_REGION || 'iad1',
      },
    });
  }
}

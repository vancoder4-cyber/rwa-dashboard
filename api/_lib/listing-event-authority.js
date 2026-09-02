import {
  LISTING_AUDIT_SCHEMA_VERSION,
  LISTING_EVENT_MAX,
  LISTING_EVENT_RETENTION_DAYS,
  LISTING_SOURCE_KEYS,
} from './listing-audit.js';
import {
  listingDatabaseConfigured,
  runListingDatabaseTransaction,
} from './database.js';

export const LISTING_EVENT_READER_ROLE = 'rwa_listing_audit_reader';
export const LISTING_EVENT_VIEW_VERSION = 'publication.listing_change_event_v1';

const MARKETS = new Set(['perp', 'spot']);
const VENUES = new Set(['tradexyz', 'bitget', 'gate', 'kraken', 'binance', 'okx']);
const CATEGORIES = new Set(['equity', 'etf', 'commodity', 'index', 'fx', 'bond', 'pre-ipo']);
const LIFECYCLE_STATUSES = new Set(['public', 'pre-ipo', 'ipo-registered']);
const SOURCE_STATUSES = new Set(['full', 'partial', 'warming', 'unavailable']);
const EVENT_TYPES = new Set(['listed', 'relisted', 'delisted']);
const LISTING_KEY_PATTERN = /^[A-Z0-9._:-]{1,90}$/;
const CANONICAL_PATTERN = /^[A-Z0-9.-]{1,40}$/;

function value(row, snake, camel = snake) {
  return row?.[snake] ?? row?.[camel];
}

function normalized(valueToNormalize) {
  return String(valueToNormalize ?? '').trim();
}

function isoTimestamp(valueToNormalize, nullable = false) {
  if (nullable && (valueToNormalize === null || valueToNormalize === undefined || valueToNormalize === '')) return null;
  const date = valueToNormalize instanceof Date ? valueToNormalize : new Date(valueToNormalize);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function nonNegativeInteger(valueToNormalize) {
  const number = Number(valueToNormalize);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizeSourceStatus(row) {
  const mergedStatus = normalized(value(row, 'merged_status', 'mergedStatus')).toLowerCase();
  const runStatus = normalized(value(row, 'run_status', 'runStatus')).toLowerCase();
  const catalogStatus = normalized(value(row, 'catalog_status', 'catalogStatus')).toLowerCase();
  const identityStatus = normalized(value(row, 'identity_status', 'identityStatus')).toLowerCase();
  if (runStatus === 'unavailable' || runStatus === 'failed' || catalogStatus === 'unavailable') return 'unavailable';
  if (mergedStatus === 'warming') return 'warming';
  if (runStatus === 'partial' || catalogStatus === 'partial' || identityStatus === 'partial' || mergedStatus === 'partial') {
    return 'partial';
  }
  return runStatus === 'full' && catalogStatus === 'full' && identityStatus === 'full'
    ? 'full'
    : 'unavailable';
}

function normalizeSourceRow(row) {
  const sourceKey = normalized(value(row, 'source_key', 'sourceKey')).toLowerCase();
  const [expectedMarket, expectedVenue] = sourceKey.split(':');
  const market = normalized(row?.market).toLowerCase();
  const venue = normalized(row?.venue).toLowerCase();
  const listingCount = nonNegativeInteger(value(row, 'listing_count', 'listingCount'));
  const pendingRemovalCount = nonNegativeInteger(value(row, 'pending_removal_count', 'pendingRemovalCount'));
  const baselineAt = isoTimestamp(value(row, 'baseline_at', 'baselineAt'), true);
  const observedAt = isoTimestamp(value(row, 'observed_at', 'observedAt'), true);
  if (!LISTING_SOURCE_KEYS.includes(sourceKey) || market !== expectedMarket || venue !== expectedVenue ||
      listingCount === null || pendingRemovalCount === null) {
    throw new TypeError(`Invalid Listing Audit source-run projection for ${sourceKey || 'unknown source'}`);
  }
  const status = normalizeSourceStatus(row);
  if (!SOURCE_STATUSES.has(status)) throw new TypeError(`Invalid Listing Audit source status for ${sourceKey}`);
  const errorCodes = Array.isArray(value(row, 'error_codes', 'errorCodes'))
    ? value(row, 'error_codes', 'errorCodes').map(normalized).filter(Boolean)
    : [];
  return {
    sourceKey,
    market,
    venue,
    status,
    listingCount,
    previousCount:listingCount,
    added:0,
    removed:0,
    pendingRemovalCount,
    baselineAt,
    observedAt,
    reason:errorCodes.length ? errorCodes.join(', ') : null,
  };
}

function normalizeEventRow(row) {
  const eventId = normalized(value(row, 'event_id', 'eventId'));
  const market = normalized(row?.market).toLowerCase();
  const venue = normalized(row?.venue).toLowerCase();
  const venueSymbol = normalized(value(row, 'venue_symbol', 'venueSymbol')).toUpperCase();
  const canonicalSymbol = normalized(value(row, 'canonical_symbol', 'canonicalSymbol')).toUpperCase();
  const listingKey = `${market}:${venue}:${venueSymbol}`;
  const declaredListingKey = normalized(value(row, 'listing_key', 'listingKey'));
  const name = normalized(value(row, 'display_name', 'displayName'));
  const category = normalized(row?.category).toLowerCase();
  const venueCategory = normalized(value(row, 'venue_category', 'venueCategory')).toLowerCase();
  const lifecycleStatusValue = normalized(value(row, 'lifecycle_status', 'lifecycleStatus')).toLowerCase();
  const lifecycleStatus = lifecycleStatusValue || null;
  const eventType = normalized(value(row, 'event_type', 'eventType')).toLowerCase();
  const changeType = normalized(value(row, 'change_type', 'changeType')).toLowerCase();
  const detectedAt = isoTimestamp(value(row, 'observed_at', 'observedAt'));
  const officialListedAt = isoTimestamp(value(row, 'official_listed_at', 'officialListedAt'), true);
  const timeBasis = normalized(value(row, 'time_basis', 'timeBasis')).toLowerCase();
  const identityStatus = normalized(value(row, 'identity_status', 'identityStatus')).toLowerCase();
  const inclusionStatus = normalized(value(row, 'inclusion_status', 'inclusionStatus')).toLowerCase();
  const expectedChangeType = eventType === 'listed' ? 'new' : eventType;
  const expectedInclusion = eventType === 'delisted' ? 'removed' : 'eligible';
  if (!eventId || eventId.length > 200 || !MARKETS.has(market) || !VENUES.has(venue) ||
      !LISTING_KEY_PATTERN.test(venueSymbol) || !CANONICAL_PATTERN.test(canonicalSymbol) ||
      declaredListingKey !== listingKey || !name || name.length > 200 || !CATEGORIES.has(category) ||
      !CATEGORIES.has(venueCategory) || (lifecycleStatus !== null && !LIFECYCLE_STATUSES.has(lifecycleStatus)) ||
      !EVENT_TYPES.has(eventType) || changeType !== expectedChangeType || !detectedAt ||
      !['official', 'first_observed'].includes(timeBasis) ||
      (timeBasis === 'official') !== Boolean(officialListedAt) || identityStatus !== 'verified' ||
      inclusionStatus !== expectedInclusion) {
    throw new TypeError(`Invalid authoritative listing event ${eventId || 'unknown'}`);
  }
  return {
    eventId,
    listingKey,
    changeType,
    detectedAt,
    observedAt:detectedAt,
    officialListedAt,
    timeBasis,
    market,
    venue,
    venueSymbol,
    canonicalSymbol,
    name,
    category,
    venueCategory,
    lifecycleStatus,
    identityStatus:'verified',
    inclusionStatus,
  };
}

function normalizePendingReview(row) {
  const market = normalized(row?.market).toLowerCase();
  const venue = normalized(row?.venue).toLowerCase();
  const venueSymbol = normalized(value(row, 'venue_symbol', 'venueSymbol')).toUpperCase();
  const canonicalSymbol = normalized(value(row, 'canonical_symbol', 'canonicalSymbol')).toUpperCase();
  const category = normalized(row?.category).toLowerCase();
  const firstSeenAt = isoTimestamp(value(row, 'first_seen_at', 'firstSeenAt'), true);
  const lastSeenAt = isoTimestamp(value(row, 'last_seen_at', 'lastSeenAt'), true);
  if (!MARKETS.has(market) || !VENUES.has(venue) || !LISTING_KEY_PATTERN.test(venueSymbol) ||
      !CANONICAL_PATTERN.test(canonicalSymbol) || !CATEGORIES.has(category) || !firstSeenAt) return null;
  return {
    listingKey:`${market}:${venue}:${venueSymbol}`,
    market,
    venue,
    venueSymbol,
    canonicalSymbol,
    name:normalized(value(row, 'display_name', 'displayName')) || null,
    category,
    venueCategory:category,
    lifecycleStatus:null,
    identityStatus:'review-required',
    inclusionStatus:'review-required',
    firstSeenAt,
    lastSeenAt:lastSeenAt || firstSeenAt,
  };
}

function roleIdentityValid(row) {
  return normalized(value(row, 'active_role_name', 'activeRoleName')) === LISTING_EVENT_READER_ROLE &&
    value(row, 'is_reader_member', 'isReaderMember') === true &&
    value(row, 'is_not_database_owner', 'isNotDatabaseOwner') === true &&
    value(row, 'is_not_superuser', 'isNotSuperuser') === true &&
    value(row, 'is_not_catalog_writer', 'isNotCatalogWriter') === true &&
    value(row, 'is_event_reader', 'isEventReader') === true &&
    value(row, 'is_run_reader', 'isRunReader') === true &&
    value(row, 'is_review_reader', 'isReviewReader') === true &&
    value(row, 'cannot_read_raw_events', 'cannotReadRawEvents') === true &&
    value(row, 'cannot_read_membership', 'cannotReadMembership') === true &&
    value(row, 'cannot_read_identity_evidence', 'cannotReadIdentityEvidence') === true;
}

export function buildListingEventAuthorityQueries(sql) {
  if (!sql || typeof sql.query !== 'function') throw new TypeError('A read-only Listing Audit query builder is required');
  return [
    sql.query(`SET LOCAL ROLE ${LISTING_EVENT_READER_ROLE}`),
    sql.query(
      `SELECT session_user::text AS session_user_name,
         current_user::text AS active_role_name,
         pg_has_role(session_user, '${LISTING_EVENT_READER_ROLE}', 'member') AS is_reader_member,
         session_user <> (
           SELECT pg_get_userbyid(database_row.datdba)
           FROM pg_database AS database_row
           WHERE database_row.datname = current_database()
         ) AS is_not_database_owner,
         NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = session_user), true) AS is_not_superuser,
         NOT pg_has_role(session_user, 'rwa_catalog_shadow_writer', 'member') AS is_not_catalog_writer,
         has_table_privilege(current_user, 'publication.listing_change_event_v1', 'SELECT') AS is_event_reader,
         has_table_privilege(current_user, 'publication.listing_audit_run_v1', 'SELECT') AS is_run_reader,
         has_table_privilege(current_user, 'publication.listing_audit_pending_review_v1', 'SELECT') AS is_review_reader,
         NOT has_table_privilege(session_user, (
           SELECT relation.oid
           FROM pg_catalog.pg_class AS relation
           JOIN pg_catalog.pg_namespace AS schema ON schema.oid = relation.relnamespace
           WHERE schema.nspname = 'analytics' AND relation.relname = 'catalog_change_event'
         ), 'SELECT') AS cannot_read_raw_events,
         NOT has_table_privilege(session_user, (
           SELECT relation.oid
           FROM pg_catalog.pg_class AS relation
           JOIN pg_catalog.pg_namespace AS schema ON schema.oid = relation.relnamespace
           WHERE schema.nspname = 'ingest' AND relation.relname = 'catalog_membership'
         ), 'SELECT') AS cannot_read_membership,
         NOT has_table_privilege(session_user, (
           SELECT relation.oid
           FROM pg_catalog.pg_class AS relation
           JOIN pg_catalog.pg_namespace AS schema ON schema.oid = relation.relnamespace
           WHERE schema.nspname = 'identity' AND relation.relname = 'evidence'
         ), 'SELECT') AS cannot_read_identity_evidence`,
    ),
    sql.query(
      `WITH selected_cycle AS (
         SELECT cycle_id
         FROM publication.listing_audit_run_v1
         ORDER BY bucket_at DESC, cycle_completed_at DESC NULLS LAST, cycle_id DESC
         LIMIT 1
       ), last_successful AS (
         SELECT max(cycle_completed_at) AS generated_at
         FROM publication.listing_audit_run_v1
         WHERE cycle_status IN ('complete', 'partial')
           AND run_status <> 'unavailable'
       )
       SELECT run.*, success.generated_at
       FROM publication.listing_audit_run_v1 AS run
       CROSS JOIN last_successful AS success
       WHERE run.cycle_id = (SELECT cycle_id FROM selected_cycle)
       ORDER BY run.source_key COLLATE "C"`,
    ),
    sql.query(
      `SELECT event.*, count(*) OVER ()::int AS total_count
       FROM publication.listing_change_event_v1 AS event
       WHERE event.observed_at >= clock_timestamp() - make_interval(days => $1)
       ORDER BY event.observed_at DESC, event.event_id COLLATE "C"
       LIMIT $2`,
      [LISTING_EVENT_RETENTION_DAYS, LISTING_EVENT_MAX + 1],
    ),
    sql.query(
      `SELECT *
       FROM publication.listing_audit_pending_review_v1
       ORDER BY first_seen_at, review_id COLLATE "C"
       LIMIT 2000`,
    ),
  ];
}

export function listingSnapshotFromAuthorityRows(sourceRows, eventRows, reviewRows) {
  const sources = (Array.isArray(sourceRows) ? sourceRows : []).map(normalizeSourceRow);
  if (sources.length && (sources.length !== LISTING_SOURCE_KEYS.length ||
      new Set(sources.map(source => source.sourceKey)).size !== LISTING_SOURCE_KEYS.length ||
      LISTING_SOURCE_KEYS.some(sourceKey => !sources.some(source => source.sourceKey === sourceKey)))) {
    throw new TypeError('Authoritative Listing Audit cycle does not contain the exact ten-source set');
  }
  const generatedAt = sources.length
    ? isoTimestamp(value(sourceRows[0], 'generated_at', 'generatedAt'), true)
    : null;
  const normalizedRows = (Array.isArray(eventRows) ? eventRows : []).map(normalizeEventRow);
  const totalEvents = normalizedRows.length
    ? nonNegativeInteger(value(eventRows[0], 'total_count', 'totalCount'))
    : 0;
  if (totalEvents === null || totalEvents < normalizedRows.length) {
    throw new TypeError('Authoritative Listing Audit event count is invalid');
  }
  const events = normalizedRows.slice(0, LISTING_EVENT_MAX);
  const droppedAtLeast = Math.max(0, totalEvents - events.length);
  const droppedRow = normalizedRows[LISTING_EVENT_MAX] || null;
  const history = {
    retentionDays:LISTING_EVENT_RETENTION_DAYS,
    maxEvents:LISTING_EVENT_MAX,
    truncated:droppedAtLeast > 0,
    droppedAtLeast,
    droppedThrough:droppedRow?.detectedAt || null,
    retainedFrom:events.at(-1)?.detectedAt || null,
  };
  const pendingReviews = (Array.isArray(reviewRows) ? reviewRows : [])
    .map(normalizePendingReview)
    .filter(Boolean);
  const availableSources = sources.filter(source => source.status !== 'unavailable').length;
  const warmingSources = sources.filter(source => source.status === 'warming').length;
  const partialSources = sources.filter(source => source.status === 'partial').length;
  const unavailableSources = sources.filter(source => source.status === 'unavailable').length;
  const sourceStatus = !sources.length
    ? 'warming'
    : unavailableSources
      ? (availableSources ? 'partial' : 'unavailable')
      : partialSources ? 'partial'
        : warmingSources ? 'warming' : 'full';
  const status = history.truncated && sourceStatus !== 'unavailable' ? 'partial' : sourceStatus;
  return {
    schemaVersion:LISTING_AUDIT_SCHEMA_VERSION,
    generatedAt,
    status,
    scope:'Daily official-catalog diff for RWA perpetual and spot listings',
    methodology:{
      identity:'Official venue product metadata is authoritative; PostgreSQL stores only previously admitted identities',
      baseline:'First successful observation per venue and market establishes a baseline and emits no false new-listing events',
      failurePolicy:'Partial or unavailable source runs retain the last trusted catalog and never emit synthetic lifecycle events',
    },
    coverage:{
      expectedSources:LISTING_SOURCE_KEYS.length,
      availableSources,
      warmingSources,
      partialSources,
      unavailableSources:sources.length ? unavailableSources : LISTING_SOURCE_KEYS.length,
    },
    counts:{
      activeListings:sources.reduce((sum, source) => sum + source.listingCount, 0),
      retainedEvents:events.length,
      new:events.filter(event => event.changeType === 'new').length,
      relisted:events.filter(event => event.changeType === 'relisted').length,
      delisted:events.filter(event => event.changeType === 'delisted').length,
      reviewRequired:pendingReviews.length,
    },
    sources,
    events,
    pendingReviews,
    history,
    persistence:{
      mode:'postgresql-event-authority',
      status:sources.length ? 'full' : 'partial',
      continuity:'analytics.catalog_change_event and trusted source runs are authoritative; HTTP and Runtime Cache layers are disposable replicas',
      retentionDays:LISTING_EVENT_RETENTION_DAYS,
    },
  };
}

export async function readListingEventAuthority({
  env = process.env,
  runTransaction = runListingDatabaseTransaction,
} = {}) {
  if (!listingDatabaseConfigured(env)) {
    const error = new Error('Dedicated Listing Audit database reader is not configured');
    error.code = 'LISTING_EVENT_AUTHORITY_NOT_CONFIGURED';
    throw error;
  }
  const results = await runTransaction(buildListingEventAuthorityQueries, {
    isolationLevel:'RepeatableRead',
    deferrable:true,
    timeoutMs:20_000,
  });
  const identity = results?.[1]?.[0];
  if (!roleIdentityValid(identity)) {
    const error = new Error('Listing event authority requires the dedicated least-privilege reader role');
    error.code = 'LISTING_EVENT_READER_ROLE_INVALID';
    throw error;
  }
  const snapshot = listingSnapshotFromAuthorityRows(results?.[2], results?.[3], results?.[4]);
  return {
    status:'stored',
    observedAt:snapshot.generatedAt,
    snapshot,
    readPath:{
      mode:'postgres-authoritative',
      source:'postgres-events',
      reconciliation:'database-authoritative',
      runtimeCache:{ status:'not-requested', observedAt:null },
      durableCheckpoint:{ status:'not-requested', observedAt:null },
      eventStore:{
        status:snapshot.generatedAt ? 'stored' : 'empty',
        observedAt:snapshot.generatedAt,
        view:LISTING_EVENT_VIEW_VERSION,
      },
    },
  };
}

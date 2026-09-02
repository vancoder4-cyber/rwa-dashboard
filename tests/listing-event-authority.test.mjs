import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LISTING_SOURCE_KEYS,
} from '../api/_lib/listing-audit.js';
import {
  buildListingEventAuthorityQueries,
  listingSnapshotFromAuthorityRows,
  readListingEventAuthority,
} from '../api/_lib/listing-event-authority.js';
import {
  readListingChangesSnapshot,
} from '../api/listing-changes.js';
import {
  validateListingAuditSnapshot,
} from '../api/health.js';

const GENERATED_AT = '2026-09-02T00:45:00.000Z';

function sourceRows(overrides = {}) {
  return LISTING_SOURCE_KEYS.map((sourceKey, index) => {
    const [market, venue] = sourceKey.split(':');
    return {
      cycle_id:'00000000-0000-4000-8000-000000000001',
      bucket_at:'2026-09-02T00:00:00.000Z',
      cycle_completed_at:GENERATED_AT,
      cycle_status:'complete',
      source_key:sourceKey,
      market,
      venue,
      run_status:'full',
      catalog_status:'full',
      identity_status:'full',
      listing_count:index === 0 ? 236 : 230,
      admitted_listing_count:index === 0 ? 236 : 230,
      rejected_listing_count:0,
      error_codes:[],
      merged_status:'full',
      baseline_at:'2026-09-01T00:45:00.000Z',
      observed_at:GENERATED_AT,
      pending_removal_count:0,
      write_disposition:'latest-trusted',
      generated_at:GENERATED_AT,
      ...(overrides[sourceKey] || {}),
    };
  });
}

function eventRow(overrides = {}) {
  return {
    event_id:'11111111-1111-4111-8111-111111111111',
    listing_key:'perp:binance:TESTUSDT',
    market:'perp',
    venue:'binance',
    venue_symbol:'TESTUSDT',
    canonical_symbol:'TEST',
    display_name:'Test Corporation',
    category:'equity',
    venue_category:'equity',
    lifecycle_status:'public',
    event_type:'listed',
    change_type:'new',
    observed_at:GENERATED_AT,
    official_listed_at:null,
    time_basis:'first_observed',
    identity_status:'verified',
    inclusion_status:'eligible',
    total_count:1,
    ...overrides,
  };
}

function transaction(results, calls = []) {
  return async build => {
    const sql = {
      query(text, params = []) {
        const query = { text, params };
        calls.push(query);
        return query;
      },
    };
    return build(sql).map((query, index) => results[index] ?? []);
  };
}

const READER_IDENTITY = Object.freeze({
  active_role_name:'rwa_listing_audit_reader',
  is_reader_member:true,
  is_not_database_owner:true,
  is_not_superuser:true,
  is_not_catalog_writer:true,
  is_event_reader:true,
  is_run_reader:true,
  is_review_reader:true,
  cannot_read_raw_events:true,
  cannot_read_membership:true,
  cannot_read_identity_evidence:true,
});

test('a 2,306-instrument first persisted baseline returns zero listing events', () => {
  const rows = sourceRows();
  assert.equal(rows.reduce((sum, row) => sum + row.listing_count, 0), 2_306);
  const snapshot = listingSnapshotFromAuthorityRows(rows, [], []);
  assert.equal(snapshot.generatedAt, GENERATED_AT);
  assert.equal(snapshot.status, 'full');
  assert.equal(snapshot.counts.activeListings, 2_306);
  assert.equal(snapshot.counts.retainedEvents, 0);
  assert.deepEqual(snapshot.events, []);
});

test('PostgreSQL event projection maps one listed contract to the compatible public payload', () => {
  const snapshot = listingSnapshotFromAuthorityRows(sourceRows(), [eventRow()], []);
  assert.deepEqual(snapshot.events, [{
    eventId:'11111111-1111-4111-8111-111111111111',
    listingKey:'perp:binance:TESTUSDT',
    changeType:'new',
    detectedAt:GENERATED_AT,
    observedAt:GENERATED_AT,
    officialListedAt:null,
    timeBasis:'first_observed',
    market:'perp',
    venue:'binance',
    venueSymbol:'TESTUSDT',
    canonicalSymbol:'TEST',
    name:'Test Corporation',
    category:'equity',
    venueCategory:'equity',
    lifecycleStatus:'public',
    identityStatus:'verified',
    inclusionStatus:'eligible',
  }]);
  assert.equal(snapshot.counts.new, 1);
  assert.equal(snapshot.history.retentionDays, 45);
  assert.equal(snapshot.history.maxEvents, 2_000);
  assert.equal(Object.hasOwn(snapshot.events[0], 'evidence'), false);
  assert.equal(Object.hasOwn(snapshot.events[0], 'currentSourceRunId'), false);
});

test('official listing time is supplemental and cannot exist without the official time basis', () => {
  const official = listingSnapshotFromAuthorityRows(sourceRows(), [eventRow({
    official_listed_at:'2026-09-01T12:00:00.000Z',
    time_basis:'official',
  })], []);
  assert.equal(official.events[0].officialListedAt, '2026-09-01T12:00:00.000Z');
  assert.equal(official.events[0].detectedAt, GENERATED_AT);
  assert.equal(official.events[0].timeBasis, 'official');

  assert.throws(() => listingSnapshotFromAuthorityRows(sourceRows(), [eventRow({
    official_listed_at:'2026-09-01T12:00:00.000Z',
    time_basis:'first_observed',
  })], []), /Invalid authoritative listing event/);
});

test('one unavailable source keeps reliable events visible but forbids a clean no-event conclusion', () => {
  const rows = sourceRows({
    'spot:kraken':{
      run_status:'unavailable',
      catalog_status:'unavailable',
      identity_status:'unavailable',
      merged_status:'unavailable',
      listing_count:0,
      admitted_listing_count:0,
      observed_at:null,
      error_codes:['CATALOG_UNAVAILABLE'],
    },
  });
  const snapshot = listingSnapshotFromAuthorityRows(rows, [eventRow()], []);
  assert.equal(snapshot.status, 'partial');
  assert.equal(snapshot.coverage.availableSources, 9);
  assert.equal(snapshot.coverage.unavailableSources, 1);
  assert.equal(snapshot.events.length, 1);
});

test('authoritative reader uses only safe publication views under the dedicated role', async () => {
  const calls = [];
  const result = await readListingEventAuthority({
    env:{ LISTING_DATABASE_URL:'postgresql://reader.test.invalid/database' },
    runTransaction:transaction([[], [READER_IDENTITY], sourceRows(), [eventRow()], []], calls),
  });
  assert.equal(result.snapshot.events.length, 1);
  assert.equal(result.readPath.source, 'postgres-events');
  assert.match(calls[0].text, /^SET LOCAL ROLE rwa_listing_audit_reader$/);
  assert.match(calls[2].text, /publication\.listing_audit_run_v1/);
  assert.match(calls[3].text, /publication\.listing_change_event_v1/);
  assert.match(calls[4].text, /publication\.listing_audit_pending_review_v1/);
  assert.doesNotMatch(calls.slice(2).map(call => call.text).join('\n'), /analytics\.catalog_change_event/);
  assert.deepEqual(calls[3].params, [45, 2_001]);
});

test('PostgreSQL-authoritative API recovery does not consult an evicted Runtime Cache', async () => {
  let cacheReads = 0;
  const snapshot = listingSnapshotFromAuthorityRows(sourceRows(), [eventRow()], []);
  const result = await readListingChangesSnapshot({
    env:{ LISTING_READ_MODE:'postgres-authoritative' },
    cache:{ async get() { cacheReads += 1; throw new Error('evicted'); } },
    readEventAuthority:async () => ({
      snapshot,
      readPath:{
        mode:'postgres-authoritative',
        source:'postgres-events',
        reconciliation:'database-authoritative',
        runtimeCache:{ status:'not-requested', observedAt:null },
        durableCheckpoint:{ status:'not-requested', observedAt:null },
        eventStore:{ status:'stored', observedAt:GENERATED_AT },
      },
    }),
  });
  assert.equal(cacheReads, 0);
  assert.equal(result.events[0].eventId, '11111111-1111-4111-8111-111111111111');
  assert.equal(result.persistence.readPath.source, 'postgres-events');
});

test('Health accepts the PostgreSQL event authority and reports it reconciled', () => {
  const snapshot = listingSnapshotFromAuthorityRows(sourceRows(), [eventRow()], []);
  snapshot.persistence.readPath = {
    mode:'postgres-authoritative',
    source:'postgres-events',
    reconciliation:'database-authoritative',
    runtimeCache:{ status:'not-requested', observedAt:null },
    durableCheckpoint:{ status:'not-requested', observedAt:null },
    eventStore:{ status:'stored', observedAt:GENERATED_AT },
  };
  const result = validateListingAuditSnapshot(snapshot, Date.parse('2026-09-02T01:00:00.000Z'), {
    expectedReadMode:'postgres-authoritative',
  });
  assert.equal(result.status, 'pass');
  assert.equal(result.readPathSource, 'postgres-events');
  assert.equal(result.eventStoreReadStatus, 'stored');
  assert.equal(result.replicaReconciled, true);
});

test('reader fails closed on an incomplete source cycle or unverified event', () => {
  assert.throws(
    () => listingSnapshotFromAuthorityRows(sourceRows().slice(0, 9), [], []),
    /exact ten-source set/,
  );
  assert.throws(
    () => listingSnapshotFromAuthorityRows(sourceRows(), [eventRow({ identity_status:'quarantined' })], []),
    /Invalid authoritative listing event/,
  );
});

test('query construction is fixed, bounded, GET-reader-safe, and has no mutation statement', () => {
  const calls = [];
  const sql = { query(text, params = []) { calls.push({ text, params }); return { text, params }; } };
  const queries = buildListingEventAuthorityQueries(sql);
  assert.equal(queries.length, 5);
  const publicQueries = calls.slice(2).map(call => call.text).join('\n');
  assert.doesNotMatch(publicQueries, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
  assert.match(publicQueries, /LIMIT \$2/);
  assert.match(publicQueries, /LIMIT 2000/);
});

import { createHash } from 'node:crypto';

import { runDatabaseTransaction } from './database.js';
import {
  ARBITRAGE_FORMULA_VERSION,
  ARBITRAGE_SCHEMA_VERSION,
  validateArbitrageRoute,
  validateArbitrageSnapshot,
} from './arbitrage-analysis.js';

export const ARBITRAGE_JOB_NAME = 'rwa-arbitrage-opportunities';
export const ARBITRAGE_PIPELINE_VERSION = 'rwa-arbitrage-authoritative/v1';
export const ARBITRAGE_SOURCE_KEYS = Object.freeze([
  'perp:tradexyz', 'perp:bitget', 'perp:gate', 'perp:binance', 'perp:okx',
  'spot:bitget', 'spot:gate', 'spot:kraken', 'spot:binance', 'spot:okx',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function json(value) {
  return JSON.stringify(value);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function arbitrageWriteMode(env = process.env) {
  const mode = String(env?.ARBITRAGE_WRITE_MODE || 'off').trim().toLowerCase();
  return ['off', 'shadow', 'required'].includes(mode) ? mode : 'off';
}

export function buildAuthoritativeArbitrageIdentityQueries(sql) {
  if (!sql || typeof sql.query !== 'function') throw new TypeError('An arbitrage writer query builder is required');
  return [
    sql.query('SET LOCAL ROLE rwa_arbitrage_writer'),
    sql.query(
      `SELECT source_key
       FROM identity.source
       WHERE source_key = ANY($1::text[])
         AND enabled = true
         AND catalog_authority = 'official'
       ORDER BY source_key COLLATE "C"`,
      [ARBITRAGE_SOURCE_KEYS],
    ),
    sql.query(
      `SELECT source.source_key,
         source.market,
         source.venue,
         instrument_version.instrument_version_id,
         instrument_version.official_venue_symbol,
         instrument_version.normalized_venue_symbol,
         instrument_version.instrument_type,
         instrument_version.asset_version_id,
         asset_version.category,
         asset_version.canonical_underlying,
         asset_version.display_name
       FROM identity.instrument_version AS instrument_version
       JOIN identity.source AS source ON source.source_id = instrument_version.source_id
       JOIN identity.asset_version AS asset_version ON asset_version.asset_version_id = instrument_version.asset_version_id
       WHERE source.source_key = ANY($1::text[])
         AND source.enabled = true
         AND source.catalog_authority = 'official'
         AND source.market IN ('spot', 'perp')
         AND instrument_version.valid_to IS NULL
         AND instrument_version.identity_status = 'verified'
         AND instrument_version.official_status = 'online'
         AND asset_version.valid_to IS NULL
         AND asset_version.identity_status = 'verified'
       ORDER BY source.source_key COLLATE "C", instrument_version.official_venue_symbol COLLATE "C"`,
      [ARBITRAGE_SOURCE_KEYS],
    ),
    sql.query(
      `SELECT route_fingerprint, bucket_at, basis_pct
       FROM fact.arbitrage_route_observation
       WHERE bucket_at >= clock_timestamp() - interval '30 minutes'
       ORDER BY route_fingerprint, bucket_at DESC`,
    ),
  ];
}

export function normalizeAuthoritativeArbitrageSourceRows(rows) {
  const sourceKeys = (Array.isArray(rows) ? rows : []).map(row =>
    String(row?.source_key ?? row?.sourceKey ?? '').trim().toLowerCase());
  const exact = sourceKeys.length === ARBITRAGE_SOURCE_KEYS.length &&
    new Set(sourceKeys).size === ARBITRAGE_SOURCE_KEYS.length &&
    ARBITRAGE_SOURCE_KEYS.every(sourceKey => sourceKeys.includes(sourceKey));
  if (!exact) throw new TypeError('Database source registry does not contain the exact ten-source arbitrage set');
  return sourceKeys;
}

export function normalizeAuthoritativeArbitrageIdentityRows(rows) {
  const source = Array.isArray(rows) ? rows : [];
  const byListingKey = new Map();
  const duplicates = new Set();
  const register = (listingKey, identity) => {
    const existing = byListingKey.get(listingKey);
    if (existing && existing.instrumentVersionId !== identity.instrumentVersionId) duplicates.add(listingKey);
    else byListingKey.set(listingKey, identity);
  };
  for (const row of source) {
    const sourceKey = String(row?.source_key ?? row?.sourceKey ?? '').trim().toLowerCase();
    const venueSymbol = String(row?.official_venue_symbol ?? row?.officialVenueSymbol ?? '').trim();
    const normalizedVenueSymbol = String(
      row?.normalized_venue_symbol ?? row?.normalizedVenueSymbol ?? venueSymbol,
    ).trim();
    const category = String(row?.category || '').trim().toLowerCase();
    const canonicalSymbol = String(row?.canonical_underlying ?? row?.canonicalUnderlying ?? '').trim().toUpperCase();
    const instrumentVersionId = numberOrNull(row?.instrument_version_id ?? row?.instrumentVersionId);
    const assetVersionId = numberOrNull(row?.asset_version_id ?? row?.assetVersionId);
    const name = String(row?.display_name ?? row?.displayName ?? '').trim();
    const listingKey = `${sourceKey}:${venueSymbol}`;
    if (!ARBITRAGE_SOURCE_KEYS.includes(sourceKey) || !venueSymbol || !normalizedVenueSymbol || !category || !canonicalSymbol || !name ||
        !Number.isSafeInteger(instrumentVersionId) || !Number.isSafeInteger(assetVersionId)) {
      throw new TypeError(`Invalid authoritative arbitrage identity row ${listingKey}`);
    }
    const identity = {
      sourceKey, venueSymbol, normalizedVenueSymbol, category, canonicalSymbol, name,
      instrumentVersionId, assetVersionId,
    };
    register(listingKey, identity);
    register(`${sourceKey}:${normalizedVenueSymbol}`, identity);
  }
  if (duplicates.size) throw new TypeError(`Duplicate authoritative identities: ${[...duplicates].join(', ')}`);
  return byListingKey;
}

export async function readAuthoritativeArbitrageInputs() {
  const results = await runDatabaseTransaction(
    transactionSql => buildAuthoritativeArbitrageIdentityQueries(transactionSql),
    { readOnly:true, timeoutMs:15_000 },
  );
  normalizeAuthoritativeArbitrageSourceRows(results[1]);
  return {
    identities:normalizeAuthoritativeArbitrageIdentityRows(results[2]),
    basisHistory:(Array.isArray(results[3]) ? results[3] : []).map(row => ({
      routeFingerprint:String(row?.route_fingerprint ?? row?.routeFingerprint ?? ''),
      bucketAt:new Date(row?.bucket_at ?? row?.bucketAt).toISOString(),
      basisPct:Number(row?.basis_pct ?? row?.basisPct),
    })),
  };
}

function normalizeSourceCoverage(rows) {
  const source = Array.isArray(rows) ? rows : [];
  const byKey = new Map(source.map(row => [String(row?.sourceKey || '').trim().toLowerCase(), row]));
  if (source.length !== ARBITRAGE_SOURCE_KEYS.length || byKey.size !== ARBITRAGE_SOURCE_KEYS.length ||
      ARBITRAGE_SOURCE_KEYS.some(key => !byKey.has(key))) {
    throw new TypeError('Arbitrage publication requires the exact ten-source coverage set');
  }
  return ARBITRAGE_SOURCE_KEYS.map(sourceKey => {
    const row = byKey.get(sourceKey);
    const listingCount = Number(row?.listingCount);
    if (row?.status !== 'full' || !Number.isInteger(listingCount) || listingCount < 0) {
      throw new TypeError(`Incomplete arbitrage source ${sourceKey}`);
    }
    return { sourceKey, listingCount };
  });
}

function routeFactRows(routeFacts, generatedAt) {
  return (Array.isArray(routeFacts) ? routeFacts : []).map(row => {
    const route = row?.route;
    const authority = row?.authority || {};
    if (!validateArbitrageRoute(route, { generatedAt }).valid ||
        !Number.isSafeInteger(authority.assetVersionId) ||
        !Number.isSafeInteger(authority.spotInstrumentVersionId) ||
        !Number.isSafeInteger(authority.perpInstrumentVersionId) ||
        !Number.isInteger(row?.settledObservationCount) || row.settledObservationCount < 2) {
      throw new TypeError(`Missing authoritative database identity for route ${route?.routeId || 'unknown'}`);
    }
    return {
      route_id:route.routeId,
      route_fingerprint:route.routeFingerprint,
      asset_version_id:authority.assetVersionId,
      spot_instrument_version_id:authority.spotInstrumentVersionId,
      perp_instrument_version_id:authority.perpInstrumentVersionId,
      spot_observed_at:route.spot.observedAt,
      perp_observed_at:route.perp.observedAt,
      funding_observed_at:route.funding.observedAt,
      spot_ask_price_usd:route.spot.askPriceUsd,
      spot_executable_depth_usd:route.spot.executableDepthUsd,
      perp_bid_price_usd:route.perp.bidPriceUsd,
      perp_executable_depth_usd:route.perp.executableDepthUsd,
      perp_open_interest_usd:route.perp.openInterestUsd,
      basis_pct:route.basis.pct,
      basis_persistence_minutes:route.basis.persistenceMinutes,
      current_funding_rate_pct:route.funding.currentRatePct,
      funding_interval_hours:route.funding.intervalHours,
      current_funding_annualized_pct:route.funding.currentAnnualizedPct,
      average_24h_funding_annualized_pct:route.funding.average24hAnnualizedPct,
      consecutive_positive_settlements:route.funding.consecutivePositiveSettlements,
      short_receives:route.funding.shortReceives,
      settled_observation_count:row.settledObservationCount,
      input_sha256:sha256(json(row.inputEvidence || route)),
    };
  });
}

export function buildArbitragePublicationQueries(sql, publication) {
  if (!sql || typeof sql.query !== 'function') throw new TypeError('An arbitrage writer query builder is required');
  const snapshot = publication?.snapshot;
  const validation = validateArbitrageSnapshot(snapshot, { nowMs:Date.parse(snapshot?.generatedAt) });
  if (!validation.valid) throw new TypeError(`Refusing invalid arbitrage publication: ${validation.reason}`);
  const sources = normalizeSourceCoverage(publication?.sources);
  const facts = routeFactRows(publication?.routeFacts, snapshot.generatedAt);
  const factRouteIds = new Set(facts.map(fact => fact.route_id));
  if (factRouteIds.size !== facts.length || snapshot.routes.some(route => !factRouteIds.has(route.routeId))) {
    throw new TypeError('Every public arbitrage route must have one authoritative fact row');
  }
  const checksum = sha256(json(snapshot));
  const common = [ARBITRAGE_JOB_NAME, ARBITRAGE_PIPELINE_VERSION, snapshot.bucket];
  const cycleLookup = `SELECT cycle_id FROM ingest.collection_cycle
    WHERE job_name = $1 AND pipeline_version = $2 AND bucket_at = $3::timestamptz`;
  const attemptLookup = `SELECT attempt_id FROM ingest.collection_attempt
    WHERE cycle_id = (${cycleLookup}) AND attempt_no = 1`;
  return [
    sql.query('SET LOCAL ROLE rwa_arbitrage_writer'),
    sql.query(`SET LOCAL statement_timeout = '20s'`),
    sql.query(`SET LOCAL lock_timeout = '3s'`),
    sql.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1 || chr(31) || $2 || chr(31) || $3::text, 0))`,
      common,
    ),
    sql.query(
      `INSERT INTO ingest.collection_cycle
         (job_name, pipeline_version, bucket_at, scheduled_at, started_at, completed_at, status, trigger_kind)
       VALUES ($1, $2, $3::timestamptz, $3::timestamptz, $4::timestamptz, $4::timestamptz, 'complete', 'cron')
       ON CONFLICT (job_name, pipeline_version, bucket_at) DO NOTHING`,
      [...common, snapshot.generatedAt],
    ),
    sql.query(
      `INSERT INTO ingest.collection_attempt
         (cycle_id, attempt_no, started_at, completed_at, status)
       SELECT cycle_id, 1, $4::timestamptz, $4::timestamptz, 'complete'
       FROM ingest.collection_cycle
       WHERE job_name = $1 AND pipeline_version = $2 AND bucket_at = $3::timestamptz
       ON CONFLICT (cycle_id, attempt_no) DO NOTHING`,
      [...common, snapshot.generatedAt],
    ),
    sql.query(
      `INSERT INTO ingest.source_run
         (attempt_id, source_id, endpoint_key, started_at, completed_at, status, catalog_status,
          identity_status, data_status, listing_count, admitted_listing_count, rejected_listing_count, metadata)
       SELECT (${attemptLookup}), source.source_id, 'arbitrage-market-snapshot',
         $4::timestamptz, $4::timestamptz, 'full', 'full', 'full', 'full',
         incoming.listing_count, incoming.listing_count, 0,
         jsonb_build_object('bucket', $3::text, 'formulaVersion', $5::text)
       FROM jsonb_to_recordset($6::jsonb) AS incoming(source_key text, listing_count integer)
       JOIN identity.source AS source ON source.source_key = incoming.source_key
       ON CONFLICT (attempt_id, source_id, endpoint_key) DO NOTHING`,
      [...common, snapshot.generatedAt, ARBITRAGE_FORMULA_VERSION, json(sources.map(row => ({
        source_key:row.sourceKey, listing_count:row.listingCount,
      })))],
    ),
    sql.query(
      `INSERT INTO fact.arbitrage_route_observation
         (cycle_id, asset_version_id, spot_instrument_version_id, perp_instrument_version_id,
          route_id, route_fingerprint, formula_version, bucket_at, generated_at,
          spot_observed_at, perp_observed_at, funding_observed_at,
          spot_ask_price_usd, spot_executable_depth_usd, perp_bid_price_usd,
          perp_executable_depth_usd, perp_open_interest_usd, basis_pct,
          basis_persistence_minutes, current_funding_rate_pct, funding_interval_hours,
          current_funding_annualized_pct, average_24h_funding_annualized_pct,
          consecutive_positive_settlements, short_receives, settled_observation_count, input_sha256)
       SELECT (${cycleLookup}), incoming.asset_version_id, incoming.spot_instrument_version_id,
         incoming.perp_instrument_version_id, incoming.route_id, incoming.route_fingerprint,
         $4::text, $3::timestamptz, $5::timestamptz,
         incoming.spot_observed_at, incoming.perp_observed_at, incoming.funding_observed_at,
         incoming.spot_ask_price_usd, incoming.spot_executable_depth_usd,
         incoming.perp_bid_price_usd, incoming.perp_executable_depth_usd,
         incoming.perp_open_interest_usd, incoming.basis_pct, incoming.basis_persistence_minutes,
         incoming.current_funding_rate_pct, incoming.funding_interval_hours,
         incoming.current_funding_annualized_pct, incoming.average_24h_funding_annualized_pct,
         incoming.consecutive_positive_settlements, incoming.short_receives,
         incoming.settled_observation_count, incoming.input_sha256
       FROM jsonb_to_recordset($6::jsonb) AS incoming(
         asset_version_id bigint, spot_instrument_version_id bigint, perp_instrument_version_id bigint,
         route_id text, route_fingerprint char(64), spot_observed_at timestamptz,
         perp_observed_at timestamptz, funding_observed_at timestamptz,
         spot_ask_price_usd numeric, spot_executable_depth_usd numeric,
         perp_bid_price_usd numeric, perp_executable_depth_usd numeric, perp_open_interest_usd numeric,
         basis_pct numeric, basis_persistence_minutes integer, current_funding_rate_pct numeric,
         funding_interval_hours numeric, current_funding_annualized_pct numeric,
         average_24h_funding_annualized_pct numeric, consecutive_positive_settlements integer,
         short_receives boolean, settled_observation_count integer, input_sha256 char(64))
       WHERE NOT EXISTS (
         SELECT 1 FROM publication.arbitrage_opportunity_snapshot
         WHERE cycle_id = (${cycleLookup})
       )
       ON CONFLICT (cycle_id, route_id) DO NOTHING`,
      [...common, ARBITRAGE_FORMULA_VERSION, snapshot.generatedAt, json(facts)],
    ),
    sql.query(
      `INSERT INTO publication.arbitrage_opportunity_snapshot
         (cycle_id, schema_version, formula_version, bucket_at, generated_at, valid_until,
          route_count, payload, payload_sha256)
       VALUES ((${cycleLookup}), $4, $5, $3::timestamptz, $6::timestamptz,
         $6::timestamptz + interval '10 minutes', $7, $8::jsonb, $9)
       ON CONFLICT (cycle_id) DO NOTHING`,
      [...common, ARBITRAGE_SCHEMA_VERSION, ARBITRAGE_FORMULA_VERSION, snapshot.generatedAt,
        snapshot.routes.length, json(snapshot), checksum],
    ),
    sql.query(
      `INSERT INTO ingest.sink_commit (attempt_id, sink_name, status, row_count, checksum, committed_at)
       VALUES ((${attemptLookup}), 'postgres-arbitrage-publication', 'stored', $4, $5, $6::timestamptz)
       ON CONFLICT (attempt_id, sink_name) DO NOTHING`,
      [...common, facts.length, checksum, snapshot.generatedAt],
    ),
    sql.query(
      `SELECT snapshot_id::text, payload_sha256, route_count
       FROM publication.arbitrage_opportunity_snapshot
       WHERE cycle_id = (${cycleLookup})`,
      common,
    ),
  ];
}

export async function writeAuthoritativeArbitragePublication(publication) {
  const results = await runDatabaseTransaction(
    transactionSql => buildArbitragePublicationQueries(transactionSql, publication),
    { timeoutMs:25_000 },
  );
  const stored = results.at(-1)?.[0];
  const expectedChecksum = sha256(json(publication.snapshot));
  const actualChecksum = String(stored?.payload_sha256 ?? stored?.payloadSha256 ?? '');
  const routeCount = Number(stored?.route_count ?? stored?.routeCount);
  if (actualChecksum !== expectedChecksum || routeCount !== publication.snapshot.routes.length) {
    throw new TypeError('Existing arbitrage bucket differs from the attempted idempotent publication');
  }
  return { status:'stored', snapshotId:String(stored?.snapshot_id ?? stored?.snapshotId), checksum:actualChecksum };
}

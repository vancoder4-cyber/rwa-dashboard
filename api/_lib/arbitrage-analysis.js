import { createHash } from 'node:crypto';

export const ARBITRAGE_SCHEMA_VERSION = 'rwa-arbitrage-opportunities/v1';
export const ARBITRAGE_FORMULA_VERSION = 'rwa-arbitrage-opportunity-1.0';
export const ARBITRAGE_BUCKET_MS = 5 * 60_000;
export const ARBITRAGE_MAX_AGE_MS = 10 * 60_000;
export const ARBITRAGE_LEG_MAX_AGE_MS = 3 * 60_000;
export const ARBITRAGE_LEG_MAX_SKEW_MS = 60_000;
export const ARBITRAGE_EXECUTION_TOLERANCE_PCT = 2;
export const ARBITRAGE_THRESHOLDS = Object.freeze({
  basisPct: 1,
  basisPersistenceMinutes: 10,
  fundingAverage24hAnnualizedPct: 20,
  fundingConsecutivePositiveSettlements: 3,
  fundingMinimumBasisPct: -0.3,
  executableDepthUsd: 10_000,
  openInterestUsd: 1_000_000,
});

const CATEGORIES = new Set(['equity', 'etf', 'commodity', 'index', 'fx', 'bond', 'pre-ipo']);
const SPOT_VENUES = new Set(['gate', 'kraken', 'bitget', 'binance', 'okx']);
const PERP_VENUES = new Set(['gate', 'binance', 'bitget', 'tradexyz', 'okx']);
const SAFE_SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const SAFE_CANONICAL = /^[A-Z0-9][A-Z0-9.-]{0,39}$/;
const SAFE_ROUTE_ID = /^[A-Za-z0-9._:-]{1,160}$/;

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value) {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

function nonNegative(value) {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
}

function round(value, digits = 8) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function timestamp(value) {
  const milliseconds = value instanceof Date
    ? value.getTime()
    : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function iso(value) {
  const milliseconds = timestamp(value);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

function lower(value) {
  return String(value ?? '').trim().toLowerCase();
}

function upper(value) {
  return String(value ?? '').trim().toUpperCase();
}

export function fiveMinuteBucket(value) {
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError('Invalid arbitrage bucket clock');
  return Math.floor(milliseconds / ARBITRAGE_BUCKET_MS) * ARBITRAGE_BUCKET_MS;
}

export function calculateBasisPct(spotAskPriceUsd, perpBidPriceUsd) {
  const spot = positive(spotAskPriceUsd);
  const perp = positive(perpBidPriceUsd);
  if (spot === null || perp === null) return null;
  return round(((perp - spot) / spot) * 100, 8);
}

export function calculateCurrentAnnualizedPct(currentRatePct, intervalHours) {
  const rate = finite(currentRatePct);
  const interval = positive(intervalHours);
  if (rate === null || interval === null || interval > 24) return null;
  return round(rate * (24 / interval) * 365, 8);
}

export function settledFundingMetrics(rows, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const intervalHours = positive(options.intervalHours);
  if (intervalHours === null || intervalHours > 24) return null;
  const cutoff = nowMs - 24 * 60 * 60_000;
  const normalized = (Array.isArray(rows) ? rows : []).map(row => {
    const observedAtMs = timestamp(row?.fundingTime ?? row?.observedAt);
    const rateFraction = finite(row?.fundingRate);
    return observedAtMs !== null && observedAtMs >= cutoff - 15 * 60_000 && observedAtMs <= nowMs + 60_000 &&
      rateFraction !== null ? { observedAtMs, ratePct:rateFraction * 100 } : null;
  }).filter(Boolean).sort((left, right) => left.observedAtMs - right.observedAtMs);
  const deduped = [];
  for (const row of normalized) {
    const prior = deduped.at(-1);
    if (prior?.observedAtMs === row.observedAtMs) deduped[deduped.length - 1] = row;
    else deduped.push(row);
  }
  const expected = Math.max(1, Math.floor(24 / intervalHours));
  if (deduped.length < Math.max(2, Math.ceil(expected * 0.8))) return null;
  const averageRatePct = deduped.reduce((sum, row) => sum + row.ratePct, 0) / deduped.length;
  let consecutivePositiveSettlements = 0;
  for (let index = deduped.length - 1; index >= 0 && deduped[index].ratePct > 0; index -= 1) {
    consecutivePositiveSettlements += 1;
  }
  return {
    average24hAnnualizedPct:calculateCurrentAnnualizedPct(averageRatePct, intervalHours),
    consecutivePositiveSettlements,
    settledObservationCount:deduped.length,
    firstSettledAt:new Date(deduped[0].observedAtMs).toISOString(),
    lastSettledAt:new Date(deduped.at(-1).observedAtMs).toISOString(),
  };
}

export function basisPersistenceMinutes(currentBucketMs, currentBasisPct, history, routeFingerprint) {
  if (!(finite(currentBasisPct) >= ARBITRAGE_THRESHOLDS.basisPct)) return 0;
  const bucket = fiveMinuteBucket(currentBucketMs);
  let earliest = bucket;
  let expected = bucket - ARBITRAGE_BUCKET_MS;
  const rows = (Array.isArray(history) ? history : [])
    .filter(row => row?.routeFingerprint === routeFingerprint && finite(row?.basisPct) >= ARBITRAGE_THRESHOLDS.basisPct)
    .map(row => {
      const bucketAtMs = timestamp(row?.bucketAt);
      return { bucketAtMs:bucketAtMs === null ? null : fiveMinuteBucket(bucketAtMs) };
    })
    .filter(row => Number.isFinite(row.bucketAtMs) && row.bucketAtMs < bucket)
    .sort((left, right) => right.bucketAtMs - left.bucketAtMs);
  const unique = new Set(rows.map(row => row.bucketAtMs));
  while (unique.has(expected)) {
    earliest = expected;
    expected -= ARBITRAGE_BUCKET_MS;
  }
  return Math.floor((bucket - earliest) / 60_000);
}

export function routeIdentity(asset, spot, perp) {
  const category = lower(asset?.category);
  const symbol = upper(asset?.symbol ?? asset?.canonicalSymbol);
  const spotVenue = lower(spot?.venue);
  const spotSymbol = String(spot?.venueSymbol ?? '').trim();
  const perpVenue = lower(perp?.venue);
  const perpSymbol = String(perp?.venueSymbol ?? '').trim();
  if (!CATEGORIES.has(category) || !SAFE_CANONICAL.test(symbol) || !SPOT_VENUES.has(spotVenue) ||
      !PERP_VENUES.has(perpVenue) || !SAFE_SYMBOL.test(spotSymbol) || !SAFE_SYMBOL.test(perpSymbol)) {
    throw new TypeError('Invalid exact arbitrage route identity');
  }
  const assetKey = `${category}:${symbol}`;
  const routeId = `${assetKey}:${spotVenue}:${spotSymbol}:${perpVenue}:${perpSymbol}`;
  if (!SAFE_ROUTE_ID.test(routeId)) throw new TypeError('Unsafe arbitrage route ID');
  return {
    assetKey,
    routeId,
    routeFingerprint:createHash('sha256').update(routeId).digest('hex'),
  };
}

export function buildArbitrageRoute(input, options = {}) {
  const generatedAtMs = timestamp(options.generatedAt ?? input?.generatedAt);
  if (generatedAtMs === null) throw new TypeError('Missing arbitrage generation time');
  const asset = input?.asset || {};
  const spot = input?.spot || {};
  const perp = input?.perp || {};
  const identity = routeIdentity(asset, spot, perp);
  const name = String(asset?.name || '').trim();
  const category = lower(asset?.category);
  const spotObservedAtMs = timestamp(spot?.observedAt);
  const perpObservedAtMs = timestamp(perp?.observedAt);
  const spotAsk = positive(spot?.askPriceUsd);
  const perpBid = positive(perp?.bidPriceUsd);
  const spotDepth = nonNegative(spot?.executableDepthUsd);
  const perpDepth = nonNegative(perp?.executableDepthUsd);
  const openInterest = nonNegative(perp?.openInterestUsd);
  const currentRateFraction = finite(perp?.currentFundingRate);
  const intervalHours = positive(perp?.fundingIntervalHours);
  const fundingObservedAtMs = timestamp(perp?.fundingObservedAt ?? perp?.observedAt);
  if (!name || name.length > 200 || !CATEGORIES.has(category) || asset?.verified !== true || asset?.eligible !== true ||
      spotObservedAtMs === null || perpObservedAtMs === null || fundingObservedAtMs === null ||
      spotAsk === null || perpBid === null || spotDepth === null || perpDepth === null || openInterest === null ||
      currentRateFraction === null || intervalHours === null || intervalHours > 24 ||
      generatedAtMs - spotObservedAtMs < 0 || generatedAtMs - perpObservedAtMs < 0 ||
      generatedAtMs - spotObservedAtMs > ARBITRAGE_LEG_MAX_AGE_MS ||
      generatedAtMs - perpObservedAtMs > ARBITRAGE_LEG_MAX_AGE_MS ||
      Math.abs(spotObservedAtMs - perpObservedAtMs) > ARBITRAGE_LEG_MAX_SKEW_MS) {
    throw new TypeError(`Incomplete or stale arbitrage route ${identity.routeId}`);
  }
  const settled = settledFundingMetrics(input?.fundingHistory, { nowMs:generatedAtMs, intervalHours });
  if (!settled) throw new TypeError(`Incomplete settled funding history for ${identity.routeId}`);
  const basisPct = calculateBasisPct(spotAsk, perpBid);
  const currentRatePct = round(currentRateFraction * 100, 8);
  const currentAnnualizedPct = calculateCurrentAnnualizedPct(currentRatePct, intervalHours);
  const bucketMs = fiveMinuteBucket(generatedAtMs);
  const persistenceMinutes = basisPersistenceMinutes(
    bucketMs,
    basisPct,
    options.basisHistory,
    identity.routeFingerprint,
  );
  return {
    routeId:identity.routeId,
    routeFingerprint:identity.routeFingerprint,
    assetKey:identity.assetKey,
    symbol:upper(asset.symbol ?? asset.canonicalSymbol),
    name,
    category,
    verified:true,
    eligible:true,
    status:'full',
    spot:{
      status:'full', venue:lower(spot.venue), venueSymbol:String(spot.venueSymbol).trim(),
      askPriceUsd:round(spotAsk, 8), executableDepthUsd:round(spotDepth, 2),
      observedAt:new Date(spotObservedAtMs).toISOString(),
    },
    perp:{
      status:'full', venue:lower(perp.venue), venueSymbol:String(perp.venueSymbol).trim(),
      bidPriceUsd:round(perpBid, 8), executableDepthUsd:round(perpDepth, 2),
      openInterestUsd:round(openInterest, 2), observedAt:new Date(perpObservedAtMs).toISOString(),
    },
    basis:{ status:'full', pct:round(basisPct, 8), persistenceMinutes },
    funding:{
      status:'full', currentRatePct, intervalHours:round(intervalHours, 8), currentAnnualizedPct,
      average24hAnnualizedPct:round(settled.average24hAnnualizedPct, 8),
      consecutivePositiveSettlements:settled.consecutivePositiveSettlements,
      shortReceives:currentRatePct > 0,
      observedAt:new Date(fundingObservedAtMs).toISOString(),
    },
  };
}

export function routeMeetsNotificationPolicy(route) {
  const capacity = route?.spot?.executableDepthUsd >= ARBITRAGE_THRESHOLDS.executableDepthUsd &&
    route?.perp?.executableDepthUsd >= ARBITRAGE_THRESHOLDS.executableDepthUsd &&
    route?.perp?.openInterestUsd >= ARBITRAGE_THRESHOLDS.openInterestUsd;
  if (!capacity) return false;
  const basis = route?.basis?.pct >= ARBITRAGE_THRESHOLDS.basisPct &&
    route?.basis?.persistenceMinutes >= ARBITRAGE_THRESHOLDS.basisPersistenceMinutes;
  const funding = route?.funding?.average24hAnnualizedPct >= ARBITRAGE_THRESHOLDS.fundingAverage24hAnnualizedPct &&
    route?.funding?.consecutivePositiveSettlements >= ARBITRAGE_THRESHOLDS.fundingConsecutivePositiveSettlements &&
    route?.funding?.shortReceives === true && route?.basis?.pct >= ARBITRAGE_THRESHOLDS.fundingMinimumBasisPct;
  return basis || funding;
}

export function validateArbitrageRoute(route, options = {}) {
  const generatedAtMs = timestamp(options.generatedAt);
  if (generatedAtMs === null || !route || typeof route !== 'object' || Array.isArray(route)) {
    return { valid:false, reason:'invalid-arbitrage-route' };
  }
  let identity;
  try {
    identity = routeIdentity(
      { category:route.category, symbol:route.symbol },
      route.spot,
      route.perp,
    );
  } catch {
    return { valid:false, reason:'invalid-arbitrage-route-identity' };
  }
  const spotObservedAtMs = timestamp(route?.spot?.observedAt);
  const perpObservedAtMs = timestamp(route?.perp?.observedAt);
  const fundingObservedAtMs = timestamp(route?.funding?.observedAt);
  const spotAsk = positive(route?.spot?.askPriceUsd);
  const perpBid = positive(route?.perp?.bidPriceUsd);
  const basisPct = finite(route?.basis?.pct);
  const persistenceMinutes = nonNegative(route?.basis?.persistenceMinutes);
  const currentRatePct = finite(route?.funding?.currentRatePct);
  const intervalHours = positive(route?.funding?.intervalHours);
  const currentAnnualizedPct = finite(route?.funding?.currentAnnualizedPct);
  const expectedBasis = calculateBasisPct(spotAsk, perpBid);
  const expectedAnnualized = calculateCurrentAnnualizedPct(currentRatePct, intervalHours);
  const exactIdentity = route.routeId === identity.routeId &&
    route.routeFingerprint === identity.routeFingerprint && route.assetKey === identity.assetKey;
  const valid = exactIdentity && route.symbol === upper(route.symbol) &&
    String(route.name || '').trim().length > 0 && String(route.name || '').trim().length <= 200 &&
    route.verified === true && route.eligible === true && route.status === 'full' &&
    route?.spot?.status === 'full' && route?.perp?.status === 'full' && route?.basis?.status === 'full' &&
    route?.funding?.status === 'full' && spotAsk !== null && perpBid !== null &&
    nonNegative(route?.spot?.executableDepthUsd) !== null &&
    nonNegative(route?.perp?.executableDepthUsd) !== null && nonNegative(route?.perp?.openInterestUsd) !== null &&
    basisPct !== null && persistenceMinutes !== null && Number.isInteger(persistenceMinutes) &&
    currentRatePct !== null && intervalHours !== null && intervalHours <= 24 && currentAnnualizedPct !== null &&
    finite(route?.funding?.average24hAnnualizedPct) !== null &&
    Number.isInteger(route?.funding?.consecutivePositiveSettlements) &&
    route.funding.consecutivePositiveSettlements >= 0 &&
    route?.funding?.shortReceives === (currentRatePct > 0) &&
    spotObservedAtMs !== null && perpObservedAtMs !== null && fundingObservedAtMs !== null &&
    generatedAtMs >= spotObservedAtMs && generatedAtMs - spotObservedAtMs <= ARBITRAGE_LEG_MAX_AGE_MS &&
    generatedAtMs >= perpObservedAtMs && generatedAtMs - perpObservedAtMs <= ARBITRAGE_LEG_MAX_AGE_MS &&
    generatedAtMs >= fundingObservedAtMs && generatedAtMs - fundingObservedAtMs <= ARBITRAGE_LEG_MAX_AGE_MS &&
    Math.abs(spotObservedAtMs - perpObservedAtMs) <= ARBITRAGE_LEG_MAX_SKEW_MS &&
    expectedBasis !== null && Math.abs(expectedBasis - basisPct) <= 0.000001 &&
    expectedAnnualized !== null && Math.abs(expectedAnnualized - currentAnnualizedPct) <= 0.000001;
  if (!valid) return { valid:false, reason:'invalid-arbitrage-route' };
  return { valid:true, identity };
}

export function buildArbitrageSnapshot(routes, coverage, options = {}) {
  const generatedAtMs = timestamp(options.generatedAt ?? Date.now());
  if (generatedAtMs === null) throw new TypeError('Invalid arbitrage snapshot time');
  const routeRows = Array.isArray(routes) ? routes : [];
  const routeIds = routeRows.map(route => route?.routeId);
  const complete = coverage?.complete === true && coverage?.availableSources === 5 &&
    coverage?.spotAvailableSources === 5 && coverage?.identityConflicts === 0 &&
    coverage?.rejectedListings === 0 && coverage?.quarantinedListings === 0 &&
    new Set(routeIds).size === routeIds.length &&
    new Set(routeRows.map(route => route?.routeFingerprint)).size === routeRows.length &&
    routeRows.every(route => validateArbitrageRoute(route, { generatedAt:generatedAtMs }).valid) &&
    routeRows.every(routeMeetsNotificationPolicy);
  if (!complete) throw new TypeError('Arbitrage snapshot coverage is incomplete');
  return {
    schemaVersion:ARBITRAGE_SCHEMA_VERSION,
    formulaVersion:ARBITRAGE_FORMULA_VERSION,
    generatedAt:new Date(generatedAtMs).toISOString(),
    bucket:new Date(fiveMinuteBucket(generatedAtMs)).toISOString(),
    status:'full',
    coverage:{
      expectedSources:5,
      availableSources:5,
      spotExpectedSources:5,
      spotAvailableSources:5,
      identityConflicts:0,
      rejectedListings:0,
      quarantinedListings:0,
      expectedRoutes:routeRows.length,
      returnedRoutes:routeRows.length,
      complete:true,
    },
    methodology:{
      executionTolerancePct:ARBITRAGE_EXECUTION_TOLERANCE_PCT,
      prices:'executable-top-of-book',
      fundingHistory:'exact-contract-settled-24h',
    },
    routes:[...routeRows].sort((left, right) => left.routeId.localeCompare(right.routeId)),
  };
}

export function validateArbitrageSnapshot(payload, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const generatedAtMs = timestamp(payload?.generatedAt);
  const bucketMs = timestamp(payload?.bucket);
  const routes = Array.isArray(payload?.routes) ? payload.routes : null;
  const coverage = payload?.coverage || {};
  if (payload?.schemaVersion !== ARBITRAGE_SCHEMA_VERSION || payload?.formulaVersion !== ARBITRAGE_FORMULA_VERSION ||
      payload?.status !== 'full' || generatedAtMs === null || bucketMs === null ||
      bucketMs !== fiveMinuteBucket(generatedAtMs) || generatedAtMs > nowMs + 60_000 ||
      nowMs - generatedAtMs > ARBITRAGE_MAX_AGE_MS || !routes ||
      coverage.expectedSources !== 5 || coverage.availableSources !== 5 ||
      coverage.spotExpectedSources !== 5 || coverage.spotAvailableSources !== 5 ||
      coverage.identityConflicts !== 0 || coverage.rejectedListings !== 0 || coverage.quarantinedListings !== 0 ||
      coverage.complete !== true || coverage.expectedRoutes !== routes.length || coverage.returnedRoutes !== routes.length ||
      new Set(routes.map(route => route?.routeId)).size !== routes.length ||
      new Set(routes.map(route => route?.routeFingerprint)).size !== routes.length ||
      routes.some(route => !validateArbitrageRoute(route, { generatedAt:generatedAtMs }).valid) ||
      routes.some(route => !routeMeetsNotificationPolicy(route))) {
    return { valid:false, reason:'invalid-or-stale-arbitrage-snapshot' };
  }
  return { valid:true, generatedAtMs, bucketMs, routes };
}

export function unavailableArbitragePayload(reason = 'authoritative snapshot unavailable') {
  return {
    schemaVersion:ARBITRAGE_SCHEMA_VERSION,
    formulaVersion:ARBITRAGE_FORMULA_VERSION,
    generatedAt:null,
    bucket:null,
    status:'unavailable',
    coverage:{
      expectedSources:5, availableSources:0, spotExpectedSources:5, spotAvailableSources:0,
      identityConflicts:0, rejectedListings:0, quarantinedListings:0,
      expectedRoutes:null, returnedRoutes:0, complete:false,
    },
    routes:[],
    reason:String(reason || 'authoritative snapshot unavailable').slice(0, 300),
  };
}

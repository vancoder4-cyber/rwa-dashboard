import { createHash } from 'node:crypto';

import { normalizeSignalIdentity } from './security-identity.js';

export const OI_LIQUIDATION_FORMULA_VERSION = 'rwa-oi-liquidation-proxy-1.0';
export const OI_LIQUIDATION_HISTORY_NAMESPACE = 'rwa-signal-oi-liquidation-hourly-v1';
export const OI_LIQUIDATION_HISTORY_HOURS = 96;
export const OI_LIQUIDATION_HISTORY_MAX_BYTES = 1_750_000;
export const OI_LIQUIDATION_THRESHOLDS = Object.freeze({
  minVolume24hUsdExclusive:1_000_000,
  liquidationProxyDropUsdExclusive:2_000_000,
  risingCompletedDays:3,
  peakLookbackHours:24,
  topTraderBullishAbove:1.05,
  topTraderBearishBelow:0.95,
  logic:'or',
});

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const HISTORY_VERSION = 1;
const RESPONSE_ROW_LIMIT = 100;
const TOP_TRADER_MAX_AGE_MS = 3 * HOUR_MS;
const PRICE_24H_SELECTION_METHOD = 'largest-current-oi-listing-with-available-change';
const BINANCE_VENUE = 'binance';
const TOP_TRADER_METRIC = 'top-trader-position-ratio';
const TOP_TRADER_SCOPE = 'top-20%-by-margin-balance-position-ratio';
const TOP_TRADER_PERIOD = '1h';
const MARKET_CONTEXT_VERSION = 'rwa-oi-market-context/v2';
const CATEGORY_CODES = Object.freeze({
  equity:'e',
  etf:'t',
  commodity:'c',
  index:'i',
  fx:'f',
  bond:'b',
  'pre-ipo':'p',
});
const CODE_CATEGORIES = Object.freeze(Object.fromEntries(
  Object.entries(CATEGORY_CODES).map(([category, code]) => [code, category]),
));
const COHORT_PATTERN = /^[A-Za-z0-9_-]{12,32}$/;

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function nonNegativeOrNull(value) {
  const numeric = finiteOrNull(value);
  return numeric !== null && numeric >= 0 ? numeric : null;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function utcHour(timestampMs) {
  const numeric = finiteOrNull(timestampMs);
  return numeric === null ? null : Math.floor(numeric / HOUR_MS) * HOUR_MS;
}

function utcDay(timestampMs) {
  const numeric = finiteOrNull(timestampMs);
  return numeric === null ? null : Math.floor(numeric / DAY_MS) * DAY_MS;
}

function normalizedCategory(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizedSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function identityKey(symbol, category) {
  const normalized = normalizeSignalIdentity(symbol, category);
  if (!normalized) return null;
  const expectedSymbol = normalizedSymbol(symbol);
  const expectedCategory = normalizedCategory(category);
  return normalized.symbol === expectedSymbol && normalized.category === expectedCategory
    ? `${expectedCategory}:${expectedSymbol}`
    : null;
}

function encodeCategory(category) {
  const normalized = normalizedCategory(category);
  return CATEGORY_CODES[normalized] || normalized;
}

function decodeCategory(code) {
  const normalized = normalizedCategory(code);
  return CODE_CATEGORIES[normalized] || normalized;
}

function amountToCents(value) {
  const amount = nonNegativeOrNull(value);
  if (amount === null || amount > Number.MAX_SAFE_INTEGER / 100) return null;
  return Math.round(amount * 100);
}

function centsToAmount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value / 100 : null;
}

function acceptedFieldStatus(value) {
  return ['full', 'estimated'].includes(String(value || '').trim().toLowerCase());
}

function publicListing(listing) {
  const venue = String(listing?.venue || '').trim().toLowerCase();
  const venueSymbol = String(listing?.venueSymbol || '').trim();
  const instrumentType = String(listing?.instrumentType || 'perpetual').trim().toLowerCase();
  const volumeMethod = String(listing?.volumeMethod || '').trim().toLowerCase();
  const volumeStatus = String(listing?.volumeStatus || '').trim().toLowerCase();
  const openInterestMethod = String(listing?.openInterestMethod || '').trim().toLowerCase();
  const openInterestStatus = String(listing?.openInterestStatus || '').trim().toLowerCase();
  const change24hMethod = String(listing?.change24hMethod || '').trim().toLowerCase();
  const change24hStatus = String(listing?.change24hStatus || '').trim().toLowerCase();
  const fundingRate = finiteOrNull(listing?.fundingRate);
  const fundingIntervalHours = finiteOrNull(listing?.fundingIntervalHours);
  const fundingValid = fundingRate !== null && fundingIntervalHours !== null && fundingIntervalHours > 0;
  const volume24hUsd = round(nonNegativeOrNull(listing?.volume24hUsd), 2);
  const openInterestUsd = round(nonNegativeOrNull(listing?.openInterestUsd), 2);
  const rawChange24hPct = finiteOrNull(listing?.change24hPct);
  const normalizedChange24hPct = rawChange24hPct !== null && rawChange24hPct >= -100
    ? round(rawChange24hPct, 5)
    : null;
  const change24hValid = normalizedChange24hPct !== null && change24hMethod &&
    acceptedFieldStatus(change24hStatus);
  const change24hPct = change24hValid ? normalizedChange24hPct : null;
  const identityValid = Boolean(venue && venueSymbol && instrumentType);
  const volumeValid = Boolean(identityValid && volumeMethod &&
    acceptedFieldStatus(volumeStatus) && volume24hUsd !== null);
  const openInterestValid = Boolean(identityValid && openInterestMethod &&
    acceptedFieldStatus(openInterestStatus) && openInterestUsd !== null);
  return {
    valid:volumeValid && openInterestValid,
    volumeValid,
    openInterestValid,
    value:{
      venue,
      venueSymbol,
      instrumentType,
      volume24hUsd,
      volumeMethod:volumeMethod || null,
      volumeStatus:acceptedFieldStatus(volumeStatus) ? volumeStatus : 'unavailable',
      openInterestUsd,
      openInterestMethod:openInterestMethod || null,
      openInterestStatus:acceptedFieldStatus(openInterestStatus) ? openInterestStatus : 'unavailable',
      fundingRate:fundingValid ? fundingRate : null,
      fundingIntervalHours:fundingValid ? fundingIntervalHours : null,
      change24hPct,
      change24hMethod:change24hValid ? change24hMethod : null,
      change24hStatus:change24hValid ? change24hStatus : 'unavailable',
    },
  };
}

function cohortFingerprint(listings) {
  if (!Array.isArray(listings) || !listings.length) return null;
  const members = listings.map(listing => [
    listing.venue,
    listing.venueSymbol,
    listing.instrumentType,
    listing.volumeMethod,
    listing.openInterestMethod,
  ].join(':'));
  if (new Set(members).size !== listings.length) return null;
  return createHash('sha256')
    .update([...members].sort().join('|'))
    .digest('base64url')
    .slice(0, 16);
}

function classifyCurrentAssets(assets) {
  const rows = [];
  const counts = {
    verifiedAssets:0,
    filteredLowVolume:0,
    filterUnknown:0,
    volumeEligibleAssets:0,
    completeEligibleAssets:0,
    missingEligibleAssets:0,
    perpListings:0,
  };

  for (const asset of Array.isArray(assets) ? assets : []) {
    const symbol = normalizedSymbol(asset?.symbol);
    const category = normalizedCategory(asset?.category);
    const assetKey = identityKey(symbol, category);
    if (!assetKey) continue;
    counts.verifiedAssets += 1;
    const rawListings = Array.isArray(asset?.listings) ? asset.listings : [];
    counts.perpListings += rawListings.length;
    const aggregateVolume = round(nonNegativeOrNull(asset?.volume24hUsd), 2);
    const volumeAggregateFull = String(asset?.fieldStatus?.volume24hUsd || '').toLowerCase() === 'full';
    const listingCountComplete = rawListings.length > 0 && rawListings.length === Number(asset?.listingCount);
    const normalizedListings = rawListings.map(publicListing);
    const listings = normalizedListings.map(row => row.value);
    const exactListingKeys = listings.map(listing => `${listing.venue}:${listing.venueSymbol}`);
    const exactListingsUnique = new Set(exactListingKeys).size === listings.length;
    const listingVolumesComplete = normalizedListings.every(row => row.volumeValid);
    const publicAggregateVolume = listingCountComplete && exactListingsUnique && listingVolumesComplete
      ? round(listings.reduce((sum, listing) => sum + listing.volume24hUsd, 0), 2)
      : null;
    if (aggregateVolume === null || !volumeAggregateFull || publicAggregateVolume === null) {
      counts.filterUnknown += 1;
      rows.push({ assetKey, symbol, category, classification:'filter-unknown' });
      continue;
    }
    // The strict eligibility boundary is evaluated from the exact public,
    // cent-rounded listing values that are also returned to consumers.
    if (!(publicAggregateVolume > OI_LIQUIDATION_THRESHOLDS.minVolume24hUsdExclusive)) {
      counts.filteredLowVolume += 1;
      rows.push({ assetKey, symbol, category, classification:'filtered-low-volume' });
      continue;
    }

    counts.volumeEligibleAssets += 1;
    const reasonCodes = [];
    if (!listingCountComplete) {
      reasonCodes.push('LISTING_COHORT_INCOMPLETE');
    }
    if (normalizedListings.some(row => !row.openInterestValid)) reasonCodes.push('LISTING_OPEN_INTEREST_UNAVAILABLE');
    if (!exactListingsUnique) reasonCodes.push('DUPLICATE_EXACT_LISTING');
    const cohort = reasonCodes.length ? null : cohortFingerprint(listings);
    if (!cohort) reasonCodes.push('COHORT_FINGERPRINT_UNAVAILABLE');
    const currentVolume24hUsd = reasonCodes.length ? null : publicAggregateVolume;
    const currentOpenInterestUsd = reasonCodes.length
      ? null
      : round(listings.reduce((sum, listing) => sum + listing.openInterestUsd, 0), 2);
    if (reasonCodes.length || currentOpenInterestUsd === null) {
      counts.missingEligibleAssets += 1;
      rows.push({
        assetKey,
        symbol,
        category,
        listingCount:listings.length,
        listings,
        currentOpenInterestUsd:null,
        classification:'eligible-incomplete',
        reasonCodes:[...new Set(reasonCodes)],
      });
      continue;
    }
    counts.completeEligibleAssets += 1;
    rows.push({
      assetKey,
      symbol,
      category,
      venues:[...new Set(listings.map(listing => listing.venue))].sort(),
      listingCount:listings.length,
      listings,
      cohortFingerprint:cohort,
      currentVolume24hUsd,
      currentOpenInterestUsd,
      classification:'eligible-complete',
      reasonCodes:[],
    });
  }
  return { rows, counts };
}

function emptyHistory() {
  return { v:HISTORY_VERSION, i:[], c:[], h:[] };
}

function decodeHistory(history, nowMs) {
  if (history === null || history === undefined) return [];
  if (!history || history.v !== HISTORY_VERSION || !Array.isArray(history.i) ||
      !Array.isArray(history.c) || !Array.isArray(history.h)) {
    throw new TypeError('Invalid OI hourly history envelope');
  }
  const identities = history.i.map(compactIdentity => {
    if (!Array.isArray(compactIdentity) || compactIdentity.length !== 2) {
      throw new TypeError('Invalid OI hourly identity dictionary');
    }
    const category = decodeCategory(compactIdentity[0]);
    const symbol = normalizedSymbol(compactIdentity[1]);
    const key = identityKey(symbol, category);
    if (!key) throw new TypeError('Invalid OI hourly identity');
    return { assetKey:key, category, symbol };
  });
  if (new Set(identities.map(row => row.assetKey)).size !== identities.length) {
    throw new TypeError('Duplicate OI hourly identity dictionary entry');
  }
  const cohorts = history.c.map(value => String(value || ''));
  if (cohorts.some(value => !COHORT_PATTERN.test(value)) || new Set(cohorts).size !== cohorts.length) {
    throw new TypeError('Invalid OI hourly cohort dictionary');
  }
  const currentHour = utcHour(nowMs);
  if (currentHour === null) throw new TypeError('Invalid OI hourly history clock');
  const cutoff = currentHour - (OI_LIQUIDATION_HISTORY_HOURS - 1) * HOUR_MS;
  const byHour = new Map();
  for (const compactSnapshot of history.h) {
    const timestamp = finiteOrNull(compactSnapshot?.t);
    const eligible = Number(compactSnapshot?.e);
    const missing = Number(compactSnapshot?.m);
    if (!Number.isSafeInteger(timestamp) || utcHour(timestamp) !== timestamp || timestamp > currentHour ||
        !Number.isSafeInteger(eligible) || eligible < 0 || !Number.isSafeInteger(missing) || missing < 0 ||
        !Array.isArray(compactSnapshot?.a)) {
      throw new TypeError('Invalid OI hourly snapshot');
    }
    const rows = [];
    const seen = new Set();
    for (const compactRow of compactSnapshot.a) {
      if (!Array.isArray(compactRow) || compactRow.length !== 3) {
        throw new TypeError('Invalid OI hourly row');
      }
      const [identityIndex, oiCents, cohortIndex] = compactRow;
      if (!Number.isSafeInteger(identityIndex) || !identities[identityIndex] ||
          !Number.isSafeInteger(oiCents) || oiCents < 0 ||
          !Number.isSafeInteger(cohortIndex) || !cohorts[cohortIndex]) {
        throw new TypeError('Invalid OI hourly row reference');
      }
      const identity = identities[identityIndex];
      if (seen.has(identity.assetKey)) throw new TypeError('Duplicate asset in OI hourly snapshot');
      seen.add(identity.assetKey);
      rows.push({ ...identity, openInterestUsd:centsToAmount(oiCents), cohortFingerprint:cohorts[cohortIndex] });
    }
    if (eligible !== rows.length + missing) throw new TypeError('Invalid OI hourly eligibility counts');
    if (timestamp >= cutoff) byHour.set(timestamp, { t:timestamp, e:eligible, m:missing, rows });
  }
  return [...byHour.values()].sort((left, right) => left.t - right.t)
    .slice(-OI_LIQUIDATION_HISTORY_HOURS);
}

function encodeHistory(snapshots) {
  if (!snapshots.length) return emptyHistory();
  const identities = new Map();
  const cohorts = new Set();
  for (const snapshot of snapshots) {
    for (const row of snapshot.rows) {
      identities.set(row.assetKey, { category:row.category, symbol:row.symbol });
      cohorts.add(row.cohortFingerprint);
    }
  }
  const identityRows = [...identities.entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  const cohortRows = [...cohorts].sort();
  const identityIndexes = new Map(identityRows.map(([key], index) => [key, index]));
  const cohortIndexes = new Map(cohortRows.map((cohort, index) => [cohort, index]));
  return {
    v:HISTORY_VERSION,
    i:identityRows.map(([, identity]) => [encodeCategory(identity.category), identity.symbol]),
    c:cohortRows,
    h:snapshots.map(snapshot => ({
      t:snapshot.t,
      e:snapshot.e,
      m:snapshot.m,
      a:[...snapshot.rows]
        .sort((left, right) => left.assetKey.localeCompare(right.assetKey))
        .map(row => [
          identityIndexes.get(row.assetKey),
          amountToCents(row.openInterestUsd),
          cohortIndexes.get(row.cohortFingerprint),
        ]),
    })),
  };
}

export function oiHourlyHistoryBytes(history) {
  return Buffer.byteLength(JSON.stringify(history ?? emptyHistory()), 'utf8');
}

function assertHistorySize(history) {
  const bytes = oiHourlyHistoryBytes(history);
  if (bytes > OI_LIQUIDATION_HISTORY_MAX_BYTES) {
    throw new RangeError(
      `OI hourly history exceeds ${OI_LIQUIDATION_HISTORY_MAX_BYTES} bytes (${bytes})`,
    );
  }
  return history;
}

export function compactOiHourlySnapshot(assets, capturedAtMs) {
  const bucket = utcHour(capturedAtMs);
  if (bucket === null) throw new TypeError('Invalid OI hourly snapshot timestamp');
  const classified = classifyCurrentAssets(assets);
  const complete = classified.rows.filter(row => row.classification === 'eligible-complete');
  return assertHistorySize(encodeHistory([{
    t:bucket,
    e:classified.counts.volumeEligibleAssets,
    m:classified.counts.missingEligibleAssets,
    rows:complete.map(row => ({
      assetKey:row.assetKey,
      category:row.category,
      symbol:row.symbol,
      openInterestUsd:row.currentOpenInterestUsd,
      cohortFingerprint:row.cohortFingerprint,
    })),
  }]));
}

export function normalizeOiHourlyHistory(history, nowMs = Date.now()) {
  return assertHistorySize(encodeHistory(decodeHistory(history, nowMs)));
}

export function mergeOiHourlyHistory(history, currentSnapshot, nowMs = Date.now()) {
  const stored = decodeHistory(normalizeOiHourlyHistory(history, nowMs), nowMs);
  const current = decodeHistory(normalizeOiHourlyHistory(currentSnapshot, nowMs), nowMs);
  if (current.length !== 1 || current[0].t !== utcHour(nowMs)) {
    throw new TypeError('Invalid current OI hourly snapshot');
  }
  const byHour = new Map(stored.map(snapshot => [snapshot.t, snapshot]));
  byHour.set(current[0].t, current[0]);
  const cutoff = utcHour(nowMs) - (OI_LIQUIDATION_HISTORY_HOURS - 1) * HOUR_MS;
  const merged = [...byHour.values()]
    .filter(snapshot => snapshot.t >= cutoff && snapshot.t <= utcHour(nowMs))
    .sort((left, right) => left.t - right.t)
    .slice(-OI_LIQUIDATION_HISTORY_HOURS);
  return assertHistorySize(encodeHistory(merged));
}

function rowsByHour(history, nowMs) {
  return new Map(decodeHistory(history, nowMs).map(snapshot => [
    snapshot.t,
    new Map(snapshot.rows.map(row => [row.assetKey, row])),
  ]));
}

function completedDayEvaluation(hourRows, current, capturedAtMs) {
  const currentDay = utcDay(capturedAtMs);
  const closes = [];
  for (let offset = OI_LIQUIDATION_THRESHOLDS.risingCompletedDays; offset >= 1; offset -= 1) {
    const day = currentDay - offset * DAY_MS;
    const closeHour = day + 23 * HOUR_MS;
    const row = hourRows.get(closeHour)?.get(current.assetKey);
    if (!row || row.cohortFingerprint !== current.cohortFingerprint) {
      return { ready:false, trend:'warming', closes:[] };
    }
    closes.push({
      day:new Date(day).toISOString().slice(0, 10),
      openInterestUsd:round(row.openInterestUsd, 2),
    });
  }
  const rising = closes.every((row, index) => index === 0 ||
    row.openInterestUsd > closes[index - 1].openInterestUsd);
  return { ready:true, trend:rising ? 'rising' : 'not-rising', closes };
}

function drawdownEvaluation(hourRows, current, capturedAtMs) {
  const currentHour = utcHour(capturedAtMs);
  const series = [];
  let missingHour = false;
  let changedCohort = false;
  for (let offset = OI_LIQUIDATION_THRESHOLDS.peakLookbackHours - 1; offset >= 0; offset -= 1) {
    const hour = currentHour - offset * HOUR_MS;
    const row = hourRows.get(hour)?.get(current.assetKey);
    if (!row) {
      missingHour = true;
      continue;
    }
    if (row.cohortFingerprint !== current.cohortFingerprint) {
      changedCohort = true;
      continue;
    }
    series.push({ hour, openInterestUsd:round(row.openInterestUsd, 2) });
  }
  if (missingHour || changedCohort) {
    return {
      ready:false,
      peak:null,
      peakAt:null,
      drawdown:null,
      sameCohort:changedCohort ? false : null,
      reasonCodes:[
        ...(changedCohort ? ['OI_COHORT_CHANGED'] : []),
        ...(missingHour ? ['OI_HISTORY_HOUR_MISSING'] : []),
      ],
    };
  }
  const peak = series.reduce((selected, row) =>
    row.openInterestUsd > selected.openInterestUsd ? row : selected, series[0]);
  const drawdown = round(peak.openInterestUsd - current.currentOpenInterestUsd, 2);
  return {
    ready:true,
    peak:peak.openInterestUsd,
    peakAt:new Date(peak.hour).toISOString(),
    drawdown,
    sameCohort:true,
    reasonCodes:[],
  };
}

function drawdownState(current, drawdown, observedBucket, {
  historyAvailable,
  snapshotComparable,
} = {}) {
  const base = {
    assetKey:current.assetKey,
    symbol:current.symbol,
    category:current.category,
    cohortFingerprint:current.cohortFingerprint || null,
    observedBucket,
    evaluationStatus:'unavailable',
    sameCohort:null,
    currentOpenInterestUsd:Number.isFinite(current.currentOpenInterestUsd)
      ? round(current.currentOpenInterestUsd, 2)
      : null,
    peak24hOpenInterestUsd:null,
    drawdown24hUsd:null,
    drawdown24hPct:null,
    reasonCodes:[],
  };
  if (current.classification !== 'eligible-complete') {
    const reasonCodes = Array.isArray(current.reasonCodes) && current.reasonCodes.length
      ? current.reasonCodes
      : ['CURRENT_OI_COHORT_INCOMPLETE'];
    return {
      ...base,
      reasonCodes:[...new Set(reasonCodes)],
    };
  }
  const unavailableReasons = [
    ...(!historyAvailable ? ['OI_HISTORY_UNAVAILABLE'] : []),
    ...(!snapshotComparable ? ['OI_SNAPSHOT_NOT_COMPARABLE'] : []),
  ];
  if (unavailableReasons.length) return { ...base, reasonCodes:unavailableReasons };
  if (!drawdown?.ready) {
    return {
      ...base,
      evaluationStatus:'warming',
      sameCohort:drawdown?.sameCohort ?? null,
      reasonCodes:[...new Set(drawdown?.reasonCodes || ['OI_HISTORY_WARMING'])],
    };
  }
  const drawdownPct = drawdown.peak > 0
    ? round((drawdown.drawdown / drawdown.peak) * 100, 6)
    : null;
  const triggered = drawdown.drawdown > OI_LIQUIDATION_THRESHOLDS.liquidationProxyDropUsdExclusive;
  return {
    ...base,
    evaluationStatus:triggered ? 'triggered' : 'clear',
    sameCohort:true,
    peak24hOpenInterestUsd:drawdown.peak,
    drawdown24hUsd:drawdown.drawdown,
    drawdown24hPct:drawdownPct,
    reasonCodes:drawdownPct === null ? ['OI_PEAK_ZERO_PERCENT_UNAVAILABLE'] : [],
  };
}

function unavailableTraderPosition(venueSymbol, reasonCode = 'TOP_TRADER_UNAVAILABLE') {
  return {
    venueSymbol,
    status:'unavailable',
    longShortRatio:null,
    longPositionPct:null,
    shortPositionPct:null,
    bias:'unavailable',
    observedAt:null,
    reasonCode,
  };
}

function price24hContext(current, capturedAtMs) {
  const listings = Array.isArray(current?.listings) ? current.listings : [];
  const expectedListings = listings.length;
  const observed = listings.filter(listing => Number.isFinite(listing?.change24hPct) &&
    listing.change24hPct >= -100 && typeof listing?.change24hMethod === 'string' &&
    listing.change24hMethod.length > 0 && acceptedFieldStatus(listing?.change24hStatus));
  const candidates = observed
    .filter(listing => Number.isFinite(listing?.openInterestUsd) && listing.openInterestUsd >= 0)
    .sort((left, right) => right.openInterestUsd - left.openInterestUsd ||
      left.venue.localeCompare(right.venue) || left.venueSymbol.localeCompare(right.venueSymbol));
  const representativeListing = candidates[0] || null;
  const aggregateOi = nonNegativeOrNull(current?.currentOpenInterestUsd);
  const representative = representativeListing ? {
    venue:representativeListing.venue,
    venueSymbol:representativeListing.venueSymbol,
    change24hPct:representativeListing.change24hPct,
    method:representativeListing.change24hMethod,
    status:representativeListing.change24hStatus,
    currentOpenInterestSharePct:aggregateOi > 0
      ? round((representativeListing.openInterestUsd / aggregateOi) * 100, 5)
      : null,
  } : null;
  const changes = observed.map(listing => listing.change24hPct);
  const coverageStatus = observed.length === 0
    ? 'unavailable'
    : observed.length === expectedListings ? 'full' : 'partial';
  return {
    coverageStatus:representative ? coverageStatus : 'unavailable',
    selectionMethod:PRICE_24H_SELECTION_METHOD,
    observedListings:observed.length,
    expectedListings,
    observedAt:new Date(capturedAtMs).toISOString(),
    representative,
    rangePct:{
      min:changes.length ? round(Math.min(...changes), 5) : null,
      max:changes.length ? round(Math.max(...changes), 5) : null,
    },
    reasonCode:representative
      ? null
      : observed.length ? 'PRICE_24H_REPRESENTATIVE_OI_UNAVAILABLE' : 'PRICE_24H_CHANGE_UNAVAILABLE',
  };
}

function unavailableFunding(reference, reasonCode) {
  return {
    status:'unavailable',
    venue:reference?.venue || null,
    venueSymbol:reference?.venueSymbol || null,
    ratePct:null,
    intervalHours:null,
    observedAt:null,
    reasonCode,
  };
}

function fundingContext(current, price24h, capturedAtMs) {
  const reference = price24h?.representative || null;
  if (!reference) return unavailableFunding(null, 'REFERENCE_CONTRACT_UNAVAILABLE');
  const listing = (Array.isArray(current?.listings) ? current.listings : []).find(candidate =>
    candidate.venue === reference.venue && candidate.venueSymbol === reference.venueSymbol);
  if (!listing || !Number.isFinite(listing.fundingRate) ||
      !Number.isFinite(listing.fundingIntervalHours) || listing.fundingIntervalHours <= 0) {
    return unavailableFunding(reference, 'FUNDING_UNAVAILABLE');
  }
  return {
    status:'full',
    venue:reference.venue,
    venueSymbol:reference.venueSymbol,
    ratePct:round(listing.fundingRate * 100, 8),
    intervalHours:round(listing.fundingIntervalHours, 6),
    observedAt:new Date(capturedAtMs).toISOString(),
    reasonCode:null,
  };
}

function unavailablePositioning(reference, reasonCode, { binanceMetric = false } = {}) {
  return {
    status:'unavailable',
    venue:reference?.venue || null,
    venueSymbol:reference?.venueSymbol || null,
    metric:binanceMetric ? TOP_TRADER_METRIC : null,
    scope:binanceMetric ? TOP_TRADER_SCOPE : null,
    period:binanceMetric ? TOP_TRADER_PERIOD : null,
    longShortRatio:null,
    longPositionPct:null,
    shortPositionPct:null,
    bias:'unavailable',
    observedAt:null,
    reasonCode,
  };
}

function positioningContext(price24h, evaluationStatus, injected, capturedAtMs) {
  const reference = price24h?.representative || null;
  if (!reference) return unavailablePositioning(null, 'REFERENCE_CONTRACT_UNAVAILABLE');
  if (evaluationStatus !== 'triggered') {
    return unavailablePositioning(reference, 'OI_DRAWDOWN_NOT_TRIGGERED');
  }
  if (reference.venue !== BINANCE_VENUE) {
    return unavailablePositioning(reference, 'VENUE_POSITIONING_UNSUPPORTED');
  }
  const position = normalizeInjectedTraderPosition(reference.venueSymbol, injected, capturedAtMs);
  if (position.status !== 'full') {
    return unavailablePositioning(
      reference,
      position.reasonCode || 'TOP_TRADER_UPSTREAM_UNAVAILABLE',
      { binanceMetric:true },
    );
  }
  return {
    status:'full',
    venue:reference.venue,
    venueSymbol:reference.venueSymbol,
    metric:TOP_TRADER_METRIC,
    scope:TOP_TRADER_SCOPE,
    period:TOP_TRADER_PERIOD,
    longShortRatio:position.longShortRatio,
    longPositionPct:position.longPositionPct,
    shortPositionPct:position.shortPositionPct,
    bias:position.bias,
    observedAt:position.observedAt,
    reasonCode:null,
  };
}

function marketContext(current, evaluationStatus, injected, capturedAtMs) {
  const price24h = price24hContext(current, capturedAtMs);
  return {
    version:MARKET_CONTEXT_VERSION,
    price24h,
    funding:fundingContext(current, price24h, capturedAtMs),
    positioning:positioningContext(price24h, evaluationStatus, injected, capturedAtMs),
  };
}

function alertPriority(trigger) {
  if (trigger === 'both') return 0;
  if (trigger === 'liquidation_proxy') return 1;
  return 2;
}

function injectedTraderValue(injected, venueSymbol) {
  if (injected instanceof Map) return injected.get(venueSymbol);
  if (injected && typeof injected === 'object') return injected[venueSymbol];
  return null;
}

function normalizeInjectedTraderPosition(venueSymbol, injected, nowMs) {
  const value = injectedTraderValue(injected, venueSymbol);
  if (Array.isArray(value)) return normalizeBinanceTopTraderPositions(venueSymbol, value, nowMs);
  if (!value || typeof value !== 'object') {
    return unavailableTraderPosition(venueSymbol, 'TOP_TRADER_NOT_FETCHED');
  }
  if (value.status !== 'full') {
    return unavailableTraderPosition(venueSymbol, String(value.reasonCode || 'TOP_TRADER_UPSTREAM_UNAVAILABLE'));
  }
  const timestamp = Date.parse(value.observedAt);
  return normalizeBinanceTopTraderPositions(venueSymbol, [{
    symbol:value.venueSymbol,
    longShortRatio:value.longShortRatio,
    longAccount:finiteOrNull(value.longPositionPct) === null ? null : Number(value.longPositionPct) / 100,
    shortAccount:finiteOrNull(value.shortPositionPct) === null ? null : Number(value.shortPositionPct) / 100,
    timestamp,
  }], nowMs);
}

export function buildOiLiquidationAnomalies(assets, hourlyHistory, capturedAtMs, options = {}) {
  const captured = finiteOrNull(capturedAtMs);
  if (captured === null) throw new TypeError('Invalid OI anomaly timestamp');
  const classified = classifyCurrentAssets(assets);
  const sources = options.sources && typeof options.sources === 'object' ? options.sources : {};
  const sourceRows = Object.values(sources);
  // Pure-function fixtures may omit source metadata, but production payloads
  // always provide all five venues. A Partial/Unavailable venue may still
  // contribute verified rows; it can never let the section claim Full.
  const sourceCoverageFull = sourceRows.length === 0 || sourceRows.every(source =>
    String(source?.status || '').trim().toLowerCase() === 'full');
  const conflicts = Array.isArray(options.conflicts) ? options.conflicts : [];
  const snapshotComparable = options.snapshotComparable !== false && conflicts.length === 0;
  let historyAvailable = options.historyAvailable !== false;
  let stored = emptyHistory();
  if (historyAvailable) {
    try {
      stored = normalizeOiHourlyHistory(hourlyHistory, captured);
    } catch {
      historyAvailable = false;
    }
  }
  let evaluationHistory = stored;
  if (historyAvailable) {
    try {
      evaluationHistory = mergeOiHourlyHistory(
        stored,
        compactOiHourlySnapshot(assets, captured),
        captured,
      );
    } catch {
      historyAvailable = false;
      evaluationHistory = emptyHistory();
    }
  }
  const hourRows = historyAvailable ? rowsByHour(evaluationHistory, captured) : new Map();
  let trendReadyAssets = 0;
  let drawdownReadyAssets = 0;
  let readyAssets = 0;
  const evaluations = [];
  const observedBucket = new Date(utcHour(captured)).toISOString();
  const states = classified.rows
    .filter(row => row.classification === 'eligible-incomplete')
    .map(row => {
      const state = drawdownState(row, null, observedBucket, {
        historyAvailable,
        snapshotComparable,
      });
      return {
        ...state,
        marketContext:marketContext(row, state.evaluationStatus, options.topTraderPositions, captured),
      };
    });

  for (const current of classified.rows.filter(row => row.classification === 'eligible-complete')) {
    const trend = historyAvailable && snapshotComparable
      ? completedDayEvaluation(hourRows, current, captured)
      : { ready:false, trend:'unavailable', closes:[] };
    const drawdown = historyAvailable && snapshotComparable
      ? drawdownEvaluation(hourRows, current, captured)
      : { ready:false, peak:null, peakAt:null, drawdown:null, sameCohort:null, reasonCodes:[] };
    const state = drawdownState(current, drawdown, observedBucket, {
      historyAvailable,
      snapshotComparable,
    });
    states.push({
      ...state,
      marketContext:marketContext(current, state.evaluationStatus, options.topTraderPositions, captured),
    });
    if (trend.ready) trendReadyAssets += 1;
    if (drawdown.ready) drawdownReadyAssets += 1;
    if (trend.ready && drawdown.ready) readyAssets += 1;
    const oiRising = trend.ready && trend.trend === 'rising';
    const liquidationProxy = drawdown.ready &&
      drawdown.drawdown > OI_LIQUIDATION_THRESHOLDS.liquidationProxyDropUsdExclusive;
    if (!oiRising && !liquidationProxy) continue;
    const trigger = oiRising && liquidationProxy
      ? 'both'
      : oiRising ? 'oi_rising' : 'liquidation_proxy';
    const binanceSymbols = current.listings
      .filter(listing => listing.venue === 'binance')
      .map(listing => listing.venueSymbol);
    const topTraderPositions = binanceSymbols.map(symbol =>
      normalizeInjectedTraderPosition(symbol, options.topTraderPositions, captured));
    const availableTraderPositions = topTraderPositions.filter(position => position.status === 'full').length;
    const topTraderStatus = !topTraderPositions.length || !availableTraderPositions
      ? 'unavailable'
      : availableTraderPositions === topTraderPositions.length ? 'full' : 'partial';
    evaluations.push({
      assetKey:current.assetKey,
      symbol:current.symbol,
      category:current.category,
      venues:current.venues,
      listingCount:current.listingCount,
      listings:current.listings,
      cohortFingerprint:current.cohortFingerprint,
      currentVolume24hUsd:current.currentVolume24hUsd,
      currentOpenInterestUsd:current.currentOpenInterestUsd,
      completedDailyCloses:trend.closes,
      completedDailyTrend:trend.trend,
      peak24hOpenInterestUsd:drawdown.peak,
      peak24hAt:drawdown.peakAt,
      drawdown24hUsd:drawdown.drawdown,
      trigger,
      status:'estimated',
      topTraderPositions,
      overallTraderBias:overallBias(topTraderPositions),
      fieldStatus:{
        currentVolume24hUsd:'estimated',
        currentOpenInterestUsd:'estimated',
        completedDailyCloses:trend.ready ? 'estimated' : 'unavailable',
        completedDailyTrend:trend.ready ? 'estimated' : 'unavailable',
        peak24hOpenInterestUsd:drawdown.ready ? 'estimated' : 'unavailable',
        drawdown24hUsd:drawdown.ready ? 'estimated' : 'unavailable',
        topTraderPositions:topTraderStatus,
      },
      reasonCodes:!binanceSymbols.length
        ? ['NO_BINANCE_PERP_LISTING']
        : topTraderStatus === 'full' ? [] : ['TOP_TRADER_PARTIAL_OR_UNAVAILABLE'],
    });
  }

  const ordered = evaluations.sort((left, right) =>
    alertPriority(left.trigger) - alertPriority(right.trigger) ||
    (right.drawdown24hUsd ?? -1) - (left.drawdown24hUsd ?? -1) ||
    right.currentOpenInterestUsd - left.currentOpenInterestUsd ||
    left.assetKey.localeCompare(right.assetKey));
  const counts = {
    ...classified.counts,
    alerts:ordered.length,
    oiRising:ordered.filter(row => ['oi_rising', 'both'].includes(row.trigger)).length,
    liquidationProxy:ordered.filter(row => ['liquidation_proxy', 'both'].includes(row.trigger)).length,
    both:ordered.filter(row => row.trigger === 'both').length,
    topTraderAvailable:ordered.filter(row =>
      row.topTraderPositions.some(position => position.status === 'full')).length,
  };
  const decodedStored = historyAvailable ? decodeHistory(stored, captured) : [];
  const allReady = classified.counts.completeEligibleAssets > 0 &&
    readyAssets === classified.counts.completeEligibleAssets;
  const status = !historyAvailable
    ? 'unavailable'
    : !snapshotComparable || !sourceCoverageFull || classified.counts.filterUnknown > 0 ||
        classified.counts.missingEligibleAssets > 0
      ? 'partial'
      : allReady ? 'full' : 'warming';
  const orderedStates = states.sort((left, right) => left.assetKey.localeCompare(right.assetKey));
  const stateCoverage = {
    expectedEligibleAssets:classified.counts.volumeEligibleAssets,
    returnedStates:orderedStates.length,
    complete:orderedStates.length === classified.counts.volumeEligibleAssets,
  };

  return {
    formulaVersion:OI_LIQUIDATION_FORMULA_VERSION,
    generatedAt:new Date(captured).toISOString(),
    status,
    rowLimit:RESPONSE_ROW_LIMIT,
    scope:'All identity-verified RWA perpetual canonical assets from the current five-source snapshot',
    thresholds:{ ...OI_LIQUIDATION_THRESHOLDS },
    methodology:{
      universe:'Full verified five-venue RWA perpetual universe, grouped by category:canonical identity and exact venue-instrument cohort',
      eligibility:'Current aggregate rolling-24h USD contract volume must be strictly greater than $1,000,000; incomplete exact listing cohorts fail closed',
      openInterest:'Cross-venue USD open interest is an estimate derived from exact official contract observations and current mark prices where direct USD OI is unavailable',
      threeDayTrend:'oi_rising requires strictly increasing same-cohort 23:00 UTC hourly closes on each of the three most recent completed UTC days',
      liquidationProxy:'liquidation_proxy requires a same-cohort, gap-free 24-hour series and a current USD OI decline strictly greater than $2,000,000 from that window peak',
      logic:'oi_rising OR liquidation_proxy; both is reported when both conditions hold',
      price24h:'State market context selects the exact perpetual listing with the largest current USD OI among listings with an available 24h change; same-contract funding is published when available, while the range and coverage retain cross-listing disagreement and gaps',
      topTraderPositions:'Triggered drawdown state positioning is bound to the selected price contract: exact Binance representatives can use the official 1h Top Trader Long/Short Position Ratio, while other venues remain explicitly unsupported; legacy alert-row Binance fields remain optional evidence',
      limitations:'The OI decline is a passive position-reduction/deleveraging proxy, not a trade-by-trade liquidation feed. USD OI also changes with mark price and cannot identify whether longs or shorts were liquidated.',
    },
    sources,
    coverage:{
      expectedSources:Number(options.coverage?.expectedSources) || Object.keys(sources).length,
      availableSources:Number(options.coverage?.availableSources) || 0,
      fullCatalogSources:Number(options.coverage?.fullCatalogSources) || 0,
      acceptedListings:classified.counts.perpListings,
      quarantinedListings:Number(options.coverage?.quarantinedListings) || 0,
      verifiedAssets:classified.counts.verifiedAssets,
      identityConflicts:conflicts.length,
      volumeEligibleAssets:classified.counts.volumeEligibleAssets,
      completeEligibleAssets:classified.counts.completeEligibleAssets,
      missingEligibleAssets:classified.counts.missingEligibleAssets,
      filterUnknownAssets:classified.counts.filterUnknown,
    },
    counts,
    history:{
      status:!historyAvailable
        ? 'unavailable'
        : !snapshotComparable || !sourceCoverageFull || classified.counts.filterUnknown > 0 ||
            classified.counts.missingEligibleAssets > 0
          ? 'partial'
          : allReady ? 'full' : 'warming',
      ready:historyAvailable && allReady,
      cadence:'utc-hourly-idempotent',
      storedHourlyBuckets:decodedStored.length,
      retentionHours:OI_LIQUIDATION_HISTORY_HOURS,
      requiredHourlyBuckets:OI_LIQUIDATION_THRESHOLDS.peakLookbackHours,
      requiredCompletedDays:OI_LIQUIDATION_THRESHOLDS.risingCompletedDays,
      readyAssets,
      trendReadyAssets,
      drawdownReadyAssets,
      oldestAt:decodedStored[0]?.t !== undefined ? new Date(decodedStored[0].t).toISOString() : null,
      latestAt:decodedStored.at(-1)?.t !== undefined ? new Date(decodedStored.at(-1).t).toISOString() : null,
    },
    persistence:options.persistence || null,
    stateCoverage,
    states:orderedStates,
    rows:ordered.slice(0, RESPONSE_ROW_LIMIT).map((row, index) => ({ rank:index + 1, ...row })),
  };
}

function topTraderBias(ratio) {
  if (ratio > OI_LIQUIDATION_THRESHOLDS.topTraderBullishAbove) return 'bullish';
  if (ratio < OI_LIQUIDATION_THRESHOLDS.topTraderBearishBelow) return 'bearish';
  return 'neutral';
}

export function normalizeBinanceTopTraderPositions(venueSymbol, payload, nowMs = Date.now()) {
  const expected = String(venueSymbol || '').trim().toUpperCase();
  const rows = Array.isArray(payload) ? payload : [];
  const row = rows.length === 1 ? rows[0] : null;
  if (!expected || !row || String(row.symbol || '').trim().toUpperCase() !== expected) {
    return unavailableTraderPosition(expected, 'TOP_TRADER_IDENTITY_MISMATCH');
  }
  const ratioRaw = finiteOrNull(row.longShortRatio);
  const longFraction = finiteOrNull(row.longAccount);
  const shortFraction = finiteOrNull(row.shortAccount);
  const timestamp = finiteOrNull(row.timestamp);
  if (ratioRaw === null || ratioRaw < 0 || longFraction === null || longFraction < 0 || longFraction > 1 ||
      shortFraction === null || shortFraction <= 0 || shortFraction > 1 ||
      timestamp === null || timestamp > nowMs || nowMs - timestamp > TOP_TRADER_MAX_AGE_MS) {
    return unavailableTraderPosition(expected, 'TOP_TRADER_FIELDS_INVALID');
  }
  if (Math.abs(longFraction + shortFraction - 1) > 0.002) {
    return unavailableTraderPosition(expected, 'TOP_TRADER_SHARE_SUM_INVALID');
  }
  const computedRatio = longFraction / shortFraction;
  if (Math.abs(ratioRaw - computedRatio) / Math.max(1, Math.abs(computedRatio)) > 0.01) {
    return unavailableTraderPosition(expected, 'TOP_TRADER_RATIO_INCONSISTENT');
  }
  const longShortRatio = round(ratioRaw, 4);
  return {
    venueSymbol:expected,
    status:'full',
    longShortRatio,
    longPositionPct:round(longFraction * 100, 2),
    shortPositionPct:round(shortFraction * 100, 2),
    bias:topTraderBias(longShortRatio),
    observedAt:new Date(timestamp).toISOString(),
    reasonCode:null,
  };
}

function overallBias(positions) {
  const available = positions.filter(position => position.status === 'full');
  if (!available.length) return 'unavailable';
  const biases = new Set(available.map(position => position.bias));
  return biases.size === 1 ? available[0].bias : 'mixed';
}

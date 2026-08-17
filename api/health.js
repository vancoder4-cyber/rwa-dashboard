import { assessChecks, checkResult, PRODUCTION_BASELINES } from './_lib/health.js';
import {
  LISTING_AUDIT_SCHEMA_VERSION,
  LISTING_EVENT_MAX,
  LISTING_EVENT_RETENTION_DAYS,
  LISTING_SOURCE_KEYS,
} from './_lib/listing-audit.js';
import {
  OKX_SPOT_GOLD_EXCEPTIONS,
  canonicalOkxPerpSymbol,
  canonicalOkxSpotSymbol,
  isOkxRwaPerpInstrument,
  isOkxRwaSpotInstrument,
} from './_lib/okx.js';
import { SIGNAL_SCHEMA_VERSION } from './_lib/signal-analysis.js';
import { validateUsMarketDirectoryPayload } from './_lib/us-market-directory.js';
import {
  PERP_VOLUME_ANOMALY_FORMULA_VERSION,
  PERP_VOLUME_ANOMALY_THRESHOLDS,
  PERP_VOLUME_BASELINE_DAYS,
  PERP_VOLUME_CONSECUTIVE_EXPANSION_DAYS,
  PERP_VOLUME_FREQUENCY_DAYS,
  PERP_VOLUME_HIGH_FREQUENCY_MIN_ANOMALY_DAYS,
  PERP_VOLUME_HIGH_FREQUENCY_MIN_ELIGIBLE_DAYS,
  PERP_VOLUME_HISTORY_DAYS,
} from './_lib/volume-anomaly.js';
import {
  SPOT_ANOMALY_FORMULA_VERSION,
  SPOT_ANOMALY_HISTORY_DAYS,
  SPOT_ANOMALY_HISTORY_NAMESPACE,
  SPOT_ANOMALY_SOURCE_NAMES,
  SPOT_ANOMALY_THRESHOLDS,
} from './_lib/spot-volume-price-anomaly.js';
import {
  OI_LIQUIDATION_FORMULA_VERSION,
  OI_LIQUIDATION_HISTORY_HOURS,
  OI_LIQUIDATION_HISTORY_NAMESPACE,
  OI_LIQUIDATION_THRESHOLDS,
} from './_lib/oi-liquidation-anomaly.js';
import { fetchJsonWithPolicy, fetchWithPolicy, mapWithConcurrency } from './_lib/upstream.js';

export const config = { regions: ['sin1'], maxDuration: 60 };

const REFERENCE_SYMBOLS = ['AAPL', 'XAU', 'SKHYNIX', 'MINIMAX'];
const FUNDING_PROBES = Object.freeze({
  tradexyz: 'xyz:AAPL',
  bitget: 'AAPLUSDT',
  gate: 'AAPLX_USDT',
  binance: 'AAPLUSDT',
  okx: 'AAPL-USDT-SWAP',
});
// These are reviewed lower bounds, not permanent exact allowlists. Official
// category/type metadata remains the identity gate, while the listing audit
// reports legitimate catalog growth independently.
const OKX_REVIEWED_PERP_MINIMUMS = Object.freeze({ total: 183, swap: 149, xperp: 34 });
const OKX_REVIEWED_SPOT_MINIMUMS = Object.freeze({ total: 51, uts: 48, gold: 3 });
const SIGNAL_SOURCE_KEYS = Object.freeze(['gate', 'binance', 'bitget', 'tradexyz', 'okx']);
const SIGNAL_SOURCE_STATUSES = new Set(['full', 'partial', 'unavailable']);
const SIGNAL_SNAPSHOT_STATUSES = new Set(['full', 'partial']);
const VOLUME_ANOMALY_STATUSES = new Set(['full', 'partial', 'warming', 'unavailable']);
const RWA_SIGNAL_CATEGORIES = new Set(['equity', 'etf', 'commodity', 'index', 'fx', 'bond', 'pre-ipo']);
const SIGNAL_VENUES = new Set(['gate', 'binance', 'bitget', 'tradexyz', 'okx']);
const SPOT_ANOMALY_VENUES = new Set(['gate', 'kraken', 'bitget', 'binance', 'okx']);
const SPOT_ANOMALY_FIELD_STATUSES = new Set(['full', 'partial', 'estimated', 'unavailable']);
const SPOT_ANOMALY_SECTION_STATUSES = new Set(['full', 'partial', 'warming', 'unavailable']);
const SPOT_ANOMALY_PERSISTENCE_STATUSES = new Set(['partial', 'unavailable']);
const SPOT_ANOMALY_SOURCE_STATUSES = new Set(['full', 'partial', 'unavailable']);
const SPOT_ANOMALY_WRITE_STATUSES = new Set([
  'stored',
  'read-only',
  'skipped-incomplete-sources',
  'unavailable',
]);
const SPOT_ANOMALY_USD_QUOTES = new Set(['USD', 'USDT']);
const OI_LIQUIDATION_SECTION_STATUSES = new Set(['full', 'partial', 'warming', 'unavailable']);
const OI_LIQUIDATION_FIELD_STATUSES = new Set(['full', 'partial', 'estimated', 'unavailable']);
const OI_LIQUIDATION_SOURCE_STATUSES = new Set(['full', 'partial', 'unavailable']);
const OI_LIQUIDATION_PERSISTENCE_STATUSES = new Set(['partial', 'unavailable']);
const OI_LIQUIDATION_EVALUATION_STATUSES = new Set(['triggered', 'clear', 'warming', 'unavailable']);
const OI_PRICE_24H_SELECTION_METHOD = 'largest-current-oi-listing-with-available-change';
const OI_TOP_TRADER_METRIC = 'top-trader-position-ratio';
const OI_TOP_TRADER_SCOPE = 'top-20%-by-margin-balance-position-ratio';
const OI_MARKET_CONTEXT_VERSION = 'rwa-oi-market-context/v2';
const OI_LIQUIDATION_WRITE_STATUSES = new Set([
  'stored',
  'read-only',
  'skipped-incomplete-sources',
  'unavailable',
]);
const OI_CATALOG_BLOCKER = /(?:IDENTITY|INSTRUMENTS_UNAVAILABLE|CATALOG|UPSTREAM_COVERAGE)/;
const SIGNAL_SNAPSHOT_MAX_AGE_MS = 2 * 60 * 60 * 1_000;
const SIGNAL_SNAPSHOT_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
const SIGNAL_VOLUME_DAILY_NAMESPACE = 'rwa-signal-volume-daily-v1';
const UTC_DAY_MS = 24 * 60 * 60 * 1_000;
const UTC_HOUR_MS = 60 * 60 * 1_000;

function deploymentBaseUrl(req) {
  const forwarded = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').toLowerCase();
  if (/^[a-z0-9.-]+\.vercel\.app$/.test(forwarded)) return `https://${forwarded}`;
  const deployment = process.env.VERCEL_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return `https://${deployment || 'avenir-rwa-analyst.vercel.app'}`;
}

async function probePage(baseUrl) {
  const startedAt = Date.now();
  try {
    const response = await fetchWithPolicy(`${baseUrl}/`, { method: 'HEAD' }, { timeoutMs: 5000, retries: 0 });
    const valid = response.ok && String(response.headers.get('content-type') || '').includes('text/html');
    return checkResult('production-page', valid ? 'pass' : 'fail', {
      latencyMs: Date.now() - startedAt,
      httpStatus: response.status,
      reason: valid ? null : 'Dashboard shell did not return HTML',
    }, { critical: true });
  } catch (error) {
    return checkResult('production-page', 'fail', { latencyMs: Date.now() - startedAt, reason: error.message }, { critical: true });
  }
}

async function probeReferences(baseUrl) {
  const startedAt = Date.now();
  try {
    const payload = await fetchJsonWithPolicy(
      `${baseUrl}/api/reference-prices?symbols=${REFERENCE_SYMBOLS.join(',')}`,
      {},
      { timeoutMs: 20000, retries: 0 },
    );
    const rows = Object.values(payload?.rows || {});
    const unavailable = rows.filter(row => row.status === 'unavailable').length;
    const fxConverted = rows.filter(row => row.nativeCurrency && row.nativeCurrency !== 'USD' && row.currency === 'USD').length;
    const valid = rows.length === REFERENCE_SYMBOLS.length && unavailable === 0 && fxConverted >= 2;
    return checkResult('reference-prices', valid ? 'pass' : 'fail', {
      latencyMs: Date.now() - startedAt,
      requested: REFERENCE_SYMBOLS.length,
      returned: rows.length,
      full: rows.filter(row => row.status === 'full').length,
      estimated: rows.filter(row => row.status === 'estimated').length,
      unavailable,
      fxConverted,
      reason: valid ? null : 'Reference coverage or FX conversion is incomplete',
    }, { critical: true });
  } catch (error) {
    return checkResult('reference-prices', 'fail', { latencyMs: Date.now() - startedAt, reason: error.message }, { critical: true });
  }
}

export function validateUsMarketDirectory(payload) {
  return validateUsMarketDirectoryPayload(payload);
}

export async function probeUsMarketDirectory(baseUrl) {
  const startedAt = Date.now();
  try {
    const payload = await fetchJsonWithPolicy(
      `${baseUrl}/api/us-market-directory`,
      {},
      { timeoutMs:25_000, retries:0 },
    );
    const validation = validateUsMarketDirectory(payload);
    return checkResult('us-market-directory', validation.valid ? 'pass' : 'fail', {
      latencyMs:Date.now() - startedAt,
      asOf:payload?.asOf || null,
      ...validation,
    }, { critical:true });
  } catch (error) {
    return checkResult('us-market-directory', 'fail', {
      latencyMs:Date.now() - startedAt,
      reason:error.message,
    }, { critical:true });
  }
}

export function validateListingAuditSnapshot(payload, now = Date.now()) {
  const generatedAtMs = Date.parse(payload?.generatedAt);
  const ageHours = Number.isFinite(generatedAtMs) ? (now - generatedAtMs) / 3_600_000 : null;
  const expectedSources = Number(payload?.coverage?.expectedSources);
  const availableSources = Number(payload?.coverage?.availableSources);
  const unavailableSources = Number(payload?.coverage?.unavailableSources);
  const sourceKeys = Array.isArray(payload?.sources)
    ? payload.sources.map(source => String(source?.sourceKey || ''))
    : [];
  const exactSourceKeys = sourceKeys.length === LISTING_SOURCE_KEYS.length &&
    new Set(sourceKeys).size === LISTING_SOURCE_KEYS.length &&
    LISTING_SOURCE_KEYS.every(sourceKey => sourceKeys.includes(sourceKey));
  const availableSourceTimestampsFresh = Array.isArray(payload?.sources) && payload.sources.every(source => {
    if (source?.status === 'unavailable') return true;
    const observedAt = Date.parse(source?.observedAt);
    const sourceAgeHours = Number.isFinite(observedAt) ? (now - observedAt) / 3_600_000 : null;
    return sourceAgeHours !== null && sourceAgeHours >= -0.1 && sourceAgeHours <= 36;
  });

  const history = payload?.history;
  const historyRetentionDays = history?.retentionDays;
  const historyMaxEvents = history?.maxEvents;
  const historyDroppedAtLeast = history?.droppedAtLeast;
  const historyDroppedThrough = history?.droppedThrough ?? null;
  const historyRetainedFrom = history?.retainedFrom ?? null;
  const historyTruncated = history?.truncated === true;
  const historyFieldsPresent = Boolean(history) &&
    ['retentionDays', 'maxEvents', 'truncated', 'droppedAtLeast', 'droppedThrough', 'retainedFrom']
      .every(key => Object.prototype.hasOwnProperty.call(history, key));
  const historyStatusCoherent = !historyTruncated || payload?.status !== 'full';
  const validNullableTimestamp = value => value === null ||
    (typeof value === 'string' && Number.isFinite(Date.parse(value)));
  const historyContractValid = historyFieldsPresent && historyStatusCoherent &&
    Number.isInteger(historyRetentionDays) && historyRetentionDays === LISTING_EVENT_RETENTION_DAYS &&
    Number.isInteger(historyMaxEvents) && historyMaxEvents === LISTING_EVENT_MAX &&
    typeof history.truncated === 'boolean' &&
    Number.isInteger(historyDroppedAtLeast) && historyDroppedAtLeast >= 0 &&
    validNullableTimestamp(historyDroppedThrough) && validNullableTimestamp(historyRetainedFrom) &&
    (!historyTruncated
      ? historyDroppedAtLeast === 0 && historyDroppedThrough === null
      : historyDroppedAtLeast > 0 && historyDroppedThrough !== null) &&
    (!Array.isArray(payload?.events) || payload.events.length <= historyMaxEvents);
  const contractValid = payload?.schemaVersion === LISTING_AUDIT_SCHEMA_VERSION &&
    Array.isArray(payload?.sources) && Array.isArray(payload?.events) && Array.isArray(payload?.pendingReviews) &&
    expectedSources === LISTING_SOURCE_KEYS.length && exactSourceKeys && historyContractValid;
  const fresh = ageHours !== null && ageHours >= -0.1 && ageHours <= 36;
  const complete = contractValid && fresh && availableSourceTimestampsFresh && !historyTruncated &&
    availableSources === LISTING_SOURCE_KEYS.length && unavailableSources === 0;
  const status = !contractValid || !fresh || !availableSourceTimestampsFresh
    ? 'fail'
    : historyTruncated ? 'fail'
      : complete && payload.status === 'full' ? 'pass'
        : availableSources > 0 ? 'warn' : 'fail';
  return {
    status,
    contractValid,
    fresh,
    complete,
    ageHours,
    expectedSources,
    availableSources,
    unavailableSources,
    exactSourceKeys,
    availableSourceTimestampsFresh,
    historyContractValid,
    historyTruncated,
    historyStatusCoherent,
    historyRetentionDays,
    historyMaxEvents,
    historyDroppedAtLeast,
    historyDroppedThrough,
    historyRetainedFrom,
    reason: status === 'pass'
      ? null
      : !contractValid ? 'Listing audit response or history contract is invalid'
        : !fresh || !availableSourceTimestampsFresh ? 'No successful listing audit snapshot within 36 hours'
          : historyTruncated ? 'Listing audit event history exceeded its safety limit and is truncated'
            : 'Listing audit is warming or one or more venue catalogs are unavailable',
  };
}

async function probeListingAudit(baseUrl) {
  const startedAt = Date.now();
  try {
    const payload = await fetchJsonWithPolicy(
      `${baseUrl}/api/listing-changes`,
      {},
      { timeoutMs: 8_000, retries: 0 },
    );
    const validation = validateListingAuditSnapshot(payload);
    return checkResult('daily-listing-audit', validation.status, {
      latencyMs: Date.now() - startedAt,
      snapshotStatus: payload?.status || 'unavailable',
      generatedAt: payload?.generatedAt || null,
      ageHours: validation.ageHours === null ? null : Number(validation.ageHours.toFixed(2)),
      expectedSources: validation.expectedSources,
      availableSources: validation.availableSources,
      unavailableSources: validation.unavailableSources,
      exactSourceKeys: validation.exactSourceKeys,
      availableSourceTimestampsFresh: validation.availableSourceTimestampsFresh,
      historyContractValid: validation.historyContractValid,
      historyTruncated: validation.historyTruncated,
      historyStatusCoherent: validation.historyStatusCoherent,
      historyRetentionDays: validation.historyRetentionDays,
      historyMaxEvents: validation.historyMaxEvents,
      historyDroppedAtLeast: validation.historyDroppedAtLeast,
      historyDroppedThrough: validation.historyDroppedThrough,
      historyRetainedFrom: validation.historyRetainedFrom,
      newListings: Number(payload?.counts?.new) || 0,
      relisted: Number(payload?.counts?.relisted) || 0,
      reviewRequired: Number(payload?.counts?.reviewRequired) || 0,
      reason: validation.reason,
    });
  } catch (error) {
    return checkResult('daily-listing-audit', 'fail', {
      latencyMs: Date.now() - startedAt,
      reason: error.message,
    });
  }
}

function signalCategory(value) {
  return String(value || '').trim().toLowerCase();
}

function exactSignalSources(payload) {
  if (!payload?.sources || typeof payload.sources !== 'object' || Array.isArray(payload.sources)) return false;
  const sourceKeys = Object.keys(payload.sources);
  if (sourceKeys.length !== SIGNAL_SOURCE_KEYS.length || new Set(sourceKeys).size !== SIGNAL_SOURCE_KEYS.length) {
    return false;
  }
  return SIGNAL_SOURCE_KEYS.every(sourceKey => {
    const source = payload.sources[sourceKey];
    return sourceKeys.includes(sourceKey) && source && typeof source === 'object' &&
      SIGNAL_SOURCE_STATUSES.has(String(source.status || '').toLowerCase()) &&
      Number.isInteger(source.listingCount) && source.listingCount >= 0;
  });
}

function volumeAnomalyRowValid(row) {
  const level = String(row?.level || '').trim().toLowerCase();
  const status = String(row?.status || '').trim().toLowerCase();
  const category = signalCategory(row?.category);
  const symbol = String(row?.symbol || '').trim().toUpperCase();
  const ratio = row?.ratio7d;
  const currentVolume = row?.currentVolumeUsd;
  const averageVolume = row?.average7dVolumeUsd;
  const expectedRatio = Number.isFinite(currentVolume) && Number.isFinite(averageVolume) && averageVolume > 0
    ? Math.round((currentVolume / averageVolume) * 10_000) / 10_000
    : null;
  const rank = row?.rank;
  const venues = Array.isArray(row?.venues)
    ? row.venues.map(venue => String(venue || '').trim().toLowerCase())
    : [];
  const baseline = row?.baseline;
  const frequency = row?.frequency30d;
  const flags = Array.isArray(row?.flags) ? row.flags.map(flag => String(flag || '')) : null;
  const expectedHighFrequency = frequency?.eligibleDays >= PERP_VOLUME_HIGH_FREQUENCY_MIN_ELIGIBLE_DAYS &&
    frequency?.anomalyDays >= PERP_VOLUME_HIGH_FREQUENCY_MIN_ANOMALY_DAYS;
  if (!['high', 'medium', 'down'].includes(level) || status !== 'estimated' ||
      !RWA_SIGNAL_CATEGORIES.has(category) || !/^[A-Z0-9._-]{1,40}$/.test(symbol) ||
      !Number.isFinite(ratio) || ratio < 0 || !Number.isFinite(currentVolume) || currentVolume < 0 ||
      !Number.isFinite(averageVolume) || averageVolume <= 0 || ratio !== expectedRatio ||
      !Number.isInteger(rank) || rank <= 0 ||
      !venues.length || new Set(venues).size !== venues.length || venues.some(venue => !SIGNAL_VENUES.has(venue)) ||
      !Number.isInteger(row?.listingCount) || row.listingCount < venues.length ||
      row?.coverageStatus !== 'full' ||
      baseline?.status !== 'full' || baseline?.cohortStable !== true ||
      baseline?.observedDays !== PERP_VOLUME_BASELINE_DAYS ||
      baseline?.expectedDays !== PERP_VOLUME_BASELINE_DAYS ||
      !frequency || !['full', 'partial', 'warming'].includes(String(frequency.status || '').toLowerCase()) ||
      !Number.isInteger(frequency.eligibleDays) || frequency.eligibleDays < 0 ||
      frequency.eligibleDays > PERP_VOLUME_FREQUENCY_DAYS ||
      !Number.isInteger(frequency.anomalyDays) || frequency.anomalyDays < 0 ||
      frequency.anomalyDays > frequency.eligibleDays || frequency.expectedDays !== PERP_VOLUME_FREQUENCY_DAYS ||
      !Number.isInteger(frequency.highDays) || frequency.highDays < 0 ||
      !Number.isInteger(frequency.mediumDays) || frequency.mediumDays < 0 ||
      !Number.isInteger(frequency.downDays) || frequency.downDays < 0 ||
      frequency.highDays + frequency.mediumDays + frequency.downDays !== frequency.anomalyDays ||
      !Number.isInteger(frequency.expansionDays) ||
      frequency.expansionDays !== frequency.highDays + frequency.mediumDays ||
      (frequency.status === 'full') !== (frequency.eligibleDays === PERP_VOLUME_FREQUENCY_DAYS) ||
      (frequency.status === 'warming') !== (frequency.eligibleDays === 0) ||
      typeof frequency.highFrequency !== 'boolean' || frequency.highFrequency !== expectedHighFrequency ||
      !Number.isInteger(frequency.consecutiveExpansionDays) || frequency.consecutiveExpansionDays < 0 ||
      frequency.consecutiveExpansionDays > PERP_VOLUME_FREQUENCY_DAYS || !flags ||
      flags.some(flag => !['CONSECUTIVE_EXPANSION', 'HIGH_FREQUENCY_ANOMALY'].includes(flag)) ||
      flags.includes('CONSECUTIVE_EXPANSION') !==
        (frequency.consecutiveExpansionDays >= PERP_VOLUME_CONSECUTIVE_EXPANSION_DAYS) ||
      flags.includes('HIGH_FREQUENCY_ANOMALY') !== frequency.highFrequency) {
    return false;
  }
  if (level === 'high') return ratio >= PERP_VOLUME_ANOMALY_THRESHOLDS.high;
  if (level === 'medium') {
    return ratio >= PERP_VOLUME_ANOMALY_THRESHOLDS.medium &&
      ratio < PERP_VOLUME_ANOMALY_THRESHOLDS.high;
  }
  return ratio <= PERP_VOLUME_ANOMALY_THRESHOLDS.down;
}

function exactSpotAnomalySources(section) {
  const sources = section?.sources;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) return false;
  const sourceKeys = Object.keys(sources);
  if (sourceKeys.length !== SPOT_ANOMALY_SOURCE_NAMES.length ||
      new Set(sourceKeys).size !== sourceKeys.length ||
      !SPOT_ANOMALY_SOURCE_NAMES.every(sourceKey => sourceKeys.includes(sourceKey))) {
    return false;
  }
  return SPOT_ANOMALY_SOURCE_NAMES.every(sourceKey => {
    const source = sources[sourceKey];
    return source && typeof source === 'object' &&
      SPOT_ANOMALY_SOURCE_STATUSES.has(String(source.status || '').toLowerCase()) &&
      Number.isInteger(source.listingCount) && source.listingCount >= 0 &&
      Number.isInteger(source.marketFieldCount) && source.marketFieldCount >= 0 &&
      source.marketFieldCount <= source.listingCount &&
      Number.isInteger(source.priceFieldCount) && source.priceFieldCount >= 0 &&
      source.priceFieldCount <= source.listingCount &&
      (sourceKey !== 'kraken' || source.priceFieldCount === 0) &&
      (source.status !== 'full' || (source.listingCount > 0 &&
        source.marketFieldCount === source.listingCount &&
        (sourceKey === 'kraken' || source.priceFieldCount === source.listingCount))) &&
      Array.isArray(source.warnings) && source.warnings.every(warning => typeof warning === 'string');
  });
}

function exactUtcDayMs(value) {
  if (typeof value !== 'string') return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) && parsed % UTC_DAY_MS === 0 ? parsed : null;
}

function spotAnomalyPerpCoverageValid(row) {
  const coverage = row?.perpCoverage;
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) return false;
  const status = String(coverage.status || '').toLowerCase();
  if (!['full', 'partial', 'unavailable'].includes(status)) return false;
  if (![true, false, null].includes(coverage.listed) || !Array.isArray(coverage.contracts)) return false;
  const contractKeys = [];
  for (const contract of coverage.contracts) {
    const venue = String(contract?.venue || '').toLowerCase();
    const venueSymbol = String(contract?.venueSymbol || '');
    const instrumentType = String(contract?.instrumentType || '');
    if (!SIGNAL_VENUES.has(venue) ||
        !/^[A-Z0-9][A-Z0-9._:/-]{0,79}$/.test(venueSymbol) ||
        !/^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,39}$/.test(instrumentType)) return false;
    contractKeys.push(`${venue}:${venueSymbol}`);
  }
  if (new Set(contractKeys).size !== contractKeys.length) return false;
  if (coverage.listed === true) return coverage.contracts.length > 0;
  if (coverage.listed === false) return status === 'full' && coverage.contracts.length === 0;
  return status !== 'full' && coverage.contracts.length === 0;
}

function spotAnomalyRowValid(row, sources) {
  const category = signalCategory(row?.category);
  const symbol = String(row?.symbol || '').trim().toUpperCase();
  const venue = String(row?.venue || '').trim().toLowerCase();
  const venueSymbol = String(row?.venueSymbol || '').trim().toUpperCase();
  const quote = String(row?.quote || '').trim().toUpperCase();
  const currentVolume = row?.currentVolumeUsd;
  const yesterdayVolume = row?.yesterdayVolumeUsd;
  const ratio = row?.volumeRatio;
  const priceChange = row?.priceChange24hPct;
  const volumeComparable = Number.isFinite(yesterdayVolume) && yesterdayVolume > 0;
  const expectedRatio = volumeComparable
    ? Math.round((currentVolume / yesterdayVolume) * 10_000) / 10_000
    : null;
  const ratioCoherent = expectedRatio === null
    ? ratio === null
    : Number.isFinite(ratio) && Math.abs(ratio - expectedRatio) <= 0.0001;
  const expectedVolumeTriggered = Number.isFinite(ratio) && ratio >= SPOT_ANOMALY_THRESHOLDS.volumeRatio;
  const expectedPriceTriggered = Number.isFinite(priceChange) &&
    priceChange >= SPOT_ANOMALY_THRESHOLDS.priceRisePct;
  const expectedTrigger = expectedVolumeTriggered && expectedPriceTriggered
    ? 'both'
    : expectedVolumeTriggered ? 'volume_spike' : expectedPriceTriggered ? 'price_surge' : null;
  const fieldStatus = row?.fieldStatus;
  const rowStatus = String(row?.status || '').toLowerCase();
  const reasonCodes = row?.reasonCodes;
  const currentVolumeStatus = String(fieldStatus?.currentVolume || '').toLowerCase();
  const yesterdayVolumeStatus = String(fieldStatus?.yesterdayVolume || '').toLowerCase();
  const volumeRatioStatus = String(fieldStatus?.volumeRatio || '').toLowerCase();
  const priceChangeStatus = String(fieldStatus?.priceChange || '').toLowerCase();
  const perpStatus = String(row?.perpCoverage?.status || '').toLowerCase();
  const expectedRowStatus = String(sources?.[venue]?.status || '').toLowerCase() !== 'full' || perpStatus !== 'full'
    ? 'partial'
    : expectedVolumeTriggered ? 'estimated' : 'full';
  const expectedReasonCodes = [
    ...(expectedVolumeTriggered ? ['VOLUME_SPIKE'] : []),
    ...(expectedPriceTriggered ? ['PRICE_SURGE'] : []),
    ...(yesterdayVolume === 0 ? ['ZERO_PRIOR_VOLUME'] : []),
    ...(perpStatus !== 'full' ? ['PERP_COVERAGE_INCOMPLETE'] : []),
  ];

  if (!Number.isInteger(row?.rank) || row.rank <= 0 ||
      !RWA_SIGNAL_CATEGORIES.has(category) || !/^[A-Z0-9][A-Z0-9.-]{0,39}$/.test(symbol) ||
      !SPOT_ANOMALY_VENUES.has(venue) || !/^[A-Z0-9][A-Z0-9._:/-]{0,79}$/.test(venueSymbol) ||
      !SPOT_ANOMALY_USD_QUOTES.has(quote) ||
      row?.listingKey !== `spot:${venue}:${venueSymbol}` || row?.assetKey !== `${category}:${symbol}` ||
      !Number.isFinite(currentVolume) || currentVolume < SPOT_ANOMALY_THRESHOLDS.minCurrentVolumeUsd ||
      !(yesterdayVolume === null || (Number.isFinite(yesterdayVolume) && yesterdayVolume >= 0)) ||
      !(priceChange === null || Number.isFinite(priceChange)) || !ratioCoherent ||
      row?.volumeTriggered !== expectedVolumeTriggered || row?.priceTriggered !== expectedPriceTriggered ||
      row?.trigger !== expectedTrigger || expectedTrigger === null ||
      !SPOT_ANOMALY_FIELD_STATUSES.has(rowStatus) || rowStatus !== expectedRowStatus ||
      !fieldStatus || typeof fieldStatus !== 'object' || Array.isArray(fieldStatus) ||
      !['full', 'estimated'].includes(currentVolumeStatus) ||
      yesterdayVolumeStatus !== (yesterdayVolume === null ? 'unavailable' : 'estimated') ||
      volumeRatioStatus !== (ratio === null ? 'unavailable' : 'estimated') ||
      priceChangeStatus !== (priceChange === null ? 'unavailable' : 'full') ||
      String(fieldStatus.perpCoverage || '').toLowerCase() !== String(row?.perpCoverage?.status || '').toLowerCase() ||
      !spotAnomalyPerpCoverageValid(row) || !Array.isArray(reasonCodes) ||
      new Set(reasonCodes).size !== reasonCodes.length ||
      reasonCodes.some(code => typeof code !== 'string' || !/^[A-Z0-9_]{2,80}$/.test(code)) ||
      reasonCodes.length !== expectedReasonCodes.length ||
      expectedReasonCodes.some(code => !reasonCodes.includes(code))) {
    return false;
  }
  return venue !== 'kraken' || (priceChange === null && fieldStatus.priceChange === 'unavailable' &&
    row.priceTriggered === false && row.trigger !== 'price_surge' && row.trigger !== 'both');
}

function validateSpotVolumePriceAnomalies(section, generatedAtMs) {
  const status = String(section?.status || '').toLowerCase();
  const formulaValid = section?.formulaVersion === SPOT_ANOMALY_FORMULA_VERSION;
  const generatedAt = Date.parse(section?.generatedAt);
  const timestampValid = Number.isFinite(generatedAt) && Number.isFinite(generatedAtMs) &&
    Math.abs(generatedAt - generatedAtMs) <= 1_000;
  const thresholds = section?.thresholds;
  const thresholdsValid = thresholds?.volumeRatio === SPOT_ANOMALY_THRESHOLDS.volumeRatio &&
    thresholds?.priceRisePct === SPOT_ANOMALY_THRESHOLDS.priceRisePct &&
    thresholds?.minCurrentVolumeUsd === SPOT_ANOMALY_THRESHOLDS.minCurrentVolumeUsd &&
    String(thresholds?.logic || '').toLowerCase() === 'or';
  const methodology = section?.methodology;
  const methodologyValid = methodology && typeof methodology === 'object' && !Array.isArray(methodology) &&
    methodology.grain === 'exact-venue-instrument' &&
    ['currentVolume', 'priorVolume', 'volumeComparison', 'priceChange', 'krakenPriceChange']
      .every(key => typeof methodology[key] === 'string' && methodology[key].length > 0);
  const sourcesValid = exactSpotAnomalySources(section);
  const sourceValues = sourcesValid ? SPOT_ANOMALY_SOURCE_NAMES.map(key => section.sources[key]) : [];
  const observedAvailableSources = sourceValues.filter(source => source.status !== 'unavailable').length;
  const observedFullSources = sourceValues.filter(source => source.status === 'full').length;
  const observedVerifiedListings = sourceValues.reduce((sum, source) => sum + source.listingCount, 0);
  const coverage = section?.coverage;
  const coverageCountKeys = [
    'verifiedListings', 'quarantinedListings', 'identityConflicts', 'volumeAvailableListings',
    'priorVolumeAvailableListings', 'priceAvailableListings', 'liquidityEligibleListings',
    'volumeComparableListings', 'priceComparableListings',
  ];
  const coverageCountsValid = coverageCountKeys.every(key => Number.isInteger(coverage?.[key]) && coverage[key] >= 0);
  const coverageValid = coverageCountsValid && coverage?.expectedSources === SPOT_ANOMALY_SOURCE_NAMES.length &&
    coverage?.availableSources === observedAvailableSources && coverage?.fullSources === observedFullSources &&
    coverage?.verifiedListings + coverage?.quarantinedListings === observedVerifiedListings &&
    coverage.volumeAvailableListings <= coverage.verifiedListings &&
    coverage.priorVolumeAvailableListings <= coverage.volumeAvailableListings &&
    coverage.priceAvailableListings <= coverage.verifiedListings &&
    coverage.liquidityEligibleListings <= coverage.volumeAvailableListings &&
    coverage.volumeComparableListings <= coverage.liquidityEligibleListings &&
    coverage.priceComparableListings <= coverage.liquidityEligibleListings;
  const spotIdentityConflicts = Number.isInteger(coverage?.identityConflicts) ? coverage.identityConflicts : null;
  const identityConflict = spotIdentityConflicts !== null && spotIdentityConflicts > 0;

  const rows = Array.isArray(section?.rows) ? section.rows : null;
  const invalidRows = rows ? rows.filter(row => !spotAnomalyRowValid(row, section?.sources)) : [];
  const ranks = rows ? rows.map(row => row?.rank) : [];
  const listingKeys = rows ? rows.map(row => row?.listingKey) : [];
  const rowsValid = rows !== null && invalidRows.length === 0 && rows.length <= 100 &&
    new Set(listingKeys).size === listingKeys.length &&
    new Set(ranks).size === ranks.length && ranks.every((rank, index) => rank === index + 1);
  const observedRowCounts = rows ? {
    volumeSpike:rows.filter(row => row?.volumeTriggered === true).length,
    priceSurge:rows.filter(row => row?.priceTriggered === true).length,
    both:rows.filter(row => row?.trigger === 'both').length,
    perpListed:rows.filter(row => row?.perpCoverage?.listed === true).length,
  } : null;
  const counts = section?.counts;
  const countKeys = ['alerts', 'volumeSpike', 'priceSurge', 'both', 'perpListed'];
  const declaredCountsValid = countKeys.every(key => Number.isInteger(counts?.[key]) && counts[key] >= 0) &&
    counts.alerts === counts.volumeSpike + counts.priceSurge - counts.both &&
    counts.both <= Math.min(counts.volumeSpike, counts.priceSurge) && counts.perpListed <= counts.alerts;
  const rowCountsValid = observedRowCounts !== null && rows.length === Math.min(counts?.alerts ?? -1, 100) &&
    ['volumeSpike', 'priceSurge', 'both', 'perpListed'].every(key =>
      observedRowCounts[key] <= counts[key] && (counts.alerts > 100 || observedRowCounts[key] === counts[key]));
  const countsValid = declaredCountsValid && rowCountsValid &&
    Number.isInteger(counts?.filteredLowLiquidity) && counts.filteredLowLiquidity >= 0 &&
    Number.isInteger(counts?.filterUnknown) && counts.filterUnknown >= 0 &&
    coverageValid && counts.filteredLowLiquidity + counts.filterUnknown +
      coverage.liquidityEligibleListings === coverage.verifiedListings &&
    counts.alerts <= coverage.liquidityEligibleListings;

  const generatedDay = Number.isFinite(generatedAtMs)
    ? Math.floor(generatedAtMs / UTC_DAY_MS) * UTC_DAY_MS
    : null;
  const history = section?.history;
  const historyStatus = String(history?.status || '').toLowerCase();
  const storedDays = history?.storedDays;
  const priorDayMs = history?.priorDay === null ? null : exactUtcDayMs(history?.priorDay);
  const oldestAtMs = history?.oldestAt === null ? null : exactUtcDayMs(history?.oldestAt);
  const newestAtMs = history?.newestAt === null ? null : exactUtcDayMs(history?.newestAt);
  const emptyHistory = storedDays === 0 && history?.priorDay === null &&
    history?.oldestAt === null && history?.newestAt === null;
  const populatedHistory = Number.isInteger(storedDays) && storedDays > 0 &&
    oldestAtMs !== null && newestAtMs !== null && oldestAtMs <= newestAtMs && newestAtMs <= generatedDay &&
    oldestAtMs >= generatedDay - (SPOT_ANOMALY_HISTORY_DAYS - 1) * UTC_DAY_MS &&
    newestAtMs - oldestAtMs >= (storedDays - 1) * UTC_DAY_MS;
  const priorDayValid = history?.priorDay === null || priorDayMs === generatedDay - UTC_DAY_MS;
  const historyValid = history && SPOT_ANOMALY_SECTION_STATUSES.has(historyStatus) &&
    history.namespace === SPOT_ANOMALY_HISTORY_NAMESPACE && history.cadence === 'utc-daily-sealed' &&
    history.retentionDays === SPOT_ANOMALY_HISTORY_DAYS && Number.isInteger(storedDays) &&
    storedDays >= 0 && storedDays <= SPOT_ANOMALY_HISTORY_DAYS && (emptyHistory || populatedHistory) &&
    priorDayValid && (historyStatus !== 'full' || priorDayMs !== null);

  const persistence = section?.persistence;
  const persistenceStatus = String(persistence?.status || '').toLowerCase();
  const writeStatus = String(persistence?.writeStatus || '').toLowerCase();
  const persistenceReadStateValid =
    (persistenceStatus === 'partial' && writeStatus === 'read-only' && persistence?.error === null) ||
    (persistenceStatus === 'unavailable' && writeStatus === 'unavailable' &&
      typeof persistence?.error === 'string' && persistence.error.length > 0);
  const persistenceValid = persistence?.mode === 'vercel-runtime-cache' &&
    SPOT_ANOMALY_PERSISTENCE_STATUSES.has(persistenceStatus) &&
    persistence?.namespace === SPOT_ANOMALY_HISTORY_NAMESPACE &&
    persistence?.writer?.requested === false && persistence?.writer?.succeeded === null &&
    SPOT_ANOMALY_WRITE_STATUSES.has(writeStatus) && persistenceReadStateValid;

  const statusValid = SPOT_ANOMALY_SECTION_STATUSES.has(status);
  const allSourcesFull = sourcesValid && observedFullSources === SPOT_ANOMALY_SOURCE_NAMES.length;
  const statusCoherent = statusValid &&
    (status !== 'full' || (allSourcesFull && !identityConflict && historyStatus === 'full' &&
      counts?.filterUnknown === 0 &&
      coverage?.volumeComparableListings === coverage?.liquidityEligibleListings &&
      coverage?.priceComparableListings === coverage?.liquidityEligibleListings)) &&
    (status !== 'warming' || historyStatus === 'warming') &&
    (status !== 'unavailable' || rows?.length === 0);
  const cryptoCategoryCount = rows
    ? rows.filter(row => !RWA_SIGNAL_CATEGORIES.has(signalCategory(row?.category))).length
    : 0;
  const contractValid = Boolean(section) && formulaValid && timestampValid && thresholdsValid &&
    methodologyValid && sourcesValid && coverageValid && rowsValid && countsValid && historyValid &&
    persistenceValid && statusCoherent && cryptoCategoryCount === 0;
  return {
    contractValid,
    status,
    formulaValid,
    timestampValid,
    thresholdsValid,
    methodologyValid,
    sourcesValid,
    allSourcesFull,
    coverageValid,
    countsValid,
    historyValid,
    persistenceValid,
    statusCoherent,
    identityConflicts:spotIdentityConflicts,
    identityConflict,
    rows:rows?.length ?? null,
    invalidRows:invalidRows.length,
    cryptoCategoryCount,
  };
}

function exactOiLiquidationSources(section) {
  const sources = section?.sources;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) return false;
  const keys = Object.keys(sources);
  if (keys.length !== SIGNAL_SOURCE_KEYS.length || new Set(keys).size !== keys.length ||
      !SIGNAL_SOURCE_KEYS.every(key => keys.includes(key))) return false;
  return SIGNAL_SOURCE_KEYS.every(key => {
    const source = sources[key];
    const status = String(source?.status || '').toLowerCase();
    const listingCount = source?.listingCount;
    const oiCount = source?.openInterestFieldCount;
    const volumeCount = source?.volumeFieldCount;
    const warnings = Array.isArray(source?.warnings) ? source.warnings : null;
    const hasCatalogBlocker = warnings?.some(warning =>
      OI_CATALOG_BLOCKER.test(String(warning).toUpperCase())) === true;
    const fullFields = listingCount > 0 && oiCount === listingCount && volumeCount === listingCount;
    // Complete observed fields do not make a source Full when its official
    // catalog or identity coverage is blocked. Those are separate claims.
    const partialFields = listingCount > 0 && (oiCount > 0 || volumeCount > 0) &&
      (!fullFields || hasCatalogBlocker);
    const unavailableFields = oiCount === 0 && volumeCount === 0;
    const baseValid = source && typeof source === 'object' && !Array.isArray(source) &&
      OI_LIQUIDATION_SOURCE_STATUSES.has(status) &&
      Number.isInteger(listingCount) && listingCount >= 0 &&
      Number.isInteger(oiCount) && oiCount >= 0 && oiCount <= listingCount &&
      Number.isInteger(volumeCount) && volumeCount >= 0 && volumeCount <= listingCount &&
      warnings !== null && warnings.every(warning => typeof warning === 'string') &&
      ((status === 'full' && fullFields && !hasCatalogBlocker) ||
        (status === 'partial' && partialFields) ||
        (status === 'unavailable' && unavailableFields));
    return baseValid;
  });
}

function rounded(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function oiTopTraderPositionValid(position, generatedAtMs) {
  const status = String(position?.status || '').toLowerCase();
  const venueSymbol = String(position?.venueSymbol || '').trim().toUpperCase();
  const ratio = position?.longShortRatio;
  const longPct = position?.longPositionPct;
  const shortPct = position?.shortPositionPct;
  const bias = String(position?.bias || '').toLowerCase();
  const observedAtMs = Date.parse(position?.observedAt);
  if (!/^[A-Z0-9][A-Z0-9._:/-]{0,79}$/.test(venueSymbol) ||
      !['full', 'unavailable'].includes(status)) return false;
  if (status === 'unavailable') {
    return ratio === null && longPct === null && shortPct === null &&
      position?.observedAt === null && bias === 'unavailable' &&
      typeof position?.reasonCode === 'string' && position.reasonCode.length > 0;
  }
  if (!Number.isFinite(ratio) || ratio < 0 || rounded(ratio, 4) !== ratio ||
      !Number.isFinite(longPct) || longPct < 0 || longPct > 100 || rounded(longPct, 2) !== longPct ||
      !Number.isFinite(shortPct) || shortPct <= 0 || shortPct > 100 ||
      rounded(shortPct, 2) !== shortPct ||
      !Number.isFinite(observedAtMs) || !Number.isFinite(generatedAtMs) ||
      observedAtMs > generatedAtMs || generatedAtMs - observedAtMs > 3 * UTC_HOUR_MS ||
      Math.abs(longPct + shortPct - 100) > 0.0101) return false;
  // Published percentages are rounded to two decimals while the ratio keeps
  // four. Validate that the ratio is possible within both rounding intervals
  // instead of comparing it to a lower-precision quotient as exact truth.
  const ratioMinimum = Math.max(0, longPct - 0.005) / (shortPct + 0.005);
  const ratioMaximum = (longPct + 0.005) / Math.max(0.000001, shortPct - 0.005);
  if (ratio < ratioMinimum - 0.0001 || ratio > ratioMaximum + 0.0001) return false;
  const expectedBias = ratio < OI_LIQUIDATION_THRESHOLDS.topTraderBearishBelow
    ? 'bearish'
    : ratio > OI_LIQUIDATION_THRESHOLDS.topTraderBullishAbove ? 'bullish' : 'neutral';
  return bias === expectedBias && position?.reasonCode === null;
}

function expectedOiPrice24h(listings, currentOi, generatedAtMs) {
  const expectedListings = listings.length;
  const observed = listings.filter(listing => Number.isFinite(listing?.change24hPct) &&
    listing.change24hPct >= -100 && rounded(listing.change24hPct, 5) === listing.change24hPct &&
    typeof listing?.change24hMethod === 'string' && listing.change24hMethod.length > 0 &&
    ['full', 'estimated'].includes(String(listing?.change24hStatus || '').toLowerCase()));
  const candidates = observed
    .filter(listing => Number.isFinite(listing?.openInterestUsd) && listing.openInterestUsd >= 0)
    .sort((left, right) => right.openInterestUsd - left.openInterestUsd ||
      String(left.venue).localeCompare(String(right.venue)) ||
      String(left.venueSymbol).localeCompare(String(right.venueSymbol)));
  const selected = candidates[0] || null;
  const changes = observed.map(listing => listing.change24hPct);
  return {
    coverageStatus:selected
      ? observed.length === expectedListings ? 'full' : 'partial'
      : 'unavailable',
    selectionMethod:OI_PRICE_24H_SELECTION_METHOD,
    observedListings:observed.length,
    expectedListings,
    observedAt:new Date(generatedAtMs).toISOString(),
    representative:selected ? {
      venue:String(selected.venue || '').toLowerCase(),
      venueSymbol:String(selected.venueSymbol || ''),
      change24hPct:selected.change24hPct,
      method:selected.change24hMethod,
      status:selected.change24hStatus,
      currentOpenInterestSharePct:currentOi > 0
        ? rounded((selected.openInterestUsd / currentOi) * 100, 5)
        : null,
    } : null,
    rangePct:{
      min:changes.length ? rounded(Math.min(...changes), 5) : null,
      max:changes.length ? rounded(Math.max(...changes), 5) : null,
    },
    reasonCode:selected
      ? null
      : observed.length ? 'PRICE_24H_REPRESENTATIVE_OI_UNAVAILABLE' : 'PRICE_24H_CHANGE_UNAVAILABLE',
  };
}

function oiPrice24hContextValid(context, generatedAtMs, support = null) {
  const keys = [
    'coverageStatus', 'selectionMethod', 'observedListings', 'expectedListings', 'observedAt',
    'representative', 'rangePct', 'reasonCode',
  ];
  if (!context || typeof context !== 'object' || Array.isArray(context) ||
      Object.keys(context).length !== keys.length || keys.some(key =>
        !Object.prototype.hasOwnProperty.call(context, key)) ||
      context.selectionMethod !== OI_PRICE_24H_SELECTION_METHOD ||
      !['full', 'partial', 'unavailable'].includes(String(context.coverageStatus || '').toLowerCase()) ||
      !Number.isInteger(context.observedListings) || context.observedListings < 0 ||
      !Number.isInteger(context.expectedListings) || context.expectedListings <= 0 ||
      context.observedListings > context.expectedListings ||
      Date.parse(context.observedAt) !== generatedAtMs) return false;
  const min = context?.rangePct?.min;
  const max = context?.rangePct?.max;
  const rangeKeysValid = context.rangePct && typeof context.rangePct === 'object' &&
    !Array.isArray(context.rangePct) && Object.keys(context.rangePct).length === 2 &&
    Object.prototype.hasOwnProperty.call(context.rangePct, 'min') &&
    Object.prototype.hasOwnProperty.call(context.rangePct, 'max');
  const emptyRange = min === null && max === null;
  const populatedRange = Number.isFinite(min) && min >= -100 && rounded(min, 5) === min &&
    Number.isFinite(max) && max >= min && rounded(max, 5) === max;
  if (!rangeKeysValid || (context.observedListings === 0 ? !emptyRange : !populatedRange)) return false;
  const representative = context.representative;
  if (representative === null) {
    if (context.coverageStatus !== 'unavailable' || typeof context.reasonCode !== 'string' ||
        !context.reasonCode.length) return false;
  } else {
    const representativeKeys = [
      'venue', 'venueSymbol', 'change24hPct', 'method', 'status', 'currentOpenInterestSharePct',
    ];
    const share = representative.currentOpenInterestSharePct;
    const shareValid = share === null ||
      (Number.isFinite(share) && share >= 0 && share <= 100 && rounded(share, 5) === share);
    const expectedStatus = context.observedListings === context.expectedListings ? 'full' : 'partial';
    if (!representative || typeof representative !== 'object' || Array.isArray(representative) ||
        Object.keys(representative).length !== representativeKeys.length ||
        representativeKeys.some(key => !Object.prototype.hasOwnProperty.call(representative, key)) ||
        !SIGNAL_VENUES.has(String(representative.venue || '').toLowerCase()) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(String(representative.venueSymbol || '')) ||
        !Number.isFinite(representative.change24hPct) || representative.change24hPct < -100 ||
        rounded(representative.change24hPct, 5) !== representative.change24hPct ||
        representative.change24hPct < min || representative.change24hPct > max ||
        typeof representative.method !== 'string' || !representative.method.length ||
        !['full', 'estimated'].includes(String(representative.status || '').toLowerCase()) ||
        !shareValid || context.coverageStatus !== expectedStatus || context.reasonCode !== null) return false;
  }
  if (support) {
    const expected = expectedOiPrice24h(support.listings, support.currentOi, generatedAtMs);
    if (JSON.stringify(context) !== JSON.stringify(expected)) return false;
  }
  return true;
}

function expectedOiFunding(listings, price24h, generatedAtMs) {
  const reference = price24h?.representative || null;
  if (!reference) {
    return {
      status:'unavailable', venue:null, venueSymbol:null, ratePct:null, intervalHours:null,
      observedAt:null, reasonCode:'REFERENCE_CONTRACT_UNAVAILABLE',
    };
  }
  const listing = listings.find(candidate => String(candidate?.venue || '').toLowerCase() === reference.venue &&
    String(candidate?.venueSymbol || '') === reference.venueSymbol);
  if (!listing || !Number.isFinite(listing.fundingRate) ||
      !Number.isFinite(listing.fundingIntervalHours) || listing.fundingIntervalHours <= 0) {
    return {
      status:'unavailable', venue:reference.venue, venueSymbol:reference.venueSymbol,
      ratePct:null, intervalHours:null, observedAt:null, reasonCode:'FUNDING_UNAVAILABLE',
    };
  }
  return {
    status:'full',
    venue:reference.venue,
    venueSymbol:reference.venueSymbol,
    ratePct:rounded(listing.fundingRate * 100, 8),
    intervalHours:rounded(listing.fundingIntervalHours, 6),
    observedAt:new Date(generatedAtMs).toISOString(),
    reasonCode:null,
  };
}

function oiFundingContextValid(context, generatedAtMs, price24h, support = null) {
  const keys = [
    'status', 'venue', 'venueSymbol', 'ratePct', 'intervalHours', 'observedAt', 'reasonCode',
  ];
  if (!context || typeof context !== 'object' || Array.isArray(context) ||
      Object.keys(context).length !== keys.length || keys.some(key =>
        !Object.prototype.hasOwnProperty.call(context, key)) ||
      !['full', 'unavailable'].includes(String(context.status || '').toLowerCase())) return false;
  const reference = price24h?.representative || null;
  if (!reference) {
    return context.status === 'unavailable' && context.venue === null && context.venueSymbol === null &&
      context.ratePct === null && context.intervalHours === null && context.observedAt === null &&
      context.reasonCode === 'REFERENCE_CONTRACT_UNAVAILABLE';
  }
  if (context.venue !== reference.venue || context.venueSymbol !== reference.venueSymbol) return false;
  let valid;
  if (context.status === 'unavailable') {
    valid = context.ratePct === null && context.intervalHours === null && context.observedAt === null &&
      context.reasonCode === 'FUNDING_UNAVAILABLE';
  } else {
    valid = Number.isFinite(context.ratePct) && rounded(context.ratePct, 8) === context.ratePct &&
      Number.isFinite(context.intervalHours) && context.intervalHours > 0 &&
      rounded(context.intervalHours, 6) === context.intervalHours &&
      Date.parse(context.observedAt) === generatedAtMs && context.reasonCode === null;
  }
  if (!valid) return false;
  if (support) {
    const expected = expectedOiFunding(support.listings, price24h, generatedAtMs);
    if (JSON.stringify(context) !== JSON.stringify(expected)) return false;
  }
  return true;
}

function oiPositioningContextValid(context, evaluationStatus, generatedAtMs, price24h) {
  const keys = [
    'status', 'venue', 'venueSymbol', 'metric', 'scope', 'period', 'longShortRatio',
    'longPositionPct', 'shortPositionPct', 'bias', 'observedAt', 'reasonCode',
  ];
  if (!context || typeof context !== 'object' || Array.isArray(context) ||
      Object.keys(context).length !== keys.length || keys.some(key =>
        !Object.prototype.hasOwnProperty.call(context, key)) ||
      !['full', 'unavailable'].includes(String(context.status || '').toLowerCase())) return false;
  const reference = price24h?.representative || null;
  const unavailableValues = context.longShortRatio === null && context.longPositionPct === null &&
    context.shortPositionPct === null && context.bias === 'unavailable' && context.observedAt === null;
  if (!reference) {
    return context.status === 'unavailable' && context.venue === null && context.venueSymbol === null &&
      context.metric === null && context.scope === null && context.period === null && unavailableValues &&
      context.reasonCode === 'REFERENCE_CONTRACT_UNAVAILABLE';
  }
  if (context.venue !== reference.venue || context.venueSymbol !== reference.venueSymbol) return false;
  if (evaluationStatus !== 'triggered') {
    return context.status === 'unavailable' && context.metric === null && context.scope === null &&
      context.period === null && unavailableValues && context.reasonCode === 'OI_DRAWDOWN_NOT_TRIGGERED';
  }
  if (reference.venue !== 'binance') {
    return context.status === 'unavailable' && context.metric === null && context.scope === null &&
      context.period === null && unavailableValues && context.reasonCode === 'VENUE_POSITIONING_UNSUPPORTED';
  }
  return context.metric === OI_TOP_TRADER_METRIC && context.scope === OI_TOP_TRADER_SCOPE &&
    context.period === '1h' && oiTopTraderPositionValid(context, generatedAtMs);
}

function oiMarketContextValid(context, evaluationStatus, generatedAtMs, priceSupport = null) {
  return context && typeof context === 'object' && !Array.isArray(context) &&
    Object.keys(context).length === 4 && context.version === OI_MARKET_CONTEXT_VERSION &&
    Object.prototype.hasOwnProperty.call(context, 'version') &&
    Object.prototype.hasOwnProperty.call(context, 'price24h') &&
    Object.prototype.hasOwnProperty.call(context, 'funding') &&
    Object.prototype.hasOwnProperty.call(context, 'positioning') &&
    oiPrice24hContextValid(context.price24h, generatedAtMs, priceSupport) &&
    oiFundingContextValid(context.funding, generatedAtMs, context.price24h, priceSupport) &&
    oiPositioningContextValid(context.positioning, evaluationStatus, generatedAtMs, context.price24h);
}

function oiLiquidationRowValid(row, section, generatedAtMs) {
  const category = signalCategory(row?.category);
  const symbol = String(row?.symbol || '').trim().toUpperCase();
  const venues = Array.isArray(row?.venues)
    ? row.venues.map(venue => String(venue || '').trim().toLowerCase())
    : [];
  const currentVolume = row?.currentVolume24hUsd;
  const currentOi = row?.currentOpenInterestUsd;
  const listings = Array.isArray(row?.listings) ? row.listings : null;
  const listingKeys = [];
  let listingVolume = 0;
  let listingOi = 0;
  let listingFieldsValid = listings !== null && listings.length > 0;
  for (const listing of listings || []) {
    const venue = String(listing?.venue || '').trim().toLowerCase();
    const venueSymbol = String(listing?.venueSymbol || '').trim().toUpperCase();
    const instrumentType = String(listing?.instrumentType || '').trim();
    const volume = listing?.volume24hUsd;
    const oi = listing?.openInterestUsd;
    const volumeStatus = String(listing?.volumeStatus || '').toLowerCase();
    const oiStatus = String(listing?.openInterestStatus || '').toLowerCase();
    const fundingRate = listing?.fundingRate;
    const fundingIntervalHours = listing?.fundingIntervalHours;
    const fundingValid = (fundingRate === null && fundingIntervalHours === null) ||
      (Number.isFinite(fundingRate) && Number.isFinite(fundingIntervalHours) && fundingIntervalHours > 0);
    const change24h = listing?.change24hPct;
    const change24hMethod = listing?.change24hMethod;
    const change24hStatus = String(listing?.change24hStatus || '').toLowerCase();
    const change24hValid = change24h === null
      ? change24hMethod === null && change24hStatus === 'unavailable'
      : Number.isFinite(change24h) && change24h >= -100 && rounded(change24h, 5) === change24h &&
        typeof change24hMethod === 'string' && change24hMethod.length > 0 &&
        ['full', 'estimated'].includes(change24hStatus);
    if (!SIGNAL_VENUES.has(venue) || !/^[A-Z0-9][A-Z0-9._:/-]{0,79}$/.test(venueSymbol) ||
        !/^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,39}$/.test(instrumentType) ||
        !Number.isFinite(volume) || volume < 0 || rounded(volume, 2) !== volume ||
        !['full', 'estimated'].includes(volumeStatus) ||
        typeof listing?.volumeMethod !== 'string' || !listing.volumeMethod.trim() ||
        !Number.isFinite(oi) || oi < 0 || rounded(oi, 2) !== oi ||
        !['full', 'estimated'].includes(oiStatus) ||
        typeof listing?.openInterestMethod !== 'string' || !listing.openInterestMethod.trim() ||
        !fundingValid ||
        !change24hValid) {
      listingFieldsValid = false;
      continue;
    }
    listingKeys.push(`${venue}:${venueSymbol}`);
    listingVolume += volume;
    listingOi += oi;
  }
  listingFieldsValid = listingFieldsValid && new Set(listingKeys).size === listingKeys.length &&
    row?.listingCount === listings.length && rounded(listingVolume, 2) === currentVolume &&
    rounded(listingOi, 2) === currentOi;
  const listingVenueSet = new Set((listings || []).map(listing => String(listing?.venue || '').toLowerCase()));
  const closes = Array.isArray(row?.completedDailyCloses) ? row.completedDailyCloses : null;
  const generatedDay = Number.isFinite(generatedAtMs)
    ? Math.floor(generatedAtMs / UTC_DAY_MS) * UTC_DAY_MS
    : null;
  const closeRows = closes?.map(close => ({
    day:exactUtcDayMs(close?.day),
    openInterestUsd:close?.openInterestUsd,
  })) || [];
  const closeDaysValid = closeRows.every((close, index) => close.day !== null &&
    Number.isFinite(close.openInterestUsd) && close.openInterestUsd >= 0 &&
    close.day === generatedDay - (closeRows.length - index) * UTC_DAY_MS);
  const completeCloses = closeRows.length === OI_LIQUIDATION_THRESHOLDS.risingCompletedDays && closeDaysValid;
  const closesRising = completeCloses && closeRows.every((close, index) =>
    index === 0 || close.openInterestUsd > closeRows[index - 1].openInterestUsd);
  const historyStatus = String(section?.history?.status || '').toLowerCase();
  const expectedTrend = completeCloses
    ? closesRising ? 'rising' : 'not-rising'
    : null;
  const trendValid = expectedTrend === null
    ? ['warming', 'unavailable'].includes(row?.completedDailyTrend) &&
      (historyStatus !== 'unavailable' || row?.completedDailyTrend === 'unavailable')
    : row?.completedDailyTrend === expectedTrend;
  const peak = row?.peak24hOpenInterestUsd;
  const peakAtMs = row?.peak24hAt === null ? null : Date.parse(row?.peak24hAt);
  const peakValid = Number.isFinite(peak) && peak >= 0 && Number.isFinite(peakAtMs) &&
    Number.isFinite(generatedAtMs) && peakAtMs <= generatedAtMs &&
    peakAtMs >= generatedAtMs - OI_LIQUIDATION_THRESHOLDS.peakLookbackHours * UTC_HOUR_MS;
  const expectedDrawdown = peakValid && Number.isFinite(currentOi)
    ? rounded(Math.max(0, peak - currentOi), 2)
    : null;
  const drawdown = row?.drawdown24hUsd;
  const drawdownCoherent = expectedDrawdown === null
    ? drawdown === null
    : Number.isFinite(drawdown) && drawdown === expectedDrawdown;
  const oiTriggered = row?.completedDailyTrend === 'rising' && expectedTrend === 'rising';
  const liquidationTriggered = Number.isFinite(drawdown) &&
    drawdown > OI_LIQUIDATION_THRESHOLDS.liquidationProxyDropUsdExclusive;
  const expectedTrigger = oiTriggered && liquidationTriggered
    ? 'both'
    : oiTriggered ? 'oi_rising' : liquidationTriggered ? 'liquidation_proxy' : null;
  const positions = Array.isArray(row?.topTraderPositions) ? row.topTraderPositions : null;
  const positionKeys = positions?.map(position => String(position?.venueSymbol || '').trim().toUpperCase()) || [];
  const binanceListingSymbols = new Set((listings || [])
    .filter(listing => String(listing?.venue || '').toLowerCase() === 'binance')
    .map(listing => String(listing?.venueSymbol || '').toUpperCase()));
  const positionsValid = positions !== null && new Set(positionKeys).size === positionKeys.length &&
    positions.length === binanceListingSymbols.size &&
    positionKeys.every(venueSymbol => binanceListingSymbols.has(venueSymbol)) &&
    [...binanceListingSymbols].every(venueSymbol => positionKeys.includes(venueSymbol)) &&
    positions.every(position => oiTopTraderPositionValid(position, generatedAtMs)) &&
    (!positions.length || venues.includes('binance'));
  const availableBiases = positionsValid
    ? positions.filter(position => position.status === 'full').map(position => position.bias)
    : [];
  const expectedOverallBias = availableBiases.length === 0
    ? 'unavailable'
    : new Set(availableBiases).size === 1 ? availableBiases[0] : 'mixed';
  const fieldStatus = row?.fieldStatus;
  const topTraderFieldStatus = availableBiases.length === 0
    ? 'unavailable'
    : availableBiases.length === positions.length ? 'full' : 'partial';
  const expectedClosesStatus = completeCloses ? 'estimated' : closeRows.length ? 'partial' : 'unavailable';
  const fieldStatusKeys = [
    'currentVolume24hUsd', 'currentOpenInterestUsd', 'completedDailyCloses', 'completedDailyTrend',
    'peak24hOpenInterestUsd', 'drawdown24hUsd', 'topTraderPositions',
  ];
  const estimatedFieldsValid = fieldStatus && typeof fieldStatus === 'object' && !Array.isArray(fieldStatus) &&
    Object.keys(fieldStatus).length === fieldStatusKeys.length &&
    fieldStatusKeys.every(key => Object.prototype.hasOwnProperty.call(fieldStatus, key)) &&
    String(fieldStatus.currentVolume24hUsd || '').toLowerCase() === 'estimated' &&
    String(fieldStatus.currentOpenInterestUsd || '').toLowerCase() === 'estimated' &&
    String(fieldStatus.completedDailyCloses || '').toLowerCase() === expectedClosesStatus &&
    String(fieldStatus.completedDailyTrend || '').toLowerCase() === expectedClosesStatus &&
    String(fieldStatus.peak24hOpenInterestUsd || '').toLowerCase() === (peakValid ? 'estimated' : 'unavailable') &&
    String(fieldStatus.drawdown24hUsd || '').toLowerCase() === (expectedDrawdown === null ? 'unavailable' : 'estimated') &&
    String(fieldStatus.topTraderPositions || '').toLowerCase() === topTraderFieldStatus &&
    Object.values(fieldStatus).every(value => OI_LIQUIDATION_FIELD_STATUSES.has(String(value || '').toLowerCase()));
  const reasonCodesValid = Array.isArray(row?.reasonCodes) &&
    row.reasonCodes.every(reason => typeof reason === 'string' && reason.length > 0) &&
    new Set(row.reasonCodes).size === row.reasonCodes.length;

  return Number.isInteger(row?.rank) && row.rank > 0 &&
    RWA_SIGNAL_CATEGORIES.has(category) && /^[A-Z0-9][A-Z0-9.-]{0,39}$/.test(symbol) &&
    row?.assetKey === `${category}:${symbol}` && /^[A-Za-z0-9_-]{8,64}$/.test(String(row?.cohortFingerprint || '')) &&
    venues.length > 0 && new Set(venues).size === venues.length && venues.every(venue => SIGNAL_VENUES.has(venue)) &&
    listingFieldsValid && venues.length === listingVenueSet.size && venues.every(venue => listingVenueSet.has(venue)) &&
    Number.isInteger(row?.listingCount) && row.listingCount >= venues.length &&
    Number.isFinite(currentVolume) && currentVolume > OI_LIQUIDATION_THRESHOLDS.minVolume24hUsdExclusive &&
    rounded(currentVolume, 2) === currentVolume && Number.isFinite(currentOi) && currentOi >= 0 &&
    rounded(currentOi, 2) === currentOi && closes !== null && closeDaysValid &&
    trendValid && drawdownCoherent &&
    (peakValid || (peak === null && row?.peak24hAt === null)) &&
    row?.trigger === expectedTrigger && expectedTrigger !== null && positionsValid &&
    row?.overallTraderBias === expectedOverallBias && row?.status === 'estimated' &&
    estimatedFieldsValid && reasonCodesValid;
}

function oiLiquidationStateValid(state, generatedAtMs) {
  const category = signalCategory(state?.category);
  const symbol = String(state?.symbol || '').trim().toUpperCase();
  const evaluationStatus = String(state?.evaluationStatus || '').toLowerCase();
  const cohortFingerprint = state?.cohortFingerprint;
  const cohortValid = /^[A-Za-z0-9_-]{8,64}$/.test(String(cohortFingerprint || ''));
  const observedBucketMs = Date.parse(state?.observedBucket);
  const generatedHour = Number.isFinite(generatedAtMs)
    ? Math.floor(generatedAtMs / UTC_HOUR_MS) * UTC_HOUR_MS
    : null;
  const currentOi = state?.currentOpenInterestUsd;
  const peak = state?.peak24hOpenInterestUsd;
  const drawdown = state?.drawdown24hUsd;
  const drawdownPct = state?.drawdown24hPct;
  const currentOiValid = currentOi === null ||
    (Number.isFinite(currentOi) && currentOi >= 0 && rounded(currentOi, 2) === currentOi);
  const peakValid = peak === null || (Number.isFinite(peak) && peak >= 0 && rounded(peak, 2) === peak);
  const drawdownValid = drawdown === null ||
    (Number.isFinite(drawdown) && drawdown >= 0 && rounded(drawdown, 2) === drawdown);
  const drawdownPctValid = drawdownPct === null ||
    (Number.isFinite(drawdownPct) && drawdownPct >= 0 && drawdownPct <= 100 &&
      rounded(drawdownPct, 6) === drawdownPct);
  const reasonCodes = Array.isArray(state?.reasonCodes) ? state.reasonCodes : null;
  const reasonsValid = reasonCodes !== null && reasonCodes.every(reason =>
    /^[A-Z][A-Z0-9_]{1,79}$/.test(reason)) && new Set(reasonCodes).size === reasonCodes.length;
  const commonValid = RWA_SIGNAL_CATEGORIES.has(category) &&
    /^[A-Z0-9][A-Z0-9.-]{0,39}$/.test(symbol) && state?.assetKey === `${category}:${symbol}` &&
    OI_LIQUIDATION_EVALUATION_STATUSES.has(evaluationStatus) &&
    Number.isFinite(observedBucketMs) && observedBucketMs === generatedHour &&
    currentOiValid && peakValid && drawdownValid && drawdownPctValid && reasonsValid &&
    oiMarketContextValid(state?.marketContext, evaluationStatus, generatedAtMs);
  if (!commonValid) return false;

  if (evaluationStatus === 'triggered' || evaluationStatus === 'clear') {
    if (!cohortValid || state?.sameCohort !== true || !Number.isFinite(currentOi) ||
        !Number.isFinite(peak) || !Number.isFinite(drawdown) || peak < currentOi ||
        drawdown !== rounded(peak - currentOi, 2)) return false;
    const expectedStatus = drawdown > OI_LIQUIDATION_THRESHOLDS.liquidationProxyDropUsdExclusive
      ? 'triggered'
      : 'clear';
    if (evaluationStatus !== expectedStatus) return false;
    if (peak === 0) {
      return currentOi === 0 && drawdown === 0 && drawdownPct === null &&
        reasonCodes.length === 1 && reasonCodes[0] === 'OI_PEAK_ZERO_PERCENT_UNAVAILABLE';
    }
    return drawdownPct === rounded((drawdown / peak) * 100, 6) && reasonCodes.length === 0;
  }

  if (evaluationStatus === 'warming') {
    const explainsWarming = reasonCodes.includes('OI_COHORT_CHANGED') ||
      reasonCodes.includes('OI_HISTORY_HOUR_MISSING') || reasonCodes.includes('OI_HISTORY_WARMING');
    const cohortClaimValid = state?.sameCohort === false
      ? reasonCodes.includes('OI_COHORT_CHANGED')
      : state?.sameCohort === null;
    return cohortValid && Number.isFinite(currentOi) && peak === null && drawdown === null &&
      drawdownPct === null && reasonCodes.length > 0 && explainsWarming && cohortClaimValid;
  }

  const currentCohortShapeValid = (cohortFingerprint === null && currentOi === null) ||
    (cohortValid && Number.isFinite(currentOi));
  return evaluationStatus === 'unavailable' && currentCohortShapeValid && state?.sameCohort === null &&
    peak === null && drawdown === null && drawdownPct === null && reasonCodes.length > 0;
}

function validateOiLiquidationAnomalies(section, generatedAtMs) {
  const status = String(section?.status || '').toLowerCase();
  const formulaValid = section?.formulaVersion === OI_LIQUIDATION_FORMULA_VERSION;
  const sectionGeneratedAtMs = Date.parse(section?.generatedAt);
  const timestampValid = Number.isFinite(sectionGeneratedAtMs) && Number.isFinite(generatedAtMs) &&
    Math.abs(sectionGeneratedAtMs - generatedAtMs) <= 1_000;
  const thresholds = section?.thresholds;
  const thresholdsValid = Object.entries(OI_LIQUIDATION_THRESHOLDS)
    .every(([key, value]) => thresholds?.[key] === value) &&
    Object.keys(thresholds || {}).length === Object.keys(OI_LIQUIDATION_THRESHOLDS).length &&
    String(thresholds?.logic || '').toLowerCase() === 'or';
  const methodology = section?.methodology;
  const methodologyValid = methodology && typeof methodology === 'object' && !Array.isArray(methodology) &&
    ['universe', 'eligibility', 'openInterest', 'threeDayTrend', 'liquidationProxy', 'logic',
      'price24h', 'topTraderPositions', 'limitations']
      .every(key => typeof methodology[key] === 'string' && methodology[key].length > 0);
  const sourcesValid = exactOiLiquidationSources(section);
  const sourceValues = sourcesValid ? SIGNAL_SOURCE_KEYS.map(key => section.sources[key]) : [];
  const observedAvailableSources = sourceValues.filter(source => source.status !== 'unavailable').length;
  const observedFullCatalogSources = sourceValues.filter(source =>
    source.listingCount > 0 &&
    !source.warnings.some(warning => OI_CATALOG_BLOCKER.test(String(warning).toUpperCase()))).length;
  const observedAcceptedListings = sourceValues.reduce((sum, source) => sum + source.listingCount, 0);
  const coverage = section?.coverage;
  const coverageKeys = [
    'acceptedListings', 'verifiedAssets', 'identityConflicts', 'volumeEligibleAssets',
    'completeEligibleAssets', 'missingEligibleAssets', 'filterUnknownAssets',
  ];
  const coverageNumbersValid = coverageKeys.every(key => Number.isInteger(coverage?.[key]) && coverage[key] >= 0);
  const coverageValid = coverageNumbersValid && coverage?.expectedSources === SIGNAL_SOURCE_KEYS.length &&
    coverage?.availableSources === observedAvailableSources &&
    coverage?.fullCatalogSources === observedFullCatalogSources &&
    coverage.acceptedListings === observedAcceptedListings &&
    coverage.volumeEligibleAssets <= coverage.verifiedAssets &&
    coverage.completeEligibleAssets <= coverage.volumeEligibleAssets &&
    coverage.missingEligibleAssets === coverage.volumeEligibleAssets - coverage.completeEligibleAssets &&
    coverage.filterUnknownAssets <= coverage.verifiedAssets;
  const identityConflict = Number.isInteger(coverage?.identityConflicts) && coverage.identityConflicts > 0;

  const states = Array.isArray(section?.states) ? section.states : null;
  const invalidStates = states ? states.filter(state => !oiLiquidationStateValid(state, generatedAtMs)) : [];
  const stateKeys = states?.map(state => String(state?.assetKey || '')) || [];
  const statesOrdered = stateKeys.every((key, index) => index === 0 || stateKeys[index - 1].localeCompare(key) < 0);
  const stateCoverage = section?.stateCoverage;
  const stateCoverageValid = Number.isInteger(stateCoverage?.expectedEligibleAssets) &&
    stateCoverage.expectedEligibleAssets === coverage?.volumeEligibleAssets &&
    Number.isInteger(stateCoverage?.returnedStates) && stateCoverage.returnedStates === states?.length &&
    stateCoverage?.complete === true && stateCoverage.returnedStates === stateCoverage.expectedEligibleAssets;

  const rows = Array.isArray(section?.rows) ? section.rows : null;
  const invalidRows = rows ? rows.filter(row => !oiLiquidationRowValid(row, section, generatedAtMs)) : [];
  const ranks = rows?.map(row => row?.rank) || [];
  const identityKeys = rows?.map(row => `${signalCategory(row?.category)}:${String(row?.symbol || '').toUpperCase()}`) || [];
  const responseListings = rows?.flatMap(row => Array.isArray(row?.listings) ? row.listings : []) || [];
  const responseListingKeys = responseListings.map(listing =>
    `${String(listing?.venue || '').toLowerCase()}:${String(listing?.venueSymbol || '').toUpperCase()}`);
  const responseSourceCountsValid = sourcesValid && SIGNAL_SOURCE_KEYS.every(venue => {
    const observed = responseListings.filter(listing => String(listing?.venue || '').toLowerCase() === venue).length;
    const source = section.sources[venue];
    return observed <= source.listingCount && observed <= source.volumeFieldCount &&
      observed <= source.openInterestFieldCount;
  });
  const rowsValid = rows !== null && rows.length <= 100 && invalidRows.length === 0 &&
    new Set(identityKeys).size === identityKeys.length && new Set(ranks).size === ranks.length &&
    new Set(responseListingKeys).size === responseListingKeys.length && responseSourceCountsValid &&
    ranks.every((rank, index) => rank === index + 1);
  const observedCounts = rows ? {
    oiRising:rows.filter(row => ['oi_rising', 'both'].includes(row.trigger)).length,
    liquidationProxy:rows.filter(row => ['liquidation_proxy', 'both'].includes(row.trigger)).length,
    both:rows.filter(row => row.trigger === 'both').length,
    topTraderAvailable:rows.filter(row => row.topTraderPositions
      .some(position => position.status === 'full')).length,
  } : null;
  const counts = section?.counts;
  const declaredCountKeys = [
    'verifiedAssets', 'filteredLowVolume', 'filterUnknown', 'volumeEligibleAssets',
    'completeEligibleAssets', 'missingEligibleAssets', 'alerts', 'oiRising',
    'liquidationProxy', 'both', 'perpListings', 'topTraderAvailable',
  ];
  const declaredCountsValid = declaredCountKeys.every(key => Number.isInteger(counts?.[key]) && counts[key] >= 0) &&
    counts.alerts === counts.oiRising + counts.liquidationProxy - counts.both &&
    counts.both <= Math.min(counts.oiRising, counts.liquidationProxy) &&
    counts.verifiedAssets === coverage?.verifiedAssets &&
    counts.filterUnknown === coverage?.filterUnknownAssets &&
    counts.volumeEligibleAssets === coverage?.volumeEligibleAssets &&
    counts.completeEligibleAssets === coverage?.completeEligibleAssets &&
    counts.missingEligibleAssets === coverage?.missingEligibleAssets &&
    counts.perpListings === coverage?.acceptedListings &&
    counts.topTraderAvailable <= counts.alerts;
  const rowsCountsValid = observedCounts !== null && rows.length === Math.min(counts?.alerts ?? -1, 100) &&
    ['oiRising', 'liquidationProxy', 'both', 'topTraderAvailable'].every(key =>
      observedCounts[key] <= counts[key] && (counts.alerts > 100 || observedCounts[key] === counts[key]));
  const countsValid = declaredCountsValid && rowsCountsValid && coverageValid &&
    counts.filteredLowVolume + counts.filterUnknown + coverage.volumeEligibleAssets === coverage.verifiedAssets &&
    counts.completeEligibleAssets + counts.missingEligibleAssets === counts.volumeEligibleAssets &&
    counts.alerts <= coverage.completeEligibleAssets;
  const stateByKey = new Map((states || []).map(state => [state.assetKey, state]));
  const rowStatesCoherent = rows !== null && rows.every(row => {
    const state = stateByKey.get(row.assetKey);
    if (!state || state.cohortFingerprint !== row.cohortFingerprint ||
        state.currentOpenInterestUsd !== row.currentOpenInterestUsd ||
        !oiMarketContextValid(state?.marketContext, state.evaluationStatus, generatedAtMs, {
          listings:row.listings,
          currentOi:row.currentOpenInterestUsd,
        })) return false;
    const positioning = state.marketContext.positioning;
    if (state.evaluationStatus === 'triggered' && positioning.venue === 'binance') {
      const legacy = row.topTraderPositions.find(position =>
        String(position?.venueSymbol || '').toUpperCase() === positioning.venueSymbol.toUpperCase());
      if (!legacy || legacy.status !== positioning.status ||
          legacy.longShortRatio !== positioning.longShortRatio ||
          legacy.longPositionPct !== positioning.longPositionPct ||
          legacy.shortPositionPct !== positioning.shortPositionPct ||
          legacy.bias !== positioning.bias || legacy.observedAt !== positioning.observedAt ||
          legacy.reasonCode !== positioning.reasonCode) return false;
    }
    if (row.drawdown24hUsd === null) {
      return state.evaluationStatus === 'warming' && state.peak24hOpenInterestUsd === null &&
        state.drawdown24hUsd === null && state.drawdown24hPct === null;
    }
    return state.peak24hOpenInterestUsd === row.peak24hOpenInterestUsd &&
      state.drawdown24hUsd === row.drawdown24hUsd;
  });
  const triggeredStates = states?.filter(state => state.evaluationStatus === 'triggered').length ?? -1;
  const completeStateCohorts = states?.filter(state => state.cohortFingerprint !== null).length ?? -1;
  const statesValid = states !== null && invalidStates.length === 0 && statesOrdered &&
    new Set(stateKeys).size === stateKeys.length && stateCoverageValid && rowStatesCoherent &&
    triggeredStates === counts?.liquidationProxy &&
    completeStateCohorts === coverage?.completeEligibleAssets;

  const history = section?.history;
  const historyStatus = String(history?.status || '').toLowerCase();
  const storedHours = history?.storedHourlyBuckets;
  const oldestAtMs = history?.oldestAt === null ? null : Date.parse(history?.oldestAt);
  const newestAtMs = history?.latestAt === null ? null : Date.parse(history?.latestAt);
  const generatedHour = Number.isFinite(generatedAtMs)
    ? Math.floor(generatedAtMs / UTC_HOUR_MS) * UTC_HOUR_MS
    : null;
  const emptyHistory = storedHours === 0 && history?.oldestAt === null && history?.latestAt === null;
  const populatedHistory = Number.isInteger(storedHours) && storedHours > 0 &&
    Number.isFinite(oldestAtMs) && Number.isFinite(newestAtMs) &&
    oldestAtMs % UTC_HOUR_MS === 0 && newestAtMs % UTC_HOUR_MS === 0 &&
    oldestAtMs <= newestAtMs && newestAtMs <= generatedHour &&
    oldestAtMs >= generatedHour - (OI_LIQUIDATION_HISTORY_HOURS - 1) * UTC_HOUR_MS &&
    newestAtMs - oldestAtMs >= (storedHours - 1) * UTC_HOUR_MS;
  const historyValid = history && OI_LIQUIDATION_SECTION_STATUSES.has(historyStatus) &&
    history.cadence === 'utc-hourly-idempotent' &&
    history.retentionHours === OI_LIQUIDATION_HISTORY_HOURS &&
    history.requiredHourlyBuckets === OI_LIQUIDATION_THRESHOLDS.peakLookbackHours &&
    history.requiredCompletedDays === OI_LIQUIDATION_THRESHOLDS.risingCompletedDays &&
    typeof history.ready === 'boolean' &&
    Number.isInteger(history.readyAssets) && history.readyAssets >= 0 &&
    Number.isInteger(history.trendReadyAssets) && history.trendReadyAssets >= 0 &&
    history.readyAssets <= history.trendReadyAssets &&
    Number.isInteger(history.drawdownReadyAssets) && history.drawdownReadyAssets >= 0 &&
    history.readyAssets <= history.drawdownReadyAssets &&
    history.trendReadyAssets <= coverage?.completeEligibleAssets &&
    history.drawdownReadyAssets <= coverage?.completeEligibleAssets &&
    history.readyAssets <= coverage?.completeEligibleAssets &&
    history.ready === (coverage?.completeEligibleAssets > 0 &&
      history.readyAssets === coverage?.completeEligibleAssets &&
      history.trendReadyAssets === coverage?.completeEligibleAssets &&
      history.drawdownReadyAssets === coverage?.completeEligibleAssets) &&
    Number.isInteger(storedHours) && storedHours >= 0 && storedHours <= OI_LIQUIDATION_HISTORY_HOURS &&
    (emptyHistory || populatedHistory) &&
    (historyStatus !== 'full' || history.ready === true) &&
    (historyStatus !== 'warming' || history.ready === false);

  const persistence = section?.persistence;
  const persistenceStatus = String(persistence?.status || '').toLowerCase();
  const writeStatus = String(persistence?.writeStatus || '').toLowerCase();
  const readStateValid =
    (persistenceStatus === 'partial' && writeStatus === 'read-only' && persistence?.error === null) ||
    (persistenceStatus === 'unavailable' && writeStatus === 'unavailable' &&
      typeof persistence?.error === 'string' && persistence.error.length > 0);
  const persistenceValid = persistence?.mode === 'vercel-runtime-cache' &&
    OI_LIQUIDATION_PERSISTENCE_STATUSES.has(persistenceStatus) &&
    persistence?.namespace === OI_LIQUIDATION_HISTORY_NAMESPACE &&
    persistence?.writer?.requested === false && persistence?.writer?.succeeded === null &&
    OI_LIQUIDATION_WRITE_STATUSES.has(writeStatus) && readStateValid;

  const allSourcesFull = sourcesValid && sourceValues.every(source => source.status === 'full');
  const statusValid = OI_LIQUIDATION_SECTION_STATUSES.has(status);
  const statusCoherent = statusValid &&
    (status !== 'full' || (allSourcesFull && !identityConflict && historyStatus === 'full' &&
      coverage.fullCatalogSources === SIGNAL_SOURCE_KEYS.length &&
      counts?.filterUnknown === 0 && coverage.completeEligibleAssets === coverage.volumeEligibleAssets &&
      coverage.missingEligibleAssets === 0 && history?.ready === true)) &&
    (status !== 'warming' || historyStatus === 'warming') &&
    (status !== 'unavailable' || rows?.length === 0);
  const cryptoCategoryCount = (rows || [])
    .filter(row => !RWA_SIGNAL_CATEGORIES.has(signalCategory(row?.category))).length +
    (states || []).filter(state => !RWA_SIGNAL_CATEGORIES.has(signalCategory(state?.category))).length;
  const metadataValid = section?.rowLimit === 100 && typeof section?.scope === 'string' && section.scope.length > 0;
  const contractValid = Boolean(section) && metadataValid && formulaValid && timestampValid && thresholdsValid &&
    methodologyValid && sourcesValid && coverageValid && countsValid && rowsValid && statesValid && historyValid &&
    persistenceValid && statusCoherent && cryptoCategoryCount === 0;
  return {
    contractValid,
    status,
    formulaValid,
    timestampValid,
    thresholdsValid,
    methodologyValid,
    sourcesValid,
    allSourcesFull,
    coverageValid,
    countsValid,
    rowsValid,
    statesValid,
    stateCoverageValid,
    historyValid,
    persistenceValid,
    statusCoherent,
    identityConflicts:Number.isInteger(coverage?.identityConflicts) ? coverage.identityConflicts : null,
    identityConflict,
    rows:rows?.length ?? null,
    invalidRows:invalidRows.length,
    states:states?.length ?? null,
    invalidStates:invalidStates.length,
    cryptoCategoryCount,
  };
}

export function validateSignalRadarSnapshot(payload, now = Date.now()) {
  const generatedAtMs = Date.parse(payload?.generatedAt);
  const ageMs = Number.isFinite(generatedAtMs) ? now - generatedAtMs : null;
  const fresh = ageMs !== null && ageMs >= -SIGNAL_SNAPSHOT_FUTURE_TOLERANCE_MS &&
    ageMs <= SIGNAL_SNAPSHOT_MAX_AGE_MS;
  const schemaValid = payload?.schemaVersion === SIGNAL_SCHEMA_VERSION;
  const sourcesValid = exactSignalSources(payload);
  const expectedSources = payload?.coverage?.expectedSources;
  const availableSources = payload?.coverage?.availableSources;
  const declaredIdentityConflicts = payload?.coverage?.identityConflicts;
  const observedAvailableSources = sourcesValid
    ? SIGNAL_SOURCE_KEYS.filter(sourceKey =>
      String(payload.sources[sourceKey].status || '').toLowerCase() !== 'unavailable').length
    : null;
  const coverageValid = Number.isInteger(expectedSources) && expectedSources === SIGNAL_SOURCE_KEYS.length &&
    Number.isInteger(availableSources) && availableSources === observedAvailableSources &&
    Number.isInteger(declaredIdentityConflicts) && declaredIdentityConflicts >= 0;
  const identityConflicts = Number.isInteger(declaredIdentityConflicts) ? declaredIdentityConflicts : null;
  const identityConflict = identityConflicts !== null && identityConflicts > 0;
  const allSourcesFull = sourcesValid && SIGNAL_SOURCE_KEYS.every(sourceKey =>
    String(payload.sources[sourceKey].status || '').toLowerCase() === 'full');

  const volume = payload?.perpVolumeAnomalies;
  const volumeHistory = volume?.history;
  const volumeMethodology = volume?.methodology;
  const thresholds = volumeMethodology?.thresholds;
  const formulaValid = volume?.formulaVersion === PERP_VOLUME_ANOMALY_FORMULA_VERSION;
  const historyContractValid = volumeHistory?.retentionDays === PERP_VOLUME_HISTORY_DAYS &&
    volumeHistory?.baselineDays === PERP_VOLUME_BASELINE_DAYS &&
    volumeHistory?.frequencyWindowDays === PERP_VOLUME_FREQUENCY_DAYS;
  const thresholdsValid = thresholds?.high === PERP_VOLUME_ANOMALY_THRESHOLDS.high &&
    thresholds?.medium === PERP_VOLUME_ANOMALY_THRESHOLDS.medium &&
    thresholds?.down === PERP_VOLUME_ANOMALY_THRESHOLDS.down &&
    volumeMethodology?.highFrequencyMinEligibleDays === PERP_VOLUME_HIGH_FREQUENCY_MIN_ELIGIBLE_DAYS &&
    volumeMethodology?.highFrequencyMinAnomalyDays === PERP_VOLUME_HIGH_FREQUENCY_MIN_ANOMALY_DAYS &&
    volumeMethodology?.consecutiveExpansionMinDays === PERP_VOLUME_CONSECUTIVE_EXPANSION_DAYS;
  const volumeStatus = String(volume?.status || '').trim().toLowerCase();
  const volumeStatusValid = VOLUME_ANOMALY_STATUSES.has(volumeStatus);
  const volumeGeneratedAtMs = Date.parse(volume?.generatedAt);
  const volumeTimestampValid = Number.isFinite(volumeGeneratedAtMs) && Number.isFinite(generatedAtMs) &&
    Math.abs(volumeGeneratedAtMs - generatedAtMs) <= 1_000;
  const canonicalAssetCount = payload?.coverage?.canonicalAssetCount;
  const monitoredAssets = volume?.monitoredAssets;
  const monitoredCoverageValid = Number.isInteger(canonicalAssetCount) && canonicalAssetCount > 0 &&
    Number.isInteger(monitoredAssets) && monitoredAssets === canonicalAssetCount;
  const readyAssets = volume?.readyAssets;
  const frequencyReadyAssets = volume?.frequencyReadyAssets;
  const readinessValid = Number.isInteger(readyAssets) && readyAssets >= 0 && readyAssets <= monitoredAssets &&
    Number.isInteger(frequencyReadyAssets) && frequencyReadyAssets >= 0 &&
    frequencyReadyAssets <= readyAssets;
  const volumeRows = Array.isArray(volume?.rows) ? volume.rows : null;
  const invalidVolumeRows = volumeRows
    ? volumeRows.filter(row => !volumeAnomalyRowValid(row))
    : [];
  const volumeRanks = volumeRows ? volumeRows.map(row => row?.rank) : [];
  const uniqueVolumeRanks = volumeRows !== null && new Set(volumeRanks).size === volumeRanks.length &&
    volumeRanks.every((rank, index) => rank === index + 1);
  const observedCounts = volumeRows ? {
    high:volumeRows.filter(row => row?.level === 'high').length,
    medium:volumeRows.filter(row => row?.level === 'medium').length,
    down:volumeRows.filter(row => row?.level === 'down').length,
    highFrequency:volumeRows.filter(row => row?.frequency30d?.highFrequency === true).length,
  } : null;
  const declaredCounts = volume?.counts;
  const countsValid = observedCounts !== null && ['high', 'medium', 'down', 'highFrequency'].every(key =>
    Number.isInteger(declaredCounts?.[key]) && declaredCounts[key] === observedCounts[key]);

  const storedDays = volumeHistory?.storedDays;
  const priorStoredDays = volumeHistory?.priorStoredDays;
  const generatedDay = Number.isFinite(generatedAtMs)
    ? Math.floor(generatedAtMs / UTC_DAY_MS) * UTC_DAY_MS
    : null;
  const oldestAtMs = Date.parse(volumeHistory?.oldestAt);
  const newestAtMs = Date.parse(volumeHistory?.newestAt);
  const emptyHistoryDates = volumeHistory?.oldestAt === null && volumeHistory?.newestAt === null;
  const populatedHistoryDates = Number.isFinite(oldestAtMs) && Number.isFinite(newestAtMs) &&
    oldestAtMs % UTC_DAY_MS === 0 && newestAtMs % UTC_DAY_MS === 0 &&
    oldestAtMs <= newestAtMs && newestAtMs < generatedDay &&
    newestAtMs - oldestAtMs >= Math.max(0, storedDays - 1) * UTC_DAY_MS;
  const historyStateValid = Number.isInteger(storedDays) && storedDays >= 0 &&
    storedDays <= PERP_VOLUME_HISTORY_DAYS && priorStoredDays === storedDays &&
    (storedDays === 0 ? emptyHistoryDates : populatedHistoryDates);

  const persistence = payload?.persistence;
  const dailyPersistence = persistence?.dailyVolume;
  const dailyStoredDays = dailyPersistence?.storedDays;
  const persistenceContractValid = persistence?.writer?.requested === false &&
    persistence?.writer?.succeeded === null &&
    dailyPersistence?.namespace === SIGNAL_VOLUME_DAILY_NAMESPACE &&
    ['partial', 'unavailable'].includes(String(dailyPersistence?.status || '').toLowerCase()) &&
    dailyPersistence?.retentionDays === PERP_VOLUME_HISTORY_DAYS &&
    Number.isInteger(dailyStoredDays) && dailyStoredDays >= 0 &&
    dailyStoredDays <= PERP_VOLUME_HISTORY_DAYS &&
    [priorStoredDays, priorStoredDays + 1].includes(dailyStoredDays) &&
    dailyPersistence?.writeStatus === 'read-only';

  const assets = Array.isArray(payload?.assets) ? payload.assets : null;
  const invalidAssetCategories = assets
    ? assets.filter(asset => !RWA_SIGNAL_CATEGORIES.has(signalCategory(asset?.category)))
    : [];
  const invalidVolumeCategories = volumeRows
    ? volumeRows.filter(row => !RWA_SIGNAL_CATEGORIES.has(signalCategory(row?.category)))
    : [];
  const spotVolumePrice = validateSpotVolumePriceAnomalies(payload?.spotVolumePriceAnomalies, generatedAtMs);
  const spotTopPersistence = persistence?.spotVolumePrice;
  const spotTopPersistenceStatus = String(spotTopPersistence?.status || '').toLowerCase();
  const spotTopWriteStatus = String(spotTopPersistence?.writeStatus || '').toLowerCase();
  const spotTopReadStateValid =
    (spotTopPersistenceStatus === 'partial' && spotTopWriteStatus === 'read-only' &&
      spotTopPersistence?.error === null) ||
    (spotTopPersistenceStatus === 'unavailable' && spotTopWriteStatus === 'unavailable' &&
      typeof spotTopPersistence?.error === 'string' && spotTopPersistence.error.length > 0);
  const spotTopPersistenceValid = spotTopPersistence?.namespace === SPOT_ANOMALY_HISTORY_NAMESPACE &&
    SPOT_ANOMALY_PERSISTENCE_STATUSES.has(spotTopPersistenceStatus) &&
    spotTopPersistence?.retentionDays === SPOT_ANOMALY_HISTORY_DAYS &&
    Number.isInteger(spotTopPersistence?.storedDays) && spotTopPersistence.storedDays >= 0 &&
    spotTopPersistence.storedDays <= SPOT_ANOMALY_HISTORY_DAYS &&
    spotTopPersistence.storedDays === payload?.spotVolumePriceAnomalies?.history?.storedDays &&
    SPOT_ANOMALY_WRITE_STATUSES.has(spotTopWriteStatus) && spotTopReadStateValid &&
    spotTopPersistence.status === payload?.spotVolumePriceAnomalies?.persistence?.status &&
    spotTopPersistence.writeStatus === payload?.spotVolumePriceAnomalies?.persistence?.writeStatus;
  const oiLiquidation = validateOiLiquidationAnomalies(payload?.oiLiquidationAnomalies, generatedAtMs);
  const oiTopPersistence = persistence?.oiLiquidation;
  const oiTopPersistenceStatus = String(oiTopPersistence?.status || '').toLowerCase();
  const oiTopWriteStatus = String(oiTopPersistence?.writeStatus || '').toLowerCase();
  const oiTopReadStateValid =
    (oiTopPersistenceStatus === 'partial' && oiTopWriteStatus === 'read-only' &&
      oiTopPersistence?.error === null) ||
    (oiTopPersistenceStatus === 'unavailable' && oiTopWriteStatus === 'unavailable' &&
      typeof oiTopPersistence?.error === 'string' && oiTopPersistence.error.length > 0);
  const oiTopPersistenceValid = oiTopPersistence?.namespace === OI_LIQUIDATION_HISTORY_NAMESPACE &&
    OI_LIQUIDATION_PERSISTENCE_STATUSES.has(oiTopPersistenceStatus) &&
    oiTopPersistence?.retentionHours === OI_LIQUIDATION_HISTORY_HOURS &&
    Number.isInteger(oiTopPersistence?.storedHours) && oiTopPersistence.storedHours >= 0 &&
    oiTopPersistence.storedHours <= OI_LIQUIDATION_HISTORY_HOURS &&
    oiTopPersistence.storedHours === payload?.oiLiquidationAnomalies?.history?.storedHourlyBuckets &&
    OI_LIQUIDATION_WRITE_STATUSES.has(oiTopWriteStatus) && oiTopReadStateValid &&
    oiTopPersistence.status === payload?.oiLiquidationAnomalies?.persistence?.status &&
    oiTopPersistence.writeStatus === payload?.oiLiquidationAnomalies?.persistence?.writeStatus;
  const cryptoCategoryCount = invalidAssetCategories.length + invalidVolumeCategories.length +
    spotVolumePrice.cryptoCategoryCount + oiLiquidation.cryptoCategoryCount;
  const rowsValid = volumeRows !== null && invalidVolumeRows.length === 0 && uniqueVolumeRanks &&
    volumeRows.length <= readyAssets &&
    (volumeStatus !== 'unavailable' || volumeRows.length === 0);
  const assetsValid = assets !== null && invalidAssetCategories.length === 0;
  const responseStatus = String(payload?.status || '').trim().toLowerCase();
  const responseStatusValid = SIGNAL_SNAPSHOT_STATUSES.has(responseStatus);
  const expectedResponseStatus = allSourcesFull && !identityConflict ? 'full' : 'partial';
  const responseStatusCoherent = responseStatus === expectedResponseStatus;
  const dailyStatus = String(dailyPersistence?.status || '').toLowerCase();
  const expectedVolumeStatus = dailyStatus === 'unavailable'
    ? 'unavailable'
    : responseStatus !== 'full'
      ? 'partial'
      : priorStoredDays < PERP_VOLUME_BASELINE_DAYS
        ? 'warming'
        : readyAssets === monitoredAssets && frequencyReadyAssets === monitoredAssets
          ? 'full'
          : 'partial';
  const volumeStatusCoherent = volumeStatus === expectedVolumeStatus &&
    (volumeStatus !== 'full' || priorStoredDays >= PERP_VOLUME_BASELINE_DAYS + PERP_VOLUME_FREQUENCY_DAYS) &&
    (!['warming', 'unavailable'].includes(volumeStatus) ||
      (readyAssets === 0 && frequencyReadyAssets === 0 && volumeRows?.length === 0));
  const volumeContractValid = Boolean(volume) && formulaValid && volumeTimestampValid && historyContractValid &&
    thresholdsValid && volumeStatusValid && monitoredCoverageValid && readinessValid && countsValid &&
    historyStateValid && persistenceContractValid && volumeStatusCoherent && rowsValid;
  const contractValid = schemaValid && sourcesValid && coverageValid && responseStatusValid &&
    responseStatusCoherent && assetsValid && volumeContractValid && spotVolumePrice.contractValid &&
    spotTopPersistenceValid && oiLiquidation.contractValid && oiTopPersistenceValid;
  const hardFailure = !contractValid || !fresh || identityConflict || spotVolumePrice.identityConflict ||
    oiLiquidation.identityConflict || spotVolumePrice.status === 'unavailable' ||
    oiLiquidation.status === 'unavailable';
  const warmingOrDegraded = responseStatus !== 'full' || volumeStatus !== 'full' ||
    spotVolumePrice.status !== 'full' || oiLiquidation.status !== 'full' || availableSources < expectedSources ||
    persistence?.status === 'unavailable';
  const status = hardFailure ? 'fail' : warmingOrDegraded ? 'warn' : 'pass';

  let reason = null;
  if (identityConflict) reason = `${identityConflicts} cross-category identity conflict(s) detected by Signal Radar`;
  else if (spotVolumePrice.identityConflict) {
    reason = `${spotVolumePrice.identityConflicts} Spot cross-category identity conflict(s) detected by Signal Radar`;
  }
  else if (oiLiquidation.identityConflict) {
    reason = `${oiLiquidation.identityConflicts} OI cross-category identity conflict(s) detected by Signal Radar`;
  }
  else if (!schemaValid) reason = 'Signal Radar schema version is invalid';
  else if (!sourcesValid || !coverageValid || !responseStatusCoherent) {
    reason = 'Signal Radar five-source coverage or status contract is invalid';
  }
  else if (!fresh) reason = 'Signal Radar snapshot is older than two hours or has a future timestamp';
  else if (!volumeContractValid) reason = 'Perpetual volume anomaly contract or row semantics are invalid';
  else if (!spotVolumePrice.contractValid || !spotTopPersistenceValid) {
    reason = 'Spot volume/price anomaly contract, persistence, or row semantics are invalid';
  }
  else if (!oiLiquidation.contractValid || !oiTopPersistenceValid) {
    reason = 'OI and liquidation proxy contract, persistence, or row semantics are invalid';
  }
  else if (spotVolumePrice.status === 'unavailable') reason = 'Spot volume/price anomaly coverage is unavailable';
  else if (oiLiquidation.status === 'unavailable') reason = 'OI and liquidation proxy coverage is unavailable';
  else if (!assetsValid) reason = 'Signal Radar contains a non-RWA or Crypto category';
  else if (warmingOrDegraded) reason = 'Signal Radar or perpetual volume history is Warming, Partial, or Unavailable';

  return {
    status,
    contractValid,
    schemaValid,
    fresh,
    ageMinutes:ageMs === null ? null : ageMs / 60_000,
    sourcesValid,
    allSourcesFull,
    expectedSources:Number.isInteger(expectedSources) ? expectedSources : null,
    availableSources:Number.isInteger(availableSources) ? availableSources : null,
    identityConflicts,
    identityConflict,
    responseStatus,
    formulaValid,
    volumeTimestampValid,
    historyContractValid,
    thresholdsValid,
    volumeStatus,
    volumeStatusCoherent,
    monitoredCoverageValid,
    monitoredAssets:Number.isInteger(monitoredAssets) ? monitoredAssets : null,
    canonicalAssetCount:Number.isInteger(canonicalAssetCount) ? canonicalAssetCount : null,
    readyAssets:Number.isInteger(readyAssets) ? readyAssets : null,
    frequencyReadyAssets:Number.isInteger(frequencyReadyAssets) ? frequencyReadyAssets : null,
    countsValid,
    historyStateValid,
    persistenceContractValid,
    volumeRows:Array.isArray(volumeRows) ? volumeRows.length : null,
    invalidVolumeRows:invalidVolumeRows.length,
    spotVolumePrice,
    spotTopPersistenceValid,
    oiLiquidation,
    oiTopPersistenceValid,
    cryptoCategoryCount,
    reason,
  };
}

async function probeSignalRadar(baseUrl) {
  const startedAt = Date.now();
  try {
    // Use the public fixed reader so a warm Vercel CDN response is preferred;
    // health never calls the authenticated writer or supplies a cache-buster.
    const payload = await fetchJsonWithPolicy(
      `${baseUrl}/api/signal-snapshot`,
      { headers:{ Accept:'application/json' } },
      // A cold Signal snapshot also performs bounded OI and triggered Binance
      // positioning enrichment after the five-source core collection. Keep the
      // read-only probe below the 60-second Function ceiling but above the
      // server's cold core + optional Top Trader enrichment budget.
      { timeoutMs:50_000, retries:0 },
    );
    const validation = validateSignalRadarSnapshot(payload);
    return checkResult('signal-radar-volume', validation.status, {
      latencyMs:Date.now() - startedAt,
      generatedAt:payload?.generatedAt || null,
      ...validation,
    }, {
      critical:validation.identityConflict || validation.spotVolumePrice?.identityConflict ||
        validation.cryptoCategoryCount > 0 || validation.spotVolumePrice?.status === 'unavailable',
    });
  } catch (error) {
    return checkResult('signal-radar-volume', 'fail', {
      latencyMs:Date.now() - startedAt,
      reason:error.message,
    });
  }
}

async function probeFunding(baseUrl, venue, symbol) {
  const startedAt = Date.now();
  try {
    const payload = await fetchJsonWithPolicy(
      `${baseUrl}/api/funding-history?venue=${venue}&hours=24&symbols=${encodeURIComponent(symbol)}`,
      {},
      { timeoutMs: 20000, retries: 0 },
    );
    const row = payload?.results?.[symbol];
    const cutoff = Date.now() - 24 * 3600_000 - 20 * 60_000;
    const leaked = (row?.rows || []).some(item => Number(item.fundingTime) < cutoff);
    const valid = Number(row?.observed) >= 2 && !leaked;
    return checkResult(`funding-${venue}`, valid ? 'pass' : 'warn', {
      latencyMs: Date.now() - startedAt,
      symbol,
      coverageStatus: row?.status || 'unavailable',
      observed: row?.observed || 0,
      expected: row?.expected || null,
      leakedOutsideWindow: leaked,
      reason: valid ? null : row?.error || row?.reason || 'Insufficient 24h funding observations',
    });
  } catch (error) {
    return checkResult(`funding-${venue}`, 'warn', { latencyMs: Date.now() - startedAt, symbol, reason: error.message });
  }
}

function normalized(value) {
  return String(value ?? '').trim();
}

function normalizedUpper(value) {
  return normalized(value).toUpperCase();
}

function summarizeResourceCoverage(rows, expectedIds, declared) {
  const values = Array.isArray(rows) ? rows : [];
  const ids = values.map(row => normalizedUpper(row?.instId)).filter(Boolean);
  const uniqueIds = new Set(ids);
  const duplicateCount = ids.length - uniqueIds.size;
  const missingIds = [...expectedIds].filter(instId => !uniqueIds.has(instId));
  const unexpectedIds = [...uniqueIds].filter(instId => !expectedIds.has(instId));
  const declaredFull = normalized(declared?.status).toLowerCase() === 'full' &&
    Number(declared?.observed) === expectedIds.size &&
    Number(declared?.expected) === expectedIds.size;
  return {
    valid: declaredFull && duplicateCount === 0 && missingIds.length === 0 &&
      unexpectedIds.length === 0 && values.length === expectedIds.size,
    observed: values.length,
    expected: expectedIds.size,
    duplicateCount,
    missingCount: missingIds.length,
    unexpectedCount: unexpectedIds.length,
    missingSample: missingIds.slice(0, 5),
    unexpectedSample: unexpectedIds.slice(0, 5),
    declaredStatus: normalized(declared?.status).toLowerCase() || 'unavailable',
  };
}

function okxPerpIdentity(instrument) {
  const canonical = canonicalOkxPerpSymbol(instrument);
  return isOkxRwaPerpInstrument(instrument) && canonical !== null &&
    normalizedUpper(instrument?.canonicalSymbol) === canonical;
}

function okxSpotIdentity(instrument) {
  const canonical = canonicalOkxSpotSymbol(instrument);
  return isOkxRwaSpotInstrument(instrument) && canonical !== null &&
    normalizedUpper(instrument?.canonicalSymbol) === canonical;
}

function validationReason(issues) {
  return issues.length ? issues.join('; ') : null;
}

export function validateOkxPerpSnapshot(payload) {
  const instruments = Array.isArray(payload?.instruments) ? payload.instruments : [];
  const instIds = instruments.map(row => normalizedUpper(row?.instId)).filter(Boolean);
  const uniqueIds = new Set(instIds);
  const duplicateCount = instIds.length - uniqueIds.size;
  const invalidIdentityIds = instruments
    .filter(row => !okxPerpIdentity(row))
    .map(row => normalizedUpper(row?.instId) || '(missing instId)');
  const swapListings = instruments.filter(row => normalizedUpper(row?.instType) === 'SWAP').length;
  const xPerpListings = instruments.filter(row =>
    normalizedUpper(row?.instType) === 'FUTURES' &&
    normalized(row?.ruleType).toLowerCase() === 'xperp'
  ).length;
  const expectedListings = PRODUCTION_BASELINES.perpetuals.okx;
  const tickerCoverage = summarizeResourceCoverage(payload?.tickers, uniqueIds, payload?.coverage?.tickers);
  const markCoverage = summarizeResourceCoverage(payload?.marks, uniqueIds, payload?.coverage?.marks);
  const openInterestCoverage = summarizeResourceCoverage(
    payload?.openInterest,
    uniqueIds,
    payload?.coverage?.openInterest,
  );
  const identityValid = invalidIdentityIds.length === 0 && duplicateCount === 0;
  const countValid = instruments.length >= OKX_REVIEWED_PERP_MINIMUMS.total &&
    uniqueIds.size >= OKX_REVIEWED_PERP_MINIMUMS.total &&
    swapListings >= OKX_REVIEWED_PERP_MINIMUMS.swap &&
    xPerpListings >= OKX_REVIEWED_PERP_MINIMUMS.xperp;
  const marketCoverageValid = tickerCoverage.valid && markCoverage.valid && openInterestCoverage.valid;
  const issues = [];
  if (!identityValid) issues.push(`identity rejected ${invalidIdentityIds.length} rows; duplicates ${duplicateCount}`);
  if (!countValid) {
    issues.push(`expected at least ${expectedListings} listings (${OKX_REVIEWED_PERP_MINIMUMS.swap} SWAP + ${OKX_REVIEWED_PERP_MINIMUMS.xperp} X-Perp), got ${instruments.length} (${swapListings} + ${xPerpListings})`);
  }
  if (!marketCoverageValid) issues.push('ticker, mark, or open-interest coverage is not a complete catalog join');
  return {
    valid: identityValid && countValid && marketCoverageValid,
    identityValid,
    countValid,
    marketCoverageValid,
    expectedListings,
    listingCount: instruments.length,
    listingDelta: instruments.length - expectedListings,
    growthDetected: instruments.length > expectedListings,
    uniqueListingCount: uniqueIds.size,
    swapListings,
    xPerpListings,
    duplicateCount,
    invalidIdentityCount: invalidIdentityIds.length,
    invalidIdentitySample: invalidIdentityIds.slice(0, 5),
    coverage: { tickers: tickerCoverage, marks: markCoverage, openInterest: openInterestCoverage },
    reason: validationReason(issues),
  };
}

export function validateOkxSpotSnapshot(payload) {
  const instruments = Array.isArray(payload?.instruments) ? payload.instruments : [];
  const instIds = instruments.map(row => normalizedUpper(row?.instId)).filter(Boolean);
  const uniqueIds = new Set(instIds);
  const duplicateCount = instIds.length - uniqueIds.size;
  const invalidIdentityIds = instruments
    .filter(row => !okxSpotIdentity(row))
    .map(row => normalizedUpper(row?.instId) || '(missing instId)');
  const utsListings = instruments.filter(row => normalized(row?.instCategory) === '3').length;
  const goldIds = new Set(instruments
    .filter(row => normalized(row?.instCategory) === '1' && OKX_SPOT_GOLD_EXCEPTIONS[normalizedUpper(row?.instId)])
    .map(row => normalizedUpper(row?.instId)));
  const expectedListings = PRODUCTION_BASELINES.spot.okx;
  const tickerCoverage = summarizeResourceCoverage(payload?.tickers, uniqueIds, payload?.coverage?.tickers);
  const identityValid = invalidIdentityIds.length === 0 && duplicateCount === 0;
  const countValid = instruments.length >= OKX_REVIEWED_SPOT_MINIMUMS.total &&
    uniqueIds.size >= OKX_REVIEWED_SPOT_MINIMUMS.total &&
    utsListings >= OKX_REVIEWED_SPOT_MINIMUMS.uts &&
    goldIds.size === OKX_REVIEWED_SPOT_MINIMUMS.gold &&
    Object.keys(OKX_SPOT_GOLD_EXCEPTIONS).every(instId => goldIds.has(instId));
  const marketCoverageValid = tickerCoverage.valid;
  const issues = [];
  if (!identityValid) issues.push(`identity rejected ${invalidIdentityIds.length} rows; duplicates ${duplicateCount}`);
  if (!countValid) {
    issues.push(`expected at least ${expectedListings} listings (${OKX_REVIEWED_SPOT_MINIMUMS.uts} UTS + ${OKX_REVIEWED_SPOT_MINIMUMS.gold} gold), got ${instruments.length} (${utsListings} + ${goldIds.size})`);
  }
  if (!marketCoverageValid) issues.push('ticker coverage is not a complete catalog join');
  return {
    valid: identityValid && countValid && marketCoverageValid,
    identityValid,
    countValid,
    marketCoverageValid,
    expectedListings,
    listingCount: instruments.length,
    listingDelta: instruments.length - expectedListings,
    growthDetected: instruments.length > expectedListings,
    uniqueListingCount: uniqueIds.size,
    utsListings,
    goldListings: goldIds.size,
    duplicateCount,
    invalidIdentityCount: invalidIdentityIds.length,
    invalidIdentitySample: invalidIdentityIds.slice(0, 5),
    coverage: { tickers: tickerCoverage },
    reason: validationReason(issues),
  };
}

export async function probeOkxMarkets(baseUrl) {
  const definitions = [
    ['perp', 'perp-snapshot', validateOkxPerpSnapshot],
    ['spot', 'spot-snapshot', validateOkxSpotSnapshot],
  ];
  const checks = [];
  // These self-probes deliberately run one at a time. Each route already uses
  // bulk OKX resources, so retrying or fanning them out would amplify a cold start.
  for (const [market, type, validate] of definitions) {
    const startedAt = Date.now();
    try {
      const payload = await fetchJsonWithPolicy(
        `${baseUrl}/api/okx-market?type=${type}`,
        {},
        { timeoutMs: 10_000, retries: 0 },
      );
      const validation = validate(payload);
      checks.push(checkResult(`okx-${market}-market`, validation.valid ? 'pass' : 'fail', {
        latencyMs: Date.now() - startedAt,
        ...validation,
      }, { critical: !validation.identityValid }));
    } catch (error) {
      checks.push(checkResult(`okx-${market}-market`, 'warn', {
        latencyMs: Date.now() - startedAt,
        reason: error.message,
      }));
    }
  }
  return checks;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const baseUrl = deploymentBaseUrl(req);
  // Each sibling route owns its upstream retry policy, so the health layer
  // never retries a full route again. Five-way bounded concurrency keeps the
  // worst-case self-probe wall time within this Function's 60-second budget;
  // the two OKX snapshots remain one sequential job.
  const checks = [await probePage(baseUrl)];
  const probeJobs = [
    () => probeReferences(baseUrl),
    () => probeUsMarketDirectory(baseUrl),
    () => probeListingAudit(baseUrl),
    () => probeSignalRadar(baseUrl),
    () => probeOkxMarkets(baseUrl),
    ...Object.entries(FUNDING_PROBES).map(([venue, symbol]) =>
      () => probeFunding(baseUrl, venue, symbol)),
  ];
  const groupedChecks = await mapWithConcurrency(probeJobs, 5, job => job());
  checks.push(...groupedChecks.flat());
  const assessment = assessChecks(checks);
  const payload = {
    service: 'avenir-rwa-analyst',
    environment: process.env.VERCEL_ENV || 'unknown',
    deployment: process.env.VERCEL_URL || null,
    commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    generatedAt: new Date().toISOString(),
    ...assessment,
    baselines: PRODUCTION_BASELINES,
    checks,
  };

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-RWA-Health-Status', assessment.status);
  const summary = { status: assessment.status, counts: assessment.counts, commit: payload.commit };
  if (assessment.status === 'unhealthy') console.error('[rwa-health]', JSON.stringify(summary));
  else console.log('[rwa-health]', JSON.stringify(summary));
  return res.status(assessment.status === 'unhealthy' ? 503 : 200).json(payload);
}

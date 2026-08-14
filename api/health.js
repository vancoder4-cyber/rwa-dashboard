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
const SIGNAL_SNAPSHOT_MAX_AGE_MS = 2 * 60 * 60 * 1_000;
const SIGNAL_SNAPSHOT_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
const SIGNAL_VOLUME_DAILY_NAMESPACE = 'rwa-signal-volume-daily-v1';
const UTC_DAY_MS = 24 * 60 * 60 * 1_000;

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
  const cryptoCategoryCount = invalidAssetCategories.length + invalidVolumeCategories.length;
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
    responseStatusCoherent && assetsValid && volumeContractValid;
  const hardFailure = !contractValid || !fresh || identityConflict;
  const warmingOrDegraded = responseStatus !== 'full' || volumeStatus !== 'full' ||
    availableSources < expectedSources || persistence?.status === 'unavailable';
  const status = hardFailure ? 'fail' : warmingOrDegraded ? 'warn' : 'pass';

  let reason = null;
  if (identityConflict) reason = `${identityConflicts} cross-category identity conflict(s) detected by Signal Radar`;
  else if (!schemaValid) reason = 'Signal Radar schema version is invalid';
  else if (!sourcesValid || !coverageValid || !responseStatusCoherent) {
    reason = 'Signal Radar five-source coverage or status contract is invalid';
  }
  else if (!fresh) reason = 'Signal Radar snapshot is older than two hours or has a future timestamp';
  else if (!volumeContractValid) reason = 'Perpetual volume anomaly contract or row semantics are invalid';
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
      { timeoutMs:20_000, retries:0 },
    );
    const validation = validateSignalRadarSnapshot(payload);
    return checkResult('signal-radar-volume', validation.status, {
      latencyMs:Date.now() - startedAt,
      generatedAt:payload?.generatedAt || null,
      ...validation,
    }, { critical:validation.identityConflict || validation.cryptoCategoryCount > 0 });
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

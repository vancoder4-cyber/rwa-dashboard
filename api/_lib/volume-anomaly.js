import { createHash } from 'node:crypto';

export const PERP_VOLUME_ANOMALY_FORMULA_VERSION = 'rwa-perp-volume-anomaly-1.0';
export const PERP_VOLUME_BASELINE_DAYS = 7;
export const PERP_VOLUME_FREQUENCY_DAYS = 30;
export const PERP_VOLUME_HISTORY_DAYS = 45;
export const PERP_VOLUME_HIGH_FREQUENCY_MIN_ELIGIBLE_DAYS = 21;
export const PERP_VOLUME_HIGH_FREQUENCY_MIN_ANOMALY_DAYS = 6;
export const PERP_VOLUME_CONSECUTIVE_EXPANSION_DAYS = 2;
export const PERP_VOLUME_ANOMALY_THRESHOLDS = Object.freeze({
  high:2,
  medium:1.5,
  down:0.4,
});

const DAY_MS = 24 * 60 * 60 * 1_000;
const HISTORY_MAX_BYTES = 1_750_000;
const CATEGORY_CODES = Object.freeze({
  equity:'e',
  etf:'t',
  commodity:'c',
  index:'i',
  fx:'f',
  'pre-ipo':'p',
  bond:'b',
});
const CODE_CATEGORIES = Object.freeze(Object.fromEntries(
  Object.entries(CATEGORY_CODES).map(([category, code]) => [code, category]),
));

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function utcVolumeDay(timestampMs) {
  const numeric = finiteOrNull(timestampMs);
  return numeric === null ? null : Math.floor(numeric / DAY_MS) * DAY_MS;
}

function identityKey(symbol, category) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const normalizedCategory = String(category || '').trim().toLowerCase();
  return normalizedSymbol && normalizedCategory ? `${normalizedCategory}:${normalizedSymbol}` : null;
}

function encodeCategory(category) {
  const normalized = String(category || '').trim().toLowerCase();
  return CATEGORY_CODES[normalized] || normalized;
}

function decodeCategory(code) {
  const normalized = String(code || '').trim().toLowerCase();
  return CODE_CATEGORIES[normalized] || normalized;
}

function assetCohortFingerprint(asset) {
  const listings = Array.isArray(asset?.listings) ? asset.listings : [];
  if (!listings.length || listings.length !== Number(asset?.listingCount)) return null;
  const members = listings.map(listing => {
    const venue = String(listing?.venue || '').trim().toLowerCase();
    const venueSymbol = String(listing?.venueSymbol || '').trim().toUpperCase();
    const volumeMethod = String(listing?.volumeMethod || '').trim().toLowerCase();
    return venue && venueSymbol && volumeMethod ? `${venue}:${venueSymbol}:${volumeMethod}` : null;
  });
  if (members.some(member => !member)) return null;
  const canonical = [...new Set(members)].sort();
  if (canonical.length !== listings.length) return null;
  return createHash('sha256').update(canonical.join('|')).digest('base64url').slice(0, 12);
}

function completeAssetVolume(asset) {
  if (String(asset?.fieldStatus?.volume24hUsd || '').toLowerCase() !== 'full') return null;
  const listings = Array.isArray(asset?.listings) ? asset.listings : [];
  if (!listings.length || listings.length !== Number(asset?.listingCount)) return null;
  const values = listings.map(listing => {
    const status = String(listing?.volumeStatus || '').trim().toLowerCase();
    const method = String(listing?.volumeMethod || '').trim();
    const value = finiteOrNull(listing?.volume24hUsd);
    if (!['full','estimated'].includes(status) || !method || value === null || value < 0) return null;
    return value;
  });
  if (values.some(value => value === null)) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

export function compactDailyVolumeSnapshot(assets, capturedAtMs, options = {}) {
  const captured = finiteOrNull(capturedAtMs);
  const day = utcVolumeDay(options.dayMs ?? captured);
  if (captured === null || day === null) throw new TypeError('Invalid daily volume snapshot timestamp');
  const source = Array.isArray(assets) ? assets : [];
  const limit = Number.isFinite(options.limit) ? Math.max(0, Number(options.limit)) : Infinity;
  const selected = Number.isFinite(limit) ? source.slice(0, limit) : source;
  const rows = selected
    .map(asset => {
      const symbol = String(asset?.symbol || '').trim().toUpperCase();
      const category = String(asset?.category || '').trim().toLowerCase();
      if (!identityKey(symbol, category)) return null;
      const cohort = assetCohortFingerprint(asset);
      const volume = cohort ? completeAssetVolume(asset) : null;
      return [symbol, encodeCategory(category), round(volume, 2), cohort];
    })
    .filter(Boolean)
    .sort((left, right) => `${left[1]}:${left[0]}`.localeCompare(`${right[1]}:${right[0]}`));
  return { d:day, t:captured, a:rows };
}

function validDailySnapshot(snapshot, nowDay, nowMs) {
  if (!snapshot || !Array.isArray(snapshot.a)) return null;
  const capturedAtMs = finiteOrNull(snapshot.t);
  const rawDay = finiteOrNull(snapshot.d);
  const day = utcVolumeDay(rawDay ?? capturedAtMs);
  if (capturedAtMs === null || rawDay === null || day === null || day !== rawDay || day > nowDay ||
      capturedAtMs > nowMs ||
      utcVolumeDay(capturedAtMs) !== day) return null;
  return { d:day, t:capturedAtMs, a:snapshot.a };
}

export function dailyVolumeHistoryBytes(history) {
  return Buffer.byteLength(JSON.stringify(Array.isArray(history) ? history : []), 'utf8');
}

export function normalizeDailyVolumeHistory(history, nowMs = Date.now()) {
  const nowDay = utcVolumeDay(nowMs);
  if (nowDay === null) throw new TypeError('Invalid daily volume history clock');
  const cutoffDay = nowDay - (PERP_VOLUME_HISTORY_DAYS - 1) * DAY_MS;
  const byDay = new Map();
  for (const candidate of Array.isArray(history) ? history : []) {
    const snapshot = validDailySnapshot(candidate, nowDay, nowMs);
    if (!snapshot || snapshot.d < cutoffDay) continue;
    const existing = byDay.get(snapshot.d);
    if (!existing || snapshot.t > existing.t) byDay.set(snapshot.d, snapshot);
  }
  const normalized = [...byDay.values()]
    .sort((left, right) => left.d - right.d || left.t - right.t)
    .slice(-PERP_VOLUME_HISTORY_DAYS);
  const bytes = dailyVolumeHistoryBytes(normalized);
  if (bytes > HISTORY_MAX_BYTES) {
    throw new RangeError(`Daily volume history exceeds ${HISTORY_MAX_BYTES} bytes (${bytes})`);
  }
  return normalized;
}

export function mergeDailyVolumeHistory(history, currentSnapshot, nowMs = Date.now()) {
  const nowDay = utcVolumeDay(nowMs);
  if (nowDay === null) throw new TypeError('Invalid daily volume history clock');
  const current = validDailySnapshot(currentSnapshot, nowDay, nowMs);
  if (!current) throw new TypeError('Invalid current daily volume snapshot');
  const byDay = new Map(normalizeDailyVolumeHistory(history, nowMs).map(snapshot => [snapshot.d, snapshot]));
  const existing = byDay.get(current.d);
  if (!existing || current.t >= existing.t) byDay.set(current.d, current);
  return normalizeDailyVolumeHistory([...byDay.values()], nowMs);
}

function dailyRowsByIdentity(snapshots) {
  const days = new Map();
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const day = utcVolumeDay(snapshot?.d);
    if (day === null || !Array.isArray(snapshot?.a)) continue;
    const rows = new Map();
    for (const compactRow of snapshot.a) {
      if (!Array.isArray(compactRow) || compactRow.length < 4) continue;
      const symbol = String(compactRow[0] || '').trim().toUpperCase();
      const category = decodeCategory(compactRow[1]);
      const key = identityKey(symbol, category);
      const volume = finiteOrNull(compactRow[2]);
      const cohort = String(compactRow[3] || '');
      if (!key || volume === null || volume < 0 || !cohort) continue;
      rows.set(key, { symbol, category, volume, cohort });
    }
    days.set(day, rows);
  }
  return days;
}

function volumeLevel(ratio) {
  if (!Number.isFinite(ratio)) return 'unavailable';
  if (ratio >= PERP_VOLUME_ANOMALY_THRESHOLDS.high) return 'high';
  if (ratio >= PERP_VOLUME_ANOMALY_THRESHOLDS.medium) return 'medium';
  if (ratio <= PERP_VOLUME_ANOMALY_THRESHOLDS.down) return 'down';
  return 'normal';
}

function evaluateVolumeDay(days, key, day) {
  const current = days.get(day)?.get(key) || null;
  if (!current) return { ready:false, observedBaselineDays:0, cohortStable:false };
  const baseline = [];
  let cohortStable = true;
  for (let offset = 1; offset <= PERP_VOLUME_BASELINE_DAYS; offset += 1) {
    const row = days.get(day - offset * DAY_MS)?.get(key) || null;
    if (!row || row.cohort !== current.cohort) {
      cohortStable = false;
      continue;
    }
    baseline.push(row.volume);
  }
  if (baseline.length !== PERP_VOLUME_BASELINE_DAYS) {
    return {
      ready:false,
      currentVolumeUsd:current.volume,
      cohort:current.cohort,
      observedBaselineDays:baseline.length,
      cohortStable,
    };
  }
  // Publish and classify against the same cent-rounded USD baseline. This
  // keeps the displayed numerator, denominator, ratio, and health contract
  // arithmetically reproducible instead of hiding extra denominator precision.
  const average7dVolumeUsd = round(
    baseline.reduce((sum, value) => sum + value, 0) / baseline.length,
    2,
  );
  if (!(average7dVolumeUsd > 0)) {
    return {
      ready:false,
      currentVolumeUsd:current.volume,
      cohort:current.cohort,
      average7dVolumeUsd,
      observedBaselineDays:baseline.length,
      cohortStable:true,
    };
  }
  // Classification and the public ratio must use the exact same precision;
  // otherwise a row can display 2.0000× while remaining MEDIUM internally.
  const ratio7d = round(current.volume / average7dVolumeUsd, 4);
  return {
    ready:true,
    currentVolumeUsd:current.volume,
    cohort:current.cohort,
    average7dVolumeUsd,
    ratio7d,
    level:volumeLevel(ratio7d),
    observedBaselineDays:baseline.length,
    cohortStable:true,
  };
}

function frequencyForIdentity(days, key, currentDay, currentCohort) {
  const evaluations = [];
  // Frequency only uses sealed daily anchors. The live current 24h value is
  // never counted as a completed anomaly day.
  for (let offset = PERP_VOLUME_FREQUENCY_DAYS; offset >= 1; offset -= 1) {
    const day = currentDay - offset * DAY_MS;
    const evaluation = evaluateVolumeDay(days, key, day);
    if (evaluation.ready && evaluation.cohort === currentCohort) evaluations.push({ day, ...evaluation });
  }
  const counts = { high:0, medium:0, down:0, normal:0 };
  evaluations.forEach(evaluation => { counts[evaluation.level] += 1; });
  const anomalyDays = counts.high + counts.medium + counts.down;
  let consecutiveExpansionDays = 0;
  for (let offset = 1; offset <= PERP_VOLUME_FREQUENCY_DAYS; offset += 1) {
    const evaluation = evaluateVolumeDay(days, key, currentDay - offset * DAY_MS);
    if (!evaluation.ready || evaluation.cohort !== currentCohort ||
        !['high','medium'].includes(evaluation.level)) break;
    consecutiveExpansionDays += 1;
  }
  const eligibleDays = evaluations.length;
  const highFrequency = eligibleDays >= PERP_VOLUME_HIGH_FREQUENCY_MIN_ELIGIBLE_DAYS &&
    anomalyDays >= PERP_VOLUME_HIGH_FREQUENCY_MIN_ANOMALY_DAYS;
  return {
    status:eligibleDays >= PERP_VOLUME_FREQUENCY_DAYS ? 'full' : eligibleDays ? 'partial' : 'warming',
    eligibleDays,
    expectedDays:PERP_VOLUME_FREQUENCY_DAYS,
    anomalyDays,
    highDays:counts.high,
    mediumDays:counts.medium,
    downDays:counts.down,
    expansionDays:counts.high + counts.medium,
    consecutiveExpansionDays,
    highFrequency,
  };
}

function unavailableVolumeAnomaly(asset, baselineStatus, observedBaselineDays = 0) {
  return {
    symbol:String(asset?.symbol || '').toUpperCase(),
    category:String(asset?.category || '').toLowerCase(),
    venues:Array.isArray(asset?.venues) ? asset.venues : [],
    listingCount:Number(asset?.listingCount) || 0,
    currentVolumeUsd:null,
    average7dVolumeUsd:null,
    ratio7d:null,
    level:'unavailable',
    status:'unavailable',
    coverageStatus:'unavailable',
    baseline:{
      status:baselineStatus,
      observedDays:observedBaselineDays,
      expectedDays:PERP_VOLUME_BASELINE_DAYS,
      cohortStable:false,
    },
    frequency30d:{
      status:'warming', eligibleDays:0, expectedDays:PERP_VOLUME_FREQUENCY_DAYS,
      anomalyDays:0, highDays:0, mediumDays:0, downDays:0, expansionDays:0,
      consecutiveExpansionDays:0, highFrequency:false,
    },
    flags:[],
  };
}

function anomalyPriority(row) {
  if (row.level === 'high') return 0;
  if (row.level === 'down') return 1;
  if (row.level === 'medium') return 2;
  return 3;
}

export function buildPerpVolumeAnomalies(assets, dailyHistory, capturedAtMs, options = {}) {
  const monitored = Array.isArray(assets) ? assets : [];
  const captured = finiteOrNull(capturedAtMs);
  const currentDay = utcVolumeDay(captured);
  const snapshotComparable = options.snapshotComparable !== false;
  let historyAvailable = options.historyAvailable !== false;
  if (captured === null || currentDay === null) throw new TypeError('Invalid volume anomaly timestamp');

  let storedHistory = [];
  if (historyAvailable) {
    try {
      storedHistory = normalizeDailyVolumeHistory(dailyHistory, captured)
        .filter(snapshot => snapshot.d < currentDay);
    } catch {
      historyAvailable = false;
    }
  }
  const currentSnapshot = compactDailyVolumeSnapshot(monitored, captured, { dayMs:currentDay });
  const days = dailyRowsByIdentity([...storedHistory, currentSnapshot]);
  const priorStoredDays = storedHistory.length;
  let readyAssets = 0;
  let frequencyReadyAssets = 0;
  const evaluations = monitored.map(asset => {
    const key = identityKey(asset?.symbol, asset?.category);
    if (!key || !historyAvailable) return unavailableVolumeAnomaly(asset, 'unavailable');
    if (!snapshotComparable) {
      return unavailableVolumeAnomaly(asset,
        priorStoredDays >= PERP_VOLUME_BASELINE_DAYS ? 'partial' : 'warming');
    }
    const evaluation = evaluateVolumeDay(days, key, currentDay);
    if (!evaluation.ready) {
      const baselineStatus = priorStoredDays < PERP_VOLUME_BASELINE_DAYS ? 'warming' : 'partial';
      return unavailableVolumeAnomaly(asset, baselineStatus, evaluation.observedBaselineDays || 0);
    }
    readyAssets += 1;
    const frequency30d = frequencyForIdentity(days, key, currentDay, evaluation.cohort);
    if (frequency30d.status === 'full') frequencyReadyAssets += 1;
    const flags = [];
    if (frequency30d.consecutiveExpansionDays >= PERP_VOLUME_CONSECUTIVE_EXPANSION_DAYS) {
      flags.push('CONSECUTIVE_EXPANSION');
    }
    if (frequency30d.highFrequency) flags.push('HIGH_FREQUENCY_ANOMALY');
    return {
      symbol:String(asset?.symbol || '').toUpperCase(),
      category:String(asset?.category || '').toLowerCase(),
      venues:Array.isArray(asset?.venues) ? asset.venues : [],
      listingCount:Number(asset?.listingCount) || 0,
      currentVolumeUsd:round(evaluation.currentVolumeUsd, 2),
      average7dVolumeUsd:round(evaluation.average7dVolumeUsd, 2),
      ratio7d:round(evaluation.ratio7d, 4),
      level:evaluation.level,
      status:'estimated',
      coverageStatus:'full',
      baseline:{
        status:'full',
        observedDays:evaluation.observedBaselineDays,
        expectedDays:PERP_VOLUME_BASELINE_DAYS,
        cohortStable:evaluation.cohortStable,
      },
      frequency30d,
      flags,
    };
  });

  const rows = evaluations
    .filter(row => ['high','medium','down'].includes(row.level))
    .sort((left, right) => {
      const priority = anomalyPriority(left) - anomalyPriority(right);
      if (priority) return priority;
      if (left.level === 'down') {
        return left.ratio7d - right.ratio7d || right.currentVolumeUsd - left.currentVolumeUsd;
      }
      return right.ratio7d - left.ratio7d || right.currentVolumeUsd - left.currentVolumeUsd;
    })
    .map((row, index) => ({ rank:index + 1, ...row }));
  const counts = {
    high:rows.filter(row => row.level === 'high').length,
    medium:rows.filter(row => row.level === 'medium').length,
    down:rows.filter(row => row.level === 'down').length,
    highFrequency:rows.filter(row => row.frequency30d.highFrequency).length,
  };
  const status = !historyAvailable
    ? 'unavailable'
    : !snapshotComparable
      ? 'partial'
      : priorStoredDays < PERP_VOLUME_BASELINE_DAYS
        ? 'warming'
        : readyAssets === monitored.length && frequencyReadyAssets === monitored.length
          ? 'full'
          : 'partial';

  return {
    formulaVersion:PERP_VOLUME_ANOMALY_FORMULA_VERSION,
    generatedAt:new Date(captured).toISOString(),
    status,
    scope:'All identity-verified RWA perpetual canonical assets from the current five-source snapshot',
    monitoredAssets:monitored.length,
    readyAssets,
    frequencyReadyAssets,
    counts,
    history:{
      storedDays:storedHistory.length,
      priorStoredDays,
      retentionDays:PERP_VOLUME_HISTORY_DAYS,
      baselineDays:PERP_VOLUME_BASELINE_DAYS,
      frequencyWindowDays:PERP_VOLUME_FREQUENCY_DAYS,
      oldestAt:storedHistory[0]?.d ? new Date(storedHistory[0].d).toISOString() : null,
      newestAt:storedHistory.at(-1)?.d ? new Date(storedHistory.at(-1).d).toISOString() : null,
    },
    methodology:{
      currentVolume:'Current rolling 24h USD contract volume across a stable exact venue-instrument cohort',
      baseline:'Mean of the prior seven sealed UTC-date rolling-24h anchor observations for the same exact cohort',
      thresholds:{ ...PERP_VOLUME_ANOMALY_THRESHOLDS },
      frequencyWindowDays:PERP_VOLUME_FREQUENCY_DAYS,
      highFrequencyMinEligibleDays:PERP_VOLUME_HIGH_FREQUENCY_MIN_ELIGIBLE_DAYS,
      highFrequencyMinAnomalyDays:PERP_VOLUME_HIGH_FREQUENCY_MIN_ANOMALY_DAYS,
      consecutiveExpansionMinDays:PERP_VOLUME_CONSECUTIVE_EXPANSION_DAYS,
      note:'Ratios are monitoring estimates. Missing fields, incomplete venue snapshots, or cohort changes never become DOWN alerts.',
    },
    rows,
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SIGNAL_ASSET_LIMIT,
  aggregateSignalListings,
} from '../api/_lib/signal-analysis.js';
import {
  PERP_VOLUME_HISTORY_DAYS,
  buildPerpVolumeAnomalies,
  compactDailyVolumeSnapshot,
  dailyVolumeHistoryBytes,
  mergeDailyVolumeHistory,
  normalizeDailyVolumeHistory,
} from '../api/_lib/volume-anomaly.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const CURRENT_DAY = Date.UTC(2026, 7, 14);
const CAPTURED_AT = CURRENT_DAY + 12 * HOUR_MS;

function volumeAsset(symbol, volume, options = {}) {
  const category = options.category || 'equity';
  const venue = options.venue || 'gate';
  const venueSymbol = options.venueSymbol || `${symbol}_USDT`;
  const volumeMethod = options.volumeMethod || 'official-quote-volume';
  const volumeStatus = options.volumeStatus || (volume === null || volume === undefined ? 'unavailable' : 'full');
  const aggregated = aggregateSignalListings([{
    symbol,
    category,
    venue,
    venueSymbol,
    priceUsd:100,
    volume24hUsd:volume,
    volumeMethod,
    volumeStatus,
    openInterestUsd:1,
    fundingRate:0,
    fundingIntervalHours:8,
    change24hPct:0,
  }], Infinity);
  assert.equal(aggregated.conflicts.length, 0);
  assert.equal(aggregated.allAssets.length, 1);
  return aggregated.allAssets[0];
}

function dailySnapshot(day, assets, capturedOffsetMs = HOUR_MS) {
  return compactDailyVolumeSnapshot(assets, day + capturedOffsetMs, { dayMs:day });
}

function historyForAssets(days, assetFactory) {
  return Array.from({ length:days }, (_, index) => {
    const day = CURRENT_DAY - (days - index) * DAY_MS;
    const assets = assetFactory(day, index);
    return dailySnapshot(day, Array.isArray(assets) ? assets : [assets]);
  });
}

function rowFor(payload, symbol) {
  return payload.rows.find(row => row.symbol === symbol);
}

test('perpetual volume anomaly thresholds include exact HIGH, MEDIUM, and DOWN boundaries', () => {
  const baselineAssets = [
    volumeAsset('HIGHA', 100),
    volumeAsset('MEDA', 100),
    volumeAsset('DOWNA', 100),
  ];
  const history = historyForAssets(7, () => baselineAssets);
  const current = [
    volumeAsset('HIGHA', 200),
    volumeAsset('MEDA', 150),
    volumeAsset('DOWNA', 40),
  ];

  const result = buildPerpVolumeAnomalies(current, history, CAPTURED_AT);
  assert.equal(rowFor(result, 'HIGHA').ratio7d, 2);
  assert.equal(rowFor(result, 'HIGHA').level, 'high');
  assert.equal(rowFor(result, 'MEDA').ratio7d, 1.5);
  assert.equal(rowFor(result, 'MEDA').level, 'medium');
  assert.equal(rowFor(result, 'DOWNA').ratio7d, 0.4);
  assert.equal(rowFor(result, 'DOWNA').level, 'down');
  assert.deepEqual(result.counts, { high:1, medium:1, down:1, highFrequency:0 });
});

test('published ratio precision and server level cannot disagree at a threshold', () => {
  const baselineVolumes = [100.01, 100, 100, 100, 100, 100, 100];
  const history = historyForAssets(7, (_day, index) => volumeAsset('ROUNDA', baselineVolumes[index]));
  const result = buildPerpVolumeAnomalies([volumeAsset('ROUNDA', 200)], history, CAPTURED_AT);
  const row = rowFor(result, 'ROUNDA');
  assert.equal(row.ratio7d, 2);
  assert.equal(row.level, 'high');
});

test('a real zero can be DOWN while null current or baseline volume stays unavailable', () => {
  const zeroHistory = historyForAssets(7, () => volumeAsset('ZEROA', 100));
  const zero = buildPerpVolumeAnomalies([volumeAsset('ZEROA', 0)], zeroHistory, CAPTURED_AT);
  assert.equal(zero.rows.length, 1);
  assert.equal(zero.rows[0].currentVolumeUsd, 0);
  assert.equal(zero.rows[0].ratio7d, 0);
  assert.equal(zero.rows[0].level, 'down');

  const missingCurrent = buildPerpVolumeAnomalies(
    [volumeAsset('NULLA', null)],
    historyForAssets(7, () => volumeAsset('NULLA', 100)),
    CAPTURED_AT,
  );
  assert.equal(missingCurrent.readyAssets, 0);
  assert.deepEqual(missingCurrent.rows, []);

  const missingBaseline = historyForAssets(7, (_day, index) =>
    volumeAsset('MISSA', index === 3 ? null : 100));
  const baselineUnavailable = buildPerpVolumeAnomalies(
    [volumeAsset('MISSA', 0)],
    missingBaseline,
    CAPTURED_AT,
  );
  assert.equal(baselineUnavailable.readyAssets, 0);
  assert.deepEqual(baselineUnavailable.rows, []);
});

test('the seven-day baseline requires exact consecutive UTC days', () => {
  const missingSeventhDay = [1, 2, 3, 4, 5, 6, 8].map(offset =>
    dailySnapshot(CURRENT_DAY - offset * DAY_MS, [volumeAsset('GAPA', 100)]));
  const unavailable = buildPerpVolumeAnomalies(
    [volumeAsset('GAPA', 200)],
    missingSeventhDay,
    CAPTURED_AT,
  );
  assert.equal(unavailable.readyAssets, 0);
  assert.deepEqual(unavailable.rows, []);

  const continuous = buildPerpVolumeAnomalies(
    [volumeAsset('GAPA', 200)],
    historyForAssets(7, () => volumeAsset('GAPA', 100)),
    CAPTURED_AT,
  );
  assert.equal(continuous.readyAssets, 1);
  assert.equal(continuous.rows[0].level, 'high');
});

test('listing cohort or volume-method changes reset the seven-day baseline', () => {
  const cohortHistory = historyForAssets(7, (_day, index) => volumeAsset('COHORTA', 100, {
    venueSymbol:index === 2 ? 'COHORTA_ALT_USDT' : 'COHORTA_USDT',
  }));
  const cohortChanged = buildPerpVolumeAnomalies(
    [volumeAsset('COHORTA', 200, { venueSymbol:'COHORTA_USDT' })],
    cohortHistory,
    CAPTURED_AT,
  );
  assert.equal(cohortChanged.readyAssets, 0);
  assert.deepEqual(cohortChanged.rows, []);

  const methodHistory = historyForAssets(7, (_day, index) => volumeAsset('METHODA', 100, {
    volumeMethod:index === 4 ? 'base-volume-x-price' : 'official-quote-volume',
  }));
  const methodChanged = buildPerpVolumeAnomalies(
    [volumeAsset('METHODA', 200)],
    methodHistory,
    CAPTURED_AT,
  );
  assert.equal(methodChanged.readyAssets, 0);
  assert.deepEqual(methodChanged.rows, []);
});

test('30-day frequency excludes the live current observation', () => {
  const history = historyForAssets(37, () => volumeAsset('LIVEA', 100));
  const result = buildPerpVolumeAnomalies([volumeAsset('LIVEA', 200)], history, CAPTURED_AT);
  const row = rowFor(result, 'LIVEA');
  assert.equal(row.level, 'high');
  assert.equal(row.frequency30d.status, 'full');
  assert.equal(row.frequency30d.eligibleDays, 30);
  assert.equal(row.frequency30d.anomalyDays, 0);
});

test('30-day frequency resets when the exact venue-instrument cohort changes', () => {
  const oldAnomalyOffsets = new Set([30, 26, 22, 18, 14, 10]);
  const history = Array.from({ length:37 }, (_, index) => {
    const offset = 37 - index;
    const currentCohort = offset <= 7;
    const volume = !currentCohort && oldAnomalyOffsets.has(offset) ? 0 : 100;
    return dailySnapshot(CURRENT_DAY - offset * DAY_MS, [volumeAsset('RESETA', volume, {
      venueSymbol:currentCohort ? 'RESETA_NEW_USDT' : 'RESETA_OLD_USDT',
    })]);
  });
  const result = buildPerpVolumeAnomalies([
    volumeAsset('RESETA', 200, { venueSymbol:'RESETA_NEW_USDT' }),
  ], history, CAPTURED_AT);
  const row = rowFor(result, 'RESETA');

  assert.equal(row.level, 'high');
  assert.equal(row.frequency30d.status, 'warming');
  assert.equal(row.frequency30d.eligibleDays, 0);
  assert.equal(row.frequency30d.anomalyDays, 0);
  assert.equal(row.frequency30d.highFrequency, false);
  assert.deepEqual(row.flags, []);
});

test('30-day frequency flags six anomalies and two consecutive expansion days', () => {
  const volumes = Array(37).fill(100);
  const indexForOffset = offset => volumes.length - offset;
  for (const offset of [30, 25, 20, 15, 10, 6]) volumes[indexForOffset(offset)] = 0;
  volumes[indexForOffset(2)] = 200;
  volumes[indexForOffset(1)] = 200;
  const history = historyForAssets(37, (_day, index) => volumeAsset('FREQA', volumes[index]));
  const result = buildPerpVolumeAnomalies([volumeAsset('FREQA', 200)], history, CAPTURED_AT);
  const row = rowFor(result, 'FREQA');

  assert.equal(row.frequency30d.status, 'full');
  assert.equal(row.frequency30d.eligibleDays, 30);
  assert.ok(row.frequency30d.anomalyDays >= 6);
  assert.equal(row.frequency30d.consecutiveExpansionDays, 2);
  assert.equal(row.frequency30d.highFrequency, true);
  assert.ok(row.flags.includes('CONSECUTIVE_EXPANSION'));
  assert.ok(row.flags.includes('HIGH_FREQUENCY_ANOMALY'));
});

test('high-frequency flag requires both 21 eligible days and six anomaly days', () => {
  const scenario = (days, anomalyOffsets, symbol) => {
    const volumes = Array(days).fill(100);
    for (const offset of anomalyOffsets) volumes[days - offset] = 0;
    const history = historyForAssets(days, (_day, index) => volumeAsset(symbol, volumes[index]));
    return rowFor(
      buildPerpVolumeAnomalies([volumeAsset(symbol, 200)], history, CAPTURED_AT),
      symbol,
    ).frequency30d;
  };

  const exactBoundary = scenario(28, [21, 17, 13, 9, 5, 1], 'BOUNDARYA');
  assert.equal(exactBoundary.eligibleDays, 21);
  assert.equal(exactBoundary.anomalyDays, 6);
  assert.equal(exactBoundary.highFrequency, true);

  const tooFewEligible = scenario(27, [20, 16, 12, 8, 4, 1], 'SHORTA');
  assert.equal(tooFewEligible.eligibleDays, 20);
  assert.equal(tooFewEligible.anomalyDays, 6);
  assert.equal(tooFewEligible.highFrequency, false);

  const tooFewAnomalies = scenario(28, [21, 17, 13, 9, 5], 'QUIETA');
  assert.equal(tooFewAnomalies.eligibleDays, 21);
  assert.equal(tooFewAnomalies.anomalyDays, 5);
  assert.equal(tooFewAnomalies.highFrequency, false);
});

test('daily history merge is same-day idempotent and keeps the latest retry', () => {
  const early = dailySnapshot(CURRENT_DAY, [volumeAsset('RETRYA', 100)], HOUR_MS);
  const later = dailySnapshot(CURRENT_DAY, [volumeAsset('RETRYA', 200)], 2 * HOUR_MS);
  const staleRetry = dailySnapshot(CURRENT_DAY, [volumeAsset('RETRYA', 50)], HOUR_MS + 30 * 60 * 1_000);

  const first = mergeDailyVolumeHistory([], early, CAPTURED_AT);
  const replaced = mergeDailyVolumeHistory(first, later, CAPTURED_AT);
  const unchanged = mergeDailyVolumeHistory(replaced, staleRetry, CAPTURED_AT);
  assert.equal(first.length, 1);
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].a[0][2], 200);
  assert.deepEqual(unchanged, replaced);
});

test('a future same-day cache entry cannot block the current writer', () => {
  const future = dailySnapshot(CURRENT_DAY, [volumeAsset('FUTUREA', 999)], 23 * HOUR_MS);
  const current = dailySnapshot(CURRENT_DAY, [volumeAsset('FUTUREA', 100)], 12 * HOUR_MS);

  assert.deepEqual(normalizeDailyVolumeHistory([future], CAPTURED_AT), []);
  const merged = mergeDailyVolumeHistory([future], current, CAPTURED_AT);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].t, CAPTURED_AT);
  assert.equal(merged[0].a[0][2], 100);
});

test('daily history retains only the newest 45 UTC day buckets', () => {
  const history = Array.from({ length:49 }, (_, index) => {
    const day = CURRENT_DAY - (49 - index) * DAY_MS;
    return dailySnapshot(day, [volumeAsset('TRIMA', index + 1)]);
  });
  const current = dailySnapshot(CURRENT_DAY, [volumeAsset('TRIMA', 50)]);
  const merged = mergeDailyVolumeHistory(history, current, CAPTURED_AT);

  assert.equal(PERP_VOLUME_HISTORY_DAYS, 45);
  assert.equal(merged.length, 45);
  assert.equal(merged[0].d, CURRENT_DAY - 44 * DAY_MS);
  assert.equal(merged.at(-1).d, CURRENT_DAY);
  assert.equal(new Set(merged.map(snapshot => snapshot.d)).size, merged.length);
});

test('daily history rejects an item above the Runtime Cache safety budget', () => {
  const oversized = {
    d:CURRENT_DAY,
    t:CURRENT_DAY + HOUR_MS,
    a:[['X'.repeat(1_750_000), 'e', 1, 'same-cohort']],
  };
  assert.ok(dailyVolumeHistoryBytes([oversized]) > 1_750_000);
  assert.throws(
    () => mergeDailyVolumeHistory([], oversized, CAPTURED_AT),
    error => error instanceof RangeError && /exceeds 1750000 bytes/.test(error.message),
  );
});

test('daily volume persistence includes verified assets beyond the response Top 100', () => {
  const listings = Array.from({ length:125 }, (_, index) => ({
    symbol:`RWA${String(index).padStart(3, '0')}`,
    category:'equity',
    venue:'gate',
    venueSymbol:`RWA${String(index).padStart(3, '0')}_USDT`,
    priceUsd:1,
    volume24hUsd:index + 1,
    volumeMethod:'official-quote-volume',
    volumeStatus:'full',
    openInterestUsd:index + 1,
    fundingRate:0,
    fundingIntervalHours:8,
  }));
  const aggregated = aggregateSignalListings(listings);
  const daily = compactDailyVolumeSnapshot(aggregated.allAssets, CAPTURED_AT, { dayMs:CURRENT_DAY });

  assert.equal(SIGNAL_ASSET_LIMIT, 100);
  assert.equal(aggregated.assets.length, SIGNAL_ASSET_LIMIT);
  assert.equal(aggregated.allAssets.length, 125);
  assert.equal(aggregated.assets.some(asset => asset.symbol === 'RWA000'), false);
  assert.equal(daily.a.length, 125);
  assert.ok(daily.a.some(row => row[0] === 'RWA000'));
});

test('daily history normalization also enforces the capacity guard directly', () => {
  const oversized = [{
    d:CURRENT_DAY,
    t:CURRENT_DAY + HOUR_MS,
    a:[['Y'.repeat(1_750_000), 'e', 1, 'same-cohort']],
  }];
  assert.throws(() => normalizeDailyVolumeHistory(oversized, CAPTURED_AT), RangeError);
});

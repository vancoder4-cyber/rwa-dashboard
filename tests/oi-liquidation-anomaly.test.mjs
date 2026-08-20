import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OI_LIQUIDATION_FORMULA_VERSION,
  OI_LIQUIDATION_HISTORY_HOURS,
  OI_LIQUIDATION_HISTORY_MAX_BYTES,
  OI_LIQUIDATION_HISTORY_NAMESPACE,
  OI_LIQUIDATION_THRESHOLDS,
  OI_RANGE_FORMULA_VERSION,
  buildOiLiquidationAnomalies,
  compactOiHourlySnapshot,
  mergeOiHourlyHistory,
  normalizeBinanceTopTraderPositions,
  normalizeOiHourlyHistory,
  oiHourlyHistoryBytes,
} from '../api/_lib/oi-liquidation-anomaly.js';

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.parse('2026-08-14T12:30:00.000Z');
const CURRENT_HOUR = Math.floor(NOW / HOUR_MS) * HOUR_MS;
const CURRENT_DAY = Math.floor(NOW / DAY_MS) * DAY_MS;

function listing({
  venue = 'binance',
  venueSymbol = 'AAPLUSDT',
  volume24hUsd = 1_000_000.01,
  openInterestUsd = 7_000_000,
  volumeStatus = 'full',
  openInterestStatus = 'full',
  openInterestMethod = 'official-open-interest-usd',
  fundingRate = 0.0001,
  fundingIntervalHours = 8,
  change24hPct = 0,
  change24hMethod = change24hPct === null ? null : 'official-change-percent',
  change24hStatus = change24hPct === null ? 'unavailable' : 'full',
} = {}) {
  return {
    venue,
    venueSymbol,
    instrumentType:'perpetual',
    volume24hUsd,
    volumeMethod:'official-quote-volume-usd',
    volumeStatus,
    openInterestUsd,
    openInterestMethod,
    openInterestStatus,
    fundingRate,
    fundingIntervalHours,
    change24hPct,
    change24hMethod,
    change24hStatus,
  };
}

function asset(symbol = 'AAPL', {
  category = 'equity',
  venue = 'binance',
  venueSymbol = `${symbol}USDT`,
  volume24hUsd = 1_000_000.01,
  openInterestUsd = 7_000_000,
  openInterestMethod = 'official-open-interest-usd',
  listings = null,
} = {}) {
  const resolvedListings = typeof listings === 'function' ? listings(openInterestUsd) : listings;
  const rows = resolvedListings || [listing({
    venue,
    venueSymbol,
    volume24hUsd,
    openInterestUsd,
    openInterestMethod,
  })];
  return {
    symbol,
    category,
    listingCount:rows.length,
    listings:rows,
    volume24hUsd:rows.every(row => Number.isFinite(row.volume24hUsd))
      ? rows.reduce((sum, row) => sum + row.volume24hUsd, 0)
      : null,
    fieldStatus:{ volume24hUsd:'full' },
  };
}

function sealedCloseMap(values) {
  return new Map(values.map((value, index) => [
    CURRENT_DAY - (values.length - index) * DAY_MS + 23 * HOUR_MS,
    value,
  ]));
}

function oiSchedule(closes, fallback = closes.at(-1)) {
  const byHour = sealedCloseMap(closes);
  return timestamp => byHour.get(timestamp) ?? fallback;
}

function hourlyHistory(specs, {
  startHour = CURRENT_HOUR - 95 * HOUR_MS,
  endHour = CURRENT_HOUR,
  skipHours = new Set(),
} = {}) {
  let history = null;
  for (let timestamp = startHour; timestamp < endHour; timestamp += HOUR_MS) {
    if (skipHours.has(timestamp)) continue;
    const assets = specs.map(spec => asset(spec.symbol, {
      ...(spec.assetOptions || {}),
      openInterestUsd:spec.oiAt(timestamp),
    }));
    const snapshot = compactOiHourlySnapshot(assets, timestamp + 5 * 60_000);
    history = mergeOiHourlyHistory(history, snapshot, timestamp + 5 * 60_000);
  }
  return history;
}

function build(specs, history, options = {}) {
  const assets = specs.map(spec => asset(spec.symbol, {
    ...(spec.assetOptions || {}),
    openInterestUsd:spec.currentOi,
  }));
  return buildOiLiquidationAnomalies(assets, history, NOW, options);
}

test('OI proxy publishes the locked formula, namespace, and strict threshold contract', () => {
  assert.equal(OI_LIQUIDATION_FORMULA_VERSION, 'rwa-oi-liquidation-proxy-1.0');
  assert.equal(OI_RANGE_FORMULA_VERSION, 'rwa-oi-24h-range-1.0');
  assert.equal(OI_LIQUIDATION_HISTORY_NAMESPACE, 'rwa-signal-oi-liquidation-hourly-v1');
  assert.equal(OI_LIQUIDATION_HISTORY_HOURS, 96);
  assert.equal(OI_LIQUIDATION_HISTORY_MAX_BYTES, 1_750_000);
  assert.deepEqual(OI_LIQUIDATION_THRESHOLDS, {
    minVolume24hUsdExclusive:1_000_000,
    liquidationProxyDropUsdExclusive:2_000_000,
    risingCompletedDays:3,
    peakLookbackHours:24,
    topTraderBullishAbove:1.05,
    topTraderBearishBelow:0.95,
    logic:'or',
  });
});

test('complete states publish a coherent 24h trough-to-current OI increase', () => {
  const spec = {
    symbol:'SURGE',
    currentOi:16_000_000,
    oiAt:oiSchedule([10_000_000, 10_000_000, 10_000_000]),
  };
  const result = build([spec], hourlyHistory([spec]));
  const state = result.states[0];
  assert.equal(result.rangeFormulaVersion, OI_RANGE_FORMULA_VERSION);
  assert.equal(state.currentOpenInterestUsd, 16_000_000);
  assert.equal(state.trough24hOpenInterestUsd, 10_000_000);
  assert.equal(state.increase24hUsd, 6_000_000);
  assert.equal(state.increase24hPct, 60);
  assert.equal(state.peak24hOpenInterestUsd, 16_000_000);
  assert.equal(state.drawdown24hUsd, 0);
});

test('volume eligibility is strictly above $1m and uses the published listing-cent sum', () => {
  const specs = [{
    symbol:'AAPL', currentOi:7_000_000, oiAt:oiSchedule([5_000_000, 6_000_000, 7_000_000]),
    assetOptions:{ volume24hUsd:1_000_000.01 },
  }, {
    symbol:'MSFT', currentOi:7_000_000, oiAt:oiSchedule([5_000_000, 6_000_000, 7_000_000]),
    assetOptions:{ volume24hUsd:1_000_000 },
  }, {
    symbol:'TSLA', currentOi:7_000_000, oiAt:oiSchedule([5_000_000, 6_000_000, 7_000_000]),
    // Raw value rounds to the exact public boundary and therefore must fail.
    assetOptions:{ volume24hUsd:1_000_000.004 },
  }];
  const result = build(specs, hourlyHistory(specs));

  assert.equal(result.counts.verifiedAssets, 3);
  assert.equal(result.counts.filteredLowVolume, 2);
  assert.equal(result.counts.volumeEligibleAssets, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].symbol, 'AAPL');
  assert.equal(result.rows[0].currentVolume24hUsd, 1_000_000.01);
  assert.deepEqual(result.stateCoverage, {
    expectedEligibleAssets:1,
    returnedStates:1,
    complete:true,
  });
  assert.equal(result.states.length, 1, 'states cover eligible assets only and are not Top-100 ranked rows');
  assert.equal(result.states[0].assetKey, 'equity:AAPL');
});

test('three sealed UTC closes and the 24h drawdown use strict OR semantics', () => {
  const specs = [{
    symbol:'RISE', currentOi:7_000_000,
    oiAt:oiSchedule([5_000_000, 6_000_000, 7_000_000]),
  }, {
    symbol:'DROP', currentOi:4_899_999.99,
    oiAt:oiSchedule([5_000_000, 5_000_000, 7_000_000]),
  }, {
    symbol:'BOTH', currentOi:4_899_999.99,
    oiAt:oiSchedule([5_000_000, 6_000_000, 7_000_000]),
  }, {
    symbol:'EDGE', currentOi:5_000_000,
    oiAt:oiSchedule([5_000_000, 5_000_000, 7_000_000]),
  }];
  const result = build(specs, hourlyHistory(specs));
  const bySymbol = new Map(result.rows.map(row => [row.symbol, row]));
  const stateBySymbol = new Map(result.states.map(state => [state.symbol, state]));

  assert.equal(result.counts.alerts, 3);
  assert.equal(result.counts.oiRising, 2);
  assert.equal(result.counts.liquidationProxy, 2);
  assert.equal(result.counts.both, 1);
  assert.equal(bySymbol.get('RISE').trigger, 'oi_rising');
  assert.equal(bySymbol.get('DROP').trigger, 'liquidation_proxy');
  assert.equal(bySymbol.get('BOTH').trigger, 'both');
  assert.equal(bySymbol.has('EDGE'), false, 'an exact $2m drawdown must not trigger');
  assert.deepEqual(bySymbol.get('BOTH').completedDailyCloses, [
    { day:'2026-08-11', openInterestUsd:5_000_000 },
    { day:'2026-08-12', openInterestUsd:6_000_000 },
    { day:'2026-08-13', openInterestUsd:7_000_000 },
  ]);
  assert.equal(bySymbol.get('BOTH').completedDailyTrend, 'rising');
  assert.equal(bySymbol.get('BOTH').drawdown24hUsd, 2_100_000.01);
  assert.equal(bySymbol.get('BOTH').status, 'estimated');
  assert.equal(stateBySymbol.get('DROP').evaluationStatus, 'triggered');
  assert.equal(stateBySymbol.get('EDGE').evaluationStatus, 'clear');
  assert.equal(stateBySymbol.get('EDGE').drawdown24hUsd, 2_000_000);
  assert.equal(stateBySymbol.get('EDGE').drawdown24hPct, 28.571429);
  assert.equal(stateBySymbol.get('EDGE').sameCohort, true);
  assert.equal(stateBySymbol.get('EDGE').observedBucket, new Date(CURRENT_HOUR).toISOString());
  assert.deepEqual(stateBySymbol.get('EDGE').reasonCodes, []);
  for (const field of [
    'currentVolume24hUsd', 'currentOpenInterestUsd', 'completedDailyCloses',
    'completedDailyTrend', 'peak24hOpenInterestUsd', 'drawdown24hUsd',
  ]) {
    assert.equal(bySymbol.get('BOTH').fieldStatus[field], 'estimated');
  }
});

test('the unfinished current UTC day never substitutes for one of the three sealed closes', () => {
  const spec = {
    symbol:'AAPL', currentOi:10_000_000,
    oiAt:oiSchedule([7_000_000, 6_000_000, 5_000_000], 5_000_000),
  };
  const result = build([spec], hourlyHistory([spec]));
  assert.equal(result.rows.length, 0, 'a current-day increase cannot turn declining sealed closes into OI rising');
  assert.equal(result.history.trendReadyAssets, 1);
});

test('null OI is incomplete while a true zero remains a valid value', () => {
  const prior = {
    symbol:'ZERO', currentOi:0,
    oiAt:oiSchedule([1_000_000, 1_000_000, 3_000_000], 3_000_000),
  };
  const history = hourlyHistory([prior]);
  const zero = build([prior], history);
  assert.equal(zero.rows.length, 1);
  assert.equal(zero.rows[0].currentOpenInterestUsd, 0);
  assert.equal(zero.rows[0].trigger, 'liquidation_proxy');
  assert.equal(zero.rows[0].drawdown24hUsd, 3_000_000);

  const missingAsset = asset('ZERO', { openInterestUsd:null });
  const missing = buildOiLiquidationAnomalies([missingAsset], history, NOW);
  assert.equal(missing.counts.volumeEligibleAssets, 1);
  assert.equal(missing.counts.completeEligibleAssets, 0);
  assert.equal(missing.counts.missingEligibleAssets, 1);
  assert.equal(missing.rows.length, 0);
  assert.equal(missing.status, 'partial');
  assert.equal(missing.states.length, 1);
  assert.equal(missing.states[0].evaluationStatus, 'unavailable');
  assert.equal(missing.states[0].currentOpenInterestUsd, null);
  assert.equal(missing.states[0].sameCohort, null);
  assert.ok(missing.states[0].reasonCodes.includes('LISTING_OPEN_INTEREST_UNAVAILABLE'));
});

test('a comparable zero peak is Clear without inventing a percentage denominator', () => {
  const spec = {
    symbol:'ZERO', currentOi:0,
    oiAt:() => 0,
  };
  const result = build([spec], hourlyHistory([spec]));
  assert.equal(result.rows.length, 0);
  assert.equal(result.states[0].evaluationStatus, 'clear');
  assert.equal(result.states[0].sameCohort, true);
  assert.equal(result.states[0].peak24hOpenInterestUsd, 0);
  assert.equal(result.states[0].drawdown24hUsd, 0);
  assert.equal(result.states[0].drawdown24hPct, null);
  assert.equal(result.states[0].trough24hOpenInterestUsd, 0);
  assert.equal(result.states[0].increase24hUsd, 0);
  assert.equal(result.states[0].increase24hPct, null);
  assert.deepEqual(result.states[0].reasonCodes, [
    'OI_PEAK_ZERO_PERCENT_UNAVAILABLE',
    'OI_TROUGH_ZERO_PERCENT_UNAVAILABLE',
  ]);
});

test('a changed exact-listing cohort cannot inherit old trend or peak history', () => {
  const oldSpec = {
    symbol:'AAPL', currentOi:4_000_000,
    oiAt:oiSchedule([5_000_000, 6_000_000, 7_000_000]),
    assetOptions:{ venueSymbol:'AAPLUSDT' },
  };
  const history = hourlyHistory([oldSpec]);
  const changed = build([{ ...oldSpec, assetOptions:{ venueSymbol:'AAPL2USDT' } }], history);

  assert.equal(changed.rows.length, 0);
  assert.equal(changed.history.readyAssets, 0);
  assert.equal(changed.history.trendReadyAssets, 0);
  assert.equal(changed.history.drawdownReadyAssets, 0);
  assert.equal(changed.status, 'warming');
  assert.equal(changed.states.length, 1);
  assert.equal(changed.states[0].evaluationStatus, 'warming');
  assert.equal(changed.states[0].sameCohort, false);
  assert.deepEqual(changed.states[0].reasonCodes, ['OI_COHORT_CHANGED']);
});

test('an open-interest method change alone resets both trend and drawdown history', () => {
  const oldSpec = {
    symbol:'AAPL',
    currentOi:4_000_000,
    oiAt:oiSchedule([5_000_000, 6_000_000, 7_000_000]),
    assetOptions:{
      venueSymbol:'AAPLUSDT',
      openInterestMethod:'official-open-interest-usd',
    },
  };
  const history = hourlyHistory([oldSpec]);
  const changed = build([{
    ...oldSpec,
    assetOptions:{
      ...oldSpec.assetOptions,
      openInterestMethod:'open-interest-x-last-price',
    },
  }], history);

  assert.equal(changed.rows.length, 0);
  assert.equal(changed.history.readyAssets, 0);
  assert.equal(changed.history.trendReadyAssets, 0);
  assert.equal(changed.history.drawdownReadyAssets, 0);
  assert.equal(changed.status, 'warming');
});

test('a gap in the 24h OI series suppresses only the drawdown leg of the OR signal', () => {
  const spec = {
    symbol:'AAPL', currentOi:4_000_000,
    oiAt:oiSchedule([5_000_000, 6_000_000, 7_000_000]),
  };
  const history = hourlyHistory([spec], {
    skipHours:new Set([CURRENT_HOUR - 5 * HOUR_MS]),
  });
  const result = build([spec], history);

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].trigger, 'oi_rising');
  assert.equal(result.rows[0].completedDailyTrend, 'rising');
  assert.equal(result.rows[0].peak24hOpenInterestUsd, null);
  assert.equal(result.rows[0].drawdown24hUsd, null);
  assert.equal(result.rows[0].fieldStatus.drawdown24hUsd, 'unavailable');
  assert.equal(result.history.trendReadyAssets, 1);
  assert.equal(result.history.drawdownReadyAssets, 0);
  assert.equal(result.history.readyAssets, 0);
  assert.equal(result.states[0].evaluationStatus, 'warming');
  assert.equal(result.states[0].sameCohort, null);
  assert.deepEqual(result.states[0].reasonCodes, ['OI_HISTORY_HOUR_MISSING']);
});

test('one accepted listing with missing OI is isolated while a verified same-cohort asset keeps its hourly row', () => {
  const healthySpec = {
    symbol:'AAPL', currentOi:4_000_000,
    oiAt:oiSchedule([5_000_000, 6_000_000, 7_000_000]),
  };
  const history = hourlyHistory([healthySpec]);
  const currentAssets = [
    asset('AAPL', { openInterestUsd:healthySpec.currentOi }),
    asset('MISSING', { openInterestUsd:null }),
  ];
  const currentSnapshot = compactOiHourlySnapshot(currentAssets, NOW);

  assert.equal(currentSnapshot.h.length, 1);
  assert.equal(currentSnapshot.h[0].e, 2);
  assert.equal(currentSnapshot.h[0].m, 1);
  assert.equal(currentSnapshot.h[0].a.length, 1);

  const merged = mergeOiHourlyHistory(history, currentSnapshot, NOW);
  const result = buildOiLiquidationAnomalies(currentAssets, merged, NOW, {
    snapshotComparable:true,
    historyAvailable:true,
  });
  const stateBySymbol = new Map(result.states.map(state => [state.symbol, state]));
  assert.equal(stateBySymbol.get('AAPL').evaluationStatus, 'triggered');
  assert.equal(stateBySymbol.get('AAPL').sameCohort, true);
  assert.equal(stateBySymbol.get('MISSING').evaluationStatus, 'unavailable');
  assert.ok(stateBySymbol.get('MISSING').reasonCodes.includes('LISTING_OPEN_INTEREST_UNAVAILABLE'));
  assert.equal(result.counts.completeEligibleAssets, 1);
  assert.equal(result.counts.missingEligibleAssets, 1);
});

test('a Partial venue can expose verified alerts but can never make the section Full', () => {
  const spec = {
    symbol:'AAPL', currentOi:7_000_000,
    oiAt:oiSchedule([5_000_000, 6_000_000, 7_000_000]),
  };
  const sources = Object.fromEntries(['gate','binance','bitget','tradexyz','okx'].map(venue => [venue, {
    status:venue === 'okx' ? 'partial' : 'full',
  }]));
  const result = build([spec], hourlyHistory([spec]), { sources });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].trigger, 'oi_rising');
  assert.equal(result.status, 'partial');
  assert.equal(result.history.status, 'partial');
});

test('the full verified universe is evaluated before the response is capped at Top 100', () => {
  const specs = Array.from({ length:101 }, (_, index) => ({
    symbol:`X${String(index).padStart(3, '0')}`,
    currentOi:7_000_000,
    oiAt:oiSchedule([5_000_000, 6_000_000, 7_000_000]),
    assetOptions:{ venue:'gate', venueSymbol:`X${String(index).padStart(3, '0')}_USDT` },
  }));
  const history = hourlyHistory(specs);
  const result = build(specs, history);

  assert.equal(result.counts.verifiedAssets, 101);
  assert.equal(result.counts.alerts, 101);
  assert.equal(result.history.trendReadyAssets, 101);
  assert.equal(result.rows.length, 100);
  assert.equal(result.rows.some(row => row.symbol === 'X100'), false);
  assert.equal(result.states.length, 101, 'recovery states must never inherit the alert-row cap');
  assert.deepEqual(result.stateCoverage, {
    expectedEligibleAssets:101,
    returnedStates:101,
    complete:true,
  });
  assert.equal(result.states.some(state => state.symbol === 'X100'), true);
});

test('recovery states fail closed when history or the current snapshot is unavailable', () => {
  const spec = {
    symbol:'AAPL', currentOi:7_000_000,
    oiAt:oiSchedule([5_000_000, 6_000_000, 7_000_000]),
  };
  const history = hourlyHistory([spec]);

  const missingHistory = build([spec], history, { historyAvailable:false });
  assert.equal(missingHistory.states[0].evaluationStatus, 'unavailable');
  assert.equal(missingHistory.states[0].sameCohort, null);
  assert.deepEqual(missingHistory.states[0].reasonCodes, ['OI_HISTORY_UNAVAILABLE']);

  const partialSnapshot = build([spec], history, { snapshotComparable:false });
  assert.equal(partialSnapshot.states[0].evaluationStatus, 'unavailable');
  assert.equal(partialSnapshot.states[0].sameCohort, null);
  assert.deepEqual(partialSnapshot.states[0].reasonCodes, ['OI_SNAPSHOT_NOT_COMPARABLE']);
});

test('hourly history is idempotent, rejects future buckets, and retains 96 UTC hours', () => {
  const firstAsset = asset('AAPL', { openInterestUsd:1_000_000 });
  const replacement = asset('AAPL', { openInterestUsd:2_000_000 });
  const first = compactOiHourlySnapshot([firstAsset], NOW);
  const replaced = mergeOiHourlyHistory(first, compactOiHourlySnapshot([replacement], NOW + 10 * 60_000), NOW);
  assert.equal(replaced.h.length, 1);
  assert.equal(replaced.h[0].a[0][1], 200_000_000);

  const future = compactOiHourlySnapshot([firstAsset], NOW + HOUR_MS);
  assert.throws(() => normalizeOiHourlyHistory(future, NOW), /Invalid OI hourly snapshot/);

  let retained = null;
  for (let offset = 110; offset >= 0; offset -= 1) {
    const timestamp = CURRENT_HOUR - offset * HOUR_MS;
    const snapshot = compactOiHourlySnapshot([firstAsset], timestamp);
    retained = mergeOiHourlyHistory(retained, snapshot, timestamp);
  }
  assert.equal(retained.h.length, 96);
  assert.equal(retained.h[0].t, CURRENT_HOUR - 95 * HOUR_MS);
  assert.equal(retained.h.at(-1).t, CURRENT_HOUR);
});

test('serialized OI history rejects payloads above the 1.75 MB cache budget', () => {
  const assetCount = 70_000;
  const oversized = {
    v:1,
    i:Array.from({ length:assetCount }, (_, index) => ['e', `Q${index}`]),
    c:['abcdefghijklmnop'],
    h:[{
      t:CURRENT_HOUR,
      e:assetCount,
      m:0,
      a:Array.from({ length:assetCount }, (_, index) => [index, 100, 0]),
    }],
  };
  assert.ok(oiHourlyHistoryBytes(oversized) > OI_LIQUIDATION_HISTORY_MAX_BYTES);
  assert.throws(() => normalizeOiHourlyHistory(oversized, NOW), /exceeds 1750000 bytes/);
});

test('Binance Top Trader enrichment uses an exact symbol, fresh time, and strict neutral boundaries', () => {
  function officialRow(symbol, ratio, timestamp = NOW) {
    const short = 1 / (1 + ratio);
    return {
      symbol,
      longShortRatio:String(ratio),
      longAccount:String(1 - short),
      shortAccount:String(short),
      timestamp,
    };
  }

  assert.equal(normalizeBinanceTopTraderPositions('AAPLUSDT', [officialRow('AAPLUSDT', 1.05)], NOW).bias, 'neutral');
  assert.equal(normalizeBinanceTopTraderPositions('AAPLUSDT', [officialRow('AAPLUSDT', 0.95)], NOW).bias, 'neutral');
  assert.equal(normalizeBinanceTopTraderPositions('AAPLUSDT', [officialRow('AAPLUSDT', 1.0501)], NOW).bias, 'bullish');
  assert.equal(normalizeBinanceTopTraderPositions('AAPLUSDT', [officialRow('AAPLUSDT', 0.9499)], NOW).bias, 'bearish');
  assert.equal(normalizeBinanceTopTraderPositions('AAPLUSDT', [officialRow('MSFTUSDT', 1)], NOW).status, 'unavailable');
  assert.equal(normalizeBinanceTopTraderPositions('AAPLUSDT', [officialRow('AAPLUSDT', 1, NOW + 1)], NOW).status, 'unavailable');
  assert.equal(normalizeBinanceTopTraderPositions('AAPLUSDT', [officialRow('AAPLUSDT', 1, NOW - 3 * HOUR_MS)], NOW).status, 'full');
  assert.equal(normalizeBinanceTopTraderPositions('AAPLUSDT', [officialRow('AAPLUSDT', 1, NOW - 3 * HOUR_MS - 1)], NOW).status, 'unavailable');
  assert.equal(normalizeBinanceTopTraderPositions('AAPLUSDT', [{
    ...officialRow('AAPLUSDT', 1), longShortRatio:'2',
  }], NOW).status, 'unavailable');
});

test('missing Binance data is Unavailable and never silently becomes Neutral', () => {
  const spec = {
    symbol:'AAPL', currentOi:7_000_000,
    oiAt:oiSchedule([5_000_000, 6_000_000, 7_000_000]),
  };
  const history = hourlyHistory([spec]);
  const absent = build([spec], history);
  assert.equal(absent.rows[0].topTraderPositions[0].status, 'unavailable');
  assert.equal(absent.rows[0].topTraderPositions[0].bias, 'unavailable');
  assert.equal(absent.rows[0].overallTraderBias, 'unavailable');
  assert.equal(absent.counts.topTraderAvailable, 0);

  const failed = build([spec], history, {
    topTraderPositions:{ AAPLUSDT:{ status:'unavailable', reasonCode:'UPSTREAM_FAILURE' } },
  });
  assert.equal(failed.rows[0].topTraderPositions[0].status, 'unavailable');
  assert.notEqual(failed.rows[0].overallTraderBias, 'neutral');

  const gateSpec = {
    ...spec,
    assetOptions:{ venue:'gate', venueSymbol:'AAPL_USDT' },
  };
  const noBinance = build([gateSpec], hourlyHistory([gateSpec]));
  assert.deepEqual(noBinance.rows[0].topTraderPositions, []);
  assert.equal(noBinance.rows[0].overallTraderBias, 'unavailable');
});

test('state market context selects the available 24h change from the largest current-OI listing', () => {
  const listings = [
    listing({ venue:'gate', venueSymbol:'AAPL_USDT', volume24hUsd:500_000.01,
      openInterestUsd:2_000_000, change24hPct:-2 }),
    listing({ venue:'binance', venueSymbol:'AAPLUSDT', volume24hUsd:500_000,
      openInterestUsd:6_000_000, change24hPct:1.234567 }),
    listing({ venue:'bitget', venueSymbol:'AAPLUSDT', volume24hUsd:500_000,
      openInterestUsd:1_000_000, change24hPct:null }),
  ];
  const result = buildOiLiquidationAnomalies(
    [asset('AAPL', { listings })],
    null,
    NOW,
    { historyAvailable:false },
  );
  assert.deepEqual(result.states[0].marketContext.price24h, {
    coverageStatus:'partial',
    selectionMethod:'largest-current-oi-listing-with-available-change',
    observedListings:2,
    expectedListings:3,
    observedAt:new Date(NOW).toISOString(),
    representative:{
      venue:'binance',
      venueSymbol:'AAPLUSDT',
      change24hPct:1.23457,
      method:'official-change-percent',
      status:'full',
      currentOpenInterestSharePct:66.66667,
    },
    rangePct:{ min:-2, max:1.23457 },
    reasonCode:null,
  });
  assert.equal(result.states[0].marketContext.version, 'rwa-oi-market-context/v2');
  assert.deepEqual(result.states[0].marketContext.funding, {
    status:'full',
    venue:'binance',
    venueSymbol:'AAPLUSDT',
    ratePct:0.01,
    intervalHours:8,
    observedAt:new Date(NOW).toISOString(),
    reasonCode:null,
  });
  assert.equal(result.states[0].marketContext.positioning.status, 'unavailable');
  assert.equal(
    result.states[0].marketContext.positioning.reasonCode,
    'OI_POSITIONING_NOT_REQUESTED',
  );
});

test('price context rejects an impossible sub-minus-100 percent change instead of publishing it', () => {
  const bad = listing({ change24hPct:-100.00001 });
  const result = buildOiLiquidationAnomalies(
    [asset('AAPL', { listings:[bad] })],
    null,
    NOW,
    { historyAvailable:false },
  );
  assert.deepEqual(result.states[0].marketContext.price24h.rangePct, { min:null, max:null });
  assert.equal(result.states[0].marketContext.price24h.coverageStatus, 'unavailable');
  assert.equal(result.states[0].marketContext.price24h.observedListings, 0);
  assert.equal(result.states[0].marketContext.price24h.reasonCode, 'PRICE_24H_CHANGE_UNAVAILABLE');
  assert.equal(result.states[0].marketContext.funding.reasonCode, 'REFERENCE_CONTRACT_UNAVAILABLE');
  assert.equal(result.states[0].marketContext.positioning.reasonCode, 'REFERENCE_CONTRACT_UNAVAILABLE');
});

test('same-contract funding stays unavailable when the selected listing lacks a valid native rate', () => {
  const selected = listing({ change24hPct:1, fundingRate:null, fundingIntervalHours:null });
  const result = buildOiLiquidationAnomalies(
    [asset('AAPL', { listings:[selected] })],
    null,
    NOW,
    { historyAvailable:false },
  );
  assert.deepEqual(result.states[0].marketContext.funding, {
    status:'unavailable', venue:'binance', venueSymbol:'AAPLUSDT', ratePct:null,
    intervalHours:null, observedAt:null, reasonCode:'FUNDING_UNAVAILABLE',
  });
});

test('triggered state positioning is explicit for enriched, missing, and non-Binance contracts', () => {
  const spec = {
    symbol:'AAPL', currentOi:4_899_999.99,
    oiAt:oiSchedule([5_000_000, 5_000_000, 7_000_000]),
  };
  const history = hourlyHistory([spec]);
  const short = 1 / 2.1;
  const enriched = build([spec], history, {
    topTraderPositions:{
      AAPLUSDT:[{
        symbol:'AAPLUSDT',
        longShortRatio:'1.1',
        longAccount:String(1 - short),
        shortAccount:String(short),
        timestamp:NOW,
      }],
    },
  });
  assert.equal(enriched.states[0].evaluationStatus, 'triggered');
  assert.equal(enriched.states[0].marketContext.positioning.status, 'full');
  assert.equal(enriched.states[0].marketContext.positioning.venue, 'binance');
  assert.equal(enriched.states[0].marketContext.positioning.venueSymbol, 'AAPLUSDT');
  assert.equal(enriched.states[0].marketContext.positioning.longShortRatio, 1.1);
  assert.equal(enriched.states[0].marketContext.positioning.reasonCode, null);

  const absent = build([spec], history);
  assert.equal(absent.states[0].marketContext.positioning.status, 'unavailable');
  assert.equal(absent.states[0].marketContext.positioning.venueSymbol, 'AAPLUSDT');
  assert.equal(absent.states[0].marketContext.positioning.reasonCode, 'TOP_TRADER_NOT_FETCHED');

  const gateSpec = { ...spec, assetOptions:{ venue:'gate', venueSymbol:'AAPL_USDT' } };
  const noBinance = build([gateSpec], hourlyHistory([gateSpec]));
  assert.equal(
    noBinance.states[0].marketContext.positioning.reasonCode,
    'VENUE_POSITIONING_UNSUPPORTED',
  );
  assert.equal(noBinance.states[0].marketContext.positioning.venue, 'gate');
  assert.equal(noBinance.states[0].marketContext.positioning.venueSymbol, 'AAPL_USDT');

  const surgeSpec = {
    symbol:'SURGE', currentOi:16_000_000,
    oiAt:oiSchedule([10_000_000, 10_000_000, 10_000_000]),
  };
  const surge = build([surgeSpec], hourlyHistory([surgeSpec]), {
    topTraderPositions:{
      SURGEUSDT:[{
        symbol:'SURGEUSDT', longShortRatio:'1.1', longAccount:String(1 - short),
        shortAccount:String(short), timestamp:NOW,
      }],
    },
  });
  assert.equal(surge.states[0].evaluationStatus, 'clear');
  assert.equal(surge.states[0].increase24hUsd, 6_000_000);
  assert.equal(surge.states[0].marketContext.positioning.status, 'full');
  assert.equal(surge.states[0].marketContext.positioning.venueSymbol, 'SURGEUSDT');
});

test('state context never substitutes Binance positioning for a trade.xyz reference contract', () => {
  const dualListings = totalOi => [
    listing({
      venue:'tradexyz', venueSymbol:'XYZ:AAPL', volume24hUsd:750_000.01,
      openInterestUsd:totalOi * 0.8, fundingRate:0.00025, fundingIntervalHours:1,
      change24hPct:-3, change24hMethod:'mark-vs-prev-day-price', change24hStatus:'estimated',
    }),
    listing({
      venue:'binance', venueSymbol:'AAPLUSDT', volume24hUsd:750_000,
      openInterestUsd:totalOi * 0.2, fundingRate:0.0001, fundingIntervalHours:8,
      change24hPct:-2,
    }),
  ];
  const spec = {
    symbol:'AAPL', currentOi:4_899_999.99,
    oiAt:oiSchedule([5_000_000, 5_000_000, 7_000_000]),
    assetOptions:{ listings:dualListings },
  };
  const short = 1 / 2.1;
  const result = build([spec], hourlyHistory([spec]), {
    topTraderPositions:{
      AAPLUSDT:[{
        symbol:'AAPLUSDT', longShortRatio:'1.1', longAccount:String(1 - short),
        shortAccount:String(short), timestamp:NOW,
      }],
    },
  });
  const context = result.states[0].marketContext;
  assert.equal(context.price24h.representative.venue, 'tradexyz');
  assert.equal(context.price24h.representative.venueSymbol, 'XYZ:AAPL');
  assert.deepEqual(context.funding, {
    status:'full', venue:'tradexyz', venueSymbol:'XYZ:AAPL', ratePct:0.025,
    intervalHours:1, observedAt:new Date(NOW).toISOString(), reasonCode:null,
  });
  assert.equal(context.positioning.status, 'unavailable');
  assert.equal(context.positioning.venue, 'tradexyz');
  assert.equal(context.positioning.venueSymbol, 'XYZ:AAPL');
  assert.equal(context.positioning.reasonCode, 'VENUE_POSITIONING_UNSUPPORTED');
  assert.equal(context.positioning.longShortRatio, null);
});

test('Crypto identities and identity-conflicted cohorts fail closed', () => {
  const valid = {
    symbol:'AAPL', currentOi:7_000_000,
    oiAt:oiSchedule([5_000_000, 6_000_000, 7_000_000]),
  };
  const history = hourlyHistory([valid]);
  const crypto = asset('AAPL', { category:'crypto', openInterestUsd:7_000_000 });
  const cryptoResult = buildOiLiquidationAnomalies([crypto], history, NOW);
  assert.equal(cryptoResult.counts.verifiedAssets, 0);
  assert.equal(cryptoResult.rows.length, 0);

  const conflict = build([valid], history, { conflicts:[{ symbol:'AAPL' }] });
  assert.equal(conflict.coverage.identityConflicts, 1);
  assert.equal(conflict.status, 'partial');
  assert.equal(conflict.rows.length, 0);
  assert.equal(conflict.history.readyAssets, 0);
});

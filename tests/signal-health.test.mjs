import test from 'node:test';
import assert from 'node:assert/strict';

import { validateSignalRadarSnapshot } from '../api/health.js';

const NOW = Date.parse('2026-08-14T12:00:00.000Z');
const SOURCE_KEYS = ['gate', 'binance', 'bitget', 'tradexyz', 'okx'];

function basePayload(volumeStatus = 'warming') {
  const generatedAt = new Date(NOW - 5 * 60_000).toISOString();
  const full = volumeStatus === 'full';
  const rows = full ? [validHighRow()] : [];
  const priorStoredDays = full ? 37 : 0;
  return {
    schemaVersion:'rwa-signal-snapshot/v1',
    generatedAt,
    status:'full',
    sources:Object.fromEntries(SOURCE_KEYS.map(key => [key, {
      status:'full', listingCount:1, catalogListingCount:1, quarantinedListings:0, warnings:[],
    }])),
    coverage:{
      expectedSources:5,
      availableSources:5,
      identityConflicts:0,
      canonicalAssetCount:1,
    },
    assets:[{ symbol:'AAPL', category:'equity' }],
    persistence:{
      mode:'vercel-runtime-cache',
      status:'partial',
      writer:{ requested:false, succeeded:null },
      dailyVolume:{
        namespace:'rwa-signal-volume-daily-v1',
        status:'partial',
        retentionDays:45,
        storedDays:full ? 38 : 0,
        writeStatus:'read-only',
      },
      spotVolumePrice:{
        namespace:'rwa-signal-spot-volume-price-history-v1',
        status:'partial',
        retentionDays:8,
        storedDays:full ? 2 : 0,
        writeStatus:'read-only',
        error:null,
      },
      oiLiquidation:{
        namespace:'rwa-signal-oi-liquidation-hourly-v1',
        status:'partial',
        retentionHours:96,
        storedHours:full ? 96 : 0,
        writeStatus:'read-only',
        error:null,
      },
    },
    perpVolumeAnomalies:{
      formulaVersion:'rwa-perp-volume-anomaly-1.0',
      generatedAt,
      status:volumeStatus,
      monitoredAssets:1,
      readyAssets:full ? 1 : 0,
      frequencyReadyAssets:full ? 1 : 0,
      counts:full
        ? { high:1, medium:0, down:0, highFrequency:1 }
        : { high:0, medium:0, down:0, highFrequency:0 },
      history:{
        storedDays:priorStoredDays,
        priorStoredDays,
        retentionDays:45,
        baselineDays:7,
        frequencyWindowDays:30,
        oldestAt:full ? new Date(Date.UTC(2026, 6, 8)).toISOString() : null,
        newestAt:full ? new Date(Date.UTC(2026, 7, 13)).toISOString() : null,
      },
      methodology:{
        thresholds:{ high:2, medium:1.5, down:0.4 },
        highFrequencyMinEligibleDays:21,
        highFrequencyMinAnomalyDays:6,
        consecutiveExpansionMinDays:2,
      },
      rows,
    },
    spotVolumePriceAnomalies:validSpotSection(volumeStatus === 'full' ? 'full' : 'warming', generatedAt),
    oiLiquidationAnomalies:validOiLiquidationSection(volumeStatus === 'full' ? 'full' : 'warming', generatedAt),
  };
}

function spotSources() {
  return {
    gate:{ status:'full', listingCount:1, marketFieldCount:1, priceFieldCount:1, warnings:[] },
    kraken:{ status:'full', listingCount:1, marketFieldCount:1, priceFieldCount:0, warnings:['KRAKEN_PRICE_CHANGE_UNAVAILABLE_BY_DESIGN'] },
    bitget:{ status:'full', listingCount:1, marketFieldCount:1, priceFieldCount:1, warnings:[] },
    binance:{ status:'full', listingCount:1, marketFieldCount:1, priceFieldCount:1, warnings:[] },
    okx:{ status:'full', listingCount:1, marketFieldCount:1, priceFieldCount:1, warnings:[] },
  };
}

function validSpotRow(trigger = 'both') {
  const volumeTriggered = trigger === 'volume_spike' || trigger === 'both';
  const priceTriggered = trigger === 'price_surge' || trigger === 'both';
  return {
    rank:1,
    listingKey:'spot:binance:AAPLBUSDT',
    assetKey:'equity:AAPL',
    symbol:'AAPL',
    category:'equity',
    venue:'binance',
    venueSymbol:'AAPLBUSDT',
    quote:'USDT',
    currentVolumeUsd:600_000,
    yesterdayVolumeUsd:volumeTriggered ? 200_000 : null,
    volumeRatio:volumeTriggered ? 3 : null,
    priceChange24hPct:priceTriggered ? 15 : 10,
    trigger,
    volumeTriggered,
    priceTriggered,
    fieldStatus:{
      currentVolume:'full',
      yesterdayVolume:volumeTriggered ? 'estimated' : 'unavailable',
      volumeRatio:volumeTriggered ? 'estimated' : 'unavailable',
      priceChange:'full',
      perpCoverage:'full',
    },
    perpCoverage:{
      status:'full',
      listed:true,
      contracts:[{ venue:'gate', venueSymbol:'AAPLX_USDT', instrumentType:'perpetual' }],
    },
    status:volumeTriggered ? 'estimated' : 'full',
    reasonCodes:volumeTriggered && priceTriggered
      ? ['VOLUME_SPIKE', 'PRICE_SURGE']
      : volumeTriggered ? ['VOLUME_SPIKE'] : ['PRICE_SURGE'],
  };
}

function validSpotSection(status, generatedAt) {
  const full = status === 'full';
  const row = validSpotRow(full ? 'both' : 'price_surge');
  return {
    formulaVersion:'rwa-spot-volume-price-anomaly-1.0',
    generatedAt,
    status,
    thresholds:{ volumeRatio:3, priceRisePct:15, minCurrentVolumeUsd:500_000, logic:'or' },
    methodology:{
      grain:'exact-venue-instrument',
      currentVolume:'rolling-24h-usd-turnover',
      priorVolume:'previous-sealed-utc-day-rolling-24h-anchor',
      volumeComparison:'current-divided-by-prior',
      priceChange:'official-rolling-24h-gain',
      krakenPriceChange:'unavailable-utc-day-open-is-not-rolling-24h-open',
    },
    coverage:{
      expectedSources:5,
      availableSources:5,
      fullSources:5,
      verifiedListings:5,
      quarantinedListings:0,
      identityConflicts:0,
      volumeAvailableListings:5,
      priorVolumeAvailableListings:full ? 5 : 0,
      priceAvailableListings:4,
      liquidityEligibleListings:1,
      volumeComparableListings:full ? 1 : 0,
      priceComparableListings:1,
    },
    counts:{
      alerts:1,
      volumeSpike:full ? 1 : 0,
      priceSurge:1,
      both:full ? 1 : 0,
      perpListed:1,
      filteredLowLiquidity:4,
      filterUnknown:0,
    },
    history:{
      status:full ? 'full' : 'warming',
      namespace:'rwa-signal-spot-volume-price-history-v1',
      cadence:'utc-daily-sealed',
      retentionDays:8,
      storedDays:full ? 2 : 0,
      priorDay:full ? '2026-08-13T00:00:00.000Z' : null,
      oldestAt:full ? '2026-08-12T00:00:00.000Z' : null,
      newestAt:full ? '2026-08-13T00:00:00.000Z' : null,
    },
    persistence:{
      mode:'vercel-runtime-cache',
      status:'partial',
      namespace:'rwa-signal-spot-volume-price-history-v1',
      writer:{ requested:false, succeeded:null },
      writeStatus:'read-only',
      error:null,
    },
    sources:spotSources(),
    rows:[row],
  };
}

function validHighRow() {
  return {
    rank:1,
    symbol:'AAPL',
    category:'equity',
    venues:['gate'],
    listingCount:1,
    currentVolumeUsd:200,
    average7dVolumeUsd:100,
    ratio7d:2,
    level:'high',
    status:'estimated',
    coverageStatus:'full',
    baseline:{ status:'full', observedDays:7, expectedDays:7, cohortStable:true },
    frequency30d:{
      status:'full', eligibleDays:30, expectedDays:30, anomalyDays:6,
      highDays:3, mediumDays:2, downDays:1, expansionDays:5,
      consecutiveExpansionDays:2, highFrequency:true,
    },
    flags:['CONSECUTIVE_EXPANSION', 'HIGH_FREQUENCY_ANOMALY'],
  };
}

function validOiListing(venue, venueSymbol, change24hPct) {
  const estimatedChange = ['tradexyz', 'okx'].includes(venue);
  return {
    venue,
    venueSymbol,
    instrumentType:'perpetual',
    volume24hUsd:400_001,
    volumeMethod:'official-quote-volume',
    volumeStatus:'full',
    openInterestUsd:1_200_000,
    openInterestMethod:'official-open-interest-usd',
    openInterestStatus:'full',
    fundingRate:0.0001,
    fundingIntervalHours:venue === 'tradexyz' ? 1 : 8,
    change24hPct,
    change24hMethod:estimatedChange ? 'computed-change' : 'official-change',
    change24hStatus:estimatedChange ? 'estimated' : 'full',
  };
}

function validOiLiquidationSection(status, generatedAt) {
  const full = status === 'full';
  const sources = Object.fromEntries(SOURCE_KEYS.map(key => [key, {
    status:'full',
    listingCount:1,
    catalogListingCount:1,
    quarantinedListings:0,
    volumeFieldCount:1,
    openInterestFieldCount:1,
    warnings:[],
  }]));
  const listings = [
    validOiListing('gate', 'AAPLX_USDT', 1),
    validOiListing('binance', 'AAPLUSDT', 2),
    validOiListing('bitget', 'AAPLUSDT', 3),
    validOiListing('tradexyz', 'XYZ:AAPL', 4),
    validOiListing('okx', 'AAPL-USDT-SWAP', 5),
  ];
  const row = {
    rank:1,
    assetKey:'equity:AAPL',
    symbol:'AAPL',
    category:'equity',
    venues:['gate', 'binance', 'bitget', 'tradexyz', 'okx'],
    listingCount:5,
    cohortFingerprint:'abcdefgh1234',
    listings,
    currentVolume24hUsd:2_000_005,
    currentOpenInterestUsd:6_000_000,
    completedDailyCloses:[
      { day:'2026-08-11T00:00:00.000Z', openInterestUsd:5_000_000 },
      { day:'2026-08-12T00:00:00.000Z', openInterestUsd:6_000_000 },
      { day:'2026-08-13T00:00:00.000Z', openInterestUsd:7_000_000 },
    ],
    completedDailyTrend:'rising',
    peak24hOpenInterestUsd:8_000_001,
    peak24hAt:'2026-08-14T06:00:00.000Z',
    drawdown24hUsd:2_000_001,
    trough24hOpenInterestUsd:4_000_000,
    trough24hAt:'2026-08-14T05:00:00.000Z',
    increase24hUsd:2_000_000,
    increase24hPct:50,
    trigger:'both',
    topTraderPositions:[{
      venueSymbol:'AAPLUSDT',
      status:'full',
      longShortRatio:1.05,
      longPositionPct:51.22,
      shortPositionPct:48.78,
      bias:'neutral',
      observedAt:'2026-08-14T11:00:00.000Z',
      reasonCode:null,
    }],
    overallTraderBias:'neutral',
    fieldStatus:{
      currentVolume24hUsd:'estimated',
      currentOpenInterestUsd:'estimated',
      completedDailyCloses:'estimated',
      completedDailyTrend:'estimated',
      peak24hOpenInterestUsd:'estimated',
      drawdown24hUsd:'estimated',
      trough24hOpenInterestUsd:'estimated',
      increase24hUsd:'estimated',
      increase24hPct:'estimated',
      topTraderPositions:'full',
    },
    status:'estimated',
    reasonCodes:[],
  };
  const observedBucket = new Date(
    Math.floor(Date.parse(generatedAt) / (60 * 60 * 1_000)) * 60 * 60 * 1_000,
  ).toISOString();
  const state = {
    assetKey:'equity:AAPL',
    symbol:'AAPL',
    category:'equity',
    cohortFingerprint:'abcdefgh1234',
    observedBucket,
    evaluationStatus:full ? 'triggered' : 'warming',
    sameCohort:full ? true : null,
    currentOpenInterestUsd:6_000_000,
    peak24hOpenInterestUsd:full ? 8_000_001 : null,
    drawdown24hUsd:full ? 2_000_001 : null,
    drawdown24hPct:full ? Number(((2_000_001 / 8_000_001) * 100).toFixed(6)) : null,
    trough24hOpenInterestUsd:full ? 4_000_000 : null,
    increase24hUsd:full ? 2_000_000 : null,
    increase24hPct:full ? 50 : null,
    reasonCodes:full ? [] : ['OI_HISTORY_HOUR_MISSING'],
    marketContext:{
      version:'rwa-oi-market-context/v2',
      price24h:{
        coverageStatus:'full',
        selectionMethod:'largest-current-oi-listing-with-available-change',
        observedListings:5,
        expectedListings:5,
        observedAt:generatedAt,
        representative:{
          venue:'binance',
          venueSymbol:'AAPLUSDT',
          change24hPct:2,
          method:'official-change',
          status:'full',
          currentOpenInterestSharePct:20,
        },
        rangePct:{ min:1, max:5 },
        reasonCode:null,
      },
      funding:{
        status:'full', venue:'binance', venueSymbol:'AAPLUSDT', ratePct:0.01,
        intervalHours:8, observedAt:generatedAt, reasonCode:null,
      },
      positioning:full ? {
        status:'full',
        venue:'binance',
        venueSymbol:'AAPLUSDT',
        metric:'top-trader-position-ratio',
        scope:'top-20%-by-margin-balance-position-ratio',
        period:'1h',
        longShortRatio:1.05,
        longPositionPct:51.22,
        shortPositionPct:48.78,
        bias:'neutral',
        observedAt:'2026-08-14T11:00:00.000Z',
        reasonCode:null,
      } : {
        status:'unavailable',
        venue:'binance',
        venueSymbol:'AAPLUSDT',
        metric:null,
        scope:null,
        period:null,
        longShortRatio:null,
        longPositionPct:null,
        shortPositionPct:null,
        bias:'unavailable',
        observedAt:null,
        reasonCode:'OI_POSITIONING_NOT_REQUESTED',
      },
    },
  };
  return {
    formulaVersion:'rwa-oi-liquidation-proxy-1.0',
    rangeFormulaVersion:'rwa-oi-24h-range-1.0',
    generatedAt,
    status,
    rowLimit:100,
    scope:'All identity-verified RWA perpetual canonical assets from the current five-source snapshot',
    thresholds:{
      minVolume24hUsdExclusive:1_000_000,
      liquidationProxyDropUsdExclusive:2_000_000,
      risingCompletedDays:3,
      peakLookbackHours:24,
      topTraderBullishAbove:1.05,
      topTraderBearishBelow:0.95,
      logic:'or',
    },
    methodology:{
      universe:'all verified canonical RWA perpetual assets',
      eligibility:'rolling 24h USD volume strictly above threshold',
      openInterest:'complete exact-listing USD OI aggregate',
      threeDayTrend:'three sealed completed UTC-day closes',
      liquidationProxy:'24h comparable OI peak minus current OI',
      twentyFourHourRange:'24h comparable OI trough to current increase',
      logic:'OI rising OR liquidation proxy',
      price24h:'largest-current-OI exact listing plus cross-listing range',
      topTraderPositions:'optional exact Binance contract enrichment',
      limitations:'proxy is not trade-by-trade liquidation data',
    },
    sources,
    coverage:{
      expectedSources:5,
      availableSources:5,
      fullCatalogSources:5,
      acceptedListings:5,
      quarantinedListings:0,
      verifiedAssets:1,
      identityConflicts:0,
      volumeEligibleAssets:1,
      completeEligibleAssets:1,
      missingEligibleAssets:0,
      filterUnknownAssets:0,
    },
    counts:{
      verifiedAssets:1,
      filteredLowVolume:0,
      filterUnknown:0,
      volumeEligibleAssets:1,
      completeEligibleAssets:1,
      missingEligibleAssets:0,
      alerts:full ? 1 : 0,
      oiRising:full ? 1 : 0,
      liquidationProxy:full ? 1 : 0,
      both:full ? 1 : 0,
      perpListings:5,
      topTraderAvailable:full ? 1 : 0,
    },
    history:{
      status:full ? 'full' : 'warming',
      ready:full,
      cadence:'utc-hourly-idempotent',
      storedHourlyBuckets:full ? 96 : 0,
      retentionHours:96,
      requiredHourlyBuckets:24,
      requiredCompletedDays:3,
      readyAssets:full ? 1 : 0,
      trendReadyAssets:full ? 1 : 0,
      drawdownReadyAssets:full ? 1 : 0,
      oldestAt:full ? '2026-08-10T12:00:00.000Z' : null,
      latestAt:full ? '2026-08-14T11:00:00.000Z' : null,
    },
    persistence:{
      mode:'vercel-runtime-cache',
      status:'partial',
      namespace:'rwa-signal-oi-liquidation-hourly-v1',
      writer:{ requested:false, succeeded:null },
      writeStatus:'read-only',
      error:null,
    },
    stateCoverage:{ expectedEligibleAssets:1, returnedStates:1, complete:true },
    states:[state],
    rows:full ? [row] : [],
  };
}

test('Signal volume health treats baseline warming as a non-critical warning', () => {
  const result = validateSignalRadarSnapshot(basePayload('warming'), NOW);
  assert.equal(result.contractValid, true);
  assert.equal(result.status, 'warn');
  assert.equal(result.identityConflict, false);
  assert.equal(result.spotVolumePrice.contractValid, true);
  assert.equal(result.spotVolumePrice.status, 'warming');
});

test('Signal volume health passes a fresh full five-source snapshot', () => {
  const payload = basePayload('full');
  const result = validateSignalRadarSnapshot(payload, NOW);
  assert.equal(result.status, 'pass');
  assert.equal(result.invalidVolumeRows, 0);
  assert.equal(result.monitoredCoverageValid, true);
  assert.equal(result.spotVolumePrice.contractValid, true);
  assert.equal(result.spotVolumePrice.invalidRows, 0);
});

test('Signal volume health fails identity conflicts, Crypto leakage, and illegal server levels', () => {
  const conflict = basePayload('warming');
  conflict.coverage.identityConflicts = 1;
  assert.equal(validateSignalRadarSnapshot(conflict, NOW).identityConflict, true);
  assert.equal(validateSignalRadarSnapshot(conflict, NOW).status, 'fail');

  const crypto = basePayload('warming');
  crypto.assets[0].category = 'crypto';
  const cryptoResult = validateSignalRadarSnapshot(crypto, NOW);
  assert.equal(cryptoResult.status, 'fail');
  assert.equal(cryptoResult.cryptoCategoryCount, 1);

  const illegal = basePayload('full');
  illegal.perpVolumeAnomalies.rows = [{ ...validHighRow(), level:'medium', ratio7d:2 }];
  const illegalResult = validateSignalRadarSnapshot(illegal, NOW);
  assert.equal(illegalResult.status, 'fail');
  assert.equal(illegalResult.invalidVolumeRows, 1);
});

test('Signal volume health rejects stale snapshots and incomplete source contracts', () => {
  const stale = basePayload('warming');
  stale.generatedAt = new Date(NOW - 3 * 60 * 60_000).toISOString();
  stale.perpVolumeAnomalies.generatedAt = stale.generatedAt;
  assert.equal(validateSignalRadarSnapshot(stale, NOW).fresh, false);

  const missingSource = basePayload('warming');
  delete missingSource.sources.okx;
  const missingResult = validateSignalRadarSnapshot(missingSource, NOW);
  assert.equal(missingResult.sourcesValid, false);
  assert.equal(missingResult.status, 'fail');
});

test('Signal volume health rejects impossible Full summaries and history maturity', () => {
  const payload = basePayload('full');
  payload.perpVolumeAnomalies.readyAssets = 0;
  payload.perpVolumeAnomalies.frequencyReadyAssets = 0;
  payload.perpVolumeAnomalies.counts.high = 999;
  payload.perpVolumeAnomalies.history.storedDays = 0;
  payload.perpVolumeAnomalies.history.priorStoredDays = 0;
  payload.perpVolumeAnomalies.history.oldestAt = null;
  payload.perpVolumeAnomalies.history.newestAt = null;
  payload.persistence.dailyVolume.storedDays = 0;

  const result = validateSignalRadarSnapshot(payload, NOW);
  assert.equal(result.status, 'fail');
  assert.equal(result.countsValid, false);
  assert.equal(result.volumeStatusCoherent, false);
});

test('Signal volume health rejects a declared Full response when any venue is Partial', () => {
  const payload = basePayload('full');
  payload.sources.okx.status = 'partial';

  const result = validateSignalRadarSnapshot(payload, NOW);
  assert.equal(result.allSourcesFull, false);
  assert.equal(result.status, 'fail');
  assert.match(result.reason, /coverage or status contract/);
});

test('Signal volume health rejects a ratio that contradicts its published volumes', () => {
  const payload = basePayload('full');
  payload.perpVolumeAnomalies.rows[0] = {
    ...payload.perpVolumeAnomalies.rows[0],
    currentVolumeUsd:1,
    average7dVolumeUsd:100,
    ratio7d:2,
  };

  const result = validateSignalRadarSnapshot(payload, NOW);
  assert.equal(result.status, 'fail');
  assert.equal(result.invalidVolumeRows, 1);
});

test('Spot anomaly health enforces the OR thresholds and the $500K hard filter', () => {
  const belowFloor = basePayload('full');
  belowFloor.spotVolumePriceAnomalies.rows[0].currentVolumeUsd = 499_999;
  assert.equal(validateSignalRadarSnapshot(belowFloor, NOW).spotVolumePrice.invalidRows, 1);

  const falsePriceTrigger = basePayload('full');
  Object.assign(falsePriceTrigger.spotVolumePriceAnomalies.rows[0], {
    yesterdayVolumeUsd:null,
    volumeRatio:null,
    priceChange24hPct:-15,
    trigger:'price_surge',
    volumeTriggered:false,
    priceTriggered:true,
  });
  Object.assign(falsePriceTrigger.spotVolumePriceAnomalies.rows[0].fieldStatus, {
    yesterdayVolume:'unavailable',
    volumeRatio:'unavailable',
  });
  assert.equal(validateSignalRadarSnapshot(falsePriceTrigger, NOW).spotVolumePrice.invalidRows, 1);

  const wrongThreshold = basePayload('full');
  wrongThreshold.spotVolumePriceAnomalies.thresholds.volumeRatio = 2.99;
  assert.equal(validateSignalRadarSnapshot(wrongThreshold, NOW).spotVolumePrice.thresholdsValid, false);
});

test('Spot anomaly health preserves a true zero prior while leaving its ratio unavailable', () => {
  const payload = basePayload('full');
  const section = payload.spotVolumePriceAnomalies;
  Object.assign(section.rows[0], {
    yesterdayVolumeUsd:0,
    volumeRatio:null,
    trigger:'price_surge',
    volumeTriggered:false,
    priceTriggered:true,
    status:'full',
    reasonCodes:['PRICE_SURGE', 'ZERO_PRIOR_VOLUME'],
  });
  Object.assign(section.rows[0].fieldStatus, {
    yesterdayVolume:'estimated',
    volumeRatio:'unavailable',
  });
  Object.assign(section.counts, { volumeSpike:0, priceSurge:1, both:0 });
  Object.assign(section.coverage, { volumeComparableListings:0 });
  Object.assign(section, { status:'warming' });
  Object.assign(section.history, { status:'warming' });

  const result = validateSignalRadarSnapshot(payload, NOW);
  assert.equal(result.spotVolumePrice.contractValid, true);
  assert.equal(result.spotVolumePrice.status, 'warming');
  assert.equal(result.status, 'warn');
});

test('Spot anomaly health rejects duplicate listings, Crypto categories, and Kraken UTC-day price', () => {
  const duplicate = basePayload('full');
  duplicate.spotVolumePriceAnomalies.rows.push({ ...duplicate.spotVolumePriceAnomalies.rows[0], rank:2 });
  duplicate.spotVolumePriceAnomalies.counts.alerts = 2;
  duplicate.spotVolumePriceAnomalies.counts.volumeSpike = 2;
  duplicate.spotVolumePriceAnomalies.counts.priceSurge = 2;
  duplicate.spotVolumePriceAnomalies.counts.both = 2;
  duplicate.spotVolumePriceAnomalies.counts.perpListed = 2;
  assert.equal(validateSignalRadarSnapshot(duplicate, NOW).spotVolumePrice.contractValid, false);

  const crypto = basePayload('full');
  Object.assign(crypto.spotVolumePriceAnomalies.rows[0], {
    category:'crypto', assetKey:'crypto:AAPL',
  });
  const cryptoResult = validateSignalRadarSnapshot(crypto, NOW);
  assert.equal(cryptoResult.spotVolumePrice.cryptoCategoryCount, 1);
  assert.equal(cryptoResult.status, 'fail');

  const kraken = basePayload('full');
  Object.assign(kraken.spotVolumePriceAnomalies.rows[0], {
    listingKey:'spot:kraken:AAPL/USD', venue:'kraken', venueSymbol:'AAPL/USD', quote:'USD',
  });
  assert.equal(validateSignalRadarSnapshot(kraken, NOW).spotVolumePrice.invalidRows, 1);
});

test('Spot anomaly health rejects false Full, wrong sealed day, and writable public state', () => {
  const partialSource = basePayload('full');
  partialSource.spotVolumePriceAnomalies.sources.okx.status = 'partial';
  partialSource.spotVolumePriceAnomalies.coverage.fullSources = 4;
  const partialResult = validateSignalRadarSnapshot(partialSource, NOW);
  assert.equal(partialResult.spotVolumePrice.allSourcesFull, false);
  assert.equal(partialResult.spotVolumePrice.statusCoherent, false);

  const wrongDay = basePayload('full');
  wrongDay.spotVolumePriceAnomalies.history.priorDay = '2026-08-12T00:00:00.000Z';
  assert.equal(validateSignalRadarSnapshot(wrongDay, NOW).spotVolumePrice.historyValid, false);

  const writableReader = basePayload('full');
  writableReader.spotVolumePriceAnomalies.persistence.writer.requested = true;
  writableReader.spotVolumePriceAnomalies.persistence.writer.succeeded = true;
  writableReader.spotVolumePriceAnomalies.persistence.writeStatus = 'stored';
  assert.equal(validateSignalRadarSnapshot(writableReader, NOW).spotVolumePrice.persistenceValid, false);

  const topMismatch = basePayload('full');
  topMismatch.persistence.spotVolumePrice.storedDays = 7;
  assert.equal(validateSignalRadarSnapshot(topMismatch, NOW).spotTopPersistenceValid, false);

  const missingPriceCoverage = basePayload('full');
  delete missingPriceCoverage.spotVolumePriceAnomalies.sources.binance.priceFieldCount;
  assert.equal(validateSignalRadarSnapshot(missingPriceCoverage, NOW).spotVolumePrice.sourcesValid, false);
});

test('Spot anomaly health fails when all five Spot sources are unavailable', () => {
  const payload = basePayload('warming');
  const section = payload.spotVolumePriceAnomalies;
  section.status = 'unavailable';
  section.sources = Object.fromEntries(Object.keys(section.sources).map(venue => [venue, {
    status:'unavailable', listingCount:0, marketFieldCount:0, priceFieldCount:0, warnings:['SOURCE_UNAVAILABLE'],
  }]));
  Object.assign(section.coverage, {
    availableSources:0,
    fullSources:0,
    verifiedListings:0,
    volumeAvailableListings:0,
    priorVolumeAvailableListings:0,
    priceAvailableListings:0,
    liquidityEligibleListings:0,
    volumeComparableListings:0,
    priceComparableListings:0,
  });
  Object.assign(section.counts, {
    alerts:0, volumeSpike:0, priceSurge:0, both:0, perpListed:0,
    filteredLowLiquidity:0, filterUnknown:0,
  });
  section.rows = [];

  const result = validateSignalRadarSnapshot(payload, NOW);
  assert.equal(result.spotVolumePrice.contractValid, true);
  assert.equal(result.status, 'fail');
  assert.match(result.reason, /coverage is unavailable/);
});

test('Spot Runtime Cache read failure is an explicit degraded state, not a malformed contract', () => {
  const payload = basePayload('warming');
  const section = payload.spotVolumePriceAnomalies;
  section.status = 'partial';
  section.history.status = 'unavailable';
  Object.assign(section.persistence, {
    status:'unavailable',
    writeStatus:'unavailable',
    error:'spot daily history unavailable',
  });
  Object.assign(payload.persistence.spotVolumePrice, {
    status:'unavailable',
    writeStatus:'unavailable',
    error:'spot daily history unavailable',
  });

  const result = validateSignalRadarSnapshot(payload, NOW);
  assert.equal(result.spotVolumePrice.persistenceValid, true);
  assert.equal(result.spotTopPersistenceValid, true);
  assert.equal(result.contractValid, true);
  assert.equal(result.status, 'warn');
});

test('Signal health requires the additive Spot child even though the browser isolates it', () => {
  const missing = basePayload('full');
  delete missing.spotVolumePriceAnomalies;
  const result = validateSignalRadarSnapshot(missing, NOW);
  assert.equal(result.spotVolumePrice.contractValid, false);
  assert.equal(result.status, 'fail');
  assert.match(result.reason, /Spot volume\/price anomaly contract/);
});

test('OI health enforces strict $1m eligibility and strict $2m drawdown semantics', () => {
  const volumeBoundary = basePayload('full');
  const boundaryRow = volumeBoundary.oiLiquidationAnomalies.rows[0];
  boundaryRow.listings.forEach(row => { row.volume24hUsd = 200_000; });
  boundaryRow.currentVolume24hUsd = 1_000_000;
  const boundaryResult = validateSignalRadarSnapshot(volumeBoundary, NOW);
  assert.equal(boundaryResult.oiLiquidation.invalidRows, 1);
  assert.equal(boundaryResult.status, 'fail');

  const drawdownBoundary = basePayload('full');
  const drawdownRow = drawdownBoundary.oiLiquidationAnomalies.rows[0];
  drawdownRow.peak24hOpenInterestUsd = 8_000_000;
  drawdownRow.drawdown24hUsd = 2_000_000;
  assert.equal(validateSignalRadarSnapshot(drawdownBoundary, NOW).oiLiquidation.invalidRows, 1,
    'an exact $2m decline cannot be declared liquidation_proxy');

  drawdownRow.trigger = 'oi_rising';
  Object.assign(drawdownBoundary.oiLiquidationAnomalies.counts, {
    alerts:1, oiRising:1, liquidationProxy:0, both:0,
  });
  Object.assign(drawdownBoundary.oiLiquidationAnomalies.states[0], {
    evaluationStatus:'clear',
    peak24hOpenInterestUsd:8_000_000,
    drawdown24hUsd:2_000_000,
    drawdown24hPct:25,
  });
  Object.assign(
    drawdownBoundary.oiLiquidationAnomalies.states[0].marketContext.positioning,
    {
      status:'unavailable', metric:null, scope:null, period:null, longShortRatio:null,
      longPositionPct:null, shortPositionPct:null, bias:'unavailable', observedAt:null,
      reasonCode:'OI_POSITIONING_NOT_REQUESTED',
    },
  );
  const strictBoundaryValid = validateSignalRadarSnapshot(drawdownBoundary, NOW);
  assert.equal(strictBoundaryValid.oiLiquidation.contractValid, true);
  assert.equal(strictBoundaryValid.status, 'pass');
});

test('OI health validates three exact completed UTC days and row aggregate arithmetic', () => {
  const nonRising = basePayload('full');
  nonRising.oiLiquidationAnomalies.rows[0].completedDailyCloses[1].openInterestUsd = 5_000_000;
  assert.equal(validateSignalRadarSnapshot(nonRising, NOW).oiLiquidation.invalidRows, 1);

  const currentDayLeak = basePayload('full');
  currentDayLeak.oiLiquidationAnomalies.rows[0].completedDailyCloses[2].day = '2026-08-14';
  assert.equal(validateSignalRadarSnapshot(currentDayLeak, NOW).oiLiquidation.invalidRows, 1);

  const volumeMismatch = basePayload('full');
  volumeMismatch.oiLiquidationAnomalies.rows[0].listings[0].volume24hUsd += 0.01;
  assert.equal(validateSignalRadarSnapshot(volumeMismatch, NOW).oiLiquidation.invalidRows, 1);

  const oiMismatch = basePayload('full');
  oiMismatch.oiLiquidationAnomalies.rows[0].listings[0].openInterestUsd += 0.01;
  assert.equal(validateSignalRadarSnapshot(oiMismatch, NOW).oiLiquidation.invalidRows, 1);

  const falsePrecision = basePayload('full');
  falsePrecision.oiLiquidationAnomalies.rows[0].status = 'full';
  assert.equal(validateSignalRadarSnapshot(falsePrecision, NOW).oiLiquidation.invalidRows, 1,
    'complete coverage must not relabel an OI/liquidation estimate as Full');
});

test('OI health requires complete, coherent, untruncated recovery states', () => {
  const missing = basePayload('full');
  missing.oiLiquidationAnomalies.states = [];
  missing.oiLiquidationAnomalies.stateCoverage.returnedStates = 0;
  missing.oiLiquidationAnomalies.stateCoverage.complete = false;
  const missingResult = validateSignalRadarSnapshot(missing, NOW);
  assert.equal(missingResult.oiLiquidation.stateCoverageValid, false);
  assert.equal(missingResult.oiLiquidation.statesValid, false);
  assert.equal(missingResult.status, 'fail');

  const wrongPercent = basePayload('full');
  wrongPercent.oiLiquidationAnomalies.states[0].drawdown24hPct = 99;
  const wrongPercentResult = validateSignalRadarSnapshot(wrongPercent, NOW);
  assert.equal(wrongPercentResult.oiLiquidation.invalidStates, 1);
  assert.equal(wrongPercentResult.status, 'fail');

  const falseRecovery = basePayload('full');
  Object.assign(falseRecovery.oiLiquidationAnomalies.states[0], {
    evaluationStatus:'clear',
    sameCohort:false,
    reasonCodes:['OI_COHORT_CHANGED'],
  });
  falseRecovery.oiLiquidationAnomalies.counts.liquidationProxy = 0;
  falseRecovery.oiLiquidationAnomalies.counts.both = 0;
  const falseRecoveryResult = validateSignalRadarSnapshot(falseRecovery, NOW);
  assert.equal(falseRecoveryResult.oiLiquidation.invalidStates, 1);
  assert.equal(falseRecoveryResult.status, 'fail');
});

test('OI health recomputes state price context from exact alert listings', () => {
  const wrongRepresentative = basePayload('full');
  wrongRepresentative.oiLiquidationAnomalies.states[0]
    .marketContext.price24h.representative.venue = 'gate';
  assert.equal(validateSignalRadarSnapshot(wrongRepresentative, NOW).oiLiquidation.statesValid, false);

  const wrongRange = basePayload('full');
  wrongRange.oiLiquidationAnomalies.states[0].marketContext.price24h.rangePct.max = 4;
  assert.equal(validateSignalRadarSnapshot(wrongRange, NOW).oiLiquidation.statesValid, false);

  const impossibleListing = basePayload('full');
  impossibleListing.oiLiquidationAnomalies.rows[0].listings[0].change24hPct = -100.00001;
  assert.equal(validateSignalRadarSnapshot(impossibleListing, NOW).oiLiquidation.invalidRows, 1);

  const wrongFundingVenue = basePayload('full');
  wrongFundingVenue.oiLiquidationAnomalies.states[0].marketContext.funding.venue = 'tradexyz';
  assert.equal(validateSignalRadarSnapshot(wrongFundingVenue, NOW).oiLiquidation.statesValid, false);

  const wrongFundingRate = basePayload('full');
  wrongFundingRate.oiLiquidationAnomalies.states[0].marketContext.funding.ratePct = 0.02;
  assert.equal(validateSignalRadarSnapshot(wrongFundingRate, NOW).oiLiquidation.statesValid, false);

  const wrongPositioningVenue = basePayload('full');
  wrongPositioningVenue.oiLiquidationAnomalies.states[0].marketContext.positioning.venue = 'tradexyz';
  assert.equal(validateSignalRadarSnapshot(wrongPositioningVenue, NOW).oiLiquidation.statesValid, false);

  const wrongPositioningSymbol = basePayload('full');
  wrongPositioningSymbol.oiLiquidationAnomalies.states[0].marketContext.positioning.venueSymbol = 'MSFTUSDT';
  assert.equal(validateSignalRadarSnapshot(wrongPositioningSymbol, NOW).oiLiquidation.statesValid, false);
});

test('OI health requires exact five-source coverage and coherent history maturity', () => {
  const catalogOnly = basePayload('warming');
  Object.assign(catalogOnly.oiLiquidationAnomalies.sources.gate, {
    status:'unavailable', listingCount:1, volumeFieldCount:0, openInterestFieldCount:0,
    warnings:['VOLUME_INCOMPLETE', 'OPEN_INTEREST_INCOMPLETE'],
  });
  catalogOnly.oiLiquidationAnomalies.coverage.availableSources = 4;
  const catalogOnlyResult = validateSignalRadarSnapshot(catalogOnly, NOW);
  assert.equal(catalogOnlyResult.oiLiquidation.sourcesValid, true);
  assert.equal(catalogOnlyResult.oiLiquidation.coverageValid, true,
    'a non-empty official catalog remains catalog-complete when all market fields are unavailable');
  assert.equal(catalogOnlyResult.oiLiquidation.contractValid, true);

  const catalogBlockedWithCompleteFields = basePayload('full');
  Object.assign(catalogBlockedWithCompleteFields.oiLiquidationAnomalies.sources.gate, {
    status:'partial',
    warnings:['IDENTITY_COVERAGE_INCOMPLETE'],
  });
  catalogBlockedWithCompleteFields.oiLiquidationAnomalies.status = 'partial';
  catalogBlockedWithCompleteFields.oiLiquidationAnomalies.coverage.fullCatalogSources = 4;
  const catalogBlockedResult = validateSignalRadarSnapshot(catalogBlockedWithCompleteFields, NOW);
  assert.equal(catalogBlockedResult.oiLiquidation.sourcesValid, true,
    'complete market fields remain Partial when official catalog identity coverage is blocked');
  assert.equal(catalogBlockedResult.oiLiquidation.coverageValid, true);
  assert.equal(catalogBlockedResult.oiLiquidation.contractValid, true);
  assert.equal(catalogBlockedResult.status, 'warn');

  const missingField = basePayload('full');
  delete missingField.oiLiquidationAnomalies.sources.gate.openInterestFieldCount;
  assert.equal(validateSignalRadarSnapshot(missingField, NOW).oiLiquidation.sourcesValid, false);

  const catalogShrink = basePayload('full');
  catalogShrink.oiLiquidationAnomalies.sources.okx.warnings.push('IDENTITY_COVERAGE_INCOMPLETE');
  assert.equal(validateSignalRadarSnapshot(catalogShrink, NOW).oiLiquidation.coverageValid, false);
  catalogShrink.oiLiquidationAnomalies.coverage.fullCatalogSources = 4;
  assert.equal(validateSignalRadarSnapshot(catalogShrink, NOW).oiLiquidation.statusCoherent, false);

  const invertedReadiness = basePayload('full');
  invertedReadiness.oiLiquidationAnomalies.history.trendReadyAssets = 0;
  assert.equal(validateSignalRadarSnapshot(invertedReadiness, NOW).oiLiquidation.historyValid, false);

  const wrongCadence = basePayload('full');
  wrongCadence.oiLiquidationAnomalies.history.cadence = 'hourly';
  assert.equal(validateSignalRadarSnapshot(wrongCadence, NOW).oiLiquidation.historyValid, false);
});

test('OI health exposes a closed unknown-type quarantine as Partial/Warn and recomputes its counts', () => {
  const payload = basePayload('full');
  Object.assign(payload.sources.binance, {
    status:'partial', catalogListingCount:2, quarantinedListings:1,
    warnings:['UNSUPPORTED_OFFICIAL_ROWS_QUARANTINED'],
  });
  payload.status = 'partial';
  Object.assign(payload.oiLiquidationAnomalies.sources.binance, {
    status:'partial', catalogListingCount:2, quarantinedListings:1,
    warnings:['UNSUPPORTED_OFFICIAL_ROWS_QUARANTINED'],
  });
  Object.assign(payload.oiLiquidationAnomalies.coverage, {
    fullCatalogSources:4,
    quarantinedListings:1,
  });
  payload.oiLiquidationAnomalies.status = 'partial';
  payload.oiLiquidationAnomalies.history.status = 'partial';
  payload.perpVolumeAnomalies.status = 'partial';

  const result = validateSignalRadarSnapshot(payload, NOW);
  assert.equal(result.contractValid, true);
  assert.equal(result.status, 'warn');
  assert.equal(result.oiLiquidation.contractValid, true);
  assert.equal(result.oiLiquidation.quarantinedListings, 1);
  assert.equal(result.reason, '1 unsupported official OI listing row(s) quarantined');

  const wrongCoverage = structuredClone(payload);
  wrongCoverage.oiLiquidationAnomalies.coverage.quarantinedListings = 0;
  assert.equal(validateSignalRadarSnapshot(wrongCoverage, NOW).oiLiquidation.coverageValid, false);

  const missingWarning = structuredClone(payload);
  missingWarning.oiLiquidationAnomalies.sources.binance.warnings = [];
  assert.equal(validateSignalRadarSnapshot(missingWarning, NOW).oiLiquidation.sourcesValid, false);

  const falseFull = structuredClone(payload);
  falseFull.oiLiquidationAnomalies.sources.binance.status = 'full';
  assert.equal(validateSignalRadarSnapshot(falseFull, NOW).oiLiquidation.sourcesValid, false);

  const schemaDrift = structuredClone(payload);
  Object.assign(schemaDrift.sources.binance, {
    catalogListingCount:3,
    quarantinedListings:2,
  });
  Object.assign(schemaDrift.oiLiquidationAnomalies.sources.binance, {
    catalogListingCount:3,
    quarantinedListings:2,
  });
  schemaDrift.oiLiquidationAnomalies.coverage.quarantinedListings = 2;
  const schemaDriftResult = validateSignalRadarSnapshot(schemaDrift, NOW);
  assert.equal(schemaDriftResult.sourcesValid, false,
    'two unknown official rows exceed the narrow quarantine exception');
  assert.equal(schemaDriftResult.oiLiquidation.sourcesValid, false);
  assert.equal(schemaDriftResult.status, 'fail');
});

test('OI health treats Binance Top Trader as exact optional evidence, never default Neutral', () => {
  const unavailable = basePayload('full');
  const row = unavailable.oiLiquidationAnomalies.rows[0];
  row.topTraderPositions = [{
    venueSymbol:'AAPLUSDT', status:'unavailable', longShortRatio:null,
    longPositionPct:null, shortPositionPct:null, bias:'unavailable', observedAt:null,
    reasonCode:'TOP_TRADER_UPSTREAM_UNAVAILABLE',
  }];
  row.overallTraderBias = 'unavailable';
  row.fieldStatus.topTraderPositions = 'unavailable';
  unavailable.oiLiquidationAnomalies.counts.topTraderAvailable = 0;
  Object.assign(unavailable.oiLiquidationAnomalies.states[0].marketContext.positioning, {
    status:'unavailable',
    longShortRatio:null,
    longPositionPct:null,
    shortPositionPct:null,
    bias:'unavailable',
    observedAt:null,
    reasonCode:'TOP_TRADER_UPSTREAM_UNAVAILABLE',
  });
  const unavailableResult = validateSignalRadarSnapshot(unavailable, NOW);
  assert.equal(unavailableResult.oiLiquidation.contractValid, true);
  assert.equal(unavailableResult.status, 'pass');

  const omitted = basePayload('full');
  omitted.oiLiquidationAnomalies.rows[0].topTraderPositions = [];
  omitted.oiLiquidationAnomalies.rows[0].overallTraderBias = 'unavailable';
  omitted.oiLiquidationAnomalies.rows[0].fieldStatus.topTraderPositions = 'unavailable';
  omitted.oiLiquidationAnomalies.counts.topTraderAvailable = 0;
  assert.equal(validateSignalRadarSnapshot(omitted, NOW).oiLiquidation.invalidRows, 1,
    'every exact Binance alert contract needs an explicit Full or Unavailable position row');

  const boundaryContradiction = basePayload('full');
  boundaryContradiction.oiLiquidationAnomalies.rows[0].topTraderPositions[0].longShortRatio = 1.0501;
  assert.equal(validateSignalRadarSnapshot(boundaryContradiction, NOW).oiLiquidation.invalidRows, 1);
  boundaryContradiction.oiLiquidationAnomalies.rows[0].topTraderPositions[0].bias = 'bullish';
  boundaryContradiction.oiLiquidationAnomalies.rows[0].overallTraderBias = 'bullish';
  boundaryContradiction.oiLiquidationAnomalies.states[0]
    .marketContext.positioning.longShortRatio = 1.0501;
  boundaryContradiction.oiLiquidationAnomalies.states[0]
    .marketContext.positioning.bias = 'bullish';
  assert.equal(validateSignalRadarSnapshot(boundaryContradiction, NOW).oiLiquidation.contractValid, true);

  const stale = basePayload('full');
  stale.oiLiquidationAnomalies.rows[0].topTraderPositions[0].observedAt = '2026-08-14T08:54:59.999Z';
  assert.equal(validateSignalRadarSnapshot(stale, NOW).oiLiquidation.invalidRows, 1);

  const wrongSymbol = basePayload('full');
  wrongSymbol.oiLiquidationAnomalies.rows[0].topTraderPositions[0].venueSymbol = 'MSFTUSDT';
  assert.equal(validateSignalRadarSnapshot(wrongSymbol, NOW).oiLiquidation.invalidRows, 1);
});

test('OI health rejects writable public state, persistence mismatch, identity conflicts, and Crypto rows', () => {
  const writable = basePayload('full');
  Object.assign(writable.oiLiquidationAnomalies.persistence, {
    writer:{ requested:true, succeeded:true }, writeStatus:'stored',
  });
  assert.equal(validateSignalRadarSnapshot(writable, NOW).oiLiquidation.persistenceValid, false);

  const mismatch = basePayload('full');
  mismatch.persistence.oiLiquidation.storedHours = 95;
  assert.equal(validateSignalRadarSnapshot(mismatch, NOW).oiTopPersistenceValid, false);

  const conflict = basePayload('full');
  conflict.oiLiquidationAnomalies.status = 'partial';
  conflict.oiLiquidationAnomalies.coverage.identityConflicts = 1;
  const conflictResult = validateSignalRadarSnapshot(conflict, NOW);
  assert.equal(conflictResult.oiLiquidation.identityConflict, true);
  assert.equal(conflictResult.status, 'fail');

  const crypto = basePayload('full');
  Object.assign(crypto.oiLiquidationAnomalies.rows[0], {
    category:'crypto', assetKey:'crypto:AAPL',
  });
  const cryptoResult = validateSignalRadarSnapshot(crypto, NOW);
  assert.equal(cryptoResult.oiLiquidation.cryptoCategoryCount, 1);
  assert.equal(cryptoResult.status, 'fail');
});

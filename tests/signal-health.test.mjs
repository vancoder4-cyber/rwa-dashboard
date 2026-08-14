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
      status:'full', listingCount:1, warnings:[],
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

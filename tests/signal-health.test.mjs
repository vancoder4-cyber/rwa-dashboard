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
});

test('Signal volume health passes a fresh full five-source snapshot', () => {
  const payload = basePayload('full');
  const result = validateSignalRadarSnapshot(payload, NOW);
  assert.equal(result.status, 'pass');
  assert.equal(result.invalidVolumeRows, 0);
  assert.equal(result.monitoredCoverageValid, true);
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

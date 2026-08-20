import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LISTING_MARKET_FACT_DATA_FAMILY,
  LISTING_MARKET_FACT_POLICY_VERSION,
  classifyListingMarketFactRevisionBatch,
  classifyListingMarketFactRevision,
  listingMarketFactObservationKey,
  listingMarketFactPayloadChecksum,
  normalizeListingMarketFactObservation,
  prepareListingMarketFactRevision,
  resolveMarketFactWriteMode,
} from '../api/_lib/market-fact-revisions.js';

const UUIDS = Object.freeze({
  cycle:'11111111-1111-4111-8111-111111111111',
  sourceRun:'22222222-2222-4222-8222-222222222222',
  artifact:'33333333-3333-4333-8333-333333333333',
  revision:'44444444-4444-4444-8444-444444444444',
});

function fixture(overrides = {}) {
  return {
    dataFamily:LISTING_MARKET_FACT_DATA_FAMILY,
    policyVersion:LISTING_MARKET_FACT_POLICY_VERSION,
    methodVersion:'binance-tradifi-hourly/v1',
    cycleId:UUIDS.cycle,
    sourceRunId:UUIDS.sourceRun,
    sourceId:4,
    instrumentVersionId:1042,
    assetVersionId:502,
    inputArtifactId:UUIDS.artifact,
    eventAt:'2026-08-20T10:59:59.000Z',
    validFrom:'2026-08-20T10:00:00.000Z',
    validTo:'2026-08-20T11:00:00.000Z',
    capturedAt:'2026-08-20T11:00:02.000Z',
    quoteCurrency:'usdt',
    nativeCurrency:'usd',
    lastPrice:100,
    markPrice:100.1,
    referencePriceUsd:null,
    volume24hNative:1234,
    volume24hUsd:123400,
    openInterestNative:500,
    openInterestUsd:50000,
    fundingRate:0.0001,
    priceChange24hPct:1.25,
    priceStatus:'partial',
    volumeStatus:'full',
    openInterestStatus:'full',
    fundingStatus:'full',
    volumeMethod:'official-quote-volume/v1',
    openInterestMethod:'official-oi/v1',
    referencePriceMethod:null,
    qualityFlags:[' source-full ', 'IDENTITY_VERIFIED', 'SOURCE-FULL'],
    ...overrides,
  };
}

test('market-fact writer mode is fail-closed and independent of catalog PG mode', () => {
  assert.equal(resolveMarketFactWriteMode({}), 'off');
  assert.equal(resolveMarketFactWriteMode({ PG_WRITE_MODE:'required' }), 'off');
  assert.equal(resolveMarketFactWriteMode({ MARKET_FACT_PG_WRITE_MODE:'SHADOW' }), 'shadow');
  assert.equal(resolveMarketFactWriteMode({ MARKET_FACT_PG_WRITE_MODE:'required' }), 'required');
  assert.throws(
    () => resolveMarketFactWriteMode({ MARKET_FACT_PG_WRITE_MODE:'write' }),
    /off, shadow, or required/,
  );
});

test('normalization preserves null versus zero and requires exact versioned identity', () => {
  const normalized = normalizeListingMarketFactObservation(fixture({
    volume24hNative:0,
    volume24hUsd:0,
  }));
  assert.equal(normalized.volume24hNative, 0);
  assert.equal(normalized.referencePriceUsd, null);
  assert.equal(normalized.quoteCurrency, 'USDT');
  assert.equal(normalized.nativeCurrency, 'USD');
  assert.deepEqual(normalized.qualityFlags, ['IDENTITY_VERIFIED', 'SOURCE-FULL']);
  assert.throws(() => normalizeListingMarketFactObservation(fixture({ ticker:'AAPL' })), /not an identity key/);
  assert.throws(() => normalizeListingMarketFactObservation(fixture({ instrumentVersionId:0 })), /positive safe integer/);
  assert.throws(() => normalizeListingMarketFactObservation(fixture({ lastPrice:-1 })), /cannot be negative/);
  assert.throws(
    () => normalizeListingMarketFactObservation(fixture({ priceStatus:'unavailable' })),
    /cannot carry a numeric value/,
  );
  assert.throws(
    () => normalizeListingMarketFactObservation(fixture({ fundingRate:null, fundingStatus:'full' })),
    /requires at least one numeric value/,
  );
  assert.throws(
    () => normalizeListingMarketFactObservation(fixture({ eventAt:'2026-08-20T11:00:00.000Z' })),
    /valid interval/,
  );
  assert.throws(
    () => normalizeListingMarketFactObservation(fixture({ referencePriceUsd:100, referencePriceMethod:null })),
    /referencePriceMethod is required/,
  );
  assert.throws(
    () => normalizeListingMarketFactObservation(fixture({ volumeMethod:null })),
    /volumeMethod is required/,
  );
  assert.throws(
    () => normalizeListingMarketFactObservation(fixture({ nativeCurrency:null })),
    /nativeCurrency is required/,
  );
});

test('observation keys bind source, exact instrument, method, units, and valid boundary', () => {
  const baseline = fixture();
  const baselineKey = listingMarketFactObservationKey(baseline);
  assert.match(baselineKey, /^[0-9a-f]{64}$/);
  assert.equal(listingMarketFactObservationKey(fixture({
    cycleId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sourceRunId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    capturedAt:'2026-08-20T11:05:00.000Z',
  })), baselineKey, 'collection evidence must not create a new observation series');
  for (const changed of [
    { sourceId:5 },
    { instrumentVersionId:1043 },
    { assetVersionId:503 },
    { methodVersion:'binance-tradifi-hourly/v2' },
    { volumeMethod:'official-quote-volume/v2' },
    { quoteCurrency:'USD' },
    { validFrom:'2026-08-20T09:00:00.000Z' },
  ]) {
    assert.notEqual(listingMarketFactObservationKey(fixture(changed)), baselineKey);
  }
  assert.equal(listingMarketFactPayloadChecksum(baseline), listingMarketFactPayloadChecksum(fixture({
    capturedAt:'2026-08-20T11:05:00.000Z',
  })));
  assert.notEqual(listingMarketFactPayloadChecksum(baseline), listingMarketFactPayloadChecksum(fixture({ lastPrice:100.1 })));
});

test('identical re-fetch skips a revision while a small restatement appends', () => {
  const baseline = fixture();
  const identical = prepareListingMarketFactRevision(baseline, {
    revisionId:UUIDS.revision,
    revisionNo:1,
    observation:fixture({ capturedAt:'2026-08-20T11:01:00.000Z' }),
  });
  assert.equal(identical.action, 'skip');
  assert.equal(identical.classification, 'identical');

  const normal = prepareListingMarketFactRevision(fixture({ lastPrice:100.4 }), {
    revisionId:UUIDS.revision,
    revisionNo:1,
    observation:baseline,
  });
  assert.equal(normal.action, 'append');
  assert.equal(normal.classification, 'normal-restatement');
  assert.equal(normal.revisionNo, 2);
  assert.equal(normal.supersedesRevisionId, UUIDS.revision);
});

test('price and quantity drift use conservative normal/review/anomalous gates', () => {
  const baseline = fixture();
  const review = classifyListingMarketFactRevision(baseline, fixture({ lastPrice:101 }));
  assert.equal(review.classification, 'review-required');
  assert.equal(review.accepted, false);
  assert.ok(review.reasonCodes.includes('PRICE_DELTA_REQUIRES_REVIEW'));

  const anomalous = classifyListingMarketFactRevision(baseline, fixture({ volume24hUsd:131000 }));
  assert.equal(anomalous.classification, 'anomalous');
  assert.equal(anomalous.accepted, false);
  assert.ok(anomalous.reasonCodes.includes('QUANTITY_DELTA_ANOMALOUS'));

  const zeroDenominator = classifyListingMarketFactRevision(
    fixture({ priceChange24hPct:0 }),
    fixture({ priceChange24hPct:0.01 }),
  );
  assert.equal(zeroDenominator.classification, 'review-required');
  assert.ok(zeroDenominator.reasonCodes.includes('ZERO_DENOMINATOR_REQUIRES_ABSOLUTE_POLICY'));
});

test('funding precision, null transitions, and status downgrades fail closed', () => {
  const baseline = fixture();
  assert.equal(
    classifyListingMarketFactRevision(baseline, fixture({ fundingRate:0.000100005 }), {
      fundingPrecision:0.00000001,
    }).classification,
    'normal-restatement',
  );
  assert.equal(
    classifyListingMarketFactRevision(baseline, fixture({ fundingRate:0.00015 })).classification,
    'review-required',
  );
  assert.equal(
    classifyListingMarketFactRevision(baseline, fixture({ fundingRate:0.00025 })).classification,
    'anomalous',
  );

  const latePrevious = fixture({
    referencePriceUsd:null,
    referencePriceMethod:'official-reference/v1',
    priceStatus:'partial',
  });
  const lateCurrent = fixture({
    referencePriceUsd:100,
    referencePriceMethod:'official-reference/v1',
    priceStatus:'full',
  });
  assert.equal(
    classifyListingMarketFactRevision(latePrevious, lateCurrent, { withinFinality:true }).classification,
    'late-completion',
  );
  assert.equal(
    classifyListingMarketFactRevision(latePrevious, lateCurrent, { withinFinality:false }).classification,
    'review-required',
  );

  const valueToNull = classifyListingMarketFactRevision(
    baseline,
    fixture({ lastPrice:null }),
  );
  assert.equal(valueToNull.classification, 'anomalous');
  assert.ok(valueToNull.reasonCodes.includes('VALUE_TO_NULL'));

  const downgrade = classifyListingMarketFactRevision(
    fixture({ priceStatus:'full', referencePriceUsd:100, referencePriceMethod:'official-reference/v1' }),
    fixture({ priceStatus:'partial', referencePriceUsd:100, referencePriceMethod:'official-reference/v1' }),
  );
  assert.equal(downgrade.classification, 'anomalous');
  assert.ok(downgrade.reasonCodes.includes('PRICE_STATUS_DOWNGRADE'));
  assert.throws(
    () => classifyListingMarketFactRevision(baseline, fixture({ fundingRate:0.0002 }), { fundingPrecision:Number.NaN }),
    /finite non-negative number/,
  );
});

test('method, unit, or exact-identity changes start a new series and cannot masquerade as revisions', () => {
  const baseline = fixture();
  for (const changed of [
    { methodVersion:'binance-tradifi-hourly/v2' },
    { volumeMethod:'official-quote-volume/v2' },
    { quoteCurrency:'USD' },
    { instrumentVersionId:9999 },
    { assetVersionId:9999 },
    { validTo:'2026-08-20T12:00:00.000Z' },
  ]) {
    assert.throws(
      () => classifyListingMarketFactRevision(baseline, fixture(changed)),
      /require a new observation series/,
    );
  }
});

test('initial facts append and review/anomalous candidates quarantine without advancing revision number', () => {
  const initial = prepareListingMarketFactRevision(fixture());
  assert.equal(initial.action, 'append');
  assert.equal(initial.classification, 'initial');
  assert.equal(initial.revisionNo, 1);
  assert.equal(initial.supersedesRevisionId, null);

  const quarantine = prepareListingMarketFactRevision(fixture({ lastPrice:103 }), {
    revisionId:UUIDS.revision,
    revisionNo:7,
    observation:fixture(),
  });
  assert.equal(quarantine.action, 'quarantine');
  assert.equal(quarantine.classification, 'anomalous');
  assert.equal(quarantine.revisionNo, 7);
});

test('batch drift gate isolates small review sets and blocks anomalous or excessive review batches', () => {
  const isolated = classifyListingMarketFactRevisionBatch([
    ...Array.from({ length:99 }, () => ({ classification:'identical' })),
    { classification:'review-required' },
  ]);
  assert.equal(isolated.accepted, true);
  assert.equal(isolated.classification, 'review-isolated');
  assert.equal(isolated.reviewFraction, 0.01);

  const excessive = classifyListingMarketFactRevisionBatch([
    ...Array.from({ length:18 }, () => ({ classification:'normal-restatement' })),
    { classification:'review-required' },
    { classification:'review-required' },
  ]);
  assert.equal(excessive.accepted, false);
  assert.equal(excessive.classification, 'review-rate-anomalous');
  assert.ok(excessive.reasonCodes.includes('REVIEW_RATE_THRESHOLD_EXCEEDED'));

  const anomalous = classifyListingMarketFactRevisionBatch([
    { classification:'initial' },
    { classification:'anomalous' },
  ]);
  assert.equal(anomalous.accepted, false);
  assert.equal(anomalous.classification, 'anomalous');
  assert.throws(() => classifyListingMarketFactRevisionBatch([]), /non-empty/);
  assert.throws(
    () => classifyListingMarketFactRevisionBatch([{ classification:'identical' }], { maximumReviewBatchFraction:2 }),
    /between zero and one/,
  );
});

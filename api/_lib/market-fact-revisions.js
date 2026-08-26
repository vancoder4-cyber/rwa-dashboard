import { createHash } from 'node:crypto';

export const LISTING_MARKET_FACT_DATA_FAMILY = 'listing-market-hourly';
export const LISTING_MARKET_FACT_POLICY_VERSION = 'listing-market-fact/v1';
export const MARKET_FACT_WRITE_MODES = Object.freeze(['off', 'shadow', 'required']);
export const MARKET_FACT_FIELD_STATUSES = Object.freeze(['full', 'partial', 'estimated', 'unavailable']);
export const LISTING_MARKET_FACT_BATCH_POLICY = Object.freeze({
  maximumReviewBatchFraction:0.05,
  maximumReviewBatchRows:50,
});

const STATUS_SET = new Set(MARKET_FACT_FIELD_STATUSES);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_PATTERN = /^[a-z0-9][a-z0-9._:/-]{2,127}$/;
const CURRENCY_PATTERN = /^[A-Z0-9][A-Z0-9._-]{1,15}$/;
const QUALITY_FLAG_PATTERN = /^[A-Z0-9][A-Z0-9._:-]{1,127}$/;

const TYPED_FIELDS = Object.freeze([
  'lastPrice',
  'markPrice',
  'referencePriceUsd',
  'volume24hNative',
  'volume24hUsd',
  'openInterestNative',
  'openInterestUsd',
  'fundingRate',
  'priceChange24hPct',
]);

const GROUPS = Object.freeze({
  price: Object.freeze({
    fields: Object.freeze(['lastPrice', 'markPrice', 'referencePriceUsd', 'priceChange24hPct']),
    status: 'priceStatus',
    normalRelativeDelta: 0.005,
    reviewRelativeDelta: 0.02,
  }),
  quantity: Object.freeze({
    fields: Object.freeze(['volume24hNative', 'volume24hUsd', 'openInterestNative', 'openInterestUsd']),
    status: null,
    normalRelativeDelta: 0.01,
    reviewRelativeDelta: 0.05,
  }),
  funding: Object.freeze({
    fields: Object.freeze(['fundingRate']),
    status: 'fundingStatus',
    normalAbsoluteDelta: 0.00000001,
    reviewAbsoluteDelta: 0.0001,
  }),
});

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function exactText(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return number;
}

function uuid(value, label, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  const normalized = exactText(value, label).toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new TypeError(`${label} must be a UUID`);
  return normalized;
}

function isoTimestamp(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function nullableNumber(value, label, { nonNegative = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite or null`);
  if (nonNegative && number < 0) throw new RangeError(`${label} cannot be negative`);
  return Object.is(number, -0) ? 0 : number;
}

function fieldStatus(value, label) {
  const normalized = exactText(value, label).toLowerCase();
  if (!STATUS_SET.has(normalized)) {
    throw new TypeError(`${label} must be full, partial, estimated, or unavailable`);
  }
  return normalized;
}

function optionalMethod(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = exactText(value, label);
  if (!VERSION_PATTERN.test(normalized)) throw new TypeError(`${label} is not a valid versioned method`);
  return normalized;
}

function normalizedFlags(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('qualityFlags must be an array');
  const flags = [...new Set(value.map(flag => exactText(flag, 'quality flag').toUpperCase()))].sort();
  if (flags.some(flag => !QUALITY_FLAG_PATTERN.test(flag))) {
    throw new TypeError('qualityFlags contain an invalid code');
  }
  return flags;
}

function assertStatusValueCoherence(observation, statusKey, valueKeys) {
  const values = valueKeys.map(key => observation[key]);
  const hasValue = values.some(value => value !== null);
  if (observation[statusKey] === 'unavailable' && hasValue) {
    throw new TypeError(`${statusKey}=unavailable cannot carry a numeric value`);
  }
  if (observation[statusKey] !== 'unavailable' && !hasValue) {
    throw new TypeError(`${statusKey} requires at least one numeric value`);
  }
}

export function resolveMarketFactWriteMode(env = process.env) {
  const value = String(env?.MARKET_FACT_PG_WRITE_MODE || 'off').trim().toLowerCase();
  if (!MARKET_FACT_WRITE_MODES.includes(value)) {
    throw new TypeError('MARKET_FACT_PG_WRITE_MODE must be off, shadow, or required');
  }
  return value;
}

export function normalizeListingMarketFactObservation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('A listing market-fact observation object is required');
  }
  for (const forbiddenIdentityKey of ['ticker', 'symbol', 'venueSymbol', 'canonicalSymbol']) {
    if (Object.prototype.hasOwnProperty.call(input, forbiddenIdentityKey)) {
      throw new TypeError(`${forbiddenIdentityKey} is not an identity key; use exact sourceId and instrumentVersionId`);
    }
  }
  const dataFamily = String(input.dataFamily || LISTING_MARKET_FACT_DATA_FAMILY).trim().toLowerCase();
  const policyVersion = String(input.policyVersion || LISTING_MARKET_FACT_POLICY_VERSION).trim().toLowerCase();
  if (dataFamily !== LISTING_MARKET_FACT_DATA_FAMILY) {
    throw new TypeError(`dataFamily must be ${LISTING_MARKET_FACT_DATA_FAMILY}`);
  }
  if (policyVersion !== LISTING_MARKET_FACT_POLICY_VERSION) {
    throw new TypeError(`policyVersion must be ${LISTING_MARKET_FACT_POLICY_VERSION}`);
  }
  const methodVersion = exactText(input.methodVersion, 'methodVersion').toLowerCase();
  if (!VERSION_PATTERN.test(methodVersion)) throw new TypeError('methodVersion is invalid');
  const eventAt = isoTimestamp(input.eventAt, 'eventAt');
  const validFrom = isoTimestamp(input.validFrom, 'validFrom');
  const validTo = isoTimestamp(input.validTo, 'validTo');
  const capturedAt = isoTimestamp(input.capturedAt, 'capturedAt');
  if (Date.parse(validTo) <= Date.parse(validFrom)) throw new RangeError('validTo must be after validFrom');
  if (Date.parse(eventAt) < Date.parse(validFrom) || Date.parse(eventAt) >= Date.parse(validTo)) {
    throw new RangeError('eventAt must fall within the valid interval');
  }
  if (Date.parse(capturedAt) < Date.parse(eventAt) - 5 * 60 * 1000) {
    throw new RangeError('capturedAt cannot precede eventAt by more than five minutes');
  }
  const quoteCurrency = exactText(input.quoteCurrency, 'quoteCurrency').toUpperCase();
  const nativeCurrency = input.nativeCurrency === null || input.nativeCurrency === undefined || input.nativeCurrency === ''
    ? null
    : exactText(input.nativeCurrency, 'nativeCurrency').toUpperCase();
  if (!CURRENCY_PATTERN.test(quoteCurrency) || (nativeCurrency && !CURRENCY_PATTERN.test(nativeCurrency))) {
    throw new TypeError('currency codes are invalid');
  }

  const observation = {
    dataFamily,
    policyVersion,
    methodVersion,
    cycleId:uuid(input.cycleId, 'cycleId'),
    sourceRunId:uuid(input.sourceRunId, 'sourceRunId'),
    sourceId:positiveInteger(input.sourceId, 'sourceId'),
    instrumentVersionId:positiveInteger(input.instrumentVersionId, 'instrumentVersionId'),
    assetVersionId:positiveInteger(input.assetVersionId, 'assetVersionId'),
    inputArtifactId:uuid(input.inputArtifactId, 'inputArtifactId', { optional:true }),
    eventAt,
    validFrom,
    validTo,
    capturedAt,
    quoteCurrency,
    nativeCurrency,
    lastPrice:nullableNumber(input.lastPrice, 'lastPrice', { nonNegative:true }),
    markPrice:nullableNumber(input.markPrice, 'markPrice', { nonNegative:true }),
    referencePriceUsd:nullableNumber(input.referencePriceUsd, 'referencePriceUsd', { nonNegative:true }),
    volume24hNative:nullableNumber(input.volume24hNative, 'volume24hNative', { nonNegative:true }),
    volume24hUsd:nullableNumber(input.volume24hUsd, 'volume24hUsd', { nonNegative:true }),
    openInterestNative:nullableNumber(input.openInterestNative, 'openInterestNative', { nonNegative:true }),
    openInterestUsd:nullableNumber(input.openInterestUsd, 'openInterestUsd', { nonNegative:true }),
    fundingRate:nullableNumber(input.fundingRate, 'fundingRate'),
    priceChange24hPct:nullableNumber(input.priceChange24hPct, 'priceChange24hPct'),
    priceStatus:fieldStatus(input.priceStatus, 'priceStatus'),
    volumeStatus:fieldStatus(input.volumeStatus, 'volumeStatus'),
    openInterestStatus:fieldStatus(input.openInterestStatus, 'openInterestStatus'),
    fundingStatus:fieldStatus(input.fundingStatus, 'fundingStatus'),
    volumeMethod:optionalMethod(input.volumeMethod, 'volumeMethod'),
    openInterestMethod:optionalMethod(input.openInterestMethod, 'openInterestMethod'),
    referencePriceMethod:optionalMethod(input.referencePriceMethod, 'referencePriceMethod'),
    qualityFlags:normalizedFlags(input.qualityFlags),
  };

  assertStatusValueCoherence(observation, 'priceStatus', ['lastPrice', 'markPrice', 'referencePriceUsd', 'priceChange24hPct']);
  assertStatusValueCoherence(observation, 'volumeStatus', ['volume24hNative', 'volume24hUsd']);
  assertStatusValueCoherence(observation, 'openInterestStatus', ['openInterestNative', 'openInterestUsd']);
  assertStatusValueCoherence(observation, 'fundingStatus', ['fundingRate']);
  if (observation.referencePriceUsd !== null && observation.referencePriceMethod === null) {
    throw new TypeError('referencePriceMethod is required when referencePriceUsd is present');
  }
  if (observation.volumeStatus !== 'unavailable' && observation.volumeMethod === null) {
    throw new TypeError('volumeMethod is required when volume is present');
  }
  if (observation.openInterestStatus !== 'unavailable' && observation.openInterestMethod === null) {
    throw new TypeError('openInterestMethod is required when open interest is present');
  }
  if (observation.nativeCurrency === null && [
    observation.volume24hNative,
    observation.openInterestNative,
  ].some(value => value !== null)) {
    throw new TypeError('nativeCurrency is required for native-unit measurements');
  }
  return observation;
}

export function listingMarketFactObservationKey(input) {
  const observation = normalizeListingMarketFactObservation(input);
  return sha256(JSON.stringify([
    observation.dataFamily,
    observation.policyVersion,
    observation.methodVersion,
    observation.sourceId,
    observation.instrumentVersionId,
    observation.assetVersionId,
    observation.eventAt,
    observation.validFrom,
    observation.validTo,
    observation.quoteCurrency,
    observation.nativeCurrency,
    observation.volumeMethod,
    observation.openInterestMethod,
    observation.referencePriceMethod,
  ]));
}

export function listingMarketFactPayloadChecksum(input) {
  const observation = normalizeListingMarketFactObservation(input);
  return sha256(JSON.stringify([
    ...TYPED_FIELDS.map(key => observation[key]),
    observation.priceStatus,
    observation.volumeStatus,
    observation.openInterestStatus,
    observation.fundingStatus,
    observation.volumeMethod,
    observation.openInterestMethod,
    observation.referencePriceMethod,
    observation.qualityFlags,
  ]));
}

function groupForField(field) {
  if (GROUPS.price.fields.includes(field)) return 'price';
  if (GROUPS.quantity.fields.includes(field)) return 'quantity';
  if (GROUPS.funding.fields.includes(field)) return 'funding';
  throw new TypeError(`Unknown market-fact field: ${field}`);
}

function statusForField(observation, field) {
  if (field.startsWith('volume')) return observation.volumeStatus;
  if (field.startsWith('openInterest')) return observation.openInterestStatus;
  if (field === 'fundingRate') return observation.fundingStatus;
  return observation.priceStatus;
}

function severityRank(classification) {
  return {
    identical:0,
    'normal-restatement':1,
    'late-completion':2,
    'review-required':3,
    anomalous:4,
  }[classification];
}

function raiseClassification(result, classification) {
  if (severityRank(classification) > severityRank(result.classification)) {
    result.classification = classification;
  }
}

export function classifyListingMarketFactRevision(previousInput, currentInput, {
  withinFinality = false,
  fundingPrecision = GROUPS.funding.normalAbsoluteDelta,
} = {}) {
  const normalizedFundingPrecision = Number(fundingPrecision);
  if (!Number.isFinite(normalizedFundingPrecision) || normalizedFundingPrecision < 0) {
    throw new TypeError('fundingPrecision must be a finite non-negative number');
  }
  const previous = normalizeListingMarketFactObservation(previousInput);
  const current = normalizeListingMarketFactObservation(currentInput);
  const previousKey = listingMarketFactObservationKey(previous);
  const currentKey = listingMarketFactObservationKey(current);
  if (previousKey !== currentKey) {
    throw new TypeError('Identity, method, unit, currency, grain, or valid-boundary changes require a new observation series');
  }
  const previousChecksum = listingMarketFactPayloadChecksum(previous);
  const currentChecksum = listingMarketFactPayloadChecksum(current);
  if (previousChecksum === currentChecksum) {
    return {
      classification:'identical',
      accepted:true,
      observationKey:currentKey,
      payloadChecksum:currentChecksum,
      reasonCodes:[],
      comparisons:[],
    };
  }

  const result = {
    classification:'normal-restatement',
    accepted:true,
    observationKey:currentKey,
    payloadChecksum:currentChecksum,
    reasonCodes:[],
    comparisons:[],
  };
  for (const field of TYPED_FIELDS) {
    const before = previous[field];
    const after = current[field];
    if (before === after) continue;
    const groupName = groupForField(field);
    const group = GROUPS[groupName];
    const comparison = { field, before, after, fieldFamily:groupName };
    if (before === null && after !== null) {
      const eligibleLateCompletion = withinFinality && ['unavailable', 'partial'].includes(statusForField(previous, field));
      const classification = eligibleLateCompletion ? 'late-completion' : 'review-required';
      comparison.classification = classification;
      comparison.reasonCode = eligibleLateCompletion ? 'LATE_COMPLETION_WITHIN_FINALITY' : 'NULL_TO_VALUE_REQUIRES_REVIEW';
      raiseClassification(result, classification);
      result.reasonCodes.push(comparison.reasonCode);
      result.comparisons.push(comparison);
      continue;
    }
    if (before !== null && after === null) {
      comparison.classification = 'anomalous';
      comparison.reasonCode = 'VALUE_TO_NULL';
      raiseClassification(result, 'anomalous');
      result.reasonCodes.push(comparison.reasonCode);
      result.comparisons.push(comparison);
      continue;
    }
    const absoluteDelta = Math.abs(after - before);
    comparison.absoluteDelta = absoluteDelta;
    if (groupName === 'funding') {
      const normalAbsoluteDelta = normalizedFundingPrecision;
      comparison.normalThreshold = normalAbsoluteDelta;
      comparison.reviewThreshold = group.reviewAbsoluteDelta;
      if (absoluteDelta <= normalAbsoluteDelta) {
        comparison.classification = 'normal-restatement';
      } else if (absoluteDelta <= group.reviewAbsoluteDelta) {
        comparison.classification = 'review-required';
        comparison.reasonCode = 'FUNDING_DELTA_REQUIRES_REVIEW';
      } else {
        comparison.classification = 'anomalous';
        comparison.reasonCode = 'FUNDING_DELTA_ANOMALOUS';
      }
    } else if (before === 0) {
      comparison.relativeDelta = null;
      comparison.classification = 'review-required';
      comparison.reasonCode = 'ZERO_DENOMINATOR_REQUIRES_ABSOLUTE_POLICY';
    } else {
      const relativeDelta = absoluteDelta / Math.abs(before);
      comparison.relativeDelta = relativeDelta;
      comparison.normalThreshold = group.normalRelativeDelta;
      comparison.reviewThreshold = group.reviewRelativeDelta;
      if (relativeDelta <= group.normalRelativeDelta) {
        comparison.classification = 'normal-restatement';
      } else if (relativeDelta <= group.reviewRelativeDelta) {
        comparison.classification = 'review-required';
        comparison.reasonCode = `${groupName.toUpperCase()}_DELTA_REQUIRES_REVIEW`;
      } else {
        comparison.classification = 'anomalous';
        comparison.reasonCode = `${groupName.toUpperCase()}_DELTA_ANOMALOUS`;
      }
    }
    raiseClassification(result, comparison.classification);
    if (comparison.reasonCode) result.reasonCodes.push(comparison.reasonCode);
    result.comparisons.push(comparison);
  }

  for (const statusKey of ['priceStatus', 'volumeStatus', 'openInterestStatus', 'fundingStatus']) {
    if (previous[statusKey] === current[statusKey]) continue;
    if (previous[statusKey] === 'full' && current[statusKey] !== 'full') {
      raiseClassification(result, 'anomalous');
      const statusFamily = statusKey.replace(/Status$/, '').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
      result.reasonCodes.push(`${statusFamily}_STATUS_DOWNGRADE`);
    }
  }
  if (JSON.stringify(previous.qualityFlags) !== JSON.stringify(current.qualityFlags)) {
    raiseClassification(result, 'review-required');
    result.reasonCodes.push('QUALITY_FLAGS_CHANGED');
    result.comparisons.push({
      field:'qualityFlags',
      before:previous.qualityFlags,
      after:current.qualityFlags,
      fieldFamily:'quality',
      classification:'review-required',
      reasonCode:'QUALITY_FLAGS_CHANGED',
    });
  }
  result.reasonCodes = [...new Set(result.reasonCodes)].sort();
  result.accepted = !['review-required', 'anomalous'].includes(result.classification);
  return result;
}

export function prepareListingMarketFactRevision(currentInput, previous = null, options = {}) {
  const current = normalizeListingMarketFactObservation(currentInput);
  const observationKey = listingMarketFactObservationKey(current);
  const payloadChecksum = listingMarketFactPayloadChecksum(current);
  if (!previous) {
    return {
      action:'append',
      classification:'initial',
      accepted:true,
      revisionNo:1,
      supersedesRevisionId:null,
      observationKey,
      payloadChecksum,
      observation:current,
      reasonCodes:[],
      comparisons:[],
    };
  }
  const previousObservation = normalizeListingMarketFactObservation(previous.observation || previous);
  const classification = classifyListingMarketFactRevision(previousObservation, current, options);
  const previousRevisionId = uuid(previous.revisionId, 'previous.revisionId');
  const previousRevisionNo = positiveInteger(previous.revisionNo, 'previous.revisionNo');
  if (classification.classification === 'identical') {
    return {
      ...classification,
      action:'skip',
      revisionNo:previousRevisionNo,
      supersedesRevisionId:previousRevisionId,
      observation:current,
    };
  }
  if (!classification.accepted) {
    return {
      ...classification,
      action:'quarantine',
      revisionNo:previousRevisionNo,
      supersedesRevisionId:previousRevisionId,
      observation:current,
    };
  }
  return {
    ...classification,
    action:'append',
    revisionNo:previousRevisionNo + 1,
    supersedesRevisionId:previousRevisionId,
    observation:current,
  };
}

export function classifyListingMarketFactRevisionBatch(results, {
  maximumReviewBatchFraction = LISTING_MARKET_FACT_BATCH_POLICY.maximumReviewBatchFraction,
  maximumReviewBatchRows = LISTING_MARKET_FACT_BATCH_POLICY.maximumReviewBatchRows,
} = {}) {
  if (!Array.isArray(results) || results.length === 0) {
    throw new TypeError('A non-empty market-fact revision result batch is required');
  }
  const fractionThreshold = Number(maximumReviewBatchFraction);
  const rowThreshold = Number(maximumReviewBatchRows);
  if (!Number.isFinite(fractionThreshold) || fractionThreshold < 0 || fractionThreshold > 1) {
    throw new TypeError('maximumReviewBatchFraction must be between zero and one');
  }
  if (!Number.isSafeInteger(rowThreshold) || rowThreshold <= 0) {
    throw new TypeError('maximumReviewBatchRows must be a positive safe integer');
  }
  const classifications = results.map(result => exactText(result?.classification, 'result.classification'));
  const anomalousRows = classifications.filter(value => value === 'anomalous').length;
  const reviewRows = classifications.filter(value => value === 'review-required').length;
  const acceptedRows = classifications.filter(value => ['identical', 'initial', 'normal-restatement', 'late-completion'].includes(value)).length;
  if (acceptedRows + reviewRows + anomalousRows !== classifications.length) {
    throw new TypeError('Batch contains an unknown revision classification');
  }
  const reviewFraction = reviewRows / classifications.length;
  const reviewThresholdExceeded = reviewRows > rowThreshold || reviewFraction > fractionThreshold;
  const accepted = anomalousRows === 0 && !reviewThresholdExceeded;
  return {
    accepted,
    classification:anomalousRows > 0
      ? 'anomalous'
      : reviewThresholdExceeded
        ? 'review-rate-anomalous'
        : reviewRows > 0
          ? 'review-isolated'
          : 'normal',
    totalRows:classifications.length,
    acceptedRows,
    reviewRows,
    anomalousRows,
    reviewFraction,
    maximumReviewBatchFraction:fractionThreshold,
    maximumReviewBatchRows:rowThreshold,
    reasonCodes:[
      ...(anomalousRows > 0 ? ['ANOMALOUS_ROWS_PRESENT'] : []),
      ...(reviewThresholdExceeded ? ['REVIEW_RATE_THRESHOLD_EXCEEDED'] : []),
    ],
  };
}

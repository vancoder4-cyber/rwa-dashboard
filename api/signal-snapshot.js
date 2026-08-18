import { getCache } from '@vercel/functions';

import {
  SIGNAL_ASSET_LIMIT,
  SIGNAL_SCHEMA_VERSION,
  aggregateSignalListings,
  attachSignalAnalysis,
  compactSignalSnapshot,
} from './_lib/signal-analysis.js';
import {
  PERP_VOLUME_HISTORY_DAYS,
  buildPerpVolumeAnomalies,
  compactDailyVolumeSnapshot,
  mergeDailyVolumeHistory,
  normalizeDailyVolumeHistory,
} from './_lib/volume-anomaly.js';
import {
  OI_LIQUIDATION_HISTORY_HOURS,
  OI_LIQUIDATION_HISTORY_NAMESPACE,
  buildOiLiquidationAnomalies,
  compactOiHourlySnapshot,
  mergeOiHourlyHistory,
  normalizeBinanceTopTraderPositions,
  normalizeOiHourlyHistory,
} from './_lib/oi-liquidation-anomaly.js';
import {
  categoryFromOfficialSignalType,
  normalizeSignalIdentity,
  normalizedOfficialType,
} from './_lib/security-identity.js';
import {
  SPOT_ANOMALY_HISTORY_DAYS,
  SPOT_ANOMALY_HISTORY_NAMESPACE,
  SPOT_ANOMALY_SOURCE_NAMES,
  buildSpotVolumePriceAnomalies,
  collectSpotMarketSnapshot,
  compactSpotDailySnapshot,
  isSpotAnomalyHistoryComparable,
  mergeSpotDailyHistory,
  normalizeSpotDailyHistory,
} from './_lib/spot-volume-price-anomaly.js';
import {
  fetchJsonWithPolicy,
  setNoStore,
  setPublicCache,
} from './_lib/upstream.js';

export const config = { regions: ['iad1'], maxDuration: 60 };

// Adding a source changes aggregate Volume/OI baselines. Keep the five-source
// history isolated so the rollout is not scored as an anomaly against v1.
const HISTORY_NAMESPACE = 'rwa-signal-radar-v2';
const HISTORY_KEY = 'hourly-history-v2';
const HISTORY_TTL_SECONDS = 7 * 24 * 60 * 60;
const HISTORY_MAX_SNAPSHOTS = 168;
const HISTORY_MAX_BYTES = 1_750_000;
const DAILY_VOLUME_HISTORY_NAMESPACE = 'rwa-signal-volume-daily-v1';
const DAILY_VOLUME_HISTORY_KEY = 'daily-volume-history-v1';
const DAILY_VOLUME_HISTORY_TTL_SECONDS = 60 * 24 * 60 * 60;
const SPOT_ANOMALY_HISTORY_KEY = 'spot-volume-price-daily-v1';
const SPOT_ANOMALY_HISTORY_TTL_SECONDS = 10 * 24 * 60 * 60;
const OI_LIQUIDATION_HISTORY_KEY = 'oi-liquidation-hourly-v1';
const OI_LIQUIDATION_HISTORY_TTL_SECONDS = 7 * 24 * 60 * 60;
const SOURCE_TIMEOUT_MS = 20_000;
const BITGET_BASE = 'https://api.bitget.com';
const BINANCE_CORE_TIMEOUT_MS = 12_000;
const BINANCE_POSITIONING_TIMEOUT_MS = 20_000;
const SIGNAL_SOURCE_NAMES = Object.freeze(['gate', 'binance', 'bitget', 'tradexyz', 'okx']);
export const OI_CATALOG_QUARANTINE_WARNING = 'UNSUPPORTED_OFFICIAL_ROWS_QUARANTINED';
export const TRADE_XYZ_UNTYPED_RWA_CATEGORIES = Object.freeze({
  URANIUM:'commodity',
  TTF:'commodity',
  H100:'commodity',
  NIFTY:'index',
  IBOV:'index',
});

const OKX_SIGNAL_CATEGORIES = Object.freeze({
  3: 'equity',
  4: 'commodity',
  5: 'fx',
  6: 'bond',
});

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const numeric = finiteOrNull(value);
    if (numeric !== null) return numeric;
  }
  return null;
}

function reportedVolumeFields(value, method, { estimated = false } = {}) {
  const numeric = finiteOrNull(value);
  const volume24hUsd = numeric !== null && numeric >= 0 ? numeric : null;
  return {
    volume24hUsd,
    volumeMethod:volume24hUsd === null ? null : method,
    volumeStatus:volume24hUsd === null ? 'unavailable' : estimated ? 'estimated' : 'full',
  };
}

function reportedOpenInterestFields(value, method, { estimated = true } = {}) {
  const numeric = finiteOrNull(value);
  const openInterestUsd = numeric !== null && numeric >= 0 ? numeric : null;
  return {
    openInterestUsd,
    openInterestMethod:openInterestUsd === null ? null : method,
    openInterestStatus:openInterestUsd === null ? 'unavailable' : estimated ? 'estimated' : 'full',
  };
}

function reportedChange24hFields(value, method, { estimated = false } = {}) {
  const numeric = finiteOrNull(value);
  const change24hPct = numeric !== null && numeric >= -100 ? numeric : null;
  return {
    change24hPct,
    change24hMethod:change24hPct === null ? null : method,
    change24hStatus:change24hPct === null ? 'unavailable' : estimated ? 'estimated' : 'full',
  };
}

function hasCatalogIdentityWarning(warnings) {
  return (Array.isArray(warnings) ? warnings : []).some(warning =>
    /(?:SOURCE|IDENTITY|INSTRUMENTS_UNAVAILABLE|CATALOG|UPSTREAM_COVERAGE)/i.test(String(warning)));
}

export function oiHistorySourceComparable(source) {
  const status = String(source?.status || '').trim().toLowerCase();
  const listingCount = Number(source?.listingCount);
  const catalogListingCount = Number(source?.catalogListingCount);
  const quarantinedListings = Number(source?.quarantinedListings);
  const volumeFieldCount = Number(source?.volumeFieldCount);
  const openInterestFieldCount = Number(source?.openInterestFieldCount);
  const warnings = Array.isArray(source?.warnings) &&
    source.warnings.every(warning => typeof warning === 'string') ? source.warnings : null;
  const quarantineWarningCount = warnings?.filter(warning =>
    warning.toUpperCase() === OI_CATALOG_QUARANTINE_WARNING).length ?? -1;
  const quarantineCoherent = Number.isInteger(quarantinedListings) && quarantinedListings >= 0 &&
    ((quarantinedListings === 1 && status === 'partial' && quarantineWarningCount === 1) ||
      (quarantinedListings === 0 && quarantineWarningCount === 0));
  return ['full','partial'].includes(status) && warnings !== null &&
    Number.isInteger(listingCount) && listingCount > 0 &&
    Number.isInteger(catalogListingCount) && catalogListingCount >= listingCount &&
    quarantineCoherent && catalogListingCount === listingCount + quarantinedListings &&
    Number.isInteger(volumeFieldCount) && volumeFieldCount > 0 && volumeFieldCount <= listingCount &&
    Number.isInteger(openInterestFieldCount) && openInterestFieldCount > 0 &&
    openInterestFieldCount <= listingCount &&
    !hasCatalogIdentityWarning(warnings);
}

export function isOiHistorySnapshotComparable(sources, conflicts = []) {
  if (!sources || typeof sources !== 'object' || Array.isArray(sources) ||
      !Array.isArray(conflicts) || conflicts.length > 0) return false;
  const keys = Object.keys(sources);
  return keys.length === SIGNAL_SOURCE_NAMES.length &&
    SIGNAL_SOURCE_NAMES.every(name => oiHistorySourceComparable(sources[name]));
}

function positiveDeltaHours(later, earlier) {
  const laterMs = finiteOrNull(later);
  const earlierMs = finiteOrNull(earlier);
  if (laterMs === null || earlierMs === null || laterMs <= earlierMs) return null;
  return (laterMs - earlierMs) / 3_600_000;
}

function okxFundingIntervalHours(row) {
  return positiveDeltaHours(row?.nextFundingTime, row?.fundingTime)
    ?? positiveDeltaHours(row?.fundingTime, row?.prevFundingTime);
}

function okxRowsByInstrument(rows) {
  return new Map((Array.isArray(rows) ? rows : [])
    .filter(row => row && typeof row === 'object' && row.instId)
    .map(row => [String(row.instId).toUpperCase(), row]));
}

function okxCoverageStatus(coverage) {
  if (typeof coverage === 'string') return coverage.trim().toLowerCase();
  return String(coverage?.status || coverage?.overall || '').trim().toLowerCase();
}

export function normalizeOkxSignalSnapshot(payload) {
  const instruments = Array.isArray(payload?.instruments) ? payload.instruments : [];
  const tickerMap = okxRowsByInstrument(payload?.tickers);
  const markMap = okxRowsByInstrument(payload?.marks);
  const oiMap = okxRowsByInstrument(payload?.openInterest);
  const fundingMap = okxRowsByInstrument(payload?.funding);
  const listings = [];
  let admittedCatalogListings = 0;

  for (const instrument of instruments) {
    const venueSymbol = String(instrument?.instId || '').toUpperCase();
    const instType = String(instrument?.instType || '').toUpperCase();
    const ruleType = String(instrument?.ruleType || '').toLowerCase();
    const officialCategory = OKX_SIGNAL_CATEGORIES[String(instrument?.instCategory || '')] || null;
    const isPerpetual = instType === 'SWAP' || (instType === 'FUTURES' && ruleType === 'xperp');
    if (String(instrument?.state || '').toLowerCase() !== 'live' || !isPerpetual || !officialCategory) continue;
    admittedCatalogListings += 1;
    if (!/^[A-Z0-9_-]{3,80}$/.test(venueSymbol)) continue;

    // ctValCcy is official contract metadata. Parsing an ambiguous ticker is
    // intentionally not a fallback identity source.
    const venueBase = String(instrument?.ctValCcy || '').toUpperCase();
    const identity = normalizeSignalIdentity(venueBase, officialCategory);
    if (!identity) continue;

    const ticker = tickerMap.get(venueSymbol) || {};
    const mark = markMap.get(venueSymbol) || {};
    const openInterest = oiMap.get(venueSymbol) || {};
    const funding = fundingMap.get(venueSymbol) || {};
    const markPrice = finiteOrNull(mark.markPx);
    const lastPrice = finiteOrNull(ticker.last);
    const price = markPrice ?? lastPrice;
    const valuationPriceMethod = markPrice !== null ? 'mark-price' : 'last-price';
    const open24h = finiteOrNull(ticker.open24h);
    const last = finiteOrNull(ticker.last);
    const baseVolume = finiteOrNull(ticker.volCcy24h);
    const directQuoteVolume = firstNumber(ticker.volCcyQuote24h, ticker.quoteVolume);
    const derivedQuoteVolume = directQuoteVolume === null && baseVolume !== null && price > 0
      ? baseVolume * price
      : null;
    const directOiUsd = finiteOrNull(openInterest.oiUsd);
    const oiCcy = finiteOrNull(openInterest.oiCcy);
    const contractCount = finiteOrNull(openInterest.oi);
    const contractValue = finiteOrNull(instrument.ctVal);
    const contractMultiplier = finiteOrNull(instrument.ctMult);
    let derivedOiUsd = null;
    let derivedOiMethod = null;
    if (directOiUsd === null && oiCcy !== null && oiCcy >= 0 && price > 0) {
      derivedOiUsd = oiCcy * price;
      derivedOiMethod = `oi-ccy-x-${valuationPriceMethod}`;
    } else if (directOiUsd === null && contractCount !== null && contractCount >= 0 &&
        contractValue > 0 && contractMultiplier > 0 && price > 0) {
      derivedOiUsd = contractCount * contractValue * contractMultiplier * price;
      derivedOiMethod = `contract-count-x-ctval-x-ctmult-x-${valuationPriceMethod}`;
    }

    listings.push({
      symbol: identity.symbol,
      category: identity.category,
      venue: 'okx',
      venueSymbol,
      instrumentType: instType === 'SWAP' ? 'swap' : 'x-perp',
      priceUsd: price,
      ...reportedVolumeFields(
        directQuoteVolume ?? derivedQuoteVolume,
        directQuoteVolume !== null ? 'official-quote-volume' : `base-volume-x-${valuationPriceMethod}`,
        { estimated:directQuoteVolume === null && derivedQuoteVolume !== null },
      ),
      ...reportedOpenInterestFields(
        directOiUsd ?? derivedOiUsd,
        directOiUsd !== null ? 'official-oi-usd' : derivedOiMethod,
        { estimated:directOiUsd === null },
      ),
      fundingRate: firstNumber(funding.fundingRate, funding.settFundingRate),
      fundingIntervalHours: okxFundingIntervalHours(funding),
      ...reportedChange24hFields(
        last !== null && open24h > 0 ? ((last - open24h) / open24h) * 100 : null,
        'last-vs-open24h',
        { estimated:true },
      ),
    });
  }

  const admittedIds = listings.map(listing => listing.venueSymbol);
  const fieldMaps = [
    ['TICKERS_INCOMPLETE', tickerMap],
    ['MARKS_INCOMPLETE', markMap],
    ['OPEN_INTEREST_INCOMPLETE', oiMap],
    ['FUNDING_INCOMPLETE', fundingMap],
  ];
  const warnings = fieldMaps
    .filter(([, fieldMap]) => admittedIds.some(instId => !fieldMap.has(instId)))
    .map(([warning]) => warning);
  if (!instruments.length) warnings.unshift('INSTRUMENTS_UNAVAILABLE');
  if (listings.length !== admittedCatalogListings) warnings.push('IDENTITY_COVERAGE_INCOMPLETE');
  const upstreamWarnings = Array.isArray(payload?.coverage?.warnings) ? payload.coverage.warnings : [];
  warnings.push(...upstreamWarnings.map(value => String(value)).filter(Boolean));
  const explicitCoverage = okxCoverageStatus(payload?.coverage);
  if (explicitCoverage && explicitCoverage !== 'full') {
    warnings.push(`UPSTREAM_COVERAGE_${explicitCoverage.toUpperCase()}`);
  }
  const completeness = listings.length && warnings.length === 0 && (!explicitCoverage || explicitCoverage === 'full')
    ? 'full'
    : 'partial';
  return { listings, completeness, warnings: [...new Set(warnings)] };
}

function isExplicitTrue(value) {
  return value === true || value === 1 || ['1', 'true', 'yes'].includes(String(value || '').trim().toLowerCase());
}

export function tradeXyzSignalCategory(symbol, officialType) {
  return categoryFromOfficialSignalType(officialType) ||
    TRADE_XYZ_UNTYPED_RWA_CATEGORIES[String(symbol || '').trim().toUpperCase()] || null;
}

function deploymentBaseUrl(req) {
  const forwarded = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').toLowerCase();
  if (/^[a-z0-9.-]+\.vercel\.app$/.test(forwarded)) return `https://${forwarded}`;
  const deployment = process.env.VERCEL_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return `https://${deployment || 'avenir-rwa-analyst.vercel.app'}`;
}

async function fetchSameOrigin(baseUrl, path, timeoutMs = SOURCE_TIMEOUT_MS) {
  return fetchJsonWithPolicy(
    `${baseUrl}${path}`,
    { headers: { Accept: 'application/json' } },
    { timeoutMs, retries: 0 },
  );
}

function validateBinancePositioningProxy(payload, snapshotType, nowMs = Date.now()) {
  const generatedAtMs = Date.parse(payload?.generatedAt);
  const maximumAgeMs = snapshotType === 'open-interest' ? 15 * 60_000 : 70 * 60_000;
  const instruments = Array.isArray(payload?.instruments) ? payload.instruments : null;
  const rows = Array.isArray(payload?.rows) ? payload.rows : null;
  const coverage = payload?.coverage || {};
  if (payload?.schemaVersion !== 1 || payload?.snapshotType !== snapshotType || payload?.catalogStatus !== 'full' ||
      !['full','partial'].includes(String(payload?.status || '').toLowerCase()) ||
      !Number.isFinite(generatedAtMs) || generatedAtMs > nowMs + 5 * 60_000 || generatedAtMs < nowMs - maximumAgeMs ||
      !instruments?.length || !rows?.length) throw new TypeError('Invalid Binance positioning proxy snapshot');
  const symbols = new Set();
  for (const instrument of instruments) {
    const symbol = String(instrument?.symbol || '').trim().toUpperCase();
    const baseAsset = String(instrument?.baseAsset || '').trim().toUpperCase();
    const contractType = String(instrument?.contractType || '').trim().toUpperCase();
    const admitted = contractType === 'TRADIFI_PERPETUAL' ||
      (contractType === 'PERPETUAL' && ['PAXG','XAUT'].includes(baseAsset));
    if (!/^[A-Z0-9]{2,40}$/.test(symbol) || !/^[A-Z0-9-]{1,40}$/.test(baseAsset) ||
        !admitted || symbols.has(symbol)) throw new TypeError('Invalid Binance positioning proxy catalog');
    symbols.add(symbol);
  }
  const rowSymbols = rows.map(row => String(row?.symbol || '').trim().toUpperCase());
  if (new Set(rowSymbols).size !== rowSymbols.length || rowSymbols.some(symbol => !symbols.has(symbol)) ||
      coverage.expected !== instruments.length || coverage.observed !== rows.length ||
      coverage.missing !== instruments.length - rows.length || coverage.upstreamFailures !== coverage.missing ||
      !Number.isInteger(coverage.expected) || !Number.isInteger(coverage.observed) ||
      !Number.isInteger(coverage.missing) || !Number.isInteger(coverage.upstreamFailures) ||
      (payload.status === 'full' && rows.length !== instruments.length) ||
      (payload.status === 'partial' && !(rows.length < instruments.length))) {
    throw new TypeError('Incoherent Binance positioning proxy coverage');
  }
  return { generatedAtMs, symbols, rows };
}

export function normalizeBinanceOiProxySnapshot(payload, listings, nowMs = Date.now()) {
  const proxy = validateBinancePositioningProxy(payload, 'open-interest', nowMs);
  const quantityBySymbol = new Map();
  for (const row of proxy.rows) {
    const venueSymbol = String(row?.symbol || '').trim().toUpperCase();
    const quantity = finiteOrNull(row?.openInterest);
    const observedAtMs = Date.parse(row?.observedAt);
    if (quantity === null || quantity < 0 || !Number.isFinite(observedAtMs) ||
        observedAtMs > proxy.generatedAtMs + 5 * 60_000 || observedAtMs < proxy.generatedAtMs - 10 * 60_000) {
      throw new TypeError('Invalid Binance open-interest proxy row');
    }
    quantityBySymbol.set(venueSymbol, quantity);
  }
  return new Map((Array.isArray(listings) ? listings : []).map(listing => {
    const venueSymbol = String(listing?.venueSymbol || '').trim().toUpperCase();
    const quantity = quantityBySymbol.get(venueSymbol);
    const price = finiteOrNull(listing?.priceUsd);
    const valuationPriceMethod = String(listing?.oiValuationPriceMethod || '').trim().toLowerCase();
    if (!proxy.symbols.has(venueSymbol) || quantity === undefined || !(price > 0) ||
        !['mark-price','last-price'].includes(valuationPriceMethod)) return [venueSymbol, null];
    return [venueSymbol, reportedOpenInterestFields(
      quantity * price,
      `open-interest-x-${valuationPriceMethod}`,
    )];
  }));
}

export function normalizeBinanceTopTraderProxySnapshot(payload, venueSymbols, nowMs = Date.now()) {
  const proxy = validateBinancePositioningProxy(payload, 'top-trader-position-ratio', nowMs);
  const rowsBySymbol = new Map(proxy.rows.map(row => [String(row?.symbol || '').trim().toUpperCase(), row]));
  const symbols = [...new Set((Array.isArray(venueSymbols) ? venueSymbols : [])
    .map(value => String(value || '').trim().toUpperCase())
    .filter(value => /^[A-Z0-9]{2,40}$/.test(value)))].sort();
  return new Map(symbols.map(venueSymbol => {
    const row = rowsBySymbol.get(venueSymbol);
    if (!proxy.symbols.has(venueSymbol) || !row) return [venueSymbol, {
      venueSymbol, status:'unavailable', longShortRatio:null, longPositionPct:null,
      shortPositionPct:null, bias:'unavailable', observedAt:null, reasonCode:'TOP_TRADER_NOT_OBSERVED',
    }];
    return [venueSymbol, normalizeBinanceTopTraderPositions(venueSymbol, [row], nowMs)];
  }));
}

async function fetchBinanceTopTraderPositionRows(baseUrl, venueSymbols, nowMs) {
  const payload = await fetchSameOrigin(
    baseUrl,
    '/api/binance-public?endpoint=top-trader-snapshot',
    BINANCE_POSITIONING_TIMEOUT_MS,
  );
  return normalizeBinanceTopTraderProxySnapshot(payload, venueSymbols, nowMs);
}

export function oiTriggeredBinanceSymbols(section) {
  return [...new Set((Array.isArray(section?.states) ? section.states : [])
    .filter(state => state?.evaluationStatus === 'triggered')
    .map(state => state?.marketContext?.positioning)
    .filter(positioning => String(positioning?.venue || '').trim().toLowerCase() === 'binance')
    .map(positioning => String(positioning?.venueSymbol || '').trim().toUpperCase())
    .filter(value => /^[A-Z0-9]{2,40}$/.test(value)))].sort();
}

function gateListings(payload) {
  const tickerMap = new Map((payload?.tickers || []).map(ticker => [ticker.contract, ticker]));
  const rows = [];
  for (const contract of payload?.contracts || []) {
    const venueSymbol = String(contract.name || '').toUpperCase();
    const venueBase = venueSymbol.replace(/_USDT$/, '');
    const officialCategory = categoryFromOfficialSignalType(contract.contract_type);
    const admittedCategory = officialCategory === 'equity' && isExplicitTrue(contract.is_pre_market)
      ? 'pre-ipo'
      : officialCategory;
    const identity = normalizeSignalIdentity(venueBase, admittedCategory, { venue:'gate' });
    if (!identity || !/^[A-Z0-9]{1,30}_USDT$/.test(venueSymbol)) continue;
    const ticker = tickerMap.get(venueSymbol) || {};
    const markPrice = firstNumber(ticker.mark_price, contract.mark_price);
    const lastPrice = firstNumber(ticker.last, contract.last_price);
    const price = markPrice ?? lastPrice;
    const valuationPriceMethod = markPrice !== null ? 'mark-price' : 'last-price';
    // Gate documents position_size as aggregate long positions rather than
    // total OI. Only the ticker's total_size is valid for this OI estimate.
    const quantity = finiteOrNull(ticker.total_size);
    const multiplier = finiteOrNull(contract.quanto_multiplier);
    const quoteVolume = firstNumber(ticker.volume_24h_quote, ticker.volume_24h_usd);
    rows.push({
      symbol: identity.symbol,
      category: identity.category,
      venue: 'gate',
      venueSymbol,
      instrumentType: 'perpetual',
      priceUsd: price,
      ...reportedVolumeFields(quoteVolume, 'official-quote-volume'),
      ...reportedOpenInterestFields(
        quantity !== null && quantity >= 0 && multiplier > 0 && price > 0
          ? quantity * multiplier * price
          : null,
        `total-size-x-quanto-x-${valuationPriceMethod}`,
      ),
      fundingRate: firstNumber(ticker.funding_rate, contract.funding_rate),
      fundingIntervalHours: (finiteOrNull(contract.funding_interval) || 28_800) / 3_600,
      ...reportedChange24hFields(
        ticker.change_percentage,
        'official-change-percentage',
      ),
    });
  }
  return rows;
}

async function collectGate(baseUrl) {
  const payload = await fetchSameOrigin(baseUrl, '/api/gate-bulk?type=perp-snapshot');
  const catalogContracts = Array.isArray(payload?.contracts) ? payload.contracts : [];
  const listings = gateListings(payload);
  if (!listings.length) throw new Error('trusted Gate RWA catalog is empty');
  const tickerContracts = new Set((payload?.tickers || []).map(ticker => ticker?.contract));
  const tickersComplete = catalogContracts.every(contract => tickerContracts.has(contract?.name));
  const identityCoverageComplete = listings.length === catalogContracts.length;
  const warnings = [];
  if (!tickersComplete) warnings.push('TICKERS_INCOMPLETE');
  if (!identityCoverageComplete) warnings.push('IDENTITY_COVERAGE_INCOMPLETE');
  return {
    listings,
    completeness: warnings.length ? 'partial' : 'full',
    warnings,
  };
}

export function classifyBinanceSignalCatalog(exchangeInfo) {
  if (!Array.isArray(exchangeInfo?.symbols)) {
    throw new TypeError('Invalid Binance exchangeInfo catalog');
  }
  const accepted = [];
  const quarantined = [];
  const warnings = [];
  const seenVenueSymbols = new Set();
  let catalogListingCount = 0;
  for (const contract of exchangeInfo.symbols) {
    const venueSymbol = String(contract?.symbol || '').trim().toUpperCase();
    const venueBase = String(contract?.baseAsset || '').trim().toUpperCase();
    const contractType = String(contract?.contractType || '').trim().toUpperCase();
    const isMetalException = contractType === 'PERPETUAL' && ['PAXG', 'XAUT'].includes(venueBase);
    if (String(contract?.status || '').trim().toUpperCase() !== 'TRADING' ||
        (contractType !== 'TRADIFI_PERPETUAL' && !isMetalException)) continue;
    catalogListingCount += 1;
    if (!/^[A-Z0-9]{2,40}$/.test(venueSymbol) || !/^[A-Z0-9-]{1,40}$/.test(venueBase)) {
      quarantined.push({ venueSymbol:venueSymbol || null, reasonCode:'INVALID_OFFICIAL_IDENTITY' });
      warnings.push('INVALID_OFFICIAL_IDENTITY');
      continue;
    }
    if (seenVenueSymbols.has(venueSymbol)) {
      quarantined.push({ venueSymbol:venueSymbol || null, reasonCode:'DUPLICATE_CATALOG_IDENTITY' });
      warnings.push('DUPLICATE_CATALOG_IDENTITY');
      continue;
    }
    if (venueSymbol) seenVenueSymbols.add(venueSymbol);
    const officialType = normalizedOfficialType(contract?.underlyingType);
    const category = isMetalException ? 'commodity' : categoryFromOfficialSignalType(contract?.underlyingType);
    const identity = normalizeSignalIdentity(venueBase, category, {
      allowBinanceBstock:contractType === 'TRADIFI_PERPETUAL',
    });
    if (!category && officialType && !['CRYPTO','COIN','TOKEN','MEME','MEMECOIN'].includes(officialType)) {
      quarantined.push({
        venueSymbol:venueSymbol || null,
        reasonCode:'UNSUPPORTED_OFFICIAL_TYPE',
      });
      continue;
    }
    if (!identity) {
      quarantined.push({ venueSymbol:venueSymbol || null, reasonCode:'INVALID_OFFICIAL_IDENTITY' });
      warnings.push('INVALID_OFFICIAL_IDENTITY');
      continue;
    }
    accepted.push({ contract, venueSymbol, venueBase, identity });
  }
  if (quarantined.length) warnings.push(OI_CATALOG_QUARANTINE_WARNING);
  return {
    accepted,
    catalogListingCount,
    quarantinedListings:quarantined.length,
    warnings:[...new Set(warnings)],
  };
}

async function collectBinance(baseUrl) {
  const requests = await Promise.allSettled([
    fetchSameOrigin(baseUrl, '/api/binance-public?endpoint=exchangeInfo', BINANCE_CORE_TIMEOUT_MS),
    fetchSameOrigin(baseUrl, '/api/binance-public?endpoint=premiumIndex', BINANCE_CORE_TIMEOUT_MS),
    fetchSameOrigin(baseUrl, '/api/binance-public?endpoint=ticker24hr', BINANCE_CORE_TIMEOUT_MS),
    fetchSameOrigin(baseUrl, '/api/binance-public?endpoint=fundingInfo', BINANCE_CORE_TIMEOUT_MS),
    fetchSameOrigin(baseUrl, '/api/binance-public?endpoint=oi-snapshot', BINANCE_POSITIONING_TIMEOUT_MS),
  ]);
  if (requests[0].status !== 'fulfilled' || !Array.isArray(requests[0].value?.symbols)) {
    throw new Error('trusted Binance exchangeInfo unavailable');
  }
  const info = requests[0].value;
  const optionalAvailable = requests.slice(1, 4).map((result, index) => result.status === 'fulfilled' &&
    Array.isArray(result.value) && (index === 2 || result.value.length > 0));
  const premiums = optionalAvailable[0] ? requests[1].value : [];
  const tickers = optionalAvailable[1] ? requests[2].value : [];
  const fundingInfo = optionalAvailable[2] ? requests[3].value : [];
  const oiSnapshot = requests[4].status === 'fulfilled' ? requests[4].value : null;
  const premiumMap = new Map(premiums.map(row => [row.symbol, row]));
  const tickerMap = new Map(tickers.map(row => [row.symbol, row]));
  const intervalMap = new Map(fundingInfo.map(row => [row.symbol, finiteOrNull(row.fundingIntervalHours)]));
  const listings = [];
  const catalog = classifyBinanceSignalCatalog(info);
  for (const { contract, venueSymbol, identity } of catalog.accepted) {
    const premium = premiumMap.get(venueSymbol) || {};
    const ticker = tickerMap.get(venueSymbol) || {};
    const quoteVolume = finiteOrNull(ticker.quoteVolume);
    const markPrice = finiteOrNull(premium.markPrice);
    const lastPrice = finiteOrNull(ticker.lastPrice);
    const price = markPrice ?? lastPrice;
    listings.push({
      symbol: identity.symbol,
      category: identity.category,
      venue: 'binance',
      venueSymbol,
      instrumentType: 'perpetual',
      priceUsd:price,
      oiValuationPriceMethod:markPrice !== null ? 'mark-price' : 'last-price',
      ...reportedVolumeFields(quoteVolume, 'official-quote-volume'),
      ...reportedOpenInterestFields(null, 'open-interest-x-mark-price'),
      fundingRate: finiteOrNull(premium.lastFundingRate),
      fundingIntervalHours: intervalMap.get(venueSymbol) || 8,
      ...reportedChange24hFields(
        ticker.priceChangePercent,
        'official-price-change-percent',
      ),
    });
  }
  if (!listings.length) throw new Error('trusted Binance TradFi catalog is empty');
  let openInterestBySymbol = new Map();
  try {
    if (oiSnapshot) openInterestBySymbol = normalizeBinanceOiProxySnapshot(oiSnapshot, listings);
  } catch (error) {
    console.error('[signal-snapshot] Binance fixed OI proxy invalid', error);
  }
  for (const listing of listings) {
    const fields = openInterestBySymbol.get(listing.venueSymbol);
    if (fields) Object.assign(listing, fields);
  }
  const openInterestFieldCount = listings.filter(listing => Number.isFinite(listing.openInterestUsd)).length;
  const missing = optionalAvailable.filter(available => !available).length;
  const warnings = [...catalog.warnings];
  if (missing) warnings.push('OPTIONAL_MARKET_FIELDS_UNAVAILABLE');
  if (listings.length + catalog.quarantinedListings !== catalog.catalogListingCount) {
    warnings.push('IDENTITY_COVERAGE_INCOMPLETE');
  }
  return {
    listings,
    completeness:warnings.length ? 'partial' : 'full',
    warnings:openInterestFieldCount === listings.length
      ? warnings
      : [...warnings, 'OPEN_INTEREST_INCOMPLETE'],
    openInterestFieldCount,
    catalogListingCount:catalog.catalogListingCount,
    quarantinedListings:catalog.quarantinedListings,
  };
}

function bitgetEnvelope(payload, label) {
  if (payload?.code !== '00000' || !Array.isArray(payload?.data)) {
    throw new Error(`invalid Bitget ${label} response`);
  }
  return payload.data;
}

async function collectBitget() {
  const settled = await Promise.allSettled([
    fetchJsonWithPolicy(`${BITGET_BASE}/api/v3/market/instruments?category=USDT-FUTURES`, {}, { timeoutMs: 12_000, retries: 1 }),
    fetchJsonWithPolicy(`${BITGET_BASE}/api/v2/mix/market/tickers?productType=USDT-FUTURES`, {}, { timeoutMs: 12_000, retries: 1 }),
    fetchJsonWithPolicy(`${BITGET_BASE}/api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES`, {}, { timeoutMs: 12_000, retries: 1 }),
  ]);
  if (settled[0].status !== 'fulfilled') throw new Error('trusted Bitget instruments unavailable');
  const contracts = bitgetEnvelope(settled[0].value, 'instruments');
  let tickers = null;
  let fundingRows = null;
  try { if (settled[1].status === 'fulfilled') tickers = bitgetEnvelope(settled[1].value, 'tickers'); } catch { /* partial below */ }
  try { if (settled[2].status === 'fulfilled') fundingRows = bitgetEnvelope(settled[2].value, 'funding'); } catch { /* partial below */ }
  tickers ||= [];
  fundingRows ||= [];
  const tickerMap = new Map(tickers.map(row => [row.symbol, row]));
  const fundingMap = new Map(fundingRows.map(row => [row.symbol, row]));
  const listings = [];
  let admittedCatalogListings = 0;
  for (const contract of contracts) {
    const venueBase = String(contract.baseCoin || '').toUpperCase();
    const venueSymbol = String(contract.symbol || '').toUpperCase();
    const officialType = String(contract.symbolType || '').toLowerCase();
    const exactKuaishouException = venueBase === 'KUAISHOU' && officialType === 'crypto';
    const category = exactKuaishouException ? 'equity' : categoryFromOfficialSignalType(officialType);
    if (String(contract.isRwa || '').toLowerCase() !== 'yes' || contract.status !== 'online') continue;
    // Explicit Crypto rows are correctly rejected, not unresolved RWA
    // identities. Only the official RWA product classes (plus the exact dated
    // KUAISHOU exception) belong in the admission-coverage denominator.
    if (!['stock', 'metal', 'commodity'].includes(officialType) && !exactKuaishouException) continue;
    admittedCatalogListings += 1;
    const identity = normalizeSignalIdentity(venueBase, category);
    if (!identity) continue;
    const ticker = tickerMap.get(venueSymbol) || {};
    const funding = fundingMap.get(venueSymbol) || {};
    const markPrice = finiteOrNull(ticker.markPrice);
    const lastPrice = finiteOrNull(ticker.lastPr);
    const price = markPrice ?? lastPrice;
    const valuationPriceMethod = markPrice !== null ? 'mark-price' : 'last-price';
    const holdingAmount = finiteOrNull(ticker.holdingAmount);
    const changeFraction = finiteOrNull(ticker.change24h);
    const quoteVolume = firstNumber(ticker.quoteVolume, ticker.usdtVolume);
    listings.push({
      symbol: identity.symbol,
      category: identity.category,
      venue: 'bitget',
      venueSymbol,
      instrumentType: 'perpetual',
      priceUsd: price,
      ...reportedVolumeFields(quoteVolume, 'official-quote-volume'),
      ...reportedOpenInterestFields(
        holdingAmount !== null && holdingAmount >= 0 && price > 0 ? holdingAmount * price : null,
        `holding-amount-x-${valuationPriceMethod}`,
      ),
      fundingRate: firstNumber(funding.fundingRate, ticker.fundingRate),
      fundingIntervalHours: firstNumber(funding.fundingRateInterval, contract.fundInterval) || 8,
      ...reportedChange24hFields(
        changeFraction === null ? null : changeFraction * 100,
        'official-change24h-fraction',
      ),
    });
  }
  if (!listings.length) throw new Error('trusted Bitget RWA catalog is empty');
  const missing = Number(!tickers.length) + Number(!fundingRows.length);
  const identityCoverageComplete = listings.length === admittedCatalogListings;
  const warnings = [];
  if (missing) warnings.push('OPTIONAL_MARKET_FIELDS_UNAVAILABLE');
  if (!identityCoverageComplete) warnings.push('IDENTITY_COVERAGE_INCOMPLETE');
  return {
    listings,
    completeness: warnings.length ? 'partial' : 'full',
    warnings,
  };
}

async function collectTradeXyz(baseUrl) {
  const payload = await fetchSameOrigin(baseUrl, '/api/hyperliquid-market');
  if (!/^dex:(?:xyz|tradexyz)$/i.test(String(payload?.source || '').trim())) {
    throw new Error('dedicated trade.xyz DEX identity unavailable');
  }
  const data = payload?.data;
  const universe = Array.isArray(data) && data.length === 2 ? (data[0]?.universe || data[0]) : null;
  const contexts = Array.isArray(data) && data.length === 2 ? data[1] : null;
  if (!Array.isArray(universe) || !Array.isArray(contexts)) throw new Error('trade.xyz market context unavailable');
  const officialTypes = new Map();
  for (const row of payload?.categories || []) {
    if (Array.isArray(row) && row.length >= 2) officialTypes.set(String(row[0] || '').toLowerCase(), String(row[1] || ''));
  }
  if (!officialTypes.size) throw new Error('trade.xyz official category metadata unavailable');
  const listings = [];
  const activeIndexes = [];
  for (let index = 0; index < universe.length; index += 1) {
    const meta = universe[index] || {};
    if (meta.isDelisted === true || ['1','true','yes'].includes(String(meta.isDelisted || '').toLowerCase())) continue;
    activeIndexes.push(index);
    const context = contexts[index] || {};
    const venueSymbol = String(meta.name || '');
    const symbol = (venueSymbol.includes(':') ? venueSymbol.split(':').pop() : venueSymbol).toUpperCase();
    const officialType = officialTypes.get(venueSymbol.toLowerCase()) || officialTypes.get(`xyz:${symbol}`.toLowerCase());
    // perpCategories currently omits five rows from the otherwise dedicated
    // xyz DEX universe. Admit only the exact audited fallback map used by the
    // client; an arbitrary blank-category ticker still fails closed.
    const category = tradeXyzSignalCategory(symbol, officialType);
    const identity = normalizeSignalIdentity(symbol, category, { venue:'tradexyz' });
    if (!identity || !symbol || !venueSymbol) continue;
    const price = finiteOrNull(context.markPx);
    const previousPrice = finiteOrNull(context.prevDayPx);
    const openInterest = finiteOrNull(context.openInterest);
    const dayNotionalVolume = finiteOrNull(context.dayNtlVlm);
    listings.push({
      symbol: identity.symbol,
      category: identity.category,
      venue: 'tradexyz',
      venueSymbol,
      instrumentType: 'perpetual',
      priceUsd: price,
      ...reportedVolumeFields(dayNotionalVolume, 'official-day-notional'),
      ...reportedOpenInterestFields(
        openInterest !== null && openInterest >= 0 && price > 0 ? openInterest * price : null,
        'open-interest-x-mark-price',
      ),
      fundingRate: finiteOrNull(context.funding),
      fundingIntervalHours: 1,
      ...reportedChange24hFields(
        previousPrice > 0 && price !== null ? ((price - previousPrice) / previousPrice) * 100 : null,
        'mark-vs-prev-day-price',
        { estimated:true },
      ),
    });
  }
  if (!listings.length) throw new Error('trusted trade.xyz RWA catalog is empty');
  const marketContextComplete = contexts.length === universe.length && activeIndexes.every(index =>
    contexts[index] && typeof contexts[index] === 'object');
  const identityCoverageComplete = listings.length === activeIndexes.length;
  const warnings = [];
  if (!marketContextComplete) warnings.push('MARKET_CONTEXT_INCOMPLETE');
  if (!identityCoverageComplete) warnings.push('IDENTITY_COVERAGE_INCOMPLETE');
  const completeness = marketContextComplete && identityCoverageComplete ? 'full' : 'partial';
  return { listings, completeness, warnings };
}

async function collectOkx(baseUrl) {
  const payload = await fetchSameOrigin(baseUrl, '/api/okx-market?type=perp-snapshot');
  const normalized = normalizeOkxSignalSnapshot(payload);
  if (!normalized.listings.length) throw new Error('trusted OKX RWA catalog is empty');
  return normalized;
}

export function mergeSignalHistory(history, currentSnapshot, nowMs = Date.now()) {
  const cutoff = nowMs - HISTORY_TTL_SECONDS * 1_000;
  const byBucket = new Map();
  for (const snapshot of Array.isArray(history) ? history : []) {
    if (Number(snapshot?.t) >= cutoff && Array.isArray(snapshot?.a)) byBucket.set(Number(snapshot.t), snapshot);
  }
  byBucket.set(currentSnapshot.t, currentSnapshot);
  let snapshots = [...byBucket.values()]
    .sort((left, right) => left.t - right.t)
    .slice(-HISTORY_MAX_SNAPSHOTS);
  while (snapshots.length > 1 && Buffer.byteLength(JSON.stringify(snapshots), 'utf8') > HISTORY_MAX_BYTES) {
    snapshots = snapshots.slice(1);
  }
  return snapshots;
}

async function updateRuntimeHistory(currentSnapshot, nowMs, {
  writeRequested = false,
  writeAllowed = false,
} = {}) {
  try {
    const cache = getCache({ namespace: HISTORY_NAMESPACE });
    const stored = await cache.get(HISTORY_KEY);
    const storedSnapshots = Array.isArray(stored) ? stored : [];
    const previous = storedSnapshots
      .filter(snapshot => Number(snapshot?.t) < currentSnapshot.t)
      .slice(-(HISTORY_MAX_SNAPSHOTS - 1));
    if (!writeRequested || !writeAllowed) {
      return {
        status: 'partial',
        previous,
        stored: storedSnapshots,
        writeStatus: writeRequested ? 'skipped-incomplete-sources' : 'read-only',
        error: null,
      };
    }
    const merged = mergeSignalHistory(stored, currentSnapshot, nowMs);
    await cache.set(HISTORY_KEY, merged, {
      ttl: HISTORY_TTL_SECONDS,
      tags: ['rwa-signal-history-v2'],
      name: 'RWA Signal Radar five-source hourly history',
    });
    return { status: 'partial', previous, stored: merged, writeStatus: 'stored', error: null };
  } catch (error) {
    console.error('[signal-snapshot] runtime history unavailable', error);
    return { status: 'unavailable', previous: [], stored: [], writeStatus: 'unavailable', error: error.message };
  }
}

async function updateDailyVolumeHistory(assets, nowMs, {
  writeRequested = false,
  writeAllowed = false,
} = {}) {
  try {
    const cache = getCache({ namespace: DAILY_VOLUME_HISTORY_NAMESPACE });
    const storedValue = await cache.get(DAILY_VOLUME_HISTORY_KEY);
    const stored = normalizeDailyVolumeHistory(storedValue, nowMs);
    if (!writeRequested || !writeAllowed) {
      return {
        status:'partial',
        stored,
        writeStatus:writeRequested ? 'skipped-incomplete-sources' : 'read-only',
        error:null,
      };
    }
    // The hourly writer upserts one row for the current UTC day. Repeated
    // executions replace that day, so the final successful run becomes the
    // sealed rolling-24h anchor used from the following UTC day onward.
    const current = compactDailyVolumeSnapshot(assets, nowMs, { dayMs:nowMs });
    const merged = mergeDailyVolumeHistory(stored, current, nowMs);
    await cache.set(DAILY_VOLUME_HISTORY_KEY, merged, {
      ttl:DAILY_VOLUME_HISTORY_TTL_SECONDS,
      tags:['rwa-signal-volume-daily-v1'],
      name:'RWA perpetual volume daily anchor history',
    });
    return { status:'partial', stored:merged, writeStatus:'stored', error:null };
  } catch (error) {
    console.error('[signal-snapshot] daily volume history unavailable', error);
    return {
      status:'unavailable',
      stored:[],
      writeStatus:'unavailable',
      error:error.message,
    };
  }
}

async function updateSpotAnomalyHistory(listings, nowMs, {
  writeRequested = false,
  writeAllowed = false,
} = {}) {
  try {
    const cache = getCache({ namespace:SPOT_ANOMALY_HISTORY_NAMESPACE });
    const storedValue = await cache.get(SPOT_ANOMALY_HISTORY_KEY);
    const stored = normalizeSpotDailyHistory(storedValue, nowMs);
    if (!writeRequested || !writeAllowed) {
      return {
        status:'partial',
        stored,
        writeStatus:writeRequested ? 'skipped-incomplete-sources' : 'read-only',
        error:null,
      };
    }
    // The authenticated hourly Cron replaces the current UTC day's compact
    // observation. From the next UTC day, the final successful observation is
    // the sealed prior-day rolling-24h anchor. Public reads never mutate it.
    const current = compactSpotDailySnapshot(listings, nowMs);
    const merged = mergeSpotDailyHistory(stored, current, nowMs);
    await cache.set(SPOT_ANOMALY_HISTORY_KEY, merged, {
      ttl:SPOT_ANOMALY_HISTORY_TTL_SECONDS,
      tags:['rwa-signal-spot-volume-price-history-v1'],
      name:'RWA Spot volume and price daily anchor history',
    });
    return { status:'partial', stored:merged, writeStatus:'stored', error:null };
  } catch (error) {
    console.error('[signal-snapshot] Spot anomaly history unavailable', error);
    return {
      status:'unavailable',
      stored:[],
      writeStatus:'unavailable',
      error:error?.message || 'runtime cache unavailable',
    };
  }
}

async function updateOiLiquidationHistory(assets, nowMs, {
  writeRequested = false,
  writeAllowed = false,
} = {}) {
  try {
    const cache = getCache({ namespace:OI_LIQUIDATION_HISTORY_NAMESPACE });
    const storedValue = await cache.get(OI_LIQUIDATION_HISTORY_KEY);
    const stored = normalizeOiHourlyHistory(storedValue, nowMs);
    if (!writeRequested || !writeAllowed) {
      return {
        status:'partial',
        stored,
        writeStatus:writeRequested ? 'skipped-incomplete-sources' : 'read-only',
        error:null,
      };
    }
    const current = compactOiHourlySnapshot(assets, nowMs);
    const merged = mergeOiHourlyHistory(stored, current, nowMs);
    await cache.set(OI_LIQUIDATION_HISTORY_KEY, merged, {
      ttl:OI_LIQUIDATION_HISTORY_TTL_SECONDS,
      tags:['rwa-signal-oi-liquidation-hourly-v1'],
      name:'RWA perpetual OI and liquidation-proxy hourly history',
    });
    return { status:'partial', stored:merged, writeStatus:'stored', error:null };
  } catch (error) {
    console.error('[signal-snapshot] OI liquidation-proxy history unavailable', error);
    return {
      status:'unavailable',
      stored:{ v:1, i:[], c:[], h:[] },
      writeStatus:'unavailable',
      error:error?.message || 'runtime cache unavailable',
    };
  }
}

function historyCoverageStatus(snapshotCount) {
  if (snapshotCount >= 168) return 'full';
  if (snapshotCount >= 24) return 'partial';
  return 'warming';
}

function aggregateHistoryPoints(snapshots) {
  return (Array.isArray(snapshots) ? snapshots : []).slice(-48).map(snapshot => {
    const volumeValues = (snapshot.a || []).map(row => finiteOrNull(row?.[2])).filter(Number.isFinite);
    const oiValues = (snapshot.a || []).map(row => finiteOrNull(row?.[3])).filter(Number.isFinite);
    return {
      capturedAt:new Date(snapshot.t).toISOString(),
      volume24hUsd:volumeValues.length ? volumeValues.reduce((sum, value) => sum + value, 0) : null,
      openInterestUsd:oiValues.length ? oiValues.reduce((sum, value) => sum + value, 0) : null,
    };
  });
}

export function isSignalSnapshotComparable(sources, expectedSourceNames = null) {
  const names = Array.isArray(expectedSourceNames) && expectedSourceNames.length
    ? expectedSourceNames
    : Object.keys(sources || {});
  return names.length > 0 && names.every(name => {
    const source = sources?.[name];
    if (source?.status === 'full') return true;
    const warnings = Array.isArray(source?.warnings) &&
      source.warnings.every(warning => typeof warning === 'string') ? source.warnings : null;
    const quarantineWarnings = warnings?.filter(warning =>
      warning.toUpperCase() === OI_CATALOG_QUARANTINE_WARNING) || [];
    const allowedWarnings = new Set([OI_CATALOG_QUARANTINE_WARNING, 'OPEN_INTEREST_INCOMPLETE']);
    return source?.status === 'partial' && Number.isInteger(source?.listingCount) &&
      source.listingCount > 0 && Number.isInteger(source?.catalogListingCount) &&
      source.quarantinedListings === 1 &&
      source.catalogListingCount === source.listingCount + source.quarantinedListings &&
      warnings?.length >= 1 && quarantineWarnings.length === 1 &&
      new Set(warnings.map(warning => warning.toUpperCase())).size === warnings.length &&
      warnings.every(warning => allowedWarnings.has(warning.toUpperCase()));
  });
}

export function signalHistoryWriteSucceeded(runtimeHistory, dailyVolumeHistory, spotAnomalyHistory, oiLiquidationHistory) {
  return runtimeHistory?.writeStatus === 'stored' && dailyVolumeHistory?.writeStatus === 'stored' &&
    spotAnomalyHistory?.writeStatus === 'stored' && oiLiquidationHistory?.writeStatus === 'stored';
}

export async function serveSignalSnapshot(req, res, {
  publicCache = true,
  writeHistory = false,
} = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    setNoStore(res);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (Object.keys(req.query || {}).length) {
    setNoStore(res);
    return res.status(400).json({ error: 'Unsupported query parameter' });
  }

  const baseUrl = deploymentBaseUrl(req);
  // Spot collection is failure-isolated from the existing Perpetual Radar and
  // starts concurrently so five additional official catalogs do not serialize
  // endpoint latency. Its child reports its own coverage/status contract.
  const spotSnapshotPromise = collectSpotMarketSnapshot(baseUrl).catch(error => {
    console.error('[signal-snapshot] Spot anomaly market snapshot unavailable', error);
    return {
      listings:[],
      sources:Object.fromEntries(SPOT_ANOMALY_SOURCE_NAMES.map(name => [name, {
        status:'unavailable', listingCount:0, marketFieldCount:0, priceFieldCount:0, warnings:['SOURCE_UNAVAILABLE'],
      }])),
      conflicts:[],
      quarantinedListings:0,
    };
  });
  const collectors = {
    gate: () => collectGate(baseUrl),
    binance: () => collectBinance(baseUrl),
    bitget: () => collectBitget(),
    tradexyz: () => collectTradeXyz(baseUrl),
    okx: () => collectOkx(baseUrl),
  };
  const settled = await Promise.allSettled(SIGNAL_SOURCE_NAMES.map(name => collectors[name]()));
  const sources = {};
  const oiSources = {};
  const listings = [];
  settled.forEach((result, index) => {
    const name = SIGNAL_SOURCE_NAMES[index];
    if (result.status === 'fulfilled') {
      listings.push(...result.value.listings);
      const sourceListings = result.value.listings;
      const volumeFieldCount = sourceListings.filter(row => Number.isFinite(row?.volume24hUsd)).length;
      const openInterestFieldCount = sourceListings.filter(row => Number.isFinite(row?.openInterestUsd)).length;
      const catalogIdentityComplete = !hasCatalogIdentityWarning(result.value.warnings);
      const quarantinedListings = Number.isInteger(result.value.quarantinedListings)
        ? result.value.quarantinedListings
        : 0;
      const catalogListingCount = Number.isInteger(result.value.catalogListingCount)
        ? result.value.catalogListingCount
        : sourceListings.length + quarantinedListings;
      const catalogFullyAccepted = catalogIdentityComplete && quarantinedListings === 0 &&
        catalogListingCount === sourceListings.length;
      const oiStatus = sourceListings.length && catalogFullyAccepted &&
        volumeFieldCount === sourceListings.length &&
        openInterestFieldCount === sourceListings.length
        ? 'full'
        : sourceListings.length && (volumeFieldCount > 0 || openInterestFieldCount > 0) ? 'partial' : 'unavailable';
      sources[name] = {
        status: result.value.completeness,
        listingCount: result.value.listings.length,
        catalogListingCount,
        quarantinedListings,
        warnings: result.value.warnings,
      };
      oiSources[name] = {
        status:oiStatus,
        listingCount:sourceListings.length,
        catalogListingCount,
        quarantinedListings,
        volumeFieldCount,
        openInterestFieldCount,
        warnings:[...new Set([
          ...(result.value.warnings || []),
          ...(volumeFieldCount < sourceListings.length ? ['VOLUME_INCOMPLETE'] : []),
          ...(openInterestFieldCount < sourceListings.length ? ['OPEN_INTEREST_INCOMPLETE'] : []),
        ])],
      };
    } else {
      sources[name] = {
        status:'unavailable', listingCount:0, catalogListingCount:0, quarantinedListings:0,
        warnings:['SOURCE_UNAVAILABLE'],
      };
      oiSources[name] = {
        status:'unavailable', listingCount:0, catalogListingCount:0, quarantinedListings:0,
        volumeFieldCount:0, openInterestFieldCount:0,
        warnings:['SOURCE_UNAVAILABLE'],
      };
      console.error(`[signal-snapshot] ${name} unavailable`, result.reason);
    }
  });

  const availableSources = Object.values(sources).filter(source => source.status !== 'unavailable').length;
  if (!availableSources || !listings.length) {
    setNoStore(res);
    return res.status(502).json({ error: 'RWA signal sources unavailable', sources });
  }

  const normalized = aggregateSignalListings(listings, SIGNAL_ASSET_LIMIT);
  if (!normalized.assets.length) {
    setNoStore(res);
    return res.status(502).json({ error: 'No identity-verified RWA signal assets', sources });
  }

  const capturedAtMs = Date.now();
  const spotSnapshot = await spotSnapshotPromise;
  const compact = compactSignalSnapshot(normalized.assets, capturedAtMs, SIGNAL_ASSET_LIMIT);
  const snapshotCoverageFull = SIGNAL_SOURCE_NAMES.every(name => sources[name]?.status === 'full');
  const analysisComparable = isSignalSnapshotComparable(sources, SIGNAL_SOURCE_NAMES) &&
    normalized.conflicts.length === 0;
  const oiCatalogTrusted = (result, index) => {
    const source = oiSources[SIGNAL_SOURCE_NAMES[index]];
    return result.status === 'fulfilled' &&
      result.value.listings.length > 0 && source?.listingCount > 0 &&
      source.catalogListingCount === source.listingCount + source.quarantinedListings &&
      !hasCatalogIdentityWarning(result.value.warnings);
  };
  const oiCatalogComplete = (result, index) => oiCatalogTrusted(result, index) &&
    oiSources[SIGNAL_SOURCE_NAMES[index]].quarantinedListings === 0;
  const oiCatalogComparable = settled.every(oiCatalogTrusted) && normalized.conflicts.length === 0;
  const oiHistoryComparable = oiCatalogComparable &&
    isOiHistorySnapshotComparable(oiSources, normalized.conflicts);
  const spotHistoryComparable = spotSnapshot.listings.length > 0 &&
    isSpotAnomalyHistoryComparable(spotSnapshot.sources, spotSnapshot.conflicts);
  const [runtimeHistory, dailyVolumeHistory, spotAnomalyHistory, oiLiquidationHistory] = await Promise.all([
    updateRuntimeHistory(compact, capturedAtMs, {
      writeRequested:writeHistory,
      writeAllowed:analysisComparable,
    }),
    updateDailyVolumeHistory(normalized.allAssets, capturedAtMs, {
      writeRequested:writeHistory,
      writeAllowed:analysisComparable,
    }),
    updateSpotAnomalyHistory(spotSnapshot.listings, capturedAtMs, {
      writeRequested:writeHistory,
      writeAllowed:spotHistoryComparable,
    }),
    updateOiLiquidationHistory(normalized.allAssets, capturedAtMs, {
      writeRequested:writeHistory,
      writeAllowed:oiHistoryComparable,
    }),
  ]);
  const assets = attachSignalAnalysis(normalized.assets, runtimeHistory.previous, capturedAtMs, {
    snapshotComparable:analysisComparable,
    historyAvailable: runtimeHistory.status !== 'unavailable',
  });
  const perpVolumeAnomalies = buildPerpVolumeAnomalies(
    normalized.allAssets,
    dailyVolumeHistory.stored,
    capturedAtMs,
    {
      snapshotComparable:analysisComparable,
      sourceCoverageFull:snapshotCoverageFull,
      historyAvailable:dailyVolumeHistory.status !== 'unavailable',
    },
  );
  const perpCoverageStatus = snapshotCoverageFull && normalized.conflicts.length === 0
    ? 'full'
    : availableSources > 0 ? 'partial' : 'unavailable';
  const spotWriterSucceeded = spotAnomalyHistory.writeStatus === 'stored';
  const spotVolumePriceAnomalies = buildSpotVolumePriceAnomalies(
    spotSnapshot.listings,
    spotAnomalyHistory.stored,
    capturedAtMs,
    {
      sources:spotSnapshot.sources,
      conflicts:spotSnapshot.conflicts,
      quarantinedListings:spotSnapshot.quarantinedListings,
      historyAvailable:spotAnomalyHistory.status !== 'unavailable',
      perpAssets:normalized.allAssets,
      perpCoverageStatus,
      persistence:{
        mode:'vercel-runtime-cache',
        status:spotAnomalyHistory.status,
        namespace:SPOT_ANOMALY_HISTORY_NAMESPACE,
        writer:{
          requested:writeHistory,
          succeeded:writeHistory ? spotWriterSucceeded : null,
        },
        writeStatus:spotAnomalyHistory.writeStatus,
        error:spotAnomalyHistory.error ? 'spot daily history runtime cache unavailable' : null,
      },
    },
  );
  const oiCoverage = {
    expectedSources:SIGNAL_SOURCE_NAMES.length,
    availableSources:Object.values(oiSources).filter(source => source.status !== 'unavailable').length,
    fullCatalogSources:settled.filter(oiCatalogComplete).length,
    quarantinedListings:Object.values(oiSources)
      .reduce((sum, source) => sum + source.quarantinedListings, 0),
  };
  const oiPersistence = {
    mode:'vercel-runtime-cache',
    status:oiLiquidationHistory.status,
    namespace:OI_LIQUIDATION_HISTORY_NAMESPACE,
    writer:{
      requested:writeHistory,
      succeeded:writeHistory ? oiLiquidationHistory.writeStatus === 'stored' : null,
    },
    writeStatus:oiLiquidationHistory.writeStatus,
    error:oiLiquidationHistory.error ? 'OI hourly history runtime cache unavailable' : null,
  };
  const oiBaseOptions = {
    sources:oiSources,
    coverage:oiCoverage,
    conflicts:normalized.conflicts,
    snapshotComparable:oiHistoryComparable,
    historyAvailable:oiLiquidationHistory.status !== 'unavailable',
    persistence:oiPersistence,
  };
  let preliminaryOiLiquidation;
  try {
    preliminaryOiLiquidation = buildOiLiquidationAnomalies(
      normalized.allAssets,
      oiLiquidationHistory.stored,
      capturedAtMs,
      oiBaseOptions,
    );
  } catch (error) {
    // The additive OI child must never take down the existing Signal Radar.
    // A safe fallback keeps the child explicitly Unavailable and row-empty.
    console.error('[signal-snapshot] OI liquidation-proxy analysis unavailable', error);
    preliminaryOiLiquidation = buildOiLiquidationAnomalies(
      normalized.allAssets,
      null,
      capturedAtMs,
      { ...oiBaseOptions, snapshotComparable:false, historyAvailable:false },
    );
  }
  // Positioning enrichment follows the uncapped recovery-state contract and
  // only targets a Binance contract when that exact contract is also the
  // selected price/funding reference. Cross-venue substitution is forbidden.
  // Deriving targets from the ranked rows would silently skip a triggered
  // asset whenever more than 100 alert rows exist in the same snapshot.
  const triggeredBinanceSymbols = oiTriggeredBinanceSymbols(preliminaryOiLiquidation);
  let oiLiquidationAnomalies = preliminaryOiLiquidation;
  if (triggeredBinanceSymbols.length) {
    try {
      const topTraderPositions = await fetchBinanceTopTraderPositionRows(
        baseUrl,
        triggeredBinanceSymbols,
        capturedAtMs,
      );
      oiLiquidationAnomalies = buildOiLiquidationAnomalies(
        normalized.allAssets,
        oiLiquidationHistory.stored,
        capturedAtMs,
        { ...oiBaseOptions, topTraderPositions },
      );
    } catch (error) {
      // Alerts remain valid without optional Binance positioning. The first
      // pass already represents every exact Binance contract as Unavailable.
      console.error('[signal-snapshot] Binance top-trader enrichment unavailable', error);
    }
  }
  const volumeValues = normalized.assets.map(asset => asset.volume24hUsd).filter(Number.isFinite);
  const oiValues = normalized.assets.map(asset => asset.openInterestUsd).filter(Number.isFinite);
  const responseStatus = snapshotCoverageFull && normalized.conflicts.length === 0
    ? 'full'
    : 'partial';
  const historyStatus = runtimeHistory.status === 'unavailable'
    ? 'unavailable'
    : historyCoverageStatus(runtimeHistory.stored.length);
  const writerSucceeded = signalHistoryWriteSucceeded(
    runtimeHistory,
    dailyVolumeHistory,
    spotAnomalyHistory,
    oiLiquidationHistory,
  );

  if (publicCache) {
    setPublicCache(res, 300, 600);
    res.setHeader('Vercel-Cache-Tag', 'rwa-signal-snapshot');
  } else {
    setNoStore(res);
  }
  return res.status(writeHistory && !writerSucceeded ? 503 : 200).json({
    schemaVersion: SIGNAL_SCHEMA_VERSION,
    generatedAt: new Date(capturedAtMs).toISOString(),
    bucket: new Date(compact.t).toISOString(),
    scope: 'Activity-ranked Top 100 identity-verified RWA perpetual assets from fixed official venue catalogs',
    status: responseStatus,
    coverage: {
      expectedSources: SIGNAL_SOURCE_NAMES.length,
      availableSources,
      acceptedListings: listings.length - normalized.rejected.length,
      rejectedListings: normalized.rejected.length,
      identityConflicts: normalized.conflicts.length,
      assetCount: normalized.assets.length,
      canonicalAssetCount: normalized.totalAssetCount,
      monitoredAssetLimit: SIGNAL_ASSET_LIMIT,
    },
    methodology: {
      universe: 'Top 100 canonical assets after official venue identity gates and cross-category conflict quarantine',
      universeRank: 'aggregate 24h USD volume + aggregate open interest USD, descending',
      historyEligibility: 'Every returned asset belongs to the same monitored universe written to hourly history',
    },
    sources,
    aggregates: {
      assetCount: normalized.assets.length,
      venueCount: availableSources,
      volume24hUsd: volumeValues.length ? volumeValues.reduce((sum, value) => sum + value, 0) : null,
      openInterestUsd: oiValues.length ? oiValues.reduce((sum, value) => sum + value, 0) : null,
    },
    persistence: {
      mode: 'vercel-runtime-cache',
      status: runtimeHistory.status,
      writer: {
        requested:writeHistory,
        succeeded:writeHistory ? writerSucceeded : null,
      },
      continuity: 'regional best effort; cache survives deployments but can be evicted and is not a permanent database',
      region: process.env.VERCEL_REGION || 'iad1',
      retentionHours: HISTORY_MAX_SNAPSHOTS,
      storedSnapshots: runtimeHistory.stored.length,
      writeStatus: runtimeHistory.writeStatus,
      error: runtimeHistory.error ? 'runtime cache unavailable' : null,
      dailyVolume: {
        namespace:DAILY_VOLUME_HISTORY_NAMESPACE,
        status:dailyVolumeHistory.status,
        retentionDays:PERP_VOLUME_HISTORY_DAYS,
        storedDays:dailyVolumeHistory.stored.length,
        writeStatus:dailyVolumeHistory.writeStatus,
        error:dailyVolumeHistory.error ? 'daily volume runtime cache unavailable' : null,
      },
      spotVolumePrice: {
        namespace:SPOT_ANOMALY_HISTORY_NAMESPACE,
        status:spotAnomalyHistory.status,
        retentionDays:SPOT_ANOMALY_HISTORY_DAYS,
        storedDays:spotAnomalyHistory.stored.length,
        writeStatus:spotAnomalyHistory.writeStatus,
        error:spotAnomalyHistory.error ? 'spot daily history runtime cache unavailable' : null,
      },
      oiLiquidation: {
        namespace:OI_LIQUIDATION_HISTORY_NAMESPACE,
        status:oiLiquidationHistory.status,
        retentionHours:OI_LIQUIDATION_HISTORY_HOURS,
        storedHours:Array.isArray(oiLiquidationHistory.stored?.h) ? oiLiquidationHistory.stored.h.length : 0,
        writeStatus:oiLiquidationHistory.writeStatus,
        error:oiLiquidationHistory.error ? 'OI hourly history runtime cache unavailable' : null,
      },
    },
    history: {
      status: historyStatus,
      cadence: 'hourly idempotent bucket',
      storedSnapshots: runtimeHistory.stored.length,
      fullBaselineSamples: 168,
      partialBaselineSamples: 24,
      returnedPointsPerAsset: 48,
      oldestAt: runtimeHistory.stored[0]?.t ? new Date(runtimeHistory.stored[0].t).toISOString() : null,
      newestAt: runtimeHistory.stored.at(-1)?.t ? new Date(runtimeHistory.stored.at(-1).t).toISOString() : null,
    },
    aggregateHistory: aggregateHistoryPoints(runtimeHistory.stored),
    perpVolumeAnomalies,
    spotVolumePriceAnomalies,
    oiLiquidationAnomalies,
    assets,
  });
}

export default function handler(req, res) {
  return serveSignalSnapshot(req, res, { publicCache:true, writeHistory:false });
}

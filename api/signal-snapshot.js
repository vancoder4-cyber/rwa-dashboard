import { getCache } from '@vercel/functions';

import {
  SIGNAL_ASSET_LIMIT,
  SIGNAL_SCHEMA_VERSION,
  aggregateSignalListings,
  attachSignalAnalysis,
  compactSignalSnapshot,
} from './_lib/signal-analysis.js';
import {
  categoryFromOfficialSignalType,
  normalizeSignalIdentity,
} from './_lib/security-identity.js';
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
const SOURCE_TIMEOUT_MS = 20_000;
const BITGET_BASE = 'https://api.bitget.com';
const SIGNAL_SOURCE_NAMES = Object.freeze(['gate', 'binance', 'bitget', 'tradexyz', 'okx']);
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

  for (const instrument of instruments) {
    const venueSymbol = String(instrument?.instId || '').toUpperCase();
    const instType = String(instrument?.instType || '').toUpperCase();
    const ruleType = String(instrument?.ruleType || '').toLowerCase();
    const officialCategory = OKX_SIGNAL_CATEGORIES[String(instrument?.instCategory || '')] || null;
    const isPerpetual = instType === 'SWAP' || (instType === 'FUTURES' && ruleType === 'xperp');
    if (String(instrument?.state || '').toLowerCase() !== 'live' || !isPerpetual || !officialCategory) continue;
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
    const price = firstNumber(mark.markPx, ticker.last);
    const open24h = finiteOrNull(ticker.open24h);
    const last = finiteOrNull(ticker.last);
    const baseVolume = finiteOrNull(ticker.volCcy24h);
    const directQuoteVolume = firstNumber(ticker.volCcyQuote24h, ticker.quoteVolume);
    const oiBase = firstNumber(openInterest.oiCcy,
      finiteOrNull(openInterest.oi) !== null && finiteOrNull(instrument.ctVal) !== null
        ? Number(openInterest.oi) * Number(instrument.ctVal)
        : null);

    listings.push({
      symbol: identity.symbol,
      category: identity.category,
      venue: 'okx',
      venueSymbol,
      priceUsd: price,
      volume24hUsd: directQuoteVolume ?? (baseVolume !== null && price !== null ? baseVolume * price : null),
      openInterestUsd: firstNumber(openInterest.oiUsd,
        oiBase !== null && price !== null ? oiBase * price : null),
      fundingRate: firstNumber(funding.fundingRate, funding.settFundingRate),
      fundingIntervalHours: okxFundingIntervalHours(funding),
      change24hPct: last !== null && open24h > 0 ? ((last - open24h) / open24h) * 100 : null,
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

async function fetchSameOrigin(baseUrl, path) {
  return fetchJsonWithPolicy(
    `${baseUrl}${path}`,
    { headers: { Accept: 'application/json' } },
    { timeoutMs: SOURCE_TIMEOUT_MS, retries: 0 },
  );
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
    const identity = normalizeSignalIdentity(venueBase, admittedCategory);
    if (!identity || !/^[A-Z0-9]{1,30}_USDT$/.test(venueSymbol)) continue;
    const ticker = tickerMap.get(venueSymbol) || {};
    const price = firstNumber(ticker.mark_price, contract.mark_price, ticker.last, contract.last_price);
    const quantity = firstNumber(ticker.total_size, contract.position_size);
    const multiplier = firstNumber(contract.quanto_multiplier) ?? 1;
    rows.push({
      symbol: identity.symbol,
      category: identity.category,
      venue: 'gate',
      venueSymbol,
      priceUsd: price,
      volume24hUsd: firstNumber(ticker.volume_24h_quote, ticker.volume_24h_usd),
      openInterestUsd: quantity !== null && price !== null ? quantity * multiplier * price : null,
      fundingRate: firstNumber(ticker.funding_rate, contract.funding_rate),
      fundingIntervalHours: (finiteOrNull(contract.funding_interval) || 28_800) / 3_600,
      change24hPct: finiteOrNull(ticker.change_percentage),
    });
  }
  return rows;
}

async function collectGate(baseUrl) {
  const payload = await fetchSameOrigin(baseUrl, '/api/gate-bulk?type=perp-snapshot');
  const listings = gateListings(payload);
  if (!listings.length) throw new Error('trusted Gate RWA catalog is empty');
  const tickerContracts = new Set((payload?.tickers || []).map(ticker => ticker?.contract));
  const tickersComplete = (payload?.contracts || []).every(contract => tickerContracts.has(contract?.name));
  return {
    listings,
    completeness: tickersComplete ? 'full' : 'partial',
    warnings: tickersComplete ? [] : ['TICKERS_INCOMPLETE'],
  };
}

async function collectBinance(baseUrl) {
  const requests = await Promise.allSettled([
    fetchSameOrigin(baseUrl, '/api/binance-public?endpoint=exchangeInfo'),
    fetchSameOrigin(baseUrl, '/api/binance-public?endpoint=premiumIndex'),
    fetchSameOrigin(baseUrl, '/api/binance-public?endpoint=ticker24hr'),
    fetchSameOrigin(baseUrl, '/api/binance-public?endpoint=fundingInfo'),
  ]);
  if (requests[0].status !== 'fulfilled' || !Array.isArray(requests[0].value?.symbols)) {
    throw new Error('trusted Binance exchangeInfo unavailable');
  }
  const info = requests[0].value;
  const optionalAvailable = requests.slice(1).map((result, index) => result.status === 'fulfilled' &&
    Array.isArray(result.value) && (index === 2 || result.value.length > 0));
  const premiums = optionalAvailable[0] ? requests[1].value : [];
  const tickers = optionalAvailable[1] ? requests[2].value : [];
  const fundingInfo = optionalAvailable[2] ? requests[3].value : [];
  const premiumMap = new Map(premiums.map(row => [row.symbol, row]));
  const tickerMap = new Map(tickers.map(row => [row.symbol, row]));
  const intervalMap = new Map(fundingInfo.map(row => [row.symbol, finiteOrNull(row.fundingIntervalHours)]));
  const listings = [];
  let admittedCatalogListings = 0;
  for (const contract of info.symbols) {
    const venueSymbol = String(contract.symbol || '').toUpperCase();
    const venueBase = String(contract.baseAsset || '').toUpperCase();
    const isMetalException = contract.contractType === 'PERPETUAL' && ['PAXG', 'XAUT'].includes(venueBase);
    if (contract.status !== 'TRADING' || (contract.contractType !== 'TRADIFI_PERPETUAL' && !isMetalException)) continue;
    admittedCatalogListings += 1;
    const category = isMetalException ? 'commodity' : categoryFromOfficialSignalType(contract.underlyingType);
    const identity = normalizeSignalIdentity(venueBase, category, {
      allowBinanceBstock: contract.contractType === 'TRADIFI_PERPETUAL',
    });
    if (!identity || !venueSymbol || !venueBase) continue;
    const premium = premiumMap.get(venueSymbol) || {};
    const ticker = tickerMap.get(venueSymbol) || {};
    listings.push({
      symbol: identity.symbol,
      category: identity.category,
      venue: 'binance',
      venueSymbol,
      priceUsd: firstNumber(premium.markPrice, ticker.lastPrice),
      volume24hUsd: finiteOrNull(ticker.quoteVolume),
      openInterestUsd: null,
      fundingRate: finiteOrNull(premium.lastFundingRate),
      fundingIntervalHours: intervalMap.get(venueSymbol) || 8,
      change24hPct: finiteOrNull(ticker.priceChangePercent),
    });
  }
  if (!listings.length) throw new Error('trusted Binance TradFi catalog is empty');
  const missing = optionalAvailable.filter(available => !available).length;
  const identityCoverageComplete = listings.length === admittedCatalogListings;
  const warnings = [];
  if (missing) warnings.push('OPTIONAL_MARKET_FIELDS_UNAVAILABLE');
  if (!identityCoverageComplete) warnings.push('IDENTITY_COVERAGE_INCOMPLETE');
  return {
    listings,
    completeness: missing || !identityCoverageComplete ? 'partial' : 'full',
    warnings,
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
  for (const contract of contracts) {
    const venueBase = String(contract.baseCoin || '').toUpperCase();
    const venueSymbol = String(contract.symbol || '').toUpperCase();
    const officialType = String(contract.symbolType || '').toLowerCase();
    const exactKuaishouException = venueBase === 'KUAISHOU' && officialType === 'crypto';
    const category = exactKuaishouException ? 'equity' : categoryFromOfficialSignalType(officialType);
    const identity = normalizeSignalIdentity(venueBase, category);
    if (String(contract.isRwa || '').toLowerCase() !== 'yes' || contract.status !== 'online' || !identity) continue;
    if (!['stock', 'metal', 'commodity'].includes(officialType) && !exactKuaishouException) continue;
    const ticker = tickerMap.get(venueSymbol) || {};
    const funding = fundingMap.get(venueSymbol) || {};
    const price = firstNumber(ticker.markPrice, ticker.lastPr);
    const holdingAmount = finiteOrNull(ticker.holdingAmount);
    const changeFraction = finiteOrNull(ticker.change24h);
    listings.push({
      symbol: identity.symbol,
      category: identity.category,
      venue: 'bitget',
      venueSymbol,
      priceUsd: price,
      volume24hUsd: firstNumber(ticker.quoteVolume, ticker.usdtVolume),
      openInterestUsd: holdingAmount !== null && price !== null ? holdingAmount * price : null,
      fundingRate: firstNumber(funding.fundingRate, ticker.fundingRate),
      fundingIntervalHours: firstNumber(funding.fundingRateInterval, contract.fundInterval) || 8,
      change24hPct: changeFraction === null ? null : changeFraction * 100,
    });
  }
  if (!listings.length) throw new Error('trusted Bitget RWA catalog is empty');
  const missing = Number(!tickers.length) + Number(!fundingRows.length);
  return {
    listings,
    completeness: missing ? 'partial' : 'full',
    warnings: missing ? ['OPTIONAL_MARKET_FIELDS_UNAVAILABLE'] : [],
  };
}

async function collectTradeXyz(baseUrl) {
  const payload = await fetchSameOrigin(baseUrl, '/api/hyperliquid-market');
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
  for (let index = 0; index < universe.length; index += 1) {
    const meta = universe[index] || {};
    const context = contexts[index] || {};
    const venueSymbol = String(meta.name || '');
    const symbol = (venueSymbol.includes(':') ? venueSymbol.split(':').pop() : venueSymbol).toUpperCase();
    const officialType = officialTypes.get(venueSymbol.toLowerCase()) || officialTypes.get(`xyz:${symbol}`.toLowerCase());
    // perpCategories currently omits five rows from the otherwise dedicated
    // xyz DEX universe. Admit only the exact audited fallback map used by the
    // client; an arbitrary blank-category ticker still fails closed.
    const category = tradeXyzSignalCategory(symbol, officialType);
    const identity = normalizeSignalIdentity(symbol, category);
    if (!identity || !symbol || !venueSymbol) continue;
    const price = finiteOrNull(context.markPx);
    const previousPrice = finiteOrNull(context.prevDayPx);
    const openInterest = finiteOrNull(context.openInterest);
    listings.push({
      symbol: identity.symbol,
      category: identity.category,
      venue: 'tradexyz',
      venueSymbol,
      priceUsd: price,
      volume24hUsd: finiteOrNull(context.dayNtlVlm),
      openInterestUsd: openInterest !== null && price !== null ? openInterest * price : null,
      fundingRate: finiteOrNull(context.funding),
      fundingIntervalHours: 1,
      change24hPct: previousPrice > 0 && price !== null ? ((price - previousPrice) / previousPrice) * 100 : null,
    });
  }
  if (!listings.length) throw new Error('trusted trade.xyz RWA catalog is empty');
  const marketContextComplete = contexts.length === universe.length && universe.every((_, index) =>
    contexts[index] && typeof contexts[index] === 'object');
  const identityCoverageComplete = listings.length === universe.length;
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

async function updateRuntimeHistory(currentSnapshot, nowMs, { writeAllowed = true } = {}) {
  try {
    const cache = getCache({ namespace: HISTORY_NAMESPACE });
    const stored = await cache.get(HISTORY_KEY);
    const storedSnapshots = Array.isArray(stored) ? stored : [];
    const previous = storedSnapshots
      .filter(snapshot => Number(snapshot?.t) < currentSnapshot.t)
      .slice(-(HISTORY_MAX_SNAPSHOTS - 1));
    if (!writeAllowed) {
      return {
        status: 'partial',
        previous,
        stored: storedSnapshots,
        writeStatus: 'skipped-incomplete-sources',
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
  return names.length > 0 && names.every(name => sources?.[name]?.status === 'full');
}

export async function serveSignalSnapshot(req, res, { publicCache = true } = {}) {
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
  const collectors = {
    gate: () => collectGate(baseUrl),
    binance: () => collectBinance(baseUrl),
    bitget: () => collectBitget(),
    tradexyz: () => collectTradeXyz(baseUrl),
    okx: () => collectOkx(baseUrl),
  };
  const settled = await Promise.allSettled(SIGNAL_SOURCE_NAMES.map(name => collectors[name]()));
  const sources = {};
  const listings = [];
  settled.forEach((result, index) => {
    const name = SIGNAL_SOURCE_NAMES[index];
    if (result.status === 'fulfilled') {
      listings.push(...result.value.listings);
      sources[name] = {
        status: result.value.completeness,
        listingCount: result.value.listings.length,
        warnings: result.value.warnings,
      };
    } else {
      sources[name] = { status: 'unavailable', listingCount: 0, warnings: ['SOURCE_UNAVAILABLE'] };
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
  const compact = compactSignalSnapshot(normalized.assets, capturedAtMs, SIGNAL_ASSET_LIMIT);
  const snapshotComparable = isSignalSnapshotComparable(sources, SIGNAL_SOURCE_NAMES);
  const runtimeHistory = await updateRuntimeHistory(compact, capturedAtMs, { writeAllowed: snapshotComparable });
  const assets = attachSignalAnalysis(normalized.assets, runtimeHistory.previous, capturedAtMs, {
    snapshotComparable,
    historyAvailable: runtimeHistory.status !== 'unavailable',
  });
  const volumeValues = normalized.assets.map(asset => asset.volume24hUsd).filter(Number.isFinite);
  const oiValues = normalized.assets.map(asset => asset.openInterestUsd).filter(Number.isFinite);
  const responseStatus = snapshotComparable && !normalized.conflicts.length
    ? 'full'
    : 'partial';
  const historyStatus = runtimeHistory.status === 'unavailable'
    ? 'unavailable'
    : historyCoverageStatus(runtimeHistory.stored.length);

  if (publicCache) {
    setPublicCache(res, 300, 600);
    res.setHeader('Vercel-Cache-Tag', 'rwa-signal-snapshot');
  } else {
    setNoStore(res);
  }
  return res.status(200).json({
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
      continuity: 'regional best effort; cache survives deployments but can be evicted and is not a permanent database',
      region: process.env.VERCEL_REGION || 'iad1',
      retentionHours: HISTORY_MAX_SNAPSHOTS,
      storedSnapshots: runtimeHistory.stored.length,
      writeStatus: runtimeHistory.writeStatus,
      error: runtimeHistory.error ? 'runtime cache unavailable' : null,
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
    assets,
  });
}

export default function handler(req, res) {
  return serveSignalSnapshot(req, res, { publicCache: true });
}

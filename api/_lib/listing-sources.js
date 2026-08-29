import {
  GATE_SPOT_EXACT_LEGACY_PAIRS,
  GATE_SPOT_VERIFIED_WRAPPERS,
  SECURITY_ETF_UNDERLYINGS,
  categoryFromOfficialSignalType,
  normalizeSignalIdentity,
  securityLifecycleStatus,
} from './security-identity.js';
import {
  canonicalOkxPerpSymbol,
  canonicalOkxSpotSymbol,
} from './okx.js';
import {
  fetchJsonWithPolicy,
  mapWithConcurrency,
} from './upstream.js';
import { validateUsMarketDirectoryPayload } from './us-market-directory.js';

const BITGET_BASE = 'https://api.bitget.com';
const KRAKEN_BASE = 'https://api.kraken.com/0/public';
const SOURCE_TIMEOUT_MS = 25_000;
const SECURITY_CATEGORIES = new Set(['equity', 'etf', 'pre-ipo']);
const BITGET_ALLOWED_RWA_TYPES = new Set(['stock', 'metal', 'commodity']);
const BITGET_RWA_TYPE_EXCEPTIONS = Object.freeze({
  KUAISHOU: Object.freeze({ category: 'equity', name: 'Kuaishou Technology' }),
});
const TRADE_XYZ_UNTYPED_RWA_CATEGORIES = Object.freeze({
  URANIUM: 'commodity',
  TTF: 'commodity',
  H100: 'commodity',
  NIFTY: 'index',
  IBOV: 'index',
});
const OKX_CATEGORIES = Object.freeze({
  3: 'equity',
  4: 'commodity',
  5: 'fx',
  6: 'bond',
});
const GATE_WRAPPER_SET = new Set(GATE_SPOT_VERIFIED_WRAPPERS);
const ETF_UNDERLYING_SET = new Set(SECURITY_ETF_UNDERLYINGS);
const EXACT_LEGACY_SPOT_RWA = Object.freeze({
  PAXG: Object.freeze({ underlying:'PAXG', category:'commodity' }),
  XAUT: Object.freeze({ underlying:'XAUT', category:'commodity' }),
  XAUM: Object.freeze({ underlying:'XAUM', category:'commodity' }),
  KAU: Object.freeze({ underlying:'KAU', category:'commodity' }),
  PGOLD: Object.freeze({ underlying:'PGOLD', category:'commodity' }),
  GGBR: Object.freeze({ underlying:'GGBR', category:'commodity' }),
  XAG: Object.freeze({ underlying:'XAG', category:'commodity' }),
  XAGX: Object.freeze({ underlying:'XAGX', category:'commodity' }),
  XPT: Object.freeze({ underlying:'XPT', category:'commodity' }),
  XPTX: Object.freeze({ underlying:'XPTX', category:'commodity' }),
});
const KRAKEN_EXACT_LEGACY_RWA = EXACT_LEGACY_SPOT_RWA;

const SOURCE_BOUNDS = Object.freeze({
  'perp:tradexyz': [20, 500],
  'perp:bitget': [20, 1_000],
  'perp:gate': [20, 500],
  'perp:binance': [20, 500],
  'perp:okx': [20, 500],
  'spot:bitget': [20, 1_500],
  'spot:gate': [1, 500],
  'spot:kraken': [10, 500],
  'spot:binance': [2, 500],
  'spot:okx': [2, 500],
});

function normalized(value) {
  return String(value ?? '').trim();
}

function normalizedUpper(value) {
  return normalized(value).toUpperCase();
}

function boundedSourcePolicy(deadlineAt, { retries = 0, baseDelayMs = 250 } = {}) {
  if (!Number.isFinite(deadlineAt)) {
    return { timeoutMs:SOURCE_TIMEOUT_MS, retries, baseDelayMs };
  }
  const remainingMs = Math.floor(deadlineAt - Date.now());
  if (remainingMs < 250) throw new TypeError('Spot collection deadline exhausted');
  return { timeoutMs:Math.min(SOURCE_TIMEOUT_MS, remainingMs), retries:0, baseDelayMs };
}

export function isDedicatedTradeXyzSource(value) {
  return /^dex:(?:xyz|tradexyz)$/i.test(normalized(value));
}

export function krakenListingCandidate(pairName, pair, officialEtfSet = ETF_UNDERLYING_SET) {
  if (normalized(pair?.status).toLowerCase() !== 'online') return null;
  const wsParts = normalized(pair?.wsname).split('/');
  const quote = normalizedUpper(wsParts[1] || pair?.quote).replace(/^[XZ](?=USD|USDT)/, '');
  if (!['USD', 'USDT'].includes(quote)) return null;
  const tokenized = normalized(pair?.aclass_base).toLowerCase() === 'tokenized_asset';
  // Kraken's tokenized-asset suffix is a case-sensitive lowercase `x` in
  // request parameters (for example `AAPLxUSD`). Keep that official spelling
  // separately from the dashboard's case-normalized listing identity.
  const marketQuerySymbol = tokenized
    ? normalized(pair?.altname)
    : normalized(pair?.altname || pairName);
  const venueSymbol = normalizedUpper(marketQuerySymbol);
  if (!venueSymbol) return null;
  const rawBase = normalized(wsParts[0] || pair?.base);
  if (tokenized && /x$/i.test(rawBase)) {
    if (normalizedUpper(normalized(pair?.wsname).replace('/', '')) !== venueSymbol) return null;
    const underlying = normalizedUpper(rawBase.replace(/x$/i, ''));
    if (!underlying) return null;
    return {
      venueSymbol,
      marketQuerySymbol,
      underlying,
      category:officialEtfSet.has(underlying) || ETF_UNDERLYING_SET.has(underlying) ? 'etf' : 'equity',
    };
  }
  const legacy = KRAKEN_EXACT_LEGACY_RWA[normalizedUpper(rawBase)];
  return legacy ? { venueSymbol, marketQuerySymbol, ...legacy } : null;
}

export function mergeKrakenOfficialPairEntries(pairEntries, officialEtfSet = ETF_UNDERLYING_SET) {
  const bySymbol = new Map();
  const identityConflicts = new Set();
  for (const [pairName, pair] of Array.isArray(pairEntries) ? pairEntries : []) {
    const candidate = krakenListingCandidate(pairName, pair, officialEtfSet);
    if (!candidate) continue;
    const marketDataProfile = normalized(pair?.aclass_base).toLowerCase() === 'tokenized_asset'
      ? 'kraken-tokenized'
      : 'kraken-standard';
    const wsname = normalized(pair?.wsname);
    // Tokenized catalogs expose both the market altname (`AAPLxUSD`) and an
    // internal SPV key (`AAPLSPVUSD`). They can have different ticker values,
    // so only the official market altname/wsname identity may join that row.
    // Legacy standard pairs retain their exact official pair key aliases.
    const officialAliases = (marketDataProfile === 'kraken-tokenized'
      ? [normalized(pair?.altname), wsname, wsname.replace('/', '')]
      : [normalized(pairName), normalized(pair?.altname), wsname, wsname.replace('/', '')]
    ).filter(Boolean);
    const existing = bySymbol.get(candidate.venueSymbol);
    if (existing && (
      existing.underlying !== candidate.underlying ||
      existing.category !== candidate.category ||
      existing.marketDataProfile !== marketDataProfile
    )) {
      identityConflicts.add(candidate.venueSymbol);
      bySymbol.delete(candidate.venueSymbol);
      continue;
    }
    if (identityConflicts.has(candidate.venueSymbol)) continue;
    if (existing) {
      for (const alias of officialAliases) existing.marketAliases.add(alias);
      continue;
    }
    bySymbol.set(candidate.venueSymbol, {
      ...candidate,
      marketDataProfile,
      marketAliases:new Set(officialAliases),
    });
  }

  // An alias shared by two distinct official listings is not safe evidence for
  // either listing. Remove it from the join surface rather than guessing.
  const aliasOwners = new Map();
  for (const entry of bySymbol.values()) {
    for (const alias of entry.marketAliases) {
      const key = normalizedUpper(alias);
      if (!aliasOwners.has(key)) aliasOwners.set(key, new Set());
      aliasOwners.get(key).add(entry.venueSymbol);
    }
  }
  return [...bySymbol.values()].map(entry => ({
    ...entry,
    marketAliases:[...entry.marketAliases].filter(alias => aliasOwners.get(normalizedUpper(alias))?.size === 1),
  }));
}

function listing(market, venue, venueSymbol, canonicalSymbol, category, extras = {}) {
  const venueCategory = normalized(extras.venueCategory || category).toLowerCase();
  const row = {
    market,
    venue,
    venueSymbol: normalizedUpper(venueSymbol),
    canonicalSymbol: normalizedUpper(canonicalSymbol),
    category,
    venueCategory,
    lifecycleStatus: securityLifecycleStatus(canonicalSymbol, category),
    name: normalized(extras.name) || null,
    identityStatus: extras.identityStatus || 'verified',
    identityEvidence: extras.identityEvidence || null,
  };
  // Market-data routing metadata is carried only where the official catalog
  // distinguishes otherwise identical API products. Listing Audit ignores
  // these additive fields; identity still comes exclusively from the fields
  // above.
  if (extras.marketDataProfile) row.marketDataProfile = normalized(extras.marketDataProfile);
  if (extras.marketQuerySymbol) row.marketQuerySymbol = normalized(extras.marketQuerySymbol);
  if (Array.isArray(extras.marketAliases)) {
    row.marketAliases = [...new Set(extras.marketAliases.map(normalizedUpper).filter(Boolean))];
  }
  return row;
}

export function gateExactLegacySpotListing(pair) {
  const venueSymbol = normalizedUpper(pair?.id);
  const exact = GATE_SPOT_EXACT_LEGACY_PAIRS[venueSymbol];
  if (!exact || pair?.trade_status !== 'tradable') return null;
  if (normalizedUpper(pair?.base) !== exact.base || normalizedUpper(pair?.quote) !== exact.quote) return null;
  const identity = normalizeSignalIdentity(exact.underlying, exact.category, { venue:'gate' });
  if (!identity) return null;
  return listing('spot', 'gate', venueSymbol, identity.symbol, identity.category, {
    venueCategory:exact.category,
    identityEvidence:'exact audited Gate legacy RWA pair (2026-08-14) in the live official catalog',
  });
}

function assertCatalogBounds(market, venue, rows) {
  const key = `${market}:${venue}`;
  const [minimum, maximum] = SOURCE_BOUNDS[key] || [1, 2_000];
  if (!Array.isArray(rows) || rows.length < minimum || rows.length > maximum) {
    throw new TypeError(`${key} catalog size ${Array.isArray(rows) ? rows.length : 'invalid'} outside ${minimum}-${maximum}`);
  }
  const unique = new Set(rows.map(row => normalizedUpper(row?.venueSymbol)));
  if (unique.size !== rows.length) throw new TypeError(`${key} catalog contains duplicate venue symbols`);
  return rows;
}

function assertFullDeclaredCatalog(payload, label) {
  const instruments = Array.isArray(payload?.instruments) ? payload.instruments : [];
  const coverage = payload?.coverage?.instruments;
  if (normalized(payload?.coverage?.status).toLowerCase() !== 'full' ||
      normalized(coverage?.status).toLowerCase() !== 'full' ||
      Number(coverage?.observed) !== instruments.length || Number(coverage?.expected) !== instruments.length) {
    throw new TypeError(`${label} official catalog coverage is not full`);
  }
  return instruments;
}

async function fetchSameOrigin(baseUrl, path, { deadlineAt = null } = {}) {
  return fetchJsonWithPolicy(
    `${baseUrl}${path}`,
    { headers: { Accept: 'application/json' } },
    boundedSourcePolicy(deadlineAt, { retries:0 }),
  );
}

async function fetchBitget(path, { deadlineAt = null } = {}) {
  const payload = await fetchJsonWithPolicy(
    `${BITGET_BASE}${path}`,
    { headers: { Accept: 'application/json' } },
    boundedSourcePolicy(deadlineAt, { retries:Number.isFinite(deadlineAt) ? 0 : 1, baseDelayMs:250 }),
  );
  if (!payload || payload.code !== '00000' || !Array.isArray(payload.data)) {
    throw new TypeError('Invalid Bitget official catalog');
  }
  return payload.data;
}

export function tradeXyzListingFromOfficial(instrument, officialType = '') {
  if (instrument?.isDelisted === true || ['1', 'true', 'yes'].includes(normalized(instrument?.isDelisted).toLowerCase())) {
    return null;
  }
  const venueSymbol = normalized(instrument?.name);
  const venueBase = normalizedUpper(venueSymbol.includes(':') ? venueSymbol.split(':').at(-1) : venueSymbol);
  const venueCategory = categoryFromOfficialSignalType(officialType) ||
    TRADE_XYZ_UNTYPED_RWA_CATEGORIES[venueBase] || null;
  const identity = normalizeSignalIdentity(venueBase, venueCategory, { venue: 'tradexyz' });
  if (!identity || !venueSymbol) return null;
  return listing('perp', 'tradexyz', venueSymbol, identity.symbol, identity.category, {
    venueCategory,
    name: instrument?.fullName,
    identityEvidence: officialType
      ? `Hyperliquid perpCategories:${officialType}`
      : 'audited untyped trade.xyz RWA exception',
  });
}

async function collectTradeXyz(baseUrl) {
  const payload = await fetchSameOrigin(baseUrl, '/api/hyperliquid-market');
  if (!isDedicatedTradeXyzSource(payload?.source)) {
    throw new TypeError('dedicated trade.xyz DEX identity unavailable');
  }
  const universe = Array.isArray(payload?.data) && payload.data.length === 2
    ? (payload.data[0]?.universe || payload.data[0])
    : null;
  const categories = Array.isArray(payload?.categories) ? payload.categories : [];
  if (!Array.isArray(universe) || !universe.length || !categories.length) {
    throw new TypeError('trade.xyz official universe or category metadata unavailable');
  }
  const categoryByCoin = new Map();
  for (const row of categories) {
    if (Array.isArray(row) && row.length >= 2) {
      categoryByCoin.set(normalized(row[0]).toLowerCase(), normalized(row[1]));
    }
  }
  const rows = [];
  for (const instrument of universe) {
    const venueSymbol = normalized(instrument?.name);
    const venueBase = normalizedUpper(venueSymbol.includes(':') ? venueSymbol.split(':').at(-1) : venueSymbol);
    const officialType = categoryByCoin.get(venueSymbol.toLowerCase()) ||
      categoryByCoin.get(`xyz:${venueBase}`.toLowerCase()) || '';
    const row = tradeXyzListingFromOfficial(instrument, officialType);
    if (row) rows.push(row);
  }
  return assertCatalogBounds('perp', 'tradexyz', rows);
}

async function collectBitgetPerp() {
  const instruments = await fetchBitget('/api/v3/market/instruments?category=USDT-FUTURES');
  const rows = [];
  for (const instrument of instruments) {
    const venueBase = normalizedUpper(instrument?.baseCoin);
    const officialType = normalized(instrument?.symbolType).toLowerCase();
    const identityException = BITGET_RWA_TYPE_EXCEPTIONS[venueBase];
    if (normalized(instrument?.isRwa).toLowerCase() !== 'yes' || instrument?.status !== 'online') continue;
    if (!BITGET_ALLOWED_RWA_TYPES.has(officialType) && !identityException) continue;
    const category = identityException?.category || categoryFromOfficialSignalType(officialType);
    const identity = normalizeSignalIdentity(venueBase, category, { venue: 'bitget' });
    if (!identity) continue;
    rows.push(listing('perp', 'bitget', instrument.symbol, identity.symbol, identity.category, {
      venueCategory:category,
      name: identityException?.name || instrument?.symbolName,
      identityEvidence: identityException
        ? 'audited exact Bitget RWA type exception'
        : `Bitget isRwa=yes; symbolType=${officialType}`,
    }));
  }
  return assertCatalogBounds('perp', 'bitget', rows);
}

async function collectGatePerp(baseUrl) {
  const payload = await fetchSameOrigin(baseUrl, '/api/gate-bulk?type=perp-snapshot');
  const rows = [];
  for (const contract of Array.isArray(payload?.contracts) ? payload.contracts : []) {
    const venueSymbol = normalizedUpper(contract?.name);
    const venueBase = venueSymbol.replace(/_USDT$/, '');
    const officialCategory = categoryFromOfficialSignalType(contract?.contract_type);
    const category = officialCategory === 'equity' && ['1', 'true', 'yes'].includes(normalized(contract?.is_pre_market).toLowerCase())
      ? 'pre-ipo'
      : officialCategory;
    const identity = normalizeSignalIdentity(venueBase, category, { venue: 'gate' });
    if (!identity) continue;
    rows.push(listing('perp', 'gate', venueSymbol, identity.symbol, identity.category, {
      venueCategory:category,
      identityEvidence: `Gate contract_type=${contract.contract_type}`,
    }));
  }
  return assertCatalogBounds('perp', 'gate', rows);
}

async function collectBinancePerp(baseUrl) {
  const payload = await fetchSameOrigin(baseUrl, '/api/binance-public?endpoint=exchangeInfo');
  const rows = [];
  for (const contract of Array.isArray(payload?.symbols) ? payload.symbols : []) {
    const venueBase = normalizedUpper(contract?.baseAsset);
    const isMetal = contract?.contractType === 'PERPETUAL' && ['PAXG', 'XAUT'].includes(venueBase);
    if (contract?.status !== 'TRADING' || (contract?.contractType !== 'TRADIFI_PERPETUAL' && !isMetal)) continue;
    const category = isMetal ? 'commodity' : categoryFromOfficialSignalType(contract?.underlyingType);
    const identity = normalizeSignalIdentity(venueBase, category, {
      allowBinanceBstock: contract?.contractType === 'TRADIFI_PERPETUAL',
      venue: 'binance',
    });
    if (!identity) continue;
    rows.push(listing('perp', 'binance', contract.symbol, identity.symbol, identity.category, {
      venueCategory:category,
      identityEvidence: isMetal
        ? 'audited Binance tokenized-metal exception'
        : `Binance contractType=TRADIFI_PERPETUAL; underlyingType=${contract.underlyingType}`,
    }));
  }
  return assertCatalogBounds('perp', 'binance', rows);
}

async function collectOkxPerp(baseUrl) {
  const payload = await fetchSameOrigin(baseUrl, '/api/okx-market?type=perp-snapshot');
  const rows = [];
  for (const instrument of assertFullDeclaredCatalog(payload, 'OKX Perpetual')) {
    const canonical = canonicalOkxPerpSymbol(instrument);
    const category = OKX_CATEGORIES[String(instrument?.instCategory || '')] || null;
    const identity = normalizeSignalIdentity(canonical, category, { venue: 'okx' });
    if (!identity) continue;
    rows.push(listing('perp', 'okx', instrument.instId, identity.symbol, identity.category, {
      venueCategory:category,
      identityEvidence: `OKX instCategory=${instrument.instCategory}; ${instrument.instType}/${instrument.ruleType || 'standard'}`,
    }));
  }
  return assertCatalogBounds('perp', 'okx', rows);
}

async function collectBitgetSpot(deadlineAt = null) {
  const instruments = await fetchBitget('/api/v3/market/instruments?category=SPOT', { deadlineAt });
  const rows = new Map();
  for (const instrument of instruments) {
    if (instrument?.status !== 'online' || !['USD', 'USDT'].includes(normalizedUpper(instrument?.quoteCoin))) continue;
    const venueBase = normalizedUpper(instrument?.baseCoin);
    const legacy = EXACT_LEGACY_SPOT_RWA[venueBase];
    if (normalized(instrument?.isReality).toLowerCase() !== 'yes') {
      if (!legacy) continue;
      const identity = normalizeSignalIdentity(legacy.underlying, legacy.category, { venue: 'bitget' });
      if (!identity) continue;
      const legacyRow = listing('spot', 'bitget', instrument.symbol, identity.symbol, identity.category, {
        venueCategory:legacy.category,
        name: instrument?.symbolName,
        marketDataProfile: 'bitget-standard',
        identityEvidence: 'exact audited Bitget RWA asset in the live official instruments catalog',
      });
      rows.set(legacyRow.venueSymbol, legacyRow);
      continue;
    }
    const rawUnderlying = venueBase.replace(/^R/, '');
    const identityException = BITGET_RWA_TYPE_EXCEPTIONS[rawUnderlying];
    const category = identityException?.category || categoryFromOfficialSignalType(instrument?.symbolType || 'stock');
    const identity = normalizeSignalIdentity(rawUnderlying, category, { venue: 'bitget' });
    if (!identity) continue;
    const realityRow = listing('spot', 'bitget', instrument.symbol, identity.symbol, identity.category, {
      venueCategory:category,
      name: identityException?.name || instrument?.symbolName,
      marketDataProfile: 'bitget-reality',
      identityEvidence: identityException
        ? 'audited exact Bitget Reality type exception'
        : `Bitget isReality=yes; symbolType=${instrument.symbolType || 'stock'}`,
    });
    rows.set(realityRow.venueSymbol, realityRow);
  }
  return assertCatalogBounds('spot', 'bitget', [...rows.values()]);
}

async function collectGateSpot(baseUrl, deadlineAt = null) {
  const payload = await fetchSameOrigin(baseUrl, '/api/gate-bulk?type=spot-snapshot', { deadlineAt });
  const rawPairs = (Array.isArray(payload?.pairs) ? payload.pairs : [])
    .filter(pair => pair?.trade_status === 'tradable' && ['USD', 'USDT'].includes(normalizedUpper(pair?.quote)));
  if (!rawPairs.length) throw new TypeError('Gate Spot official pair catalog unavailable');
  const rows = [];
  for (const pair of rawPairs) {
    const exactLegacy = gateExactLegacySpotListing(pair);
    if (exactLegacy) {
      rows.push(exactLegacy);
      continue;
    }
    const base = normalizedUpper(pair?.base);
    if (!GATE_WRAPPER_SET.has(base)) continue;
    const rawUnderlying = base.endsWith('ON') ? base.slice(0, -2) : base.endsWith('X') ? base.slice(0, -1) : '';
    const category = ETF_UNDERLYING_SET.has(rawUnderlying) ? 'etf' : 'equity';
    const identity = normalizeSignalIdentity(rawUnderlying, category, { venue: 'gate' });
    if (!identity) continue;
    rows.push(listing('spot', 'gate', pair.id, identity.symbol, identity.category, {
      venueCategory:category,
      identityEvidence: 'exact audited Gate Spot wrapper and live official pair',
    }));
  }
  assertCatalogBounds('spot', 'gate', rows);
  return { listings: rows, rawPairs };
}

async function collectKrakenSpot(baseUrl, deadlineAt = null) {
  const krakenPolicy = boundedSourcePolicy(deadlineAt, {
    retries:Number.isFinite(deadlineAt) ? 0 : 1,
    baseDelayMs:250,
  });
  const [standardPayload, tokenizedPayload, directoryPayload] = await Promise.all([
    fetchJsonWithPolicy(
      `${KRAKEN_BASE}/AssetPairs`,
      { headers: { Accept: 'application/json' } },
      krakenPolicy,
    ),
    fetchJsonWithPolicy(
      `${KRAKEN_BASE}/AssetPairs?aclass_base=tokenized_asset`,
      { headers: { Accept: 'application/json' } },
      krakenPolicy,
    ),
    fetchSameOrigin(baseUrl, '/api/us-market-directory', { deadlineAt }),
  ]);
  for (const payload of [standardPayload, tokenizedPayload]) {
    if (!payload || (Array.isArray(payload.error) && payload.error.length) || !payload.result || typeof payload.result !== 'object') {
      throw new TypeError('Kraken official AssetPairs catalog unavailable');
    }
  }
  const directoryValidation = validateUsMarketDirectoryPayload(directoryPayload);
  if (!directoryValidation.valid) {
    throw new TypeError('Official U.S. ETF identity directory unavailable');
  }
  const officialEtfSet = new Set(directoryPayload.etfs);
  const mergedEntries = mergeKrakenOfficialPairEntries([
    ...Object.entries(standardPayload.result),
    ...Object.entries(tokenizedPayload.result),
  ], officialEtfSet);
  const rows = [];
  for (const entry of mergedEntries) {
    const identity = normalizeSignalIdentity(entry.underlying, entry.category, { venue: 'kraken' });
    if (!identity) continue;
    rows.push(listing('spot', 'kraken', entry.venueSymbol, identity.symbol, identity.category, {
      venueCategory:entry.category,
      marketDataProfile: entry.marketDataProfile,
      marketQuerySymbol: entry.marketQuerySymbol,
      marketAliases: entry.marketAliases,
      identityEvidence: entry.category === 'commodity'
        ? 'exact audited Kraken RWA asset in the live official AssetPairs catalog'
        : 'Kraken official tokenized_asset AssetPairs catalog',
    }));
  }
  return assertCatalogBounds('spot', 'kraken', rows);
}

async function collectBinanceSpot(baseUrl, deadlineAt = null) {
  const payload = await fetchSameOrigin(baseUrl, '/api/binance-public?endpoint=spot-snapshot', { deadlineAt });
  if (payload?.schemaVersion !== 1 || payload?.catalogStatus !== 'full') {
    throw new TypeError('Binance admitted Spot catalog unavailable');
  }
  const rows = [];
  for (const instrument of Array.isArray(payload?.instruments) ? payload.instruments : []) {
    const category = normalized(instrument?.category).toLowerCase();
    const rawCanonical = instrument?.product === 'bstock' ? instrument?.underlyingSymbol : instrument?.baseAsset;
    const identity = normalizeSignalIdentity(rawCanonical, category, { venue: 'binance' });
    if (!identity) continue;
    rows.push(listing('spot', 'binance', instrument.symbol, identity.symbol, identity.category, {
      venueCategory:category,
      identityEvidence: instrument.identityEvidence,
    }));
  }
  return assertCatalogBounds('spot', 'binance', rows);
}

async function collectOkxSpot(baseUrl, deadlineAt = null) {
  const payload = await fetchSameOrigin(baseUrl, '/api/okx-market?type=spot-snapshot', { deadlineAt });
  const rows = [];
  for (const instrument of assertFullDeclaredCatalog(payload, 'OKX Spot')) {
    const canonical = canonicalOkxSpotSymbol(instrument);
    const category = String(instrument?.instCategory) === '3'
      ? (ETF_UNDERLYING_SET.has(canonical) ? 'etf' : 'equity')
      : 'commodity';
    const identity = normalizeSignalIdentity(canonical, category, { venue: 'okx' });
    if (!identity) continue;
    rows.push(listing('spot', 'okx', instrument.instId, identity.symbol, identity.category, {
      venueCategory:category,
      identityEvidence: String(instrument?.instCategory) === '3'
        ? 'OKX official Unified Tokenized Stocks category'
        : 'audited exact OKX tokenized-gold pair',
    }));
  }
  return assertCatalogBounds('spot', 'okx', rows);
}

function gateCandidateUnderlying(base) {
  if (/^[A-Z0-9.-]{3,38}ON$/.test(base)) return base.slice(0, -2);
  if (/^[A-Z0-9.-]{4,39}X$/.test(base)) return base.slice(0, -1);
  return null;
}

function addGateReviewCandidates(gateObservation, observations) {
  if (!gateObservation?.rawPairs?.length) return gateObservation?.listings || [];
  const verifiedSecurityByCanonical = new Map();
  for (const observation of observations) {
    for (const row of observation?.listings || []) {
      if (row.identityStatus === 'verified' && SECURITY_CATEGORIES.has(row.category)) {
        const canonical = normalizedUpper(row.canonicalSymbol);
        if (!verifiedSecurityByCanonical.has(canonical)) verifiedSecurityByCanonical.set(canonical, new Set());
        verifiedSecurityByCanonical.get(canonical).add(row.category);
      }
    }
  }
  const rows = [...gateObservation.listings];
  const admittedSymbols = new Set(rows.map(row => normalizedUpper(row.venueSymbol)));
  for (const pair of gateObservation.rawPairs) {
    const venueSymbol = normalizedUpper(pair?.id);
    const base = normalizedUpper(pair?.base);
    if (admittedSymbols.has(venueSymbol)) continue;
    const candidate = gateCandidateUnderlying(base);
    const crossCategories = candidate ? verifiedSecurityByCanonical.get(candidate) : null;
    if (!candidate || crossCategories?.size !== 1) continue;
    const [crossCategory] = crossCategories;
    rows.push(listing('spot', 'gate', venueSymbol, candidate, crossCategory, {
      venueCategory:crossCategory,
      identityStatus: 'review-required',
      identityEvidence: 'Gate live pair plus same canonical on another official RWA catalog; exact Gate wrapper identity pending',
    }));
    admittedSymbols.add(venueSymbol);
  }
  return assertCatalogBounds('spot', 'gate', rows);
}

export async function collectListingSourceObservations(baseUrl) {
  const definitions = [
    ['perp', 'tradexyz', () => collectTradeXyz(baseUrl)],
    ['perp', 'bitget', () => collectBitgetPerp()],
    ['perp', 'gate', () => collectGatePerp(baseUrl)],
    ['perp', 'binance', () => collectBinancePerp(baseUrl)],
    ['perp', 'okx', () => collectOkxPerp(baseUrl)],
    ['spot', 'bitget', () => collectBitgetSpot()],
    ['spot', 'gate', () => collectGateSpot(baseUrl)],
    ['spot', 'kraken', () => collectKrakenSpot(baseUrl)],
    ['spot', 'binance', () => collectBinanceSpot(baseUrl)],
    ['spot', 'okx', () => collectOkxSpot(baseUrl)],
  ];
  const settled = await mapWithConcurrency(definitions, 5, async ([market, venue, collect]) => {
    try {
      const value = await collect();
      return {
        market,
        venue,
        status: 'full',
        listings: Array.isArray(value) ? value : value.listings,
        rawPairs: value?.rawPairs,
        reason: null,
      };
    } catch (error) {
      return {
        market,
        venue,
        status: 'unavailable',
        listings: [],
        reason: error?.message || 'official catalog unavailable',
      };
    }
  });
  const gateSpot = settled.find(row => row.market === 'spot' && row.venue === 'gate' && row.status === 'full');
  if (gateSpot) {
    try {
      gateSpot.listings = addGateReviewCandidates(gateSpot, settled);
    } catch (error) {
      gateSpot.status = 'unavailable';
      gateSpot.listings = [];
      gateSpot.reason = error?.message || 'Gate Spot candidate enrichment unavailable';
    }
  }
  return settled.map(({ rawPairs, ...observation }) => observation);
}

// Signal Radar needs the complete verified Spot universe without fetching the
// five Perpetual catalogs a second time. Keep this routed through the exact
// same private collectors so listing monitoring and anomaly history cannot
// drift into separate ticker-based identity rules.
export async function collectVerifiedSpotListingSourceObservations(baseUrl, { deadlineAt = null } = {}) {
  const definitions = [
    ['spot', 'bitget', () => collectBitgetSpot(deadlineAt)],
    ['spot', 'gate', () => collectGateSpot(baseUrl, deadlineAt)],
    ['spot', 'kraken', () => collectKrakenSpot(baseUrl, deadlineAt)],
    ['spot', 'binance', () => collectBinanceSpot(baseUrl, deadlineAt)],
    ['spot', 'okx', () => collectOkxSpot(baseUrl, deadlineAt)],
  ];
  return mapWithConcurrency(definitions, 5, async ([market, venue, collect]) => {
    try {
      const value = await collect();
      return {
        market,
        venue,
        status: 'full',
        listings: (Array.isArray(value) ? value : value.listings)
          .filter(row => row?.identityStatus === 'verified'),
        reason: null,
      };
    } catch (error) {
      return {
        market,
        venue,
        status: 'unavailable',
        listings: [],
        reason: error?.message || 'official catalog unavailable',
      };
    }
  });
}

import {
  GATE_SPOT_VERIFIED_WRAPPERS,
  SECURITY_ETF_UNDERLYINGS,
  categoryFromOfficialSignalType,
  normalizeSignalIdentity,
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

export function isDedicatedTradeXyzSource(value) {
  return /^dex:(?:xyz|tradexyz)$/i.test(normalized(value));
}

export function krakenListingCandidate(pairName, pair, officialEtfSet = ETF_UNDERLYING_SET) {
  if (normalized(pair?.status).toLowerCase() !== 'online') return null;
  const wsParts = normalized(pair?.wsname).split('/');
  const quote = normalizedUpper(wsParts[1] || pair?.quote).replace(/^[XZ](?=USD|USDT)/, '');
  if (!['USD', 'USDT'].includes(quote)) return null;
  const venueSymbol = normalizedUpper(pair?.altname || pairName);
  if (!venueSymbol) return null;
  const rawBase = normalized(wsParts[0] || pair?.base);
  if (normalized(pair?.aclass_base).toLowerCase() === 'tokenized_asset' && /x$/i.test(rawBase)) {
    const underlying = normalizedUpper(rawBase.replace(/x$/i, ''));
    if (!underlying) return null;
    return {
      venueSymbol,
      underlying,
      category:officialEtfSet.has(underlying) || ETF_UNDERLYING_SET.has(underlying) ? 'etf' : 'equity',
    };
  }
  const legacy = KRAKEN_EXACT_LEGACY_RWA[normalizedUpper(rawBase)];
  return legacy ? { venueSymbol, ...legacy } : null;
}

function listing(market, venue, venueSymbol, canonicalSymbol, category, extras = {}) {
  return {
    market,
    venue,
    venueSymbol: normalizedUpper(venueSymbol),
    canonicalSymbol: normalizedUpper(canonicalSymbol),
    category,
    name: normalized(extras.name) || null,
    identityStatus: extras.identityStatus || 'verified',
    identityEvidence: extras.identityEvidence || null,
  };
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

async function fetchSameOrigin(baseUrl, path) {
  return fetchJsonWithPolicy(
    `${baseUrl}${path}`,
    { headers: { Accept: 'application/json' } },
    { timeoutMs: SOURCE_TIMEOUT_MS, retries: 0 },
  );
}

async function fetchBitget(path) {
  const payload = await fetchJsonWithPolicy(
    `${BITGET_BASE}${path}`,
    { headers: { Accept: 'application/json' } },
    { timeoutMs: SOURCE_TIMEOUT_MS, retries: 1, baseDelayMs: 250 },
  );
  if (!payload || payload.code !== '00000' || !Array.isArray(payload.data)) {
    throw new TypeError('Invalid Bitget official catalog');
  }
  return payload.data;
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
    if (instrument?.isDelisted === true || ['1', 'true', 'yes'].includes(normalized(instrument?.isDelisted).toLowerCase())) {
      continue;
    }
    const venueSymbol = normalized(instrument?.name);
    const venueBase = normalizedUpper(venueSymbol.includes(':') ? venueSymbol.split(':').at(-1) : venueSymbol);
    const officialType = categoryByCoin.get(venueSymbol.toLowerCase()) ||
      categoryByCoin.get(`xyz:${venueBase}`.toLowerCase()) || '';
    const category = categoryFromOfficialSignalType(officialType) || TRADE_XYZ_UNTYPED_RWA_CATEGORIES[venueBase] || null;
    const identity = normalizeSignalIdentity(venueBase, category, { venue: 'tradexyz' });
    if (!identity || !venueSymbol) continue;
    rows.push(listing('perp', 'tradexyz', venueSymbol, identity.symbol, identity.category, {
      name: instrument?.fullName,
      identityEvidence: officialType
        ? `Hyperliquid perpCategories:${officialType}`
        : 'audited untyped trade.xyz RWA exception',
    }));
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
      identityEvidence: `OKX instCategory=${instrument.instCategory}; ${instrument.instType}/${instrument.ruleType || 'standard'}`,
    }));
  }
  return assertCatalogBounds('perp', 'okx', rows);
}

async function collectBitgetSpot() {
  const instruments = await fetchBitget('/api/v3/market/instruments?category=SPOT');
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
        name: instrument?.symbolName,
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
      name: identityException?.name || instrument?.symbolName,
      identityEvidence: identityException
        ? 'audited exact Bitget Reality type exception'
        : `Bitget isReality=yes; symbolType=${instrument.symbolType || 'stock'}`,
    });
    rows.set(realityRow.venueSymbol, realityRow);
  }
  return assertCatalogBounds('spot', 'bitget', [...rows.values()]);
}

async function collectGateSpot(baseUrl) {
  const payload = await fetchSameOrigin(baseUrl, '/api/gate-bulk?type=spot-snapshot');
  const rawPairs = (Array.isArray(payload?.pairs) ? payload.pairs : [])
    .filter(pair => pair?.trade_status === 'tradable' && ['USD', 'USDT'].includes(normalizedUpper(pair?.quote)));
  if (!rawPairs.length) throw new TypeError('Gate Spot official pair catalog unavailable');
  const rows = [];
  for (const pair of rawPairs) {
    const base = normalizedUpper(pair?.base);
    if (!GATE_WRAPPER_SET.has(base)) continue;
    const rawUnderlying = base.endsWith('ON') ? base.slice(0, -2) : base.endsWith('X') ? base.slice(0, -1) : '';
    const category = ETF_UNDERLYING_SET.has(rawUnderlying) ? 'etf' : 'equity';
    const identity = normalizeSignalIdentity(rawUnderlying, category, { venue: 'gate' });
    if (!identity) continue;
    rows.push(listing('spot', 'gate', pair.id, identity.symbol, identity.category, {
      identityEvidence: 'exact audited Gate Spot wrapper and live official pair',
    }));
  }
  assertCatalogBounds('spot', 'gate', rows);
  return { listings: rows, rawPairs };
}

async function collectKrakenSpot(baseUrl) {
  const [standardPayload, tokenizedPayload, directoryPayload] = await Promise.all([
    fetchJsonWithPolicy(
      `${KRAKEN_BASE}/AssetPairs`,
      { headers: { Accept: 'application/json' } },
      { timeoutMs: SOURCE_TIMEOUT_MS, retries: 1, baseDelayMs: 250 },
    ),
    fetchJsonWithPolicy(
      `${KRAKEN_BASE}/AssetPairs?aclass_base=tokenized_asset`,
      { headers: { Accept: 'application/json' } },
      { timeoutMs: SOURCE_TIMEOUT_MS, retries: 1, baseDelayMs: 250 },
    ),
    fetchSameOrigin(baseUrl, '/api/us-market-directory'),
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
  const bySymbol = new Map();
  for (const [pairName, pair] of [
    ...Object.entries(standardPayload.result),
    ...Object.entries(tokenizedPayload.result),
  ]) {
    const candidate = krakenListingCandidate(pairName, pair, officialEtfSet);
    if (candidate) bySymbol.set(candidate.venueSymbol, candidate);
  }
  const rows = [];
  for (const entry of bySymbol.values()) {
    const identity = normalizeSignalIdentity(entry.underlying, entry.category, { venue: 'kraken' });
    if (!identity) continue;
    rows.push(listing('spot', 'kraken', entry.venueSymbol, identity.symbol, identity.category, {
      identityEvidence: entry.category === 'commodity'
        ? 'exact audited Kraken RWA asset in the live official AssetPairs catalog'
        : 'Kraken official tokenized_asset AssetPairs catalog',
    }));
  }
  return assertCatalogBounds('spot', 'kraken', rows);
}

async function collectBinanceSpot(baseUrl) {
  const payload = await fetchSameOrigin(baseUrl, '/api/binance-public?endpoint=spot-snapshot');
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
      identityEvidence: instrument.identityEvidence,
    }));
  }
  return assertCatalogBounds('spot', 'binance', rows);
}

async function collectOkxSpot(baseUrl) {
  const payload = await fetchSameOrigin(baseUrl, '/api/okx-market?type=spot-snapshot');
  const rows = [];
  for (const instrument of assertFullDeclaredCatalog(payload, 'OKX Spot')) {
    const canonical = canonicalOkxSpotSymbol(instrument);
    const category = String(instrument?.instCategory) === '3'
      ? (ETF_UNDERLYING_SET.has(canonical) ? 'etf' : 'equity')
      : 'commodity';
    const identity = normalizeSignalIdentity(canonical, category, { venue: 'okx' });
    if (!identity) continue;
    rows.push(listing('spot', 'okx', instrument.instId, identity.symbol, identity.category, {
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

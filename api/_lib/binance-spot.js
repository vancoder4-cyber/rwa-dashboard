import {
  categoryFromOfficialSignalType,
  normalizeSignalIdentity,
} from './security-identity.js';

const SYMBOL_PATTERN = /^[A-Z0-9]{2,40}$/;
const BASE_PATTERN = /^[A-Z0-9.-]{1,30}$/;
const SECURITY_CATEGORIES = new Set(['equity', 'etf']);
const SPOT_QUOTES = new Set(['USD', 'USDT']);

// A trailing B is only a discovery signal. These exact exceptions are audited
// venue identities for wrappers whose underlying does not have an exact raw
// ticker match in Binance's current TRADIFI_PERPETUAL catalog.
export const BINANCE_BSTOCK_EXCEPTIONS = Object.freeze({
  QNTB: Object.freeze({
    underlyingSymbol: 'QNT',
    category: 'equity',
    underlyingType: 'EQUITY',
    auditedAt: '2026-08-07',
  }),
});

// PAXG/XAUT are exact tokenized-metal exceptions. This does not admit other
// Binance COIN/crypto products or additional quote currencies.
export const BINANCE_SPOT_METAL_EXCEPTIONS = Object.freeze({
  PAXG: Object.freeze({ category: 'commodity', underlyingType: 'COMMODITY' }),
  XAUT: Object.freeze({ category: 'commodity', underlyingType: 'COMMODITY' }),
});

function catalogRows(payload, label) {
  if (!Array.isArray(payload?.symbols) || payload.symbols.length === 0) {
    throw new TypeError(`Invalid Binance ${label} catalog`);
  }
  return payload.symbols;
}

function catalogIdentity(row, label) {
  const symbol = String(row?.symbol || '').trim().toUpperCase();
  const baseAsset = String(row?.baseAsset || '').trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(symbol) || !BASE_PATTERN.test(baseAsset)) {
    throw new TypeError(`Invalid Binance ${label} identity`);
  }
  return { symbol, baseAsset };
}

function addTradfiEvidence(map, conflicts, key, evidence) {
  if (!key || conflicts.has(key)) return;
  const current = map.get(key);
  if (!current) {
    map.set(key, evidence);
    return;
  }
  if (current.category !== evidence.category || current.canonicalSymbol !== evidence.canonicalSymbol) {
    map.delete(key);
    conflicts.add(key);
  }
}

function activeTradfiEvidence(futuresExchangeInfo) {
  const rows = catalogRows(futuresExchangeInfo, 'futures');
  const raw = new Map();
  const canonical = new Map();
  const rawConflicts = new Set();
  const canonicalConflicts = new Set();
  let activeContracts = 0;

  for (const row of rows) {
    if (row?.status !== 'TRADING' || row?.contractType !== 'TRADIFI_PERPETUAL') continue;
    activeContracts += 1;
    const identity = catalogIdentity(row, 'futures');
    const category = categoryFromOfficialSignalType(row?.underlyingType);
    if (!SECURITY_CATEGORIES.has(category)) continue;
    const normalized = normalizeSignalIdentity(identity.baseAsset, category, { venue: 'binance' });
    if (!normalized || !SECURITY_CATEGORIES.has(normalized.category)) continue;
    const evidence = Object.freeze({
      rawUnderlying: identity.baseAsset,
      canonicalSymbol: normalized.symbol,
      category: normalized.category,
      underlyingType: String(row?.underlyingType || '').trim().toUpperCase(),
      futuresSymbol: identity.symbol,
    });
    addTradfiEvidence(raw, rawConflicts, identity.baseAsset, evidence);
    addTradfiEvidence(canonical, canonicalConflicts, normalized.symbol, evidence);
  }

  if (!activeContracts || (!raw.size && !canonical.size)) {
    throw new TypeError('Binance active TradFi identity catalog is empty');
  }
  return {
    raw,
    canonical,
    activeContracts,
    identityConflicts: rawConflicts.size + canonicalConflicts.size,
  };
}

function bstockEvidence(baseAsset, tradfi) {
  if (baseAsset.length < 3 || !baseAsset.endsWith('B')) return null;
  const candidate = baseAsset.slice(0, -1);
  const official = tradfi.raw.get(candidate) || tradfi.canonical.get(candidate);
  if (official) return { ...official, identityEvidence: 'active-tradifi-futures' };

  const exception = BINANCE_BSTOCK_EXCEPTIONS[baseAsset];
  if (!exception) return null;
  return {
    rawUnderlying: exception.underlyingSymbol,
    canonicalSymbol: exception.underlyingSymbol,
    category: exception.category,
    underlyingType: exception.underlyingType,
    futuresSymbol: null,
    identityEvidence: `audited-exception:${exception.auditedAt}`,
  };
}

export function selectBinanceSpotRwaCatalog(spotExchangeInfo, futuresExchangeInfo) {
  const spotRows = catalogRows(spotExchangeInfo, 'spot');
  const tradfi = activeTradfiEvidence(futuresExchangeInfo);
  const selected = new Map();
  let bStocks = 0;
  let metals = 0;

  for (const row of spotRows) {
    if (row?.status !== 'TRADING' || row?.isSpotTradingAllowed === false) continue;
    const identity = catalogIdentity(row, 'spot');
    const quoteAsset = String(row?.quoteAsset || '').trim().toUpperCase();
    if (!SPOT_QUOTES.has(quoteAsset)) continue;

    const metal = BINANCE_SPOT_METAL_EXCEPTIONS[identity.baseAsset];
    const bstock = metal ? null : bstockEvidence(identity.baseAsset, tradfi);
    if (!metal && !bstock) continue;

    const instrument = metal
      ? {
          symbol: identity.symbol,
          baseAsset: identity.baseAsset,
          quoteAsset,
          status: 'TRADING',
          product: 'tokenized-metal',
          underlyingSymbol: null,
          category: metal.category,
          underlyingType: metal.underlyingType,
          identityEvidence: 'audited-tokenized-metal',
          futuresSymbol: null,
        }
      : {
          symbol: identity.symbol,
          baseAsset: identity.baseAsset,
          quoteAsset,
          status: 'TRADING',
          product: 'bstock',
          underlyingSymbol: bstock.canonicalSymbol,
          category: bstock.category,
          underlyingType: bstock.underlyingType,
          identityEvidence: bstock.identityEvidence,
          futuresSymbol: bstock.futuresSymbol,
        };
    if (selected.has(instrument.symbol)) {
      throw new TypeError('Duplicate Binance admitted spot identity');
    }
    selected.set(instrument.symbol, Object.freeze(instrument));
    if (metal) metals += 1;
    else bStocks += 1;
  }

  if (!selected.size) throw new TypeError('Binance admitted RWA spot catalog is empty');
  return {
    instruments: [...selected.values()].sort((left, right) => left.symbol.localeCompare(right.symbol)),
    coverage: Object.freeze({
      spotSymbolsSeen: spotRows.length,
      activeTradifiContracts: tradfi.activeContracts,
      admittedListings: selected.size,
      bStocks,
      metals,
      identityConflicts: tradfi.identityConflicts,
    }),
  };
}

function finiteTickerValue(value, { positive = false, signed = false } = {}) {
  if (value === '' || value === null || value === undefined) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (positive && numeric <= 0) return null;
  if (!signed && !positive && numeric < 0) return null;
  return numeric;
}

function normalizedTicker(row) {
  return {
    symbol: String(row?.symbol || '').trim().toUpperCase(),
    lastPrice: finiteTickerValue(row?.lastPrice, { positive: true }),
    priceChangePercent: finiteTickerValue(row?.priceChangePercent, { signed: true }),
    quoteVolume: finiteTickerValue(row?.quoteVolume),
    highPrice: finiteTickerValue(row?.highPrice, { positive: true }),
    lowPrice: finiteTickerValue(row?.lowPrice, { positive: true }),
    bidPrice: finiteTickerValue(row?.bidPrice, { positive: true }),
    askPrice: finiteTickerValue(row?.askPrice, { positive: true }),
  };
}

export function normalizeBinanceSpotTickerCoverage(instruments, tickerRows) {
  if (!Array.isArray(instruments) || !instruments.length) {
    throw new TypeError('Invalid Binance admitted spot catalog');
  }
  const expectedSymbols = new Set(instruments.map(row => String(row?.symbol || '').toUpperCase()));
  if (expectedSymbols.size !== instruments.length || [...expectedSymbols].some(symbol => !SYMBOL_PATTERN.test(symbol))) {
    throw new TypeError('Invalid Binance admitted spot identities');
  }

  const bySymbol = new Map();
  const duplicates = new Set();
  for (const row of Array.isArray(tickerRows) ? tickerRows : []) {
    const symbol = String(row?.symbol || '').trim().toUpperCase();
    if (!expectedSymbols.has(symbol) || duplicates.has(symbol)) continue;
    if (bySymbol.has(symbol)) {
      bySymbol.delete(symbol);
      duplicates.add(symbol);
      continue;
    }
    bySymbol.set(symbol, normalizedTicker(row));
  }

  const tickers = [...bySymbol.values()].sort((left, right) => left.symbol.localeCompare(right.symbol));
  const completeSymbols = new Set(tickers.filter(row =>
    row.lastPrice !== null && row.priceChangePercent !== null && row.quoteVolume !== null &&
    row.highPrice !== null && row.lowPrice !== null && row.bidPrice !== null && row.askPrice !== null
  ).map(row => row.symbol));
  const missingSymbols = [...expectedSymbols].filter(symbol => !bySymbol.has(symbol)).sort();
  const incompleteSymbols = [...expectedSymbols]
    .filter(symbol => bySymbol.has(symbol) && !completeSymbols.has(symbol))
    .sort();
  const expected = expectedSymbols.size;
  const observed = bySymbol.size;
  const complete = completeSymbols.size;
  const status = complete === expected
    ? 'full'
    : observed > 0 ? 'partial' : 'unavailable';

  return {
    tickers,
    coverage: Object.freeze({
      status,
      observed,
      complete,
      expected,
      missingSymbols: Object.freeze(missingSymbols),
      incompleteSymbols: Object.freeze(incompleteSymbols),
      duplicateSymbols: Object.freeze([...duplicates].sort()),
    }),
  };
}

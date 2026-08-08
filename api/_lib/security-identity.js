// Server-side RWA security identity registry.
//
// Venue metadata must admit a listing before this module is called. The
// lifecycle registry may then refine an already verified security, but it must
// never turn a crypto/coin/token category into a security.

const CATEGORY_SET = new Set(['equity', 'etf', 'commodity', 'index', 'fx', 'pre-ipo']);

const OFFICIAL_TYPE_CATEGORIES = Object.freeze({
  PREIPO: 'pre-ipo',
  PREMARKET: 'pre-ipo',
  ETF: 'etf',
  EQUITYETF: 'etf',
  STOCKETF: 'etf',
  COMMODITY: 'commodity',
  COMMODITIES: 'commodity',
  COMMOD: 'commodity',
  METAL: 'commodity',
  METALS: 'commodity',
  INDEX: 'index',
  INDICES: 'index',
  FOREX: 'fx',
  FX: 'fx',
  STOCK: 'equity',
  STOCKS: 'equity',
  EQUITY: 'equity',
  EQUITIES: 'equity',
  SHARE: 'equity',
  SHARES: 'equity',
  PREFERREDSTOCK: 'equity',
});

const OFFICIAL_NON_RWA_TYPES = new Set(['CRYPTO', 'COIN', 'TOKEN', 'MEME', 'MEMECOIN']);

export const SECURITY_LISTING_REGISTRY = Object.freeze({
  SPCX: Object.freeze({ category:'equity', status:'public', aliases:Object.freeze(['SPACEX', 'SPCXB', 'SPCXON', 'SPCXX']) }),
  CBRS: Object.freeze({ category:'equity', status:'public', aliases:Object.freeze(['CBRSB', 'CBRSON', 'CBRSX', 'SCBRS']) }),
  MINIMAX: Object.freeze({ category:'equity', status:'public', aliases:Object.freeze([]) }),
  ZHIPU: Object.freeze({ category:'equity', status:'public', aliases:Object.freeze([]) }),
  CXMT: Object.freeze({ category:'equity', status:'public', aliases:Object.freeze([]) }),
  QNT: Object.freeze({ category:'equity', status:'public', aliases:Object.freeze(['QNTX', 'QNTSTOCK', 'QNTB']) }),
  OPENAI: Object.freeze({ category:'pre-ipo', status:'pre-ipo', aliases:Object.freeze([]) }),
  ANTHROPIC: Object.freeze({ category:'pre-ipo', status:'pre-ipo', aliases:Object.freeze([]) }),
  ANDURIL: Object.freeze({ category:'pre-ipo', status:'pre-ipo', aliases:Object.freeze([]) }),
  KALSHI: Object.freeze({ category:'pre-ipo', status:'pre-ipo', aliases:Object.freeze([]) }),
  KIMI: Object.freeze({ category:'pre-ipo', status:'pre-ipo', aliases:Object.freeze([]) }),
  NEURALINK: Object.freeze({ category:'pre-ipo', status:'pre-ipo', aliases:Object.freeze([]) }),
  POLYMARKET: Object.freeze({ category:'pre-ipo', status:'pre-ipo', aliases:Object.freeze([]) }),
  UNITREE: Object.freeze({ category:'pre-ipo', status:'ipo-registered', aliases:Object.freeze([]) }),
});

const SECURITY_ALIAS_MAP = Object.freeze(Object.fromEntries(
  Object.entries(SECURITY_LISTING_REGISTRY).flatMap(([canonical, record]) =>
    [canonical, ...record.aliases].map(alias => [alias, canonical])
  )
));

const COMMODITY_ALIASES = Object.freeze({
  GOLD:'XAU', SILVER:'XAG', COPPER:'XCU', PLATINUM:'XPT', PALLADIUM:'XPD',
  GC:'XAU', SI:'XAG', HG:'XCU', NG:'NATGAS', CL:'WTI', BZ:'BRENTOIL',
  PL:'XPT', XAL:'ALUMINIUM', WTIOIL:'WTI', PAXG:'XAU', XAUT:'XAU',
});

const INDEX_ALIASES = Object.freeze({
  SP500:'SPX', SPX500:'SPX', US500:'SPX', NAS100:'NDX', NQ100:'NDX',
  NDX100:'NDX', US100:'NDX', JPN225:'JP225', US2000:'RTY', US30:'DJI',
  GER40:'DAX', UK100:'FTSE',
});

const EQUITY_ALIASES = Object.freeze({
  SAMSUNGUSD:'SAMSUNG', SKHYNIXUSD:'SKHYNIX', HYUNDAIUSD:'HYUNDAI',
  BBX:'BB', BRKB:'BRK-B', HK0700:'TENCENT', HK1810:'XIAOMI',
});

// Official venue product classes often call ETFs "stock". Keep this audited
// underlying set synchronized with the browser registry so category:canonical
// remains identical in the Radar, Drawer and venue pages.
export const SECURITY_ETF_UNDERLYINGS = Object.freeze([
  'AGG','ARKK','BINC','BITI','BITO','BOTZ','CIBR','CLOA','CLOI','COPX','DBC','DIA','DGRW',
  'ECH','EEM','EFA','ETHA','EWJ','EWY','EWZ','FAZ','FAS','FGDL','FLHY','FLQL','FSOL','FTGC',
  'FXI','GDX','GLD','GLTR','HYG','IAU','IBB','IBIT','ICLN','IEF','IEMG','IEFA','IGV','IJH',
  'INDA','ITOT','ITA','IVV','IWF','IWM','IWN','JAAA','JEPQ','KWEB','LABD','LABU','LIT','MAGS',
  'NVDL','OIH','PALL','PDBC','PPLT','PSQ','QQQ','QQQI','QQQM','REMX','SCHD','SGOV','SHY','SLV',
  'SMH','SNXX','SOXL','SOXS','SOXX','SPMO','SPY','SPXU','SQQQ','TAN','TIP','TLT','TNA','TQQQ',
  'TZA','UNG','UPRO','URA','URNM','USFR','USO','UVXY','VGT','VNQ','VOO','VTI','VTV','VXUS','XLK',
  'XLE','XLU','XLV','YANG','YINN','EWT','DRAM','KORU','KSTR','LYTE','NCLD','EWH','DFEN','MUU',
]);
const SECURITY_ETF_SET = new Set(SECURITY_ETF_UNDERLYINGS);

export const TOKENIZED_ETF_WRAPPERS = Object.freeze({
  QQQX:'QQQ', SPYX:'SPY', TQQQX:'TQQQ', SLVON:'SLV',
});

// Audited Binance bStock wrapper snapshot (2026-08-07). A trailing B is never
// stripped generically: only wrappers in this exact official snapshot resolve.
const BINANCE_BSTOCK_WRAPPERS = Object.freeze([
  'AAOIB','AAPLB','ALABB','AMATB','AMDB','AMZNB','ARMB','ASMLB','ASTSB','AVGOB','AXTIB','BABAB',
  'BEB','BMNRB','CBRSB','COHRB','COINB','CRCLB','CRDOB','CRWVB','DELLB','DRAMB','EWYB','FLNCB',
  'GLWB','GOOGLB','GSB','HOODB','IBMB','INTCB','INTWB','IRENB','KORUB','LITEB','METAB','MRVLB',
  'MSFTB','MSTRB','MUB','MUUB','MVLLB','NBISB','NFLXB','NOKB','NVDAB','ORCLB','PLTRB','PYPLB',
  'QCOMB','QNTB','QQQB','RKLBB','SKHYB','SMCIB','SMHB','SNDKB','SNXXB','SOXLB','SOXSB','SPCXB',
  'SPYB','TQQQB','TSLAB','TSMB','USARB','WDCB',
]);

export const BINANCE_BSTOCK_UNDERLYING = Object.freeze(Object.fromEntries(
  BINANCE_BSTOCK_WRAPPERS.map(wrapper => [wrapper, wrapper.slice(0, -1)])
));

export function normalizedOfficialType(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

export function categoryFromOfficialSignalType(value) {
  const normalized = normalizedOfficialType(value);
  if (!normalized || OFFICIAL_NON_RWA_TYPES.has(normalized)) return null;
  return OFFICIAL_TYPE_CATEGORIES[normalized] || null;
}

function normalizedCategory(value) {
  return String(value || '').trim().toLowerCase().replace(/^pre[-_]?ipo$/, 'pre-ipo');
}

export function normalizeSignalIdentity(symbol, category, { allowBinanceBstock = false } = {}) {
  let raw = String(symbol || '').trim().toUpperCase();
  let resolvedCategory = normalizedCategory(category);
  if (!/^[A-Z0-9.-]{1,30}$/.test(raw) || !CATEGORY_SET.has(resolvedCategory)) return null;

  if (allowBinanceBstock && BINANCE_BSTOCK_UNDERLYING[raw]) {
    raw = BINANCE_BSTOCK_UNDERLYING[raw];
  }

  if (resolvedCategory === 'commodity') {
    return { symbol: COMMODITY_ALIASES[raw] || raw, category: resolvedCategory };
  }
  if (resolvedCategory === 'index') {
    return { symbol: INDEX_ALIASES[raw] || raw, category: resolvedCategory };
  }
  if (['equity', 'etf', 'pre-ipo'].includes(resolvedCategory)) {
    if (TOKENIZED_ETF_WRAPPERS[raw]) {
      raw = TOKENIZED_ETF_WRAPPERS[raw];
      resolvedCategory = 'etf';
    }
    const lifecycleCanonical = SECURITY_ALIAS_MAP[raw];
    // Lifecycle only refines an already verified security. ETF identity remains
    // venue-authoritative and cannot be overwritten by a same-ticker company.
    if (lifecycleCanonical && ['equity', 'pre-ipo'].includes(resolvedCategory)) {
      resolvedCategory = SECURITY_LISTING_REGISTRY[lifecycleCanonical].category;
      raw = lifecycleCanonical;
    } else {
      raw = EQUITY_ALIASES[raw] || raw;
      if (SECURITY_ETF_SET.has(raw)) resolvedCategory = 'etf';
    }
  }
  return { symbol: raw, category: resolvedCategory };
}

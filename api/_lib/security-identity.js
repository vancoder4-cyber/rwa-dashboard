// Server-side RWA security identity registry.
//
// Venue metadata must admit a listing before this module is called. The
// lifecycle registry may then refine an already verified security, but it must
// never turn a crypto/coin/token category into a security.

const CATEGORY_SET = new Set(['equity', 'etf', 'commodity', 'index', 'fx', 'bond', 'pre-ipo']);

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
  BOND: 'bond',
  BONDS: 'bond',
  FIXEDINCOME: 'bond',
  STOCK: 'equity',
  STOCKS: 'equity',
  EQUITY: 'equity',
  EQUITIES: 'equity',
  HKEQUITY: 'equity',
  KREQUITY: 'equity',
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

// Some official RWA catalogs expose a broad "stock(s)" product class for
// equity indices. Refine only these exact, currently audited underlyings after
// the venue identity gate; never infer an index from a ticker substring.
export const BROAD_STOCK_INDEX_UNDERLYINGS = Object.freeze(['SP500', 'NDX100', 'KR200']);
const BROAD_STOCK_INDEX_SET = new Set(BROAD_STOCK_INDEX_UNDERLYINGS);

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
  'SHLD','SMH','SNXX','SOXL','SOXS','SOXX','SPMO','SPY','SPXU','SPYX','SQQQ','TAN','TIP','TLT','TMF','TNA','TQQQ',
  'TZA','UNG','UPRO','URA','URNM','USFR','USO','UVXY','VGT','VNQ','VOO','VTI','VTV','VXUS','XLK',
  'XBI','XLE','XLU','XLV','YANG','YINN','EWT','DRAM','KORU','KSTR','LYTE','NCLD','EWH','DFEN','MUU',
]);
const SECURITY_ETF_SET = new Set(SECURITY_ETF_UNDERLYINGS);

export const TOKENIZED_ETF_WRAPPERS = Object.freeze({
  QQQX:'QQQ', SPYX:'SPY', TQQQX:'TQQQ', SLVON:'SLV',
});

// Gate Spot does not publish an asset-class field. These exact wrappers were
// reviewed against independent official tokenized-security catalogs. New Gate
// suffix lookalikes are discovery candidates only until the monitor records
// equivalent official identity evidence; they must not enter market data by
// ticker shape alone.
export const GATE_SPOT_VERIFIED_WRAPPERS = Object.freeze([
  'SPCXX','CRCLX','HOODON','SLVON','NVDAX','COINON','ACNON','PLTRON','SPYX','MSFTON',
  'AMDON','TSLAON','AMZNON','SKHYON','TSLAX','CRCLON','SPCXON','MSTRON','METAON','SPYON',
  'GOOGLX','AAPLON','AVGOON','QQQON','MSTRX','COINX','GOOGLON','BABAON','IAUON','IEFAON',
  'NFLXON','AGGON','CSCOON','JPMON','UNHON','LLYON','AAPLX','PEPON','NVDAON','MCDON',
  'CVXON','HOODX','LMTON','SBUXON','ABTON','NFLXX','AVGOX','TQQQX','TLTON','CSCOX',
  'CRWDX','ABBVX','AMZNX','METAX','CMCSAX','SBETON','DFDVX','BTGOON',
]);

// Gate Spot has no product-class metadata. Keep the 2026-08-14 legacy
// commodity review scoped to exact live pair/base/quote tuples, never to a
// bare metal ticker or a generic quote family.
export const GATE_SPOT_EXACT_LEGACY_PAIRS = Object.freeze({
  PAXG_USDT: Object.freeze({ base:'PAXG', quote:'USDT', underlying:'XAU', category:'commodity' }),
  XAUT_USDT: Object.freeze({ base:'XAUT', quote:'USDT', underlying:'XAU', category:'commodity' }),
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

export function normalizeSignalIdentity(symbol, category, { allowBinanceBstock = false, venue = '' } = {}) {
  let raw = String(symbol || '').trim().toUpperCase();
  let resolvedCategory = normalizedCategory(category);
  if (!/^[A-Z0-9.-]{1,30}$/.test(raw) || !CATEGORY_SET.has(resolvedCategory)) return null;

  if (allowBinanceBstock && BINANCE_BSTOCK_UNDERLYING[raw]) {
    raw = BINANCE_BSTOCK_UNDERLYING[raw];
  }

  if (String(venue).toLowerCase() === 'tradexyz' && raw === 'SKHX' && resolvedCategory === 'equity') {
    raw = 'SKHYNIX';
  }

  if (resolvedCategory === 'commodity') {
    return { symbol: COMMODITY_ALIASES[raw] || raw, category: resolvedCategory };
  }
  if (resolvedCategory === 'index') {
    return { symbol: INDEX_ALIASES[raw] || raw, category: resolvedCategory };
  }
  if (['equity', 'etf', 'pre-ipo'].includes(resolvedCategory)) {
    // Bitget and OKX broad stock classes include these exact equity indices.
    // A crypto-category lookalike still fails the CATEGORY_SET gate above.
    if (BROAD_STOCK_INDEX_SET.has(raw)) {
      return { symbol:INDEX_ALIASES[raw] || raw, category:'index' };
    }
    // These exact wrapper tickers are verified in Gate's RWA catalog. QQQX
    // and SPYX are also genuine U.S.-listed securities, so never rewrite them
    // without the venue-scoped identity evidence.
    if (String(venue).toLowerCase() === 'gate' && TOKENIZED_ETF_WRAPPERS[raw]) {
      raw = TOKENIZED_ETF_WRAPPERS[raw];
      resolvedCategory = 'etf';
    }
    const lifecycleCanonical = SECURITY_ALIAS_MAP[raw];
    // Lifecycle only refines an already verified security. ETF identity remains
    // venue-authoritative and cannot be overwritten by a same-ticker company.
    if (lifecycleCanonical && ['equity', 'pre-ipo'].includes(resolvedCategory)) {
      resolvedCategory = SECURITY_LISTING_REGISTRY[lifecycleCanonical].category;
      raw = lifecycleCanonical;
    } else if (['equity', 'pre-ipo'].includes(resolvedCategory)) {
      raw = EQUITY_ALIASES[raw] || raw;
      if (SECURITY_ETF_SET.has(raw)) resolvedCategory = 'etf';
    } else if (SECURITY_ETF_SET.has(raw)) {
      resolvedCategory = 'etf';
    }
  }
  return { symbol: raw, category: resolvedCategory };
}

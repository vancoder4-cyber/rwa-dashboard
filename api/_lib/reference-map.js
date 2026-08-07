export const REFERENCE_SYMBOL_MAP = Object.freeze({
  WTI: 'CL=F', BRENTOIL: 'BZ=F', NATGAS: 'NG=F', COFFEE: 'KC=F', COTTON: 'CT=F',
  CORN: 'ZC=F', WHEAT: 'ZW=F', URANIUM: 'URA', SOYBEAN: 'ZS=F', SUGAR: 'SB=F',
  ALUMINIUM: 'ALI=F', COPPER: 'HG=F', OIL: 'CL=F', BRN: 'BZ=F', COP: 'COP',
  XAU: 'GC=F', XAG: 'SI=F', XCU: 'HG=F', XPT: 'PL=F', XPD: 'PA=F',
  PLAT: 'PL=F', TTF: 'TTF=F',
  SPX: '^GSPC', VIX: '^VIX', JP225: '^N225', KR200: '^KS200', KRCOMP: '^KS11',
  DXY: 'DX-Y.NYB', DAX: '^GDAXI', FTSE: '^FTSE', DJI: '^DJI',
  NDX: '^NDX', NQ100: '^NDX', NASDAQ: '^IXIC',
  SAMSUNG: '005930.KS', SMSN: '005930.KS', SKHYNIX: '000660.KS', HYUNDAI: '005380.KS',
  SOFTBANK: '9984.T', KIOXIA: '285A.T', SKHX: '000660.KS',
  MINIMAX: '0100.HK', ZHIPU: '2513.HK', TENCENT: '0700.HK', XIAOMI: '1810.HK',
});

export const FX_REFERENCE_MAP = Object.freeze({
  KRW: { symbol: 'KRW=X', mode: 'divide' },
  JPY: { symbol: 'JPY=X', mode: 'divide' },
  HKD: { symbol: 'HKD=X', mode: 'divide' },
  TWD: { symbol: 'TWD=X', mode: 'divide' },
  CNY: { symbol: 'CNY=X', mode: 'divide' },
  CAD: { symbol: 'CAD=X', mode: 'divide' },
  EUR: { symbol: 'EURUSD=X', mode: 'multiply' },
  GBP: { symbol: 'GBPUSD=X', mode: 'multiply' },
  GBp: { symbol: 'GBPUSD=X', mode: 'pence-multiply' },
});

export function yahooSymbolFor(canonical) {
  const symbol = String(canonical || '').trim().toUpperCase();
  return REFERENCE_SYMBOL_MAP[symbol] || symbol;
}

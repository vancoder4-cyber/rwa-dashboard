// Short-cache Nasdaq public quotes for indicative cross-market price spreads.
// Activity/ranking remains in tradfi-activity.js because its full-universe
// Nasdaq/OCC downloads should not run at quote frequency.

import {
  fetchJsonWithPolicy,
  mapWithConcurrency,
  setPublicCache,
} from './_lib/upstream.js';

const NASDAQ_INFO = 'https://api.nasdaq.com/api/quote';
const MAX_SYMBOLS = 30;
const SOURCE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (compatible; Avenir-RWA-Analyst/1.0)',
  Origin: 'https://www.nasdaq.com',
  Referer: 'https://www.nasdaq.com/',
};

function asNumber(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[$,%\s]/g, '').replace(/,/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchQuote(symbol, preferredAssetClass) {
  const attempts = preferredAssetClass === 'etf' ? ['etf', 'stocks'] : ['stocks', 'etf'];
  for (const assetClass of attempts) {
    try {
      const payload = await fetchJsonWithPolicy(
        `${NASDAQ_INFO}/${encodeURIComponent(symbol)}/info?assetclass=${assetClass}`,
        { headers:SOURCE_HEADERS },
        { timeoutMs:10000, retries:1 },
      );
      const data = payload?.data;
      if (!data?.companyName) continue;
      const actualAssetClass = String(data.assetClass || '').toUpperCase();
      if (!['STOCKS', 'ETF'].includes(actualAssetClass)) continue;
      const primary = data.primaryData || {};
      const secondary = data.secondaryData || {};
      const primaryPrice = asNumber(primary.lastSalePrice);
      const secondaryPrice = asNumber(secondary.lastSalePrice);
      const usePrimary = primaryPrice > 0;
      const chosen = usePrimary ? primary : secondary;
      const price = usePrimary ? primaryPrice : secondaryPrice;
      if (!(price > 0)) continue;
      const bid = asNumber(chosen.bidPrice);
      const ask = asNumber(chosen.askPrice);
      const hasBook = bid > 0 && ask > 0 && ask >= bid;
      return {
        symbol,
        companyName:data.companyName,
        assetClass:actualAssetClass,
        stockType:data.stockType || null,
        price,
        bid:hasBook ? bid : null,
        ask:hasBook ? ask : null,
        currency:'USD',
        unit:'share',
        priceSource:usePrimary ? 'primaryData' : 'secondaryData',
        asOf:chosen.lastTradeTimestamp || null,
        marketStatus:data.marketStatus || null,
        isRealTime:chosen.isRealTime === true,
        status:usePrimary ? 'full' : 'partial',
      };
    } catch (error) {
      // Try the alternate official asset class before returning unavailable.
    }
  }
  return { symbol, status:'unavailable' };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error:'Method not allowed' });
  }
  const queryKeys = Object.keys(req.query || {});
  if (queryKeys.some(key => !['symbols', 'etfs'].includes(key))) {
    return res.status(400).json({ error:'Unsupported query parameter' });
  }
  const symbols = [...new Set(String(req.query.symbols || '')
    .split(',')
    .map(symbol => symbol.trim().toUpperCase())
    .filter(symbol => /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)))]
    .slice(0, MAX_SYMBOLS);
  if (!symbols.length) return res.status(400).json({ error:'No valid symbols' });

  const etfs = new Set(String(req.query.etfs || '')
    .split(',')
    .map(symbol => symbol.trim().toUpperCase())
    .filter(symbol => symbols.includes(symbol)));
  const rows = await mapWithConcurrency(
    symbols,
    6,
    symbol => fetchQuote(symbol, etfs.has(symbol) ? 'etf' : 'stocks'),
  );
  setPublicCache(res, 60, 120);
  return res.status(200).json({
    generatedAt:new Date().toISOString(),
    source:{
      name:'Nasdaq Quote Info',
      url:'https://www.nasdaq.com/market-activity',
      latency:'Official public display; may be delayed or outside regular session',
    },
    rows,
  });
}

export const config = { maxDuration:30 };

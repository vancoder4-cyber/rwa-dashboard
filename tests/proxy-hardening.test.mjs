import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import binancePublicHandler, {
  completedUtcDayWindow,
  normalizeBinanceOpenInterestRow,
  normalizeBinanceDailyCandles,
  normalizeBinanceTopTraderPositionRow,
  selectBinanceRwaContractCatalog,
  selectBinanceKlineSymbols,
} from '../api/binance-public.js';
import {
  normalizeBinanceOiProxySnapshot,
  normalizeBinanceTopTraderProxySnapshot,
} from '../api/signal-snapshot.js';
import {
  normalizeBinanceSpotTickerCoverage,
  selectBinanceSpotRwaCatalog,
} from '../api/_lib/binance-spot.js';
import hyperliquidKlinesHandler, {
  completedUtcHourWindow,
  normalizeHyperliquidHourlyCandles,
  selectTradeXyzKlineSymbols,
} from '../api/hyperliquid-klines.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const FIXED_NOW = Date.UTC(2026, 7, 8, 12, 34, 56);

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    send(body) { this.body = body; return this; },
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
    async text() { return JSON.stringify(payload); },
  };
}

async function withFetchStub(stub, operation) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function binanceContract(symbol, baseAsset, overrides = {}) {
  return {
    symbol,
    baseAsset,
    status:'TRADING',
    contractType:'TRADIFI_PERPETUAL',
    ...overrides,
  };
}

function binanceTicker(symbol, quoteVolume) {
  return { symbol, quoteVolume:String(quoteVolume) };
}

function binancePositioningCatalog() {
  return { symbols:[
    binanceContract('AAPLUSDT', 'AAPL', { underlyingType:'EQUITY' }),
    binanceContract('QQQUSDT', 'QQQ', { underlyingType:'EQUITY' }),
    binanceContract('PAXGUSDT', 'PAXG', { contractType:'PERPETUAL', underlyingType:'COIN' }),
    binanceContract('XAUTUSDT', 'XAUT', { contractType:'PERPETUAL', underlyingType:'COIN' }),
    binanceContract('BTCUSDT', 'BTC', { contractType:'PERPETUAL', underlyingType:'COIN' }),
    binanceContract('QNTUSDT', 'QNT', { contractType:'PERPETUAL', underlyingType:'COIN' }),
    binanceContract('OLDUSDT', 'OLD', { status:'BREAK', underlyingType:'EQUITY' }),
  ] };
}

function positioningProxyPayload(snapshotType, {
  instruments = selectBinanceRwaContractCatalog(binancePositioningCatalog()),
  rows,
  generatedAt = new Date(FIXED_NOW).toISOString(),
  status = null,
  upstreamFailures = null,
} = {}) {
  const observedRows = rows || [];
  const missing = instruments.length - observedRows.length;
  return {
    schemaVersion:1,
    snapshotType,
    generatedAt,
    catalogStatus:'full',
    status:status || (missing ? 'partial' : 'full'),
    coverage:{
      expected:instruments.length,
      observed:observedRows.length,
      missing,
      upstreamFailures:upstreamFailures ?? missing,
    },
    instruments,
    rows:observedRows,
  };
}

function binanceSpotInstrument(symbol, baseAsset, quoteAsset = 'USDT', overrides = {}) {
  return {
    symbol,
    baseAsset,
    quoteAsset,
    status:'TRADING',
    isSpotTradingAllowed:true,
    ...overrides,
  };
}

function binanceSpotTicker(symbol, overrides = {}) {
  return {
    symbol,
    lastPrice:'100',
    priceChangePercent:'1.5',
    quoteVolume:'1000000',
    highPrice:'105',
    lowPrice:'95',
    bidPrice:'99.9',
    askPrice:'100.1',
    ...overrides,
  };
}

function binanceCandle(openTime, quoteVolume, closeTime = openTime + DAY_MS - 1) {
  return [openTime, '1', '1', '1', '1', '1', closeTime, quoteVolume];
}

function hyperliquidCandle(openTime, baseVolume, close, closeTime = openTime + HOUR_MS - 1) {
  return { t:openTime, T:closeTime, v:baseVolume, c:close };
}

function tradeXyzSnapshot(entries) {
  return [
    { universe:entries.map(entry => ({ name:entry.symbol, ...(entry.instrument || {}) })) },
    entries.map(entry => ({ dayNtlVlm:String(entry.dayNtlVlm) })),
  ];
}

test('Binance fixed selection uses only active official RWA contracts and ranks quote volume deterministically', () => {
  const exchangeInfo = { symbols:[
    binanceContract('AAPLUSDT', 'AAPL'),
    binanceContract('TSLAUSDT', 'TSLA'),
    binanceContract('XAUTUSDT', 'XAUT', { contractType:'PERPETUAL' }),
    binanceContract('PAXGUSDT', 'PAXG', { contractType:'PERPETUAL', status:'BREAK' }),
    binanceContract('BTCUSDT', 'BTC', { contractType:'PERPETUAL' }),
  ] };
  const tickers = [
    binanceTicker('BTCUSDT', 9_999),
    binanceTicker('AAPLUSDT', 10),
    binanceTicker('TSLAUSDT', 20),
    binanceTicker('XAUTUSDT', 20),
  ];
  assert.deepEqual(
    selectBinanceKlineSymbols(exchangeInfo, tickers),
    ['TSLAUSDT', 'XAUTUSDT', 'AAPLUSDT'],
  );

  const eightyOneContracts = Array.from({ length:81 }, (_, index) =>
    binanceContract(`R${String(index).padStart(3, '0')}USDT`, `R${String(index).padStart(3, '0')}`)
  );
  const eightyOneTickers = eightyOneContracts.map((row, index) => binanceTicker(row.symbol, index));
  const selected = selectBinanceKlineSymbols({ symbols:eightyOneContracts }, eightyOneTickers);
  assert.equal(selected.length, 80);
  assert.equal(selected[0], 'R080USDT');
  assert.ok(!selected.includes('R000USDT'));

  assert.throws(() => selectBinanceKlineSymbols(exchangeInfo, tickers.filter(row => row.symbol !== 'AAPLUSDT')), /coverage/);
  assert.throws(() => selectBinanceKlineSymbols(
    { symbols:[...exchangeInfo.symbols, binanceContract('AAPLUSDT', 'AAPL')] },
    tickers,
  ), /Duplicate/);
  assert.throws(() => selectBinanceKlineSymbols(
    { symbols:[binanceContract('BAD_SYMBOL', 'BAD')] },
    [binanceTicker('BAD_SYMBOL', 1)],
  ), /identity/);
});

test('Binance positioning catalog admits only active official TradFi contracts and exact metal exceptions', () => {
  const catalog = selectBinanceRwaContractCatalog(binancePositioningCatalog());
  assert.deepEqual(catalog.map(row => row.symbol), [
    'AAPLUSDT', 'PAXGUSDT', 'QQQUSDT', 'XAUTUSDT',
  ]);
  assert.equal(catalog.find(row => row.symbol === 'AAPLUSDT').contractType, 'TRADIFI_PERPETUAL');
  assert.equal(catalog.find(row => row.symbol === 'PAXGUSDT').contractType, 'PERPETUAL');
  assert.ok(!catalog.some(row => ['BTCUSDT','QNTUSDT','OLDUSDT'].includes(row.symbol)));
  assert.throws(() => selectBinanceRwaContractCatalog({ symbols:[
    binanceContract('AAPLUSDT', 'AAPL'),
    binanceContract('AAPLUSDT', 'AAPL'),
  ] }), /duplicate/i);
  assert.throws(() => selectBinanceRwaContractCatalog({ symbols:[
    binanceContract('BTCUSDT', 'BTC', { contractType:'PERPETUAL', underlyingType:'COIN' }),
  ] }), /empty/i);
});

test('Binance positioning rows require exact identity, coherent values, and fresh official timestamps', () => {
  assert.deepEqual(
    normalizeBinanceOpenInterestRow('AAPLUSDT', {
      symbol:'AAPLUSDT', openInterest:'123.45', time:FIXED_NOW,
    }, FIXED_NOW),
    { symbol:'AAPLUSDT', openInterest:123.45, observedAt:new Date(FIXED_NOW).toISOString() },
  );
  assert.equal(normalizeBinanceOpenInterestRow('AAPLUSDT', {
    symbol:'BTCUSDT', openInterest:'123.45', time:FIXED_NOW,
  }, FIXED_NOW), null);
  assert.equal(normalizeBinanceOpenInterestRow('AAPLUSDT', {
    symbol:'AAPLUSDT', openInterest:'123.45', time:FIXED_NOW - 10 * 60_000 - 1,
  }, FIXED_NOW), null);
  assert.equal(normalizeBinanceOpenInterestRow('AAPLUSDT', {
    symbol:'AAPLUSDT', openInterest:'123.45', time:FIXED_NOW + 5 * 60_000 + 1,
  }, FIXED_NOW), null);

  const topTrader = normalizeBinanceTopTraderPositionRow('AAPLUSDT', [{
    symbol:'AAPLUSDT', longShortRatio:'1.5', longAccount:'0.6', shortAccount:'0.4', timestamp:FIXED_NOW,
  }], FIXED_NOW);
  assert.deepEqual(topTrader, {
    symbol:'AAPLUSDT', longShortRatio:1.5, longAccount:0.6, shortAccount:0.4, timestamp:FIXED_NOW,
  });
  assert.equal(normalizeBinanceTopTraderPositionRow('AAPLUSDT', [{
    symbol:'BTCUSDT', longShortRatio:'1.5', longAccount:'0.6', shortAccount:'0.4', timestamp:FIXED_NOW,
  }], FIXED_NOW), null);
  assert.equal(normalizeBinanceTopTraderPositionRow('AAPLUSDT', [{
    symbol:'AAPLUSDT', longShortRatio:'9', longAccount:'0.6', shortAccount:'0.4', timestamp:FIXED_NOW,
  }], FIXED_NOW), null);
  assert.equal(normalizeBinanceTopTraderPositionRow('AAPLUSDT', [{
    symbol:'AAPLUSDT', longShortRatio:'1.5', longAccount:'0.6', shortAccount:'0.4',
    timestamp:FIXED_NOW - 3 * 60 * 60_000 - 1,
  }], FIXED_NOW), null);
});

test('Binance fixed spot catalog cross-checks B candidates against active TradFi identity and keeps only exact metal exceptions', () => {
  const spotExchangeInfo = { symbols:[
    binanceSpotInstrument('AAPLBUSDT', 'AAPLB'),
    binanceSpotInstrument('QQQBUSDT', 'QQQB'),
    binanceSpotInstrument('QNTBUSDT', 'QNTB'),
    binanceSpotInstrument('BTCBUSDT', 'BTCB'),
    binanceSpotInstrument('CATBUSDT', 'CATB'),
    binanceSpotInstrument('QNTUSDT', 'QNT'),
    binanceSpotInstrument('PAXGUSDT', 'PAXG'),
    binanceSpotInstrument('XAUTUSDT', 'XAUT'),
    binanceSpotInstrument('币安人生USDT', '币安人生'),
    binanceSpotInstrument('PAXGBTC', 'PAXG', 'BTC'),
    binanceSpotInstrument('OLDPAXGUSDT', 'PAXG', 'USDT', { status:'BREAK' }),
  ] };
  const futuresExchangeInfo = { symbols:[
    binanceContract('AAPLUSDT', 'AAPL', { underlyingType:'EQUITY' }),
    binanceContract('QQQUSDT', 'QQQ', { underlyingType:'EQUITY' }),
    binanceContract('BTCUSDT', 'BTC', { contractType:'PERPETUAL', underlyingType:'COIN' }),
    binanceContract('CATUSDT', 'CAT', { status:'BREAK', underlyingType:'EQUITY' }),
  ] };

  const catalog = selectBinanceSpotRwaCatalog(spotExchangeInfo, futuresExchangeInfo);
  assert.deepEqual(catalog.instruments.map(row => row.symbol), [
    'AAPLBUSDT', 'PAXGUSDT', 'QNTBUSDT', 'QQQBUSDT', 'XAUTUSDT',
  ]);
  assert.equal(catalog.coverage.bStocks, 3);
  assert.equal(catalog.coverage.metals, 2);
  assert.equal(catalog.instruments.find(row => row.symbol === 'QQQBUSDT').category, 'etf');
  assert.match(catalog.instruments.find(row => row.symbol === 'QNTBUSDT').identityEvidence, /^audited-exception:/);
  assert.ok(!catalog.instruments.some(row => ['BTCBUSDT','CATBUSDT','QNTUSDT','PAXGBTC'].includes(row.symbol)));
});

test('Binance spot ticker coverage is Full only when every admitted listing has every required official field', () => {
  const instruments = [
    { symbol:'AAPLBUSDT' },
    { symbol:'PAXGUSDT' },
    { symbol:'QNTBUSDT' },
  ];
  const full = normalizeBinanceSpotTickerCoverage(instruments, [
    binanceSpotTicker('AAPLBUSDT'),
    binanceSpotTicker('PAXGUSDT'),
    binanceSpotTicker('QNTBUSDT'),
    binanceSpotTicker('BTCUSDT'),
  ]);
  assert.equal(full.coverage.status, 'full');
  assert.equal(full.coverage.complete, 3);
  assert.equal(full.tickers.length, 3);

  const partial = normalizeBinanceSpotTickerCoverage(instruments, [
    binanceSpotTicker('AAPLBUSDT'),
    binanceSpotTicker('PAXGUSDT', { bidPrice:'' }),
  ]);
  assert.equal(partial.coverage.status, 'partial');
  assert.deepEqual(partial.coverage.missingSymbols, ['QNTBUSDT']);
  assert.deepEqual(partial.coverage.incompleteSymbols, ['PAXGUSDT']);
  assert.equal(partial.tickers.find(row => row.symbol === 'PAXGUSDT').bidPrice, null);

  const unavailable = normalizeBinanceSpotTickerCoverage(instruments, null);
  assert.equal(unavailable.coverage.status, 'unavailable');
  assert.equal(unavailable.coverage.observed, 0);
});

test('trade.xyz fixed selection joins explicit official RWA categories, excludes crypto/untyped/delisted, and ranks day notional', () => {
  const snapshot = tradeXyzSnapshot([
    { symbol:'xyz:AAPL', dayNtlVlm:10 },
    { symbol:'xyz:GOLD', dayNtlVlm:30 },
    { symbol:'xyz:BTC', dayNtlVlm:9_999 },
    { symbol:'xyz:UNTYPED', dayNtlVlm:8_888 },
    { symbol:'xyz:OLD', dayNtlVlm:7_777, instrument:{ isDelisted:true } },
  ]);
  const categories = [
    ['flx:BTC', 'crypto'],
    ['xyz:AAPL', 'stocks'],
    ['xyz:GOLD', 'commodities'],
    ['xyz:BTC', 'crypto'],
    ['xyz:OLD', 'stocks'],
  ];
  assert.deepEqual(selectTradeXyzKlineSymbols(snapshot, categories), ['xyz:GOLD', 'xyz:AAPL']);

  const eightyOne = Array.from({ length:81 }, (_, index) => ({
    symbol:`xyz:R${String(index).padStart(3, '0')}`,
    dayNtlVlm:index,
  }));
  const selected = selectTradeXyzKlineSymbols(
    tradeXyzSnapshot(eightyOne),
    eightyOne.map(row => [row.symbol, 'stocks']),
  );
  assert.equal(selected.length, 80);
  assert.equal(selected[0], 'xyz:R080');
  assert.ok(!selected.includes('xyz:R000'));

  assert.throws(() => selectTradeXyzKlineSymbols([snapshot[0], []], categories), /catalog/);
  assert.throws(() => selectTradeXyzKlineSymbols(snapshot, []), /perpCategories/);
  const invalidNotional = tradeXyzSnapshot([{ symbol:'xyz:AAPL', dayNtlVlm:'NaN' }]);
  assert.throws(() => selectTradeXyzKlineSymbols(invalidNotional, [['xyz:AAPL', 'stocks']]), /notional/);
});

test('Binance normalization counts unique completed UTC candles with finite non-negative quote volume', () => {
  const window = completedUtcDayWindow(FIXED_NOW);
  const rows = Array.from({ length:30 }, (_, index) =>
    binanceCandle(window.startInclusive + index * DAY_MS, index)
  );
  rows.push(
    binanceCandle(window.startInclusive, 999_999),
    binanceCandle(window.startInclusive - DAY_MS, 999_999),
    binanceCandle(window.endExclusive, 999_999, FIXED_NOW - 1),
    binanceCandle(window.startInclusive + DAY_MS, -1),
    binanceCandle(window.startInclusive + 2 * DAY_MS, 'Infinity'),
    binanceCandle(window.startInclusive + 3 * DAY_MS, ''),
    binanceCandle(window.startInclusive + 4 * DAY_MS, 1, FIXED_NOW + 1),
  );

  assert.deepEqual(normalizeBinanceDailyCandles(rows, FIXED_NOW), {
    volume30d:435, candles:30, observed:30, expected:30, status:'full',
  });
  assert.equal(normalizeBinanceDailyCandles(rows.slice(0, 29), FIXED_NOW).status, 'partial');
  assert.equal(normalizeBinanceDailyCandles([], FIXED_NOW).status, 'unavailable');
});

test('Hyperliquid normalization estimates notional from unique completed valid hourly candles', () => {
  const window = completedUtcHourWindow(FIXED_NOW);
  const rows = Array.from({ length:30 * 24 }, (_, index) =>
    hyperliquidCandle(window.startInclusive + index * HOUR_MS, 2, 10)
  );
  rows.push(
    hyperliquidCandle(window.startInclusive, 999_999, 999_999),
    hyperliquidCandle(window.startInclusive - HOUR_MS, 2, 10),
    hyperliquidCandle(window.endExclusive, 2, 10),
    hyperliquidCandle(window.startInclusive + HOUR_MS, -1, 10),
    hyperliquidCandle(window.startInclusive + 2 * HOUR_MS, 1, 0),
    hyperliquidCandle(window.startInclusive + 3 * HOUR_MS, 'Infinity', 10),
    hyperliquidCandle(window.startInclusive + 4 * HOUR_MS, 1, 'NaN'),
  );

  assert.deepEqual(normalizeHyperliquidHourlyCandles(rows, FIXED_NOW), {
    volume30d:14_400, candles:720, observed:720, expected:720,
    method:'estimated', status:'estimated',
  });
  const partial = normalizeHyperliquidHourlyCandles(rows.slice(0, 719), FIXED_NOW);
  assert.equal(partial.observed, 719);
  assert.equal(partial.method, 'estimated');
  assert.equal(partial.status, 'partial');
});

test('fixed snapshot routes are GET-only and reject every caller-selected symbol/time before any upstream request', async () => {
  const requests = [
    [binancePublicHandler, { method:'POST', query:{ endpoint:'klines' } }, 405],
    [binancePublicHandler, { method:'GET', query:{ endpoint:['klines'] } }, 400],
    [binancePublicHandler, { method:'GET', query:{ endpoint:'klines', symbols:'AAPLUSDT' } }, 400],
    [binancePublicHandler, { method:'GET', query:{ endpoint:'klines', startTime:'1' } }, 400],
    [binancePublicHandler, { method:'GET', query:{ endpoint:'exchangeInfo', symbols:'AAPLUSDT' } }, 400],
    [binancePublicHandler, { method:'GET', query:{ endpoint:'spot-snapshot', symbols:'AAPLBUSDT' } }, 400],
    [binancePublicHandler, { method:'GET', query:{ endpoint:'spot-snapshot', path:'/ticker/24hr' } }, 400],
    [binancePublicHandler, { method:'POST', query:{ endpoint:'oi-snapshot' } }, 405],
    [binancePublicHandler, { method:'GET', query:{ endpoint:'oi-snapshot', symbol:'AAPLUSDT' } }, 400],
    [binancePublicHandler, { method:'GET', query:{ endpoint:'top-trader-snapshot', symbols:'AAPLUSDT' } }, 400],
    [binancePublicHandler, { method:'GET', query:{ endpoint:'top-trader-snapshot', path:'/futures/data/topLongShortPositionRatio' } }, 400],
    [hyperliquidKlinesHandler, { method:'POST', query:{} }, 405],
    [hyperliquidKlinesHandler, { method:'GET', query:{ symbols:'xyz:AAPL' } }, 400],
    [hyperliquidKlinesHandler, { method:'GET', query:{ startTime:'1' } }, 400],
    [hyperliquidKlinesHandler, { method:'GET', query:{ endTime:'2' } }, 400],
  ];

  let fetches = 0;
  await withFetchStub(async () => { fetches += 1; throw new Error('validation must not fetch'); }, async () => {
    for (const [handler, request, status] of requests) {
      const response = responseRecorder();
      await handler(request, response);
      assert.equal(response.statusCode, status);
      assert.equal(response.headers['Vercel-CDN-Cache-Control'], 'no-store');
      if (status === 405) assert.equal(response.headers.Allow, 'GET');
    }
  });
  assert.equal(fetches, 0);
});

test('Binance fixed OI and Top Trader snapshots expose exact full coverage with bounded shared caching', async () => {
  const calls = [];
  const observedAt = Date.now() - 1_000;
  const originalApiKey = process.env.BINANCE_MARKET_DATA_API_KEY;
  delete process.env.BINANCE_MARKET_DATA_API_KEY;
  try {
    await withFetchStub(async (url, options = {}) => {
      const parsed = new URL(String(url));
      calls.push({ parsed, options });
      if (parsed.pathname.endsWith('/exchangeInfo')) return jsonResponse(binancePositioningCatalog());
      const symbol = parsed.searchParams.get('symbol');
      if (parsed.pathname.endsWith('/openInterest')) {
        return jsonResponse({ symbol, openInterest:'123.45', time:observedAt });
      }
      if (parsed.pathname.endsWith('/topLongShortPositionRatio')) {
        assert.equal(options.headers['X-MBX-APIKEY'], undefined,
          'the live public endpoint must work without requiring a Preview API key');
        return jsonResponse([{
          symbol, longShortRatio:'1.5', longAccount:'0.6', shortAccount:'0.4', timestamp:observedAt,
        }]);
      }
      throw new Error(`unexpected ${parsed.href}`);
    }, async () => {
      for (const [endpoint, snapshotType, fresh, swr] of [
        ['oi-snapshot', 'open-interest', 240, 60],
        ['top-trader-snapshot', 'top-trader-position-ratio', 3_300, 300],
      ]) {
        const response = responseRecorder();
        await binancePublicHandler({ method:'GET', query:{ endpoint } }, response);
        assert.equal(response.statusCode, 200);
        assert.equal(response.payload.schemaVersion, 1);
        assert.equal(response.payload.snapshotType, snapshotType);
        assert.equal(response.payload.catalogStatus, 'full');
        assert.equal(response.payload.status, 'full');
        assert.deepEqual(response.payload.coverage, {
          expected:4, observed:4, missing:0, upstreamFailures:0,
        });
        assert.deepEqual(response.payload.instruments.map(row => row.symbol), [
          'AAPLUSDT', 'PAXGUSDT', 'QQQUSDT', 'XAUTUSDT',
        ]);
        assert.deepEqual(response.payload.rows.map(row => row.symbol), [
          'AAPLUSDT', 'PAXGUSDT', 'QQQUSDT', 'XAUTUSDT',
        ]);
        assert.match(response.headers['Vercel-CDN-Cache-Control'], new RegExp(`max-age=${fresh}`));
        assert.match(response.headers['Vercel-CDN-Cache-Control'], new RegExp(`stale-while-revalidate=${swr}`));
      }
    });
  } finally {
    if (originalApiKey === undefined) delete process.env.BINANCE_MARKET_DATA_API_KEY;
    else process.env.BINANCE_MARKET_DATA_API_KEY = originalApiKey;
  }
  const marketCalls = calls.filter(({ parsed }) => !parsed.pathname.endsWith('/exchangeInfo'));
  assert.equal(marketCalls.length, 8);
  assert.ok(marketCalls.every(({ parsed }) =>
    ['AAPLUSDT','PAXGUSDT','QQQUSDT','XAUTUSDT'].includes(parsed.searchParams.get('symbol'))));
  assert.ok(marketCalls.every(({ parsed }) => !['BTCUSDT','QNTUSDT'].includes(parsed.searchParams.get('symbol'))));
});

test('Binance positioning snapshots conserve Partial coverage and fail no-store when every row fails', async () => {
  const observedAt = Date.now() - 1_000;
  const exchangeInfo = { symbols:[
    binanceContract('AAPLUSDT', 'AAPL', { underlyingType:'EQUITY' }),
    binanceContract('PAXGUSDT', 'PAXG', { contractType:'PERPETUAL', underlyingType:'COIN' }),
  ] };
  const run = async ({ endpoint, allFail = false }) => withFetchStub(async url => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/exchangeInfo')) return jsonResponse(exchangeInfo);
    const symbol = parsed.searchParams.get('symbol');
    if (allFail || symbol === 'PAXGUSDT') return jsonResponse({ error:'unavailable' }, 503);
    if (parsed.pathname.endsWith('/openInterest')) {
      return jsonResponse({ symbol, openInterest:'10', time:observedAt });
    }
    return jsonResponse([{
      symbol, longShortRatio:'1', longAccount:'0.5', shortAccount:'0.5', timestamp:observedAt,
    }]);
  }, async () => {
    const response = responseRecorder();
    await binancePublicHandler({ method:'GET', query:{ endpoint } }, response);
    return response;
  });

  const partial = await run({ endpoint:'oi-snapshot' });
  assert.equal(partial.statusCode, 200);
  assert.equal(partial.payload.status, 'partial');
  assert.deepEqual(partial.payload.coverage, {
    expected:2, observed:1, missing:1, upstreamFailures:1,
  });
  assert.deepEqual(partial.payload.rows.map(row => row.symbol), ['AAPLUSDT']);
  assert.match(partial.headers['Vercel-CDN-Cache-Control'], /max-age=60/);
  assert.match(partial.headers['Vercel-CDN-Cache-Control'], /stale-while-revalidate=60/);

  const topPartial = await run({ endpoint:'top-trader-snapshot' });
  assert.equal(topPartial.statusCode, 200);
  assert.equal(topPartial.payload.status, 'partial');
  assert.deepEqual(topPartial.payload.coverage, {
    expected:2, observed:1, missing:1, upstreamFailures:1,
  });
  assert.match(topPartial.headers['Vercel-CDN-Cache-Control'], /max-age=300/);
  assert.match(topPartial.headers['Vercel-CDN-Cache-Control'], /stale-while-revalidate=300/);

  for (const endpoint of ['oi-snapshot','top-trader-snapshot']) {
    const unavailable = await run({ endpoint, allFail:true });
    assert.equal(unavailable.statusCode, 502,
      'an all-row upstream failure must remain explicitly unavailable');
    assert.equal(unavailable.headers['Vercel-CDN-Cache-Control'], 'no-store');
  }
});

test('Signal consumes Binance positioning proxies by exact current-catalog identity and keeps missing rows Unavailable', () => {
  const instruments = selectBinanceRwaContractCatalog({ symbols:[
    binanceContract('AAPLUSDT', 'AAPL', { underlyingType:'EQUITY' }),
    binanceContract('PAXGUSDT', 'PAXG', { contractType:'PERPETUAL', underlyingType:'COIN' }),
  ] });
  const oiPayload = positioningProxyPayload('open-interest', {
    instruments,
    rows:[
      { symbol:'AAPLUSDT', openInterest:10, observedAt:new Date(FIXED_NOW).toISOString() },
      { symbol:'PAXGUSDT', openInterest:20, observedAt:new Date(FIXED_NOW).toISOString() },
    ],
  });
  const oi = normalizeBinanceOiProxySnapshot(oiPayload, [
    { venueSymbol:'AAPLUSDT', priceUsd:200, oiValuationPriceMethod:'mark-price' },
    { venueSymbol:'PAXGUSDT', priceUsd:2_500, oiValuationPriceMethod:'last-price' },
    { venueSymbol:'BTCUSDT', priceUsd:60_000, oiValuationPriceMethod:'mark-price' },
  ], FIXED_NOW);
  assert.deepEqual(oi.get('AAPLUSDT'), {
    openInterestUsd:2_000,
    openInterestMethod:'open-interest-x-mark-price',
    openInterestStatus:'estimated',
  });
  assert.deepEqual(oi.get('PAXGUSDT'), {
    openInterestUsd:50_000,
    openInterestMethod:'open-interest-x-last-price',
    openInterestStatus:'estimated',
  });
  assert.equal(oi.get('BTCUSDT'), null,
    'a listing outside the exact official proxy catalog must never inherit OI');

  const topPayload = positioningProxyPayload('top-trader-position-ratio', {
    instruments,
    rows:[{
      symbol:'AAPLUSDT', longShortRatio:1.5, longAccount:0.6, shortAccount:0.4, timestamp:FIXED_NOW,
    }],
  });
  const positions = normalizeBinanceTopTraderProxySnapshot(
    topPayload,
    ['AAPLUSDT','PAXGUSDT'],
    FIXED_NOW,
  );
  assert.equal(positions.get('AAPLUSDT').status, 'full');
  assert.equal(positions.get('AAPLUSDT').bias, 'bullish');
  assert.equal(positions.get('PAXGUSDT').status, 'unavailable');
  assert.equal(positions.get('PAXGUSDT').reasonCode, 'TOP_TRADER_NOT_OBSERVED');

  const oiAtFreshnessBoundary = structuredClone(oiPayload);
  oiAtFreshnessBoundary.generatedAt = new Date(FIXED_NOW - 15 * 60_000).toISOString();
  oiAtFreshnessBoundary.rows.forEach(row => { row.observedAt = oiAtFreshnessBoundary.generatedAt; });
  assert.equal(normalizeBinanceOiProxySnapshot(
    oiAtFreshnessBoundary,
    [{ venueSymbol:'AAPLUSDT', priceUsd:200, oiValuationPriceMethod:'mark-price' }],
    FIXED_NOW,
  ).get('AAPLUSDT').openInterestUsd, 2_000);
  const staleOiProxy = structuredClone(oiAtFreshnessBoundary);
  staleOiProxy.generatedAt = new Date(FIXED_NOW - 15 * 60_000 - 1).toISOString();
  assert.throws(() => normalizeBinanceOiProxySnapshot(staleOiProxy, [], FIXED_NOW), /proxy/i);

  const topAtFreshnessBoundary = structuredClone(topPayload);
  topAtFreshnessBoundary.generatedAt = new Date(FIXED_NOW - 70 * 60_000).toISOString();
  topAtFreshnessBoundary.rows[0].timestamp = FIXED_NOW - 70 * 60_000;
  assert.equal(normalizeBinanceTopTraderProxySnapshot(
    topAtFreshnessBoundary,
    ['AAPLUSDT'],
    FIXED_NOW,
  ).get('AAPLUSDT').status, 'full');
  const staleTopProxy = structuredClone(topAtFreshnessBoundary);
  staleTopProxy.generatedAt = new Date(FIXED_NOW - 70 * 60_000 - 1).toISOString();
  assert.throws(() => normalizeBinanceTopTraderProxySnapshot(staleTopProxy, [], FIXED_NOW), /proxy/i);

  const duplicateRows = structuredClone(oiPayload);
  duplicateRows.rows.push({ ...duplicateRows.rows[0] });
  duplicateRows.coverage.observed += 1;
  duplicateRows.coverage.missing -= 1;
  assert.throws(() => normalizeBinanceOiProxySnapshot(duplicateRows, [], FIXED_NOW), /coverage|proxy/i);

  const wrongIdentity = structuredClone(oiPayload);
  wrongIdentity.rows[0].symbol = 'BTCUSDT';
  assert.throws(() => normalizeBinanceOiProxySnapshot(wrongIdentity, [], FIXED_NOW), /coverage|proxy/i);

  const cryptoCatalog = structuredClone(oiPayload);
  cryptoCatalog.instruments[0] = {
    symbol:'BTCUSDT', baseAsset:'BTC', contractType:'PERPETUAL', underlyingType:'COIN',
  };
  cryptoCatalog.rows[0].symbol = 'BTCUSDT';
  assert.throws(() => normalizeBinanceOiProxySnapshot(cryptoCatalog, [], FIXED_NOW), /catalog/i);
});

test('Signal uses fixed same-origin Binance positioning snapshots and never calls fapi directly', async () => {
  const source = await readFile(new URL('../api/signal-snapshot.js', import.meta.url), 'utf8');
  assert.match(source, /fetchSameOrigin\(baseUrl, '\/api\/binance-public\?endpoint=oi-snapshot'/);
  assert.match(source, /fetchSameOrigin\([\s\S]*?'\/api\/binance-public\?endpoint=top-trader-snapshot'/);
  assert.doesNotMatch(source, /https:\/\/fapi\.binance\.com|BINANCE_(?:FUTURES|DATA)_BASE/,
    'iad1 Signal code must not reconnect directly to Binance fapi');
  assert.doesNotMatch(source, /binance-public\?endpoint=(?:oi|top-trader)-snapshot[^'"\n]*symbols?=/,
    'the Signal caller cannot select proxy symbols through query parameters');
  assert.match(source, /const triggeredBinanceSymbols = preliminaryOiLiquidation\.rows[\s\S]*?if \(triggeredBinanceSymbols\.length\) \{[\s\S]*?fetchBinanceTopTraderPositionRows/,
    'Top Trader proxy work must run only after preliminary server-side alerts identify exact Binance contracts');
  assert.match(source, /catch \(error\) \{[\s\S]*?Alerts remain valid without optional Binance positioning[\s\S]*?console\.error/,
    'an unavailable Top Trader proxy must preserve alerts with positioning Unavailable');
});

test('browser uses fixed snapshot URLs without caller-selected symbol query parameters', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /fetch\('\/api\/binance-public\?endpoint=klines'\)/);
  assert.match(html, /fetch\('\/api\/hyperliquid-klines'\)/);
  assert.match(html, /fetchSpotResource\('\/api\/binance-public\?endpoint=spot-snapshot', 20000\)/);
  assert.doesNotMatch(html, /\/api\/binance-public\?endpoint=klines[^'"\n]*symbols=/);
  assert.doesNotMatch(html, /fetchBinanceSpotPublic\('\/exchangeInfo'/);
  assert.doesNotMatch(html, /BINANCE_BSTOCK_SNAPSHOT/);
  assert.doesNotMatch(html, /\/api\/hyperliquid-klines\?symbols=/);
});

test('catalog validation failures return 502/no-store before either route starts candle fan-out', async () => {
  const binanceCalls = [];
  await withFetchStub(async url => {
    const parsed = new URL(String(url));
    binanceCalls.push(parsed.pathname);
    if (parsed.pathname.endsWith('/exchangeInfo')) return jsonResponse({ symbols:[] });
    if (parsed.pathname.endsWith('/ticker/24hr')) return jsonResponse([binanceTicker('AAPLUSDT', 1)]);
    throw new Error('candle fan-out must not start');
  }, async () => {
    const response = responseRecorder();
    await binancePublicHandler({ method:'GET', query:{ endpoint:'klines' } }, response);
    assert.equal(response.statusCode, 502);
    assert.equal(response.headers['Vercel-CDN-Cache-Control'], 'no-store');
  });
  assert.equal(binanceCalls.length, 2);
  assert.ok(binanceCalls.every(path => !path.endsWith('/klines')));

  const hyperCalls = [];
  await withFetchStub(async (_url, options) => {
    const body = JSON.parse(options.body);
    hyperCalls.push(body.type);
    if (body.type === 'metaAndAssetCtxs') {
      return jsonResponse(tradeXyzSnapshot([{ symbol:'xyz:AAPL', dayNtlVlm:1 }]));
    }
    if (body.type === 'perpCategories') return jsonResponse([]);
    throw new Error('candle fan-out must not start');
  }, async () => {
    const response = responseRecorder();
    await hyperliquidKlinesHandler({ method:'GET', query:{} }, response);
    assert.equal(response.statusCode, 502);
    assert.equal(response.headers['Vercel-CDN-Cache-Control'], 'no-store');
  });
  assert.deepEqual(hyperCalls.sort(), ['metaAndAssetCtxs', 'perpCategories']);
});

test('Binance fixed spot snapshot fetches only server-selected ticker symbols and exposes explicit catalog/ticker coverage', async () => {
  const calls = [];
  const spotExchangeInfo = { symbols:[
    binanceSpotInstrument('AAPLBUSDT', 'AAPLB'),
    binanceSpotInstrument('PAXGUSDT', 'PAXG'),
    binanceSpotInstrument('BTCBUSDT', 'BTCB'),
  ] };
  const futuresExchangeInfo = { symbols:[
    binanceContract('AAPLUSDT', 'AAPL', { underlyingType:'EQUITY' }),
    binanceContract('BTCUSDT', 'BTC', { contractType:'PERPETUAL', underlyingType:'COIN' }),
  ] };

  await withFetchStub(async url => {
    const parsed = new URL(String(url));
    calls.push(parsed);
    if (parsed.hostname === 'data-api.binance.vision' && parsed.pathname.endsWith('/exchangeInfo')) {
      return jsonResponse(spotExchangeInfo);
    }
    if (parsed.hostname === 'fapi.binance.com' && parsed.pathname.endsWith('/exchangeInfo')) {
      return jsonResponse(futuresExchangeInfo);
    }
    if (parsed.hostname === 'data-api.binance.vision' && parsed.pathname.endsWith('/ticker/24hr')) {
      return jsonResponse([binanceSpotTicker('AAPLBUSDT'), binanceSpotTicker('PAXGUSDT')]);
    }
    throw new Error(`unexpected ${parsed.href}`);
  }, async () => {
    const response = responseRecorder();
    await binancePublicHandler({ method:'GET', query:{ endpoint:'spot-snapshot' } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.catalogStatus, 'full');
    assert.equal(response.payload.tickerStatus, 'full');
    assert.equal(response.payload.catalogCoverage.admittedListings, 2);
    assert.equal(response.payload.tickerCoverage.complete, 2);
    assert.deepEqual(response.payload.instruments.map(row => row.symbol), ['AAPLBUSDT', 'PAXGUSDT']);
    assert.match(response.headers['Vercel-CDN-Cache-Control'], /max-age=60/);
  });

  const tickerCalls = calls.filter(url => url.pathname.endsWith('/ticker/24hr'));
  assert.equal(tickerCalls.length, 1);
  assert.deepEqual(JSON.parse(tickerCalls[0].searchParams.get('symbols')), ['AAPLBUSDT', 'PAXGUSDT']);
  assert.ok(!JSON.parse(tickerCalls[0].searchParams.get('symbols')).includes('BTCBUSDT'));
});

test('Binance spot snapshot keeps the authoritative catalog when ticker coverage is partial and never caches an unavailable ticker batch', async () => {
  const spotExchangeInfo = { symbols:[
    binanceSpotInstrument('AAPLBUSDT', 'AAPLB'),
    binanceSpotInstrument('PAXGUSDT', 'PAXG'),
  ] };
  const futuresExchangeInfo = { symbols:[
    binanceContract('AAPLUSDT', 'AAPL', { underlyingType:'EQUITY' }),
  ] };

  const run = async tickerResponse => withFetchStub(async url => {
    const parsed = new URL(String(url));
    if (parsed.hostname === 'data-api.binance.vision' && parsed.pathname.endsWith('/exchangeInfo')) {
      return jsonResponse(spotExchangeInfo);
    }
    if (parsed.hostname === 'fapi.binance.com' && parsed.pathname.endsWith('/exchangeInfo')) {
      return jsonResponse(futuresExchangeInfo);
    }
    if (parsed.pathname.endsWith('/ticker/24hr')) return tickerResponse;
    throw new Error(`unexpected ${parsed.href}`);
  }, async () => {
    const response = responseRecorder();
    await binancePublicHandler({ method:'GET', query:{ endpoint:'spot-snapshot' } }, response);
    return response;
  });

  const partial = await run(jsonResponse([binanceSpotTicker('AAPLBUSDT')]));
  assert.equal(partial.statusCode, 200);
  assert.equal(partial.payload.catalogStatus, 'full');
  assert.equal(partial.payload.tickerStatus, 'partial');
  assert.deepEqual(partial.payload.tickerCoverage.missingSymbols, ['PAXGUSDT']);
  assert.match(partial.headers['Vercel-CDN-Cache-Control'], /max-age=15/);

  const unavailable = await run(jsonResponse({ error:'rate limited' }, 429));
  assert.equal(unavailable.statusCode, 200);
  assert.equal(unavailable.payload.catalogStatus, 'full');
  assert.equal(unavailable.payload.tickerStatus, 'unavailable');
  assert.equal(unavailable.headers['Vercel-CDN-Cache-Control'], 'no-store');
});

test('Binance spot snapshot fails closed/no-store when either official identity catalog is unavailable', async () => {
  let tickerFetches = 0;
  await withFetchStub(async url => {
    const parsed = new URL(String(url));
    if (parsed.hostname === 'data-api.binance.vision' && parsed.pathname.endsWith('/exchangeInfo')) {
      return jsonResponse({ symbols:[] });
    }
    if (parsed.hostname === 'fapi.binance.com' && parsed.pathname.endsWith('/exchangeInfo')) {
      return jsonResponse({ symbols:[binanceContract('AAPLUSDT', 'AAPL', { underlyingType:'EQUITY' })] });
    }
    if (parsed.pathname.endsWith('/ticker/24hr')) tickerFetches += 1;
    throw new Error(`unexpected ${parsed.href}`);
  }, async () => {
    const response = responseRecorder();
    await binancePublicHandler({ method:'GET', query:{ endpoint:'spot-snapshot' } }, response);
    assert.equal(response.statusCode, 502);
    assert.equal(response.headers['Vercel-CDN-Cache-Control'], 'no-store');
  });
  assert.equal(tickerFetches, 0);
});

test('Binance route discovers one official fixed selection before requesting completed daily history', async () => {
  const calls = [];
  const now = Date.now();
  const window = completedUtcDayWindow(now);
  const exchangeInfo = { symbols:[
    binanceContract('AAPLUSDT', 'AAPL'),
    binanceContract('TSLAUSDT', 'TSLA'),
    binanceContract('BTCUSDT', 'BTC', { contractType:'PERPETUAL' }),
  ] };
  const tickers = [
    binanceTicker('AAPLUSDT', 10),
    binanceTicker('TSLAUSDT', 20),
    binanceTicker('BTCUSDT', 9_999),
  ];
  const candles = Array.from({ length:30 }, (_, index) =>
    binanceCandle(window.startInclusive + index * DAY_MS, 1)
  );

  await withFetchStub(async url => {
    const parsed = new URL(String(url));
    calls.push(parsed);
    if (parsed.pathname.endsWith('/exchangeInfo')) return jsonResponse(exchangeInfo);
    if (parsed.pathname.endsWith('/ticker/24hr')) return jsonResponse(tickers);
    if (parsed.pathname.endsWith('/klines')) return jsonResponse(candles);
    throw new Error(`unexpected ${parsed.pathname}`);
  }, async () => {
    const response = responseRecorder();
    await binancePublicHandler({ method:'GET', query:{ endpoint:'klines' } }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(Object.keys(response.payload), ['AAPLUSDT', 'TSLAUSDT']);
    assert.equal(response.payload.AAPLUSDT.status, 'full');
    assert.equal(response.headers['X-RWA-Selected-Symbols'], '2');
    assert.match(response.headers['Vercel-CDN-Cache-Control'], /max-age=300/);
  });
  const klineCalls = calls.filter(url => url.pathname.endsWith('/klines'));
  assert.deepEqual(klineCalls.map(url => url.searchParams.get('symbol')), ['AAPLUSDT', 'TSLAUSDT']);
  assert.ok(klineCalls.every(url => Number(url.searchParams.get('startTime')) === window.startInclusive));
  assert.ok(klineCalls.every(url => Number(url.searchParams.get('endTime')) === window.endExclusive - 1));
});

test('trade.xyz route discovers a fixed explicit-RWA selection and keeps every v*close result Estimated', async () => {
  const calls = [];
  const now = Date.now();
  const window = completedUtcHourWindow(now);
  const snapshot = tradeXyzSnapshot([
    { symbol:'xyz:AAPL', dayNtlVlm:10 },
    { symbol:'xyz:GOLD', dayNtlVlm:20 },
    { symbol:'xyz:BTC', dayNtlVlm:9_999 },
    { symbol:'xyz:UNKNOWN', dayNtlVlm:8_888 },
  ]);
  const categories = [
    ['xyz:AAPL', 'stocks'],
    ['xyz:GOLD', 'commodities'],
    ['xyz:BTC', 'crypto'],
  ];
  const candles = Array.from({ length:30 * 24 }, (_, index) =>
    hyperliquidCandle(window.startInclusive + index * HOUR_MS, 1, 2)
  );

  await withFetchStub(async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.type === 'metaAndAssetCtxs') return jsonResponse(snapshot);
    if (body.type === 'perpCategories') return jsonResponse(categories);
    if (body.type === 'candleSnapshot') return jsonResponse(candles);
    throw new Error(`unexpected ${body.type}`);
  }, async () => {
    const response = responseRecorder();
    await hyperliquidKlinesHandler({ method:'GET', query:{} }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(Object.keys(response.payload), ['xyz:AAPL', 'xyz:GOLD']);
    assert.equal(response.payload['xyz:AAPL'].method, 'estimated');
    assert.equal(response.payload['xyz:AAPL'].status, 'estimated');
    assert.equal(response.headers['X-RWA-Selected-Symbols'], '2');
    assert.match(response.headers['Vercel-CDN-Cache-Control'], /max-age=300/);
  });
  const historyCalls = calls.filter(body => body.type === 'candleSnapshot');
  assert.deepEqual(historyCalls.map(body => body.req.coin), ['xyz:AAPL', 'xyz:GOLD']);
  assert.ok(historyCalls.every(body => body.req.startTime === window.startInclusive));
  assert.ok(historyCalls.every(body => body.req.endTime === window.endExclusive - 1));
});

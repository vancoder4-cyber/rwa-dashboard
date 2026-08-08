import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import binancePublicHandler, {
  completedUtcDayWindow,
  normalizeBinanceDailyCandles,
  selectBinanceKlineSymbols,
} from '../api/binance-public.js';
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

test('browser uses fixed snapshot URLs without caller-selected symbol query parameters', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /fetch\('\/api\/binance-public\?endpoint=klines'\)/);
  assert.match(html, /fetch\('\/api\/hyperliquid-klines'\)/);
  assert.match(html, /fetch\('\/api\/binance-public\?endpoint=spot-snapshot'/);
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

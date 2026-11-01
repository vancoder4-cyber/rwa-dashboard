import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import bitgetMarketHandler, { config as bitgetMarketConfig } from '../api/bitget-market.js';
import { collectBitgetSpot } from '../api/_lib/listing-sources.js';
import { bitgetMarket } from '../api/_lib/spot-volume-price-anomaly.js';

function responseRecorder() {
  return {
    statusCode:200,
    payload:null,
    headers:{},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok:status >= 200 && status < 300,
    status,
    headers:{ get() { return null; } },
    async json() { return payload; },
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

function instrument(symbol, baseCoin, extras = {}) {
  return {
    symbol,
    category:'SPOT',
    baseCoin,
    quoteCoin:'USDT',
    status:'online',
    isRwa:'NO',
    isReality:'yes',
    symbolType:'stock',
    symbolName:baseCoin,
    launchTime:'1790000000000',
    ...extras,
  };
}

function stockInfo(symbol, code = 'AAPL', extras = {}) {
  return {
    symbol,
    code,
    name:`${code} Inc.`,
    tradingPeriod:['pre_market', 'regular', 'after_hours'],
    weekendTradable:'yes',
    ...extras,
  };
}

function realityTicker(symbol, extras = {}) {
  return {
    symbol,
    lastPrice:'100',
    openPrice24h:'90',
    lowPrice24h:'89',
    highPrice24h:'105',
    ask1Price:'101',
    bid1Price:'99',
    bid1Size:'1',
    ask1Size:'2',
    price24hPcnt:'0.1',
    turnover24h:'999999',
    platformTurnover24h:'600000',
    ts:'1790000000000',
    ...extras,
  };
}

function standardTicker(symbol, extras = {}) {
  return {
    symbol,
    lastPr:'100',
    high24h:'105',
    low24h:'89',
    bidPr:'99',
    askPr:'101',
    change24h:'0.1',
    quoteVolume:'600000',
    ts:'1790000000000',
    ...extras,
  };
}

test('Bitget Spot catalog is a fixed sin1 route with a mandatory field-projected identity response', async () => {
  assert.deepEqual(bitgetMarketConfig, { regions:['sin1'], maxDuration:60 });
  const calls = [];
  await withFetchStub(async url => {
    const value = String(url);
    calls.push(value);
    if (value.endsWith('/api/v3/reality/market/stock-info')) {
      return jsonResponse({ code:'00000', data:[stockInfo('RAAPLUSDT'), stockInfo('REXTRAUSDT', 'EXTRA')] });
    }
    return jsonResponse({ code:'00000', data:[
      instrument('RAAPLUSDT', 'RAAPL', { privateField:'must-not-leak' }),
      instrument('PAXGUSDT', 'PAXG', { isReality:'no' }),
      instrument('REURUSDT', 'REUR', { quoteCoin:'EUR' }),
      instrument('ROFFUSDT', 'ROFF', { status:'offline' }),
    ] });
  }, async () => {
    const response = responseRecorder();
    await bitgetMarketHandler({ method:'GET', query:{ type:'spot-catalog' } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.catalogStatus, 'full');
    assert.deepEqual(response.payload.instruments.map(row => row.symbol), ['RAAPLUSDT', 'PAXGUSDT']);
    assert.equal(response.payload.instruments[0].privateField, undefined);
    assert.deepEqual(response.payload.catalogEvidence, {
      status:'full',
      method:'bitget-reality-stock-info-exact-intersection-v1',
      instrumentsCount:2,
      realityCandidatesCount:1,
      stockInfoCount:2,
      matchedCount:1,
    });
    assert.deepEqual(response.payload.coverage.instruments, { status:'full', observed:2, expected:2 });
    assert.match(response.headers['Vercel-CDN-Cache-Control'], /max-age=120/);
  });
  assert.deepEqual(calls, [
    'https://api.bitget.com/api/v3/market/instruments?category=SPOT',
    'https://api.bitget.com/api/v3/reality/market/stock-info',
  ]);
});

test('Bitget Spot snapshot inner-joins optional market rows to the mandatory catalog', async () => {
  const calls = [];
  await withFetchStub(async url => {
    const value = String(url);
    calls.push(value);
    if (value.endsWith('/api/v3/market/instruments?category=SPOT')) {
      return jsonResponse({ code:'00000', data:[instrument('RAAPLUSDT', 'RAAPL'), instrument('PAXGUSDT', 'PAXG', { isReality:'no' })] });
    }
    if (value.endsWith('/api/v3/reality/market/stock-info')) {
      return jsonResponse({ code:'00000', data:[stockInfo('RAAPLUSDT')] });
    }
    if (value.endsWith('/api/v3/market/tickers?category=SPOT')) {
      return jsonResponse({ code:'00000', data:[realityTicker('RAAPLUSDT'), realityTicker('PAXGUSDT'), realityTicker('BTCUSDT')] });
    }
    if (value.endsWith('/api/v2/spot/market/tickers')) {
      return jsonResponse({ code:'00000', data:[standardTicker('RAAPLUSDT'), standardTicker('PAXGUSDT'), standardTicker('ETHUSDT')] });
    }
    throw new Error(`Unexpected URL ${value}`);
  }, async () => {
    const response = responseRecorder();
    await bitgetMarketHandler({ method:'GET', query:{ type:'spot-snapshot' } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.tickerStatus, 'full');
    assert.deepEqual(response.payload.realityTickers.map(row => row.symbol), ['RAAPLUSDT']);
    assert.deepEqual(response.payload.standardTickers.map(row => row.symbol), ['PAXGUSDT']);
    assert.deepEqual(response.payload.coverage.realityTickers, { status:'full', observed:1, expected:1 });
    assert.deepEqual(response.payload.coverage.standardTickers, { status:'full', observed:1, expected:1 });
    assert.match(response.headers['Vercel-CDN-Cache-Control'], /max-age=30/);
  });
  assert.equal(calls.length, 4);
});

test('Bitget Spot catalog remains usable when both optional ticker feeds fail', async () => {
  await withFetchStub(async url => {
    const value = String(url);
    if (value.endsWith('/api/v3/market/instruments?category=SPOT')) {
      return jsonResponse({ code:'00000', data:[instrument('RAAPLUSDT', 'RAAPL')] });
    }
    if (value.endsWith('/api/v3/reality/market/stock-info')) {
      return jsonResponse({ code:'00000', data:[stockInfo('RAAPLUSDT')] });
    }
    return jsonResponse({ error:'unavailable' }, 503);
  }, async () => {
    const response = responseRecorder();
    await bitgetMarketHandler({ method:'GET', query:{ type:'spot-snapshot' } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.catalogStatus, 'full');
    assert.equal(response.payload.tickerStatus, 'unavailable');
    assert.deepEqual(response.payload.realityTickers, []);
    assert.deepEqual(response.payload.standardTickers, []);
    assert.equal(response.headers['Vercel-CDN-Cache-Control'], 'no-store');
  });
});

test('Bitget route rejects arbitrary upstream selection and fails identity closed', async () => {
  const wrongMethod = responseRecorder();
  await bitgetMarketHandler({ method:'POST', query:{ type:'spot-catalog' } }, wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.headers.Allow, 'GET');
  assert.equal(wrongMethod.headers['Vercel-CDN-Cache-Control'], 'no-store');

  const invalid = responseRecorder();
  await bitgetMarketHandler({ method:'GET', query:{ type:'spot-catalog', symbol:'RAAPLUSDT' } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.headers['Vercel-CDN-Cache-Control'], 'no-store');

  await withFetchStub(async () => jsonResponse({ code:'00000', data:[] }), async () => {
    const unavailable = responseRecorder();
    await bitgetMarketHandler({ method:'GET', query:{ type:'spot-catalog' } }, unavailable);
    assert.equal(unavailable.statusCode, 502);
    assert.equal(unavailable.headers['Vercel-CDN-Cache-Control'], 'no-store');
  });
});

test('Bitget catalog rejects empty or duplicate exact instrument symbols instead of self-reporting Full', async () => {
  const invalidCatalogs = [
    [instrument('', 'RAAPL')],
    [instrument('RAAPLUSDT', 'RAAPL'), instrument('RAAPLUSDT', 'RSECOND')],
    [instrument('RAAPLUSDT', 'RAAPL'), instrument('raaplusdt', 'RSECOND')],
  ];
  for (const data of invalidCatalogs) {
    await withFetchStub(async url => {
      if (String(url).endsWith('/api/v3/reality/market/stock-info')) {
        return jsonResponse({ code:'00000', data:[stockInfo('RAAPLUSDT')] });
      }
      return jsonResponse({ code:'00000', data });
    }, async () => {
      const response = responseRecorder();
      await bitgetMarketHandler({ method:'GET', query:{ type:'spot-catalog' } }, response);
      assert.equal(response.statusCode, 502);
      assert.equal(response.payload.error, 'Bitget Spot identity catalog unavailable');
      assert.equal(response.headers['Vercel-CDN-Cache-Control'], 'no-store');
    });
  }
});

test('Bitget Reality admission fails closed unless every candidate exact-matches unique stock-info', async () => {
  const stockInfoCatalogs = [
    [stockInfo('RMSFTUSDT', 'MSFT')],
    [stockInfo('RAAPLUSDT'), stockInfo('raaplusdt')],
    [stockInfo('', 'AAPL')],
  ];
  for (const data of stockInfoCatalogs) {
    await withFetchStub(async url => {
      const value = String(url);
      if (value.endsWith('/api/v3/market/instruments?category=SPOT')) {
        return jsonResponse({
          code:'00000',
          data:[instrument('RAAPLUSDT', 'RAAPL'), instrument('PAXGUSDT', 'PAXG', { isReality:'no' })],
        });
      }
      if (value.endsWith('/api/v3/reality/market/stock-info')) {
        return jsonResponse({ code:'00000', data });
      }
      throw new Error(`Unexpected URL ${value}`);
    }, async () => {
      const response = responseRecorder();
      await bitgetMarketHandler({ method:'GET', query:{ type:'spot-catalog' } }, response);
      assert.equal(response.statusCode, 502);
      assert.equal(response.payload.error, 'Bitget Spot identity catalog unavailable');
      assert.equal(response.headers['Vercel-CDN-Cache-Control'], 'no-store');
    });
  }
});

test('duplicate optional ticker symbols downgrade only that profile and keep unique coverage bounded', async () => {
  for (const duplicateProfile of ['reality', 'standard']) {
    await withFetchStub(async url => {
      const value = String(url);
      if (value.endsWith('/api/v3/market/instruments?category=SPOT')) {
        return jsonResponse({
          code:'00000',
          data:[
            instrument('RAAPLUSDT', 'RAAPL'),
            instrument('PAXGUSDT', 'PAXG', { isReality:'no' }),
          ],
        });
      }
      if (value.endsWith('/api/v3/reality/market/stock-info')) {
        return jsonResponse({ code:'00000', data:[stockInfo('RAAPLUSDT')] });
      }
      if (value.endsWith('/api/v3/market/tickers?category=SPOT')) {
        const rows = [realityTicker('RAAPLUSDT')];
        if (duplicateProfile === 'reality') rows.push(realityTicker('RAAPLUSDT', { lastPrice:'101' }));
        return jsonResponse({ code:'00000', data:rows });
      }
      if (value.endsWith('/api/v2/spot/market/tickers')) {
        const rows = [standardTicker('PAXGUSDT')];
        if (duplicateProfile === 'standard') rows.push(standardTicker('PAXGUSDT', { lastPr:'101' }));
        return jsonResponse({ code:'00000', data:rows });
      }
      throw new Error(`Unexpected URL ${value}`);
    }, async () => {
      const response = responseRecorder();
      await bitgetMarketHandler({ method:'GET', query:{ type:'spot-snapshot' } }, response);
      assert.equal(response.statusCode, 200);
      assert.equal(response.payload.catalogStatus, 'full');
      assert.equal(response.payload.tickerStatus, 'partial');
      const duplicateCoverage = response.payload.coverage[`${duplicateProfile}Tickers`];
      assert.deepEqual(duplicateCoverage, { status:'unavailable', observed:0, expected:1 });
      for (const coverage of [response.payload.coverage.realityTickers, response.payload.coverage.standardTickers]) {
        assert.ok(coverage.observed <= coverage.expected);
      }
      assert.match(response.headers['Vercel-CDN-Cache-Control'], /max-age=15/);
    });
  }
});

test('Spot anomaly consumes the same-origin Bitget snapshot and preserves platform turnover units', async () => {
  const calls = [];
  await withFetchStub(async url => {
    calls.push(String(url));
    return jsonResponse({
      schemaVersion:1,
      catalogStatus:'full',
      realityTickers:[realityTicker('RAAPLUSDT')],
      standardTickers:[standardTicker('PAXGUSDT')],
    });
  }, async () => {
    const rows = await bitgetMarket('https://preview.example', [
      { venueSymbol:'RAAPLUSDT', marketDataProfile:'bitget-reality' },
      { venueSymbol:'PAXGUSDT', marketDataProfile:'bitget-standard' },
    ], Date.now() + 5_000);
    assert.equal(rows.get('RAAPLUSDT').currentVolumeUsd, 600000);
    assert.equal(rows.get('RAAPLUSDT').volumeMethod, 'official-platform-rolling24h-turnover');
    assert.equal(rows.get('RAAPLUSDT').bidPriceUsd, 99);
    assert.equal(rows.get('PAXGUSDT').currentVolumeUsd, 600000);
  });
  assert.deepEqual(calls, ['https://preview.example/api/bitget-market?type=spot-snapshot']);
});

test('Listing consumes only the identity catalog and preserves its existing exact-listing contract', async () => {
  const instruments = [
    ...Array.from({ length:20 }, (_, index) =>
      instrument(`RTEST${index}USDT`, `RTEST${index}`)),
    instrument('PAXGUSDT', 'PAXG', { isReality:'no', symbolType:'metal' }),
  ];
  const calls = [];
  await withFetchStub(async url => {
    calls.push(String(url));
    return jsonResponse({
      schemaVersion:1,
      catalogStatus:'full',
      tickerStatus:'unavailable',
      instruments,
      catalogEvidence:{
        status:'full',
        method:'bitget-reality-stock-info-exact-intersection-v1',
        instrumentsCount:21,
        realityCandidatesCount:20,
        stockInfoCount:20,
        matchedCount:20,
      },
      realityTickers:[],
      standardTickers:[],
      coverage:{ instruments:{ status:'full', observed:21, expected:21 } },
    });
  }, async () => {
    const collection = await collectBitgetSpot('https://preview.example');
    const rows = collection.listings;
    assert.equal(rows.length, 21);
    assert.deepEqual(collection.catalogEvidence, {
      status:'full',
      method:'bitget-reality-stock-info-exact-intersection-v1',
      instrumentsCount:21,
      realityCandidatesCount:20,
      stockInfoCount:20,
      matchedCount:20,
      admittedCount:21,
      admittedRealityCount:20,
      legacyCount:1,
    });
    assert.deepEqual(rows[0], {
      market:'spot',
      venue:'bitget',
      venueSymbol:'RTEST0USDT',
      canonicalSymbol:'TEST0',
      category:'equity',
      venueCategory:'equity',
      lifecycleStatus:null,
      name:'RTEST0',
      identityStatus:'verified',
      identityEvidence:'Bitget isReality=yes; symbolType=stock',
      marketDataProfile:'bitget-reality',
    });
  });
  assert.deepEqual(calls, ['https://preview.example/api/bitget-market?type=spot-catalog']);
});

test('Listing rejects proxy-declared cross-verification evidence that is missing or inconsistent', async () => {
  const instruments = Array.from({ length:20 }, (_, index) =>
    instrument(`RTEST${index}USDT`, `RTEST${index}`));
  const validEvidence = {
    status:'full',
    method:'bitget-reality-stock-info-exact-intersection-v1',
    instrumentsCount:20,
    realityCandidatesCount:20,
    stockInfoCount:20,
    matchedCount:20,
  };
  for (const catalogEvidence of [
    undefined,
    { ...validEvidence, status:'partial' },
    { ...validEvidence, method:'untrusted' },
    { ...validEvidence, instrumentsCount:19 },
    { ...validEvidence, matchedCount:19 },
    { ...validEvidence, stockInfoCount:19 },
  ]) {
    await withFetchStub(async () => jsonResponse({
      schemaVersion:1,
      catalogStatus:'full',
      instruments,
      catalogEvidence,
      coverage:{ instruments:{ status:'full', observed:20, expected:20 } },
    }), async () => {
      await assert.rejects(
        collectBitgetSpot('https://preview.example'),
        /Bitget Reality cross-verification evidence unavailable/,
      );
    });
  }
});

test('Listing, Spot anomaly and browser use fixed Bitget routes without direct catalog/ticker discovery', async () => {
  const [listingSources, anomaly, html] = await Promise.all([
    readFile(new URL('../api/_lib/listing-sources.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/_lib/spot-volume-price-anomaly.js', import.meta.url), 'utf8'),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
  ]);
  assert.match(listingSources, /fetchSameOrigin\(baseUrl, '\/api\/bitget-market\?type=spot-catalog'/);
  assert.match(anomaly, /fetchSameOrigin\(baseUrl, '\/api\/bitget-market\?type=spot-snapshot'/);
  assert.match(html, /fetchSpotResource\('\/api\/bitget-market\?type=spot-snapshot', 20000\)/);
  assert.match(html, /const bitgetSnapshotPromise = fetchBitgetSpotSnapshot\(\)/);
  assert.doesNotMatch(html, /fetchSpotResource\(`\$\{BITGET_SPOT_BASE\}\/api\/v3\/market\/(?:instruments|tickers)/);
  assert.doesNotMatch(html, /fetchSpotResource\(`\$\{BITGET_SPOT_BASE\}\/api\/v2\/spot\/market\/tickers/);
});

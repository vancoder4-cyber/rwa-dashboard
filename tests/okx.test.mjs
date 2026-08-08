import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  canonicalOkxPerpSymbol,
  canonicalOkxSpotSymbol,
  isOkxRwaPerpInstrument,
  isOkxRwaSpotInstrument,
} from '../api/_lib/okx.js';
import fundingHistoryHandler, { normalizeHistoryRows } from '../api/funding-history.js';
import okxMarketHandler, { normalizeOkxVolumeCandles } from '../api/okx-market.js';

const LIVE_SWAP = Object.freeze({
  instType: 'SWAP', instId: 'AAPL-USDT-SWAP', uly: 'AAPL-USDT',
  ctValCcy: 'AAPL', state: 'live', ruleType: 'normal', instCategory: '3',
  settleCcy: 'USDT',
});
const LIVE_XPERP = Object.freeze({
  instType: 'FUTURES', instId: 'AAPL-USD_UM_XPERP-310613',
  instFamily: 'AAPL-USD_UM_XPERP', ctValCcy: 'AAPL', state: 'live',
  ruleType: 'xperp', instCategory: '3', settleCcy: 'USD',
});
const CRYPTO_SWAP = Object.freeze({
  instType: 'SWAP', instId: 'BTC-USDT-SWAP', uly: 'BTC-USDT',
  ctValCcy: 'BTC', state: 'live', ruleType: 'normal', instCategory: '1',
});
const ORDINARY_FUTURE = Object.freeze({
  instType: 'FUTURES', instId: 'BTC-USDT-260925', ctValCcy: 'BTC',
  state: 'live', ruleType: 'normal', instCategory: '3',
});
const EXPIRED_XPERP = Object.freeze({
  instType: 'FUTURES', instId: 'TSLA-USD_UM_XPERP-250101', ctValCcy: 'TSLA',
  state: 'suspend', ruleType: 'xperp', instCategory: '3',
});

const XAAPL_SPOT = Object.freeze({
  instType: 'SPOT', instId: 'XAAPL-USDT', baseCcy: 'XAAPL', quoteCcy: 'USDT',
  state: 'live', instCategory: '3',
});
const XXOM_SPOT = Object.freeze({
  instType: 'SPOT', instId: 'XXOM-USDT', baseCcy: 'XXOM', quoteCcy: 'USDT',
  state: 'live', instCategory: '3',
});
const GOLD_SPOTS = Object.freeze([
  Object.freeze({ instType:'SPOT', instId:'PAXG-USD', baseCcy:'PAXG', quoteCcy:'USD', state:'live', instCategory:'1' }),
  Object.freeze({ instType:'SPOT', instId:'PAXG-USDT', baseCcy:'PAXG', quoteCcy:'USDT', state:'live', instCategory:'1' }),
  Object.freeze({ instType:'SPOT', instId:'XAUT-USDT', baseCcy:'XAUT', quoteCcy:'USDT', state:'live', instCategory:'1' }),
]);

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get() { return null; } },
    async json() { return payload; },
  };
}

function okxEnvelope(data) {
  return jsonResponse({ code: '0', msg: '', data });
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

function marketFixture(url) {
  const parsed = new URL(url);
  const path = parsed.pathname.replace('/api/v5', '');
  const instType = parsed.searchParams.get('instType');
  if (path === '/public/instruments' && instType === 'SWAP') {
    return okxEnvelope([LIVE_SWAP, CRYPTO_SWAP]);
  }
  if (path === '/public/instruments' && instType === 'FUTURES') {
    return okxEnvelope([LIVE_XPERP, ORDINARY_FUTURE, EXPIRED_XPERP]);
  }
  const admitted = instType === 'SWAP' ? [LIVE_SWAP] : [LIVE_XPERP];
  if (path === '/market/tickers') {
    return okxEnvelope(admitted.map(row => ({ instType:row.instType, instId:row.instId, last:'100', vol24h:'5', volCcy24h:'500', ts:'1' })));
  }
  if (path === '/public/mark-price') {
    return okxEnvelope(admitted.map(row => ({ instType:row.instType, instId:row.instId, markPx:'100', ts:'1' })));
  }
  if (path === '/public/open-interest') {
    return okxEnvelope(admitted.map(row => ({ instType:row.instType, instId:row.instId, oi:'10', oiCcy:'10', oiUsd:'1000', ts:'1' })));
  }
  if (path === '/public/funding-rate' && parsed.searchParams.get('instId') === 'ANY') {
    return okxEnvelope([
      { instType:'SWAP', instId:LIVE_SWAP.instId, fundingRate:'0', fundingTime:'10', nextFundingTime:'20', prevFundingTime:'0', settFundingRate:'0.0001', ts:'1' },
      { instType:'FUTURES', instId:LIVE_XPERP.instId, fundingRate:'0.0002', fundingTime:'10', nextFundingTime:'20', prevFundingTime:'0', ts:'1' },
      { instType:'SWAP', instId:CRYPTO_SWAP.instId, fundingRate:'0.5', fundingTime:'10', nextFundingTime:'20', ts:'1' },
      { instType:'FUTURES', instId:EXPIRED_XPERP.instId, fundingRate:'0.5', fundingTime:'10', nextFundingTime:'20', ts:'1' },
    ]);
  }
  throw new Error(`Unexpected URL ${url}`);
}

test('OKX official category gate excludes crypto, blank categories, ordinary futures, and expired X-Perps', () => {
  assert.equal(isOkxRwaPerpInstrument(LIVE_SWAP), true);
  assert.equal(isOkxRwaPerpInstrument(LIVE_XPERP), true);
  assert.equal(canonicalOkxPerpSymbol(LIVE_XPERP), 'AAPL');
  assert.equal(isOkxRwaPerpInstrument(CRYPTO_SWAP), false);
  assert.equal(isOkxRwaPerpInstrument({ ...LIVE_SWAP, instCategory:'' }), false);
  assert.equal(isOkxRwaPerpInstrument({ ...LIVE_SWAP, instCategory:'6' }), true);
  assert.equal(isOkxRwaPerpInstrument(ORDINARY_FUTURE), false);
  assert.equal(isOkxRwaPerpInstrument(EXPIRED_XPERP), false);
});

test('OKX spot strips exactly one X after category gate and admits only exact gold exceptions', () => {
  assert.equal(canonicalOkxSpotSymbol(XAAPL_SPOT), 'AAPL');
  assert.equal(canonicalOkxSpotSymbol(XXOM_SPOT), 'XOM');
  assert.equal(isOkxRwaSpotInstrument({ ...XAAPL_SPOT, instCategory:'1' }), false);
  assert.equal(isOkxRwaSpotInstrument({ ...XAAPL_SPOT, quoteCcy:'USDC', instId:'XAAPL-USDC' }), false);
  assert.equal(isOkxRwaSpotInstrument({ ...XAAPL_SPOT, baseCcy:'AAPL', instId:'AAPL-USDT' }), false);
  assert.deepEqual(GOLD_SPOTS.map(canonicalOkxSpotSymbol), ['PAXG', 'PAXG', 'XAUT']);
  assert.equal(isOkxRwaSpotInstrument({ ...GOLD_SPOTS[0], instId:'BTC-USD', baseCcy:'BTC' }), false);
  assert.equal(isOkxRwaSpotInstrument({ ...GOLD_SPOTS[0], instCategory:'3' }), false);
});

test('OKX perp snapshot inner-joins live official instruments and preserves real zero funding', async () => {
  const calls = [];
  await withFetchStub(async url => {
    calls.push(String(url));
    return marketFixture(String(url));
  }, async () => {
    const response = responseRecorder();
    await okxMarketHandler({ method:'GET', query:{ type:'perp-snapshot' } }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload.instruments.map(row => row.instId), [LIVE_XPERP.instId, LIVE_SWAP.instId]);
    assert.ok(response.payload.instruments.some(row => row.instId.includes('_XPERP-')));
    assert.equal(response.payload.tickers.length, 2);
    assert.equal(response.payload.marks.length, 2);
    assert.equal(response.payload.openInterest.length, 2);
    assert.equal(response.payload.funding.find(row => row.instId === LIVE_SWAP.instId).fundingRate, '0');
    assert.equal(response.payload.funding.find(row => row.instId === LIVE_SWAP.instId).prevFundingTime, '0');
    assert.equal(response.payload.coverage.status, 'full');
    assert.match(response.headers['Vercel-CDN-Cache-Control'], /max-age=30/);
  });
  assert.equal(calls.filter(url => new URL(url).pathname.endsWith('/funding-rate')).length, 1);
  assert.equal(new URL(calls.find(url => new URL(url).pathname.endsWith('/funding-rate'))).searchParams.get('instId'), 'ANY');
});

test('OKX spot snapshot filters category collisions and retains UTS and exact gold listings', async () => {
  const spotCatalog = [
    XAAPL_SPOT,
    XXOM_SPOT,
    ...GOLD_SPOTS,
    { instType:'SPOT', instId:'BTC-USDT', baseCcy:'BTC', quoteCcy:'USDT', state:'live', instCategory:'1' },
    { instType:'SPOT', instId:'AAPL-USDT', baseCcy:'AAPL', quoteCcy:'USDT', state:'live', instCategory:'3' },
  ];
  await withFetchStub(async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/public/instruments')) return okxEnvelope(spotCatalog);
    if (parsed.pathname.endsWith('/market/tickers')) {
      return okxEnvelope(spotCatalog.map(row => ({ instType:'SPOT', instId:row.instId, last:'100', volCcy24h:'1000', ts:'1' })));
    }
    throw new Error(`Unexpected URL ${url}`);
  }, async () => {
    const response = responseRecorder();
    await okxMarketHandler({ method:'GET', query:{ type:'spot-snapshot' } }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      response.payload.instruments.map(row => row.instId),
      ['PAXG-USD', 'PAXG-USDT', 'XAAPL-USDT', 'XAUT-USDT', 'XXOM-USDT'],
    );
    assert.deepEqual(
      response.payload.instruments.map(row => row.canonicalSymbol),
      ['PAXG', 'PAXG', 'AAPL', 'XAUT', 'XOM'],
    );
    assert.equal(response.payload.tickers.length, 5);
    assert.equal(response.payload.coverage.status, 'full');
  });
});

test('OKX 30-day volume uses the latest 30 confirmed UTC candles and quote-volume index 7', async () => {
  const day = 86_400_000;
  const complete = Array.from({ length:31 }, (_, index) => [
    String((index + 1) * day), '1', '1', '1', '1', '999999', '888888', String(index + 1), '1',
  ]).reverse();
  const currentIncomplete = [String(32 * day), '1', '1', '1', '1', '1', '1', '999999', '0'];
  const normalized = normalizeOkxVolumeCandles([currentIncomplete, ...complete]);
  assert.deepEqual(normalized, { volume30d: 495, status:'full', observed:30, expected:30 });

  let candleUrl;
  await withFetchStub(async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/public/instruments')) {
      return okxEnvelope(parsed.searchParams.get('instType') === 'SWAP' ? [LIVE_SWAP] : []);
    }
    if (parsed.pathname.endsWith('/market/history-candles')) {
      candleUrl = parsed;
      return okxEnvelope([currentIncomplete, ...complete]);
    }
    throw new Error(`Unexpected URL ${url}`);
  }, async () => {
    const response = responseRecorder();
    await okxMarketHandler({ method:'GET', query:{ type:'volume30d', symbols:LIVE_SWAP.instId } }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload[LIVE_SWAP.instId], normalized);
  });
  assert.equal(candleUrl.searchParams.get('bar'), '1Dutc');
  assert.equal(candleUrl.searchParams.get('limit'), '31');
});

test('OKX market route rejects open-proxy parameters and non-catalog volume symbols with no-store', async () => {
  let fetchCount = 0;
  await withFetchStub(async url => {
    fetchCount += 1;
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/public/instruments')) {
      return okxEnvelope(parsed.searchParams.get('instType') === 'SWAP' ? [LIVE_SWAP] : []);
    }
    throw new Error(`Unexpected URL ${url}`);
  }, async () => {
    const openProxyResponse = responseRecorder();
    await okxMarketHandler({ method:'GET', query:{ type:'perp-snapshot', url:'https://example.com' } }, openProxyResponse);
    assert.equal(openProxyResponse.statusCode, 400);
    assert.equal(openProxyResponse.headers['Cache-Control'], 'private, no-store, max-age=0');
    assert.equal(fetchCount, 0);

    const unverifiedResponse = responseRecorder();
    await okxMarketHandler({ method:'GET', query:{ type:'volume30d', symbols:'BTC-USDT-SWAP' } }, unverifiedResponse);
    assert.equal(unverifiedResponse.statusCode, 400);
    assert.match(unverifiedResponse.payload.error, /current OKX RWA catalog/);
    assert.equal(unverifiedResponse.headers['Cache-Control'], 'private, no-store, max-age=0');
  });
  assert.equal(fetchCount, 2, 'only SWAP and FUTURES catalogs may be fetched before rejection');
});

test('OKX funding history prefers a real settled zero and validates symbol against the live catalog', async () => {
  const now = Date.now();
  const normalized = normalizeHistoryRows('okx', [
    { fundingTime:String(now - 3_600_000), fundingRate:'0.001', realizedRate:'0' },
    { fundingTime:String(now), fundingRate:'0', realizedRate:'' },
  ], now - 24 * 3_600_000);
  assert.deepEqual(normalized, [{ fundingTime:now - 3_600_000, fundingRate:0 }]);

  let historyCalls = 0;
  await withFetchStub(async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/public/instruments')) {
      return okxEnvelope(parsed.searchParams.get('instType') === 'SWAP' ? [LIVE_SWAP] : []);
    }
    if (parsed.pathname.endsWith('/public/funding-rate-history')) {
      historyCalls += 1;
      return okxEnvelope([{ instId:LIVE_SWAP.instId, fundingTime:String(now - 3_600_000), fundingRate:'0.001', realizedRate:'0' }]);
    }
    throw new Error(`Unexpected URL ${url}`);
  }, async () => {
    const response = responseRecorder();
    await fundingHistoryHandler({
      method:'GET',
      query:{ venue:'okx', symbols:LIVE_SWAP.instId, hours:'24' },
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.results[LIVE_SWAP.instId].rows[0].fundingRate, 0);
    assert.equal(historyCalls, 1);

    const rejected = responseRecorder();
    await fundingHistoryHandler({
      method:'GET',
      query:{ venue:'okx', symbols:'BTC-USDT-SWAP', hours:'24' },
    }, rejected);
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.headers['Cache-Control'], 'private, no-store, max-age=0');
    assert.equal(historyCalls, 1, 'an unverified symbol must not reach funding history');
  });
});

test('OKX client integration keeps contract-level coverage and distinct-venue spread semantics', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /representativeFundingRatesByVenue\(venues\)/);
  assert.match(html, /if \(annRates\.length < 2\) return;/);
  assert.match(html, /distinctVenueFundingSpread\(a\.listings\)/);
  assert.match(html, /contributions\s*:\s*new Set\(\)/);
  assert.match(html, /existing\?\.contributions\?\.has\(contributionKey\)/);
  assert.match(html, /addVol\(asset, 'okx', volume30d, method, asset\.symbol\)/);
  assert.match(html, /ASSET_INTELLIGENCE_CATEGORIES = new Set\(\[[^\]]*'bond'/);
  assert.match(html, /r\.spotAsset\?\.pair \|\| r\.spotAsset\?\.venueSymbol/);
});

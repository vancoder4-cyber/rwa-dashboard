import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SPOT_ANOMALY_COLLECTION_BUDGET_MS,
  SPOT_ANOMALY_HISTORY_DAYS,
  SPOT_ANOMALY_SOURCE_NAMES,
  buildSpotVolumePriceAnomalies,
  collectSpotMarketSnapshot,
  compactSpotDailySnapshot,
  isSpotAnomalyHistoryComparable,
  mergeSpotDailyHistory,
  normalizeSpotDailyHistory,
  resolveKrakenTickerPayload,
  spotDailyHistoryBytes,
} from '../api/_lib/spot-volume-price-anomaly.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const CURRENT_DAY = Date.UTC(2026, 7, 14);
const CAPTURED_AT = CURRENT_DAY + 12 * HOUR_MS;

function spotListing(symbol, currentVolumeUsd, priceChange24hPct, options = {}) {
  const venue = options.venue || 'binance';
  const venueSymbol = options.venueSymbol || `${symbol}USDT`;
  return {
    venue,
    venueSymbol,
    symbol,
    category:options.category || 'equity',
    quote:options.quote || 'USDT',
    currentVolumeUsd,
    priceChange24hPct,
    volumeMethod:options.volumeMethod || 'official-rolling24h-quote-turnover',
    volumeStatus:options.volumeStatus || (currentVolumeUsd === null ? 'unavailable' : 'full'),
    changeStatus:priceChange24hPct === null ? 'unavailable' : 'full',
  };
}

function fullSources(listings = []) {
  return Object.fromEntries(SPOT_ANOMALY_SOURCE_NAMES.map(venue => {
    const count = listings.filter(row => row.venue === venue).length;
    return [venue, {
      status:'full',
      listingCount:count,
      marketFieldCount:count,
      priceFieldCount:venue === 'kraken' ? 0 : count,
      warnings:[],
    }];
  }));
}

function perpAssets(symbol = 'AAPL', category = 'equity') {
  return [{
    symbol,
    category,
    listings:[
      { venue:'gate', venueSymbol:`${symbol}X_USDT`, instrumentType:'perpetual' },
      { venue:'okx', venueSymbol:`${symbol}-USDT-SWAP`, instrumentType:'swap' },
      { venue:'okx', venueSymbol:`${symbol}-USD_UM-SWAP`, instrumentType:'x-perp' },
    ],
  }];
}

function build(current, history = [], options = {}) {
  return buildSpotVolumePriceAnomalies(current, history, CAPTURED_AT, {
    sources:fullSources(current),
    perpAssets:perpAssets(),
    perpCoverageStatus:'full',
    ...options,
  });
}

function priorSnapshot(listings) {
  return compactSpotDailySnapshot(listings, CURRENT_DAY - DAY_MS + HOUR_MS);
}

test('Spot history writer accepts price-only Partial coverage but fails closed on any volume or identity gap', () => {
  const completeVolumeSources = fullSources([
    spotListing('GATE', 1, null, { venue:'gate', venueSymbol:'GATE_USDT' }),
    spotListing('KRAKEN', 1, null, { venue:'kraken', venueSymbol:'KRAKENUSD' }),
    spotListing('BITGET', 1, null, { venue:'bitget', venueSymbol:'BITGETUSDT' }),
    spotListing('BINANCE', 1, null, { venue:'binance', venueSymbol:'BINANCEUSDT' }),
    spotListing('OKX', 1, null, { venue:'okx', venueSymbol:'OKX-USDT' }),
  ]);
  completeVolumeSources.binance.status = 'partial';
  completeVolumeSources.binance.priceFieldCount = 0;
  completeVolumeSources.binance.warnings = ['PRICE_CHANGE_FIELDS_INCOMPLETE'];

  assert.equal(isSpotAnomalyHistoryComparable(completeVolumeSources), true,
    'a price-only gap must not discard an otherwise complete volume baseline');

  const missingVolume = structuredClone(completeVolumeSources);
  missingVolume.binance.marketFieldCount = 0;
  assert.equal(isSpotAnomalyHistoryComparable(missingVolume), false);

  const unavailableSource = structuredClone(completeVolumeSources);
  unavailableSource.okx.status = 'unavailable';
  assert.equal(isSpotAnomalyHistoryComparable(unavailableSource), false);
  assert.equal(isSpotAnomalyHistoryComparable(completeVolumeSources, [{ symbol:'DUAL' }]), false);
});

test('Spot anomaly applies inclusive 3x/15% OR boundaries after the $500K filter', () => {
  const current = [
    spotListing('VOLUME', 600_000, 14),
    spotListing('PRICE', 500_000, 15),
    spotListing('BOTH', 600_000, 15),
    spotListing('LOW', 499_999, 50),
  ];
  const prior = priorSnapshot([
    spotListing('VOLUME', 200_000, 0),
    spotListing('PRICE', 500_000, 0),
    spotListing('BOTH', 200_000, 0),
    spotListing('LOW', 100_000, 0),
  ]);
  const result = build(current, [prior]);

  assert.equal(result.status, 'full');
  assert.deepEqual(result.counts, {
    alerts:3,
    volumeSpike:2,
    priceSurge:2,
    both:1,
    perpListed:0,
    filteredLowLiquidity:1,
    filterUnknown:0,
  });
  assert.equal(result.rows.find(row => row.symbol === 'VOLUME').trigger, 'volume_spike');
  assert.equal(result.rows.find(row => row.symbol === 'PRICE').trigger, 'price_surge');
  assert.equal(result.rows.find(row => row.symbol === 'BOTH').trigger, 'both');
  assert.equal(result.rows.some(row => row.symbol === 'LOW'), false);
});

test('price can trigger on Day 1 while volume remains Warming', () => {
  const current = [spotListing('AAPL', 500_000, 15)];
  const result = build(current);

  assert.equal(result.status, 'warming');
  assert.equal(result.history.status, 'warming');
  assert.equal(result.coverage.volumeComparableListings, 0);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].trigger, 'price_surge');
  assert.equal(result.rows[0].yesterdayVolumeUsd, null);
  assert.equal(result.rows[0].volumeRatio, null);
});

test('liquidity, ratio, and price boundaries classify from the exact published precision', () => {
  const current = [
    spotListing('FLOOR', 499_999.996, 15),
    spotListing('RATIO', 599_999.994, 0),
    spotListing('PRICE5', 500_000, 14.999996),
  ];
  const prior = priorSnapshot([
    spotListing('FLOOR', 500_000, 0),
    spotListing('RATIO', 200_000, 0),
    spotListing('PRICE5', 500_000, 0),
  ]);
  const result = build(current, [prior]);
  const floor = result.rows.find(row => row.symbol === 'FLOOR');
  const ratio = result.rows.find(row => row.symbol === 'RATIO');
  const price = result.rows.find(row => row.symbol === 'PRICE5');

  assert.equal(floor.currentVolumeUsd, 500_000);
  assert.equal(floor.trigger, 'price_surge');
  assert.equal(ratio.currentVolumeUsd, 599_999.99);
  assert.equal(ratio.volumeRatio, 3);
  assert.equal(ratio.trigger, 'volume_spike');
  assert.equal(price.priceChange24hPct, 15);
  assert.equal(price.trigger, 'price_surge');
});

test('zero/missing prior volume never creates a ratio and a negative move is not a price surge', () => {
  const current = [
    spotListing('ZERO', 600_000, 15),
    spotListing('DOWN', 600_000, -15),
    spotListing('NOVOL', null, 30, { volumeStatus:'unavailable' }),
  ];
  const prior = priorSnapshot([
    spotListing('ZERO', 0, 0),
    spotListing('DOWN', 600_000, 0),
    spotListing('NOVOL', 100_000, 0),
  ]);
  const result = build(current, [prior]);

  const zero = result.rows.find(row => row.symbol === 'ZERO');
  assert.equal(zero.trigger, 'price_surge');
  assert.equal(zero.yesterdayVolumeUsd, 0);
  assert.equal(zero.volumeRatio, null);
  assert.equal(result.rows.some(row => row.symbol === 'DOWN'), false);
  assert.equal(result.rows.some(row => row.symbol === 'NOVOL'), false);
  assert.equal(result.counts.filterUnknown, 1);
});

test('history and anomaly comparison remain listing-level and method-stable', () => {
  const current = [
    spotListing('AAPL', 600_000, 0, { venue:'binance', venueSymbol:'AAPLBUSDT' }),
    spotListing('AAPL', 600_000, 0, { venue:'okx', venueSymbol:'AAPL-USDT' }),
    spotListing('MSFT', 600_000, 0, { volumeMethod:'new-volume-method' }),
  ];
  const prior = priorSnapshot([
    spotListing('AAPL', 200_000, 0, { venue:'binance', venueSymbol:'AAPLBUSDT' }),
    spotListing('AAPL', 600_000, 0, { venue:'okx', venueSymbol:'AAPL-USDT' }),
    spotListing('MSFT', 200_000, 0),
  ]);
  const result = build(current, [prior]);

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].listingKey, 'spot:binance:AAPLBUSDT');
  assert.equal(result.rows[0].volumeRatio, 3);
  assert.equal(result.rows.some(row => row.listingKey === 'spot:okx:AAPL-USDT'), false);
  assert.equal(result.rows.some(row => row.symbol === 'MSFT'), false);
  assert.equal(result.coverage.volumeComparableListings, 2);
});

test('Perp contracts join by category:canonical and retain every exact contract', () => {
  const current = [spotListing('AAPL', 600_000, 15)];
  const exact = build(current, [], { perpAssets:perpAssets('AAPL', 'equity') });
  assert.equal(exact.rows[0].perpCoverage.listed, true);
  assert.equal(exact.rows[0].perpCoverage.contracts.length, 3);
  assert.deepEqual(
    exact.rows[0].perpCoverage.contracts.filter(contract => contract.venue === 'okx').map(contract => contract.instrumentType),
    ['x-perp', 'swap'].sort((left, right) => {
      const symbols = { 'x-perp':'AAPL-USD_UM-SWAP', swap:'AAPL-USDT-SWAP' };
      return symbols[left].localeCompare(symbols[right]);
    }),
  );

  const wrongCategory = build(current, [], { perpAssets:perpAssets('AAPL', 'commodity') });
  assert.equal(wrongCategory.rows[0].perpCoverage.listed, false);
  assert.deepEqual(wrongCategory.rows[0].perpCoverage.contracts, []);
});

test('Spot history is same-day idempotent, future-safe, and retains eight days', () => {
  const early = compactSpotDailySnapshot([spotListing('AAPL', 100, 0)], CURRENT_DAY + HOUR_MS);
  const later = compactSpotDailySnapshot([spotListing('AAPL', 200, 0)], CURRENT_DAY + 2 * HOUR_MS);
  const staleRetry = compactSpotDailySnapshot([spotListing('AAPL', 50, 0)], CURRENT_DAY + 90 * 60_000);
  const first = mergeSpotDailyHistory([], early, CAPTURED_AT);
  const replaced = mergeSpotDailyHistory(first, later, CAPTURED_AT);
  const unchanged = mergeSpotDailyHistory(replaced, staleRetry, CAPTURED_AT);
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].a[0][4], 200);
  assert.deepEqual(unchanged, replaced);

  const future = compactSpotDailySnapshot([spotListing('AAPL', 999, 0)], CURRENT_DAY + 23 * HOUR_MS);
  assert.deepEqual(normalizeSpotDailyHistory([future], CAPTURED_AT), []);

  const nineDays = Array.from({ length:9 }, (_, index) => {
    const day = CURRENT_DAY - (8 - index) * DAY_MS;
    return compactSpotDailySnapshot([spotListing('AAPL', index + 1, 0)], day + HOUR_MS);
  });
  const retained = normalizeSpotDailyHistory(nineDays, CAPTURED_AT);
  assert.equal(SPOT_ANOMALY_HISTORY_DAYS, 8);
  assert.equal(retained.length, 8);
  assert.equal(retained[0].d, CURRENT_DAY - 7 * DAY_MS);
  assert.equal(retained.at(-1).d, CURRENT_DAY);
});

test('Spot history rejects a valid-shaped Runtime Cache item above 1.75 MB', () => {
  const rows = Array.from({ length:20_000 }, (_, index) => [
    'gate',
    `R${String(index).padStart(6, '0')}${'X'.repeat(50)}_USDT`,
    'e',
    'AAPL',
    1,
    'abcdefgh1234',
  ]);
  const oversized = [{ d:CURRENT_DAY, t:CAPTURED_AT, n:rows.length, a:rows }];
  assert.ok(spotDailyHistoryBytes(oversized) > 1_750_000);
  assert.throws(
    () => normalizeSpotDailyHistory(oversized, CAPTURED_AT),
    error => error instanceof RangeError && /exceeds 1750000 bytes/.test(error.message),
  );
});

test('Kraken ticker resolver accepts only deterministic official aliases and rejects same-suffix lookalikes', () => {
  const ticker = (baseVolume, vwap) => ({ v:['0', String(baseVolume)], p:['0', String(vwap)], o:'1' });
  const tokenizedRows = [
    {
      venueSymbol:'AAPLXUSD', marketQuerySymbol:'AAPLxUSD',
      marketAliases:['AAPLxUSD', 'AAPLx/USD'],
    },
    {
      // `SNxUSD` is the case-sensitive tokenized wrapper for underlying SN;
      // uppercase `SNXUSD` is also an ordinary Crypto pair name.
      venueSymbol:'SNXUSD', marketQuerySymbol:'SNxUSD',
      marketAliases:['SNxUSD', 'SNx/USD'],
    },
  ];
  const tokenized = resolveKrakenTickerPayload(tokenizedRows, {
    AAPLxUSD:ticker(100, 6_000),
    AAPLSPVUSD:ticker(999, 9_999),
    AAPLXUSD:ticker(888, 8_888),
    SNXUSD:ticker(777, 7_777),
  }, { tokenized:true });

  assert.equal(tokenized.size, 1);
  assert.equal(tokenized.get('AAPLXUSD').currentVolumeUsd, 600_000);
  assert.equal(tokenized.has('SNXUSD'), false,
    'an uppercase Crypto response key must not satisfy the exact lowercase-x tokenized market key');

  const standardRow = {
    venueSymbol:'PAXGUSD', marketQuerySymbol:'PAXGUSD',
    marketAliases:['PAXGZUSD', 'PAXGUSD', 'PAXG/USD'],
  };
  for (const officialKey of ['PAXGZUSD', 'PAXGUSD', 'PAXG/USD']) {
    const standard = resolveKrakenTickerPayload([standardRow], { [officialKey]:ticker(10, 2_000) });
    assert.equal(standard.get('PAXGUSD').currentVolumeUsd, 20_000,
      `standard Kraken ticker key ${officialKey} must map through its exact official alias`);
  }

  const ambiguous = resolveKrakenTickerPayload([
    { venueSymbol:'ONEUSD', marketAliases:['SHARED'] },
    { venueSymbol:'TWOUSD', marketAliases:['SHARED'] },
  ], { SHARED:ticker(1, 1) });
  assert.equal(ambiguous.size, 0, 'a shared official alias must be quarantined instead of guessed');
});

test('Kraken resolves the full 166-listing tokenized universe in one bounded official ticker request', async () => {
  const listings = Array.from({ length:166 }, (_, index) => {
    const symbol = `R${String(index).padStart(3, '0')}`;
    return {
      market:'spot',
      venue:'kraken',
      venueSymbol:`${symbol}XUSD`,
      canonicalSymbol:symbol,
      category:'equity',
      identityStatus:'verified',
      marketDataProfile:'kraken-tokenized',
      marketQuerySymbol:`${symbol}xUSD`,
      marketAliases:[`${symbol}xUSD`, `${symbol}x/USD`],
    };
  });
  const result = Object.fromEntries(listings.map((row, index) => [row.marketQuerySymbol, {
    v:['0', String(100 + index)],
    p:['0', '6000'],
    o:'1',
  }]));
  const catalogObservations = [{
    market:'spot', venue:'kraken', status:'full', reason:null, listings,
  }];
  const tickerUrls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    tickerUrls.push(url);
    if (!url.includes('/Ticker?asset_class=tokenized_asset')) {
      throw new Error(`Unexpected Kraken test URL: ${url}`);
    }
    return new Response(JSON.stringify({ error:[], result }), {
      status:200,
      headers:{ 'content-type':'application/json' },
    });
  };
  try {
    const snapshot = await collectSpotMarketSnapshot('https://dashboard.example', { catalogObservations });
    assert.equal(SPOT_ANOMALY_COLLECTION_BUDGET_MS, 23_000);
    assert.equal(tickerUrls.length, 1, '166 tokenized listings must not fan out into per-symbol recovery calls');
    assert.equal(new URL(tickerUrls[0]).searchParams.get('asset_class'), 'tokenized_asset');
    assert.equal(new URL(tickerUrls[0]).searchParams.has('pair'), false);
    assert.equal(snapshot.sources.kraken.status, 'full');
    assert.equal(snapshot.sources.kraken.listingCount, 166);
    assert.equal(snapshot.sources.kraken.marketFieldCount, 166);
    assert.equal(snapshot.sources.kraken.priceFieldCount, 0);
    assert.equal(snapshot.listings.length, 166);
    assert.equal(snapshot.listings[0].currentVolumeUsd, 600_000);

    const callsBeforeExpiredDeadline = tickerUrls.length;
    const expired = await collectSpotMarketSnapshot('https://dashboard.example', {
      catalogObservations,
      deadlineAt:Date.now() + 100,
    });
    assert.equal(tickerUrls.length, callsBeforeExpiredDeadline,
      'an exhausted shared deadline must stop before another Kraken request starts');
    assert.equal(expired.sources.kraken.status, 'unavailable');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('market normalization uses quote turnover, Bitget platform turnover, and no Kraken price proxy', async () => {
  const catalogs = [
    ['gate', 'AAPL_USDT'],
    ['kraken', 'AAPLUSD'],
    ['bitget', 'AAPLUSDT'],
    ['binance', 'AAPLBUSDT'],
    ['okx', 'AAPL-USDT'],
  ].map(([venue, venueSymbol]) => ({
    market:'spot',
    venue,
    status:'full',
    reason:null,
    listings:[{
      market:'spot', venue, venueSymbol, canonicalSymbol:'AAPL', category:'equity',
      identityStatus:'verified',
      ...(venue === 'bitget' ? { marketDataProfile:'bitget-reality' } : {}),
      ...(venue === 'kraken' ? { marketAliases:[venueSymbol] } : {}),
    }],
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    let body;
    if (url.includes('/api/gate-bulk?type=spot-snapshot')) {
      body = { tickers:[{ currency_pair:'AAPL_USDT', quote_volume:'600000', change_percentage:'16' }] };
    } else if (url.includes('/api/binance-public?endpoint=spot-snapshot')) {
      body = { schemaVersion:1, catalogStatus:'full', tickers:[{ symbol:'AAPLBUSDT', quoteVolume:'600000', priceChangePercent:'16' }] };
    } else if (url.includes('/api/okx-market?type=spot-snapshot')) {
      body = { tickers:[{ instId:'AAPL-USDT', volCcy24h:'600000', last:'116', open24h:'100' }] };
    } else if (url.includes('/api/v3/market/tickers?category=SPOT')) {
      body = { code:'00000', data:[{
        symbol:'AAPLUSDT', platformTurnover24h:'600000', turnover24h:'999999999', price24hPcnt:'0.16',
      }] };
    } else if (url.includes('/api/v2/spot/market/tickers')) {
      body = { code:'00000', data:[] };
    } else if (url.includes('/Ticker?')) {
      body = { error:[], result:{ AAPLUSD:{ v:['0','100'], p:['0','6000'], o:'1' } } };
    } else {
      throw new Error(`Unexpected test URL: ${url}`);
    }
    return new Response(JSON.stringify(body), { status:200, headers:{ 'content-type':'application/json' } });
  };
  try {
    const snapshot = await collectSpotMarketSnapshot('https://dashboard.example', { catalogObservations:catalogs });
    assert.deepEqual(Object.keys(snapshot.sources), SPOT_ANOMALY_SOURCE_NAMES);
    assert.ok(Object.values(snapshot.sources).every(source => source.status === 'full'));
    const bitget = snapshot.listings.find(row => row.venue === 'bitget');
    assert.equal(bitget.currentVolumeUsd, 600_000);
    assert.equal(bitget.priceChange24hPct, 16);
    const kraken = snapshot.listings.find(row => row.venue === 'kraken');
    assert.equal(kraken.currentVolumeUsd, 600_000);
    assert.equal(kraken.volumeStatus, 'estimated');
    assert.equal(kraken.priceChange24hPct, null);
    assert.equal(kraken.changeStatus, 'unavailable');
    assert.equal(snapshot.sources.kraken.priceFieldCount, 0);
    assert.equal(snapshot.sources.binance.priceFieldCount, 1);
    assert.ok(snapshot.sources.kraken.warnings.includes('KRAKEN_PRICE_CHANGE_UNAVAILABLE_BY_DESIGN'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('public rows are Top 100 while counts retain the full alert universe', () => {
  const current = Array.from({ length:101 }, (_, index) =>
    spotListing(`RWA${String(index).padStart(3, '0')}`, 500_000 + index, 15));
  const result = build(current);
  assert.equal(result.counts.alerts, 101);
  assert.equal(result.counts.priceSurge, 101);
  assert.equal(result.rows.length, 100);
  assert.deepEqual(result.rows.map(row => row.rank), Array.from({ length:100 }, (_, index) => index + 1));
});

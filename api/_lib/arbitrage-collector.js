import { collectListingSourceObservations } from './listing-sources.js';
import { collectSpotMarketSnapshot } from './spot-volume-price-anomaly.js';
import { fetchJsonWithPolicy, mapWithConcurrency } from './upstream.js';
import {
  buildArbitrageRoute,
  buildArbitrageSnapshot,
  routeIdentity,
  routeMeetsNotificationPolicy,
  settledFundingMetrics,
} from './arbitrage-analysis.js';
import { readAuthoritativeArbitrageInputs, ARBITRAGE_SOURCE_KEYS } from './arbitrage-publication.js';
import {
  collectGate,
  collectBinance,
  collectBitget,
  collectTradeXyz,
  collectOkx,
} from '../signal-snapshot.js';

const BINANCE_SPOT = 'https://data-api.binance.vision/api/v3';
const BINANCE_PERP = 'https://fapi.binance.com/fapi/v1';
const BITGET = 'https://api.bitget.com';
const GATE_SPOT = 'https://api.gateio.ws/api/v4/spot';
const GATE_PERP = 'https://api.gateio.ws/api/v4/futures/usdt';
const KRAKEN = 'https://api.kraken.com/0/public';
const OKX = 'https://www.okx.com/api/v5';
const HYPERLIQUID = 'https://api.hyperliquid.xyz/info';
const MAX_CANDIDATE_ROUTES = 1_500;

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value) {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

function sourceKey(market, venue) {
  return `${market}:${venue}`;
}

function assetKey(category, symbol) {
  return `${String(category || '').trim().toLowerCase()}:${String(symbol || '').trim().toUpperCase()}`;
}

function identityKey(market, venue, venueSymbol) {
  return `${sourceKey(market, venue)}:${String(venueSymbol || '').trim()}`;
}

function deploymentBaseUrl(req) {
  const forwarded = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').toLowerCase();
  if (/^[a-z0-9.-]+\.vercel\.app$/.test(forwarded)) return `https://${forwarded}`;
  const deployment = process.env.VERCEL_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return `https://${deployment || 'avenir-rwa-analyst.vercel.app'}`;
}

function bookLevel(row) {
  const price = positive(Array.isArray(row) ? row[0] : row?.price ?? row?.px ?? row?.p);
  const size = finite(Array.isArray(row) ? row[1] : row?.size ?? row?.sz ?? row?.q);
  return price !== null && size !== null && size >= 0 ? { price, size } : null;
}

export function executableBookSide(levels, side, sizeMultiplier = 1, tolerancePct = 2) {
  const multiplier = positive(sizeMultiplier);
  const rows = (Array.isArray(levels) ? levels : []).map(bookLevel).filter(Boolean);
  if (!rows.length || multiplier === null || !['buy', 'sell'].includes(side)) return null;
  rows.sort((left, right) => side === 'buy' ? left.price - right.price : right.price - left.price);
  const topPrice = rows[0].price;
  const boundary = side === 'buy'
    ? topPrice * (1 + tolerancePct / 100)
    : topPrice * (1 - tolerancePct / 100);
  const depth = rows.reduce((sum, row) => {
    const admitted = side === 'buy' ? row.price <= boundary : row.price >= boundary;
    return admitted ? sum + row.price * row.size * multiplier : sum;
  }, 0);
  return { priceUsd:topPrice, executableDepthUsd:depth };
}

function normalizeBook(payload, venue) {
  if (venue === 'okx') {
    const book = Array.isArray(payload?.data) ? payload.data[0] : null;
    return { bids:book?.bids, asks:book?.asks };
  }
  if (venue === 'kraken') {
    if (Array.isArray(payload?.error) && payload.error.length) return null;
    return Object.values(payload?.result || {})[0] || null;
  }
  if (venue === 'bitget') return payload?.code === '00000' ? payload.data : null;
  if (venue === 'tradexyz') return {
    bids:Array.isArray(payload?.levels) ? payload.levels[0] : null,
    asks:Array.isArray(payload?.levels) ? payload.levels[1] : null,
  };
  return payload;
}

async function fetchOrderBook(listing) {
  const venue = listing.venue;
  const symbol = listing.venueSymbol;
  let url;
  let options = { headers:{ Accept:'application/json' } };
  if (venue === 'binance') {
    url = `${listing.market === 'spot' ? BINANCE_SPOT : BINANCE_PERP}/depth?symbol=${encodeURIComponent(symbol)}&limit=100`;
  } else if (venue === 'bitget') {
    url = listing.market === 'spot'
      ? `${BITGET}/api/v2/spot/market/orderbook?symbol=${encodeURIComponent(symbol)}&type=step0&limit=150`
      : `${BITGET}/api/v2/mix/market/depth?symbol=${encodeURIComponent(symbol)}&productType=USDT-FUTURES&limit=150`;
  } else if (venue === 'gate') {
    url = listing.market === 'spot'
      ? `${GATE_SPOT}/order_book?currency_pair=${encodeURIComponent(symbol)}&limit=100`
      : `${GATE_PERP}/order_book?contract=${encodeURIComponent(symbol)}&limit=100`;
  } else if (venue === 'okx') {
    url = `${OKX}/market/books?instId=${encodeURIComponent(symbol)}&sz=400`;
  } else if (venue === 'kraken') {
    const querySymbol = listing.marketQuerySymbol || symbol;
    const assetClass = listing.marketDataProfile === 'kraken-tokenized' ? '&asset_class=tokenized_asset' : '';
    url = `${KRAKEN}/Depth?pair=${encodeURIComponent(querySymbol)}&count=500${assetClass}`;
  } else if (venue === 'tradexyz') {
    url = HYPERLIQUID;
    options = {
      method:'POST',
      headers:{ 'Content-Type':'application/json', Accept:'application/json' },
      body:JSON.stringify({ type:'l2Book', coin:listing.marketQuerySymbol || symbol }),
    };
  } else {
    throw new TypeError(`Unsupported order-book venue ${venue}`);
  }
  const payload = await fetchJsonWithPolicy(url, options, { timeoutMs:8_000, retries:1, baseDelayMs:200 });
  const book = normalizeBook(payload, venue);
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) {
    throw new TypeError(`Invalid ${venue} order book for ${symbol}`);
  }
  const multiplier = listing.market === 'perp' ? (positive(listing.sizeMultiplier) || 1) : 1;
  const side = listing.market === 'spot'
    ? executableBookSide(book.asks, 'buy', 1)
    : executableBookSide(book.bids, 'sell', multiplier);
  if (!side) throw new TypeError(`Empty executable ${venue} order book for ${symbol}`);
  return { ...side, observedAt:new Date().toISOString() };
}

async function fetchFundingHistories(baseUrl, perps) {
  const byVenue = new Map();
  for (const perp of perps) {
    if (!byVenue.has(perp.venue)) byVenue.set(perp.venue, []);
    byVenue.get(perp.venue).push(perp);
  }
  const output = new Map();
  for (const [venue, rows] of byVenue) {
    const unique = [...new Map(rows.map(row => [row.venueSymbol, row])).values()]
      .sort((left, right) => left.venueSymbol.localeCompare(right.venueSymbol));
    for (let index = 0; index < unique.length; index += 40) {
      const batch = unique.slice(index, index + 40);
      const params = new URLSearchParams({
        venue,
        symbols:batch.map(row => row.marketQuerySymbol || row.venueSymbol).join(','),
        hours:'24',
      });
      const payload = await fetchJsonWithPolicy(
        `${baseUrl}/api/funding-history?${params}`,
        { headers:{ Accept:'application/json' } },
        { timeoutMs:25_000, retries:0 },
      );
      if (payload?.venue !== venue) throw new TypeError(`Invalid ${venue} funding-history envelope`);
      for (const row of batch) {
        const querySymbol = row.marketQuerySymbol || row.venueSymbol;
        const result = payload?.results?.[querySymbol];
        if (result?.status !== 'full' || !Array.isArray(result?.rows)) {
          throw new TypeError(`Incomplete settled funding history for ${venue}:${row.venueSymbol}`);
        }
        output.set(`${venue}:${row.venueSymbol}`, result.rows);
      }
    }
  }
  return output;
}

async function fillMissingBinanceOpenInterest(listings) {
  const missing = listings.filter(row => row.venue === 'binance' && !(finite(row.openInterestUsd) >= 0));
  const rows = await mapWithConcurrency(missing, 20, async row => {
    const payload = await fetchJsonWithPolicy(
      `${BINANCE_PERP}/openInterest?symbol=${encodeURIComponent(row.venueSymbol)}`,
      { headers:{ Accept:'application/json' } },
      { timeoutMs:8_000, retries:1, baseDelayMs:200 },
    );
    const quantity = finite(payload?.openInterest);
    const price = positive(row.priceUsd);
    if (quantity === null || quantity < 0 || price === null) throw new TypeError(`Missing Binance OI ${row.venueSymbol}`);
    row.openInterestUsd = quantity * price;
    return row;
  });
  return rows.length;
}

function normalizePerpListing(row) {
  const venue = String(row?.venue || '').toLowerCase();
  const venueSymbol = String(row?.venueSymbol || '').trim();
  const contractMultiplier = positive(row?.contractMultiplier);
  const contractValue = positive(row?.contractValue);
  return {
    ...row,
    market:'perp',
    venue,
    venueSymbol,
    symbol:String(row?.symbol || '').toUpperCase(),
    category:String(row?.category || '').toLowerCase(),
    marketQuerySymbol:venue === 'tradexyz' ? venueSymbol : row?.marketQuerySymbol,
    sizeMultiplier:venue === 'gate'
      ? contractMultiplier || 1
      : venue === 'okx' ? (contractValue && contractMultiplier ? contractValue * contractMultiplier : 1) : 1,
  };
}

function catalogMarketFingerprint(row, catalogRow = false) {
  const market = String(row?.market || '').trim().toLowerCase();
  const venue = String(row?.venue || '').trim().toLowerCase();
  const venueSymbol = String(row?.venueSymbol || '').trim().toUpperCase();
  const category = String(row?.category || '').trim().toLowerCase();
  const symbol = String(catalogRow ? row?.canonicalSymbol : row?.symbol || '').trim().toUpperCase();
  return `${market}:${venue}:${venueSymbol}:${category}:${symbol}`;
}

function reconcileMarketCatalogCoverage(catalogObservations, marketRows) {
  const expected = (Array.isArray(catalogObservations) ? catalogObservations : [])
    .flatMap(observation => observation.listings
      .filter(row => row?.identityStatus === 'verified')
      .map(row => catalogMarketFingerprint(row, true)));
  const observed = (Array.isArray(marketRows) ? marketRows : []).map(row => catalogMarketFingerprint(row));
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);
  if (expectedSet.size !== expected.length || observedSet.size !== observed.length ||
      expectedSet.size !== observedSet.size || [...expectedSet].some(key => !observedSet.has(key))) {
    throw new TypeError('Exact market-data membership does not match the verified ten-source catalog');
  }
}

function authoritativeListing(listing, identities) {
  const identity = identities.get(identityKey(listing.market, listing.venue, listing.venueSymbol));
  if (!identity || identity.category !== listing.category || identity.canonicalSymbol !== listing.symbol) return null;
  return {
    ...listing,
    venueSymbol:identity.venueSymbol,
    symbol:identity.canonicalSymbol,
    category:identity.category,
    identity,
  };
}

function groupByAsset(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = assetKey(row.category, row.symbol);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

export async function collectArbitragePublication(req, options = {}) {
  const fixedNowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : null;
  const baseUrl = options.baseUrl || deploymentBaseUrl(req);
  const readInputs = options.readInputs || readAuthoritativeArbitrageInputs;
  const collectCatalog = options.collectCatalog || collectListingSourceObservations;
  const collectSpot = options.collectSpot || collectSpotMarketSnapshot;
  const configuredPerpCollectors = options.perpCollectors || {
    gate:collectGate,
    binance:collectBinance,
    bitget:collectBitget,
    tradexyz:collectTradeXyz,
    okx:collectOkx,
  };
  const fillBinanceOi = options.fillBinanceOi || fillMissingBinanceOpenInterest;
  const readOrderBook = options.fetchOrderBook || fetchOrderBook;
  const readFundingHistories = options.fetchFundingHistories || fetchFundingHistories;
  const [authority, catalogObservations] = await Promise.all([
    readInputs(),
    collectCatalog(baseUrl),
  ]);
  const observationByKey = new Map(catalogObservations.map(row => [sourceKey(row.market, row.venue), row]));
  if (catalogObservations.length !== 10 || ARBITRAGE_SOURCE_KEYS.some(key => observationByKey.get(key)?.status !== 'full')) {
    throw new TypeError('Ten-source authoritative catalog coverage is incomplete');
  }

  const spotPromise = collectSpot(baseUrl, { catalogObservations });
  const perpResults = await Promise.all(Object.entries(configuredPerpCollectors).map(async ([venue, collect]) => [
    venue,
    await (venue === 'bitget' ? collect() : collect(baseUrl)),
  ]));
  const perpVenueSet = new Set(perpResults.map(([venue]) => venue));
  if (perpResults.length !== 5 || ['gate', 'binance', 'bitget', 'tradexyz', 'okx'].some(venue => !perpVenueSet.has(venue))) {
    throw new TypeError('Perpetual market collection does not contain the exact five-source set');
  }
  if (perpResults.some(([, result]) => result?.completeness !== 'full')) {
    throw new TypeError('Perpetual market coverage is incomplete');
  }
  const spotSnapshot = await spotPromise;
  if (Object.values(spotSnapshot.sources).some(source => source.status !== 'full')) {
    throw new TypeError('Spot market coverage is incomplete');
  }
  const rawPerps = perpResults.flatMap(([, result]) => result.listings.map(normalizePerpListing));
  await fillBinanceOi(rawPerps);

  const rawSpots = spotSnapshot.listings.map(row => ({ ...row, market:'spot' }));
  const allRows = [...rawSpots, ...rawPerps];
  reconcileMarketCatalogCoverage(catalogObservations, allRows);
  const authoritative = allRows.map(row => authoritativeListing(row, authority.identities));
  const rejectedListings = authoritative.filter(row => row === null).length;
  const quarantinedListings = spotSnapshot.quarantinedListings + perpResults.reduce(
    (sum, [, result]) => sum + (Number(result.quarantinedListings) || 0),
    0,
  );
  if (rejectedListings || quarantinedListings || spotSnapshot.conflicts.length) {
    throw new TypeError('Arbitrage identity coverage contains rejected, quarantined, or conflicting listings');
  }
  const spots = authoritative.filter(row => row.market === 'spot');
  const perps = authoritative.filter(row => row.market === 'perp');
  const spotsByAsset = groupByAsset(spots);
  const candidates = [];
  for (const perp of perps) {
    const matchingSpots = spotsByAsset.get(assetKey(perp.category, perp.symbol)) || [];
    if (!matchingSpots.length) continue;
    const openInterestUsd = finite(perp.openInterestUsd);
    if (openInterestUsd === null) {
      throw new TypeError(`Incomplete shared perpetual market data ${perp.venue}:${perp.venueSymbol}`);
    }
    if (openInterestUsd < 1_000_000) continue;
    if (finite(perp.fundingRate) === null || positive(perp.fundingIntervalHours) === null || !perp.observedAt) {
      throw new TypeError(`Incomplete capacity-eligible perpetual market data ${perp.venue}:${perp.venueSymbol}`);
    }
    for (const spot of matchingSpots) {
      candidates.push({ spot, perp });
    }
  }
  if (candidates.length > MAX_CANDIDATE_ROUTES) throw new TypeError('Arbitrage candidate route bound exceeded');

  const uniqueListings = [...new Map(candidates.flatMap(row => [row.spot, row.perp])
    .map(row => [`${row.market}:${row.venue}:${row.venueSymbol}`, row])).values()];
  const books = new Map(await mapWithConcurrency(uniqueListings, 20, async listing => [
    `${listing.market}:${listing.venue}:${listing.venueSymbol}`,
    await readOrderBook(listing),
  ]));
  const fundingByPerp = await readFundingHistories(baseUrl, candidates.map(row => row.perp));
  const generatedAtMs = fixedNowMs ?? Date.now();

  const routeFacts = [];
  for (const { spot, perp } of candidates) {
    const spotBook = books.get(`spot:${spot.venue}:${spot.venueSymbol}`);
    const perpBook = books.get(`perp:${perp.venue}:${perp.venueSymbol}`);
    const fundingHistory = fundingByPerp.get(`${perp.venue}:${perp.venueSymbol}`);
    const routeIdentityValue = routeIdentity(
      { category:perp.category, symbol:perp.symbol },
      spot,
      perp,
    );
    const settled = settledFundingMetrics(fundingHistory, {
      nowMs:generatedAtMs,
      intervalHours:perp.fundingIntervalHours,
    });
    if (!settled) throw new TypeError(`Incomplete exact funding metrics for ${routeIdentityValue.routeId}`);
    const route = buildArbitrageRoute({
      asset:{
        symbol:perp.symbol,
        name:perp.identity.name,
        category:perp.category,
        verified:true,
        eligible:true,
      },
      spot:{
        venue:spot.venue,
        venueSymbol:spot.venueSymbol,
        askPriceUsd:spotBook.priceUsd,
        executableDepthUsd:spotBook.executableDepthUsd,
        observedAt:spotBook.observedAt,
      },
      perp:{
        venue:perp.venue,
        venueSymbol:perp.venueSymbol,
        bidPriceUsd:perpBook.priceUsd,
        executableDepthUsd:perpBook.executableDepthUsd,
        openInterestUsd:perp.openInterestUsd,
        currentFundingRate:perp.fundingRate,
        fundingIntervalHours:perp.fundingIntervalHours,
        observedAt:perpBook.observedAt,
        fundingObservedAt:perp.observedAt || perpBook.observedAt,
      },
      fundingHistory,
    }, { generatedAt:generatedAtMs, basisHistory:authority.basisHistory });
    if (spot.identity.assetVersionId !== perp.identity.assetVersionId) {
      throw new TypeError(`Cross-version asset mismatch for ${route.routeId}`);
    }
    routeFacts.push({
      route,
      authority:{
        assetVersionId:perp.identity.assetVersionId,
        spotInstrumentVersionId:spot.identity.instrumentVersionId,
        perpInstrumentVersionId:perp.identity.instrumentVersionId,
      },
      settledObservationCount:settled.settledObservationCount,
      inputEvidence:{
        spotListingKey:identityKey('spot', spot.venue, spot.venueSymbol),
        perpListingKey:identityKey('perp', perp.venue, perp.venueSymbol),
        executionTolerancePct:2,
        fundingFirstSettledAt:settled.firstSettledAt,
        fundingLastSettledAt:settled.lastSettledAt,
      },
    });
  }
  routeFacts.sort((left, right) => left.route.routeId.localeCompare(right.route.routeId));
  const publishedRoutes = routeFacts.map(row => row.route).filter(routeMeetsNotificationPolicy);
  const snapshot = buildArbitrageSnapshot(publishedRoutes, {
    availableSources:5,
    spotAvailableSources:5,
    identityConflicts:spotSnapshot.conflicts.length,
    rejectedListings,
    quarantinedListings,
    complete:true,
  }, { generatedAt:generatedAtMs });
  return {
    snapshot,
    routeFacts,
    sources:ARBITRAGE_SOURCE_KEYS.map(key => ({
      sourceKey:key,
      status:'full',
      listingCount:observationByKey.get(key).listings.length,
    })),
    diagnostics:{ candidateRoutes:candidates.length, observedRoutes:routeFacts.length, publishedRoutes:publishedRoutes.length },
  };
}

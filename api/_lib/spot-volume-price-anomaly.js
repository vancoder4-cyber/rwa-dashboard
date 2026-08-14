import { createHash } from 'node:crypto';

import { collectVerifiedSpotListingSourceObservations } from './listing-sources.js';
import { normalizeSignalIdentity } from './security-identity.js';
import { fetchJsonWithPolicy, mapWithConcurrency } from './upstream.js';

export const SPOT_ANOMALY_FORMULA_VERSION = 'rwa-spot-volume-price-anomaly-1.0';
export const SPOT_ANOMALY_HISTORY_NAMESPACE = 'rwa-signal-spot-volume-price-history-v1';
export const SPOT_ANOMALY_HISTORY_DAYS = 8;
export const SPOT_ANOMALY_COLLECTION_BUDGET_MS = 23_000;
export const SPOT_ANOMALY_SOURCE_NAMES = Object.freeze(['gate', 'kraken', 'bitget', 'binance', 'okx']);
export const SPOT_ANOMALY_THRESHOLDS = Object.freeze({
  volumeRatio: 3,
  priceRisePct: 15,
  minCurrentVolumeUsd: 500_000,
});

const DAY_MS = 24 * 60 * 60 * 1_000;
const HISTORY_MAX_BYTES = 1_750_000;
const SOURCE_TIMEOUT_MS = 20_000;
const BITGET_BASE = 'https://api.bitget.com';
const KRAKEN_BASE = 'https://api.kraken.com/0/public';
const VENUE_SET = new Set(SPOT_ANOMALY_SOURCE_NAMES);
const CATEGORY_CODES = Object.freeze({
  equity: 'e',
  etf: 't',
  commodity: 'c',
  index: 'i',
  fx: 'f',
  bond: 'b',
  'pre-ipo': 'p',
});
const CODE_CATEGORIES = Object.freeze(Object.fromEntries(
  Object.entries(CATEGORY_CODES).map(([category, code]) => [code, category]),
));
const LISTING_SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9._:/-]{0,79}$/;
const CANONICAL_PATTERN = /^[A-Z0-9][A-Z0-9.-]{0,39}$/;

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function nonNegativeOrNull(value) {
  const numeric = finiteOrNull(value);
  return numeric !== null && numeric >= 0 ? numeric : null;
}

function positiveOrNull(value) {
  const numeric = finiteOrNull(value);
  return numeric !== null && numeric > 0 ? numeric : null;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizedUpper(value) {
  return String(value ?? '').trim().toUpperCase();
}

function normalizedLower(value) {
  return String(value ?? '').trim().toLowerCase();
}

function boundedMarketPolicy(deadlineAt, maximumMs = SOURCE_TIMEOUT_MS) {
  const remainingMs = Math.floor(deadlineAt - Date.now());
  if (remainingMs < 250) throw new TypeError('Spot market collection deadline exhausted');
  return { timeoutMs:Math.min(maximumMs, remainingMs), retries:0, baseDelayMs:250 };
}

function encodeCategory(category) {
  const normalized = normalizedLower(category);
  return CATEGORY_CODES[normalized] || normalized;
}

function decodeCategory(code) {
  const normalized = normalizedLower(code);
  return CODE_CATEGORIES[normalized] || normalized;
}

function listingKey(venue, venueSymbol) {
  const normalizedVenue = normalizedLower(venue);
  const normalizedVenueSymbol = normalizedUpper(venueSymbol);
  return VENUE_SET.has(normalizedVenue) && LISTING_SYMBOL_PATTERN.test(normalizedVenueSymbol)
    ? `spot:${normalizedVenue}:${normalizedVenueSymbol}`
    : null;
}

function assetKey(category, symbol) {
  const normalizedCategory = normalizedLower(category);
  const normalizedSymbol = normalizedUpper(symbol);
  const identity = normalizeSignalIdentity(normalizedSymbol, normalizedCategory);
  return identity && identity.symbol === normalizedSymbol && identity.category === normalizedCategory
    ? `${normalizedCategory}:${normalizedSymbol}`
    : null;
}

function quoteFromVenueSymbol(venue, venueSymbol) {
  const symbol = normalizedUpper(venueSymbol);
  if (normalizedLower(venue) === 'gate') return symbol.endsWith('_USDT') ? 'USDT' : symbol.endsWith('_USD') ? 'USD' : null;
  if (normalizedLower(venue) === 'okx') return symbol.endsWith('-USDT') ? 'USDT' : symbol.endsWith('-USD') ? 'USD' : null;
  return symbol.endsWith('USDT') ? 'USDT' : symbol.endsWith('USD') ? 'USD' : null;
}

function cohortFingerprint(row) {
  const key = listingKey(row?.venue, row?.venueSymbol);
  const canonical = assetKey(row?.category, row?.symbol);
  const quote = String(row?.quote || '').toUpperCase();
  const method = normalizedLower(row?.volumeMethod);
  if (!key || !canonical || !['USD', 'USDT'].includes(quote) || !method) return null;
  return createHash('sha256')
    .update(`${key}|${canonical}|${quote}|${method}`)
    .digest('base64url')
    .slice(0, 12);
}

async function fetchSameOrigin(baseUrl, path, deadlineAt) {
  return fetchJsonWithPolicy(
    `${baseUrl}${path}`,
    { headers: { Accept: 'application/json' } },
    boundedMarketPolicy(deadlineAt),
  );
}

function marketFields(volume, volumeMethod, change, changeMethod, { estimatedVolume = false } = {}) {
  const currentVolumeUsd = nonNegativeOrNull(volume);
  const priceChange24hPct = finiteOrNull(change);
  return {
    currentVolumeUsd,
    priceChange24hPct,
    volumeMethod: currentVolumeUsd === null ? null : volumeMethod,
    volumeStatus: currentVolumeUsd === null ? 'unavailable' : estimatedVolume ? 'estimated' : 'full',
    changeMethod: priceChange24hPct === null ? null : changeMethod,
    changeStatus: priceChange24hPct === null ? 'unavailable' : 'full',
  };
}

async function gateMarket(baseUrl, catalog, deadlineAt) {
  const payload = await fetchSameOrigin(baseUrl, '/api/gate-bulk?type=spot-snapshot', deadlineAt);
  const tickers = Array.isArray(payload?.tickers) ? payload.tickers : [];
  const bySymbol = new Map(tickers.map(row => [normalizedUpper(row?.currency_pair), row]));
  return new Map(catalog.map(row => {
    const ticker = bySymbol.get(row.venueSymbol) || {};
    return [row.venueSymbol, marketFields(
      ticker.quote_volume,
      'official-rolling24h-quote-turnover',
      ticker.change_percentage,
      'official-rolling24h-percent',
    )];
  }));
}

async function binanceMarket(baseUrl, catalog, deadlineAt) {
  const payload = await fetchSameOrigin(baseUrl, '/api/binance-public?endpoint=spot-snapshot', deadlineAt);
  if (payload?.schemaVersion !== 1 || payload?.catalogStatus !== 'full') {
    throw new TypeError('Binance admitted Spot market snapshot unavailable');
  }
  const bySymbol = new Map((Array.isArray(payload?.tickers) ? payload.tickers : [])
    .map(row => [normalizedUpper(row?.symbol), row]));
  return new Map(catalog.map(row => {
    const ticker = bySymbol.get(row.venueSymbol) || {};
    return [row.venueSymbol, marketFields(
      ticker.quoteVolume,
      'official-rolling24h-quote-turnover',
      ticker.priceChangePercent,
      'official-rolling24h-percent',
    )];
  }));
}

async function okxMarket(baseUrl, catalog, deadlineAt) {
  const payload = await fetchSameOrigin(baseUrl, '/api/okx-market?type=spot-snapshot', deadlineAt);
  const bySymbol = new Map((Array.isArray(payload?.tickers) ? payload.tickers : [])
    .map(row => [normalizedUpper(row?.instId), row]));
  return new Map(catalog.map(row => {
    const ticker = bySymbol.get(row.venueSymbol) || {};
    const last = positiveOrNull(ticker.last);
    const open = positiveOrNull(ticker.open24h);
    const change = last !== null && open !== null ? ((last - open) / open) * 100 : null;
    return [row.venueSymbol, marketFields(
      ticker.volCcy24h,
      'official-rolling24h-quote-turnover',
      change,
      'official-rolling24h-open-to-last',
    )];
  }));
}

function bitgetRows(payload, label) {
  if (payload?.code !== '00000' || !Array.isArray(payload?.data)) {
    throw new TypeError(`Bitget ${label} market snapshot unavailable`);
  }
  return payload.data;
}

async function bitgetMarket(_baseUrl, catalog, deadlineAt) {
  const requestPolicy = boundedMarketPolicy(deadlineAt);
  const settled = await Promise.allSettled([
    fetchJsonWithPolicy(
      `${BITGET_BASE}/api/v3/market/tickers?category=SPOT`,
      { headers: { Accept: 'application/json' } },
      requestPolicy,
    ),
    fetchJsonWithPolicy(
      `${BITGET_BASE}/api/v2/spot/market/tickers`,
      { headers: { Accept: 'application/json' } },
      requestPolicy,
    ),
  ]);
  let realityRows = [];
  let standardRows = [];
  if (settled[0].status === 'fulfilled') {
    try { realityRows = bitgetRows(settled[0].value, 'Reality'); } catch { /* unavailable fields below */ }
  }
  if (settled[1].status === 'fulfilled') {
    try { standardRows = bitgetRows(settled[1].value, 'standard Spot'); } catch { /* unavailable fields below */ }
  }
  if (!realityRows.length && !standardRows.length) throw new TypeError('Bitget Spot market snapshots unavailable');
  const realityBySymbol = new Map(realityRows.map(row => [normalizedUpper(row?.symbol), row]));
  const standardBySymbol = new Map(standardRows.map(row => [normalizedUpper(row?.symbol), row]));
  return new Map(catalog.map(row => {
    const reality = row.marketDataProfile === 'bitget-reality';
    const ticker = (reality ? realityBySymbol : standardBySymbol).get(row.venueSymbol) || {};
    const rawChange = finiteOrNull(reality ? ticker.price24hPcnt : ticker.change24h);
    return [row.venueSymbol, marketFields(
      reality ? ticker.platformTurnover24h : ticker.quoteVolume,
      reality ? 'official-platform-rolling24h-turnover' : 'official-rolling24h-quote-turnover',
      rawChange === null ? null : rawChange * 100,
      'official-rolling24h-fraction',
    )];
  }));
}

function krakenTickerFields(ticker) {
  const baseVolume = nonNegativeOrNull(ticker?.v?.[1]);
  const vwap = positiveOrNull(ticker?.p?.[1]);
  const volume = baseVolume === 0 ? 0 : baseVolume !== null && vwap !== null ? baseVolume * vwap : null;
  // Kraken's `o` field is the current UTC day's open, not a rolling-24h
  // reference price. It must not be relabelled as a 24h percentage change.
  return marketFields(
    volume,
    'official-rolling24h-base-volume-x-vwap',
    null,
    null,
    { estimatedVolume: volume !== null },
  );
}

async function fetchKrakenTickerPayload(rows, tokenized, deadlineAt, maximumMs = 5_000) {
  const pairs = rows.map(row => row.venueSymbol).join(',');
  const assetClass = tokenized ? '&asset_class=tokenized_asset' : '';
  const payload = await fetchJsonWithPolicy(
    `${KRAKEN_BASE}/Ticker?pair=${encodeURIComponent(pairs)}${assetClass}`,
    { headers: { Accept: 'application/json' } },
    boundedMarketPolicy(deadlineAt, maximumMs),
  );
  if (!payload || (Array.isArray(payload.error) && payload.error.length) || !payload.result || typeof payload.result !== 'object') {
    throw new TypeError('Kraken official Ticker snapshot unavailable');
  }
  return payload.result;
}

function krakenAliasIndex(rows) {
  const index = new Map();
  const duplicates = new Set();
  for (const row of rows) {
    const aliases = [row.venueSymbol, ...(Array.isArray(row.marketAliases) ? row.marketAliases : [])];
    for (const alias of aliases.map(normalizedUpper).filter(Boolean)) {
      if (index.has(alias) && index.get(alias) !== row.venueSymbol) duplicates.add(alias);
      else index.set(alias, row.venueSymbol);
    }
  }
  for (const alias of duplicates) index.delete(alias);
  return index;
}

async function krakenMarket(_baseUrl, catalog, deadlineAt) {
  const result = new Map();
  const groups = [
    { tokenized: false, rows: catalog.filter(row => row.marketDataProfile !== 'kraken-tokenized') },
    { tokenized: true, rows: catalog.filter(row => row.marketDataProfile === 'kraken-tokenized') },
  ];
  for (const group of groups) {
    const chunks = [];
    for (let index = 0; index < group.rows.length; index += 15) chunks.push(group.rows.slice(index, index + 15));
    const settled = await mapWithConcurrency(chunks, 5, async chunk => {
      try { return { chunk, payload: await fetchKrakenTickerPayload(chunk, group.tokenized, deadlineAt) }; }
      catch { return { chunk, payload: null }; }
    });
    for (const batch of settled) {
      if (!batch.payload) continue;
      const aliases = krakenAliasIndex(batch.chunk);
      for (const [upstreamSymbol, ticker] of Object.entries(batch.payload)) {
        const venueSymbol = aliases.get(normalizedUpper(upstreamSymbol));
        if (venueSymbol) result.set(venueSymbol, krakenTickerFields(ticker));
      }
    }

    // Kraken may return an internal pair key instead of the official altname.
    // Retry only unresolved identities one-by-one: a one-row official response
    // maps deterministically to the exact requested catalog instrument without
    // substring or ticker-similarity matching.
    const remainingForRecovery = deadlineAt - Date.now();
    const missing = remainingForRecovery >= 750
      ? group.rows.filter(row => !result.has(row.venueSymbol)).slice(0, 10)
      : [];
    const recovered = await mapWithConcurrency(missing, 8, async row => {
      try {
        const payload = await fetchKrakenTickerPayload([row], group.tokenized, deadlineAt, 2_500);
        const entries = Object.values(payload);
        return entries.length === 1 ? [row.venueSymbol, krakenTickerFields(entries[0])] : null;
      } catch {
        return null;
      }
    });
    for (const entry of recovered.filter(Boolean)) result.set(entry[0], entry[1]);
  }
  return new Map(catalog.map(row => [row.venueSymbol, result.get(row.venueSymbol) || marketFields(null, null, null, null)]));
}

const MARKET_COLLECTORS = Object.freeze({
  gate: gateMarket,
  kraken: krakenMarket,
  bitget: bitgetMarket,
  binance: binanceMarket,
  okx: okxMarket,
});

function normalizeCatalogListing(row) {
  if (row?.identityStatus !== 'verified') return null;
  const venue = normalizedLower(row?.venue);
  const venueSymbol = normalizedUpper(row?.venueSymbol);
  const identity = normalizeSignalIdentity(row?.canonicalSymbol, row?.category, { venue });
  const key = listingKey(venue, venueSymbol);
  const canonicalKey = identity ? assetKey(identity.category, identity.symbol) : null;
  const quote = quoteFromVenueSymbol(venue, venueSymbol);
  if (!key || !canonicalKey || !['USD', 'USDT'].includes(quote)) return null;
  return {
    venue,
    venueSymbol,
    symbol: identity.symbol,
    category: identity.category,
    quote,
    name: row?.name || null,
    marketDataProfile: row?.marketDataProfile || null,
    marketAliases: Array.isArray(row?.marketAliases) ? row.marketAliases : [],
  };
}

function spotIdentityConflicts(rows) {
  const categoriesBySymbol = new Map();
  for (const row of rows) {
    if (!categoriesBySymbol.has(row.symbol)) categoriesBySymbol.set(row.symbol, new Set());
    categoriesBySymbol.get(row.symbol).add(row.category);
  }
  return [...categoriesBySymbol]
    .filter(([, categories]) => categories.size > 1)
    .map(([symbol, categories]) => ({
      symbol,
      categories: [...categories].sort(),
      listingKeys: rows.filter(row => row.symbol === symbol)
        .map(row => listingKey(row.venue, row.venueSymbol)).sort(),
    }))
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
}

export async function collectSpotMarketSnapshot(baseUrl, options = {}) {
  const deadlineAt = Number.isFinite(options.deadlineAt)
    ? Number(options.deadlineAt)
    : Date.now() + SPOT_ANOMALY_COLLECTION_BUDGET_MS;
  const observations = Array.isArray(options.catalogObservations)
    ? options.catalogObservations
    : await collectVerifiedSpotListingSourceObservations(baseUrl, { deadlineAt });
  const observationsByVenue = new Map(observations
    .filter(row => row?.market === 'spot' && VENUE_SET.has(normalizedLower(row?.venue)))
    .map(row => [normalizedLower(row.venue), row]));
  const normalizeObservationCatalog = observation => {
    const original = Array.isArray(observation?.listings) ? observation.listings : [];
    const catalog = original.map(normalizeCatalogListing).filter(Boolean);
    return { catalog, originalCount:original.length, rejectedCount:original.length - catalog.length };
  };
  const settled = await Promise.allSettled(SPOT_ANOMALY_SOURCE_NAMES.map(async venue => {
    const observation = observationsByVenue.get(venue);
    const normalizedCatalog = normalizeObservationCatalog(observation);
    const { catalog } = normalizedCatalog;
    if (observation?.status !== 'full' || !catalog.length) {
      return {
        venue,
        ...normalizedCatalog,
        catalogStatus:'unavailable',
        fields:null,
        reason:observation?.reason || 'official catalog unavailable',
      };
    }
    const fields = await MARKET_COLLECTORS[venue](baseUrl, catalog, deadlineAt);
    return { venue, ...normalizedCatalog, catalogStatus:'full', fields, reason:null };
  }));

  const sources = {};
  const listings = [];
  let rejectedCatalogListings = 0;
  settled.forEach((result, index) => {
    const venue = SPOT_ANOMALY_SOURCE_NAMES[index];
    const observation = observationsByVenue.get(venue);
    const fallbackCatalog = normalizeObservationCatalog(observation);
    const value = result.status === 'fulfilled'
      ? result.value
      : {
          venue,
          ...fallbackCatalog,
          catalogStatus:observation?.status === 'full' ? 'full' : 'unavailable',
          fields:null,
          reason:result.reason?.message,
        };
    rejectedCatalogListings += value.rejectedCount;
    const warnings = [];
    const enriched = value.catalog.map(row => ({
      ...row,
      ...(value.fields?.get(row.venueSymbol) || marketFields(null, null, null, null)),
    }));
    const marketFieldCount = enriched.filter(row => row.currentVolumeUsd !== null).length;
    const priceFieldCount = enriched.filter(row => row.priceChange24hPct !== null).length;
    if (marketFieldCount !== enriched.length) warnings.push('VOLUME_FIELDS_INCOMPLETE');
    if (venue === 'kraken') warnings.push('KRAKEN_PRICE_CHANGE_UNAVAILABLE_BY_DESIGN');
    else if (priceFieldCount !== enriched.length) warnings.push('PRICE_CHANGE_FIELDS_INCOMPLETE');
    if (value.rejectedCount) warnings.push('CATALOG_IDENTITIES_REJECTED');
    if (value.reason) warnings.push('MARKET_OR_CATALOG_UNAVAILABLE');
    const complete = value.catalogStatus === 'full' && enriched.length > 0 && marketFieldCount === enriched.length &&
      value.rejectedCount === 0 && (venue === 'kraken' || priceFieldCount === enriched.length);
    const available = value.catalogStatus === 'full' && enriched.length > 0 && (marketFieldCount > 0 || priceFieldCount > 0);
    sources[venue] = {
      status: complete ? 'full' : available ? 'partial' : 'unavailable',
      listingCount: value.originalCount,
      marketFieldCount,
      priceFieldCount,
      warnings: [...new Set(warnings)],
    };
    listings.push(...enriched);
  });

  const duplicateKeys = new Set();
  const seenKeys = new Set();
  for (const row of listings) {
    const key = listingKey(row.venue, row.venueSymbol);
    if (seenKeys.has(key)) duplicateKeys.add(key);
    seenKeys.add(key);
  }
  const conflicts = spotIdentityConflicts(listings);
  const conflictingSymbols = new Set(conflicts.map(conflict => conflict.symbol));
  const verifiedListings = listings.filter(row =>
    !conflictingSymbols.has(row.symbol) && !duplicateKeys.has(listingKey(row.venue, row.venueSymbol))
  );
  return {
    listings: verifiedListings,
    sources,
    conflicts: [
      ...conflicts,
      ...[...duplicateKeys].sort().map(key => ({ listingKey: key, reason: 'duplicate-exact-listing-key' })),
    ],
    quarantinedListings: listings.length - verifiedListings.length + rejectedCatalogListings,
  };
}

export function utcSpotDay(timestampMs) {
  const numeric = finiteOrNull(timestampMs);
  return numeric === null ? null : Math.floor(numeric / DAY_MS) * DAY_MS;
}

export function compactSpotDailySnapshot(listings, capturedAtMs) {
  const captured = finiteOrNull(capturedAtMs);
  const day = utcSpotDay(captured);
  if (captured === null || day === null) throw new TypeError('Invalid Spot daily snapshot timestamp');
  const source = Array.isArray(listings) ? listings : [];
  const rows = source.map(row => {
    const key = listingKey(row?.venue, row?.venueSymbol);
    const canonical = assetKey(row?.category, row?.symbol);
    const volume = nonNegativeOrNull(row?.currentVolumeUsd);
    const cohort = cohortFingerprint(row);
    if (!key || !canonical || volume === null || !cohort) return null;
    return [
      normalizedLower(row.venue),
      normalizedUpper(row.venueSymbol),
      encodeCategory(row.category),
      normalizedUpper(row.symbol),
      round(volume, 2),
      cohort,
    ];
  }).filter(Boolean).sort((left, right) => `${left[0]}:${left[1]}`.localeCompare(`${right[0]}:${right[1]}`));
  return { d: day, t: captured, n: source.length, a: rows };
}

function normalizeHistoryRow(row) {
  if (!Array.isArray(row) || row.length < 6) return null;
  const venue = normalizedLower(row[0]);
  const venueSymbol = normalizedUpper(row[1]);
  const category = decodeCategory(row[2]);
  const symbol = normalizedUpper(row[3]);
  const volume = nonNegativeOrNull(row[4]);
  const cohort = String(row[5] || '');
  if (!listingKey(venue, venueSymbol) || !assetKey(category, symbol) || volume === null ||
      !/^[A-Za-z0-9_-]{8,20}$/.test(cohort)) return null;
  return [venue, venueSymbol, encodeCategory(category), symbol, round(volume, 2), cohort];
}

function validDailySnapshot(snapshot, nowDay, nowMs) {
  if (!snapshot || !Array.isArray(snapshot.a)) return null;
  const captured = finiteOrNull(snapshot.t);
  const rawDay = finiteOrNull(snapshot.d);
  const day = utcSpotDay(rawDay);
  const declaredCount = finiteOrNull(snapshot.n);
  if (captured === null || rawDay === null || day === null || day !== rawDay || day > nowDay ||
      captured > nowMs || utcSpotDay(captured) !== day || !Number.isSafeInteger(declaredCount) || declaredCount < 0) return null;
  const rows = snapshot.a.map(normalizeHistoryRow);
  if (rows.some(row => row === null) || rows.length !== declaredCount) return null;
  const keys = rows.map(row => listingKey(row[0], row[1]));
  if (new Set(keys).size !== keys.length) return null;
  return { d: day, t: captured, n: declaredCount, a: rows };
}

export function spotDailyHistoryBytes(history) {
  return Buffer.byteLength(JSON.stringify(Array.isArray(history) ? history : []), 'utf8');
}

export function normalizeSpotDailyHistory(history, nowMs = Date.now()) {
  const nowDay = utcSpotDay(nowMs);
  if (nowDay === null) throw new TypeError('Invalid Spot history clock');
  const cutoffDay = nowDay - (SPOT_ANOMALY_HISTORY_DAYS - 1) * DAY_MS;
  const byDay = new Map();
  for (const candidate of Array.isArray(history) ? history : []) {
    const snapshot = validDailySnapshot(candidate, nowDay, nowMs);
    if (!snapshot || snapshot.d < cutoffDay) continue;
    const existing = byDay.get(snapshot.d);
    if (!existing || snapshot.t > existing.t) byDay.set(snapshot.d, snapshot);
  }
  const normalized = [...byDay.values()]
    .sort((left, right) => left.d - right.d || left.t - right.t)
    .slice(-SPOT_ANOMALY_HISTORY_DAYS);
  const bytes = spotDailyHistoryBytes(normalized);
  if (bytes > HISTORY_MAX_BYTES) {
    throw new RangeError(`Spot daily history exceeds ${HISTORY_MAX_BYTES} bytes (${bytes})`);
  }
  return normalized;
}

export function mergeSpotDailyHistory(history, currentSnapshot, nowMs = Date.now()) {
  const nowDay = utcSpotDay(nowMs);
  if (nowDay === null) throw new TypeError('Invalid Spot history clock');
  const current = validDailySnapshot(currentSnapshot, nowDay, nowMs);
  if (!current) throw new TypeError('Invalid current Spot daily snapshot');
  const byDay = new Map(normalizeSpotDailyHistory(history, nowMs).map(snapshot => [snapshot.d, snapshot]));
  const existing = byDay.get(current.d);
  if (!existing || current.t >= existing.t) byDay.set(current.d, current);
  return normalizeSpotDailyHistory([...byDay.values()], nowMs);
}

function priorRows(history, priorDay) {
  const snapshot = history.find(row => row.d === priorDay);
  const rows = new Map();
  for (const row of snapshot?.a || []) {
    rows.set(listingKey(row[0], row[1]), {
      category: decodeCategory(row[2]),
      symbol: normalizedUpper(row[3]),
      volume: nonNegativeOrNull(row[4]),
      cohort: String(row[5] || ''),
    });
  }
  return { snapshot: snapshot || null, rows };
}

function normalizePerpCoverageStatus(value) {
  const status = normalizedLower(value);
  return ['full', 'partial', 'unavailable'].includes(status) ? status : 'unavailable';
}

function perpContractsByAsset(perpAssets) {
  const map = new Map();
  for (const asset of Array.isArray(perpAssets) ? perpAssets : []) {
    const key = assetKey(asset?.category, asset?.symbol);
    if (!key) continue;
    const contracts = [];
    const seen = new Set();
    for (const listing of Array.isArray(asset?.listings) ? asset.listings : []) {
      const venue = normalizedLower(listing?.venue);
      const venueSymbol = normalizedUpper(listing?.venueSymbol);
      if (!venue || !venueSymbol) continue;
      const instrumentType = String(listing?.instrumentType || 'perpetual').trim().toLowerCase();
      const contractKey = `${venue}:${venueSymbol}:${instrumentType}`;
      if (seen.has(contractKey)) continue;
      seen.add(contractKey);
      contracts.push({ venue, venueSymbol, instrumentType });
    }
    contracts.sort((left, right) => left.venue.localeCompare(right.venue) ||
      left.venueSymbol.localeCompare(right.venueSymbol) || left.instrumentType.localeCompare(right.instrumentType));
    map.set(key, contracts);
  }
  return map;
}

function publicPerpCoverage(contractsByAsset, key, coverageStatus) {
  const status = normalizePerpCoverageStatus(coverageStatus);
  const contracts = contractsByAsset.get(key) || [];
  return {
    status,
    listed: contracts.length ? true : status === 'full' ? false : null,
    contracts,
  };
}

function sourceSummary(sources) {
  return Object.fromEntries(SPOT_ANOMALY_SOURCE_NAMES.map(name => {
    const source = sources?.[name] || {};
    const status = ['full', 'partial', 'unavailable'].includes(normalizedLower(source.status))
      ? normalizedLower(source.status)
      : 'unavailable';
    return [name, {
      status,
      listingCount: Math.max(0, Number.isSafeInteger(Number(source.listingCount)) ? Number(source.listingCount) : 0),
      marketFieldCount: Math.max(0, Number.isSafeInteger(Number(source.marketFieldCount)) ? Number(source.marketFieldCount) : 0),
      priceFieldCount: Math.max(0, Number.isSafeInteger(Number(source.priceFieldCount)) ? Number(source.priceFieldCount) : 0),
      warnings: Array.isArray(source.warnings) ? [...new Set(source.warnings.map(String).filter(Boolean))] : [],
    }];
  }));
}

// Daily history stores volume only. A venue can therefore remain Partial for
// an unavailable price-change field while still contributing a complete,
// exact listing-level volume anchor. Catalog rejection, a missing volume, or
// an identity conflict still blocks the whole write and makes Cron return 503.
export function isSpotAnomalyHistoryComparable(sources, conflicts = []) {
  if (Array.isArray(conflicts) && conflicts.length) return false;
  return SPOT_ANOMALY_SOURCE_NAMES.every(name => {
    const source = sources?.[name];
    return source && normalizedLower(source.status) !== 'unavailable' &&
      Number.isSafeInteger(source.listingCount) && source.listingCount > 0 &&
      Number.isSafeInteger(source.marketFieldCount) &&
      source.marketFieldCount === source.listingCount;
  });
}

function rowStatus({ sourceStatus, volumeTriggered, perpStatus }) {
  if (sourceStatus !== 'full' || perpStatus !== 'full') return 'partial';
  return volumeTriggered ? 'estimated' : 'full';
}

export function buildSpotVolumePriceAnomalies(currentListings, dailyHistory, capturedAtMs, options = {}) {
  const captured = finiteOrNull(capturedAtMs);
  if (captured === null) throw new TypeError('Invalid Spot anomaly timestamp');
  const generatedAt = new Date(captured).toISOString();
  const sources = sourceSummary(options.sources);
  const availableSources = Object.values(sources).filter(source => source.status !== 'unavailable').length;
  const fullSources = Object.values(sources).filter(source => source.status === 'full').length;
  const conflicts = Array.isArray(options.conflicts) ? options.conflicts : [];
  const listings = (Array.isArray(currentListings) ? currentListings : []).filter(row =>
    listingKey(row?.venue, row?.venueSymbol) && assetKey(row?.category, row?.symbol)
  );
  let history = [];
  let historyUnavailable = options.historyAvailable === false;
  if (!historyUnavailable) {
    try { history = normalizeSpotDailyHistory(dailyHistory, captured); }
    catch { historyUnavailable = true; }
  }
  const priorDayMs = utcSpotDay(captured) - DAY_MS;
  const prior = priorRows(history, priorDayMs);
  const contractsByAsset = perpContractsByAsset(options.perpAssets);
  const perpStatus = normalizePerpCoverageStatus(options.perpCoverageStatus);
  const allAlerts = [];
  let volumeAvailableListings = 0;
  let priorVolumeAvailableListings = 0;
  let priceAvailableListings = 0;
  let liquidityEligibleListings = 0;
  let volumeComparableListings = 0;
  let priceComparableListings = 0;
  let filteredLowLiquidity = 0;
  let filterUnknown = 0;

  for (const row of listings) {
    const key = listingKey(row.venue, row.venueSymbol);
    const canonicalKey = assetKey(row.category, row.symbol);
    const currentVolume = nonNegativeOrNull(row.currentVolumeUsd);
    const priceChange = finiteOrNull(row.priceChange24hPct);
    const currentCohort = cohortFingerprint(row);
    const previous = prior.rows.get(key) || null;
    const priorComparable = previous && previous.category === row.category && previous.symbol === row.symbol &&
      previous.cohort === currentCohort && previous.volume !== null;
    const yesterdayVolume = priorComparable ? previous.volume : null;
    // Classification uses the exact same cent-/5dp-rounded values published
    // in the payload. Otherwise a threshold-edge row could display 3.0000x or
    // +15.00000% while carrying the opposite server trigger.
    const publishedCurrentVolume = currentVolume === null ? null : round(currentVolume, 2);
    const publishedYesterdayVolume = yesterdayVolume === null ? null : round(yesterdayVolume, 2);
    const publishedPriceChange = priceChange === null ? null : round(priceChange, 5);
    const ratio = publishedYesterdayVolume !== null && publishedYesterdayVolume > 0 && publishedCurrentVolume !== null
      ? round(publishedCurrentVolume / publishedYesterdayVolume, 4)
      : null;
    if (currentVolume !== null) volumeAvailableListings += 1;
    if (currentVolume !== null && yesterdayVolume !== null) priorVolumeAvailableListings += 1;
    if (priceChange !== null) priceAvailableListings += 1;
    if (publishedCurrentVolume === null) {
      filterUnknown += 1;
      continue;
    }
    if (publishedCurrentVolume < SPOT_ANOMALY_THRESHOLDS.minCurrentVolumeUsd) {
      filteredLowLiquidity += 1;
      continue;
    }
    liquidityEligibleListings += 1;
    if (ratio !== null) volumeComparableListings += 1;
    if (publishedPriceChange !== null) priceComparableListings += 1;
    const volumeTriggered = ratio !== null && ratio >= SPOT_ANOMALY_THRESHOLDS.volumeRatio;
    const priceTriggered = publishedPriceChange !== null && publishedPriceChange >= SPOT_ANOMALY_THRESHOLDS.priceRisePct;
    if (!volumeTriggered && !priceTriggered) continue;
    const trigger = volumeTriggered && priceTriggered
      ? 'both'
      : volumeTriggered ? 'volume_spike' : 'price_surge';
    const sourceStatus = sources[row.venue]?.status || 'unavailable';
    const perps = publicPerpCoverage(contractsByAsset, canonicalKey, perpStatus);
    const reasonCodes = [];
    if (volumeTriggered) reasonCodes.push('VOLUME_SPIKE');
    if (priceTriggered) reasonCodes.push('PRICE_SURGE');
    if (yesterdayVolume === 0) reasonCodes.push('ZERO_PRIOR_VOLUME');
    if (perps.status !== 'full') reasonCodes.push('PERP_COVERAGE_INCOMPLETE');
    allAlerts.push({
      listingKey: key,
      assetKey: canonicalKey,
      symbol: row.symbol,
      category: row.category,
      venue: row.venue,
      venueSymbol: row.venueSymbol,
      quote: row.quote,
      currentVolumeUsd: publishedCurrentVolume,
      yesterdayVolumeUsd: publishedYesterdayVolume,
      volumeRatio: ratio,
      priceChange24hPct: publishedPriceChange,
      trigger,
      volumeTriggered,
      priceTriggered,
      fieldStatus: {
        currentVolume: ['full', 'estimated'].includes(row.volumeStatus) ? row.volumeStatus : 'unavailable',
        yesterdayVolume: publishedYesterdayVolume === null ? 'unavailable' : 'estimated',
        volumeRatio: ratio === null ? 'unavailable' : 'estimated',
        priceChange: publishedPriceChange === null ? 'unavailable' : 'full',
        perpCoverage: perps.status,
      },
      perpCoverage: perps,
      status: rowStatus({ sourceStatus, volumeTriggered, perpStatus: perps.status }),
      reasonCodes,
    });
  }

  const triggerWeight = { both: 3, volume_spike: 2, price_surge: 1 };
  allAlerts.sort((left, right) =>
    triggerWeight[right.trigger] - triggerWeight[left.trigger] ||
    (right.volumeRatio ?? -Infinity) - (left.volumeRatio ?? -Infinity) ||
    (right.priceChange24hPct ?? -Infinity) - (left.priceChange24hPct ?? -Infinity) ||
    right.currentVolumeUsd - left.currentVolumeUsd ||
    left.listingKey.localeCompare(right.listingKey)
  );
  const rankedAlerts = allAlerts.map((row, index) => ({ rank: index + 1, ...row }));
  const volumeSpike = allAlerts.filter(row => row.volumeTriggered).length;
  const priceSurge = allAlerts.filter(row => row.priceTriggered).length;
  const both = allAlerts.filter(row => row.trigger === 'both').length;
  const perpListed = allAlerts.filter(row => row.perpCoverage.listed === true).length;

  let historyStatus;
  if (historyUnavailable) historyStatus = 'unavailable';
  else if (!prior.snapshot) historyStatus = 'warming';
  else if (liquidityEligibleListings === 0 || volumeComparableListings === liquidityEligibleListings) historyStatus = 'full';
  else if (volumeComparableListings > 0) historyStatus = 'partial';
  else historyStatus = 'warming';

  let status;
  if (!listings.length || availableSources === 0) status = 'unavailable';
  else if (fullSources !== SPOT_ANOMALY_SOURCE_NAMES.length || conflicts.length || historyUnavailable ||
      perpStatus !== 'full' || historyStatus === 'partial' ||
      priceComparableListings !== liquidityEligibleListings) status = 'partial';
  else if (historyStatus === 'warming') status = 'warming';
  else status = 'full';

  const persistence = options.persistence && typeof options.persistence === 'object'
    ? options.persistence
    : {
        mode: 'vercel-runtime-cache',
        status: historyUnavailable ? 'unavailable' : 'partial',
        namespace: SPOT_ANOMALY_HISTORY_NAMESPACE,
        writer: { requested: false, succeeded: null },
        writeStatus: historyUnavailable ? 'unavailable' : 'read-only',
        error: historyUnavailable ? 'spot daily history unavailable' : null,
      };
  return {
    formulaVersion: SPOT_ANOMALY_FORMULA_VERSION,
    generatedAt,
    status,
    thresholds: { ...SPOT_ANOMALY_THRESHOLDS, logic: 'or' },
    methodology: {
      grain: 'exact-venue-instrument',
      currentVolume: 'official rolling-24h quote turnover for the exact venue instrument',
      priorVolume: 'last complete rolling-24h observation sealed on the prior UTC day',
      volumeComparison: 'current rolling-24h turnover divided by the prior sealed UTC-day anchor; not exact natural-day volume',
      priceChange: 'official rolling-24h percentage change where the venue exposes that semantic',
      krakenPriceChange: 'unavailable because Kraken o is the current UTC-day open, not a rolling-24h open',
    },
    coverage: {
      expectedSources: SPOT_ANOMALY_SOURCE_NAMES.length,
      availableSources,
      fullSources,
      verifiedListings: listings.length,
      quarantinedListings: Math.max(0, Number(options.quarantinedListings) || 0),
      identityConflicts: conflicts.length,
      volumeAvailableListings,
      priorVolumeAvailableListings,
      priceAvailableListings,
      liquidityEligibleListings,
      volumeComparableListings,
      priceComparableListings,
    },
    counts: {
      alerts: allAlerts.length,
      volumeSpike,
      priceSurge,
      both,
      perpListed,
      filteredLowLiquidity,
      filterUnknown,
    },
    history: {
      status: historyStatus,
      namespace: SPOT_ANOMALY_HISTORY_NAMESPACE,
      cadence: 'utc-daily-sealed',
      retentionDays: SPOT_ANOMALY_HISTORY_DAYS,
      storedDays: history.length,
      priorDay: prior.snapshot ? new Date(priorDayMs).toISOString() : null,
      oldestAt: history[0]?.d !== undefined ? new Date(history[0].d).toISOString() : null,
      newestAt: history.at(-1)?.d !== undefined ? new Date(history.at(-1).d).toISOString() : null,
    },
    persistence,
    sources,
    rows: rankedAlerts.slice(0, 100),
  };
}

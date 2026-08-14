import { normalizeSignalIdentity } from './security-identity.js';

const HISTORY_POINT_LIMIT = 48;

export const SIGNAL_SCHEMA_VERSION = 'rwa-signal-snapshot/v1';
export const SIGNAL_ASSET_LIMIT = 100;
export const HISTORY_ROW_SCHEMA = Object.freeze([
  'symbol',
  'category',
  'volume24hUsd',
  'openInterestUsd',
  'maxAbsFundingAnnualizedPct',
  'priceUsd',
  'change24hPct',
  'priceDispersionPct',
  'venueCount',
]);
export const RESPONSE_HISTORY_POINT_SCHEMA = Object.freeze([
  'capturedAtMs',
  'volume24hUsd',
  'openInterestUsd',
  'maxAbsFundingAnnualizedPct',
  'priceUsd',
  'change24hPct',
  'priceDispersionPct',
]);

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
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

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(Math.max(value, minimum), maximum);
}

function percentDelta(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function fieldStatus(values, total) {
  const observed = values.filter(Number.isFinite).length;
  if (!observed) return 'unavailable';
  return observed === total ? 'full' : 'partial';
}

export function canonicalSignalSymbol(symbol, category) {
  return normalizeSignalIdentity(symbol, category)?.symbol || null;
}

function annualizedFundingPct(listing) {
  const rate = finiteOrNull(listing?.fundingRate);
  const intervalHours = positiveOrNull(listing?.fundingIntervalHours);
  if (rate === null || intervalHours === null) return null;
  return rate * (24 / intervalHours) * 365 * 100;
}

export function aggregateSignalListings(listings, limit = SIGNAL_ASSET_LIMIT) {
  const rejected = [];
  const normalizedListings = [];

  for (const listing of Array.isArray(listings) ? listings : []) {
    const identity = normalizeSignalIdentity(listing?.symbol, listing?.category);
    const category = identity?.category || null;
    const symbol = identity?.symbol || null;
    const venue = String(listing?.venue || '').toLowerCase();
    const venueSymbol = String(listing?.venueSymbol || '');
    if (!symbol || !venue || !venueSymbol) {
      rejected.push({ venue: venue || null, venueSymbol: venueSymbol || null, reason: 'invalid-normalized-listing' });
      continue;
    }
    normalizedListings.push({ ...listing, symbol, category, venue, venueSymbol });
  }

  // Category is part of identity, but a venue ticker collision must be
  // quarantined before category-qualified aggregation. Grouping by
  // `category:symbol` first would make this conflict check unreachable and
  // could let an Equity/Index (or Commodity) ticker collision into Radar.
  const categoriesBySymbol = new Map();
  for (const row of normalizedListings) {
    if (!categoriesBySymbol.has(row.symbol)) categoriesBySymbol.set(row.symbol, new Set());
    categoriesBySymbol.get(row.symbol).add(row.category);
  }
  const conflictingSymbols = new Set([...categoriesBySymbol]
    .filter(([, categories]) => categories.size > 1)
    .map(([symbol]) => symbol));
  const conflicts = [];
  for (const symbol of [...conflictingSymbols].sort()) {
    const rows = normalizedListings.filter(row => row.symbol === symbol);
    conflicts.push({
      symbol,
      categories:[...categoriesBySymbol.get(symbol)].sort(),
      venues:[...new Set(rows.map(row => row.venue))].sort(),
    });
  }

  const groups = new Map();
  for (const row of normalizedListings) {
    if (conflictingSymbols.has(row.symbol)) continue;
    const key = `${row.category}:${row.symbol}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const assets = [];
  for (const [, rows] of groups) {
    const symbol = rows[0].symbol;
    const categories = [...new Set(rows.map(row => row.category))];

    const prices = rows.map(row => positiveOrNull(row.priceUsd)).filter(Number.isFinite);
    const volumes = rows.map(row => finiteOrNull(row.volume24hUsd));
    const openInterest = rows.map(row => finiteOrNull(row.openInterestUsd));
    const changes = rows.map(row => finiteOrNull(row.change24hPct)).filter(Number.isFinite);
    const fundingValues = rows.map(row => annualizedFundingPct(row)).filter(Number.isFinite);
    const priceMedian = median(prices);
    const comparablePrices = priceMedian === null
      ? []
      : prices.filter(price => price >= priceMedian * 0.5 && price <= priceMedian * 1.5);
    const priceDispersionPct = comparablePrices.length >= 2
      ? ((Math.max(...comparablePrices) - Math.min(...comparablePrices)) / Math.min(...comparablePrices)) * 100
      : null;
    const maxAbsFunding = fundingValues.length
      ? fundingValues.reduce((selected, value) => Math.abs(value) > Math.abs(selected) ? value : selected, fundingValues[0])
      : null;
    const volumeValues = volumes.filter(Number.isFinite);
    const oiValues = openInterest.filter(Number.isFinite);
    const venues = [...new Set(rows.map(row => row.venue))].sort();

    assets.push({
      symbol,
      category: categories[0],
      venues,
      venueCount: venues.length,
      listingCount: rows.length,
      volume24hUsd: volumeValues.length ? volumeValues.reduce((sum, value) => sum + value, 0) : null,
      openInterestUsd: oiValues.length ? oiValues.reduce((sum, value) => sum + value, 0) : null,
      maxAbsFundingAnnualizedPct: maxAbsFunding,
      priceUsd: priceMedian,
      change24hPct: median(changes),
      priceDispersionPct,
      quarantinedPricePoints: prices.length - comparablePrices.length,
      fieldStatus: {
        volume24hUsd: fieldStatus(volumes, rows.length),
        openInterestUsd: fieldStatus(openInterest, rows.length),
        funding: fieldStatus(rows.map(row => annualizedFundingPct(row)), rows.length),
        price: fieldStatus(rows.map(row => positiveOrNull(row.priceUsd)), rows.length),
        change24h: fieldStatus(rows.map(row => finiteOrNull(row.change24hPct)), rows.length),
        priceDispersion: priceDispersionPct === null ? 'unavailable' : 'estimated',
      },
      listings: rows.map(row => ({
        venue: row.venue,
        venueSymbol: row.venueSymbol,
        instrumentType: String(row.instrumentType || 'perpetual').trim().toLowerCase(),
        priceUsd: positiveOrNull(row.priceUsd),
        volume24hUsd: finiteOrNull(row.volume24hUsd),
        volumeMethod: String(row.volumeMethod || '').trim().toLowerCase() || null,
        volumeStatus: String(row.volumeStatus || '').trim().toLowerCase() || 'unavailable',
        openInterestUsd: finiteOrNull(row.openInterestUsd),
        fundingAnnualizedPct: annualizedFundingPct(row),
        change24hPct: finiteOrNull(row.change24hPct),
      })),
    });
  }

  assets.sort((left, right) => {
    const leftActivity = (left.volume24hUsd ?? 0) + (left.openInterestUsd ?? 0);
    const rightActivity = (right.volume24hUsd ?? 0) + (right.openInterestUsd ?? 0);
    return rightActivity - leftActivity || left.symbol.localeCompare(right.symbol);
  });
  return {
    assets: assets.slice(0, limit),
    // Daily contract-volume monitoring must cover the complete verified
    // canonical universe. Keeping it server-only avoids widening the existing
    // activity-ranked Top 100 response/history contract.
    allAssets: assets,
    totalAssetCount: assets.length,
    conflicts,
    rejected,
  };
}

export function compactSignalSnapshot(assets, capturedAtMs, limit = SIGNAL_ASSET_LIMIT) {
  const totals = assets.reduce((summary, asset) => {
    if (Number.isFinite(asset.volume24hUsd)) summary.volume24hUsd += asset.volume24hUsd;
    else summary.missingVolume += 1;
    if (Number.isFinite(asset.openInterestUsd)) summary.openInterestUsd += asset.openInterestUsd;
    else summary.missingOpenInterest += 1;
    summary.listings += asset.listingCount;
    return summary;
  }, { volume24hUsd: 0, openInterestUsd: 0, missingVolume: 0, missingOpenInterest: 0, listings: 0 });
  return {
    t: Math.floor(capturedAtMs / 3_600_000) * 3_600_000,
    m: [round(totals.volume24hUsd, 2), round(totals.openInterestUsd, 2), assets.length,
      totals.listings, totals.missingVolume, totals.missingOpenInterest],
    a: assets.slice(0, limit).map(asset => [
      asset.symbol,
      asset.category,
      round(asset.volume24hUsd, 2),
      round(asset.openInterestUsd, 2),
      round(asset.maxAbsFundingAnnualizedPct, 6),
      round(asset.priceUsd, 6),
      round(asset.change24hPct, 5),
      round(asset.priceDispersionPct, 5),
      asset.venueCount,
    ]),
  };
}

function decodeHistoryRow(row, capturedAtMs) {
  if (!Array.isArray(row) || row.length < HISTORY_ROW_SCHEMA.length) return null;
  const symbol = String(row[0] || '');
  if (!symbol) return null;
  return {
    capturedAtMs,
    symbol,
    category: String(row[1] || ''),
    volume24hUsd: finiteOrNull(row[2]),
    openInterestUsd: finiteOrNull(row[3]),
    maxAbsFundingAnnualizedPct: finiteOrNull(row[4]),
    priceUsd: positiveOrNull(row[5]),
    change24hPct: finiteOrNull(row[6]),
    priceDispersionPct: finiteOrNull(row[7]),
    venueCount: finiteOrNull(row[8]),
  };
}

function historyBySymbol(snapshots) {
  const bySymbol = new Map();
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const capturedAtMs = finiteOrNull(snapshot?.t);
    if (capturedAtMs === null || !Array.isArray(snapshot?.a)) continue;
    for (const compactRow of snapshot.a) {
      const row = decodeHistoryRow(compactRow, capturedAtMs);
      if (!row) continue;
      if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
      bySymbol.get(row.symbol).push(row);
    }
  }
  for (const rows of bySymbol.values()) rows.sort((left, right) => left.capturedAtMs - right.capturedAtMs);
  return bySymbol;
}

function robustStats(current, historical) {
  const values = historical.filter(Number.isFinite);
  if (!Number.isFinite(current) || values.length < 3) {
    return { samples: values.length, median: median(values), zScore: null };
  }
  const center = median(values);
  const deviations = values.map(value => Math.abs(value - center));
  const mad = median(deviations);
  if (!Number.isFinite(mad) || mad === 0) {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
    const standardDeviation = Math.sqrt(variance);
    return {
      samples: values.length,
      median: center,
      // A break away from a truly constant baseline is maximally informative,
      // not unavailable. Saturate the signed z-score so an upward Volume/OI
      // break still reaches High while an unchanged series remains Normal.
      zScore: standardDeviation > 0 ? (current - mean) / standardDeviation : (current === center ? 0 : Math.sign(current - center) * 10),
    };
  }
  return { samples: values.length, median: center, zScore: (current - center) / (1.4826 * mad) };
}

function historyComponent(current, historical, direction = 'positive', totalSamples = historical.length + 1) {
  if (!Number.isFinite(current)) return { value: null, score: null, zScore: null, baselineMedian: null, samples: 0, status: 'unavailable' };
  const transformedCurrent = current >= 0 ? Math.log1p(current) : current;
  const transformedHistory = historical.map(value => value >= 0 ? Math.log1p(value) : value);
  const stats = robustStats(transformedCurrent, transformedHistory);
  const zScore = stats.zScore;
  const magnitude = zScore === null ? null : direction === 'absolute' ? Math.abs(zScore) : Math.max(zScore, 0);
  return {
    value: current,
    score: stats.samples < 24 || magnitude === null ? null : round(clamp(magnitude * 22), 1),
    zScore: round(zScore, 3),
    baselineMedian: median(historical),
    samples: stats.samples,
    status: totalSamples >= 168 ? 'estimated' : stats.samples >= 24 ? 'partial' : 'unavailable',
  };
}

function pointComponent(value, score) {
  if (!Number.isFinite(value)) return { value: null, score: null, status: 'unavailable' };
  return { value, score: round(clamp(score), 1), status: 'estimated' };
}

function thresholdScore(value, watchAt, highAt, maximumAt) {
  const magnitude = Math.abs(value);
  if (magnitude < watchAt) return (magnitude / watchAt) * 49;
  if (magnitude < highAt) return 50 + ((magnitude - watchAt) / (highAt - watchAt)) * 24;
  if (magnitude < maximumAt) return 75 + ((magnitude - highAt) / (maximumAt - highAt)) * 25;
  return 100;
}

function signalLevel(score) {
  if (!Number.isFinite(score)) return 'unavailable';
  if (score >= 75) return 'high';
  if (score >= 50) return 'watch';
  return 'normal';
}

function compactResponseHistory(rows, current, capturedAtMs) {
  const points = rows.slice(-(HISTORY_POINT_LIMIT - 1)).map(row => [
    row.capturedAtMs,
    row.volume24hUsd,
    row.openInterestUsd,
    row.maxAbsFundingAnnualizedPct,
    row.priceUsd,
    row.change24hPct,
    row.priceDispersionPct,
  ]);
  points.push([
    capturedAtMs,
    current.volume24hUsd,
    current.openInterestUsd,
    current.maxAbsFundingAnnualizedPct,
    current.priceUsd,
    current.change24hPct,
    current.priceDispersionPct,
  ]);
  return points;
}

export function attachSignalAnalysis(assets, historicalSnapshots, capturedAtMs, options = {}) {
  const snapshotComparable = options.snapshotComparable !== false;
  const historyAvailable = options.historyAvailable !== false;
  const histories = historyBySymbol(historicalSnapshots);
  return assets.map(asset => {
    const rows = (histories.get(asset.symbol) || []).filter(row => row.category === asset.category);
    const previous = rows[rows.length - 1] || null;
    const totalSamples = rows.length + 1;
    const volume = historyComponent(asset.volume24hUsd, rows.map(row => row.volume24hUsd), 'positive', totalSamples);
    const openInterest = historyComponent(asset.openInterestUsd, rows.map(row => row.openInterestUsd), 'positive', totalSamples);
    const funding = pointComponent(asset.maxAbsFundingAnnualizedPct,
      thresholdScore(asset.maxAbsFundingAnnualizedPct ?? 0, 50, 100, 150));
    const priceMove = pointComponent(asset.change24hPct,
      thresholdScore(asset.change24hPct ?? 0, 5, 10, 20));
    const priceDispersion = pointComponent(asset.priceDispersionPct,
      thresholdScore(asset.priceDispersionPct ?? 0, 1, 3, 5));
    const scoredComponents = [volume, openInterest, funding, priceMove, priceDispersion]
      .filter(component => Number.isFinite(component.score));
    const triggeredCount = scoredComponents.filter(component => component.score >= 50).length;
    const score = scoredComponents.length
      ? clamp(Math.max(...scoredComponents.map(component => component.score)) + Math.max(0, triggeredCount - 1) * 5)
      : null;
    const historicalSamples = rows.length;
    const historyStatus = !historyAvailable
      ? 'unavailable'
      : totalSamples >= 168 ? 'full' : totalSamples >= 24 ? 'partial' : 'warming';
    const componentEntries = Object.entries({ volume, openInterest, funding, priceMove, priceDispersion })
      .filter(([, component]) => Number.isFinite(component.score))
      .sort((left, right) => right[1].score - left[1].score || left[0].localeCompare(right[0]));
    const primaryKey = componentEntries[0]?.[0] || 'unavailable';
    const primaryLabels = { volume:'Volume spike', openInterest:'OI build', funding:'Funding extreme', priceMove:'Price move', priceDispersion:'Cross-venue dispersion', unavailable:'Unavailable' };
    const pointLevel = signalLevel(score);
    const level = pointLevel === 'normal' && (!snapshotComparable || historyStatus !== 'full')
      ? historyStatus === 'unavailable' ? 'unavailable' : 'warming'
      : pointLevel;
    const reasonCodes = [];
    if (historyStatus === 'warming') reasonCodes.push('BASELINE_WARMING');
    if (historyStatus === 'partial') reasonCodes.push('BASELINE_PARTIAL');
    if (historyStatus === 'unavailable') reasonCodes.push('BASELINE_UNAVAILABLE');
    if (!snapshotComparable) reasonCodes.push('SOURCE_SNAPSHOT_INCOMPARABLE');
    if (funding.score >= 50) reasonCodes.push('FUNDING_THRESHOLD');
    if (priceMove.score >= 50) reasonCodes.push('PRICE_MOVE_THRESHOLD');
    if (priceDispersion.score >= 50) reasonCodes.push('PRICE_DISPERSION_THRESHOLD');
    if (volume.score >= 50) reasonCodes.push('VOLUME_ROBUST_Z');
    if (openInterest.score >= 50) reasonCodes.push('OI_ROBUST_Z');
    if (asset.quarantinedPricePoints > 0) reasonCodes.push('PRICE_POINTS_QUARANTINED');
    if (Object.values(asset.fieldStatus || {}).some(status => status === 'partial')) reasonCodes.push('SOURCE_FIELDS_PARTIAL');
    if (Object.values(asset.fieldStatus || {}).some(status => status === 'unavailable')) reasonCodes.push('SOURCE_FIELDS_UNAVAILABLE');

    return {
      ...asset,
      signal: {
        formulaVersion: 'rwa-radar-1.0',
        score: round(score, 1),
        level,
        status: score === null || (pointLevel === 'normal' && historyStatus === 'unavailable') ? 'unavailable' : historyStatus === 'full' && snapshotComparable &&
          !reasonCodes.some(code => code.startsWith('SOURCE_FIELDS_')) ? 'estimated' : 'partial',
        baselineStatus: historyStatus,
        primaryType: { key: primaryKey, label: primaryLabels[primaryKey] },
        reasonCodes,
        confidence: round(clamp((totalSamples / 168) * 70 + (scoredComponents.length / 5) * 30), 1),
        components: { volume, openInterest, funding, priceMove, priceDispersion },
      },
      previous: previous ? {
        capturedAt: new Date(previous.capturedAtMs).toISOString(),
        volumeDeltaPct: round(percentDelta(asset.volume24hUsd, previous.volume24hUsd), 2),
        openInterestDeltaPct: round(percentDelta(asset.openInterestUsd, previous.openInterestUsd), 2),
        priceDeltaPct: round(percentDelta(asset.priceUsd, previous.priceUsd), 3),
        fundingDeltaPctPoints: Number.isFinite(asset.maxAbsFundingAnnualizedPct) && Number.isFinite(previous.maxAbsFundingAnnualizedPct)
          ? round(asset.maxAbsFundingAnnualizedPct - previous.maxAbsFundingAnnualizedPct, 4)
          : null,
      } : null,
      history: {
        status: historyStatus,
        availableSamples: totalSamples,
        returnedSamples: Math.min(totalSamples, HISTORY_POINT_LIMIT),
        points: compactResponseHistory(rows, asset, capturedAtMs),
      },
    };
  }).sort((left, right) => (right.signal.score ?? -1) - (left.signal.score ?? -1) ||
    (right.volume24hUsd ?? 0) - (left.volume24hUsd ?? 0) || left.symbol.localeCompare(right.symbol));
}

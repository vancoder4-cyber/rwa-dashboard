// Official traditional-market activity for RWA underlyings.
//
// Equities/ETFs: Nasdaq public market-activity summary (current share volume
// and Nasdaq's displayed average volume).
// Options: OCC batch-processing reports (latest completed trading day plus
// the same weekday in each of the preceding four weeks).

// This endpoint intentionally does not scrape Cboe's delayed quote table:
// Cboe's page explicitly prohibits automated extraction.

// Usage: /api/tradfi-activity?symbols=AAPL,TSLA,NVDA,SPY

// The public sources used here are delayed/end-of-day informational data. A
// licensed Nasdaq Basic/NLS + OPRA feed is required for a true real-time view.

const NASDAQ_SUMMARY = 'https://api.nasdaq.com/api/quote';
const OCC_VOLUME = 'https://marketdata.theocc.com/onn-volume-download';
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

function yyyymmdd(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('');
}

function addUtcDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function normalizeOccRoot(symbol) {
  // OCC adjusted roots can be prefixed by a digit (for example 2AAPL). They
  // still clear against the same underlying and should contribute to volume.
  return String(symbol || '').trim().toUpperCase().replace(/^\d+/, '');
}

function parseOccTotals(text) {
  const totals = {};
  let currentRoot = '';

  for (const line of String(text || '').split(/\r?\n/)) {
    const columns = line.split('\t').map(value => value.trim());
    if (columns.length < 2) continue;

    if (columns[0] && columns[1] && columns[0] !== 'Group' && columns[0] !== 'Symbol') {
      currentRoot = normalizeOccRoot(columns[1]);
    }

    if (columns[0] === 'Symbol' && columns[1] === 'Total' && currentRoot) {
      const total = [...columns].reverse().map(asNumber).find(Number.isFinite);
      if (Number.isFinite(total)) totals[currentRoot] = (totals[currentRoot] || 0) + total;
    }
  }

  return totals;
}

function occUrl(reportType, reportDate) {
  const params = new URLSearchParams({
    productKind: 'options',
    reportType,
    reportDate,
    reportFormat: 'volume',
    issues: 'all',
    reportView: 'totals',
  });
  return `${OCC_VOLUME}?${params}`;
}

async function fetchText(url, timeoutMs = 18000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
  return response.text();
}

async function findLatestOccDay() {
  // OCC is normally T+1 and may not have Friday's report on Saturday. Probe a
  // bounded seven-day window and keep the first report with actual rows.
  let candidate = addUtcDays(new Date(), -1);
  for (let offset = 0; offset < 7; offset += 1) {
    const reportDate = yyyymmdd(addUtcDays(candidate, -offset));
    try {
      const text = await fetchText(occUrl('D', reportDate));
      const totals = parseOccTotals(text);
      if (Object.keys(totals).length) return { reportDate, text, totals };
    } catch (error) {
      if (offset === 6) throw error;
    }
  }
  throw new Error('No completed OCC trading-day report found');
}

async function fetchOccActivity(symbols) {
  const latest = await findLatestOccDay();
  const latestDate = new Date(`${latest.reportDate.slice(0, 4)}-${latest.reportDate.slice(4, 6)}-${latest.reportDate.slice(6, 8)}T12:00:00Z`);

  // OCC's weekly download currently returns a date range but no symbol rows.
  // Four daily reports at seven-day intervals provide an official, bounded
  // same-weekday baseline without leaking today's volume into the baseline.
  const comparisonDates = [7, 14, 21, 28].map(days => yyyymmdd(addUtcDays(latestDate, -days)));
  const comparisonReports = await Promise.all(comparisonDates.map(async reportDate => {
    try {
      const text = await fetchText(occUrl('D', reportDate));
      return { reportDate, totals: parseOccTotals(text), ok: true };
    } catch (error) {
      console.error('[tradfi-activity] OCC comparison report failed', reportDate, error.message);
      return { reportDate, totals: {}, ok: false };
    }
  }));

  const completedReports = comparisonReports.filter(report => report.ok && Object.keys(report.totals).length);
  const baselineSamples = completedReports.length;
  const rows = {};

  for (const symbol of symbols) {
    const current = latest.totals[symbol] || 0;
    const baselineTotal = completedReports.reduce((sum, report) => sum + (report.totals[symbol] || 0), 0);
    const average = baselineSamples > 0 ? baselineTotal / baselineSamples : null;
    const hasOfficialSeries = current > 0 || baselineTotal > 0;
    rows[symbol] = {
      volume: hasOfficialSeries ? current : null,
      averageVolume: average,
      relativeVolume: average > 0 ? current / average : null,
      baselineSamples,
      status: hasOfficialSeries && baselineSamples === 4 ? 'full' : hasOfficialSeries ? 'partial' : 'unavailable',
    };
  }

  return {
    asOf: latest.reportDate,
    baselineReports: completedReports.map(report => report.reportDate),
    baselineSamples,
    rows,
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchNasdaqAssetClass(symbol, assetClass) {
  const url = `${NASDAQ_SUMMARY}/${encodeURIComponent(symbol)}/summary?assetclass=${assetClass}`;
  const response = await fetch(url, {
    headers: SOURCE_HEADERS,
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  return payload?.data?.summaryData || null;
}

async function fetchNasdaqIdentity(symbol, assetClass) {
  const url = `${NASDAQ_SUMMARY}/${encodeURIComponent(symbol)}/info?assetclass=${assetClass}`;
  const response = await fetch(url, {
    headers: SOURCE_HEADERS,
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  return payload?.data || null;
}

async function fetchNasdaqSummary(symbol, preferredAssetClass = 'stocks') {
  try {
    let assetClass = preferredAssetClass === 'etf' ? 'etf' : 'stocks';
    let [summary, identity] = await Promise.all([
      fetchNasdaqAssetClass(symbol, assetClass),
      fetchNasdaqIdentity(symbol, assetClass),
    ]);
    if (!summary?.ShareVolume?.value || !identity?.companyName) {
      assetClass = assetClass === 'etf' ? 'stocks' : 'etf';
      [summary, identity] = await Promise.all([
        fetchNasdaqAssetClass(symbol, assetClass),
        fetchNasdaqIdentity(symbol, assetClass),
      ]);
    }
    summary = summary || {};
    const actualAssetClass = String(identity?.assetClass || '').toUpperCase();
    const expectedAssetClass = preferredAssetClass === 'etf' ? 'ETF' : 'STOCKS';
    const identityStatus = identity?.companyName
      ? (actualAssetClass === expectedAssetClass ? 'confirmed' : 'mismatch')
      : 'unavailable';
    const rawVolume = asNumber(summary.ShareVolume?.value);
    const rawAverageVolume = asNumber(
      summary.AverageVolume?.value ??
      summary.AvgDailyVol20Days?.value ??
      summary.FiftyDayAvgDailyVol?.value ??
      summary.AvgDailyVol65Days?.value
    );
    const volume = identityStatus === 'confirmed' ? rawVolume : null;
    const averageVolume = identityStatus === 'confirmed' ? rawAverageVolume : null;
    const averageWindow = summary.AvgDailyVol20Days?.value ? '20 sessions' : 'Nasdaq displayed average';
    const exchange = String(summary.Exchange?.value || (assetClass === 'etf' ? 'US ETF' : '')).trim() || null;
    const price = asNumber(summary.PreviousClose?.value);
    return {
      symbol,
      assetClass: actualAssetClass || null,
      officialName: identity?.companyName || null,
      stockType: identity?.stockType || null,
      identityStatus,
      exchange,
      volume,
      averageVolume,
      averageWindow,
      relativeVolume: volume !== null && averageVolume > 0 ? volume / averageVolume : null,
      previousClose: price,
      status: volume !== null && averageVolume > 0 ? 'full' : volume !== null ? 'partial' : 'unavailable',
    };
  } catch (error) {
    console.error('[tradfi-activity] Nasdaq summary failed', symbol, error.message);
    return {
      symbol,
      assetClass: null,
      officialName: null,
      stockType: null,
      identityStatus: 'unavailable',
      exchange: null,
      volume: null,
      averageVolume: null,
      averageWindow: null,
      relativeVolume: null,
      previousClose: null,
      status: 'unavailable',
    };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const symbols = [...new Set(String(req.query.symbols || '')
    .split(',')
    .map(symbol => symbol.trim().toUpperCase())
    .filter(symbol => /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)))]
    .slice(0, MAX_SYMBOLS);

  if (!symbols.length) return res.status(400).json({ error: 'No valid symbols' });

  const etfSymbols = new Set(String(req.query.etfs || '')
    .split(',')
    .map(symbol => symbol.trim().toUpperCase())
    .filter(symbol => symbols.includes(symbol)));

  const [nasdaqRows, occResult] = await Promise.all([
    mapWithConcurrency(symbols, 6, symbol => fetchNasdaqSummary(symbol, etfSymbols.has(symbol) ? 'etf' : 'stocks')),
    fetchOccActivity(symbols).catch(error => {
      console.error('[tradfi-activity] OCC activity failed', error.message);
      return { asOf: null, baselineReports: [], baselineSamples: 0, rows: {} };
    }),
  ]);

  const rows = nasdaqRows.map(market => {
    const unavailableOptions = {
      volume: null,
      averageVolume: null,
      relativeVolume: null,
      baselineSamples: 0,
      status: 'unavailable',
    };
    return {
      symbol: market.symbol,
      market,
      // Options roots are also ticker-based. Do not attach OCC volume until
      // Nasdaq confirms that the current listed security has the expected
      // asset class; this prevents equity/ETF ticker collisions.
      options: market.identityStatus === 'confirmed'
        ? (occResult.rows[market.symbol] || unavailableOptions)
        : unavailableOptions,
    };
  });

  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
  return res.status(200).json({
    generatedAt: new Date().toISOString(),
    scope: 'US-listed equities, ETFs and ADRs with a canonical RWA underlying',
    sources: {
      market: {
        name: 'Nasdaq Market Activity',
        url: 'https://www.nasdaq.com/market-activity',
        latency: 'Official public display; delayed/intraday or latest completed session',
      },
      options: {
        name: 'The Options Clearing Corporation (OCC)',
        url: 'https://www.theocc.com/market-data/market-data-reports/volume-and-open-interest/volume-query',
        latency: 'T+1 completed-session volume',
        asOf: occResult.asOf,
        baselineReports: occResult.baselineReports,
        baselineSamples: occResult.baselineSamples,
      },
    },
    rows,
  });
}

export const config = { maxDuration: 60 };

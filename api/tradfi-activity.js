// Traditional-market-first activity ranking for tokenization discovery.
//
// Identity universe: Nasdaq Trader official symbol directories.
// Equity/ETF leaders: Nasdaq Most Active by Dollar Volume.
// Options leaders and baselines: OCC completed-session volume reports.
//
// Dollar values are estimates, not trade-value feeds:
//   shares notional = displayed shares * displayed price
//   options underlying notional = standard contracts * 100 * displayed price

import {
  fetchJsonWithPolicy,
  fetchWithPolicy,
  mapWithConcurrency,
  setPublicCache,
} from './_lib/upstream.js';

const NASDAQ_MOVERS = 'https://api.nasdaq.com/api/marketmovers?assetclass=stocks';
const NASDAQ_SUMMARY = 'https://api.nasdaq.com/api/quote';
const NASDAQ_LISTED = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt';
const OTHER_LISTED = 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt';
const OCC_VOLUME = 'https://marketdata.theocc.com/onn-volume-download';
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;
const OCC_CANDIDATE_COUNT = 30;

const SOURCE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (compatible; Avenir-RWA-Analyst/1.0)',
  Origin: 'https://www.nasdaq.com',
  Referer: 'https://www.nasdaq.com/',
};

const NON_COMMON_SECURITY_PATTERN = /\b(WARRANTS?|RIGHTS?|UNITS?|PREFERRED|PREFERENCE|DEBENTURES?|BONDS?|NOTES?|CERTIFICATES?)\b/i;
const ADR_NAME_PATTERN = /\b(AMERICAN DEPOSITARY|AMERICAN DEPOSITORY|ADR)\b/i;

function asNumber(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[$,%\s]/g, '').replace(/,/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function estimatedShareValue(volume, price) {
  return volume !== null && volume !== undefined && Number(volume) >= 0 && Number(price) > 0
    ? Number(volume) * Number(price)
    : null;
}

export function estimatedOptionsNotional(contracts, price) {
  return contracts !== null && contracts !== undefined && Number(contracts) >= 0 && Number(price) > 0
    ? Number(contracts) * 100 * Number(price)
    : null;
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

export function occDateToIso(value) {
  const raw = String(value || '');
  if (!/^\d{8}$/.test(raw)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

export function nasdaqHistoricalWindow(sessionDate) {
  const start = new Date(`${sessionDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sessionDate || '')) || Number.isNaN(start.getTime())) {
    return null;
  }
  return {
    fromdate:sessionDate,
    // Nasdaq rejects an equal from/to range with an HTTP-200 business error.
    // Use the next calendar day as the exclusive boundary, then select the
    // requested completed session from the returned rows.
    todate:addUtcDays(start, 1).toISOString().slice(0, 10),
  };
}

function nasdaqDisplayDateToIso(value) {
  const match = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[1]}-${match[2]}` : null;
}

export function parseNasdaqHistoricalRow(payload, sessionDate) {
  const rows = payload?.data?.tradesTable?.rows;
  if (!Array.isArray(rows)) return null;
  const row = rows.find(item => nasdaqDisplayDateToIso(item?.date) === sessionDate);
  if (!row) return null;
  const volume = asNumber(row.volume);
  const close = asNumber(row.close);
  if (!(volume >= 0) || !(close > 0)) return null;
  return { sessionDate, volume, close };
}

export function classifyNasdaqHistoricalPayload(payload, sessionDate) {
  if (Number(payload?.status?.rCode) !== 200) {
    return { status:'invalid', reason:'nasdaq-business-error', row:null };
  }
  const rows = payload?.data?.tradesTable?.rows;
  const totalRecords = asNumber(payload?.data?.totalRecords);
  if (!Array.isArray(rows)) {
    return totalRecords === 0
      ? { status:'ineligible', reason:'no-session-row', row:null }
      : { status:'invalid', reason:'historical-schema-unavailable', row:null };
  }
  const matchingRow = rows.find(item => nasdaqDisplayDateToIso(item?.date) === sessionDate);
  if (!matchingRow) {
    return rows.length === 0 && totalRecords === 0
      ? { status:'ineligible', reason:'no-session-row', row:null }
      : { status:'invalid', reason:'requested-session-missing', row:null };
  }
  const row = parseNasdaqHistoricalRow(payload, sessionDate);
  return row
    ? { status:'aligned', reason:null, row }
    : { status:'invalid', reason:'invalid-session-volume-or-close', row:null };
}

export function canAcceptNasdaqHistorical(classification, directoryBackedAttempt) {
  return classification?.status === 'aligned' ||
    (directoryBackedAttempt && classification?.status === 'ineligible');
}

function normalizeOccRoot(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/^\d+/, '');
}

export function parseOccReport(text) {
  const standardTotals = {};
  const adjustedTotals = {};
  let currentRoot = '';
  let currentAdjusted = false;

  for (const line of String(text || '').split(/\r?\n/)) {
    const columns = line.split('\t').map(value => value.trim());
    if (columns.length < 2) continue;
    // A new root can start the group (column 0 populated) or appear as a
    // continuation under the same group (column 0 blank, e.g. SPY after
    // adjusted roots 2SPY/4SPY). Column 1 is the authoritative option root.
    if (columns[1] && columns[1] !== 'Total' && columns[0] !== 'Group' && columns[0] !== 'Symbol') {
      const rawRoot = String(columns[1]).trim().toUpperCase();
      currentRoot = normalizeOccRoot(rawRoot);
      currentAdjusted = /^\d+/.test(rawRoot);
    }
    if (columns[0] === 'Symbol' && columns[1] === 'Total' && currentRoot) {
      const total = [...columns].reverse().map(asNumber).find(Number.isFinite);
      if (!Number.isFinite(total)) continue;
      const target = currentAdjusted ? adjustedTotals : standardTotals;
      target[currentRoot] = (target[currentRoot] || 0) + total;
    }
  }
  return { standardTotals, adjustedTotals };
}

export function parseOccTotals(text) {
  return parseOccReport(text).standardTotals;
}

function occUrl(reportType, reportDate) {
  const params = new URLSearchParams({
    productKind:'options', reportType, reportDate,
    reportFormat:'volume', issues:'all', reportView:'totals',
  });
  return `${OCC_VOLUME}?${params}`;
}

async function fetchText(url, timeoutMs = 18000) {
  const response = await fetchWithPolicy(url, {}, { timeoutMs, retries:1 });
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url, timeoutMs = 18000) {
  return fetchJsonWithPolicy(url, { headers:SOURCE_HEADERS }, { timeoutMs, retries:1 });
}

export function parseNasdaqDirectory(text, listingVenue) {
  const lines = String(text || '').trim().split(/\r?\n/);
  const headers = (lines.shift() || '').split('|');
  const rows = [];
  for (const line of lines) {
    if (!line || line.startsWith('File Creation Time')) continue;
    const columns = line.split('|');
    const record = Object.fromEntries(headers.map((header, index) => [header, columns[index] || '']));
    const symbol = String(record.Symbol || record['NASDAQ Symbol'] || record['ACT Symbol'] || '').trim().toUpperCase();
    const name = String(record['Security Name'] || '').trim();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) || record['Test Issue'] !== 'N' || !name) continue;
    if (NON_COMMON_SECURITY_PATTERN.test(name)) continue;
    rows.push({
      symbol,
      name,
      category:record.ETF === 'Y' ? 'etf' : 'equity',
      exchange:listingVenue === 'nasdaq' ? 'NASDAQ' : (record.Exchange || null),
      tags:ADR_NAME_PATTERN.test(name) ? ['ADR'] : [],
    });
  }
  return rows;
}

async function fetchTraditionalDirectory() {
  const [nasdaqText, otherText] = await Promise.all([
    fetchText(NASDAQ_LISTED, 20000),
    fetchText(OTHER_LISTED, 20000),
  ]);
  const rows = [
    ...parseNasdaqDirectory(nasdaqText, 'nasdaq'),
    ...parseNasdaqDirectory(otherText, 'other'),
  ];
  return new Map(rows.map(row => [row.symbol, row]));
}

async function fetchDollarVolumeLeaders() {
  const payload = await fetchJson(NASDAQ_MOVERS, 18000);
  const rows = payload?.data?.STOCKS?.MostActiveByDollarVolume?.table?.rows;
  if (!Array.isArray(rows) || !rows.length) throw new Error('Nasdaq dollar-volume leaders unavailable');
  return {
    asOf:payload?.data?.STOCKS?.MostActiveByDollarVolume?.dataAsOf || null,
    rows,
  };
}

async function findLatestOccDay() {
  const candidate = addUtcDays(new Date(), -1);
  for (let offset = 0; offset < 7; offset += 1) {
    const reportDate = yyyymmdd(addUtcDays(candidate, -offset));
    try {
      const report = parseOccReport(await fetchText(occUrl('D', reportDate)));
      if (Object.keys(report.standardTotals).length) return { reportDate, ...report };
    } catch (error) {
      if (offset === 6) throw error;
    }
  }
  throw new Error('No completed OCC trading-day report found');
}

async function fetchOccBundle() {
  const latest = await findLatestOccDay();
  const latestDate = new Date(`${latest.reportDate.slice(0, 4)}-${latest.reportDate.slice(4, 6)}-${latest.reportDate.slice(6, 8)}T12:00:00Z`);
  const comparisonDates = [7, 14, 21, 28].map(days => yyyymmdd(addUtcDays(latestDate, -days)));
  const comparisonReports = await Promise.all(comparisonDates.map(async reportDate => {
    try {
      const report = parseOccReport(await fetchText(occUrl('D', reportDate)));
      return { reportDate, ...report, ok:Object.keys(report.standardTotals).length > 0 };
    } catch (error) {
      console.error('[tradfi-activity] OCC comparison report failed', reportDate, error.message);
      return { reportDate, standardTotals:{}, adjustedTotals:{}, ok:false };
    }
  }));
  const completedReports = comparisonReports.filter(report => report.ok);
  return {
    asOf:latest.reportDate,
    latestTotals:latest.standardTotals,
    latestAdjustedTotals:latest.adjustedTotals,
    comparisonReports:completedReports,
    baselineReports:completedReports.map(report => report.reportDate),
    baselineSamples:completedReports.length,
  };
}

export function optionActivityForSymbol(symbol, occBundle, lastPrice) {
  if (!occBundle) {
    return {
      volume:null, adjustedVolumeExcluded:null, averageVolume:null, relativeVolume:null,
      estimatedNotional:null, baselineSamples:0, status:'unavailable',
    };
  }
  const current = occBundle.latestTotals[symbol] || 0;
  const adjustedVolumeExcluded = occBundle.latestAdjustedTotals[symbol] || 0;
  const baselineTotal = occBundle.comparisonReports.reduce(
    (sum, report) => sum + (report.standardTotals[symbol] || 0),
    0,
  );
  const baselineAdjustedVolumeExcluded = occBundle.comparisonReports.reduce(
    (sum, report) => sum + (report.adjustedTotals?.[symbol] || 0),
    0,
  );
  const adjustedBaselineReports = occBundle.comparisonReports
    .filter(report => (report.adjustedTotals?.[symbol] || 0) > 0)
    .map(report => report.reportDate);
  const baselineSamples = occBundle.comparisonReports.length;
  const average = baselineSamples > 0 ? baselineTotal / baselineSamples : null;
  const hasOfficialSeries = current > 0 || baselineTotal > 0;
  const completeBaseline = hasOfficialSeries && baselineSamples === 4;
  return {
    volume:hasOfficialSeries ? current : null,
    adjustedVolumeExcluded,
    baselineAdjustedVolumeExcluded,
    adjustedBaselineReports,
    averageVolume:average,
    relativeVolume:average > 0 ? current / average : null,
    estimatedNotional:hasOfficialSeries ? estimatedOptionsNotional(current, lastPrice) : null,
    baselineSamples,
    status:completeBaseline && adjustedVolumeExcluded === 0 && baselineAdjustedVolumeExcluded === 0
      ? 'full'
      : hasOfficialSeries ? 'partial' : 'unavailable',
  };
}

export function buildTraditionalCandidates(moverRows, latestOptionTotals, directory, optionCandidateCount = OCC_CANDIDATE_COUNT) {
  const candidates = new Map();
  function add(symbol, mover = null, source) {
    const normalized = String(symbol || '').trim().toUpperCase();
    const identity = directory.get(normalized);
    if (!identity) return;
    if (!candidates.has(normalized)) {
      candidates.set(normalized, {
        ...identity,
        categoryHint:identity.category,
        lastPrice:asNumber(mover?.lastSalePrice),
        moverRank:null,
        sourceRanks:[],
      });
    }
    const row = candidates.get(normalized);
    if (mover && !(row.lastPrice > 0)) row.lastPrice = asNumber(mover.lastSalePrice);
    row.sourceRanks.push(source);
  }

  (moverRows || []).forEach((row, index) => {
    add(row.symbol, row, `Nasdaq dollar #${index + 1}`);
    const candidate = candidates.get(String(row.symbol || '').trim().toUpperCase());
    if (candidate) candidate.moverRank = index + 1;
  });
  Object.entries(latestOptionTotals || {})
    .filter(([symbol]) => directory.has(symbol))
    .sort((a, b) => b[1] - a[1])
    .slice(0, optionCandidateCount)
    .forEach(([symbol], index) => add(symbol, null, `OCC options #${index + 1}`));
  return [...candidates.values()];
}

async function fetchNasdaqAssetClass(symbol, assetClass) {
  const payload = await fetchJson(`${NASDAQ_SUMMARY}/${encodeURIComponent(symbol)}/summary?assetclass=${assetClass}`, 12000);
  return payload?.data?.summaryData || null;
}

async function fetchNasdaqIdentity(symbol, assetClass) {
  const payload = await fetchJson(`${NASDAQ_SUMMARY}/${encodeURIComponent(symbol)}/info?assetclass=${assetClass}`, 12000);
  return payload?.data || null;
}

async function fetchNasdaqHistorical(symbol, assetClass, sessionDate) {
  if (!sessionDate) return null;
  const window = nasdaqHistoricalWindow(sessionDate);
  if (!window) return null;
  const params = new URLSearchParams({
    assetclass:assetClass,
    ...window,
    limit:'10',
  });
  const payload = await fetchJson(
    `${NASDAQ_SUMMARY}/${encodeURIComponent(symbol)}/historical?${params}`,
    12000,
  );
  const classification = classifyNasdaqHistoricalPayload(payload, sessionDate);
  if (classification.status === 'invalid') {
    throw new Error(`Nasdaq historical payload invalid: ${classification.reason}`);
  }
  return classification;
}

async function fetchNasdaqDetail(candidate, rankingSession = null) {
  const preferred = candidate.categoryHint === 'etf' ? 'etf' : 'stocks';
  const attempts = preferred === 'etf' ? ['etf', 'stocks'] : ['stocks', 'etf'];
  const expectedAssetClass = candidate.category === 'etf' ? 'ETF' : 'STOCKS';
  let summary = null;
  let identity = null;
  let historical = null;
  let historicalStatus = rankingSession ? 'unavailable' : 'latest';
  let historicalReason = null;
  for (const assetClass of attempts) {
    const [summaryResult, identityResult, historicalResult] = await Promise.allSettled([
      fetchNasdaqAssetClass(candidate.symbol, assetClass),
      fetchNasdaqIdentity(candidate.symbol, assetClass),
      fetchNasdaqHistorical(candidate.symbol, assetClass, rankingSession),
    ]);
    const candidateSummary = summaryResult.status === 'fulfilled' ? summaryResult.value : null;
    const candidateIdentity = identityResult.status === 'fulfilled' ? identityResult.value : null;
    const candidateHistorical = historicalResult.status === 'fulfilled' ? historicalResult.value : null;
    const actualAssetClass = String(candidateIdentity?.assetClass || '').toUpperCase();
    const identityMatches = Boolean(candidateIdentity?.companyName) && actualAssetClass === expectedAssetClass;
    const directoryBackedAttempt = assetClass === preferred;
    const requiredMarketDataAvailable = rankingSession
      ? canAcceptNasdaqHistorical(candidateHistorical, directoryBackedAttempt)
      : true;
    if (requiredMarketDataAvailable && (identityMatches || directoryBackedAttempt)) {
      summary = candidateSummary;
      identity = identityMatches ? candidateIdentity : null;
      historical = candidateHistorical?.row || null;
      historicalStatus = candidateHistorical?.status || historicalStatus;
      historicalReason = candidateHistorical?.reason || null;
      break;
    }
  }
  summary = summary || {};
  const primary = identity?.primaryData || {};
  const secondary = identity?.secondaryData || {};
  const actualAssetClass = String(identity?.assetClass || '').toUpperCase();
  const acceptedIdentity = actualAssetClass === expectedAssetClass;
  const sessionAligned = rankingSession ? historical?.sessionDate === rankingSession : acceptedIdentity;
  const volume = rankingSession
    ? (sessionAligned ? historical.volume : null)
    : (asNumber(primary.volume) ?? asNumber(summary.ShareVolume?.value));
  const lastPrice = rankingSession
    ? (sessionAligned ? historical.close : null)
    : (asNumber(primary.lastSalePrice) ?? candidate.lastPrice ?? asNumber(secondary.lastSalePrice) ?? asNumber(summary.PreviousClose?.value));
  const averageVolume = asNumber(
    summary.AverageVolume?.value ??
    summary.AvgDailyVol20Days?.value ??
    summary.FiftyDayAvgDailyVol?.value ??
    summary.AvgDailyVol65Days?.value,
  );
  const officialName = identity?.companyName || candidate.name;
  const tags = [...candidate.tags];
  if (ADR_NAME_PATTERN.test(`${officialName} ${identity?.stockType || ''}`) && !tags.includes('ADR')) tags.push('ADR');
  return {
    symbol:candidate.symbol,
    category:candidate.category,
    tags,
    market:{
      symbol:candidate.symbol,
      assetClass:actualAssetClass || expectedAssetClass,
      officialName,
      stockType:identity?.stockType || null,
      identityStatus:acceptedIdentity ? 'confirmed' : 'directory-confirmed',
      exchange:String(summary.Exchange?.value || candidate.exchange || '').trim() || null,
      volume,
      averageVolume,
      averageWindow:summary.AvgDailyVol20Days?.value ? '20 sessions' : 'Nasdaq displayed average',
      relativeVolume:volume !== null && averageVolume > 0 ? volume / averageVolume : null,
      lastPrice,
      sessionDate:sessionAligned ? rankingSession : null,
      sessionEligibility:historicalStatus,
      sessionExclusionReason:historicalStatus === 'ineligible' ? historicalReason : null,
      priceAsOf:sessionAligned ? rankingSession : primary.lastTradeTimestamp || secondary.lastTradeTimestamp || null,
      previousClose:asNumber(summary.PreviousClose?.value),
      estimatedValue:estimatedShareValue(volume, lastPrice),
      status:volume !== null && lastPrice > 0 && averageVolume > 0 ? 'full' : volume !== null && lastPrice > 0 ? 'partial' : 'unavailable',
    },
  };
}

export function summarizeTraditionalAlignment(detailed, candidates, rankingSession) {
  const alignedSymbols = new Set(
    detailed
      .filter(detail => detail?.market?.sessionDate === rankingSession && detail.market.volume !== null && Number(detail.market.lastPrice) > 0)
      .map(detail => detail.symbol),
  );
  const candidateSymbols = candidates.map(candidate => candidate.symbol);
  const ineligibleSymbols = new Set(
    detailed
      .filter(detail => detail?.market?.sessionEligibility === 'ineligible')
      .map(detail => detail.symbol),
  );
  const eligibleSymbols = candidateSymbols.filter(symbol => !ineligibleSymbols.has(symbol));
  const droppedSymbols = eligibleSymbols.filter(symbol => !alignedSymbols.has(symbol));
  return {
    requestedCandidateCount:candidateSymbols.length,
    eligibleCandidateCount:eligibleSymbols.length,
    alignedCandidateCount:alignedSymbols.size,
    ineligibleCandidateCount:ineligibleSymbols.size,
    ineligibleSymbols:[...ineligibleSymbols],
    droppedCandidateCount:droppedSymbols.length,
    droppedSymbols,
    ratio:eligibleSymbols.length ? alignedSymbols.size / eligibleSymbols.length : 0,
  };
}

export function hasCompleteTraditionalAlignment(alignment) {
  const requested = Number(alignment?.requestedCandidateCount);
  const eligible = Number(alignment?.eligibleCandidateCount);
  const ineligible = Number(alignment?.ineligibleCandidateCount);
  return requested > 0 && eligible > 0 &&
    requested === eligible + ineligible &&
    Number(alignment?.alignedCandidateCount) === eligible &&
    Number(alignment?.droppedCandidateCount) === 0;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error:'Method not allowed' });
  }
  const queryKeys = Object.keys(req.query || {});
  if (queryKeys.some(key => key !== 'limit')) {
    return res.status(400).json({ error:'Unsupported query parameter' });
  }
  if (req.query?.limit !== undefined && !/^(?:[1-9]|[1-4]\d|50)$/.test(String(req.query.limit))) {
    return res.status(400).json({ error:'Invalid limit' });
  }
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_LIMIT, 1), MAX_LIMIT);
  try {
    const [directory, movers, occBundle] = await Promise.all([
      fetchTraditionalDirectory(),
      fetchDollarVolumeLeaders(),
      fetchOccBundle(),
    ]);
    const candidates = buildTraditionalCandidates(
      movers.rows,
      occBundle?.latestTotals || {},
      directory,
    );
    const rankingSession = occDateToIso(occBundle?.asOf);
    if (!rankingSession) throw new Error('OCC completed-session date is unavailable');
    const detailed = await mapWithConcurrency(
      candidates,
      6,
      candidate => fetchNasdaqDetail(candidate, rankingSession),
    );
    const alignment = summarizeTraditionalAlignment(detailed, candidates, rankingSession);
    if (!hasCompleteTraditionalAlignment(alignment)) {
      throw new Error(
        `Insufficient Nasdaq/OCC session alignment: ${alignment.alignedCandidateCount}/${alignment.eligibleCandidateCount} eligible candidates`,
      );
    }
    const candidateBySymbol = Object.fromEntries(candidates.map(candidate => [candidate.symbol, candidate]));
    const rows = detailed.map(detail => {
      const candidate = candidateBySymbol[detail.symbol];
      const options = optionActivityForSymbol(detail.symbol, occBundle, detail.market.lastPrice);
      return {
        symbol:detail.symbol,
        name:detail.market.officialName || candidate.name,
        category:detail.category,
        tags:detail.tags,
        sourceRanks:candidate.sourceRanks,
        market:detail.market,
        options,
        traditionalTotalValue:(detail.market.estimatedValue || 0) + (options.estimatedNotional || 0),
      };
    })
      .filter(row => row.traditionalTotalValue > 0)
      .sort((a, b) => b.traditionalTotalValue - a.traditionalTotalValue || (b.market.estimatedValue || 0) - (a.market.estimatedValue || 0))
      .slice(0, limit)
      .map((row, index) => ({ ...row, rank:index + 1 }));

    setPublicCache(res, 900, 3600);
    return res.status(200).json({
      generatedAt:new Date().toISOString(),
      scope:'Traditional official candidate-set ranking completed before any crypto coverage is joined',
      methodology:{
        ranking:'Rank within the disclosed official candidate set by estimated share value + estimated standard-options underlying notional',
        candidatePool:'Current Nasdaq official dollar-volume leader snapshot ∪ OCC ranking-session options-volume leaders',
        rankingCompleteness:'official-candidate-set',
        candidateCaveat:'This is not a full-universe leaderboard when the Nasdaq candidate snapshot and the OCC T+1 ranking session differ.',
        shareValue:'Nasdaq completed-session share volume × same-session close',
        optionsValue:'OCC same-session standard contracts × 100-share multiplier × Nasdaq close',
        caveat:'Estimated notionals; not consolidated share turnover or option-premium volume. Share volume and closing price are aligned to the OCC completed session. Adjusted option roots are excluded from notional.',
        directoryUniverse:directory.size,
        candidateCount:candidates.length,
        rankingSession,
        moverAsOf:movers.asOf,
        alignment,
      },
      sources:{
        directory:{
          name:'Nasdaq Trader Symbol Directory',
          url:'https://www.nasdaqtrader.com/trader.aspx?id=symboldirdefs',
        },
        market:{
          name:'Nasdaq Most Active and Market Activity',
          url:'https://www.nasdaq.com/market-activity/most-active',
          latency:`Official completed-session historical rows aligned to ${rankingSession || 'latest available session'}`,
        },
        options:{
          name:'The Options Clearing Corporation (OCC)',
          url:'https://www.theocc.com/market-data/market-data-reports/volume-and-open-interest/volume-query',
          latency:'T+1 completed-session volume',
          asOf:occBundle?.asOf || null,
          baselineReports:occBundle?.baselineReports || [],
          baselineSamples:occBundle?.baselineSamples || 0,
        },
      },
      rows,
    });
  } catch (error) {
    console.error('[tradfi-activity] request failed', error);
    return res.status(502).json({ error:'Traditional activity unavailable', detail:error.message });
  }
}

export const config = { maxDuration:60 };

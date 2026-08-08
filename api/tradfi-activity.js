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
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;
const OCC_CANDIDATE_COUNT = 100;
const NASDAQ_BASELINE_CALENDAR_DAYS = 35;
const NASDAQ_BASELINE_SESSIONS = 20;

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

export function nasdaqHistoricalWindow(
  sessionDate,
  comparisonSessionDate = null,
  baselineCalendarDays = NASDAQ_BASELINE_CALENDAR_DAYS,
) {
  const end = new Date(`${sessionDate}T00:00:00Z`);
  const comparison = comparisonSessionDate ? new Date(`${comparisonSessionDate}T00:00:00Z`) : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sessionDate || '')) || Number.isNaN(end.getTime()) ||
      (comparisonSessionDate && (!/^\d{4}-\d{2}-\d{2}$/.test(String(comparisonSessionDate)) || Number.isNaN(comparison.getTime())))) {
    return null;
  }
  const baselineStart = addUtcDays(end, -Math.max(Number(baselineCalendarDays) || 0, 0));
  const start = comparison && comparison < baselineStart ? comparison : baselineStart;
  return {
    fromdate:start.toISOString().slice(0, 10),
    // Nasdaq rejects an equal from/to range with an HTTP-200 business error.
    // Use the next calendar day as the exclusive boundary, then select the
    // requested completed session from the returned rows.
    todate:addUtcDays(end, 1).toISOString().slice(0, 10),
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
  if (!Number.isFinite(volume) || volume < 0 || !(close > 0)) return null;
  return { sessionDate, volume, close };
}

export function parseNasdaqHistoricalAverage(payload, sessionDate, maxSessions = NASDAQ_BASELINE_SESSIONS) {
  const rows = payload?.data?.tradesTable?.rows;
  if (!Array.isArray(rows)) return { averageVolume:null, samples:0 };
  const volumes = rows
    .map(row => ({ sessionDate:nasdaqDisplayDateToIso(row?.date), volume:asNumber(row?.volume) }))
    .filter(row => row.sessionDate && row.sessionDate < sessionDate && Number.isFinite(row.volume) && row.volume >= 0)
    .sort((a, b) => b.sessionDate.localeCompare(a.sessionDate))
    .slice(0, Math.max(Number(maxSessions) || 0, 0))
    .map(row => row.volume);
  return {
    averageVolume:volumes.length ? volumes.reduce((sum, volume) => sum + volume, 0) / volumes.length : null,
    samples:volumes.length,
  };
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

export function classifyNasdaqHistoricalRange(payload, sessionDate, comparisonSessionDate = null) {
  const historicalRows = payload?.data?.tradesTable?.rows;
  const totalRecords = asNumber(payload?.data?.totalRecords);
  const rangeTruncated = Array.isArray(historicalRows) && Number.isFinite(totalRecords) && totalRecords > historicalRows.length;
  const previousMatchingRow = comparisonSessionDate && Array.isArray(historicalRows)
    ? historicalRows.find(item => nasdaqDisplayDateToIso(item?.date) === comparisonSessionDate)
    : null;
  const previousRow = comparisonSessionDate
    ? parseNasdaqHistoricalRow(payload, comparisonSessionDate)
    : null;
  let current = classifyNasdaqHistoricalPayload(payload, sessionDate);
  // A valid two-session payload can contain the previous row but no current
  // row (for example, a delisted or halted previous-session leader). That is
  // an explicit session ineligibility, not a stale row that may be substituted.
  if (current.status === 'invalid' && current.reason === 'requested-session-missing' && previousRow && !rangeTruncated) {
    current = { status:'ineligible', reason:'no-session-row', row:null };
  }
  return {
    current,
    previous:comparisonSessionDate
      ? previousRow
        ? { status:'aligned', reason:null, row:previousRow }
        : previousMatchingRow
          ? { status:'invalid', reason:'invalid-session-volume-or-close', row:null }
          : rangeTruncated
            ? { status:'invalid', reason:'historical-range-truncated', row:null }
            : { status:'ineligible', reason:'no-previous-session-row', row:null }
      : null,
  };
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

export async function findFirstNonEmptyOccReport(reportDates, loadReportText) {
  for (const reportDate of reportDates || []) {
    const report = parseOccReport(await loadReportText(reportDate));
    if (Object.keys(report.standardTotals).length) return { reportDate, ...report };
  }
  return null;
}

async function findLatestOccDay() {
  const candidate = addUtcDays(new Date(), -1);
  const reportDates = Array.from({ length:7 }, (_, offset) => yyyymmdd(addUtcDays(candidate, -offset)));
  const report = await findFirstNonEmptyOccReport(
    reportDates,
    reportDate => fetchText(occUrl('D', reportDate)),
  );
  if (report) return report;
  throw new Error('No completed OCC trading-day report found');
}

async function findPreviousOccDay(reportDate) {
  const current = new Date(`${reportDate.slice(0, 4)}-${reportDate.slice(4, 6)}-${reportDate.slice(6, 8)}T12:00:00Z`);
  const reportDates = Array.from({ length:7 }, (_, index) => yyyymmdd(addUtcDays(current, -(index + 1))));
  const report = await findFirstNonEmptyOccReport(
    reportDates,
    previousReportDate => fetchText(occUrl('D', previousReportDate)),
  );
  if (report) return report;
  throw new Error(`No OCC trading-day report found before ${reportDate}`);
}

async function fetchOccBundle() {
  const latest = await findLatestOccDay();
  const latestDate = new Date(`${latest.reportDate.slice(0, 4)}-${latest.reportDate.slice(4, 6)}-${latest.reportDate.slice(6, 8)}T12:00:00Z`);
  const comparisonDates = [7, 14, 21, 28].map(days => yyyymmdd(addUtcDays(latestDate, -days)));
  const [previous, comparisonReports] = await Promise.all([
    findPreviousOccDay(latest.reportDate),
    Promise.all(comparisonDates.map(async reportDate => {
    try {
      const report = parseOccReport(await fetchText(occUrl('D', reportDate)));
      return { reportDate, ...report, ok:Object.keys(report.standardTotals).length > 0 };
    } catch (error) {
      console.error('[tradfi-activity] OCC comparison report failed', reportDate, error.message);
      return { reportDate, standardTotals:{}, adjustedTotals:{}, ok:false };
    }
    })),
  ]);
  const completedReports = comparisonReports.filter(report => report.ok);
  return {
    asOf:latest.reportDate,
    latestTotals:latest.standardTotals,
    latestAdjustedTotals:latest.adjustedTotals,
    previousAsOf:previous.reportDate,
    previousTotals:previous.standardTotals,
    previousAdjustedTotals:previous.adjustedTotals,
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

export function buildTraditionalCandidates(
  moverRows,
  latestOptionTotals,
  directory,
  optionCandidateCount = OCC_CANDIDATE_COUNT,
  previousOptionTotals = {},
) {
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
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, optionCandidateCount)
    .forEach(([symbol], index) => add(symbol, null, `OCC options #${index + 1}`));
  Object.entries(previousOptionTotals || {})
    .filter(([symbol]) => directory.has(symbol))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, optionCandidateCount)
    .forEach(([symbol], index) => add(symbol, null, `Previous OCC options #${index + 1}`));
  return [...candidates.values()];
}

async function fetchNasdaqHistorical(symbol, assetClass, sessionDate, comparisonSessionDate = null) {
  if (!sessionDate) return null;
  const window = nasdaqHistoricalWindow(sessionDate, comparisonSessionDate);
  if (!window) return null;
  const params = new URLSearchParams({
    assetclass:assetClass,
    ...window,
    limit:'30',
  });
  const payload = await fetchJson(
    `${NASDAQ_SUMMARY}/${encodeURIComponent(symbol)}/historical?${params}`,
    12000,
  );
  const historicalRange = classifyNasdaqHistoricalRange(payload, sessionDate, comparisonSessionDate);
  const { current } = historicalRange;
  if (current.status === 'invalid') {
    throw new Error(`Nasdaq historical payload invalid: ${current.reason}`);
  }
  return {
    ...historicalRange,
    baseline:parseNasdaqHistoricalAverage(payload, sessionDate),
  };
}

async function fetchNasdaqSessions(candidate, rankingSession, comparisonSession) {
  const preferred = candidate.categoryHint === 'etf' ? 'etf' : 'stocks';
  const attempts = [preferred];
  const expectedAssetClass = candidate.category === 'etf' ? 'ETF' : 'STOCKS';
  let historical = null;
  let previousHistorical = null;
  let historicalStatus = 'unavailable';
  let historicalReason = null;
  let previousHistoricalStatus = 'unavailable';
  let previousHistoricalReason = null;
  let averageVolume = null;
  let averageSamples = 0;
  for (const assetClass of attempts) {
    let candidateHistorical = null;
    try {
      candidateHistorical = await fetchNasdaqHistorical(
        candidate.symbol,
        assetClass,
        rankingSession,
        comparisonSession,
      );
    } catch (error) {
      continue;
    }
    const directoryBackedAttempt = assetClass === preferred;
    if (canAcceptNasdaqHistorical(candidateHistorical?.current, directoryBackedAttempt)) {
      historical = candidateHistorical?.current?.row || null;
      historicalStatus = candidateHistorical?.current?.status || historicalStatus;
      historicalReason = candidateHistorical?.current?.reason || null;
      previousHistorical = candidateHistorical?.previous?.row || null;
      previousHistoricalStatus = candidateHistorical?.previous?.status || previousHistoricalStatus;
      previousHistoricalReason = candidateHistorical?.previous?.reason || null;
      averageVolume = candidateHistorical?.baseline?.averageVolume ?? null;
      averageSamples = candidateHistorical?.baseline?.samples || 0;
      break;
    }
  }
  const sessionAligned = historical?.sessionDate === rankingSession;
  const previousSessionAligned = previousHistorical?.sessionDate === comparisonSession;
  const volume = sessionAligned ? historical.volume : null;
  const lastPrice = sessionAligned ? historical.close : null;
  const tags = [...candidate.tags];
  return {
    symbol:candidate.symbol,
    category:candidate.category,
    tags,
    market:{
      symbol:candidate.symbol,
      assetClass:expectedAssetClass,
      officialName:candidate.name,
      stockType:null,
      identityStatus:'directory-confirmed',
      exchange:candidate.exchange || null,
      volume,
      averageVolume,
      averageSamples,
      averageWindow:averageSamples ? `${averageSamples} prior completed sessions` : null,
      relativeVolume:volume !== null && averageVolume > 0 ? volume / averageVolume : null,
      lastPrice,
      sessionDate:sessionAligned ? rankingSession : null,
      sessionEligibility:historicalStatus,
      sessionExclusionReason:historicalStatus === 'ineligible' ? historicalReason : null,
      priceAsOf:sessionAligned ? rankingSession : null,
      previousClose:null,
      estimatedValue:estimatedShareValue(volume, lastPrice),
      status:volume !== null && lastPrice > 0 && averageSamples >= NASDAQ_BASELINE_SESSIONS
        ? 'full'
        : volume !== null && lastPrice > 0 ? 'partial' : 'unavailable',
    },
    previousMarket:{
      sessionDate:previousSessionAligned ? comparisonSession : null,
      volume:previousSessionAligned ? previousHistorical.volume : null,
      lastPrice:previousSessionAligned ? previousHistorical.close : null,
      estimatedValue:previousSessionAligned
        ? estimatedShareValue(previousHistorical.volume, previousHistorical.close)
        : null,
      sessionEligibility:previousHistoricalStatus,
      sessionExclusionReason:previousHistoricalStatus === 'ineligible' ? previousHistoricalReason : null,
      status:previousSessionAligned ? 'full' : 'unavailable',
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

function compareTraditionalRows(a, b, valueKey, marketValueKey) {
  return Number(b?.[valueKey] || 0) - Number(a?.[valueKey] || 0) ||
    Number(b?.[marketValueKey] || 0) - Number(a?.[marketValueKey] || 0) ||
    String(a?.symbol || '').localeCompare(String(b?.symbol || ''));
}

export function rankTraditionalRows(rows, limit = MAX_LIMIT, comparisonAvailable = true, entryLimit = MAX_LIMIT) {
  const cappedLimit = Math.min(Math.max(Number(limit) || MAX_LIMIT, 1), MAX_LIMIT);
  const topBoundary = Math.min(Math.max(Number(entryLimit) || MAX_LIMIT, 1), MAX_LIMIT);
  const previousRanks = new Map();
  if (comparisonAvailable) {
    [...(rows || [])]
      .filter(row => Number(row?.previousTraditionalTotalValue) > 0)
      .sort((a, b) => compareTraditionalRows(a, b, 'previousTraditionalTotalValue', 'previousMarketEstimatedValue'))
      .forEach((row, index) => previousRanks.set(row.symbol, index + 1));
  }

  return [...(rows || [])]
    .filter(row => Number(row?.traditionalTotalValue) > 0)
    .sort((a, b) => compareTraditionalRows(a, b, 'traditionalTotalValue', 'marketEstimatedValue'))
    .slice(0, cappedLimit)
    .map((row, index) => {
      const rank = index + 1;
      const previousRank = comparisonAvailable ? (previousRanks.get(row.symbol) || null) : null;
      let rankChange = { status:'unavailable', delta:null, previousRank:null };
      if (comparisonAvailable) {
        if (previousRank === null || previousRank > topBoundary) {
          rankChange = { status:'new', delta:null, previousRank };
        } else {
          const delta = previousRank - rank;
          rankChange = {
            status:delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
            delta,
            previousRank,
          };
        }
      }
      return { ...row, rank, previousRank, rankChange };
    });
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
  if (req.query?.limit !== undefined && !/^(?:[1-9]|[1-9]\d|100)$/.test(String(req.query.limit))) {
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
      OCC_CANDIDATE_COUNT,
      occBundle?.previousTotals || {},
    );
    const rankingSession = occDateToIso(occBundle?.asOf);
    const comparisonSession = occDateToIso(occBundle?.previousAsOf);
    if (!rankingSession) throw new Error('OCC completed-session date is unavailable');
    if (!comparisonSession || comparisonSession >= rankingSession) {
      throw new Error('Previous OCC completed-session date is unavailable');
    }
    const detailed = await mapWithConcurrency(
      candidates,
      10,
      candidate => fetchNasdaqSessions(candidate, rankingSession, comparisonSession),
    );
    const alignment = summarizeTraditionalAlignment(detailed, candidates, rankingSession);
    if (!hasCompleteTraditionalAlignment(alignment)) {
      throw new Error(
        `Insufficient Nasdaq/OCC session alignment: ${alignment.alignedCandidateCount}/${alignment.eligibleCandidateCount} eligible candidates`,
      );
    }
    const comparisonAlignment = summarizeTraditionalAlignment(
      detailed.map(detail => ({ ...detail, market:detail.previousMarket })),
      candidates,
      comparisonSession,
    );
    const comparisonAvailable = hasCompleteTraditionalAlignment(comparisonAlignment);
    const candidateBySymbol = Object.fromEntries(candidates.map(candidate => [candidate.symbol, candidate]));
    const unrankedRows = detailed.map(detail => {
      const candidate = candidateBySymbol[detail.symbol];
      const options = optionActivityForSymbol(detail.symbol, occBundle, detail.market.lastPrice);
      const previousOptionsVolume = Number(occBundle?.previousTotals?.[detail.symbol] || 0);
      const previousOptionsNotional = detail.previousMarket?.lastPrice > 0
        ? estimatedOptionsNotional(previousOptionsVolume, detail.previousMarket.lastPrice)
        : null;
      const previousMarketEstimatedValue = detail.previousMarket?.estimatedValue || 0;
      return {
        symbol:detail.symbol,
        name:detail.market.officialName || candidate.name,
        category:detail.category,
        tags:detail.tags,
        sourceRanks:candidate.sourceRanks,
        market:detail.market,
        options,
        previousMarket:detail.previousMarket,
        previousOptionsVolume,
        previousOptionsNotional,
        previousMarketEstimatedValue,
        marketEstimatedValue:detail.market.estimatedValue || 0,
        previousTraditionalTotalValue:previousMarketEstimatedValue + (previousOptionsNotional || 0),
        traditionalTotalValue:(detail.market.estimatedValue || 0) + (options.estimatedNotional || 0),
      };
    });
    const rows = rankTraditionalRows(unrankedRows, limit, comparisonAvailable);

    setPublicCache(res, 900, 3600);
    return res.status(200).json({
      generatedAt:new Date().toISOString(),
      scope:'Traditional official candidate-set ranking completed before any crypto coverage is joined',
      methodology:{
        ranking:'Rank within the disclosed official candidate set by estimated share value + estimated standard-options underlying notional',
        candidatePool:'Current Nasdaq official dollar-volume leader snapshot ∪ current OCC options-volume leaders ∪ previous-session OCC options-volume leaders',
        rankingCompleteness:'official-candidate-set',
        candidateCaveat:'Nasdaq does not expose the previous dollar-volume-leader snapshot through this public feed, so this is a tracked official candidate-set Top 100 rather than a full U.S. market Top 100.',
        shareValue:'Nasdaq completed-session share volume × same-session close',
        optionsValue:'OCC same-session standard contracts × 100-share multiplier × Nasdaq close',
        caveat:'Estimated notionals; not consolidated share turnover or option-premium volume. Share volume and closing price are aligned to the OCC completed session. Adjusted option roots are excluded from notional.',
        directoryUniverse:directory.size,
        candidateCount:candidates.length,
        rankableCandidateCount:unrankedRows.filter(row => row.traditionalTotalValue > 0).length,
        rankingSession,
        comparisonSession,
        rankComparison:{
          status:comparisonAvailable ? 'full' : 'unavailable',
          definition:'Previous completed-session rank minus current rank; NEW means not in the previous candidate-set Top 100',
          caveat:'Comparison is within the disclosed union of current Nasdaq leaders plus current and previous OCC leaders; it does not reconstruct the previous Nasdaq mover snapshot.',
          alignment:comparisonAlignment,
        },
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
          previousAsOf:occBundle?.previousAsOf || null,
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

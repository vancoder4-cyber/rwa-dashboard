import { fetchWithPolicy } from './upstream.js';

export const NASDAQ_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt';
export const OTHER_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt';
export const NASDAQ_DIRECTORY_DEFINITIONS_URL = 'https://www.nasdaqtrader.com/trader.aspx?id=symboldirdefs';
export const US_MARKET_DIRECTORY_MAX_SOURCE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const US_MARKET_DIRECTORY_MAX_FUTURE_SKEW_MS = 15 * 60 * 1000;

const REQUIRED_DIRECTORY_SYMBOLS = Object.freeze(['AAPL', 'QQQ', 'BABA', 'TSM']);
const NEW_YORK_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit',
  hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23',
});

const ALWAYS_NON_COMMON_SECURITY_PATTERN = /\b(WARRANTS?|WTS?|RIGHTS?|UNITS?|ETNS?|CERTIFICATES?|ADW)\b/i;
const CONDITIONAL_NON_COMMON_SECURITY_PATTERN = /\b(PREFERRED|PREFERENCE|DEBENTURES?|BONDS?|NOTES?)\b/i;
const EXPLICIT_COMMON_SECURITY_PATTERN = /\bCOMMON (?:STOCK|SHARES?)\b/i;
const ADR_NAME_PATTERN = /(?:\b(?:AMERICAN DEPOSITARY|AMERICAN DEPOSITORY|DEPOSITARY SHARES?|DEPOSITORY SHARES?|ADR)\b|(?:^|[\s,(])ADS(?=$|[\s,)]))/i;

function directoryCreatedAt(text) {
  const match = String(text || '').match(/File Creation Time:\s*([0-9]{8})([0-9]{2}):([0-9]{2})/i);
  if (!match) return null;
  const [, mmddyyyy, hh, minute] = match;
  return `${mmddyyyy.slice(4)}-${mmddyyyy.slice(0, 2)}-${mmddyyyy.slice(2, 4)} ${hh}:${minute} ET`;
}

// Nasdaq Trader publishes local exchange time with an `ET` suffix but no
// numeric UTC offset. Resolve that wall clock through America/New_York so the
// freshness gate remains correct across EST/EDT transitions.
export function parseNasdaqTraderAsOf(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}) ET$/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const wallClockUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  if (!Number.isFinite(wallClockUtc)) return null;
  const expected = { year, month, day, hour, minute };
  // ET is UTC−4 during daylight time and UTC−5 otherwise. Validate both
  // candidates through an exact New York wall-clock round trip. This rejects
  // impossible dates/times and handles the DST boundary without Date.parse's
  // implementation-dependent normalization.
  const candidates = [4, 5].map(offsetHours => wallClockUtc + offsetHours * 60 * 60 * 1000);
  const matches = candidates.filter(candidate => {
    const parts = Object.fromEntries(
      NEW_YORK_CLOCK.formatToParts(new Date(candidate))
        .filter(part => part.type !== 'literal')
        .map(part => [part.type, part.value]),
    );
    return ['year','month','day','hour','minute'].every(key => parts[key] === expected[key]);
  });
  return matches.length ? Math.max(...matches) : null;
}

export function validateUsMarketDirectoryPayload(payload, { nowMs = Date.now() } = {}) {
  const rawSymbols = Array.isArray(payload?.symbols) ? payload.symbols : [];
  const rawEtfs = Array.isArray(payload?.etfs) ? payload.etfs : [];
  const rawAdrs = Array.isArray(payload?.adrs) ? payload.adrs : [];
  const symbols = rawSymbols
    .map(value => String(value || '').trim().toUpperCase());
  const adrs = rawAdrs
    .map(value => String(value || '').trim().toUpperCase());
  const etfs = rawEtfs
    .map(value => String(value || '').trim().toUpperCase());
  const symbolSet = new Set(symbols);
  const etfSet = new Set(etfs);
  const adrSet = new Set(adrs);
  const sourceCounts = payload?.coverage?.sourceCounts || {};
  const sourceAsOf = payload?.sourceAsOf || {};
  const sourceTimes = ['nasdaqListed', 'otherListed'].map(key => parseNasdaqTraderAsOf(sourceAsOf[key]));
  const oldestSourceMs = sourceTimes.every(Number.isFinite) ? Math.min(...sourceTimes) : null;
  const newestSourceMs = sourceTimes.every(Number.isFinite) ? Math.max(...sourceTimes) : null;
  const sourceAgeMs = oldestSourceMs === null ? null : nowMs - oldestSourceMs;
  const validUntilMs = oldestSourceMs === null ? null : oldestSourceMs + US_MARKET_DIRECTORY_MAX_SOURCE_AGE_MS;
  const freshnessValid = oldestSourceMs !== null && newestSourceMs !== null &&
    newestSourceMs <= nowMs + US_MARKET_DIRECTORY_MAX_FUTURE_SKEW_MS &&
    sourceAgeMs <= US_MARKET_DIRECTORY_MAX_SOURCE_AGE_MS;
  const listedCountMatches = Number(payload?.coverage?.listedSecurityCount) === symbols.length;
  const etfCountMatches = Number(payload?.coverage?.etfCount) === etfs.length;
  const adrCountMatches = Number(payload?.coverage?.adrCount) === adrs.length;
  const sortedSymbols = symbols.every((symbol, index) => index === 0 || symbols[index - 1].localeCompare(symbol) <= 0);
  const sortedAdrs = adrs.every((symbol, index) => index === 0 || adrs[index - 1].localeCompare(symbol) <= 0);
  const sortedEtfs = etfs.every((symbol, index) => index === 0 || etfs[index - 1].localeCompare(symbol) <= 0);
  const canonicalSymbols = rawSymbols.every((value, index) => value === symbols[index]);
  const canonicalAdrs = rawAdrs.every((value, index) => value === adrs[index]);
  const canonicalEtfs = rawEtfs.every((value, index) => value === etfs[index]);
  const generatedAtMs = Date.parse(payload?.generatedAt);
  const generatedAtValid = Number.isFinite(generatedAtMs) && generatedAtMs <= nowMs + US_MARKET_DIRECTORY_MAX_FUTURE_SKEW_MS;
  const expectedAsOf = oldestSourceMs === null
    ? null
    : sourceAsOf[sourceTimes[0] <= sourceTimes[1] ? 'nasdaqListed' : 'otherListed'];
  const declaredFreshness = payload?.freshness || {};
  const declaredSourceEpochs = declaredFreshness.sourceEpochs || {};
  const sourceEpochsValid = ['nasdaqListed', 'otherListed'].every((key, index) =>
    Number(declaredSourceEpochs[key]) === sourceTimes[index]
  );
  const freshnessProjectionValid = sourceEpochsValid &&
    Number(declaredFreshness.oldestSourceMs) === oldestSourceMs &&
    Number(declaredFreshness.newestSourceMs) === newestSourceMs &&
    Number(declaredFreshness.validUntilMs) === validUntilMs && payload?.asOf === expectedAsOf;
  const issues = [];
  if (!freshnessValid) issues.push('source-freshness');
  if (!freshnessProjectionValid) issues.push('freshness-projection');
  if (!generatedAtValid) issues.push('generated-at');
  if (!canonicalSymbols || !canonicalAdrs || !canonicalEtfs) issues.push('non-canonical-symbol');
  if (!sortedSymbols || !sortedAdrs || !sortedEtfs) issues.push('sort-order');
  if (!listedCountMatches || !adrCountMatches || !etfCountMatches) issues.push('coverage-count');
  if (symbolSet.size !== symbols.length || adrSet.size !== adrs.length || etfSet.size !== etfs.length) issues.push('duplicate');
  if (adrs.some(symbol => !symbolSet.has(symbol)) || !adrSet.has('BABA')) issues.push('adr-contract');
  if (etfs.some(symbol => !symbolSet.has(symbol)) || !etfSet.has('QQQ')) issues.push('etf-contract');
  if (REQUIRED_DIRECTORY_SYMBOLS.some(symbol => !symbolSet.has(symbol))) issues.push('required-sentinel');
  const valid = payload?.schemaVersion === 1 && payload?.status === 'full' &&
    symbols.length >= 8000 && symbolSet.size === symbols.length && adrSet.size === adrs.length && etfSet.size === etfs.length &&
    symbols.every(symbol => /^[A-Z][A-Z0-9.-]{0,13}$/.test(symbol)) &&
    Number(sourceCounts.nasdaqListed) >= 3000 && Number(sourceCounts.otherListed) >= 3000 &&
    Number(sourceCounts.nasdaqListed) + Number(sourceCounts.otherListed) >= symbols.length &&
    listedCountMatches && adrCountMatches && etfCountMatches && sortedSymbols && sortedAdrs && sortedEtfs &&
    canonicalSymbols && canonicalAdrs && canonicalEtfs && freshnessValid && freshnessProjectionValid && generatedAtValid &&
    REQUIRED_DIRECTORY_SYMBOLS.every(symbol => symbolSet.has(symbol)) &&
    adrSet.has('BABA') && etfSet.has('QQQ') && adrs.every(symbol => symbolSet.has(symbol)) &&
    etfs.every(symbol => symbolSet.has(symbol));
  if (!valid && !issues.length) issues.push('schema-or-completeness');
  const reason = valid ? null : `Official U.S. listing directory validation failed: ${issues.join(', ')}`;
  return {
    valid,
    listedSecurityCount:symbols.length,
    adrCount:adrs.length,
    etfCount:etfs.length,
    sourceCounts,
    sourceAsOf,
    oldestSourceMs,
    newestSourceMs,
    sourceAgeMs,
    validUntilMs,
    missingRequired:REQUIRED_DIRECTORY_SYMBOLS.filter(symbol => !symbolSet.has(symbol)),
    duplicateCount:symbols.length - symbolSet.size,
    adrDuplicateCount:adrs.length - adrSet.size,
    listedCountMatches,
    adrCountMatches,
    etfCountMatches,
    sortedSymbols,
    sortedAdrs,
    sortedEtfs,
    canonicalSymbols,
    canonicalAdrs,
    canonicalEtfs,
    sourceEpochsValid,
    freshnessProjectionValid,
    generatedAtValid,
    issues,
    reason,
  };
}

export function parseNasdaqDirectory(text, listingVenue) {
  const lines = String(text || '').trim().split(/\r?\n/);
  const headers = (lines.shift() || '').split('|');
  const rows = [];
  for (const line of lines) {
    if (!line || line.startsWith('File Creation Time')) continue;
    const columns = line.split('|');
    const record = Object.fromEntries(headers.map((header, index) => [header, columns[index] || '']));
    const actSymbol = String(record['ACT Symbol'] || '').trim().toUpperCase();
    const symbol = String(record.Symbol || record['NASDAQ Symbol'] || record['ACT Symbol'] || '').trim().toUpperCase();
    const name = String(record['Security Name'] || '').trim();
    if (!/^[A-Z][A-Z0-9.-]{0,13}$/.test(symbol) || record['Test Issue'] !== 'N' || !name) continue;
    // Other Listed uses `$` in ACT Symbol for preferred classes, while the
    // normalized NASDAQ Symbol replaces it with `-`. Inspect the raw ACT field
    // before projection so abbreviated preferred names cannot evade filtering.
    if (listingVenue === 'other' && actSymbol.includes('$')) continue;
    const category = record.ETF === 'Y' ? 'etf' : 'equity';
    // Bond/preferred exposure inside an ETF or an issuer/fund name is not
    // itself a debt/preferred security identity. Preserve explicit Common
    // Stock/Common Shares (for example Preferred Bank and bond funds), while
    // always excluding warrants, rights, units, ETNs, and certificates.
    if (category !== 'etf' && (
      ALWAYS_NON_COMMON_SECURITY_PATTERN.test(name) ||
      (CONDITIONAL_NON_COMMON_SECURITY_PATTERN.test(name) && !EXPLICIT_COMMON_SECURITY_PATTERN.test(name))
    )) continue;
    rows.push({
      symbol,
      name,
      category,
      exchange:listingVenue === 'nasdaq' ? 'NASDAQ' : (record.Exchange || null),
      // An ADR-themed ETF is still an ETF, not itself a depositary receipt.
      tags:category === 'equity' && ADR_NAME_PATTERN.test(name) ? ['ADR'] : [],
    });
  }
  return rows;
}

async function fetchDirectoryText(url) {
  const response = await fetchWithPolicy(
    url,
    { headers:{ Accept:'text/plain, */*', 'User-Agent':'Avenir-RWA-Analyst/1.0' } },
    { timeoutMs:10_000, retries:1 },
  );
  if (!response.ok) throw new Error(`Nasdaq Trader directory HTTP ${response.status}`);
  return response.text();
}

export async function fetchUsListedDirectory() {
  const [nasdaqText, otherText] = await Promise.all([
    fetchDirectoryText(NASDAQ_LISTED_URL),
    fetchDirectoryText(OTHER_LISTED_URL),
  ]);
  const nasdaqRows = parseNasdaqDirectory(nasdaqText, 'nasdaq');
  const otherRows = parseNasdaqDirectory(otherText, 'other');
  const rows = [...nasdaqRows, ...otherRows];
  const bySymbol = new Map();
  for (const row of rows) {
    const existing = bySymbol.get(row.symbol);
    if (!existing || (row.tags.includes('ADR') && !existing.tags.includes('ADR'))) bySymbol.set(row.symbol, row);
  }
  const sourceAsOf = {
    nasdaqListed:directoryCreatedAt(nasdaqText),
    otherListed:directoryCreatedAt(otherText),
  };
  const sourceTimes = Object.fromEntries(
    Object.entries(sourceAsOf).map(([key, value]) => [key, parseNasdaqTraderAsOf(value)]),
  );
  const oldestSourceKey = sourceTimes.nasdaqListed <= sourceTimes.otherListed ? 'nasdaqListed' : 'otherListed';
  return {
    bySymbol,
    sourceAsOf,
    sourceCounts:{ nasdaqListed:nasdaqRows.length, otherListed:otherRows.length },
    // Overall freshness is bounded by the older of the two required files.
    asOf:sourceAsOf[oldestSourceKey] || null,
  };
}

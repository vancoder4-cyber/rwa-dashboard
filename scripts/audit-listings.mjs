import { appendFile } from 'node:fs/promises';

import { getJsonWithRetry } from './_lib/http.mjs';

const SCHEMA_VERSION = 'rwa-listing-audit/v1';
const EXPECTED_SOURCES = 10;
const MAX_AGE_HOURS = 36;
const WINDOW_DAYS = 7;
const HISTORY_RETENTION_DAYS = 45;
const baseUrl = String(process.env.DASHBOARD_URL || 'https://avenir-rwa-analyst.vercel.app').replace(/\/$/, '');
const { response, payload } = await getJsonWithRetry(`${baseUrl}/api/listing-changes`, { allowErrorResponse: true });

if (payload?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(payload?.sources) ||
    !Array.isArray(payload?.events) || !Array.isArray(payload?.pendingReviews) || !payload?.history) {
  throw new Error(`Listing audit endpoint returned an invalid payload (HTTP ${response.status})`);
}
const history = payload.history;
const historyTimestampValid = value => value === null ||
  (typeof value === 'string' && Number.isFinite(Date.parse(value)));
const historyFieldsPresent = ['retentionDays', 'maxEvents', 'truncated', 'droppedAtLeast', 'droppedThrough', 'retainedFrom']
  .every(key => Object.prototype.hasOwnProperty.call(history, key));
const historyValid = historyFieldsPresent &&
  Number.isInteger(history.retentionDays) && history.retentionDays === HISTORY_RETENTION_DAYS &&
  Number.isInteger(history.maxEvents) && history.maxEvents > 0 &&
  typeof history.truncated === 'boolean' &&
  Number.isInteger(history.droppedAtLeast) && history.droppedAtLeast >= 0 &&
  historyTimestampValid(history.droppedThrough ?? null) && historyTimestampValid(history.retainedFrom ?? null) &&
  (!history.truncated
    ? history.droppedAtLeast === 0 && (history.droppedThrough ?? null) === null
    : history.droppedAtLeast > 0 && typeof history.droppedThrough === 'string' && Number.isFinite(Date.parse(history.droppedThrough))) &&
  (!history.truncated || payload.status !== 'full') &&
  payload.events.length <= history.maxEvents;
if (!historyValid) throw new Error('Listing audit returned an invalid history-retention contract');
const generatedAtMs = Date.parse(payload.generatedAt);
if (!Number.isFinite(generatedAtMs)) throw new Error('Listing audit has not established its first daily snapshot');
const ageHours = (Date.now() - generatedAtMs) / 3_600_000;
if (ageHours < -0.1 || ageHours > MAX_AGE_HOURS) {
  throw new Error(`Listing audit snapshot is ${ageHours.toFixed(1)} hours old; expected <= ${MAX_AGE_HOURS}`);
}
if (Number(payload?.coverage?.expectedSources) !== EXPECTED_SOURCES || payload.sources.length !== EXPECTED_SOURCES) {
  throw new Error(`Listing audit expected ${EXPECTED_SOURCES} sources, received ${payload.sources.length}`);
}

const cutoff = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1_000;
const recent = payload.events.filter(event =>
  ['new', 'relisted'].includes(event?.changeType) && Date.parse(event?.detectedAt) >= cutoff
);
const pending = payload.pendingReviews;
const unavailable = payload.sources.filter(source => source?.status === 'unavailable');
const summary = {
  baseUrl,
  status: payload.status,
  generatedAt: payload.generatedAt,
  ageHours: Number(ageHours.toFixed(2)),
  coverage: payload.coverage,
  rollingWindowDays: WINDOW_DAYS,
  history: {
    retentionDays: history.retentionDays,
    maxEvents: history.maxEvents,
    truncated: history.truncated,
    droppedAtLeast: history.droppedAtLeast,
    droppedThrough: history.droppedThrough,
    retainedFrom: history.retainedFrom,
  },
  newOrRelisted: recent.length,
  reviewRequired: pending.length,
  unavailableSources: unavailable.map(source => source.sourceKey),
  events: recent.slice(0, 50).map(event => ({
    detectedAt: event.detectedAt,
    changeType: event.changeType,
    market: event.market,
    venue: event.venue,
    venueSymbol: event.venueSymbol,
    canonicalSymbol: event.canonicalSymbol,
    category: event.category,
    identityStatus: event.identityStatus,
    inclusionStatus: event.inclusionStatus,
  })),
};
console.log(JSON.stringify(summary, null, 2));

if (recent.length) {
  console.log(`::notice title=RWA competitor listings::${recent.length} new or re-listed assets in the rolling ${WINDOW_DAYS}-day window`);
}
if (pending.length) {
  console.log(`::warning title=RWA identity review required::${pending.length} new listing candidates remain fail-closed pending official identity confirmation`);
}
if (history.truncated) {
  console.log(`::warning title=RWA listing history truncated::At least ${history.droppedAtLeast} older events were omitted after the ${history.maxEvents}-event safety limit; rolling-window counts are lower bounds`);
}
for (const source of unavailable) {
  console.log(`::warning title=RWA listing source unavailable::${source.sourceKey}: ${source.reason || 'official catalog unavailable'}`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = recent.slice(0, 50).map(event =>
    `| ${event.detectedAt} | ${event.market} | ${event.venue} | ${event.venueSymbol} | ${event.canonicalSymbol} | ${event.changeType} | ${event.identityStatus} |`
  );
  const markdown = [
    '## Competitor New Listings · rolling 7 days',
    '',
    `- Snapshot: ${payload.generatedAt}`,
    `- Sources: ${payload.coverage.availableSources}/${payload.coverage.expectedSources}`,
    `- New / re-listed: ${recent.length}`,
    `- Review required: ${pending.length}`,
    `- History: ${history.truncated ? `Partial — at least ${history.droppedAtLeast} events omitted at the ${history.maxEvents}-event safety limit` : `Full retained window — target ${history.retentionDays} days, ${payload.events.length}/${history.maxEvents} events`}`,
    '',
    ...(rows.length ? [
      '| Detected | Market | Venue | Instrument | Canonical | Change | Identity |',
      '|---|---|---|---|---|---|---|',
      ...rows,
    ] : [history.truncated
      ? 'No matching retained events; history is truncated, so this is not a complete zero-event conclusion.'
      : 'No new competitor listings in the rolling seven-day window.']),
    '',
  ].join('\n');
  await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown, 'utf8');
}

if (!response.ok || payload.status === 'unavailable' || unavailable.length || history.truncated) process.exitCode = 1;

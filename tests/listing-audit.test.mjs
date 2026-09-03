import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isReviewedLifecycleCategoryCorrection,
  REVIEWED_ETF_CATEGORY_CORRECTIONS,
  LISTING_SOURCE_KEYS,
  mergeListingAudit,
  normalizeListingObservation,
} from '../api/_lib/listing-audit.js';
import listingAuditCronHandler from '../api/listing-audit-cron.js';
import listingChangesHandler, {
  compactListingAuditBundle,
  hydrateListingAuditSnapshot,
  hydrateListingAuditState,
  listingSnapshotIsCacheable,
} from '../api/listing-changes.js';
import { validateListingAuditSnapshot } from '../api/health.js';
import {
  gateExactLegacySpotListing,
  isDedicatedTradeXyzSource,
  krakenListingCandidate,
  mergeKrakenOfficialPairEntries,
  tradeXyzListingFromOfficial,
} from '../api/_lib/listing-sources.js';

function responseRecorder() {
  return {
    statusCode:200,
    payload:null,
    headers:{},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function row(sourceKey, symbol = 'AAPL') {
  const [market, venue] = sourceKey.split(':');
  const venueSymbol = market === 'perp' ? `${symbol}-${venue.toUpperCase()}-PERP` : `${symbol}-${venue.toUpperCase()}-SPOT`;
  return {
    market,
    venue,
    venueSymbol,
    canonicalSymbol: symbol,
    category: 'equity',
    identityStatus: 'verified',
    identityEvidence: `${venue} official RWA catalog`,
  };
}

function fullObservations(overrides = {}) {
  return LISTING_SOURCE_KEYS.map(sourceKey => {
    const [market, venue] = sourceKey.split(':');
    return overrides[sourceKey] || { market, venue, status: 'full', listings: [row(sourceKey)] };
  });
}

test('listing audit first successful pass establishes ten independent baselines without false NEW events', () => {
  const first = mergeListingAudit(null, fullObservations(), new Date('2026-08-14T00:45:00Z'));
  assert.equal(first.snapshot.status, 'warming');
  assert.equal(first.snapshot.coverage.expectedSources, 10);
  assert.equal(first.snapshot.coverage.warmingSources, 10);
  assert.equal(first.snapshot.events.length, 0);
  assert.equal(first.snapshot.counts.activeListings, 10);
  assert.deepEqual(Object.keys(first.state.sources).sort(), [...LISTING_SOURCE_KEYS].sort());
});

test('listing audit emits Spot and Perp additions once and leaves an unavailable source baseline untouched', () => {
  const first = mergeListingAudit(null, fullObservations(), new Date('2026-08-14T00:45:00Z'));
  const secondObservations = fullObservations({
    'perp:binance': {
      market: 'perp', venue: 'binance', status: 'full',
      listings: [row('perp:binance'), row('perp:binance', 'NEWP')],
    },
    'spot:okx': {
      market: 'spot', venue: 'okx', status: 'full',
      listings: [row('spot:okx'), row('spot:okx', 'NEWS')],
    },
    'spot:gate': {
      market: 'spot', venue: 'gate', status: 'unavailable', listings: [], reason: 'official pair catalog timeout',
    },
  });
  const second = mergeListingAudit(first.state, secondObservations, new Date('2026-08-15T00:45:00Z'));
  assert.equal(second.snapshot.status, 'partial');
  assert.equal(second.snapshot.events.filter(event => event.changeType === 'new').length, 2);
  assert.deepEqual(second.snapshot.events.filter(event => event.changeType === 'new').map(event => event.market).sort(), ['perp', 'spot']);
  const gateSummary = second.snapshot.sources.find(source => source.sourceKey === 'spot:gate');
  assert.equal(gateSummary.status, 'unavailable');
  assert.equal(gateSummary.listingCount, 1);
  assert.equal(second.state.sources['spot:gate'].observedAt, first.state.sources['spot:gate'].observedAt);

  const repeated = mergeListingAudit(second.state, secondObservations, new Date('2026-08-15T01:15:00Z'));
  assert.equal(repeated.newEvents.length, 0);
  assert.equal(repeated.snapshot.events.filter(event => event.changeType === 'new').length, 2);
});

test('official product time supplements a diff-detected event but never creates one by itself', () => {
  const baseline = mergeListingAudit(null, fullObservations(), new Date('2026-09-01T00:45:00Z'));
  const officialListedAt = '2026-09-01T12:00:00.000Z';
  const withAddition = fullObservations({
    'perp:binance':{
      market:'perp', venue:'binance', status:'full',
      listings:[
        row('perp:binance'),
        { ...row('perp:binance', 'TIMED'), officialListedAt },
      ],
    },
  });
  const detected = mergeListingAudit(baseline.state, withAddition, new Date('2026-09-02T00:45:00Z'));
  assert.equal(detected.newEvents.length, 1);
  assert.equal(detected.newEvents[0].officialListedAt, officialListedAt);
  assert.equal(detected.newEvents[0].timeBasis, 'official');
  assert.equal(detected.newEvents[0].observedAt, '2026-09-02T00:45:00.000Z');

  const noDirectoryChange = mergeListingAudit(baseline.state, fullObservations({
    'perp:binance':{
      market:'perp', venue:'binance', status:'full',
      listings:[{ ...row('perp:binance'), officialListedAt }],
    },
  }), new Date('2026-09-02T00:45:00Z'));
  assert.deepEqual(noDirectoryChange.newEvents, []);
});

test('listing events publish venue contract category and lifecycle as separate fields', () => {
  const first = mergeListingAudit(null, fullObservations(), new Date('2026-08-14T00:45:00Z'));
  const unitree = tradeXyzListingFromOfficial({
    name:'xyz:UNITREE', fullName:'Unitree Robotics', isDelisted:false,
  }, 'stocks');
  const second = mergeListingAudit(first.state, fullObservations({
    'perp:tradexyz': {
      market:'perp', venue:'tradexyz', status:'full',
      listings:[row('perp:tradexyz'), unitree],
    },
  }), new Date('2026-08-15T00:45:00Z'));
  const event = second.newEvents.find(candidate => candidate.venueSymbol === 'XYZ:UNITREE');
  assert.equal(event.category, 'equity');
  assert.equal(event.venueCategory, 'equity');
  assert.equal(event.lifecycleStatus, 'public');
  assert.equal(event.name, 'Unitree Robotics');
  assert.equal(event.observedAt, event.detectedAt);
  const health = validateListingAuditSnapshot(second.snapshot, Date.parse('2026-08-15T01:00:00Z'));
  assert.equal(health.eventClassificationValid, true);

  const missingVenueCategory = structuredClone(second.snapshot);
  delete missingVenueCategory.events.find(candidate => candidate.venueSymbol === 'XYZ:UNITREE').venueCategory;
  const invalidHealth = validateListingAuditSnapshot(missingVenueCategory, Date.parse('2026-08-15T01:00:00Z'));
  assert.equal(invalidHealth.eventClassificationValid, false);
  assert.equal(invalidHealth.status, 'fail');
});

test('a reviewed public-company lifecycle correction updates the same instrument without a listing event', () => {
  const oldUnitree = {
    ...row('perp:tradexyz', 'UNITREE'),
    canonicalSymbol:'UNITREE',
    category:'pre-ipo',
    venueCategory:'equity',
    lifecycleStatus:'ipo-registered',
    name:'Unitree Robotics (Pre-IPO)',
  };
  const baseline = mergeListingAudit(null, fullObservations({
    'perp:tradexyz':{
      market:'perp', venue:'tradexyz', status:'full', listings:[oldUnitree],
    },
  }), new Date('2026-08-18T00:45:00Z'));
  const publicUnitree = {
    ...oldUnitree,
    category:'equity',
    lifecycleStatus:'public',
    name:'Unitree Robotics',
  };
  const corrected = mergeListingAudit(baseline.state, fullObservations({
    'perp:tradexyz':{
      market:'perp', venue:'tradexyz', status:'full', listings:[publicUnitree],
    },
  }), new Date('2026-08-19T00:45:00Z'));
  assert.equal(corrected.snapshot.sources.find(source => source.sourceKey === 'perp:tradexyz').status, 'full');
  assert.deepEqual(corrected.newEvents, []);
  assert.equal(corrected.state.known[`perp:tradexyz:${oldUnitree.venueSymbol}`]?.category, 'equity');
});

test('lifecycle correction bypass is one-way and limited to dated reviewed public companies', () => {
  const previous = {
    canonicalSymbol:'UNREVIEWED',
    category:'pre-ipo',
    venueCategory:'equity',
    lifecycleStatus:'ipo-registered',
  };
  const current = {
    ...previous,
    category:'equity',
    lifecycleStatus:'public',
  };
  assert.equal(isReviewedLifecycleCategoryCorrection(previous, current), false);
  assert.equal(isReviewedLifecycleCategoryCorrection(
    { ...current, canonicalSymbol:'UNITREE' },
    { ...previous, canonicalSymbol:'UNITREE' },
  ), false, 'a public-to-Pre-IPO reversal must never bypass identity review');
});

test('reviewed SKDD ETF correction survives pending removal and does not synthesize a listing event', () => {
  const xperp = {
    ...row('perp:okx', 'SKDD'),
    venueSymbol:'SKDD-USD_UM_XPERP-310829',
    canonicalSymbol:'SKDD',
    category:'equity',
    venueCategory:'equity',
    name:'SKDD',
  };
  const swap = {
    ...xperp,
    venueSymbol:'SKDD-USDT-SWAP',
  };
  const baseline = mergeListingAudit(null, fullObservations({
    'perp:okx':{ market:'perp', venue:'okx', status:'full', listings:[xperp, swap] },
  }), new Date('2026-09-02T00:45:00Z'));

  // Simulate the persisted pre-correction Runtime Cache identity.
  const legacy = structuredClone(baseline.state);
  for (const listingKey of legacy.sources['perp:okx'].listingKeys) {
    legacy.known[listingKey].category = 'equity';
    legacy.known[listingKey].name = 'SKDD';
  }

  const missingXperp = fullObservations({
    'perp:okx':{ market:'perp', venue:'okx', status:'full', listings:[swap] },
  });
  const pending = mergeListingAudit(legacy, missingXperp, new Date('2026-09-03T00:45:00Z'));
  const listingKey = 'perp:okx:SKDD-USD_UM_XPERP-310829';
  assert.deepEqual(pending.newEvents, []);
  assert.equal(pending.state.known[listingKey].category, 'etf');
  assert.equal(pending.state.known[listingKey].venueCategory, 'equity');
  assert.equal(pending.state.known[listingKey].name, 'GraniteShares 2x Short SK Hynix Daily ETF');
  assert.equal(pending.state.known[listingKey].active, true);

  const removed = mergeListingAudit(pending.state, missingXperp, new Date('2026-09-04T00:45:00Z'));
  assert.equal(removed.newEvents.length, 1);
  assert.deepEqual({
    listingKey:removed.newEvents[0].listingKey,
    changeType:removed.newEvents[0].changeType,
    category:removed.newEvents[0].category,
    venueCategory:removed.newEvents[0].venueCategory,
    name:removed.newEvents[0].name,
  }, {
    listingKey,
    changeType:'delisted',
    category:'etf',
    venueCategory:'equity',
    name:'GraniteShares 2x Short SK Hynix Daily ETF',
  });
  assert.deepEqual(REVIEWED_ETF_CATEGORY_CORRECTIONS, ['SKDD', 'SKUU']);
});

test('listing audit distinguishes delisting from a later relisting', () => {
  const first = mergeListingAudit(null, fullObservations(), new Date('2026-08-14T00:45:00Z'));
  const added = mergeListingAudit(first.state, fullObservations({
    'perp:gate': {
      market: 'perp', venue: 'gate', status: 'full',
      listings: [row('perp:gate'), row('perp:gate', 'RETURN')],
    },
  }), new Date('2026-08-15T00:45:00Z'));
  const pendingRemoval = mergeListingAudit(added.state, fullObservations(), new Date('2026-08-16T00:45:00Z'));
  assert.equal(pendingRemoval.newEvents.length, 0);
  assert.equal(pendingRemoval.snapshot.status, 'partial');
  assert.equal(pendingRemoval.snapshot.sources.find(source => source.sourceKey === 'perp:gate').pendingRemovalCount, 1);
  const sameDayRetry = mergeListingAudit(pendingRemoval.state, fullObservations(), new Date('2026-08-16T01:45:00Z'));
  assert.equal(sameDayRetry.newEvents.length, 0, 'same-day retry must not count as a second daily observation');
  assert.equal(sameDayRetry.snapshot.sources.find(source => source.sourceKey === 'perp:gate').pendingRemovalCount, 1);
  const removed = mergeListingAudit(sameDayRetry.state, fullObservations(), new Date('2026-08-17T00:45:00Z'));
  assert.equal(removed.newEvents[0].changeType, 'delisted');
  const relisted = mergeListingAudit(removed.state, fullObservations({
    'perp:gate': {
      market: 'perp', venue: 'gate', status: 'full',
      listings: [row('perp:gate'), row('perp:gate', 'RETURN')],
    },
  }), new Date('2026-08-18T00:45:00Z'));
  assert.equal(relisted.newEvents[0].changeType, 'relisted');
  assert.equal(relisted.newEvents[0].inclusionStatus, 'eligible');
});

test('listing audit quarantines a delisted venue symbol reused for a different RWA identity', () => {
  const first = mergeListingAudit(null, fullObservations(), new Date('2026-08-14T00:45:00Z'));
  const withoutGateListing = fullObservations({
    'perp:gate': { market:'perp', venue:'gate', status:'full', listings:[] },
  });
  const pending = mergeListingAudit(first.state, withoutGateListing, new Date('2026-08-15T00:45:00Z'));
  const removed = mergeListingAudit(pending.state, withoutGateListing, new Date('2026-08-16T00:45:00Z'));
  const listingKey = 'perp:gate:AAPL-GATE-PERP';
  assert.equal(removed.state.known[listingKey].active, false);

  const reused = mergeListingAudit(removed.state, fullObservations({
    'perp:gate': {
      market:'perp', venue:'gate', status:'full',
      listings:[{ ...row('perp:gate'), canonicalSymbol:'MSFT' }],
    },
  }), new Date('2026-08-17T00:45:00Z'));
  const gateSummary = reused.snapshot.sources.find(source => source.sourceKey === 'perp:gate');
  assert.equal(gateSummary.status, 'unavailable');
  assert.match(gateSummary.reason, /identity drift.*AAPL-GATE-PERP/);
  assert.equal(reused.newEvents.length, 0);
  assert.equal(reused.state.known[listingKey].canonicalSymbol, 'AAPL');
  assert.equal(reused.state.known[listingKey].active, false);
  assert.deepEqual(reused.state.sources['perp:gate'].listingKeys, []);
});

test('listing audit admits bounded official growth but quarantines destructive or extreme catalog drift', () => {
  const baselineRows = Array.from({ length:10 }, (_, index) => row('perp:gate', `BASE${index}`));
  const first = mergeListingAudit(null, fullObservations({
    'perp:gate': { market:'perp', venue:'gate', status:'full', listings:baselineRows },
  }), new Date('2026-08-14T00:45:00Z'));
  const expandedRows = [...baselineRows, ...Array.from({ length:6 }, (_, index) => row('perp:gate', `NEW${index}`))];
  const legitimateGrowth = mergeListingAudit(first.state, fullObservations({
    'perp:gate': { market:'perp', venue:'gate', status:'full', listings:expandedRows },
  }), new Date('2026-08-15T00:45:00Z'));
  const growthSummary = legitimateGrowth.snapshot.sources.find(source => source.sourceKey === 'perp:gate');
  assert.equal(growthSummary.status, 'full');
  assert.equal(legitimateGrowth.newEvents.length, 6);
  assert.equal(legitimateGrowth.state.sources['perp:gate'].listingKeys.length, 16);

  const extremeRows = [
    ...baselineRows,
    ...Array.from({ length:60 }, (_, index) => row('perp:gate', `SURGE${index}`)),
  ];
  const drifted = mergeListingAudit(first.state, fullObservations({
    'perp:gate': { market:'perp', venue:'gate', status:'full', listings:extremeRows },
  }), new Date('2026-08-15T00:45:00Z'));
  const driftSummary = drifted.snapshot.sources.find(source => source.sourceKey === 'perp:gate');
  assert.equal(driftSummary.status, 'unavailable');
  assert.match(driftSummary.reason, /extreme-growth review threshold/);
  assert.equal(drifted.newEvents.length, 0);
  assert.equal(drifted.state.sources['perp:gate'].listingKeys.length, 10);

  const destructiveRows = baselineRows.slice(0, 4);
  const destructive = mergeListingAudit(first.state, fullObservations({
    'perp:gate': { market:'perp', venue:'gate', status:'full', listings:destructiveRows },
  }), new Date('2026-08-15T00:45:00Z'));
  const destructiveSummary = destructive.snapshot.sources.find(source => source.sourceKey === 'perp:gate');
  assert.equal(destructiveSummary.status, 'unavailable');
  assert.match(destructiveSummary.reason, /with removals/);

  const invalid = mergeListingAudit(first.state, fullObservations({
    'perp:gate': {
      market:'perp', venue:'gate', status:'full',
      listings:[...baselineRows, { ...row('perp:gate', 'BTC'), category:'crypto' }],
    },
  }), new Date('2026-08-15T00:45:00Z'));
  const invalidSummary = invalid.snapshot.sources.find(source => source.sourceKey === 'perp:gate');
  assert.equal(invalidSummary.status, 'unavailable');
  assert.match(invalidSummary.reason, /normalization rejected 1 invalid/);
  assert.equal(invalid.state.sources['perp:gate'].listingKeys.length, 10);
});

test('listing audit keeps active review reminders and closes them when exact identity becomes verified', () => {
  const candidate = { ...row('spot:gate', 'FUTURE'), identityStatus:'review-required' };
  const first = mergeListingAudit(null, fullObservations({
    'spot:gate': { market:'spot', venue:'gate', status:'full', listings:[candidate] },
  }), new Date('2026-08-14T00:45:00Z'));
  assert.equal(first.snapshot.events.length, 0);
  assert.equal(first.snapshot.pendingReviews.length, 1);
  assert.equal(first.snapshot.counts.reviewRequired, 1);

  const verified = mergeListingAudit(first.state, fullObservations({
    'spot:gate': {
      market:'spot', venue:'gate', status:'full',
      listings:[{ ...candidate, identityStatus:'verified', identityEvidence:'exact audited official wrapper' }],
    },
  }), new Date('2026-08-15T00:45:00Z'));
  assert.equal(verified.newEvents.length, 0);
  assert.equal(verified.snapshot.pendingReviews.length, 0);
  assert.equal(verified.state.known[candidate.market + ':' + candidate.venue + ':' + candidate.venueSymbol].inclusionStatus, 'eligible');
});

test('listing identity normalization fails closed for Crypto and keeps ambiguous Gate candidates out of auto-inclusion', () => {
  assert.equal(normalizeListingObservation({
    market: 'spot', venue: 'gate', venueSymbol: 'QNT_USDT', canonicalSymbol: 'QNT', category: 'crypto',
  }), null);
  const candidate = normalizeListingObservation({
    market: 'spot', venue: 'gate', venueSymbol: 'FUTUREX_USDT', canonicalSymbol: 'FUTURE', category: 'equity',
    identityStatus: 'review-required',
  });
  assert.equal(candidate.identityStatus, 'review-required');
  assert.equal(candidate.inclusionStatus, 'review-required');
});

test('trade.xyz preserves the official contract class separately from company lifecycle', () => {
  const unitree = tradeXyzListingFromOfficial({
    name:'xyz:UNITREE',
    fullName:'Unitree Robotics',
    isDelisted:false,
  }, 'stocks');
  assert.deepEqual(unitree, {
    market:'perp',
    venue:'tradexyz',
    venueSymbol:'XYZ:UNITREE',
    canonicalSymbol:'UNITREE',
    category:'equity',
    venueCategory:'equity',
    lifecycleStatus:'public',
    name:'Unitree Robotics',
    identityStatus:'verified',
    identityEvidence:'Hyperliquid perpCategories:stocks',
  });

  const normalized = normalizeListingObservation(unitree);
  assert.equal(normalized.venueCategory, 'equity');
  assert.equal(normalized.lifecycleStatus, 'public');
});

test('listing collectors reject global trade.xyz fallback and Kraken same-suffix Crypto collisions', () => {
  assert.equal(isDedicatedTradeXyzSource('dex:xyz'), true);
  assert.equal(isDedicatedTradeXyzSource('dex:XYZ'), true);
  assert.equal(isDedicatedTradeXyzSource('all_perps'), false);
  assert.equal(krakenListingCandidate('SNXUSD', {
    altname:'SNXUSD', wsname:'SNX/USD', base:'SNX', quote:'ZUSD',
    aclass_base:'currency', status:'online',
  }), null);
  assert.equal(krakenListingCandidate('AAPLSPVUSD', {
    altname:'AAPLxUSD', wsname:'AAPLx/USD', base:'AAPLx', quote:'ZUSD',
    aclass_base:'tokenized_asset', status:'post_only',
  }), null);
  assert.deepEqual(krakenListingCandidate('AAPLSPVUSD', {
    altname:'AAPLxUSD', wsname:'AAPLx/USD', base:'AAPLx', quote:'ZUSD',
    aclass_base:'tokenized_asset', status:'online',
  }), { venueSymbol:'AAPLXUSD', marketQuerySymbol:'AAPLxUSD', underlying:'AAPL', category:'equity' });
  assert.deepEqual(krakenListingCandidate('NEWETFSPVUSD', {
    altname:'NEWETFxUSD', wsname:'NEWETFx/USD', base:'NEWETFx', quote:'ZUSD',
    aclass_base:'tokenized_asset', status:'online',
  }, new Set(['NEWETF'])), { venueSymbol:'NEWETFXUSD', marketQuerySymbol:'NEWETFxUSD', underlying:'NEWETF', category:'etf' });
  assert.deepEqual(krakenListingCandidate('PAXGUSD', {
    altname:'PAXGUSD', wsname:'PAXG/USD', base:'PAXG', quote:'ZUSD',
    aclass_base:'currency', status:'online',
  }), { venueSymbol:'PAXGUSD', marketQuerySymbol:'PAXGUSD', underlying:'PAXG', category:'commodity' });
});

test('Kraken official pair variants merge deterministically without admitting internal SPV or Crypto aliases', () => {
  const aapl = {
    altname:'AAPLxUSD', wsname:'AAPLx/USD', base:'AAPLx', quote:'ZUSD',
    aclass_base:'tokenized_asset', status:'online',
  };
  const merged = mergeKrakenOfficialPairEntries([
    ['AAPLSPVUSD', aapl],
    ['AAPLxUSD', aapl],
    ['SNXUSD', {
      altname:'SNXUSD', wsname:'SNX/USD', base:'SNX', quote:'ZUSD',
      aclass_base:'currency', status:'online',
    }],
    ['PAXGZUSD', {
      altname:'PAXGUSD', wsname:'PAXG/USD', base:'PAXG', quote:'ZUSD',
      aclass_base:'currency', status:'online',
    }],
  ]);

  assert.equal(merged.length, 2);
  const tokenized = merged.find(row => row.venueSymbol === 'AAPLXUSD');
  assert.equal(tokenized.marketQuerySymbol, 'AAPLxUSD');
  assert.equal(tokenized.marketDataProfile, 'kraken-tokenized');
  assert.deepEqual(new Set(tokenized.marketAliases), new Set(['AAPLxUSD', 'AAPLx/USD']));
  assert.equal(tokenized.marketAliases.includes('AAPLSPVUSD'), false,
    'the internal SPV object key is not the tradable xStock ticker identity');

  const standard = merged.find(row => row.venueSymbol === 'PAXGUSD');
  assert.deepEqual(new Set(standard.marketAliases), new Set(['PAXGZUSD', 'PAXGUSD', 'PAXG/USD']));
  assert.equal(merged.some(row => row.venueSymbol === 'SNXUSD'), false,
    'an ordinary Crypto pair ending in X must not become a tokenized security');

  const reversed = mergeKrakenOfficialPairEntries([
    ['PAXGZUSD', {
      altname:'PAXGUSD', wsname:'PAXG/USD', base:'PAXG', quote:'ZUSD',
      aclass_base:'currency', status:'online',
    }],
    ['SNXUSD', {
      altname:'SNXUSD', wsname:'SNX/USD', base:'SNX', quote:'ZUSD',
      aclass_base:'currency', status:'online',
    }],
    ['AAPLxUSD', aapl],
    ['AAPLSPVUSD', aapl],
  ]);
  assert.deepEqual(
    reversed.map(row => ({ ...row, marketAliases:[...row.marketAliases].sort() })).sort((a, b) => a.venueSymbol.localeCompare(b.venueSymbol)),
    merged.map(row => ({ ...row, marketAliases:[...row.marketAliases].sort() })).sort((a, b) => a.venueSymbol.localeCompare(b.venueSymbol)),
    'catalog response order must not change the admitted identities or their official aliases',
  );
});

test('Gate listing audit admits only the two exact live legacy commodity pairs', () => {
  assert.deepEqual(gateExactLegacySpotListing({
    id:'PAXG_USDT', base:'PAXG', quote:'USDT', trade_status:'tradable',
  }), {
    market:'spot', venue:'gate', venueSymbol:'PAXG_USDT', canonicalSymbol:'XAU', category:'commodity',
    venueCategory:'commodity', lifecycleStatus:null,
    name:null, identityStatus:'verified',
    identityEvidence:'exact audited Gate legacy RWA pair (2026-08-14) in the live official catalog',
  });
  assert.deepEqual(gateExactLegacySpotListing({
    id:'XAUT_USDT', base:'XAUT', quote:'USDT', trade_status:'tradable',
  }), {
    market:'spot', venue:'gate', venueSymbol:'XAUT_USDT', canonicalSymbol:'XAU', category:'commodity',
    venueCategory:'commodity', lifecycleStatus:null,
    name:null, identityStatus:'verified',
    identityEvidence:'exact audited Gate legacy RWA pair (2026-08-14) in the live official catalog',
  });
  assert.equal(gateExactLegacySpotListing({
    id:'PAXG_USD', base:'PAXG', quote:'USD', trade_status:'tradable',
  }), null, 'the exception must not expand to another quote');
  assert.equal(gateExactLegacySpotListing({
    id:'XAUT_USD', base:'XAUT', quote:'USD', trade_status:'tradable',
  }), null, 'the XAUT exception must not expand to another quote');
  assert.equal(gateExactLegacySpotListing({
    id:'PAXG_USDT', base:'PAXG', quote:'BTC', trade_status:'tradable',
  }), null, 'the official fields must agree with the exact pair identifier');
  assert.equal(gateExactLegacySpotListing({
    id:'PAXG_USDT', base:'XAUM', quote:'USDT', trade_status:'tradable',
  }), null, 'a mismatched or merely gold-like base must fail closed');
  assert.equal(gateExactLegacySpotListing({
    id:'PAXG_USDT', base:'PAXG', quote:'USDT', trade_status:'halted',
  }), null, 'an inactive official pair is not a live listing');
  assert.equal(gateExactLegacySpotListing({
    id:'QNT_USDT', base:'QNT', quote:'USDT', trade_status:'tradable',
  }), null, 'a same-ticker Crypto pair must remain excluded');
  assert.equal(gateExactLegacySpotListing({
    id:'XAUM_USDT', base:'XAUM', quote:'USDT', trade_status:'tradable',
  }), null, 'another metal token cannot inherit the two exact Gate exceptions');
});

test('listing public reader is GET-only and rejects query-based cache variation before persistence access', async () => {
  assert.equal(listingSnapshotIsCacheable({ generatedAt:null }), false);
  assert.equal(listingSnapshotIsCacheable({ generatedAt:'not-a-date' }), false);
  assert.equal(listingSnapshotIsCacheable({ generatedAt:'2026-08-14T09:17:16.350Z' }), true);
  const methodResponse = responseRecorder();
  await listingChangesHandler({ method:'POST', query:{}, headers:{} }, methodResponse);
  assert.equal(methodResponse.statusCode, 405);
  assert.equal(methodResponse.headers.Allow, 'GET');
  assert.equal(methodResponse.headers['Cache-Control'], 'private, no-store, max-age=0');

  const queryResponse = responseRecorder();
  await listingChangesHandler({ method:'GET', query:{ refresh:'1' }, headers:{} }, queryResponse);
  assert.equal(queryResponse.statusCode, 400);
  assert.equal(queryResponse.headers['Cache-Control'], 'private, no-store, max-age=0');
});

test('compacted ten-source persistence keeps one event copy and stays below the Runtime Cache safety budget', () => {
  const baselineCounts = {
    'perp:tradexyz':108,
    'perp:bitget':279,
    'perp:gate':380,
    'perp:binance':165,
    'perp:okx':192,
    'spot:bitget':652,
    'spot:gate':58,
    'spot:kraken':166,
    'spot:binance':69,
    'spot:okx':65,
  };
  const catalogs = Object.fromEntries(LISTING_SOURCE_KEYS.map(sourceKey => [
    sourceKey,
    Array.from({ length:baselineCounts[sourceKey] }, (_, index) => ({
      ...row(sourceKey, `B${index}`),
      name:`Reviewed competitor listing ${index}`,
      identityEvidence:'Exact official venue product metadata and independently validated RWA identity',
    })),
  ]));
  const observations = () => LISTING_SOURCE_KEYS.map(sourceKey => {
    const [market, venue] = sourceKey.split(':');
    return { market, venue, status:'full', listings:catalogs[sourceKey] };
  });

  let merged = mergeListingAudit(null, observations(), new Date('2026-06-01T00:45:00Z'));
  for (let day = 1; day <= 45; day += 1) {
    LISTING_SOURCE_KEYS.forEach((sourceKey, sourceIndex) => {
      for (let addition = 0; addition < 4; addition += 1) {
        catalogs[sourceKey].push({
          ...row(sourceKey, `D${day}S${sourceIndex}A${addition}`),
          name:`New reviewed competitor listing day ${day}`,
          identityEvidence:'Exact official venue product metadata and independently validated RWA identity',
        });
      }
    });
    merged = mergeListingAudit(
      merged.state,
      observations(),
      new Date(Date.UTC(2026, 5, 1 + day, 0, 45)),
    );
  }

  const bundle = compactListingAuditBundle(merged.state, merged.snapshot);
  assert.equal(Object.hasOwn(bundle.snapshot, 'events'), false, 'snapshot must not duplicate state.events');
  assert.equal(merged.state.events.length, 1_800, 'all events inside the 45-day window should be retained below the safety cap');
  assert.equal(merged.snapshot.history.truncated, false);
  const hydrated = hydrateListingAuditSnapshot(bundle);
  assert.equal(hydrated.events.length, merged.state.events.length);
  const hydratedState = hydrateListingAuditState(bundle.state);
  assert.equal(Object.keys(hydratedState.known).length, Object.keys(merged.state.known).length);
  assert.deepEqual(hydratedState.known['spot:kraken:B0-KRAKEN-SPOT'], merged.state.known['spot:kraken:B0-KRAKEN-SPOT']);
  assert.deepEqual(hydratedState.events, merged.state.events);
  const bundleBytes = Buffer.byteLength(JSON.stringify(bundle), 'utf8');
  assert.ok(
    bundleBytes < 1_750_000,
    `realistic ten-source baseline plus maximum retained history must fit the writer budget; got ${bundleBytes} bytes ` +
      `(known=${Buffer.byteLength(JSON.stringify(bundle.state.known))}, sources=${Buffer.byteLength(JSON.stringify(bundle.state.sources))}, ` +
      `events=${Buffer.byteLength(JSON.stringify(bundle.state.events))}, snapshot=${Buffer.byteLength(JSON.stringify(bundle.snapshot))})`,
  );
});

test('listing audit exposes an explicit Partial history state when the event safety cap is exceeded', () => {
  const first = mergeListingAudit(null, fullObservations(), new Date('2026-08-14T00:45:00Z'));
  const previous = structuredClone(first.state);
  delete previous.sources['spot:okx'];
  delete previous.known['spot:okx:AAPL-OKX-SPOT'];
  previous.events = Array.from({ length:2_005 }, (_, index) => ({
    eventId:`new:spot:okx:SAFE-${index}:2026-08-14`,
    listingKey:`spot:okx:SAFE-${index}`,
    changeType:'new',
    detectedAt:new Date(Date.UTC(2026, 7, 14, 0, 0, index % 60)).toISOString(),
    observedAt:new Date(Date.UTC(2026, 7, 14, 0, 0, index % 60)).toISOString(),
    market:'spot',
    venue:'okx',
    venueSymbol:`SAFE-${index}`,
    canonicalSymbol:`SAFE${index}`,
    category:'equity',
    venueCategory:'equity',
    lifecycleStatus:null,
    name:`SAFE${index}`,
    officialListedAt:null,
    timeBasis:'first_observed',
    identityStatus:'verified',
    identityEvidence:'official test fixture',
    inclusionStatus:'eligible',
  }));
  const capped = mergeListingAudit(previous, fullObservations(), new Date('2026-08-15T00:45:00Z'));
  assert.equal(capped.state.events.length, 2_000);
  assert.equal(capped.snapshot.status, 'partial');
  assert.equal(capped.snapshot.coverage.warmingSources, 1,
    'history truncation must remain visible even while a newly recovered source establishes its first baseline');
  assert.equal(capped.snapshot.history.truncated, true);
  assert.equal(capped.snapshot.history.droppedAtLeast, 5);
  assert.ok(capped.snapshot.history.droppedThrough);
  assert.ok(capped.snapshot.history.retainedFrom);

  const repeated = mergeListingAudit(capped.state, fullObservations(), new Date('2026-08-16T00:45:00Z'));
  assert.equal(repeated.snapshot.history.droppedAtLeast, 5, 'a later merge must not double-count earlier truncation');
  assert.equal(repeated.snapshot.status, 'partial');
  const compactBundle = compactListingAuditBundle(repeated.state, repeated.snapshot);
  assert.ok(Buffer.byteLength(JSON.stringify(compactBundle), 'utf8') < 1_750_000);
  assert.deepEqual(hydrateListingAuditState(compactBundle.state).events, repeated.state.events);
});

test('listing audit writer requires the configured cron bearer and rejects unexpected query params', async () => {
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'listing-contract-secret';
  try {
    const unauthorized = responseRecorder();
    await listingAuditCronHandler({ method:'GET', query:{}, headers:{} }, unauthorized);
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(unauthorized.headers['Cache-Control'], 'private, no-store, max-age=0');

    const queryResponse = responseRecorder();
    await listingAuditCronHandler({
      method:'GET', query:{ force:'1' }, headers:{ authorization:'Bearer listing-contract-secret' },
    }, queryResponse);
    assert.equal(queryResponse.statusCode, 400);
    assert.equal(queryResponse.headers['Cache-Control'], 'private, no-store, max-age=0');
  } finally {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
});

test('listing health requires an exact ten-source set and a fresh daily snapshot', () => {
  const first = mergeListingAudit(null, fullObservations(), new Date('2026-08-14T00:45:00Z'));
  const second = mergeListingAudit(first.state, fullObservations(), new Date('2026-08-15T00:45:00Z'));
  assert.equal(validateListingAuditSnapshot(second.snapshot, Date.parse('2026-08-15T01:00:00Z')).status, 'pass');
  const stale = validateListingAuditSnapshot(second.snapshot, Date.parse('2026-08-17T00:00:00Z'));
  assert.equal(stale.status, 'fail');
  assert.equal(stale.fresh, false);

  const duplicateSource = structuredClone(second.snapshot);
  duplicateSource.sources[9].sourceKey = duplicateSource.sources[8].sourceKey;
  const invalid = validateListingAuditSnapshot(duplicateSource, Date.parse('2026-08-15T01:00:00Z'));
  assert.equal(invalid.status, 'fail');
  assert.equal(invalid.exactSourceKeys, false);
});

# RWA Dashboard Database Architecture

Status: target architecture and migration contract. This document does not mean that PostgreSQL is already the production read path.

Related documents:

- [`RWA_DATA_RULES.md`](./RWA_DATA_RULES.md) is the authority for identity admission, aliases, categories, market tags, null handling and Full / Partial / Estimated / Unavailable semantics.
- [`DATA_CATALOG_AND_FORMULAS.md`](./DATA_CATALOG_AND_FORMULAS.md) maps every published section to its current inputs, formulas, time grain and persistence.
- [`OPERATIONS.md`](./OPERATIONS.md) defines health checks, release gates and the Phase 0/1 operating procedure.

## 1. Objective and non-goals

The database is intended to make the dashboard's history durable, auditable and reproducible without weakening the current fail-closed RWA identity boundary. The long-term data path is:

```text
official external metadata / market endpoints
                 |
                 v
      immutable raw archive + ingest run
                 |
                 v
 identity versions + exact listing membership
                 |
                 v
 normalized market facts (listing grain)
                 |
                 v
 derived canonical-asset aggregates
                 |
                 v
 versioned signal evaluations and alert events
                 |
                 v
 publication snapshot / API / UI
```

The following are explicit non-goals for Phase 0 and Phase 1:

- no production API or browser reads from PostgreSQL;
- no change to Runtime Cache history writers, cache namespaces, HTTP 503 behavior or CDN freshness policy;
- no continuous writes of price, volume, open interest, funding, order-book, traditional-market or reference-price facts;
- no change to an asset's admission, alias, category, lifecycle or market tag;
- no automatic delivery of alerts;
- no joining by a bare ticker.

Phase 0 provisions the database and archive contract. Phase 1 shadow-writes only the ten official Perpetual/Spot catalogs and the identity/listing lifecycle produced from them. Empty typed `fact`, `analytics`, `publication` and `alert` tables are the Phase 0/1 schema skeleton; continuous market-fact/aggregate writes, partition conversion and publication/alert execution wait for a later, separately approved migration.

## 2. Current system and target responsibilities

| Concern | Current production authority | Target authority | Phase 0/1 behavior |
|---|---|---|---|
| RWA admission and identity | Official venue metadata plus the reviewed gates in `api/_lib/security-identity.js`, `api/_lib/listing-sources.js` and `RWA_DATA_RULES.md` | The same rules, represented as immutable identity versions and evidence | Shadow copy only; database cannot admit an asset |
| Current venue market data | Fixed-purpose server proxies and browser state | Normalized listing facts plus a latest-value serving layer | Unchanged; fact tables are not continuously populated |
| Radar history | Four Vercel Runtime Cache namespaces in `api/signal-snapshot.js:51-56` and the anomaly libraries | PostgreSQL time-series facts/anchors and derived evaluations | Unchanged |
| Listing audit | `rwa-listing-audit-v2` Runtime Cache bundle in `api/listing-changes.js:15-17` | Durable catalog memberships and listing events | Phase 1 dual-write; Runtime Cache remains the read and operational authority |
| Raw source payloads | Mostly transient upstream responses and function logs | Immutable object archive with database manifest | Contract/schema only in Phase 0; upstream raw-body instrumentation is a later collector phase |
| Published API payload | Server builders, CDN and client validators | Versioned publication manifests with reproducible inputs | Unchanged |
| Delivery and acknowledgement | Not implemented | Alert event, incident, subscription and transactional outbox | Schema only |

Runtime Cache remains useful for low-latency latest snapshots. It must not be treated as a durable system of record: the current code explicitly describes it as regional best-effort storage in `RWA_DATA_RULES.md` section 17.

## 3. Identity and key model

### 3.1 Invariants

1. `asset_id` is an opaque UUID. It is the only durable canonical-asset foreign key.
2. `instrument_id` is an opaque UUID for one venue instrument. Its business uniqueness is `(source_id, market, venue_symbol)` during a non-overlapping validity interval.
3. A display symbol is versioned metadata. It is never a primary key and never sufficient for a join.
4. Every fact row references an exact `instrument_id` and the identity/cohort version used when it was collected.
5. Cross-venue aggregates reference `asset_id`, `cohort_version_id` and a deterministic membership fingerprint. A changed listing set or valuation method starts a new comparable cohort.
6. Conflicting categories or unverified wrappers are quarantined before normalized facts or signals. Database constraints must not convert an unknown identity into a verified one.
7. All timestamps are `timestamptz` in UTC. Daily anchors use an explicit UTC `date`; completed-day semantics are never inferred from the database server timezone.

These invariants mirror the current category-qualified keys and exact listing cohorts used in `api/_lib/volume-anomaly.js:42-80`, `api/_lib/spot-volume-price-anomaly.js:661-730`, `api/_lib/oi-liquidation-anomaly.js:140-215` and `api/_lib/listing-audit.js:30-69`.

### 3.2 Versioning rule

Identity-bearing records use half-open validity intervals `[valid_from, valid_to)`. A correction creates a new version; it does not rewrite the version referenced by an older fact. Overlapping active versions for the same parent are rejected with an exclusion constraint or a serialized application transaction.

`rule_version`, `formula_version`, `identity_version_id`, `cohort_version_id`, `source_run_id` and `raw_artifact_id` are retained with every derived record needed for replay. This distinguishes a data correction from a formula change.

## 4. Logical schemas and tables

The names below are the target contract. Phase 0 migrations may create empty skeletons; the phase column states when regular writes may begin.

### 4.1 `identity` schema

| Table | Primary key and required foreign keys | Purpose and important constraints | Write phase |
|---|---|---|---|
| `identity.asset` | `asset_id uuid` PK | Stable category-qualified `asset_key` and creation time; no ticker PK | Phase 1 for catalog identities |
| `identity.asset_version` | `asset_version_id bigint` PK; `asset_id` FK | Versioned canonical underlying, category, display name, market origin, identity decision/fingerprint and validity interval | Phase 1 |
| `identity.source` | `source_id bigint` PK | Source registry: source key, market, venue, data domain, authority and enabled state | Phase 0 schema; exactly ten catalog sources enabled in Phase 1 |
| `identity.instrument` | `instrument_id uuid` PK; `source_id` FK | Stable exact official product key scoped to its source; asset linkage is versioned rather than stored on the parent | Phase 1 |
| `identity.instrument_version` | `instrument_version_id bigint` PK; required `instrument_id`, `source_id`, `asset_version_id` FKs | Official/normalized venue symbol, type, quote, multiplier, official/identity status, fingerprint and validity interval | Phase 1 |
| `identity.alias_version` | `alias_version_id bigint` PK; required `instrument_id`, `source_id` FKs | Explicit dated venue/catalog/REST/WS/display/legacy alias; never a generic suffix rule | Schema skeleton only; the Phase 1 writer does not populate it |
| `identity.evidence` | `evidence_id uuid` PK; optional asset/instrument/artifact FKs | Official source locator, observation, checksum and reviewed provenance | Phase 1 |
| `identity.review_case` | `review_case_id uuid` PK; `source_id` FK, optional resolved asset/instrument FKs | Quarantine/review-required queue; reasons, candidate payload, decision and resolution. An unresolved candidate does not create an accepted asset/instrument/membership row | Phase 1 |
| `identity.asset_relation` | `asset_relation_id bigint` PK; two `asset_version_id` FKs | Versioned depositary receipt/share class/tracks/wrapper/successor relation; no admission by relation alone | Later unless required by an existing accepted identity |

Recommended indexes:

- unique partial index on one active `asset_version` per `asset_id`;
- exclusion/unique-current enforcement on active `(source_id, official_venue_symbol)` and `(source_id, normalized_venue_symbol)` in `instrument_version`;
- btree on `(canonical_underlying, category, valid_from desc)` for review only, never as a fact join;
- btree on `(identity_status, category, valid_from desc)` for quarantine operations;
- GIN only on explicitly searchable presentation metadata, not on fact payload JSON.

### 4.2 `ingest` and raw archive

| Table | Primary key and required foreign keys | Purpose and important constraints | Write phase |
|---|---|---|---|
| `ingest.collection_cycle` | `cycle_id uuid` PK | One scheduled logical cycle; job/pipeline version, UTC bucket, trigger and status | Phase 1 for catalogs |
| `ingest.collection_attempt` | `attempt_id uuid` PK; `cycle_id` FK; unique attempt number per cycle | Bounded retry evidence, start/end, status and sanitized error summary. The current daily shadow writer deliberately reuses idempotent `attempt_no=1`; distinct retry-attempt accounting is a later operational enhancement | Phase 1 |
| `ingest.source_run` | `source_run_id uuid` PK; `attempt_id`, `source_id` FKs | One source result: start/end, endpoint key, catalog/identity/data status, listing/admitted/rejected counts and reason metadata | Phase 1 |
| `ingest.raw_artifact` | `artifact_id uuid` PK; `source_run_id` FK | Generic artifact manifest: object URI, SHA-256, kind/role/format, compression, byte length, source time, archive state and retention class | Contract in Phase 0; deterministic normalized catalog artifacts in Phase 1; upstream raw bodies later |
| `ingest.catalog_membership` | `(source_run_id, instrument_version_id)` PK | Exact official catalog membership with `present/absent/unknown`, official position, normalized attributes and observation time; Partial/Unavailable runs must never manufacture absence | Phase 1 |
| `ingest.sink_commit` | `sink_commit_id uuid` PK; `attempt_id` FK; unique sink name per attempt | Independent `postgres-catalog-shadow`, `blob-normalized-catalog` and post-write `runtime-cache-listing-audit` outcomes; prevents one successful sink from hiding another failure | Phase 1 |

Raw archive target contract (schema/provisioning in Phase 0; upstream-body capture is not part of Phase 1):

- object key: `rwa/{dataset_family}/{source_key}/observed_date=YYYY-MM-DD/hour=HH/{source_run_id}.{ext}.gz`;
- a later raw collector stores bytes exactly as received (or a documented compressed representation) and records which byte representation the checksum covers; normalized JSON is always a separate artifact with its own checksum;
- the database stores a pointer and checksum, not a large raw payload in a hot relational table;
- conditional create or an object-lock equivalent prevents mutation after success;
- secrets, authorization headers and signed URLs are never archived;
- one Phase 1 source run has one normalized catalog artifact. Before later paginated upstream-body capture starts, add an explicit `part_no` column/uniqueness constraint; the current manifest schema does not yet model raw pagination;
- once upstream raw capture is enabled in a later phase, a missing/invalid required raw artifact leaves that sink failed and cannot be described as a complete raw archive;
- recommended retention: official catalog artifacts 400 days hot/cool, then lifecycle to archival storage; compliance/security incidents may be held longer by an explicit retention class;
- deletion is logged in `ops.audit_event`, while the manifest and checksum remain for audit.

Phase 1 archives only a deterministic `normalized-catalog-v1` artifact built from the ten sources' already verified/reviewed catalog observations. It is not the upstream HTTP response body and must not be labeled `raw`. Only accepted, venue-verified listings create identity/instrument versions and `catalog_membership`; unresolved `review-required` candidates create/update `identity.review_case` only.

Its content-addressed object path is `catalog/{environment}/rwa-listing-audit/{UTC-date}/{listing-source-key}/{sha256}.json`. With `RAW_ARCHIVE_MODE=off`, Phase 1 still records the deterministic manifest/checksum as pending/skipped but does not upload the object. `shadow` records a failed archive independently and allows the existing Runtime Cache path to continue; `required` fails before advancing that operational baseline. None of these modes captures an upstream response body.

For accepted instruments the writer records one `official-catalog` evidence row per source run and links it to the stored normalized artifact when that object exists. A confirmed verified delisting closes the current `instrument_version.valid_to`; a later verified relisting creates a new current version. Baselines, unavailable/partial absence and `review-required` rows do not close or reopen an accepted instrument.

### 4.3 `fact` schema

Migration `0002_phase1_facts_alerting.sql` creates the typed tables below as an empty schema skeleton. The Phase 0/1 application does not populate them. Continuous writes, partition conversion and any missing measurement columns require a later approval, migration and dual-write acceptance gate.

| Table | Current skeleton key | Grain and fields | Partition / retention target before writes |
|---|---|---|---|
| `fact.listing_observation_hourly` | `observation_id uuid`; unique `(cycle_id, instrument_version_id, bucket_at)` | Exact listing/hour; last/mark/reference, native/USD 24h volume and OI, funding, 24h change, method/status, source run and input checksum | Monthly range on `bucket_at`; 400 days hot. Index/bid/ask/depth/funding interval need an additive later migration before those facts are written |
| `fact.catalog_presence_daily` | `(presence_day, instrument_version_id)` | First/last observed time, present/absent, observation count and complete source-run FK | Quarterly; retain indefinitely |
| `fact.top_trader_observation_hourly` | `observation_id uuid`; unique `(cycle_id, instrument_version_id, bucket_at, period)` | Exact contract ratio and long/short fractions with official observation and field status | Monthly; 400 days hot |
| `fact.traditional_observation_daily` | `observation_id uuid`; unique `(cycle_id, instrument_version_id, session_date)` | Exact traditional instrument/session; shares, close, estimated cash value, standard option contracts/notional, combined value and source statuses, also linked to the asset version | Quarterly; 7 years hot |
| `fact.reference_price_observation` | Not yet created | Future direct/FX-converted reference observation with currency/FX evidence; current skeleton instead has a reference column on listing observations | Monthly; 3 years hot after a later migration |

Do not put unrelated measurements in a generic `value` column. Units belong in typed columns and validated method metadata. Missing is `NULL`; a true observed zero is `0`.

#### 4.3.1 Phase 2 bitemporal and append-only revision contract

A versioned, **data-family-specific** collection policy is a Phase 2 prerequisite; there is no defensible universal elapsed-time or overlap gate. Phase 1 observes one current daily official-catalog snapshot per source and shadow-writes identity/membership/lifecycle evidence. It does not fetch overlapping price, volume, OI, funding, reference or Traditional history and must not be cited as proof that market-history restatements have already been detected. The catalog-readiness fields `marketFactsChecked` and `rollingMarketHistoryVerified` therefore remain `false` throughout Phase 1.

Four times must remain distinct:

| Time | Meaning | Example |
|---|---|---|
| Event time | When the source says the market event occurred | Candle close, funding settlement or completed exchange session |
| Valid time | The interval for which the normalized value applies | One UTC hour, one rolling-24h anchor date or one official trading session |
| Captured time | When the collector received the source representation | `ingest.raw_artifact.captured_at` / source-run observation time |
| System time | When the normalized revision was committed | Append-only `recorded_at`; never substituted for event/valid time |

The existing `0002` fact tables are empty skeletons and their current unique keys are not a revision ledger. Before any Phase 2 writer starts, an additive migration must introduce a typed revision relation for each enabled fact family (or an equivalently constrained shared revision header plus typed child tables) with at least:

- `revision_id uuid` primary key and an `observation_key` derived from `source_id`, exact `instrument_version_id`, dataset/grain, event/valid boundary, unit/currency and immutable method version—never a bare ticker;
- `revision_no`, `supersedes_revision_id`, `source_run_id`, optional input artifact, `captured_at`, `recorded_at`, source/method/formula version and normalized payload checksum;
- family-specific typed measurement columns and status fields; unrelated prices, volumes, counts and rates must not be collapsed into one generic value column;
- unique `(observation_key, revision_no)` and idempotency on `(observation_key, normalized_payload_sha256)` so an identical re-fetch records collection evidence but not a false revision;
- no update/delete path for an accepted revision. A correction appends the next revision and preserves the first representation and every intermediate value.

A read-only revision summary view must expose, for every typed measurement, `first_value`, `latest_value`, `revision_count = GREATEST(COUNT(*) - 1, 0)`, `latest_minus_first`, `latest_minus_previous`, and a percentage delta when the comparison denominator is non-zero. A method, unit, currency, identity or grain change starts a new observation series/version; it is not disguised as a restatement of the old series.

Every enabled collector must register its own capture cadence, first-usable condition, formula-Full condition, hot/cold revision overlap, source finality lag and retention. The browser cannot choose any of these windows. Older repairs use an explicit authenticated backfill/replay job with a separate run reason and never expand a public request parameter.

| Data family | Current/target cadence and first usable result | Formula-Full or mature result | Phase 2 revision collection policy |
|---|---|---|---|
| Official catalogs / competitor listings | Daily. Day 1 first Full run establishes a baseline only; Day 2 Full can emit New/Re-listed in `0–24h`. A verified delisting follows `D0 present → D1 first missing → D2 missing confirmed`, normally `24–48h` after the first complete missing observation. | The UI's 7/30-day views and 45-day event retention are presentation/audit horizons, not warm-up requirements. | Current-catalog endpoints have no historical overlap: append each exact catalog capture and compare fingerprints. |
| General Radar | Hourly. Funding, price move and dispersion can score on the first complete snapshot. Volume/OI robust-z requires 24 strictly historical samples plus the current observation: the 25th distinct point, about 24 elapsed hours. | Full/Normal history requires 168 total points, reached after about 167 elapsed hours. | Replay derived scores from versioned inputs; do not invent a universal derived-source overlap. |
| Perpetual volume anchors | One sealed UTC-date anchor plus live current. First ratio is seven sealed prior anchors plus current: the eighth distinct UTC date, about seven days. | Consecutive expansion first becomes possible on Day 9; high-frequency can first become true on Day 28; a complete 30-day frequency needs 38 distinct UTC-date points (`Day 0…Day 37`), about 37 days. Retention is 45 days. | Rolling ticker history is not queryable: append captures and version the fixed sealing rule; only a sealed anchor can be revised. |
| Spot volume/price anomaly | Price-only signal is usable on Day 0. Volume comparison needs one prior sealed UTC-date anchor; crossing midnight can make it available at the next hourly run, otherwise within 24h. | One comparable prior anchor is formula-Full for volume; eight days is retention only. Kraken price change remains structurally Unavailable. | Rolling ticker is append-current only; a later capture is not a revision unless the exact source window/event key is unchanged. |
| OI / liquidation proxy | Hourly. Current OI is immediate; the 24th comparable bucket enables drawdown after about 23h. Three completed `d-3/d-2/d-1` 23:00 UTC closes become available in the best case after about 49h and normally within 72h. Top Trader evidence is fetched immediately only after an alert. | 96h is retention only, not another formula gate. | Where official historical OI exists: hot 6h each run, cold 48h daily and 7d weekly; otherwise append point-in-time captures only. |
| Funding history | Current funding is immediate. History needs at least two settled rows and `observed >= max(2, ceil(0.8 × expected))`; for a fresh local default 24h window this is about 16h at 8h/4h cadence and 19h at 1h cadence. Existing official history may make the first request Full. | The requested window determines completeness; Bitget's 100-row response limit remains explicit. | Re-read the latest two settlements or 24h, whichever is wider; cold-check 7d daily and 30d monthly. |
| Top 30 completed candles | Historical endpoints can make an old listing Full on the first request. Day 0 may use `24h × 30` Estimated; one complete daily bar gives Partial within 24h, or one trade.xyz hourly bar within 1h. | Daily venues need 30 completed days for Full. trade.xyz needs 720 hourly bars (about 30d) but remains Estimated because its notional method is `base volume × close`; the Top-80 gate can keep an otherwise old listing Estimated. | Daily candles: hot 3–7 completed days, T+2 cold check, monthly 30d sweep. Hourly candles: hot 6h and daily 48h check. |
| Traditional sessions/options | Historical endpoints can produce an old asset's rank and rank delta on the first request; a new asset normally appears T+1. One prior share session or one same-weekday option report gives a Partial relative baseline. | Market Full needs 20 prior completed sessions (about four weeks); options Full needs four same-weekday reports (about four weeks). Adjusted-root coverage can remain structurally Partial. | Daily five-session overlap; weekly 20 share sessions plus four OCC reports; monthly 60-session sweep. |
| Reference price | A fresh native/FX-converted observation or allowed fallback is immediately usable. | Current comparison has no historical maturity and is not an authoritative completed-session close. | Current-only reference is append-current with zero query overlap. A future completed-close family uses five sessions plus a T+2 cold check. |
| Cross-venue / By Asset / Heatmap / Cash-and-Carry / browser alerts | Usable as soon as the relevant current loaders finish fresh. | Full depends on source and field completeness, never elapsed time; there is no independent history maturity. | Zero independent query overlap; replay from exact catalog/listing facts and their versioned input set. |

These elapsed times describe product formulas, not authorization to expand database writes or switch readers. A source can also remain Partial indefinitely for structural reasons such as an unsupported field, a source row cap or a ranked-universe gate.

Initial Phase 2 drift policy must be versioned with the collector method and calibrated in shadow mode. Until source-specific evidence justifies tighter limits, use these conservative release gates:

| Comparison within the same source/method/version | Normal restatement | Review-required | Anomalous drift / non-passing |
|---|---|---|---|
| Price, mark, close or reference price | Absolute relative delta `<= 0.5%` and no unit/status transition | `> 0.5%` and `<= 2%` | `> 2%` |
| Volume, OI, notional, shares or contracts | Absolute relative delta `<= 1%` | `> 1%` and `<= 5%` | `> 5%` |
| Funding/rate/ratio | Change no greater than declared source precision | Above source precision but `<= 1` basis point in the normalized rate | `> 1` basis point, sign contradiction or invalid ratio arithmetic |
| Revised observation keys in one source overlap | `<= 1%` of comparable keys | `> 1%` and `<= 5%`, and no more than 50 keys | `> 5%` or more than 50 keys |

For a zero first value, percentage drift is Unavailable and a versioned field-specific absolute threshold is mandatory. `NULL → value` is a normal late completion only when the first status was explicitly incomplete and the source-specific settlement SLA has not expired; otherwise it is review-required. `value → NULL`, identity/unit/method/grain changes under the same observation key, a revision older than the authorized overlap without a backfill run, or any attempt to overwrite/delete the first value is anomalous regardless of percentage. These are data-quality gates, not changes to the dashboard's signal thresholds or RWA admission rules.

### 4.4 `analytics` schema

| Table | Primary key | Grain and purpose | Write phase |
|---|---|---|---|
| `analytics.cohort_version` | `cohort_version_id uuid` PK | Category-qualified canonical asset plus sorted exact instrument membership and method fingerprint | Later |
| `analytics.cohort_member` | `(cohort_version_id, instrument_version_id)` PK | Ordered exact membership plus volume/OI method and member fingerprint | Later |
| `analytics.asset_hourly` | `asset_hourly_id uuid`; unique `(cycle_id, cohort_version_id, bucket_at)` | Canonical volume/OI/funding/reference aggregates and expected/observed completeness counts | Later |
| `analytics.asset_daily_volume_anchor` | `anchor_id uuid`; unique `(cohort_version_id, anchor_day, anchor_method)` | Perp rolling-24h daily anchors for seven-day/30-day anomaly logic | Later |
| `analytics.spot_listing_daily_anchor` | `anchor_id uuid`; unique `(instrument_version_id, anchor_day, volume_method)` | Exact Spot listing rolling-24h volume/price anchor | Later |
| `analytics.asset_daily_oi_close` | `close_id uuid`; unique `(cohort_version_id, close_day, close_method)` | Completed UTC OI closes used by the three-day trend; field status constrained to Estimated | Later |
| `analytics.signal_result` | `signal_result_id uuid`; unique deterministic `result_key` | Versioned computed signal linked to exact asset/instrument/cohort and cycle | Later |
| `analytics.catalog_change_event` | `catalog_change_event_id uuid`; unique source/instrument/type/day | Durable lifecycle event; schema allows listed/delisted/relisted/status-change, while the current Phase 1 writer emits only verified non-baseline listed/delisted/relisted events | Phase 1 shadow |
| `analytics.traditional_rank_daily` | Not yet created | Future reproducible candidate-set rank and previous-rank comparison | Later migration |

Completeness is table-specific rather than implied by one generic pair of columns. For example, `analytics.asset_hourly` carries `expected_listing_count`, `observed_volume_count` and `observed_open_interest_count`; daily anchors carry their own method, field status and cohort identity. Later writers must add an explicit denominator/reason/watermark wherever the table's present columns cannot prove completeness. Full is impossible when the exact denominator is unknown.

### 4.5 `alert`, `publication` and `ops` schemas

| Table | Primary key | Purpose |
|---|---|---|
| `alert.rule` | `rule_id uuid` | Stable rule identity and owner |
| `alert.rule_version` | `rule_version_id uuid` | Immutable thresholds, eligibility, formula version and effective interval |
| `alert.evaluation_run` | `evaluation_run_id uuid` | Input watermark, cohort version, counts, status and execution evidence |
| `alert.event` | `event_id uuid`; unique `dedupe_key` | One deduplicated occurrence linked to a signal/catalog event and versioned asset/instrument/cohort identity |
| `alert.event_evidence` | `(event_id, evidence_order)` | Exact listing observation, signal result or artifact evidence and displayed payload |
| `alert.incident` | `incident_id uuid` | Optional grouping/acknowledgement/suppression lifecycle; an event remains immutable |
| `alert.incident_event` | `(incident_id, event_id)` | Many-to-many incident grouping without mutating the source event |
| `alert.destination` | `destination_id uuid` | Secret reference and channel metadata; never stores plaintext credentials |
| `alert.subscription` | `subscription_id uuid` | Versioned recipient filters, severity and locale |
| `alert.delivery` | `delivery_id uuid` | Intended notification and idempotency key |
| `alert.outbox` | `outbox_id uuid`; unique `delivery_id` | Transactional outbox written in the same transaction as delivery intent |
| `alert.delivery_attempt` | `delivery_attempt_id uuid`; unique `(delivery_id, attempt_no)` | Retry, provider response checksum/class and final state |
| `publication.snapshot_manifest` | `snapshot_manifest_id uuid` | API kind/formula/cycle/cohort, generated time, row count, status and payload checksum/artifact pointer |
| `publication.latest_pointer` | `pointer_key text` PK | Atomic pointer to the latest accepted publication snapshot |
| `ops.source_health_bucket` | `(bucket_at, source_id, check_name)` | Latency, freshness, counts, completeness and status |
| `ops.source_incident` | `incident_id uuid` | Open/close lifecycle for persistent source failures or drift |
| `ops.data_quality_issue` | `issue_id uuid` | Unit, identity, arithmetic or contract violations and resolution |
| `ops.reconciliation_result` | `reconciliation_id uuid` | Runtime Cache versus shadow database conservation checks |
| `ops.audit_event` | `audit_event_id bigint` | Actor, action, object and before/after checksum; append-only |

The `ops.*` tables after `ops.schema_migration` are documented later targets and are not created by `0002`. All alert/publication tables are empty skeletons in Phase 0/1. Outbox claims use `FOR UPDATE SKIP LOCKED`; `dedupe_key` is unique. A delivery provider failure must not roll back or mutate the underlying alert event.

## 5. Partitioning, indexes and maintenance

### 5.1 Partition keys

The `0002` tables are intentionally empty, unpartitioned skeletons. Before any continuous market-fact writer is enabled, a later migration must convert or replace the time-series parents with the partition design below and prove replay/rollback. Schema existence is not permission to accumulate unbounded rows.

- Monthly range partitions: hourly listing facts, funding observations, Top Trader observations, reference prices, source health and alert events.
- Quarterly range partitions: daily catalog presence, traditional activity and daily aggregate anchors.
- Non-time-versioned identity tables remain unpartitioned at this scale.
- Do not hash-partition by ticker. If a very large fact later needs subpartitioning, use `source_id` or a stable UUID hash only after measured need.

Create the next two monthly and next quarterly partitions before their boundary. A missing future partition is a P0 ingest condition and must fail closed rather than route data to an unbounded default partition.

### 5.2 Core indexes

- `fact.listing_observation_hourly (instrument_version_id, bucket_at desc) include (...)` for asset drill-down;
- BRIN on large time-ordered partitions' `bucket_at`;
- `analytics.asset_hourly (cohort_version_id, bucket_at desc)`;
- `alert.event (status, observed_at desc)`, `(event_type, observed_at desc)` and the existing unique `dedupe_key`;
- `ingest.source_run (source_id, completed_at desc)` plus a later measured status/time index if reconciliation needs it;
- `ingest.catalog_membership (instrument_version_id, observed_at desc)`;
- `ops.source_health_bucket (source_id, bucket_at desc)`.

Avoid redundant indexes on high-ingest partitions. Every added index must have a named query and measured benefit.

### 5.3 Retention and deletion

| Data class | PostgreSQL hot retention | Archive retention | Notes |
|---|---:|---:|---|
| Identity/version/evidence/listing events | Indefinite | Indefinite metadata; artifacts by class | Required for replay and lifecycle audit |
| Catalog presence | Indefinite | Phase 1 normalized catalog artifacts; 400-day upstream-raw target after later instrumentation | Small and audit-critical |
| Hourly listing/aggregate facts | 400 days | 3 years compressed by default | Extend before research promises require it |
| Funding observations | 3 years | 7 years compressed | Settlement history is compact |
| Top Trader observations | 400 days | 3 years compressed | Optional evidence, not identity |
| Traditional daily activity/ranks | 7 years | 7 years | Session grain |
| Alert events/evidence/audit | Indefinite | Indefinite | Delivery attempt bodies may be redacted after 90 days |
| Publication payload objects | 90 days hot | 400 days compressed | Manifest retained indefinitely |

Dropping an expired partition requires a recorded retention job, a successful archive checksum and a replay test. Never delete identity evidence because a fact partition expired.

## 6. Capacity model

Planning baseline: approximately 1,109 active Perpetual listings, 863 Spot listings, 1,972 exact active listings and 473 canonical Perpetual assets. These are sizing inputs, not admission baselines; official catalogs and the health baseline remain authoritative.

### 6.1 Full hourly target

Assuming one row per exact listing per UTC hour and one canonical aggregate per Perpetual asset per hour:

| Dataset | Rows/month (30 days) | Rows/year (365 days) |
|---|---:|---:|
| Exact listing hourly facts: `1,972 × 24 × days` | 1,419,840 | 17,274,720 |
| Canonical Perpetual hourly aggregates: `473 × 24 × days` | 340,560 | 4,143,480 |
| Daily exact catalog presence: `1,972 × days` | 59,160 | 719,780 |
| Perpetual daily volume anchors + OI closes: `473 × 2 × days` | 28,380 | 345,290 |
| Exact Spot daily anchors: `863 × days` | 25,890 | 314,995 |
| **Core total** | **1,873,830** | **22,798,265** |

Top Trader, source-health, alerts and Traditional Top-100/session facts add relatively few rows at the current cadence. With typed fact rows, metadata, practical indexes and partition overhead, budget approximately 8–12 GB per year for the normalized core. Provision 15–30 GB for one year when PITR/WAL, migration headroom and a branch/preview database are included.

For a later full raw collector, if one hourly cycle archives 1–2.5 MB of compressed official payloads across enabled datasets, raw storage would be roughly 0.72–1.8 GB/month and 8.8–21.9 GB/year. This is a scenario, not Phase 1 usage. Measure actual stored bytes from `ingest.raw_artifact`; do not size from uncompressed JSON guesses.

### 6.2 Phase 1 catalog-only load

Ten daily official catalogs at roughly 2,000 current memberships produce about 60,000 membership observations per 30-day month and 730,000 per year before retention/compaction. This is intentionally much smaller and safer than starting hourly market-fact ingestion.

## 7. Migration plan

### Phase 0 — provision and prove the platform

Scope:

1. Provision Neon/PostgreSQL in the production region strategy and a separate non-production branch/database.
2. Pin a supported PostgreSQL version and required extensions; apply versioned, transactional migrations.
3. Create the implemented NOLOGIN group roles: `rwa_catalog_shadow_writer` for only the named Phase 1 identity/ingest/event tables, `rwa_analytics_reader` for read-only analytics/reconciliation, and `rwa_alert_dispatcher` for only delivery/outbox dispatch. The migration owner is granted `rwa_catalog_shadow_writer` so the current runtime owner can use `SET LOCAL ROLE` inside the shadow transaction; the other groups need an explicit future login grant. No Phase 0/1 group can write continuous market facts. Before any read cutover, replace the owner connection with a dedicated least-privilege application login rather than treating owner-plus-role-assumption as the final production boundary.
4. Configure pooled runtime connections and a direct migration connection. Set short statement/lock/idle-in-transaction timeouts.
5. Create the Phase 0 identity/ingest foundation plus empty typed `fact`, `analytics`, `alert` and `publication` table skeletons. `ops.schema_migration` exists now; additional ops tables remain later targets. No skeleton table is an enabled writer contract.
6. Provision the private object-storage/archive contract and validate a synthetic content-addressed artifact's checksum, conditional-create, lifecycle and restore behavior. Do not instrument or claim capture of upstream raw bodies in this phase.
7. Keep the implemented safe defaults `PG_WRITE_MODE=off` and `RAW_ARCHIVE_MODE=off`. `DATABASE_URL` configures the lazy pooled runtime connection; `DATABASE_URL_UNPOOLED` is preferred for migrations and may fall back to the pooled URL only when intentionally configured. `BLOB_READ_WRITE_TOKEN` is private. Environment presence alone never enables a writer, and browsers cannot control any switch.
8. Configure database/connection/egress/PITR usage alerts and secret rotation. Do not log connection strings.

Acceptance gates:

- migrations apply to an empty database and upgrade a copy twice without drift;
- migration role, writer role and read-only role pass explicit allow/deny tests;
- a synthetic artifact can be archived, checksum-verified, restored and immutability-tested;
- pool exhaustion and database-unavailable drills do not affect current production APIs because all switches are off;
- current `npm test`, `npm run check:inline`, health and Preview audits remain unchanged;
- rollback is disabling the switches and reverting application configuration, not deleting data.

### Phase 1 — ten-source official-catalog shadow write

Scope:

- On the existing daily listing-audit writer, shadow-write exactly the ten source keys declared in `api/_lib/listing-audit.js:11-22`: five Perpetual and five Spot catalogs.
- Persist `collection_cycle`, `source_run`, deterministic `normalized-catalog-v1` artifact, accepted identity/instrument versions, exact accepted `catalog_membership`, listing lifecycle event and `sink_commit` outcomes.
- Persist unresolved `review-required` candidates only in `identity.review_case`; they do not create accepted identity/instrument/membership rows.
- Close/reopen instrument SCD2 lifecycle validity only from confirmed verified delist/relist output; never infer it from an unavailable/partial catalog. A separately verified identity-fingerprint correction may also close the old version and create a new one without pretending that a delisting occurred.
- Reuse the current server-normalized admission result. PostgreSQL is not a second identity engine and may not expand a catalog.
- Maintain the current `rwa-listing-audit-v2` bundle/read contract and `/api/listing-changes` read path. The writer now adds a fixed publication-lease diagnostic and, whenever PostgreSQL is enabled, holds a 180-second database lease across durable mutation, a post-acquire cache checksum re-read, Runtime Cache publication and sink acknowledgement.
- A database/archive failure is visible in shadow sink health, but during the observation window it must not turn a successful current Runtime Cache publication into a false production outage. Conversely, database success must not hide a failed current writer.
- Do not write continuous market facts, signal histories, derived rankings or alert deliveries.

Phase 2 **design** has no elapsed-cycle gate: architecture, migration and replay design can proceed whenever it is reviewed. Scheduled catalog buckets are operational confidence evidence only. The recommended policy is to consider expanding shadow telemetry after three consecutive healthy scheduled buckets and to consider required-mode or read-cutover review after seven; neither threshold automatically enables a writer, changes a reader or represents product-data warm-up. A same-day retry remains the same bucket, and a missing/non-passing scheduled bucket resets consecutive confidence evidence.

Every qualifying scheduled bucket must satisfy:

1. all ten expected source runs exist once per UTC cycle with no duplicate active membership rows;
2. exact source accepted/rejected counts and membership fingerprints reconcile with the Runtime Cache listing-audit inputs;
3. source-run status, identity conflicts, review-required rows, drift quarantine, first-baseline behavior, repeated-day removal and event types conserve exactly;
4. the `normalized-catalog-v1` checksum and replay reproduce the recorded accepted membership fingerprint; it is never represented as upstream raw evidence;
5. no accepted identity/instrument/membership row exists for a source/catalog result the current gate rejected as Crypto or left ambiguous; an unresolved review candidate may exist only in `identity.review_case`;
6. p95 added writer latency stays inside the Cron budget and connection concurrency remains within the configured pool;
7. disabling either shadow sink does not change `/api/listing-changes`, `/api/signal-snapshot`, `/api/health` or page output;
8. reconciliation gaps page/alert operators but never silently self-heal identity.

### Later phases — separate approvals

- Phase 2: exact listing market-fact dual-write, per-data-family overlap/current-capture policies, append-only revision ledger and replay comparison. No writer starts until the bitemporal keys, typed revision tables/views, drift/finality policies and backfill isolation above are migrated and tested.
- Phase 3: PostgreSQL-derived aggregates and signal evaluations in shadow mode.
- Phase 4: versioned publication snapshots and read cutover behind a rollback flag.
- Phase 5: durable alert incidents, subscriptions, outbox and delivery.

Each later phase requires its own capacity measurement, formula-by-formula conservation tests and rollback proof. Schema existence is not authorization to begin writes.

## 8. Failure and consistency semantics

- External collection settles source-by-source, so a cycle may contain mixed source statuses. The Phase 1 PostgreSQL writer nevertheless commits the ten `source_run` rows and their accepted bundle in one Serializable transaction; future aggregate publications must still record the exact accepted input set and watermarks.
- Normalized-artifact success, database success, Runtime Cache success and publication success are separate sink states. Do not compress them into one boolean. A later upstream-raw sink receives its own independent state.
- Retry idempotency keys are deterministic from dataset family, source, UTC bucket and method version.
- The current Phase 1 daily writer deliberately reuses `attempt_no=1` and idempotently upserts that attempt/source-run bundle for same-day retries. Preserving every physical retry as a distinct immutable attempt is a later operational enhancement and must precede any claim of full attempt history.
- For a trusted same-UTC-day retry, the newest exact accepted membership and official-catalog evidence replace that source's prior logical set transactionally; the first confirmed lifecycle event remains append-only. Untrusted/Unavailable retries preserve PostgreSQL last-good identity and membership while the current Runtime Cache diagnostic fails reconciliation. A review-required candidate that later verifies is an identity resolution, not a synthetic listed event.
- Runtime Cache has no compare-and-set transaction with PostgreSQL. Phase 1 therefore uses `ingest.catalog_publication_lease` as an owner/checksum fence. A writer re-reads the cache after acquiring it, rejects busy/stale/conflicting bases with HTTP 409, and holds the 180-second lease through cache and sink acknowledgement. Lease acquisition/renewal service degradation is explicit and non-passing; ownership loss blocks publication. With `PG_WRITE_MODE=off`, this cross-instance guarantee is intentionally absent.
- Market-fact corrections in Phase 2 are append-only revisions ordered by captured/system time while preserving their original event/valid time. “Latest” is a view over immutable revisions, never an in-place replacement; first/latest values, revision count and deltas must remain reproducible from source/method/version evidence.
- Full requires the expected source/listing denominator and all required fields. Partial allows a valid subset; Estimated describes method, not completeness; Unavailable means no defensible value. These meanings are unchanged from `RWA_DATA_RULES.md:141-169`.
- A database outage before read cutover must degrade only the shadow pipeline. After a future read cutover, last-good publication may be served with explicit age/status only within its product-specific hard TTL.
- The database is not allowed to turn `NULL` into zero, `Unavailable` into Neutral, Warming into no-anomaly, or a liquidation proxy into reported liquidation.

## 9. Cost and operating tiers

Use measured connection time, compute hours, row growth, WAL/PITR and archived bytes to choose a plan; provider list prices change and are not embedded here.

| Tier | Intended scope | Capacity expectation | Upgrade trigger |
|---|---|---|---|
| Phase 0/1 lean | catalog-only daily shadow write, migrations and reconciliation | sub-million membership rows/year plus compact normalized catalog artifacts | connection queueing, PITR/branch needs or sustained storage above 70% |
| Market-fact standard | all exact listings hourly, one-year hot history | about 22.8M core rows/year; plan for 15–30 GB including headroom | p95 queries miss SLO, WAL dominates, or storage above 70% |
| Research/alert scale | finer cadence, multi-year facts, delivery/outbox and analysts | partitioned compute plus object archive and replicas | workload isolation or regulatory retention requirement |

P0 risks: identity leakage, wrong units, lost audit evidence, a future partition missing, database writes blocking the current Cron, or a read cutover without a tested rollback. P1 risks: reconciliation drift, a normalized artifact mislabeled as raw, pool saturation, duplicate lifecycle events or retention jobs without restore proof. P2 items include compression tuning, extra covering indexes and cold archive query ergonomics.

## 10. Ownership and change control

- Identity schema and migration changes require the `RWA_DATA_RULES.md` pre-release identity audit.
- Formula or threshold changes require a new immutable formula/rule version and fixtures at both boundaries.
- Retention changes require capacity evidence, archive restore proof and an operations update.
- Read cutover requires a Preview comparison and an explicit production decision; it is not implied by successful shadow writing.
- Every schema migration, feature-switch change, reconciliation override and manual identity resolution is append-only audited.

## 11. Authoritative design references

- [PostgreSQL: Declarative Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html) informs monthly/quarterly time-range partitions, simple immutable bounds, partition pruning and creating future partitions before the boundary.
- [PostgreSQL: Range Types and exclusion constraints](https://www.postgresql.org/docs/current/rangetypes.html#RANGETYPES-CONSTRAINT) informs half-open `[valid_from, valid_to)` identity intervals and `btree_gist` exclusion constraints that prevent overlapping verified versions.
- [Neon: Connection pooling](https://neon.com/docs/connect/connection-pooling) and the [Neon serverless driver](https://neon.com/docs/serverless/serverless-driver) inform the pooled lazy `DATABASE_URL` runtime path, short transactions and the separate unpooled migration path.
- [Neon: Branching](https://neon.com/docs/guides/branching-intro) and [project restore-window management](https://neon.com/docs/manage/projects) inform isolated Preview/migration rehearsal branches and explicit PITR/restore-window acceptance checks; retention is plan/configuration dependent and must be verified rather than assumed.
- [Vercel Storage best practices](https://vercel.com/docs/storage) informs placing Functions, Neon and object storage close enough to avoid unnecessary network latency. [Vercel Blob private storage](https://vercel.com/docs/vercel-blob/private-storage) and [Blob immutability guidance](https://vercel.com/docs/vercel-blob) inform a private, server-authenticated, content-addressed artifact archive with immutable object names.
- [Vercel Runtime Cache API](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package) and Vercel's description of Runtime Cache as [ephemeral and regional](https://vercel.com/changelog/introducing-the-runtime-cache-api) support retaining it as a low-latency publication/history cache, not promoting it to a durable system of record.
- [AWS Prescriptive Guidance: Transactional outbox pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) informs writing delivery intent/outbox in the same database transaction, then using an idempotent dispatcher because at-least-once delivery can duplicate messages.

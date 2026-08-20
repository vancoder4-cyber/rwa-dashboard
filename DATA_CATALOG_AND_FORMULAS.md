# RWA Dashboard Data Catalog and Formula Registry

Status: description of the current production code plus the approved database destination. When prose and code disagree, the executable producer and its contract tests win until both are corrected in the same release.

This registry is deliberately explicit about four different things:

1. **identity** — whether an exact venue instrument is allowed into the RWA universe;
2. **measurement** — the source field, unit and observation time;
3. **derivation** — the formula, eligibility and completeness denominator;
4. **persistence/publication** — where the value currently lives and where it may be stored later.

Identity admission remains governed by [`RWA_DATA_RULES.md`](./RWA_DATA_RULES.md). The database model and migration phases are in [`DATABASE_ARCHITECTURE.md`](./DATABASE_ARCHITECTURE.md).

## 1. Common vocabulary

### 1.1 Identity and grains

| Term | Definition |
|---|---|
| Exact listing | One venue instrument identified by market, venue and official `venueSymbol`; conceptually `market:venue:venueSymbol` |
| Canonical asset | Category-qualified traditional underlying; conceptually `category:canonical`, never a bare ticker |
| Exact cohort | Sorted exact-listing membership plus collection/valuation methods for one category-qualified asset |
| Current / 24h | A venue's current rolling observation; not automatically a UTC calendar-day settlement |
| Hour bucket | Idempotent UTC hour used by general Radar and OI proxy history |
| Daily anchor | One idempotent UTC-date record containing a rolling-24h observation; not described as exchange UTC-day volume |
| Completed session | Official completed Nasdaq/OCC trading session selected by the Traditional producer |
| Event / valid time | Source market time and the interval/session to which a value applies; neither is the database write time |
| Captured / system time | When the collector received a representation and when its immutable normalized revision was committed |
| Revision | A changed value for the same exact source/instrument/grain/event-valid boundary and method version; it appends evidence instead of replacing the first value |

Official venue product metadata is the identity authority. Names, ticker resemblance, prices, reference prices and cross-venue matches are discovery or validation signals only. The current identity implementation is concentrated in `api/_lib/security-identity.js`, `api/_lib/listing-sources.js` and the venue collectors; listing-audit normalization is at `api/_lib/listing-audit.js:30-69`.

### 1.2 Status model

| State | Meaning |
|---|---|
| Full | Required direct observations and the expected denominator are complete and fresh |
| Partial | A valid subset exists, but a required source, field, history point or freshness condition is incomplete |
| Estimated | The value is formula-derived, converted, projected or uses an allowed fallback; it does not mean incomplete |
| Unavailable | No defensible value is supported; display `—`, never a substituted zero |
| Warming | Historical maturity state only. It is not a fifth field status and never means “no anomalies” |

An aggregate publishes `observed/expected`. A true observed zero is retained as zero; missing remains `null`. Snapshot freshness is enforced by `index.html:3514-3600`. Funding annualization uses the actual interval at `index.html:3618-3650`:

```text
annualized funding = funding rate × (24 / intervalHours) × 365
```

### 1.3 Persistence labels used below

| Label | Meaning |
|---|---|
| Browser | Current page memory only; refresh/reload can replace it |
| CDN | Vercel CDN response cache; performance layer, not durable history |
| Runtime Cache | Regional best-effort Vercel Runtime Cache used by authenticated writers |
| None | No server-side historical persistence for that derived result |
| Phase 1 shadow | Accepted catalog identity/lifecycle plus a deterministic `normalized-catalog-v1` manifest/checksum written alongside unchanged production reads; private object upload is separately controlled and is not an upstream raw-body archive |
| Phase 2 foundation | Append-only listing-market revision schema/policy exists, but its independent writer/read switches remain off and it contains no implied history |
| Later DB | Target table exists in the architecture, but continuous writes are not authorized in Phase 0/1 |

## 2. Source catalog

### 2.1 Crypto-market product scope

| Market | Current sources | Identity grain | Current collection/publication |
|---|---|---|---|
| Perpetual | trade.xyz, Bitget, Gate.io, Binance, OKX | Exact official contract, preserving multiple variants such as OKX SWAP and X-Perp | Fixed-purpose APIs and browser refresh; Radar re-collects the same five source families server-side |
| Spot | Gate.io, Kraken, Bitget, Binance, OKX | Exact official pair/wrapper; USD and USDT listings remain separate | Fixed-purpose APIs plus bounded browser collection; Spot anomaly re-collects five sources server-side |
| Funding history | Same five Perpetual venues | Exact venue contract | `api/funding-history.js`; requested window, normalized/deduplicated observations |
| Binance OI / Top Trader | Binance exact active RWA contracts | Exact official Binance contract | Fixed `oi-snapshot` and `top-trader-snapshot` in `api/binance-public.js`; no caller-supplied symbol/path |

The ten catalog source keys are executable constants at `api/_lib/listing-audit.js:11-22`. These ten catalogs—and only these catalogs—enter the Phase 1 database shadow write.

### 2.2 Traditional and reference sources

| Dataset | Authority/current code | Measurement |
|---|---|---|
| U.S. security identity | Nasdaq Trader symbol directories via `api/_lib/us-market-directory.js` | Official symbol/name, ETF and ADR flags; refines an already venue-verified security but never admits RWA by itself |
| Traditional share activity | Nasdaq official market-movers and historical quote endpoints in `api/tradfi-activity.js` | Completed-session shares and same-session close |
| Options activity | OCC completed-session volume reports in `api/tradfi-activity.js` | Standard option contracts; adjusted roots are separately detected and excluded |
| Live traditional quote | Nasdaq quote endpoint in `api/tradfi-prices.js` | USD/share comparison point with session/freshness metadata |
| Reference price | Yahoo chart and FX observations in `api/reference-prices.js` | Direct USD close/price or FX-converted USD estimate |

## 3. Perpetuals page

Current venue market rows are Browser/CDN state. None of the following page renderings are written to PostgreSQL in Phase 0/1.

### 3.1 All Venues → Aggregator

| Section | Inputs and grain | Current formula/ordering | Status | Current persistence | Target |
|---|---|---|---|---|---|
| Total RWA Assets | All filtered exact Perpetual listings | Count distinct category-qualified `assetAggregationIdentity(...).key` | Identity count; source health shown separately | Browser | `identity.asset_version` + active cohort query, later |
| Total 24h Volume | Exact listing rolling-24h USD volume | Sum available values; publish observed/expected listing denominator | Full only when all required fresh listing fields are present | Browser; general Radar also stores a separate Top-100 aggregate history | `fact.listing_observation_hourly`, later |
| Total Open Interest | Exact listing USD OI | Sum available values; publish observed/expected | Same completeness rule | Browser; general Radar keeps separate aggregate history | `fact.listing_observation_hourly`, later |
| Avg Positive Funding | Fresh exact listings with annualized funding greater than zero | Arithmetic mean of positive annualized **listing observations** | Aggregate funding field completeness | Browser | `analytics.asset_hourly`, later |
| Active Alerts / Data Health | Client alert list plus venue freshness and volume completeness | Count browser-classified alerts; otherwise report degraded source state | Not a server-authoritative alert count | Browser only | `alert.event`, only after later rule migration |
| KPI sparklines | General Radar aggregate history | Plot server `aggregateHistory` volume/OI points; requires at least three points | Inherits Radar history maturity | Runtime Cache through Radar | `analytics.asset_hourly`, later |

Implementation: `renderKPIs` at `index.html:6251`. The current “positive assets” subtitle is presentation copy; the actual average iterates listings, not deduplicated canonical assets.

### 3.2 Venue cards

| Metric | Formula | Notes/status |
|---|---|---|
| 24h Top Gainer | Highest fresh listing `change24hPct` | No fallback from stale rows |
| Highest Funding | Listing with greatest absolute annualized funding | Display keeps the rate's sign |
| Largest OI | Highest available listing USD OI | Missing is not zero |
| 24h Volume Growth Top 3 | Source-specific current rolling-24h volume versus previous comparable volume | Displayed only where the venue growth collector supplies a finite comparison |
| Category Breakdown | Exact listing counts by admitted category | Listing count, not unique assets |
| Volume Concentration | `sum(top 3 listing volume) / total available listing volume` | Denominator carries source completeness |

Implementation: `index.html:6298-6411`. These are current UI summaries with no independent history table.

### 3.3 Top 30 RWA Perps by 30-Day Volume

| Item | Contract |
|---|---|
| Identity | Group by category-qualified canonical identity; preserve each current exact listing as a required contribution. Audited gold components may aggregate to the common `commodity:XAU` identity. |
| Input | Completed exchange candles only. Binance and OKX use completed UTC daily candles; trade.xyz uses completed hourly candles. The current incomplete day/hour is excluded. |
| Venue estimate | Binance/OKX complete daily quote volume is direct; trade.xyz hourly `base volume × close` is Estimated. When a supported listing has no complete history, allowed fallback is current `24h volume × 30`, marked Estimated. |
| Asset total | Sum the current exact listing contributions for the canonical asset. |
| Rank | Descending total 30-day USD volume, deterministic identity tie-break; take 30. |
| Funding shown | Median of the current annualized funding observations across the asset's listings. |
| OI shown | Current exact-listing OI sum with observed/expected status. |
| Status | Full only when every current required listing has 30 complete direct candle days. Mixed direct/fallback or missing current listings is Partial; all complete-denominator fallback contributions may be Estimated; no defensible contribution is Unavailable. |

Implementation: fetch/orchestration `index.html:6571-6896`, render/denominator logic `index.html:6897-7097`; server collectors `api/binance-public.js`, `api/hyperliquid-klines.js` and `api/okx-market.js`. Current persistence is CDN plus a five-minute browser cache, not durable 30-day facts. Target is exact daily/hourly facts and a versioned aggregate in a later database phase.

### 3.4 Cross-Venue Coverage and Funding Rate Ranking

| Section | Formula | Status/persistence |
|---|---|---|
| Cross-Venue Coverage | Group current exact listings by category-qualified canonical asset; count distinct venues, while preserving all contracts for the Drawer | Identity/catalog display; Browser only; `index.html:6413` |
| Positive funding rank | For every asset with at least one positive fresh annualized funding observation, sort by its largest positive APR | Current snapshot; Browser only |
| Negative funding rank | For every asset with at least one negative fresh observation, sort by largest absolute negative APR | Current snapshot; Browser only |

Funding ranking preserves all venue observations in the row and does not average mutually different venues. Implementation: `index.html:6466`.

### 3.5 Venue tables and funding history

| Field | Formula/source | Status/history |
|---|---|---|
| Mark / index / 24h change / USD volume / USD OI | Exact venue contract fields and venue-specific unit conversion | Per-field Full/Partial/Estimated/Unavailable plus snapshot freshness |
| ±2% Depth | Sum `price × size × contractMultiplier` for bids at or above `mid×0.98` plus asks at or below `mid×1.02` | Estimated/Partial when supported; `index.html:10921` |
| Funding rate / APR | Raw funding and interval-aware annualization | Missing remains null; true zero remains zero |
| Funding sparkline | Exact contract observations normalized/deduplicated to requested window | `api/funding-history.js`; Full requires at least `max(2, ceil(0.8 × expected observations))`, otherwise Partial/Unavailable |
| Effective funding direction | Discard periods with absolute annualized funding below 1.5%; choose dominant positive/negative count and divide by the **expected** periods in the window | Client derivation at `index.html:5019`; no durable persistence |

Funding-history responses use CDN caching (`api/funding-history.js:198`) and are not a database history in Phase 0/1.

### 3.6 By Asset

Category-qualified exact listings are grouped into a canonical row at `index.html:7910`.

- venues: distinct venue count, with the most liquid variant used only for each venue dot;
- Best Price: maximum available fresh mark price across preserved listings;
- 24h Change: arithmetic mean of available listing changes;
- Total Volume and Total OI: listing sums with observed/expected status;
- Funding Spread: maximum minus minimum annualized funding across distinct venue representatives; each venue representative is its most liquid contract, with lexical contract tie-break (`index.html:3630-3650`).

This view is Browser only. The target later uses `analytics.cohort_version`, exact cohort members and `analytics.asset_hourly`.

### 3.7 Funding Heatmap

| Item | Formula |
|---|---|
| Cell | Latest fresh interval-aware annualized funding for one canonical asset/venue |
| Multiple venue variants | Most liquid contract represents that venue; all variants remain visible in the Drawer |
| Venue spread | `max venue APR − min venue APR`, requiring at least two venues |
| Opportunity filter | `max absolute APR >= 25%` |
| Color cap | Maximum of 25% APR and the 90th percentile of absolute displayed APR; square-root intensity |
| Near zero | Absolute APR below 1% |
| Data coverage | Observed funding cells divided by `assets × active venue columns` |

Implementation: `index.html:8092`. It is a current snapshot visualization, not persisted independently.

## 4. Spot page

### 4.1 Overview KPIs and Exchange Summary

| Metric | Formula | Status/current persistence |
|---|---|---|
| RWA pairs | Count admitted exact Spot listings | Cold/failed venue stays unknown, never zero; Browser |
| 24h volume | Sum exact listing USD/quote turnover | Per-field observed/expected; Browser |
| Average bid-ask spread | Mean of `(ask − bid) / last` for valid two-sided fresh listings | Unavailable for RFQ/one-sided/invalid book; Browser |
| Peak Funding APR* | Highest cash-and-carry `net` route result under the current holding-days/fee mode, despite the compact card label | Requires fresh exact category-qualified Spot/Perpetual match and valid two-sided Spot spread; Browser; `index.html:12468-12514` |
| Exchange 24h Volume | Sum available listing turnover | Per-venue field status; `index.html:12521` |
| Exchange Avg Spread | Mean valid spread in basis points | Field status from bid/ask availability |
| Estimated Round Trip | `2 × spot taker fee + average spread`, in basis points | Fee defaults and OKX generic fee are estimates, not account-tier quotes |
| Category breakdown | Exact Spot listing count by admitted category | Identity/catalog display |

### 4.2 Cash-and-Carry Arb Ranking

Eligibility requires one fresh exact Spot listing and one fresh category-qualified matching Perpetual contract. Stale or identity-ambiguous points are excluded.

```text
spread                 = (spot ask - spot bid) / spot last
funding APR            = perp funding × settlements per day × 365
basis                  = (perp mark in common units - spot last) / spot last
one-time cost          = 2×spot taker fee + 2×perp taker fee + spread
annualized cost        = one-time cost × 365 / holding days
net funding APR        = abs(funding APR) - annualized cost
spot deviation         = (spot last - reference price) / reference price
```

When holding days is zero (“No Fees”), annualized cost is zero and the display is gross absolute funding. Direction is Long Spot / Short Perp for non-negative funding and the reverse for negative funding. Basis is shown separately and is not annualized into or added to Net Funding APR. Implementation: `index.html:12090-12105` and `index.html:12575`.

All calculations are Browser-derived current comparisons with no durable persistence. Later target: exact listing facts plus a versioned derived route table/publication; not a Phase 0/1 write.

### 4.3 Reference Price

| Tier | Method | Status |
|---|---|---|
| Tier 1 | Yahoo direct USD price/close | Full when direct and fresh |
| Tier 1 converted | Yahoo local-currency price × matching FX conversion to USD | Estimated |
| Tier 2 fallback | Median available matching Perpetual index price | Estimated |
| Tier 3 fallback | Median matching Spot price, requiring at least two exchanges | Estimated |
| Missing/stale/unit mismatch | No value | Unavailable |

Server Tier 1 is `api/reference-prices.js:91-154` with 120-second fresh / 600-second SWR CDN caching. Client fallbacks are at `index.html:10734`. Reference price is comparison context, never identity proof.

### 4.4 All RWA Spot Assets

Exact listings are grouped for display by category-qualified underlying while keeping wrapper/ticker/venue rows beneath the group. Displayed aggregates are:

- price range: min/max valid exact-listing last prices;
- 24h change: arithmetic mean of available listing changes;
- bid-ask: range/average from valid two-sided observations;
- 24h volume: sum available listing USD turnover;
- Perp coverage: exact category-qualified matching contract venues.

Implementation: `index.html:12749`. This is Browser only. A reference-price ratio guard may reject a clearly incomparable display point, but cannot admit an asset; official metadata must already have verified the listing.

### 4.5 Spot venue tables

| Field | Formula/status |
|---|---|
| Last, 24h change, volume, high/low, bid/ask | Exact listing observation and per-field state |
| Ref Price | Tiered reference contract above |
| Dev % | `(Spot Last − Ref Price) / Ref Price`; rejected on gross unit/currency mismatch |
| Perp Mark / Basis | Exact matching Perpetual; `(Perp Mark − Spot Last) / Spot Last` |
| Bid-Ask | `(ask − bid) / last`, valid two-sided book only |
| ±2% Depth | Same price×size notional formula as Perpetual depth |
| Funding Ann. | Exact matching Perpetual funding, interval-aware |
| Arb APR | `abs(Funding Ann.) − (SpotFee×2 + PerpFee×2 + Spread)×365/Hold` |

The table is a current Browser/CDN view and is not written to a database in Phase 0/1.

## 5. Traditional Market page

The ranking is traditional-first: Crypto coverage is joined only after the official traditional rank is fixed. Producer: `api/tradfi-activity.js`; renderer: `index.html:7491`.

### 5.1 Candidate set and rank

```text
candidate set = current Nasdaq dollar-volume leaders
              ∪ current OCC standard-option volume leaders (Top 100)
              ∪ previous completed-session OCC leaders (Top 100)

estimated share value       = completed-session shares × same-session close
estimated option notional   = standard contracts × 100 shares × same-session close
traditional total value     = estimated share value + estimated option notional
```

- The Nasdaq share baseline uses up to 20 prior completed sessions within a 35-calendar-day request window (`api/tradfi-activity.js:27-31`).
- The option baseline is the prior four same-weekday completed OCC reports (`api/tradfi-activity.js:319-390`). An absent root in a successfully parsed complete OCC report is a real zero. A missing report is Unavailable.
- Adjusted option roots are excluded; incomplete adjusted-root coverage downgrades status.
- Total value is withheld unless both legs are available. It is Estimated when both official inputs are Full and Partial when either input is incomplete (`api/tradfi-activity.js:404-435`).
- Rank is descending total value, tie-break by estimated share value, then symbol (`api/tradfi-activity.js:625-674`).
- Rank delta is `previous rank − current rank`. `NEW` means absent from the previous disclosed candidate-set Top 100, not a new exchange listing.
- The page shows 50 initially and expands to at most 100.

The result is a tracked official candidate-set ranking, not a claim to reconstruct every U.S. security's previous-day rank. It is CDN-cached for 1 hour with 24-hour SWR (`api/tradfi-activity.js:801`). No durable daily rank is stored in Phase 0/1; the empty `fact.traditional_observation_daily` skeleton exists, while a reproducible `analytics.traditional_rank_daily` still requires a later migration and writer.

### 5.2 Relative activity and UI signal

```text
market relative volume  = current completed-session shares / prior-session average
options relative volume = current standard contracts / four-report same-weekday average
```

Current browser classification at `index.html:7257`:

- High: market relative volume `>= 2.0` **OR** options relative volume `>= 2.5`;
- Watch: market `>= 1.5` **OR** options `>= 1.75`;
- otherwise Normal.

This is a UI label, not a persisted server alert rule. A future durable alert must receive an explicit `rule_version` instead of silently reusing this browser function.

### 5.3 Crypto coverage and Indicative Max Spread

Perpetual/Spot coverage uses exact category-qualified identity and does not affect rank. Coverage volume is a current fresh/last-good diagnostic with Full/Partial/Unavailable state.

Indicative Max Spread requires a fresh Nasdaq USD/share quote and at least one comparable fresh Crypto price point. Each candidate Crypto point must be strictly between `0.5×` and `1.5×` the Nasdaq quote.

```text
max spread percent = (highest comparable price − lowest comparable price)
                     / lowest comparable price × 100
max spread dollars = highest comparable price − lowest comparable price
```

The result is Estimated, excludes fees/latency and is unavailable with stale traditional quotes or fewer than two points. Implementation: `index.html:7457`. Live quote CDN policy is 60 seconds fresh / 120 seconds SWR in `api/tradfi-prices.js:100`.

## 6. RWA Signal Radar

The public endpoint is `/api/signal-snapshot`. Only the authenticated, no-store `/api/signal-snapshot-cron` writes histories. Current endpoint assembly/persistence is at `api/signal-snapshot.js:51-56`, `api/signal-snapshot.js:670-815` and `api/signal-snapshot.js:1110-1171`.

### 6.1 General Radar Top 100

#### Universe and aggregation

- Inputs: five official Perpetual sources.
- Identity: reject invalid categories and quarantine any canonical symbol appearing in conflicting categories.
- Group: `category:canonical`, preserving exact listings.
- Activity order before Top 100: `aggregate rolling-24h USD volume + aggregate USD OI`, descending, then symbol (`api/_lib/signal-analysis.js:78-203`).
- Price: median comparable positive listing prices after retaining points within `0.5×–1.5×` of the raw median.
- Price dispersion: `(max comparable price − min comparable price) / min × 100`, requiring two points.
- Change: median available listing 24h percentage changes.
- Funding component value: signed annualized funding observation with greatest absolute magnitude.

#### Historical components

Volume and OI use `log1p` values and a robust z-score against prior hourly history:

```text
robust z = (current - median(history)) / (1.4826 × MAD)
```

When MAD is zero, the code falls back to mean/standard deviation and saturates a genuine break from a constant series. Volume/OI use positive-direction magnitude only. Their score is `clamp(magnitude × 22, 0, 100)` and is not used until at least 24 historical samples (`api/_lib/signal-analysis.js:265-323`).

#### Point-in-time components

Each absolute point metric maps piecewise to score 0–49 below Watch, 50–74 from Watch to High, 75–100 from High to Max:

| Component | Watch | High | Max |
|---|---:|---:|---:|
| Absolute annualized Funding | 50% | 100% | 150% |
| Absolute 24h Price Move | 5% | 10% | 20% |
| Cross-venue Price Dispersion | 1% | 3% | 5% |

Composite score is the strongest available component plus five points for every additional component at or above 50, clamped to 100. High is `>=75`; Watch is `>=50`; otherwise Normal. A nominal Normal is changed to Warming/Unavailable until the snapshot is comparable and the baseline is Full (`api/_lib/signal-analysis.js:348-430`).

History/persistence:

- formula `rwa-radar-1.0`, payload schema `rwa-signal-snapshot/v1`;
- namespace `rwa-signal-radar-v2`;
- idempotent UTC-hour buckets, maximum 168 stored snapshots;
- Volume/OI robust-z needs **24 strictly historical comparable samples plus current**. Its first score is therefore the 25th distinct hourly point, about 24 elapsed hours after a clean start; point-in-time Funding, Price Move and Dispersion can score on the first complete snapshot. The aggregate history banner may already read Partial at 24 stored buckets, but that does not manufacture the missing 24th prior sample for Volume/OI;
- Full/Normal history requires 168 total points (167 prior plus current), reached after about 167 elapsed hours. Before then a nominal Normal remains Warming/Partial according to the public contract;
- response returns at most 48 points per asset;
- Runtime Cache, regional best effort, 1.75 MB application guard.

Target later tables: exact listing facts, `analytics.asset_hourly`, versioned `alert.evaluation_run/event`, and publication manifests. No Phase 0/1 database write.

### 6.2 Perpetual Volume Anomalies

Producer: `api/_lib/volume-anomaly.js`; formula version `rwa-perp-volume-anomaly-1.0`.

| Item | Contract |
|---|---|
| Universe | Full verified Perpetual canonical universe, not general Radar Top 100 |
| Current | Complete rolling-24h USD contract volume across the exact cohort |
| Baseline | Mean of the preceding seven sealed UTC daily anchors for the same cohort/method fingerprint |
| Ratio | `current volume / seven-day mean`; current, mean, ratio and level are Estimated |
| High | ratio `>= 2.0` |
| Medium | ratio `>= 1.5` and `< 2.0` |
| Down | ratio `<= 0.4` |
| Normal | `0.4 < ratio < 1.5` only when comparable coverage/history is complete |
| Consecutive expansion | At least two consecutive eligible High/Medium days |
| 30-day high frequency | At least 21 eligible evaluation days and at least 6 anomaly days in the last 30 |

Any source/listing volume gap, identity conflict or changed exact cohort suppresses comparison and restarts Warming. Namespace `rwa-signal-volume-daily-v1` retains 45 daily anchors; 37 comparable daily buckets are needed for a complete 30-day frequency result. Runtime Cache only; Later DB target `analytics.asset_daily_volume_anchor` and versioned alerts.

### 6.3 RWA Spot Volume & Price Anomalies

Producer: `api/_lib/spot-volume-price-anomaly.js`; formula `rwa-spot-volume-price-anomaly-1.0`.

| Item | Contract |
|---|---|
| Unit | Exact `spot:venue:venueSymbol` listing; no canonical aggregation |
| Liquidity gate | Current USD turnover `>= $500,000`; exact boundary is eligible |
| Volume trigger | Current rolling-24h USD turnover / previous sealed-day rolling-24h anchor `>= 3.0` |
| Price trigger | Rolling-24h price gain `>= 15%`; a 15% fall does not trigger this version |
| Alert logic | Volume **OR** price; price can trigger while volume history is Warming |
| History | Same exact listing, identity, quote/unit and method fingerprint; one previous sealed UTC daily anchor required |
| Perp coverage | Exact current contracts joined only by matching `category:canonical` |

Volume fields are quote/USD turnover: Gate `quote_volume`, Binance `quoteVolume`, Bitget Reality `platformTurnover24h`, OKX `volCcy24h`; Kraken is estimated as `v[1] × p[1]`. Kraken's `o` is UTC-midnight open, not rolling-24h open, so Kraken price change is Unavailable and cannot trigger price (`api/_lib/spot-volume-price-anomaly.js:7-19`, `:661-730`).

Namespace `rwa-signal-spot-volume-price-history-v1` retains eight UTC daily anchors. A Partial five-source snapshot may display verified alerts but may not say “No anomalies.” Runtime Cache only; Later DB target exact Spot daily anchors plus versioned events.

### 6.4 OI Positioning & Large-Liquidation Proxy

Producer: `api/_lib/oi-liquidation-anomaly.js`; legacy trigger formula `rwa-oi-liquidation-proxy-1.0`; additive 24-hour range formula `rwa-oi-24h-range-1.0`.

Eligibility and triggers:

```text
eligible volume        = current aggregate 24h USD volume > $1,000,000
three-day OI build     = close(d-3) < close(d-2) < close(d-1)
24h drawdown           = max(comparable OI in prior 24h) - current aggregate OI
24h increase           = current aggregate OI - min(comparable OI in prior 24h)
24h increase percent   = 24h increase / 24h minimum OI × 100
liquidation proxy      = 24h drawdown > $2,000,000
alert                  = three-day OI build OR liquidation proxy
```

Both monetary boundaries are strict: exactly $1 million volume is ineligible and exactly $2 million drawdown does not trigger. The three closes are completed 23:00 UTC closes and never include current intraday OI. Exact cohort/method continuity and complete OI across all expected listings are mandatory.

All cross-listing OI USD, completed closes, 24-hour peak/trough, drawdown/increase and trigger fields are Estimated even when source coverage is Full. OI USD can change because mark price changes; neither direction proves which side opened, closed or liquidated.

Every recovery state includes additive `marketContext.version=rwa-oi-market-context/v2`. `price24h` does not publish a single cross-venue average. It selects the current exact perpetual listing with the largest USD OI among listings whose 24-hour change is available (`selectionMethod=largest-current-oi-listing-with-available-change`), and publishes that listing's venue/symbol/change/method/status plus its share of current aggregate USD OI. `rangePct`, `observedListings/expectedListings`, `coverageStatus` and snapshot `observedAt` preserve disagreement and missing coverage. Gate, Binance and Bitget use direct official 24-hour change fields as Full; trade.xyz mark-versus-previous-day and OKX last-versus-open24h are computed and therefore Estimated. Non-finite values and changes below -100% are Unavailable.

`marketContext.funding` is bound to that same representative `venue + venueSymbol`. When the representative listing has a finite native funding rate and a positive interval, `ratePct = fundingRate × 100` publishes the per-interval percentage together with `intervalHours`; it is not annualized. Missing reference or funding fields remain explicitly Unavailable. Funding from another venue is never substituted.

Binance Top Trader Position Ratio is optional supporting evidence for every exact Binance contract on an already triggered asset. It never triggers the alert:

- strict ratio `>1.05` = Bullish;
- strict ratio `<0.95` = Bearish;
- exact `0.95` and `1.05` = Neutral;
- no exact row, failure, stale/contradictory percentages = Unavailable, never Neutral;
- official observation may be at most three hours old.

Triggered drawdown states and states crossing the published OI-surge context gates publish one same-contract object under `marketContext.positioning`. Its `venue` and `venueSymbol` must exactly equal `price24h.representative`. Only a Binance representative can currently publish Full data, with metric `top-trader-position-ratio`, scope `top-20%-by-margin-balance-position-ratio` and period `1h`. A trade.xyz, Gate, Bitget or OKX representative publishes `VENUE_POSITIONING_UNSUPPORTED`; it never borrows a Binance listing for the same canonical asset. No price reference publishes `REFERENCE_CONTRACT_UNAVAILABLE`, and states that need no positioning context publish `OI_POSITIONING_NOT_REQUESTED`. Binance enrichment targets are derived from the exact representative contract in the uncapped `states` contract, never another venue listing or the ranked Top-100 `rows` response. The surge context gates match the consumer contract: current OI at least $10m, 24-hour increase above $5m and above 10%. The legacy ranked-row `topTraderPositions` fields remain unchanged for compatibility and are not the Push market-context contract.

Namespace `rwa-signal-oi-liquidation-hourly-v1` retains 96 idempotent UTC-hour buckets and requires 24 comparable hours plus three completed days. It stores only volume-eligible, OI-complete exact cohorts. Runtime Cache only; empty later-phase skeletons are `fact.top_trader_observation_hourly`, `analytics.asset_daily_oi_close`, `analytics.asset_hourly` and versioned alerts.

Binance `underlyingType=CN_EQUITY` is an exact official Equity mapping. Future unknown official types remain fail closed: at most one active `TRADIFI_PERPETUAL` row with a valid, unique venue symbol/base and a non-empty, non-Crypto unknown type may be excluded under `UNSUPPORTED_OFFICIAL_ROWS_QUARANTINED`. The source publishes `catalogListingCount = listingCount + quarantinedListings`, and OI coverage publishes the recomputed quarantine total. This narrow quarantine makes the response Partial/Warn but lets verified unchanged cohorts continue writing; it never admits the unknown row as RWA. A second unknown row, blank/malformed identity, duplicate identity, Crypto type, catalog/identity/upstream blocker, cross-category conflict, or source-wide absence of Volume/OI remains non-comparable and blocks the history writer. Missing OI on only some accepted listings remains asset-isolated: those assets are Unavailable while complete same-cohort assets continue.

The public OI child has two deliberately different collections. `rows` keeps the existing ranked alert contract and remains capped at 100. `states` is an additive recovery contract and is never rank-capped: it contains exactly one compact state for every current volume-eligible asset, including assets whose current exact OI cohort is incomplete. `stateCoverage={expectedEligibleAssets,returnedStates,complete}` must reconcile exactly to `coverage.volumeEligibleAssets`; an incomplete state collection is a failing contract, not evidence that an alert recovered.

Each state publishes `assetKey`, `symbol`, `category`, `cohortFingerprint`, UTC-hour `observedBucket`, `evaluationStatus`, `sameCohort`, current/peak/trough OI USD, drawdown/increase amounts, `drawdown24hPct`, `increase24hPct`, explicit `reasonCodes`, and the versioned `marketContext` above. Percentages use their matching peak or trough denominator and are rounded to six decimals; a zero denominator keeps that percentage null with an explicit reason. `evaluationStatus` remains the legacy drawdown-source status and is one of:

- `triggered`: the comparable drawdown is strictly above the producer's existing `$2,000,000` liquidation-proxy boundary;
- `clear`: a gap-free same-cohort 24-hour evaluation is available and does not cross that boundary;
- `warming`: the current cohort is complete, but a cohort change or missing hourly observation prevents comparison;
- `unavailable`: the current eligible cohort is incomplete, history is unavailable, or the snapshot is not comparable.

Downstream delivery systems may independently classify the additive 24-hour increase metrics, but may close state only from an explicit comparable row below their own thresholds. A missing state, `warming`, `unavailable`, or `sameCohort != true` must fail closed.

### 6.5 Competitor New Listings

Producer: `api/_lib/listing-audit.js`; public reader: `api/listing-changes.js`; formula/schema `rwa-listing-audit/v1`.

| Item | Contract |
|---|---|
| Sources | Exactly five Perpetual plus five Spot official catalogs |
| Key | Exact `market:venue:venueSymbol` |
| Initial successful run | Day 1 first Full catalog establishes baseline and emits no New events |
| Add/relist | The second Full daily catalog can emit a verified New or Relisted event in `0–24h`; review-required remains in a separate active queue |
| Removal | Exact lifecycle is `D0 present → D1 first complete missing → D2 complete missing confirmed`. This is three daily observations on the live path and normally `24–48h` from the first missing observation; same-day retries do not confirm removal |
| Drift quarantine | Ratio greater than 10% and absolute change greater than 5 when removals/mixed drift are involved; extreme pure growth above 50% and 50 listings is also quarantined |
| UI window | Rolling seven days by default, optional 30 days; pending reviews are not window-truncated |
| Inclusion status | Only an exact current page listing with matching venue symbol and category-qualified identity is Included |

Current persistence is Runtime Cache namespace `rwa-listing-audit-v2`: target 45 event days, maximum 2,000 events, inactive identity retention 180 days and 1.75 MB guard. The 7/30-day UI windows and 45-day retention are view/audit horizons, not product warm-up. Truncation is disclosed and cannot be Full or “no new assets.” Constants: `api/_lib/listing-audit.js:1-22`.

This is the sole product family written to PostgreSQL in Phase 1. The shadow sink stores source runs, deterministic `normalized-catalog-v1` manifests/checksums, accepted identity/instrument versions with official-catalog evidence, exact accepted catalog memberships and `analytics.catalog_change_event` lifecycle rows. Stored normalized artifacts are linked to their evidence rows. Confirmed verified delisting closes the current instrument version and a verified relisting opens a new version; Partial/Unavailable or review-required absence never does. `identity.alias_version` is schema-only and is not populated by this writer. An unresolved `review-required` candidate is stored only in `identity.review_case`; it creates no accepted identity/instrument/membership/event. A trusted same-day retry atomically replaces that source's logical membership/evidence set; an untrusted retry preserves PostgreSQL last-good, and a later verification is classified as identity resolution rather than New. The artifact is derived from the verified/reviewed catalog observation and is not the upstream response body. Private object upload is separately controlled by `RAW_ARCHIVE_MODE`; `/api/listing-changes` continues to read Runtime Cache. When PostgreSQL is enabled, a fixed 180-second database lease plus a post-acquire Runtime Cache checksum re-read serializes durable write, cache publication and sink acknowledgement; busy/stale/conflicting writers return 409, and degraded/missing lease evidence cannot pass Daily Check readiness.

## 7. Asset Intelligence Drawer and browser alert panel

### 7.1 Asset Intelligence Drawer

The Drawer is a category-qualified read composition, not a separate dataset. `buildAssetIntelligenceModel` begins at `index.html:5412`; rendering begins at `index.html:5604`.

It combines:

- exact Perpetual and Spot listings, venue/source health and market tags;
- reference/traditional quote context and comparable price points;
- current volume, OI, funding and funding-history evidence;
- loaded Traditional Top 100 match, if that page has been requested;
- the category-qualified source section that opened the Drawer.

Comparable prices use the existing unit guard; unavailable fields remain unavailable. The Drawer is Browser only and must be reproduced later from the same versioned facts/publication inputs, not persisted as duplicated HTML or JSON.

### 7.2 Global browser alert panel

`computeAlerts` at `index.html:6024` is independent of server Signal Radar:

1. funding: absolute annualized APR strictly above 100% is High and above 50% is Medium for normal intervals; contracts with interval `<=1h` multiply both thresholds by three;
2. cross-venue funding spread: strictly above 30% APR; High when spread is above 80%, otherwise Medium;
3. mark/index divergence: `abs(mark-index)/index >1%`; High above 3%, otherwise Low.

It is recomputed from fresh current Browser state, has no durable history and is not an authoritative alert event. Database alert tables remain unused until a later rule-version migration.

## 8. Operational publications and health

| Product/API | Current publication/cache | Historical persistence | Phase 0/1 DB |
|---|---|---|---|
| Main Perpetual/Spot venue snapshots | Fixed-purpose server responses and Browser state; route-specific CDN TTL/SWR | None | Catalog identity only in Phase 1; no market facts |
| Funding history | CDN, 60s/300s when complete and shorter on partial | None | No |
| Top 30 collectors | CDN, generally 5m/10m | None | No |
| Reference prices | CDN 120s/600s | None | No |
| Traditional activity | CDN 1h/24h | None | No |
| Traditional live prices | CDN 60s/120s | None | No |
| General Radar | CDN 5m/10m public read | Runtime Cache 168 hourly snapshots | No |
| Perp Volume Anomalies | Child of Radar public read | Runtime Cache 45 daily anchors | No |
| Spot Volume & Price Anomalies | Child of Radar public read | Runtime Cache 8 daily anchors | No |
| OI Proxy | Child of Radar public read | Runtime Cache 96 hourly buckets | No |
| Competitor Listings | CDN 5m/10m public read | Runtime Cache 45-day target / 2,000 event cap | **Yes, Phase 1 shadow** |
| `/api/health` | Read-only live contract check; HTTP 503 by current severity policy | Function logs/GitHub Action record | No product data write |

The four Signal histories are separate and the authenticated writer returns HTTP 200 only when all required stores report `stored`. Existing write/503 semantics must remain unchanged through Phase 0/1. Source health and database reconciliation records may be added as shadow operational telemetry, but they cannot change page status before a separately approved read cutover.

### 8.1 Product maturity and future revision collection by data family

Current persistence does **not** provide a market-history revision ledger:

| Current product | Retry/history behavior now | What cannot be claimed |
|---|---|---|
| Phase 1 Competitor Listings | One current official catalog observation per source/day, plus accepted membership and lifecycle evidence | Current catalogs have no historical market-fact overlap, and catalog success does not validate price/volume/OI/funding/reference/Traditional revisions |
| General Radar and OI Runtime Cache | A retry in the same UTC hour replaces that cache bucket | The first value, intermediate revisions, revision count and delta are not retained |
| Perp and Spot daily anomaly anchors | A same-UTC-day retry replaces the compact daily bucket | This is idempotent last-good history, not append-only source-restatement history |
| Funding, Top 30, Reference and Traditional endpoints | CDN/current response behavior described above | CDN revalidation is not durable correction evidence |

Migration `0004` supplies the default-off bitemporal, append-only listing-market foundation described in `DATABASE_ARCHITECTURE.md`; applying it alone does not begin exact market-fact dual-write. For the same exact observation key and source/method/version, an identical normalized re-fetch is idempotent; an accepted changed representation appends a revision, while review/anomalous candidates are quarantined. The read-only summary exposes typed first/latest values, revision count (changes after the first), latest/first delta and latest/previous delta. Event/valid time remains fixed while captured/system time identifies when each representation was seen.

There is no universal overlap or elapsed-time gate. The exact current formula and future revision policy are:

| Product/data family | Cadence | First usable | Formula Full / first complete conclusion | Current retention | Future revision overlap |
|---|---|---|---|---|---|
| Competitor Listings | Daily | Day 1 first Full baseline; no New events | Day 2 Full can emit New/Re-listed (`0–24h`). Confirmed delist is `D0 present → D1 first missing → D2 missing confirmed` (`24–48h` after first missing). | UI 7/30d; events 45d; inactive identities 180d | No historical query; append each current exact catalog/fingerprint |
| General Radar | Hourly | Funding/Price/Dispersion on first complete snapshot; Volume/OI on the **25th point** (24 prior + current), about 24h | Full/Normal at 168 total points, about 167 elapsed hours | 168 hourly buckets; 48 points returned | No independent derived overlap; replay from versioned inputs |
| Perp volume anomalies | Daily sealed anchors plus live current | Ratio on eighth distinct UTC date: seven prior + current, about 7d | Consecutive expansion Day 9; high-frequency first possible Day 28; complete 30-day frequency at the 38th distinct UTC-date point (`Day 0…37`), about 37d | 45d | Rolling ticker cannot backfill; append captures and version the sealing rule |
| Spot volume/price anomalies | Daily sealed anchor plus current | Price Day 0; volume after one prior sealed day—next post-midnight hourly run in the best case, otherwise within 24h | One comparable prior anchor; Kraken price change is structurally Unavailable | 8d, retention only | Rolling ticker append-current; zero historical query overlap |
| OI / liquidation proxy | Hourly | Current OI immediately; drawdown on bucket 24, about 23h; Top Trader immediately after an alert | Three completed 23:00 closes in about 49–72h | 96h, retention only | Historical-capable source: hot 6h, daily 48h, weekly 7d; other sources append current only |
| Funding | Current plus requested settled history | Current immediately; history after at least two settled rows | `observed >= max(2, ceil(0.8 × expected))`. With no upstream backfill, default 24h is about 16h for 8h/4h cadence and 19h for 1h; official history can be Full on the first request. | Endpoint maximum 720h; Bitget response structure caps 100 rows | Latest two settlements or 24h; daily 7d; monthly 30d |
| Top 30 | Completed daily/hourly candles | Old listing may be Full on first historical request; Day 0 `24h × 30` is Estimated; first daily bar <=24h or trade.xyz hourly bar <=1h is Partial | 30 daily bars Full for direct daily methods. trade.xyz 720 hourly bars is about 30d but remains Estimated; Top-80 gating can remain Estimated indefinitely. | CDN/browser only; 30d query | Daily hot 3–7d + T+2 cold + monthly 30d; hourly hot 6h + daily 48h |
| Traditional | Completed sessions; endpoint fetches history directly | Old asset rank/rank delta on first request; new asset normally T+1 | Market relative Partial with >=1 prior, Full with 20 prior sessions (about 4 weeks). Options Partial with >=1 same-weekday report, Full with four (about 4 weeks); adjusted series can remain Partial. | CDN only | Daily 5 sessions; weekly 20 sessions + four OCC reports; monthly 60 sessions |
| Reference | Current quote/reference | Fresh native + FX or allowed fallback immediately | No historical maturity; this is not an authoritative completed-session close | CDN/browser only | Current reference append-only with zero query overlap; future completed close uses 5 sessions + T+2 cold check |
| Cross-venue / By Asset / Heatmap / Cash-and-Carry / browser alerts | Current loaders | Immediately after the required fresh loaders settle | Full is source/field completeness, never elapsed time | Browser only | No independent overlap; replay exact catalog/listing facts |

“First usable”, “formula Full”, “retention” and “revision overlap” are separate dimensions. Retaining eight, 45, 96 or 168 buckets does not make a formula wait for the whole retention horizon; conversely a Full current formula does not prove that upstream corrections have been replayed. The initial normal/review/anomalous thresholds remain versioned operational data-quality rules in `DATABASE_ARCHITECTURE.md`; they do not alter current Radar, volume, price, OI or funding formulas. Phase 1 has no market-fact/rolling-history writer, so catalog readiness must continue to report `marketFactsChecked=false` and `rollingMarketHistoryVerified=false`.

## 9. Target layer mapping

| Data layer | Current examples | Target storage | Phase 0/1 permission |
|---|---|---|---|
| External metadata/raw archive | Official catalog/market payloads and traditional source files | Object archive + `ingest.raw_artifact` manifest | Raw-body contract/schema in Phase 0; no upstream raw body in Phase 1; collector instrumentation later |
| Normalized catalog artifact | Deterministic accepted/reviewed observation representation | `ingest.raw_artifact` manifest with kind `normalized`; optional private content-addressed object | Ten manifests/checksums per complete PostgreSQL-shadow cycle; object upload only when its independent server switch is enabled |
| Normalized identity/catalog | Security identity, exact venue listing membership | `identity.*`, `ingest.source_run`, `ingest.catalog_membership` | Ten catalogs only in Phase 1 |
| Normalized market facts | Listing price/volume/OI/funding/depth, traditional/reference observations | Typed `fact.*` plus Phase 2 append-only revision relations/views | Listing revision foundation exists in `0004`; writer/read remain off, other families remain skeleton/later |
| Derived analytics | Canonical hourly aggregate, daily anchors, ranks, cohorts | `analytics.*` | Schema skeleton only |
| Signals | Radar scores, anomaly triggers, listing lifecycle events | Market signals later use `analytics.signal_result` / `alert.*`; catalog lifecycle uses `analytics.catalog_change_event` | Only verified catalog lifecycle events may shadow-write; market signals do not |
| Publication | API snapshot payload/checksum/latest pointer | `publication.*` plus CDN | Schema skeleton only; current APIs unchanged |

## 10. Formula change checklist

Any change to a formula, threshold, grain or comparable cohort must include all of the following in one release:

1. new immutable formula/rule/method version when historical comparability changes;
2. updated producer and server contract tests at included and excluded boundaries;
3. client validator update that fails malformed payloads closed without reclassifying valid rows for display;
4. updated status, observed/expected and Warming behavior;
5. migration/replay statement for prior history—never silently compare incompatible distributions;
6. updates to this registry, `RWA_DATA_RULES.md` and `OPERATIONS.md` where relevant;
7. a database-impact declaration naming the target fact/revision relation and observation key, or explicitly stating `no persisted representation yet`;
8. writer/read state, formula/method/cohort version, retention/partition impact, and identical-versus-changed re-fetch behavior;
9. any additive migration, backfill/replay and old/new compatibility plan; an existing database writer must be updated in the same release, while a not-yet-backed feature keeps its writer disabled;
10. isolated Preview migration/audit evidence followed by Production migration checksum, database fingerprint and post-release reconciliation;
11. explicit confirmation that no bare-ticker join or Crypto collision entered the result.

An application formula and its persisted representation are one versioned contract. A release must not change the application calculation while silently continuing to write the old database meaning under the same method or formula version. Conversely, creating an empty table does not authorize a writer or imply historical coverage. Read cutover follows expand, dual-write/reconcile and explicit approval; rollback disables the new writer/reader and uses a forward migration rather than deleting accepted revisions.

## 11. Code-location index

| Concern | Current executable location |
|---|---|
| Identity/category/lifecycle | `api/_lib/security-identity.js`, `api/_lib/listing-sources.js`, `RWA_DATA_RULES.md` |
| Common frontend status/freshness/funding | `index.html:3514-3650` |
| Perpetual KPIs/cards/coverage/ranking | `index.html:6222-6570` |
| Top 30 | `index.html:6571-7097`; `api/binance-public.js`; `api/hyperliquid-klines.js`; `api/okx-market.js` |
| Traditional | `api/tradfi-activity.js:27-830`; `index.html:7240-7650` |
| Perpetual By Asset / Heatmap | `index.html:7910-8255` |
| General Radar | `api/_lib/signal-analysis.js:1-430`; `api/signal-snapshot.js` |
| Perp volume anomaly | `api/_lib/volume-anomaly.js` |
| Spot volume/price anomaly | `api/_lib/spot-volume-price-anomaly.js` |
| OI proxy / Top Trader | `api/_lib/oi-liquidation-anomaly.js`; `api/binance-public.js` |
| Listing lifecycle / Phase 1 shadow | `api/_lib/listing-audit.js`; `api/listing-changes.js`; `api/listing-audit-cron.js`; `api/_lib/listing-pg-shadow.js` |
| Spot reference/arb/venue tables | `api/reference-prices.js`; `index.html:10734`; `index.html:11980-12985` |
| Drawer / browser alerts | `index.html:5412-5745`; `index.html:6024-6135` |
| Health contract | `api/_lib/health.js`; `api/health.js` |

# RWA Dashboard Operations

## Monitoring layers

1. **Runtime resilience**
   - Upstream requests use bounded timeouts, retries, concurrency limits and CDN stale-while-revalidate caching.
   - Perp and spot venue fetches retain a last-good snapshot. A failed refresh is shown as `Stale cache`; it is never silently presented as live.
   - Missing numeric fields remain `null` and receive an explicit Full / Partial / Estimated / Unavailable status.
   - Hidden pages stop polling. When visible again, only stale datasets resume; concurrent refreshes for the same dataset share one in-flight request.
   - Traditional ranking and quotes load only while the Traditional page is active. Rendering a hidden section must not start official-source requests.

2. **Vercel health probe**
   - `GET /api/health` verifies the production shell, USD and FX-converted Reference Prices, and 24-hour Funding History sentinels for trade.xyz, Bitget, Gate and Binance.
   - The response is `healthy`, `degraded` or `unhealthy`. A critical dashboard/reference failure, or two failed checks, returns HTTP 503.
   - Vercel Cron invokes it daily at 01:00 UTC (09:00 Asia/Shanghai). Results are visible in Function logs under `[rwa-health]`.
   - The endpoint is intentionally read-only and returns no credentials or private configuration.

3. **GitHub Actions**
   - `.github/workflows/data-health.yml` runs every day at 01:20 UTC and on demand.
   - It runs contract tests, inline-script parsing, live reference/funding/Nasdaq/OCC data contracts and the production health endpoint. Traditional checks include Top 100 cardinality, adjacent-session alignment and rank-change invariants.
   - A failing run must be reviewed before promoting another production deployment.

4. **Codex scheduled reviews**
   - Daily at 09:10 Asia/Shanghai: production status, live data contracts, deployment state and recent errors.
   - Monday at 10:00 Asia/Shanghai: full venue catalogs, identity collisions, listing lifecycle, classification/tags, Traditional candidate/ranking rules, previous-session selection and comparison coverage, false `NEW` detection, deterministic tie-breaks, adjusted-options handling, reference pricing and historical coverage.
   - Scheduled reviews are read-only. They report P0/P1/P2 findings and must not modify, push or deploy without user confirmation.

## Vercel usage guardrails

The main resource risk is request fan-out, not response payload size. One browser refresh must never create one Vercel request per asset.

| Workload | Client/server budget | Shared-cache policy |
|---|---|---|
| Gate market catalogs | One fixed, field-projected `perp-snapshot` request replaces futures contracts + tickers; one fixed, field-projected `spot-snapshot` replaces currency pairs + tickers. The Spot pair catalog is mandatory. The former broad `/api/gate/:path*` and `/api/gate-spot/:path*` proxies are not exposed in production. | 30-second fresh snapshot, 120-second stale-while-revalidate. |
| Gate volume growth | One fixed `/api/gate-bulk?type=growth` request per visible client at most every 15 minutes. The server re-discovers the official Gate RWA catalog, fails closed above 500 contracts and fetches with bounded concurrency. | 15-minute fresh snapshot, 60-minute stale-while-revalidate. |
| Gate spot depth | One sorted bulk request for at most 80 already-verified pairs per spot refresh; server concurrency is bounded. No per-pair production proxy calls. | 30-second fresh snapshot, 120-second stale-while-revalidate. |
| Traditional ranking | Load only on entry to the Traditional page, with one canonical `limit=100` cache key. Client memory TTL is 1 hour. | 1-hour fresh snapshot, 24-hour stale-while-revalidate. |
| Traditional quotes | Load only on the active Traditional page. Client memory TTL is 60 seconds during the US regular session and 15 minutes while closed. | 60-second fresh snapshot, 120-second stale-while-revalidate. |

Bulk symbol lists must be unique uppercase values in lexical order; time windows must use deterministic buckets. Browsers revalidate, while `Vercel-CDN-Cache-Control` owns the shared snapshot. Validation errors and total upstream failures are `no-store`; partial results retain explicit missing values and the UI merges successful symbols into its per-venue last-good snapshot. Failed venues retry on their own five-minute backoff instead of inheriting another venue's success TTL.

Review Vercel Usage and top routes daily for the first 48 hours after a resource-affecting release, then weekly. Configure plan-level spend/usage alerts where available. Treat either of these as P1: projected monthly Edge Requests exceed 80% of the active plan allowance, or a route's rolling 24-hour requests exceed 1.5x its preceding seven-day daily median without a documented traffic increase. Throttling, a quota-caused outage or uncontrolled per-symbol fan-out is P0.

## Severity policy

- **P0**: production unavailable; RWA identity gate admits known crypto collision; widespread missing venue; materially wrong units/currency; reference or funding data could produce false trading conclusions.
- **P1**: one venue stale/unavailable; major catalog drift; historical coverage or reference source materially incomplete; Traditional comparison data mislabeled as a real rank move/`NEW`; persistent 5xx/timeouts.
- **P2**: isolated metadata/tag gaps, moderate latency, technical debt, non-blocking warnings.

## Baseline drift

The machine-readable baseline is exported from `api/_lib/health.js` and mirrors `RWA_DATA_RULES.md`. It is a drift alarm, not a permanent allowlist.

- Perpetuals: trade.xyz 108, Bitget 273, Gate 360, Binance 155; total 896.
- Spot: Gate 60, Kraken 167, Bitget 627, Binance 68; total 922.
- Canonical perpetual underlyings: 471.

Investigate when a venue changes by more than 10% or the total changes by more than 5%. Confirm official listings before updating the baseline.

## Release gate

Before production promotion:

1. `npm test`
2. `npm run check:inline`
3. Deploy a Preview.
4. `DASHBOARD_URL=<preview-url> npm run audit:data`
5. `DASHBOARD_URL=<preview-url> npm run audit:health`
6. Request the same normalized Gate bulk URL twice. After a cold `MISS` (or an already warm response), the second response must be `HIT`/`STALE`; 4xx/5xx responses must be `no-store`.
7. Browser-check venue counts, Spot Reference status, Funding History and target lifecycle/tag fixes. For Traditional, verify 50 rows initially, More expands to at most 100, row 51–100 quotes are not truncated, and rank arrows/`NEW` match the API comparison session.
8. Push the verified commit, promote the same Preview artifact, then repeat both audits and the same-URL cache check on production.
9. Check production 5xx logs and document any platform-only warning separately.
10. After 30–60 minutes and again after 24 hours, compare Edge Requests and top-route distribution with the pre-release baseline. Gate client traffic should scale with refreshes/cache keys, never with the number of assets.

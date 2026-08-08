# RWA Dashboard Operations

## Monitoring layers

1. **Runtime resilience**
   - Upstream requests use bounded timeouts, retries, concurrency limits and CDN stale-while-revalidate caching.
   - Perp and spot venue fetches retain a last-good snapshot. A failed refresh is shown as `Stale cache`; it is never silently presented as live.
   - Missing numeric fields remain `null` and receive an explicit Full / Partial / Estimated / Unavailable status.

2. **Vercel health probe**
   - `GET /api/health` verifies the production shell, USD and FX-converted Reference Prices, and 24-hour Funding History sentinels for trade.xyz, Bitget, Gate and Binance.
   - The response is `healthy`, `degraded` or `unhealthy`. A critical dashboard/reference failure, or two failed checks, returns HTTP 503.
   - Vercel Cron invokes it daily at 01:00 UTC (09:00 Asia/Shanghai). Results are visible in Function logs under `[rwa-health]`.
   - The endpoint is intentionally read-only and returns no credentials or private configuration.

3. **GitHub Actions**
   - `.github/workflows/data-health.yml` runs every day at 01:20 UTC and on demand.
   - It runs contract tests, inline-script parsing, live reference/funding/Nasdaq/OCC data contracts and the production health endpoint.
   - A failing run must be reviewed before promoting another production deployment.

4. **Codex scheduled reviews**
   - Daily at 09:10 Asia/Shanghai: production status, live data contracts, deployment state and recent errors.
   - Monday at 10:00 Asia/Shanghai: full venue catalogs, identity collisions, listing lifecycle, classification/tags, Traditional candidate/ranking rules, adjusted-options handling, reference pricing and historical coverage.
   - Scheduled reviews are read-only. They report P0/P1/P2 findings and must not modify, push or deploy without user confirmation.

## Severity policy

- **P0**: production unavailable; RWA identity gate admits known crypto collision; widespread missing venue; materially wrong units/currency; reference or funding data could produce false trading conclusions.
- **P1**: one venue stale/unavailable; major catalog drift; historical coverage or reference source materially incomplete; persistent 5xx/timeouts.
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
6. Browser-check venue counts, Spot Reference status, Funding History and target lifecycle/tag fixes.
7. Push the verified commit, promote the same Preview artifact, then repeat both audits on production.
8. Check production 5xx logs and document any platform-only warning separately.

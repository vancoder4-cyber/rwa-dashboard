# RWA Dashboard Deployment Guide

## Step 1: Create GitHub Repo & Push

Open Terminal, cd into the deploy folder, then run:

```bash
cd ~/path/to/RWA\ Arbitrage\ Opportunity/deploy

git init
git add -A
git commit -m "Initial commit: RWA perpetual futures dashboard"

gh repo create rwa-dashboard --public --source=. --push
```

> If you don't have `gh` CLI: install with `brew install gh`, then `gh auth login`.
> Or create the repo manually on github.com and use:
> ```bash
> git remote add origin https://github.com/YOUR_USERNAME/rwa-dashboard.git
> git branch -M main
> git push -u origin main
> ```

## Step 2: Deploy to Vercel

### Option A: Via Vercel Website (Easiest)
1. Go to https://vercel.com/new
2. Sign in with GitHub
3. Import the `rwa-dashboard` repo
4. Framework Preset: select **Other**
5. Click **Deploy** — done!

### Option B: Vercel CLI (Preview only)
```bash
npm i -g vercel
cd ~/path/to/RWA\ Arbitrage\ Opportunity/deploy
vercel
```
Follow the prompts to create a Preview. Never run `vercel --prod` from a local worktree. Production must come from the Git integration on `main`, or from a verified artifact whose deployment-provenance check reports `main` and the intended full commit SHA.

The build runs unit tests through `scripts/run-tests.mjs`, which passes only a small operating-system allowlist to the test process. Vercel production credentials and persistence modes must never be visible to unit tests or used as test fixtures.

## Step 3: Custom Domain (Optional)
In Vercel Dashboard → Project Settings → Domains → add your domain.

## File Structure
```
deploy/
├── index.html          ← production dashboard (single-file app)
├── i18n.js             ← English-source / Chinese presentation layer
├── api/                ← fixed-purpose market, history and health functions
├── vercel.json         ← Vercel routing & security headers
├── RWA_DATA_RULES.md   ← asset identity, labels, and audit rules
├── OPERATIONS.md       ← monitoring, baselines and release gate
├── .gitignore
└── DEPLOY.md           ← this file
```

Before changing venue catalogs, symbol aliases, category overrides, market
tags, or spot wrapper discovery, review [RWA_DATA_RULES.md](./RWA_DATA_RULES.md)
and complete its pre-release audit checklist.

## Step 4: Verify Preview and Production

Run the local contract gates before creating the deployment:

```bash
npm run build
```

Deploy a Preview, then run both audits against that exact Preview URL:

```bash
DASHBOARD_URL=https://your-preview.vercel.app npm run audit:data
DASHBOARD_URL=https://your-preview.vercel.app npm run audit:health
```

For an OKX-affecting release, the Preview and final production artifact must satisfy all of these checks:

- Perpetuals report 183 OKX listings: 149 SWAP + 34 X-Perp, representing 149 OKX canonical underlyings. A canonical aggregate such as AAPL retains both contract listings instead of overwriting one.
- Spot reports 51 OKX listings: 48 Unified Tokenized Stocks + exactly `PAXG-USD`, `PAXG-USDT`, `XAUT-USDT`, representing 50 canonical assets.
- `instCategory=1` Crypto rows such as CAT/LIT/QNT are absent; the UTS wrapper `X` is removed only after the official category-3 gate; ordinary dated FUTURES and OI-only expired rows are absent.
- `/api/okx-market?type=perp-snapshot` and `type=spot-snapshot` return catalog-joined coverage and stable shared-cache behavior. Missing fields remain null; generic OKX fees and derived derivative USD volume show Estimated, while unsupported fee fields show Unavailable.
- Top 30 accepts only confirmed complete daily candles for Full 30d coverage. Binance and trade.xyz use one fixed server-owned catalog/Top-80 snapshot each, with no browser-selected symbol/time query; trade.xyz `base volume × close` remains Estimated even at 720 completed hours. Partial history or `24h×30` fallback is labeled Partial/Estimated, and the loading copy names OKX in both English and Chinese.
- `GET /api/health` includes OKX in the five-venue probes and agrees with the 1,079 Perpetual / 973 Spot listing baselines.
- `GET /api/us-market-directory` returns a stable official directory with at least 8,000 unique Equity/ETF symbols, includes AAPL/QQQ/BABA/TSM and keeps BABA in the additive ADR list. Do not require any ticker to remain absent forever. A legitimate U.S.-listed security ticker such as the `BTC` ETF may remain in the directory; browser rows still require the earlier Equity/ETF identity gate, so Crypto BTC and Pre-IPO identities must not receive the tag.

In the browser, switch `EN → 中文 → EN`, open OKX Perpetuals, Spot, Top 30, Signal Radar and one Asset Intelligence Drawer, and confirm that ticker/venue identity, selected tabs, filters and loaded data do not change with language. In both Perpetual and Spot, toggle `US-listed / 美股`; every remaining asset row must carry the same US tag, category + market filtering must use AND, and non-U.S./crypto collisions must remain excluded.

Push the verified commit and promote the same Preview artifact. Repeat `audit:data`, `audit:health`, `/api/health`, the browser assertions and the production 5xx/log review against <https://avenir-rwa-analyst.vercel.app/>. Do not rebuild or deploy an unverified local revision between Preview and promotion.

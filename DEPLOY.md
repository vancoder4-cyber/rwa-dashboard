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

### Option B: Via Vercel CLI
```bash
npm i -g vercel
cd ~/path/to/RWA\ Arbitrage\ Opportunity/deploy
vercel
```
Follow the prompts. Vercel auto-detects the static site from `index.html`.

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
npm test
npm run check:inline
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
- Top 30 accepts only confirmed complete OKX daily candles for Full 30d coverage. Partial history or `24h×30` fallback is labeled Partial/Estimated, and the loading copy names OKX in both English and Chinese.
- `GET /api/health` includes OKX in the five-venue probes and agrees with the 1,079 Perpetual / 973 Spot listing baselines.

In the browser, switch `EN → 中文 → EN`, open OKX Perpetuals, Spot, Top 30, Signal Radar and one Asset Intelligence Drawer, and confirm that ticker/venue identity, selected tabs, filters and loaded data do not change with language.

Push the verified commit and promote the same Preview artifact. Repeat `audit:data`, `audit:health`, `/api/health`, the browser assertions and the production 5xx/log review against <https://avenir-rwa-analyst.vercel.app/>. Do not rebuild or deploy an unverified local revision between Preview and promotion.

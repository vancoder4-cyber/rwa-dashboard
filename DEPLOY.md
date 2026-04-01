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
├── index.html      ← production dashboard (single-file app)
├── vercel.json     ← Vercel routing & security headers
├── .gitignore
└── DEPLOY.md       ← this file
```

#!/bin/bash
set -e

echo "🚀 RWA Dashboard — One-click Setup"
echo "===================================="

# ── Check & install prerequisites ──
if ! command -v gh &>/dev/null; then
  echo "📦 Installing GitHub CLI..."
  if command -v brew &>/dev/null; then
    brew install gh
  else
    echo "❌ Please install Homebrew first: https://brew.sh"
    echo "   Then re-run this script."
    exit 1
  fi
fi

if ! command -v vercel &>/dev/null; then
  echo "📦 Installing Vercel CLI (needs sudo)..."
  sudo npm install -g vercel
fi

# ── GitHub auth ──
if ! gh auth status &>/dev/null 2>&1; then
  echo "🔑 Logging into GitHub..."
  gh auth login
fi

# ── Init git & push ──
cd "$(dirname "$0")"
echo "📁 Working in: $(pwd)"

if [ ! -d .git ]; then
  git init
  git add -A
  git commit -m "Initial commit: RWA perpetual futures dashboard"
fi

REPO_NAME="rwa-dashboard"
echo "📤 Creating GitHub repo: $REPO_NAME ..."
gh repo create "$REPO_NAME" --public --source=. --push 2>/dev/null || {
  echo "ℹ️  Repo may already exist, trying to push..."
  git remote get-url origin &>/dev/null || gh repo create "$REPO_NAME" --public --source=.
  git push -u origin main 2>/dev/null || git push -u origin master
}

echo ""
echo "✅ GitHub repo ready!"
echo ""

# ── Deploy to Vercel ──
echo "🌐 Deploying to Vercel..."
vercel --yes --prod

echo ""
echo "===================================="
echo "🎉 Done! Your dashboard is live."
echo "===================================="

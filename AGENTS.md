# Production release rules

- Start every change from an up-to-date `origin/main`. Health-check work is not an exception.
- Never run `vercel --prod` or `vercel deploy --prod` from a local worktree. Production is released by the Vercel Git integration from `main`, or by promoting a previously verified deployment whose provenance check reports `main` and the intended full commit SHA.
- Do not promote a dirty, detached, stale, or non-`main` source tree. If production is wrong, first promote the last verified `main` deployment, then repair forward from current `main`.
- Before a production-capable change, run `npm ci`, `npm test`, `npm run check:inline`, `npm run verify:deploy-source` with the intended Vercel metadata, and `git diff --check`.
- Treat Health Check and scheduled review code as read-only diagnostics unless a separately reviewed repair path is explicitly invoked. A diagnosis must include a stable remediation code and bounded operator actions; it must never silently mutate production data or aliases.

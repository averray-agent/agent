# Agent Collaboration Rules

This repository is worked on by multiple autonomous agents. Optimize for small,
reviewable changes and keep production deploys serialized.

## Branching

- Do not push directly to `main`.
- Create one branch per task, for example `agent/github-pr-verifier` or
  `agent/runs-ui-polish`.
- Keep PRs narrow. Split unrelated backend, frontend, contract, and docs work.
- Rebase or merge `origin/main` before marking a PR ready if other agents landed
  nearby changes.

## Generated Files

- Source changes live in `app/`, `mcp-server/`, `indexer/`, `contracts/`,
  `marketing/`, `sdk/`, `docs/`, and `scripts/`.
- Do not commit regenerated `frontend/` or `site/` output for normal app or
  marketing changes. CI builds those exports from source, and production deploy
  rebuilds them on the VPS before serving.
- Do not manually edit generated `_next/static` or `_astro` files.
- Only touch generated static output when a task explicitly changes the static
  deploy surface itself.

## Required Checks

Run the smallest relevant set locally before opening a PR:

- Backend: `npm --workspace mcp-server test`
- Operator app: `npm run typecheck:app` and `npm run build:frontend`
- Public site: `npm run build:site`
- Indexer: `npm run typecheck:indexer`
- Contracts: `forge test`

CI is the merge gate. Do not bypass failing checks.

## Deployment

- Agents do not SSH into production unless explicitly asked.
- Merging to `main` triggers the production deploy workflow after CI passes.
- Production deploys are serialized by GitHub Actions concurrency and a VPS
  `flock` lock.
- The deploy workflow runs `/srv/agent-stack/app/scripts/ops/deploy-production.sh`.
- Component deploy scripts own health checks and rollback:
  - `scripts/ops/redeploy-backend.sh`
  - `scripts/ops/redeploy-indexer.sh`
  - `scripts/ops/redeploy-frontend.sh`

## Production Safety

- Never commit secrets, private keys, JWTs, basic-auth passwords, or provider
  API keys.
- Never run destructive Git commands on shared worktrees.
- If a deploy fails, report the failing command and relevant logs; do not keep
  retrying blindly.
- Contract changes require an explicit contract deployment plan. A normal
  production deploy does not deploy smart contracts.

## PR Notes

Every PR should include:

- What changed.
- Which checks were run.
- Whether the change affects backend, frontend, indexer, Caddy, contracts, or
  public site.
- Any required environment or VPS secret changes.

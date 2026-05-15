# Agent Collaboration Rules

This repository is worked on by multiple autonomous agents. Optimize for small,
reviewable changes and keep production deploys serialized.

## Branching

- Do not push directly to `main`.
- Start each task in its own worktree from fresh `origin/main` by running
  `./scripts/ops/start-agent-worktree.sh codex/<task-name>` or
  `./scripts/ops/start-agent-worktree.sh claude/<task-name>` from the repository
  root. The helper fetches `origin/main`, creates the task branch, and prints
  the worktree path to use.
- Create one branch per task, for example `codex/github-pr-verifier` or
  `codex/runs-ui-polish`.
- Keep the primary checkout on `main` for repo sync and branch creation. Agents
  should do implementation work in task worktrees, not in the primary checkout.
- Keep PRs narrow. Split unrelated backend, frontend, contract, and docs work.
- Rebase or merge `origin/main` before marking a PR ready if other agents landed
  nearby changes.
- After your PR merges, run
  `./scripts/ops/finish-agent-worktree.sh <branch>` from the repository root to
  remove the merged task worktree, delete the merged branch, and sync local
  `main`.
- To sync local `main` without changing task branches, run
  `./scripts/ops/sync-local-main.sh`. GitHub cannot update local Macs after a
  deployment, so this helper is the local follow-up step.
- On macOS, developers can install a login/background watcher with
  `./scripts/ops/install-macos-production-sync-launchd.sh`. It polls the
  production deploy workflow and runs `sync-local-main.sh` after successful
  deploys, without touching active task branches.

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

## Hermes PR Handoff

- After PR CI passes, `.github/workflows/hermes-pr-handoff.yml` asks the
  Averray/Hermes operator to review the PR and run the configured testbed check
  set. Treat that workflow as the automated review and test handoff between
  code agents and the operator agent.
- For the full operator-report inventory (which Hermes routines this repo
  surfaces, where each one's evidence lands, and the correlation-id format
  to quote during an audit), see
  [docs/HERMES_OPERATOR_REPORTS.md](./docs/HERMES_OPERATOR_REPORTS.md).
- The handoff currently invokes Hermes with `averray_invoke_agent_task`,
  `intent='pr_handoff'`, the PR repository/number, and `TBE2E-004` as the
  default safe dry-run testbed case. Hermes checks PR metadata, GitHub checks,
  changed-file risk signals, changed files/diff context, CI coverage against
  touched areas, and requested testbed cases, then reports its code-review
  verdict and merge recommendation in the GitHub Actions summary.
- Hermes should flag blocking findings, non-blocking findings, missing tests,
  and higher-risk areas such as deploy workflows, auth, secrets,
  payments/settlement, indexer, contracts, Caddy, database migrations, and
  external agent hooks. If it cannot inspect the diff, treat the handoff as
  needing human review.
- If a PR needs a specific Hermes test, mention the desired testbed case in the
  PR notes so the next agent/operator can route it explicitly through
  `averray_invoke_agent_task`.
- Hermes PR handoff is recommendation-only. It does not merge, approve, or
  otherwise mutate GitHub. The workflow may best-effort post a summary comment,
  but comment permission failures must not hide the Hermes verdict in the
  GitHub Actions summary. CI remains the merge gate, and a human or explicitly
  authorized merge workflow still owns the final merge.

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

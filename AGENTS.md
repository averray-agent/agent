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
- The generated-output guard rejects commits or PR ranges that modify
  `frontend/` or `site/`. If a task intentionally changes those deploy
  surfaces, use `ALLOW_GENERATED_EDIT=1` locally and include `[allow-generated]`
  in the commit message so CI has an auditable bypass.

## Required Checks

Run the smallest relevant set locally before opening a PR:

- Backend: `npm --workspace mcp-server test`
- Operator app: `npm run typecheck:app` and `npm run build:frontend`
- Public site: `npm run build:site`
- Indexer: `npm run typecheck:indexer`
- Contracts: `forge test`

CI is the merge gate. Do not bypass failing checks.

## Roadmap Coordination

- `docs/PROJECT_ROADMAP.md` is the canonical project roadmap and status file.
- Parallel agents should avoid broad rewrites of the roadmap. Keep roadmap edits
  scoped to the exact item or section owned by the PR.
- If another active PR is already editing the same roadmap section, or if the
  update is a handoff/status note rather than the implementing PR itself, add a
  fragment under `docs/roadmap-updates/` instead of editing the canonical file.
- Use the template and rules in
  [docs/roadmap-updates/README.md](./docs/roadmap-updates/README.md).
- Do not mark roadmap work `Done` or `Proofed` without evidence. At minimum,
  include the merged PR, passing CI/checks, and hosted/chain/operator proof when
  the item changes deployed behavior.
- Chain-specific roadmap claims must cite Polkadot docs MCP findings, runtime
  state, or transaction evidence before being promoted into the roadmap.

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

## Hermes tester (request a browser-agent run)

- A building agent here can ask the Hermes **browser tester** to run a mission
  against the product (e.g. "can a fresh outside agent reach the first
  receipt?") and read the report back. You are a **requester, never a runner**.
- The contract is **Discover → Request → (operator) Approve → Run → Report**:
  1. **Discover** `GET /monitor/tester/capabilities` — the self-describing
     manifest; the per-flow `status` tells you what is actually runnable now.
  2. **Request** `POST /monitor/testbed-missions/request` with
     `requesterAgent` + `reason` (+ `targetUrl`, `goal`, `mode`) — this parks a
     board-gated `requested` card; it does **not** run.
  3. **Approve** — the operator approves on the Hermes board (or a trust policy).
  4. **Run** — the Hermes testbed runner claims + runs it.
  5. **Report** `GET /monitor/testbed-missions/:id` — read the structured report
     back (poll by id).
- Use the thin helper at
  [examples/request-tester-run](./examples/request-tester-run/)
  (`discoverTesterCapabilities`, `requestTesterRun`, `readTesterReport`). It is
  **request-only, operator-gated, and read-only by default** — it sends no
  run/approve/mutation field, and the server forces the mission to `requested` +
  read-only and keeps mutation testnet-only. Do not add a "run" or "approve"
  path here; that authority stays with the operator.

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

## Supply-Chain Hygiene

- The CI job `AI-instruction integrity (zero-width Unicode lint)` rejects PRs
  that introduce zero-width Unicode codepoints (U+200B, U+200C, U+200D, U+2060,
  or mid-file U+FEFF) into `AGENTS.md`, `docs/*.md`, or any tracked
  `CLAUDE.md` / `.cursorrules` file. This is a defense against the
  TrapDoor-class persistence vector documented by Socket on 2026-05-24
  ([advisory](https://socket.dev/blog/trapdoor-crypto-stealer-npm-pypi-crates)):
  a compromised npm/PyPI/Crates dependency installs a hook that grafts
  hidden instructions into an AI assistant's config file using invisible
  characters that pass code review.
- The lint also runs as a `npm run test:ops` test, so a regression is caught
  locally before push.
- This repo additionally relies on the Socket Security GitHub App for
  PR-level malicious-dependency detection. The App posts a check status on
  PRs that touch `package-lock.json`, `requirements*.txt`, or `Cargo.lock`;
  do not bypass that check without an explicit security review.
- Adding a new third-party dependency (npm, PyPI, or Cargo) requires PR
  notes that include the upstream repo URL, weekly download count, last-
  publish date, and one sentence on what the dep does. This applies to
  any new entry in any workspace's `package.json` `dependencies` /
  `devDependencies`, or any new Cargo crate.
- The operator app has zero `postinstall` lifecycle scripts. Adding one
  requires an explicit security justification in the PR body.

## GitHub Credential Safety

- Prefer the GitHub connector/plugin for GitHub operations such as PR,
  issue, check, workflow, and repository reads or writes. Use `gh` only when
  the connector cannot perform the action or when a local git/GitHub CLI
  workflow is explicitly required.
- Never run `gh auth token`, never print or request a GitHub token, and never
  paste a token into the shell, a PR, an issue, a log, or an agent transcript.
  Treat the local GitHub CLI session as a sensitive credential even when the
  token is stored in the macOS Keychain instead of plaintext `hosts.yml`.
- Keep `gh` commands non-secret and narrow. Do not pass tokens on the command
  line or through environment variables, and do not ask another agent to do so.
- Do not run untrusted dependency scripts, generated setup scripts, or random
  repository automation while a broad-scope human `gh` session is available to
  that same local user. Local processes can often act through the authenticated
  CLI session even without reading the raw token.
- Agent workstations should use the lowest-privilege GitHub account or token
  practical for the task, and broad scopes such as `admin:org`, `workflow`, or
  full `repo` should be revoked or rotated when they are no longer needed.
- VPS, CI, and production automation must not rely on a human `gh auth login`.
  Use GitHub Actions `GITHUB_TOKEN`, GitHub App credentials, or approved
  1Password-backed service credentials instead.

## PR Notes

Every PR should include:

- What changed.
- Which checks were run.
- Whether the change affects backend, frontend, indexer, Caddy, contracts, or
  public site.
- Any required environment or VPS secret changes.

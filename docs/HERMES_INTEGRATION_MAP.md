# Hermes Orchestration — Confirmed Integration Map (Phase 0)

- **Status:** Phase 0 discovery output for [`docs/HERMES_MULTI_AGENT_ORCHESTRATION_PLAN.md`](./HERMES_MULTI_AGENT_ORCHESTRATION_PLAN.md). **Confirmed from source**, not assumed.
- **Date:** 2026-05-29
- **Source read:** `depre-dev/averray-reference-agent` @ `main` (public; shallow-cloned and read directly). All `path:line` citations below are in **that** repo unless prefixed `[this repo]`.
- **Confirms or corrects** the six `[assumed]` items in §6 of the plan. Where reality differs from the plan's assumption, it's flagged **⚠ REFINEMENT**.

> Note: paths like `monitor-memory-aware-narration/packages/...` that appeared in an earlier draft do **not** exist. The real layout is `packages/` + `services/` + `ops/` + `hermes/`. Use the paths in this doc.

---

## Repo shape (reference-agent)

```
packages/
  averray-mcp/      ← the main MCP server Hermes calls (tools + invoke_agent_task + operator commands)
  policy-mcp/  receipt-mcp/  trace-mcp/  wallet-mcp/   ← the other 4 MCP servers
  monitor-ui/       ← the redesigned board SPA (MonitorPage.tsx, card-types, lane-rules)
  mcp-common/  schemas/
services/
  slack-operator/   ← serves the live /monitor board, the Codex task queue + runner, testbed mission runner
  skills-observer/  ← sidecar ingesting Hermes skill files
ops/                ← Docker compose stack (base, prod, command-center, cloudflare-access)
hermes/             ← Hermes config (hermes.yaml, policy.yaml) + trace plugin
```

---

## Q1 — How is `agentType` set today? Why is every card `ext`? ✅ CONFIRMED

`agentType` is derived by `inferAgentType()` in `services/slack-operator/src/monitor-v2.ts:208` from the classifier's **`owner` string**, not from the PR branch:

```ts
export function inferAgentType(item, type): AgentType {
  const owner = (item.owner ?? "").toLowerCase();
  if (type === "mission") return "hermes";
  if (owner.includes("codex"))  return "codex";
  if (owner.includes("hermes")) return "hermes";
  if (owner.includes("claude")) return "claude";
  return "ext";                          // ← default
}
```

The board's `owner` field is set to things like `operator`, `PR author`, `merge steward`, `history` (see `mapOwnerToWaitingOn`, `monitor-v2.ts:222`) — **never `codex`/`claude`** for ordinary external PRs. So they all fall through to `ext`. The `AgentType` union is `"claude" | "codex" | "hermes" | "ext"` (`packages/monitor-ui/src/lib/monitor/card-types.ts:24`).

**⚠ REFINEMENT to plan P1.** The plan assumed "map branch prefix → agentType." But `monitor-v2.ts:321` explicitly notes **the slim board model does not carry the head branch** (`// branch not in slim model`). The raw GitHub snapshot *does* have it — `operator-github.ts:1432` attaches `headBranch` from `pull.head.ref` — but it's dropped before `toBoardCard`. So **P1 is two small steps, not one**:
1. Thread `headBranch` through the slim classified card into `toBoardCard`.
2. In `inferAgentType`, prefer the branch prefix (`codex/*`→codex, `claude/*`→claude) and fall back to the owner-string logic.

---

## Q2 — Codex task queue + runner: schema, storage, lifecycle, executor ✅ CONFIRMED

**Queue** — `services/slack-operator/src/codex-task-queue.ts`. JSON-file backed (`readFile`/`writeFile`), path from `AVERRAY_CODEX_TASKS_PATH` (fallback `/tmp/averray-reference-agent/codex-tasks.json`, `:435`).

- `CodexTask` shape (`:37`): `{ schemaVersion:1, kind:"codex_task", id, repo, pullRequestNumber, correlationId?, title?, prompt, reason?, requester?, status, createdAt, updatedAt, approvedAt?/By?, cancelledAt?/By?, startedAt?, runnerId?, attemptCount?, completedAt?, completionSummary?, failedAt?, failureReason?, exitCode?, stdoutTail?, stderrTail?, progressMessage?, progressAt?, events?[] }`.
- **State machine** (`:4`): `proposed → approved → running → completed | failed | cancelled`.
- **Heartbeat** `CodexRunnerHeartbeat` (`:63`): `{ runnerId, status: idle|running|completed|failed|disabled|misconfigured|error, message, updatedAt, activeTaskId? }`.

**Enqueue path** — via the **slack-operator HTTP API**, not an MCP tool: `POST /monitor/codex-tasks` (`services/slack-operator/src/index.ts:389`) → `proposeCodexTask` (`:1107`); approval → `approveCodexTask(id, { approvedBy: "operator" })` (`:1132`). This is the board's `CREATE / APPROVE TASK` lane.

**Runner** — `services/slack-operator/src/codex-task-runner.ts`. `runCodexTaskRunnerForever` polls (`CODEX_TASK_RUNNER_POLL_INTERVAL_MS`, default **10s**) → `claimNextApprovedCodexTask` → run executor → `completeCodexTask`/`failCodexTask` + heartbeat. Timeout `CODEX_TASK_RUNNER_TIMEOUT_MS` default **30 min** (SIGTERM→SIGKILL). Output is **secret-sanitized** before storage (`:316` — strips private keys, JWTs, GitHub tokens, `sk-` keys).

**⚠ KEY FINDING — the runner is command-agnostic.** `executeCodexTaskCommand` (`:159`) just `spawn`s `CODEX_TASK_RUNNER_COMMAND` with templated args (`{prompt}`, `{repo}`, `{pr}`, …) and passes `CODEX_TASK_*` env (incl. `CODEX_TASK_PROMPT`). It is "Codex" only by env config. The actual Codex behavior lives in `codex-branch-worker.ts`, which: defaults its CLI to `codex` (`:95`), **refuses protected branches** (`:123`), and **checks out the PR's existing head branch** to work on it (`:192`).

**⚠ REFINEMENT to plan P2.** Two consequences:
- The current model is **PR-centric**: a task is bound to an existing `pullRequestNumber` and the worker iterates on that PR's branch. It is *not* a greenfield "build feature X from scratch → open new PR" flow. A Claude worker either (a) follows the same iterate-on-PR model, or (b) the schema/worker are extended to support originating a branch+PR.
- A Claude runner can reuse the **same queue + runner harness**; the cleanest path is to (1) generalize the queue from `codex_task` to an agent-tagged task (add an `agent: "codex" | "claude"` field), and (2) add a `claude-branch-worker` mirroring `codex-branch-worker` with `claude -p`/Agent-SDK as the command. The poll/claim/heartbeat/timeout/sanitize machinery is already done.

---

## Q3 — Is `claude` wired beyond the card-type union? ✅ CONFIRMED (recognized, not executed)

- **Recognized:** `AgentType` union (`card-types.ts:24`); `inferAgentType` maps owner `claude`→claude (`monitor-v2.ts:213`); `AGENT_TYPES` allowlist incl. claude (`monitor-v2-debug.ts:42`); debug endpoint defaults to `claude` (`:96`); fixtures use `claude` cards (`monitor-ui/.../fixtures.ts`).
- **NOT executed:** there is **no Claude runner or worker**. Only `codex-task-runner.ts` + `codex-branch-worker.ts` exist. Collaboration authors are `codex | hermes | operator | system` only (`monitor-ui/.../collaboration.ts:10`) — **claude is not a collaboration author**, so Hermes↔Claude board chatter has no type yet.

This matches the plan: Claude is modeled but is the missing worker. **Confirmed: P2 (Claude runner) is the real net-new build.**

---

## Q4 — Policy / mutation guardrails: what governs what? ✅ CONFIRMED (and they do NOT cover dispatch)

Two existing guardrail layers, **both about job/mission execution, neither about code dispatch**:

1. **Marketplace claim/submit policy** — `packages/averray-mcp/src/mutation-policy.ts`. Governs the Wikipedia citation-repair *job* mutations (`averray_claim`/`averray_submit`): requires a `runId`, caps attempts (`maxClaimAttempts`/`maxSubmitAttempts`, default 1), enforces job/session allowlists, optional fail-open, backed by a Postgres `submissions` table. Pure economic/idempotency safety for marketplace work.
2. **Agent budget policy** — `hermes/config/policy.yaml`: `claim.allowed_task_types: [citation_repair, freshness_check]`, `submit.require_approval_if_confidence_lt: 0.7`, `budget.per_run_usd_max: 0.5`, `per_day_usd_max: 1.0`, `max_browser_steps: 80`.
3. **Global kill switch** — `HALT_FILE` env + `assertNoKillSwitch()` (`averray-mcp/src/index.ts:409`) blocks mutating tools when a halt file exists.

**⚠ KEY FINDING for plan §7 (authority).** There is **no policy layer over code dispatch**. Proposing/approving a Codex task is gated only by (a) the slack-operator HTTP endpoint's auth and (b) `approveCodexTask` requiring `approvedBy: "operator"`. So a future *Hermes-driven* dispatch capability (Rung B/C) **cannot reuse `mutation-policy.ts`** — it needs a **new guardrail** (e.g. an allowlist of repos/intents Hermes may enqueue, a per-day task budget, and keeping the human `approved` gate). This is the security boundary to design before P4.

---

## Q5 — Full MCP tool surface + `invoke_agent_task` intents ✅ CONFIRMED

`averray_*` tools registered in `packages/averray-mcp/src/index.ts` (selected): `list_jobs`, `get_definition`, `operator_status`, `daily_operator_brief`, `find_safe_work`, `agent_usefulness_plan`, `project_memory`, `project_runbook`, `admin_readiness`, `admin_action_proposal`, `ops_health`, `github_status`, `github_brief`, `approve_github_merge_steward_candidate`, `testbed_agent_mission`, `testbed_e2e_suite`, `run_testbed_e2e_read_only`, `handoff_monitor`, **`invoke_agent_task`** (`:328`), **`handle_operator_command`** (`:358`), `run_wikipedia_citation_repair`, `claim`, `save_draft_submission`, …

`AgentInvocationIntent` (`packages/averray-mcp/src/agent-invocation.ts:24`):
```
operator_command | testbed_e2e_read_only | testbed_suite | testbed_case
| pr_code_review | pr_handoff | post_deploy_verification
```

**⚠ KEY FINDING.** There is **no dispatch/enqueue intent** — `invoke_agent_task` only reviews and tests. Today Hermes literally **cannot enqueue a worker task through MCP**; tasks enter only via the monitor HTTP endpoint (Q2). So Rung B/C requires either a **new intent** (e.g. `enqueue_agent_task`) or a Hermes path to the `POST /monitor/codex-tasks` endpoint — gated by the new guardrail from Q4.

---

## Q6 — Monitor deployment: standalone or in the operator app? ✅ CONFIRMED

The **Averray Handoff Monitor board** (the screenshot) is served by the **`slack-operator` service** at `/monitor/*` (`services/slack-operator/src/monitor.ts`, `monitor-spa.ts`, `monitor-v2.ts`), rendering the `packages/monitor-ui` SPA. Public exposure is via Cloudflare Access (`ops/compose.cloudflare-access.yml`). The Direction-A redesign is implemented **in this same `packages/monitor-ui`** per `docs/HERMES_MONITOR_REDESIGN_SPEC.md` (which also lives in this repo's `docs/`).

Separately there is an **optional "command center" overlay** (`ops/compose.command-center.yml`, `--profile command-center`, runbook `docs/COMMAND_CENTER.md`) that adds:
- **`hermes-gateway`** — a Hermes process exposing an **HTTP API on `:8642`** (`API_SERVER_ENABLED`, `API_SERVER_KEY`).
- **`hermes-workspace`** — the Hermes Workspace UI on `:3000` (`ghcr.io/outsourc-e/hermes-workspace`).
- The built-in **Hermes dashboard on `:9119`**.

**⚠ KEY FINDING for orchestration entry points.** There are **two ways to drive Hermes**, not one:
1. The **SSH + `hermes chat -q "<prompt>"`** path used by `[this repo]`'s GitHub workflows (one-shot, prompt-driven).
2. The **Hermes gateway HTTP API on `:8642`** (command-center overlay) — a programmatic, session-capable entry point better suited to an orchestration loop than shelling `hermes chat`.

---

## Net effect on the plan (what Phase 0 changes)

| Plan item | Confirmed reality | Action |
|---|---|---|
| **P1 attribution** | Branch is dropped before the board model; agentType comes from `owner` string. | Thread `headBranch` into the slim card, then prefer branch-prefix in `inferAgentType`. Slightly bigger than "one mapping," still small. |
| **P2 Claude runner** | Runner harness is command-agnostic and reusable; only `codex-branch-worker` is Codex-specific; tasks are PR-centric. | Generalize queue (`agent` field) + add `claude-branch-worker`. Decide PR-centric vs greenfield. |
| **P3 dispatch** | Enqueue is an HTTP endpoint (`POST /monitor/codex-tasks`), human-approved; no MCP enqueue intent. | Add Claude path to the endpoint + a co-pilot verb; keep human `approved` gate. |
| **P4 routing** | Hermes has no enqueue capability and no dispatch policy. | Add `enqueue_agent_task` intent (or gateway call) **plus** a new dispatch guardrail (Q4). |
| **§7 authority** | `mutation-policy.ts` covers marketplace/missions only. | Design a **separate** dispatch guardrail; do not reuse the marketplace policy. |
| **Entry point** | Gateway API on `:8642` exists. | Prefer the gateway API over SSH `hermes chat` for the Rung-C loop. |

**Bottom line:** the plan holds. The cheapest first PR (P1 attribution) is confirmed small. The Claude runner (P2) is real but rides on existing, command-agnostic plumbing. The one genuinely new design surface for autonomy is a **dispatch guardrail + an enqueue capability for Hermes** — neither exists today, and that is the security-relevant decision to make before Rung C.

---

*End of integration map. Confirmed from `depre-dev/averray-reference-agent` @ main on 2026-05-29.*

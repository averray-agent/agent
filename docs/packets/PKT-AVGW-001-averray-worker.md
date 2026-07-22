# PKT-AVGW-001 — Averray demand-side worker: `averray-worker` profile + bounty→TaskIntent adapter

**DIRECTIVE:** Implement this in the Averray **platform** repo. Build it, run the gates in §9, and write a handback (`docs/packets/PKT-AVGW-001-HANDBACK.md`). This is a build work order, not a design to review or summarize — produce the code.

**Project:** Averray platform (`averray-agent/agent`, Node/TS/JS ESM). **Where you are working:** a NEW top-level `worker/` directory in this repo. **Not** the harness kernel.
**The harness** is a separate sibling repo at `~/repo/agent-harness` (GH `averray-agent/agent-harness`, private, Python/`uv`). You drive it **only through its `harness` CLI** as a black box — never import kernel internals, never modify that repo. Its architecture spec (`~/repo/agent-harness/docs/ARCHITECTURE.md`, "ARCH") is authoritative for every harness-facing shape.
**Phase mapping:** ships Track A of the Agent-Harness umbrella (Phase 5 is closed; this is the demand-side worker on top of it). Money rail untouched.

**Precedence:** where this packet cites a harness or platform shape, that shape was VERIFIED against live code on 2026-07-21 (contracts, CLI output, a live scripted run) — treat the citations as ground truth, but if the code has since changed, the code wins and you flag it in the handback.

---

## 0. Non-negotiable boundaries — do not cross

1. **The worker never touches the money rail.** No wallet, private key, signer, KMS, escrow, claim-stake, or payout — in the profile's capabilities, in the adapter, or in any env you read. SIWE authentication, `POST /jobs/claim`, `POST /jobs/submit`, and opening a GitHub PR are **OUT OF SCOPE seams** (§8). The worker's job ends at a *verified submission object*; a separate gated service performs the money-rail steps.
2. **Kernel stays clone-clean.** No edits to `~/repo/agent-harness`. Nothing Averray-specific is committed there (its `hygiene_check` enforces this). The `averray-worker` profile lives in `worker/profiles/` and is loaded by the harness at runtime via `HARNESS_PROFILES_ROOT` — never copied into the kernel.
3. **Testnet only** (Polkadot Hub TestNet, `chainId 420420417`). Mainnet is a separate operations track.
4. **Do not touch `averray-reference-agent/`.** That is a separate, Codex-owned, **Hermes-based** consumer agent that holds a testnet wallet through its own gated MCP path. Different runtime, different lane. This worker is the Agent-Harness-based work engine; it is independent.
5. **Router stays `direct_execution`.** Do not enable or force `plan_execute` (it needs a schema-strict planner model; a coding model over a loose OpenAI-compatible endpoint fails plan validation).

---

## 1. Outcome

When this packet is done, `worker/` is a self-contained, dependency-free ESM module in the platform repo with:

1. The **`averray-worker` profile** (`worker/profiles/averray-worker/profile.yaml`) — Docker provider, deny egress, `direct_execution` — that loads against the harness's real `ProfileSpec` and drives a real run.
2. A **pure `mapJobToTaskIntent(job, options)`** that turns an Averray job definition into a harness `TaskIntent` object which passes `harness validate`, and **honestly flags** jobs it cannot deterministically verify (never fabricates an LLM rubric).
3. A **`HarnessDriver`** that drives the `harness` CLI (submit → wait-for-terminal → deliverables → artifacts get) with no kernel imports.
4. A **submission assembler** that turns the verified deliverable into the Averray `github-pr-evidence-output` object, and **refuses** to assemble one for work that did not verify.
5. **Tests green** via `node --test`; a generated intent passes `harness validate`; a **scripted dry-run** of the `averray-worker` profile reaches `outcome=completed`.

---

## 2. D1 — the `averray-worker` profile

`worker/profiles/averray-worker/profile.yaml`. It must load against the harness `ProfileSpec` (`agent_runtime.profiles.load_profile`, `model_config = extra="forbid"`). Author it as below (this exact content was verified to load):

```yaml
name: averray-worker
version: "1"
# Isolation is mandatory: public bounty jobs are adversarial input. The image
# must already exist locally (providers never pull); override with HARNESS_ENV_IMAGE.
# The docker provider runs every container --network none, making `network: deny` real.
environment: {provider: docker, image: averray-worker-sandbox:latest}
egress: {mode: deny_all, allowed_destinations: []}
# Executor model resolved from env at run time (HARNESS_MODEL_BASE_URL /
# HARNESS_MODEL_REF / HARNESS_MODEL_API_KEY). NEVER commit a key.
model:
  executor: {adapter: openai-compatible, model_ref: null}
capabilities:
  - fs.read_file
  - fs.write_file
  - fs.list_files
  - shell.run
  - git.status
  - git.diff
  - artifact.put
  - artifact.get
verification:
  baseline_command: null      # the adapter sets the per-job command via the intent
  protected_paths: []
strategies: [direct_execution]
retention_policy: standard
memory: {retrieval_budget_tokens: 1024}
```

**VERIFIED facts you rely on:**
- `HARNESS_PROFILES_ROOT` (default `./profiles`) is where the harness resolves profiles; point it at `worker/profiles`. The env var overrides the default at call time.
- Environment precedence: `HARNESS_ENV_PROVIDER`/`HARNESS_ENV_IMAGE` override the profile's `environment` block; docker requires a non-empty image from one of the two.
- `egress: deny_all` must carry an empty `allowed_destinations`.
- **No** `memory.*` capabilities (no learning writes), **no** network/http capability, **no** signer/wallet capability — by boundary §0.1.

**DECISION:** capabilities are the string form (not `{id, delegable}`) — the worker delegates nothing.

---

## 3. D2 — `mapJobToTaskIntent(job, options)` (the adapter core)

A **pure** function (no I/O, no network, no wallet): `(job, options) -> { intent, warnings }`.

**Input** = an Averray job definition as returned by `GET /jobs/definition?jobId=` (see Appendix A). Fields you read: `id`, `title`, `description`, `agentInstructions[]`, `acceptanceCriteria[]`, `source{type,repo,issueNumber,issueUrl,body}`, `verification.suggestedCheck`.

**Output** = a harness `TaskIntent` object. **VERIFIED contract** (`agent_runtime.contracts.task`, all models `extra="forbid"`):

- `apiVersion: "harness/v1alpha1"`, `kind: "TaskIntent"`.
- `metadata.id` MUST match `^[a-z0-9-]+$`, non-empty (slugify the job id; ≤120 chars). `metadata.labels: dict[str,str]` — carry provenance (`averray_job_id`, `source_type`, `repo`, `issue_number` as a string).
- `spec.profile = "averray-worker"`.
- `spec.objective` (non-empty): compose from `title` + `description`/`source.body` + `agentInstructions` + `acceptanceCriteria`, and **state explicitly that the sandbox has no network and must not open a PR / fetch URLs / submit** (a separate step publishes the patch).
- `spec.deliverables` (min 1): `[{type: workspace_patch}, {type: verification_report}, {type: change_summary}]`.
- `spec.context.workspace = {path: <options.workspacePath>, revision: "HEAD"}`. **The workspace is an already-prepared LOCAL checkout** — cloning is a networked read the caller does BEFORE the run, never inside the no-network sandbox. `workspacePath` is required; throw if absent.
- `spec.constraints = {allowed_paths: [], forbidden_paths: [], network: "deny"}`. **VERIFIED:** empty `allowed_paths` means *unrestricted within the workspace* (writes still bounded by workspace root, `forbidden_paths`, and protected verifier assets) — correct for an open-ended issue.
- `spec.acceptance` — **discriminated union on `type`**. Derive DETERMINISTIC checks from a verify command (`options.verifyCommand ?? job.verification.suggestedCheck`):
  - with a command: `[{id:"job-checks", type:"command", command:<cmd>, required:true}, {id:"no-regressions", type:"baseline_comparison", rule:"no_new_failures", baseline_command:<cmd>, required:true}]`.
  - **without a command: emit `acceptance: []` AND push a warning** that the deliverable is not deterministically gated / not eligible for automated submission. **Do NOT fabricate a rubric** (ARCH §4: flag unverifiable criteria, never silently convert to an LLM rubric). The Averray `github_pr` verifier owns the submission-envelope checks (PR exists, references issue, disclosure) — those are NOT the harness's job.
- `spec.approvals = []`. **DECISION:** the sandbox grants no external-write capability and paths are unrestricted, so neither `before_external_publish` nor `change_outside_allowed_paths` can fire; the real approval gate is the downstream PR-open seam.
- `spec.budgets = {elapsed:"PT30M", model_tokens:2000000, tool_calls:400, max_children:1, max_concurrent_children:1}` (all positive; `elapsed` is ISO-8601 duration), overridable via `options.budgets`.
- `spec.learning = {episode_capture:true, memory_write:"none", skill_generation:"ineligible"}`.

Also provide `serializeIntent(intent)` returning a JSON string (**JSON is valid YAML** — the harness parses it; no YAML dependency needed).

`options`: `workspacePath` (required), `verifyCommand?`, `workingDirectory?`, `profile?` (default `averray-worker`), `revision?`, `allowedPaths?`, `forbiddenPaths?`, `budgets?`.

---

## 4. D3 — `HarnessDriver` (drive the harness CLI)

Drives the `harness` executable via `child_process` — **no kernel imports**. **VERIFIED CLI output shapes:**

- `harness run submit <intent.yaml|.json>` → prints the run id (single line).
- `harness run status <id>` → key=value lines: `run_id`, `state`, `attempt`, `outcome` (present only once terminal), `outcome_reason`, `egress_policy`, `created_at`, `updated_at`.
- `harness run deliverables <id>` → `"<deliverable_type> <artifact-uri>"` lines (only for a completed run).
- `harness artifacts get <artifact://…> [--out FILE]` → raw bytes.

**Terminal detection — VERIFIED gotcha:** a run races `completed → learning_queued → learning_processed`, so `state=completed` is transient. Treat a run as terminal when the **`outcome=` line is present** (`completed`/`partial`/`failed`), OR `state ∈ {quarantined, cancelled}` (which carry no outcome). Do **not** poll for `state=completed`.

Provide: `submit(path)`, `status(id)` (parsed record), `deliverables(id)` (`{type: uri}`), `artifactGet(uri, outPath?)`, `waitForOutcome(id, {timeoutMs, pollIntervalMs, signal})`, and `runToCompletion(path, waitOpts)` → `{runId, status, deliverables}`. Config: `harnessBin` (`$HARNESS_BIN` / "harness"), `databaseUrl` (`$HARNESS_DATABASE_URL`), `env` (extra env — model/provider/profiles-root; **never a wallet key**), `cwd`. Export the pure parsers (`parseStatusOutput`, `isTerminalStatus`, `parseDeliverablesOutput`) so they unit-test without a running harness.

---

## 5. D4 — submission assembler

Pure: turn the verified deliverable into the Averray **`github-pr-evidence-output`** submission object (Appendix A). **VERIFIED schema** — required: `prUrl`, `summary`, `tests` (all non-empty strings). Optional: `notes`, `issueNumber` (int ≥1), `issueUrl`, `commitUrl`, `branchUrl`, `filesChanged` (string[]), `referencesIssue` (bool), `checksPassing` (bool), `ciStatus` (`unknown|pending|passing|failing`), `reviewApproved` (bool), `merged` (bool).

`assembleGithubPrSubmission({ job, prUrl, verificationReport, changeSummary, patchText, notes, ciStatus })`:
- `prUrl` is **required** (it is produced by the out-of-scope PR-open seam and passed in) — throw if absent.
- **Refuse to assemble if `verificationReport.passed !== true`.** The worker never submits unverified work — a staking agent must not lie. This is a hard requirement, not a warning.
- `summary` ← `changeSummary` (fallback: `Resolve <repo> issue #<n>`); `tests` ← a truthful description of the deterministic checks that passed; `filesChanged` ← parsed from `patchText` (`diff --git a/… b/<file>`); `issueNumber`/`issueUrl`/`referencesIssue` ← from `job.source` (including the issue fields in the evidence is what makes `referencesIssue` truthful).
- **ERRATUM (gate finding F1, 2026-07-22 — supersedes the original wording that derived `checksPassing` "from the report"):** `checksPassing` and `ciStatus` are claims about the **PR's GitHub CI state**, which is unknown at assembly time — harness verification is NOT PR CI. Set them only from caller-supplied PR-CI knowledge: include `checksPassing: true` iff `ciStatus === "passing"`, omit it otherwise (mirror the `ciStatus` handling: omitted when not supplied, rejected when outside the schema enum). Never derive either from the harness report. The `github_pr` verifier scores `checksPassing` and, without `GITHUB_TOKEN`, trusts the submitted field — an assembler that hardcodes it asserts an unearned claim, which violates the truth boundary (§10.7).

**VERIFIED `verification_report` shape** (the artifact `run deliverables` yields): `{check_results: [...], passed: bool, verdict: str, required_failed: [...], optional_failed: [...], protected_violations: [...]}`.

Before the real (out-of-scope) submit, the object can be checked against `POST /jobs/validate-submission` (public, no auth) — note this as the pre-submit gate; do not wire the actual submit.

---

## 6. D5 — glue (thin)

- `emit-intent` CLI (`worker/bin/emit-intent.mjs`): read a job JSON (file/stdin), map it, print the intent; warnings → stderr; **exit 3** if the job is unverifiable so a caller never mistakes an ungated deliverable for a submittable one.
- `averray-client` (read-only): fetch a job via `GET /jobs/definition?jobId=` from `$AVERRAY_API_BASE_URL` (public, no auth, no wallet). **Read-only only** — no claim/submit here.

---

## 7. D6 — tests (tiered)

- **Unit** (`worker/**/*.test.js`, `node --test`, NO harness/network): slugify conforms to `^[a-z0-9-]+$`; mapping produces the verified structure; verify-command derivation (incl. `verification.suggestedCheck` fallback); **unverifiable job → empty acceptance + warning** (not a rubric); provenance labels; `serializeIntent` round-trips; driver parsers on canned CLI output; submission assembler incl. **refuse-when-not-passed** and `filesChanged` parsing.
- **Contract:** generate an intent from a sample GitHub-issue job and run `harness validate` on it → exit 0 (the harness echoes `profile=averray-worker acceptance=job-checks,no-regressions`).
- **Integration (scripted, deterministic — no key, no network):** run the `averray-worker` profile through the durable runtime to `outcome=completed` using the blueprint in Appendix B.

---

## 8. Out of scope — do NOT build

Money rail: SIWE auth (`/auth/nonce`,`/auth/verify`), `POST /jobs/claim`, `POST /jobs/submit`, any wallet/key/stake handling · opening a GitHub PR (external write, approval-gated, outside the sandbox) · a live testnet job · any change to `~/repo/agent-harness` · real model-key selection / a live-model smoke (operator-run) · `plan_execute` · `memory.*` writes / learning · registering `worker/` as an npm workspace member (keep it standalone, low-collision) · touching `averray-reference-agent/`.

---

## 9. Definition of done

Prerequisites (operator-provided): the harness repo at `~/repo/agent-harness` with its `.venv`, and Docker for a disposable Postgres. Then:

```
cd worker && npm test                                   # node --test, all green
node bin/emit-intent.mjs examples/<job>.json --workspace /tmp/x > /tmp/i.json
( cd ~/repo/agent-harness && .venv/bin/harness validate /tmp/i.json )   # exit 0
# scripted dry-run of the averray-worker profile → outcome=completed (Appendix B)
```

The integration run must show `outcome=completed` and `egress_policy=deny_all []` in `harness run status` (proving the profile's deny-egress froze into the run manifest), and `harness run deliverables` must yield a `verification_report` artifact. `worker/` contains no key, no wallet, no claim/submit call. Handback committed as `docs/packets/PKT-AVGW-001-HANDBACK.md`.

---

## 10. Working agreement for the implementer — read before starting

The handback goes through an independent gate (reproduced from a clean checkout). Beyond the code:

1. **Run the real gates before handing back** (§9) and paste their full output into the handback. An editor build or partial run is not the gate.
2. **Write the handback note** (`PKT-AVGW-001-HANDBACK.md`): what was built; every decision this packet doesn't cover, each with a one-line rationale; the gate output; open questions. A flagged deviation is a conversation; a discovered one is a rejection.
3. **No money rail, ever** — if a task seems to need a wallet/key/claim/submit, STOP and flag it; it belongs to the seam, not this packet.
4. **No kernel edits.** Drive the harness only via its CLI. If you think the kernel needs a change, flag it — do not make it here.
5. **No scope creep / no extras.** Dependency-free (Node built-ins + global `fetch`); Node ≥20; `node --test`; not a workspace member.
6. **Tests exercise the real thing.** Fixtures loaded from real files; the contract test runs the real `harness validate`; the integration test runs the real durable runtime (scripted model). No mocking the code under test.
7. **Truth boundary.** The worker must never look more "done" than it is: the submission assembler refuses unverified work; unverifiable jobs are flagged, not rubric-faked; the money-rail steps are visibly seams, not stubs pretending to work.
8. **Determinism & hygiene.** Dedicated Postgres for the dry-run (never share one DB between a test suite and a live run). Check `git status` before committing; no keys/wallets/secrets anywhere.

---

## Appendix A — Averray API contract (VERIFIED 2026-07-21, read-only surfaces only)

- **Discover (no auth):** `GET /jobs?source=github&state=open` (compact rows) and `GET /jobs/definition?jobId=<id>` (full: `acceptanceCriteria`, `agentInstructions`, `outputSchemaRef`, and explicit `submissionContract`/`verificationContract` blocks). Base URL from `$AVERRAY_API_BASE_URL`.
- **Validate a draft (no auth):** `POST /jobs/validate-submission` `{jobId, submission}`.
- **GitHub-issue job** (first target): `verifierMode:"github_pr"` (operator-triggered — NOT auto-verified), reward USDC, `outputSchemaRef:"schema://jobs/github-pr-evidence-output"`, `source:{type:"github_issue", repo, issueNumber, issueUrl, body}`, natural-language `acceptanceCriteria`/`agentInstructions`.
- **Money-rail seams (OUT OF SCOPE, for context only):** auth is SIWE → Bearer JWT (`/auth/nonce`→`/auth/verify`; a fresh wallet gets `roles:[]`, which is accepted for claim/submit); `POST /jobs/claim` (backend brokers the on-chain `claimJobFor`, pays gas; non-waived GitHub jobs lock ~0.06 USDC stake); `POST /jobs/submit {sessionId, submission}`; poll `GET /verifier/result?sessionId=` for `outcome:"approved"` + `payoutTx`.

## Appendix B — scripted dry-run blueprint (VERIFIED to complete)

Deterministic, no key, no network. Uses the harness's scripted test model + local provider.

1. Disposable Postgres on a **dedicated** free port (e.g. 5434 — 5433 may be taken): `docker run --rm -d --name <n> -p 5434:5432 -e POSTGRES_PASSWORD=harness -e POSTGRES_DB=postgres postgres:18`.
2. `HARNESS_DATABASE_URL=postgresql://postgres:harness@localhost:5434/postgres harness db migrate`.
3. Start the worker with a profiles root that contains `averray-worker` (symlink it beside `coding-change` if you also submit fixtures), and: `HARNESS_ENV_PROVIDER=local HARNESS_MODEL_REF=scripted-model HARNESS_MODEL_BASE_URL=http://localhost:11434/v1 HARNESS_TEST_MODEL_SCRIPT=~/repo/agent-harness/tests/fixtures/model_scripts/finish.jsonl harness worker`. Optionally add `HARNESS_ARTIFACT_ROOT=<tmp-dir>` (a real kernel env var, verified) to isolate the gate's artifact store into a disposable directory.
4. Submit an `averray-worker` intent with **empty acceptance** and `deliverables:[{type:verification_report}]`, workspace = `~/repo/agent-harness/tests/fixtures/environment_workspaces/basic` (a real local dir). Poll `run status` until the `outcome=` line appears; expect `outcome=completed`, `egress_policy=deny_all []`.

(The full worker's real intents request `workspace_patch`+`verification_report`+`change_summary` and a real `command` acceptance; those need a real model and a prepared repo — that is the operator-run live smoke, out of scope here.)

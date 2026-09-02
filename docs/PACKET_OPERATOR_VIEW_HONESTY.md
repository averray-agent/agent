# PACKET — The operator's view must not lie in either direction

**Repos.** Platform = `/Users/pascalkuriger/repo/Polkadot`, `origin/main` = `16428b5`. Board = `/Users/pascalkuriger/repo/averray-reference-agent`, `origin/main` = `24092de`. Every path below was read with `git show origin/main:<path>`. Do not read a worktree.

**Hard constraint.** No file under `contracts/` or `deployments/` may be touched by any PR in this packet. Codex's in-flight D-03 waiver PR owns `deployments/mainnet.json` and the contract manifest entries; these must land in parallel without conflict.

---

## 1. Why this packet

Tonight, 2026-08-11:

1. `#1070` (`2f5ffdc`, **live** in `d186095`) added a genuine money-correctness rule: a submitted session the auto-verifier keeps skipping across two 60s runs → `submitted_session_persistently_skipped` (`mcp-server/src/services/submitted-job-auto-verifier.js:145-154`, threshold `consecutiveRuns >= 2` at `:166-170`).
2. `#1057` had already folded that component into the liveness AND — `mcp-server/src/core/health-capability.js:149`: `ok: stateStoreOk && authOk && autoVerifierOk`.
3. `mcp-server/src/protocols/http/operational-routes.js:124` maps that single boolean to the HTTP code: `respond(response, serviceHealth.ok ? 200 : 503, { status: serviceHealth.ok ? "ok" : "degraded", ... })`.
4. `scripts/ops/flip-caddy-network.sh:39` does `public_health=$(curl -fsS "$PUBLIC_HEALTH_URL")` under `set -euo pipefail`. `curl -f` exits 22 on 503. `.github/workflows/deploy-production.yml` step *Resolve durable live network (fail-closed)* runs it as the first thing after SSH setup.

Two ephemeral worker-canary sessions tripped rule 1 permanently. **Every production deploy was blocked, including the deploy of the PR that fixes the rule.** The script only ever reads `.status` and `.chainId`; the `-f` was gratuitous. The signal was correct. The consumer read *not perfect* as *not serving*.

**The rule this establishes:**

> A signal about whether the product is **correct** must never be carried on the channel that says whether the process is **serving**. `serviceHealth.ok` → HTTP 503 answers exactly one question: "should traffic go here?" Every other truth — unpaid workers, stuck settlements, missing payout proof — belongs in the payload, on a channel whose consumers are correctness gates.

This is not closed. `#1077` (`16428b5`, **merged, not deployed**) widened the streak filter from `reason.startsWith("job_snapshot_")` to *every* skip entry carrying a `sessionId` (`submitted-job-auto-verifier.js:443-448`). `non_auto_mode` is pushed with a full `sessionDiagnostic` at `:243`, and `AUTO_DECIDABLE_MODES` is frozen to `["benchmark","deterministic"]` at `:33` — so `human_fallback` and `github_pr` sessions are skipped *by design*, every run, forever. **The first `human_fallback` or `github_pr` submission after the D-03 freeze clears re-creates tonight's total deploy deadlock, and the live board carries 4 `human_fallback` jobs.** The same is true of `dry_run` (`:260`) under `AUTO_VERIFY_DRY_RUN=1`.

The other two workstreams are the same failure shape, one repo over: an instrument whose reading is fine and whose consumer draws a false conclusion.

---

## 2. Scope

Three workstreams, **four PRs** (workstream B necessarily spans two repos; a cross-repo change cannot be one PR). Repo policy is one narrow PR per concern — do not combine them, do not stack them.

| # | Workstream | Repo | PR | Depends on |
|---|---|---|---|---|
| **A** | Health/deploy contract — stop a correctness fault from 503ing | platform | 1 | nothing |
| **B1** | `/health` publishes the payout-expected split | platform | 1 | nothing |
| **B2** | Board stops counting rejections as missing payouts | board | 1 | B1 *deployed* (degrades safely before that — see §4) |
| **C** | Display the HTTP arrivals series | board | 1 | nothing (#1071 is already **live** in `d186095`) |

Priority order: **A, then B1/B2, then C.** A is time-critical: it is armed and undeployed, and it is inside the fix for tonight's outage.

None of these touch `contracts/` or `deployments/`.

**Operator note, not Codex's problem:** nothing in this packet reaches production until the sticky D-03 contract-surface freeze clears (`/srv/agent-stack/.deploy-state/contract-surface.frozen-at.mainnet`, baseline `d186095`, refusing because `#1078` changed `contracts/EscrowCore.sol` source only). C is the exception — it is board-only and its data source is already deployed.

---

## 3. Workstream A — the health/deploy contract

### Option chosen: **remove `autoVerifierOk` from the `serviceHealth.ok` AND, bundled with an explicit replacement correctness gate.**

### Why not the two alternatives

**Rejected — "degraded returns 200 for all triggers."** `serviceHealth.ok` is a three-term AND and the terms are not alike. `stateStoreOk` (`health-capability.js:1717-1734` via `stateStore.healthCheck()` → `connect()` + `PING`) genuinely means *do not send traffic here*: Redis holds sessions, jobs, nonces, refresh records. Blanket-200 silences that across ten pure-code consumers, two of which are **automatic rollback triggers** — `scripts/ops/redeploy-backend.sh:108` → `:238` (`rollback()` to `$PREVIOUS_SHA`) and `scripts/ops/flip-caddy-network.sh:122` → `rollback` — and one of which is the **only off-VPS alarm**, `.github/workflows/external-uptime-watchdog.yml:64` (`check "api" ".../health" 200`, opens a GitHub issue). `scripts/ops/deploy-production.sh:822` discards the body entirely (`curl -fsS --max-time 5 "$health_url" >/dev/null 2>&1`) and is the *post-credential-rotation* fast path — exactly when a backend comes up Redis-less. It also breaks two published contracts: `docs/api/openapi.json` documents the 503, and `site/.well-known/agent-tools.json:435,799` advertises `/health` to third parties. Trading a loud deadlock for a silent no-op is the worse trade.

**Rejected — "the deploy tolerates degraded."** Stripping `-f` at `flip-caddy-network.sh:39` clears the visible symptom and leaves `redeploy-backend.sh:238`, `deploy-production.sh:822`, `flip-caddy-network.sh:122`, `check-hosted-stack.sh:209`, `resolve-live-backend-env.sh:25`, and the watchdog all armed. Done properly it is 6+ edits across shell and YAML, each of which permanently widens a gate. Keep it in your pocket as the emergency lever only (see §8).

**Chosen.** One line restores the invariant already written in that file's own header (`health-capability.js:18-23`: *"HTTP 200 + status 'ok' follow this signal ALONE; uptime monitors that page on 503 only fire when the API itself is degraded"*), keeps 503 for the one term where it is semantically correct, and touches no consumer.

### The correction the review got wrong — read this before writing code

The claim "every body-reading correctness consumer keeps its gate" is **false** under this fix. Once `autoVerifierOk` leaves the AND, `.status` reads `"ok"` during an auto-verifier fault, so `scripts/ops/check-hosted-stack.sh:209` (`jq -e '.status == "ok"'`), `scripts/ops/resolve-live-backend-env.sh:25` (`.[1].publicStatus != "ok"`) and `scripts/ops/check-hosted-stack-and-alert.sh` (the 5-minute VPS cron) lose the auto-verifier **entirely**. Verified: `check-hosted-stack.sh` contains zero occurrences of `submittedJobAutoVerifier`, `serviceHealth`, `warnings`, or `autoVerif`. **Item A2 is load-bearing, not a nice-to-have.** Ship A1 without A2 and you have traded a deadlock for a blind spot.

### Changes — one PR, all four items

**A1.** `mcp-server/src/core/health-capability.js:149` → `ok: stateStoreOk && authOk,`. Delete the now-unused `autoVerifierOk` local at `:145-146`. **Keep `components.submittedJobAutoVerifier` in the payload byte-identical** (`:163-165` and `operational-routes.js:139`) — no consumer loses a field.

**A2.** `scripts/ops/check-hosted-stack.sh`, immediately after line 210:
```bash
jq -e '.components.submittedJobAutoVerifier.ok == true' >/dev/null <<<"$api_health_json"
```
This is the megaphone relocated to where a correctness gate belongs: the deploy smoke (`deploy-production.sh:2222`), five hosted-proof workflows, and the 5-minute alerting cron all inherit it.

**A3.** `mcp-server/src/protocols/http/operational-routes.js:132-135` — append an auto-verifier entry to `warnings[]` beside `buildCapabilityWarnings(...)` and `buildOnboardingInventoryWarnings(...)`, with `code: "submitted_session_persistently_skipped"` (or the current liveness `state`), `severity: "critical"`, and a message naming the session count.

  **This lands on an already-wired consumer — verified, no board change needed.** `services/slack-operator/src/product-health.ts:1240-1248` (`deriveCapabilityProbe`) filters `h.body.warnings` against `config.expectedWarnings` and returns `status: "red"` when an unexpected warning carries a severity in `CRITICAL_WARNING_SEVERITIES = {"error","critical","fatal"}` (`:1216`). The default acknowledged baseline is `xcm_observer_staged,indexer_unavailable,gas_sponsor_disabled` (`:832`), which does not contain the new code. So the ops board's `capabilities` probe goes **red** on an unpaid worker, automatically.

  Also verified, and it settles the review's open question about the sibling repo: `deriveProductApiProbe` (`product-health.ts:1102-1104`) reds on **both** `!h.httpOk` **and** `h.body?.serviceHealth?.ok === false`. Today an auto-verifier fault reds `product_api` (wrong subject) and greys `capabilities`. After A1+A3 it reds `capabilities` (right subject) and leaves `product_api` green. Strictly more honest, and no board PR is required for it.

**A4.** `mcp-server/src/services/submitted-job-auto-verifier.js:443-448` — exclude by-design terminal skips from `updateSubmittedFailureStreaks`. Keep the session-scoped key and keep #1077's *default-alarm* intent (the comment at `:457-460` is right: unknown future reasons must alarm). Exclude exactly `non_auto_mode`, `already_verified`, `dry_run`. A job waiting for a human is not a stuck settlement; left in, it degrades A2's new gate for a non-fault and re-arms the deadlock class one layer down.

### Acceptance test — both directions are mandatory

`mcp-server/src/core/health-capability.test.js`:
- `resolveServiceHealth({ stateStoreHealth: { ok: true }, authConfig: { mode: "strict", ... }, submittedJobAutoVerifierHealth: { ok: false, state: "submitted_session_persistently_skipped", persistentSubmittedFailureCount: 2 } })` → `ok === true`, and `components.submittedJobAutoVerifier` deep-equals the input object.
- Same call with `stateStoreHealth: { ok: false }` → `ok === false`.

`mcp-server/src/protocols/http/operational-routes.test.js`:
- **A degraded system still deploys:** auto-verifier `ok:false` + state store up → HTTP **200**, body `.status === "ok"`, and `warnings` contains an entry with `code === "submitted_session_persistently_skipped"` and `severity === "critical"`.
- **A genuinely-not-serving system still blocks:** state store `ok:false` → HTTP **503**, body `.status === "degraded"`.

`scripts/ops/check-hosted-stack.test.mjs`:
- Fixture `/health` = HTTP 200, `.status === "ok"`, `.components.submittedJobAutoVerifier.ok === false` → script exits **non-zero**.
- Same fixture with `.ok === true` → exits **zero**.

`mcp-server/src/services/submitted-job-auto-verifier.test.js`:
- A submitted `human_fallback` session skipped with `reason: "non_auto_mode"` on three consecutive `finishRun` calls → `resolveLiveness().ok === true`.
- A submitted `benchmark` session skipped with `reason: "job_snapshot_missing"` on two consecutive runs → `resolveLiveness()` returns `{ ok: false, state: "submitted_session_persistently_skipped" }`.
- The same session skipped with a **different unrecognised** reason on each of two runs → still `ok: false` (the #1077 intent survives A4).
- `AUTO_VERIFY_DRY_RUN` path: candidates skipped with `reason: "dry_run"` on three runs → `ok === true`.

**End-to-end, run on the branch:** `scripts/ops/flip-caddy-network.sh status` against a local backend with a forced auto-verifier fault must exit 0 and print `publicStatus: "ok"`; against a backend with Redis stopped it must still exit 22.

---

## 4. Workstream B — the shortfall figure

### The arithmetic today

`services/slack-operator/src/product-health.ts:1685`:
```ts
const shortfall = input.settledCount - input.confirmedCount;
if (shortfall > input.tolerance) {
```
bound at `:2891-2896` with `settledCount: settlement?.settled24h ?? null`, `confirmedCount: payoutRead.count`, `tolerance` default 1. The board renders `−Math.max(0, settledCount − confirmedCount)` at `packages/schemas/src/ops-verdict.ts:220-223`.

`settled24h` counts **terminal sessions**, not paid ones — `mcp-server/src/core/health-capability.js:83`: `const SETTLED_SESSION_STATUSES = new Set(["resolved", "rejected", "closed"]);`, consumed by `isSettledWithinWindow` at `:992-1003`. `confirmedCount` counts `ReservationSettled` logs. A rejection **structurally cannot** emit one (`EscrowCore.sol` returns on the `!approved` branch before settlement; `AgentAccountCore.sol:350` reverts a zero-value settle). So every zero-payout terminal session adds exactly +1 to the gap, permanently, until it ages off the 24h edge. `SHORTFALL −5` = five rejected/closed sessions, two of them tonight's canaries. `mcp-server/src/core/health-capability.test.js` pins the current behaviour: one `resolved` + one `rejected` → `settled24h: 2`.

The repo already implements the correct rule elsewhere — `mcp-server/src/services/transparency-service.js:731-733`: `if (session?.status === "rejected") return 0n;`.

### B1 — platform, additive, keeps the `/health` contract stable

In `resolveSettlementHealth` (`health-capability.js:826-923`), split the existing per-session loop and add two fields to the return object at `:905-916`:

```js
settled24h,            // UNCHANGED — total terminal. Do not repoint.
paidSettled24h,        // NEW: settled-in-window AND status === "resolved"
zeroPaySettled24h,     // NEW: settled-in-window AND (rejected, or closed with no release)
```

Do **not** change `settled24h`: it is the honest throughput number, and `services/slack-operator/src/gas-spend.ts:136` divides gas by it for cost-per-lifecycle, which correctly includes rejected lifecycles.

Invariant to assert in test: `paidSettled24h + zeroPaySettled24h === settled24h`.

**Uncertain, flag on handback:** whether a `closed` session can be distinguished from a *zero-release* `closed` from session state alone. If the state store carries no release amount, classify `closed` as zero-pay and say so in a code comment — do not guess a payout.

### B2 — board, comparator + renderer

1. `product-health.ts:2894` → `settledCount: settlement?.paidSettled24h ?? null`. **Fall back to `unverified`, never to the old arithmetic**, when `paidSettled24h` is absent. This is the discipline `decidePayoutEvidence` already applies for a suspect window (`:1693-1698`): *an instrument that cannot tell payout-expected from zero-pay must not accuse.* It also makes B2 independently mergeable — pointed at a pre-B1 backend it reads "unverified", not a false red.
2. `decidePayoutEvidence` gains a `zeroPayCount` input it **displays but never subtracts**.
3. `packages/monitor-ui/src/lib/monitor/ops-spec.ts:1090-1116` (`volumeMixNote`) computes `gap = total − classified` off the same inflated `settledCount` and tones `degraded` past tolerance 1. **Fix both call sites or the false amber survives the fix to the false red.** Related and verified: `services/slack-operator/src/job-lifecycle-read.ts:108-109` skips any job with no `ReservationSettled` as `// still in flight`, so every rejection is *also* missing from `classified` — tonight's two canaries produce two independent alarms from one cause.

### What the board shows instead

Confirmed (grey, reassuring):
```
CONFIRMED     12 payouts confirmed on-chain (3.00 USDC) · 2 fee credits excluded
              17 settled — 12 expected payment · 5 settled with zero payout (rejected)
              window fit ok — chain read over 41,000 blocks · ~24.0h at 2.11s/block
```
Real shortfall (red, `emphasised: true`):
```
SHORTFALL −3  9 payouts confirmed on-chain (2.25 USDC)
              17 settled — 12 expected payment · 5 settled with zero payout (rejected)
              3 jobs were approved and released value on our ledger with no on-chain proof
```

Three rules that keep the two visibly different:
1. `SHORTFALL −N` may only ever count **approved-but-unproven**. A zero-pay settlement can never move it.
2. Zero-pay settlements stay **visible and grey**. Five rejections in 24h is worth seeing; it is a quality signal, not a money-missing signal.
3. The two rows use different verbs — *expected payment* vs *settled with zero payout (rejected)* — so no reader has to know the schema to tell them apart.

**Blast radius of leaving it:** `packages/schemas/src/ops-verdict.ts:328-338` makes `payout-shortfall` outrank every degraded probe and set the whole board headline; `services/slack-operator/src/money-alert.ts:42-56` is the only non-probe condition allowed to page and keys on gap size, so each new rejection re-pages; `packages/averray-mcp/src/index.ts:243` serves the same verdict to any agent asking `averray_ops_health`.

---

## 5. Workstream C — display the HTTP arrivals series

Board repo only. **#1071 (`1d06c8a`) is an ancestor of `d186095` — the HTTP series is live in production right now** and retrievable at `https://api.averray.com/monitor/arrivals`. Nothing displays it, and nothing says so: `schemaVersion` is still `averray.arrivals.v1` (`arrival-observatory.js:5`), so the version gate passes, unknown fields are ignored, and the coherence inequality still holds because `funnel` stayed MCP-only. The board shows a confident, correct-looking, half-blind funnel with no `UNREACHABLE` banner.

### The structural blocker is one layer below the panel

`services/slack-operator/src/arrivals-feed.ts` is an allowlist normalizer: `ArrivalsSnapshot` (`:54-79`) declares only `funnel`, `funnelExternal`, `funnelSelf`, `funnelAmbiguous?`, `distinct`, `clients`, and `normalizeArrivalsFeed` **reconstructs a fresh object** from those alone (`:204-231`). Every new field is dropped at the repo boundary.

### Changes

1. **`arrivals-feed.ts`** — extend the interface and the reconstruction with `funnelHttp`, `funnelHttpExternal`, `funnelHttpSelf`, `funnelHttpAmbiguous`, `attributionSourceTotals`, `httpCutover` (exact producer names verified at `arrival-observatory.js:467-480`). Every one **optional and absent-not-zero**, exactly as `funnelAmbiguous` is handled at `:141-146` — a zero-filled HTTP funnel is a measurement claim never made. Apply the coherence inequality to the HTTP family **independently**; do not cross-check HTTP against `funnel`, which is MCP-only by construction.
2. **`packages/monitor-ui/src/lib/monitor/product-health.ts:311-341`** — the type contract is duplicated here and must move in lockstep or the UI will not typecheck.
3. **`packages/monitor-ui/src/components/ops/ArrivalsPanel.tsx`** — retitle away from `ARRIVALS — MCP FRONT DOOR` (`:37`, `:39`, `:76`, `:79`) and render **two labelled doors**. Keep `funnelExternal` as the MCP headline so the existing trend stays readable (`:50` peak scaling, `:87` per-stage value); add the HTTP row-set beside it.

### Guard rails — non-negotiable, from the #1062 design

- **No backfill claim.** Render `httpCutover.at` as an explicit divider on the HTTP column, using the producer's own words **verbatim**: `HTTP_ARRIVAL_CUTOVER_NOTE` at `arrival-observatory.js:6` — *"HTTP arrivals are measured from this cut-over only; earlier HTTP traffic was not backfilled."* Add on screen: *a larger number here is recovered blindness, not growth.* The panel already has the precedent — the `UNATTRIBUTED` note at `:173-183` exists for exactly this job.
- **Never a combined headline.** No `funnelCombined`. The two series have different start times; their sum is not a quantity that ever existed.
- **Promote the measured number only.** Surface `attributionSourceTotals.http.siwe_wallet` as the headline HTTP figure, not the `ip_only` total.

### Two traps that will silently break the panel

- `distinct` (`arrival-observatory.js:481-495`) and `distinctAgents` (`:908-925`) have **different shapes**. `distinctAgents` has no `anonymous` key. Repointing the existing `distinct` reader at it makes `count(undefined)` return `undefined` and trips `"distinct counts or furthest stages are invalid"` (`arrivals-feed.ts:180-186`), blanking the whole panel to UNREACHABLE. Also: `distinct.furthestExternal` is **MCP-scoped**; `distinctAgents` is cross-door. Repointing the "FURTHEST STAGE AN OUTSIDER REACHED" headline at the merged view flips it `browsed` → `submitted` in one deploy with zero new demand — it must be labelled as recovered blindness beside the cut-over note.
- `ArrivalsPanel.tsx:66-76` computes `unattributed` by subtracting external+self+ambiguous from `funnel`. That arithmetic is valid **only** while `funnel` is MCP-only. Pin the invariant in a comment; if anyone ever "helpfully" folds HTTP into `funnel`, this line starts printing a fabricated pre-split backlog.

**Known contradiction this will expose, and it is out of scope here:** once the board says an outsider reached `submitted`, it visibly disagrees with the public transparency page's "External agents 0" for the same 24 hours. That page classifies by who **posted** the job (`transparency-service.js:687-694`, `source.type === "external"` set only in the poster-door projection at `platform-service.js:265-271`), not who worked it. Both are "correct" under their own definitions. Named as follow-up F-4 below — do **not** bundle it into C.

---

## 6. Explicitly out of scope

Each is a named follow-up so it is not lost. None may appear in a PR from this packet.

- **F-1 — EscrowCore v3 successor ceremony (retained claim fee, rung 1).** `#1078` merged source-only; `contracts/EscrowCore.sol:296,1036` are inert on chain — live escrow `0x590EbE30…C3fC` still refunds the fee, and the probe fails closed at `mcp-server/src/blockchain/gateway.js:612-621`. Requires the six-step multisig ceremony and `deployments/`. Pascal-operated. **This is the single highest-leverage economic change available, and it is why the D-03 freeze exists.**
- **F-2 — DepositPool mainnet ceremony (rung 3).** Contract exists; no `depositPool` key in `deployments/mainnet.json`; `git grep -i "depositPool|poolShares|shareBalance" -- mcp-server/src` returns **zero** hits. Even deployed tomorrow it would be a contract with no consumer.
- **F-3 — the missing per-wallet daily-rate rung (rung 2).** Verified not built: no config, no claim-scoped limiter (`bootstrap.js:804-826` is ten per-*minute* buckets), and `POST /jobs/claim` (`protocols/http/job-routes.js:139-160`) calls no limiter at all. `#1079`'s exposure cap bounds **simultaneity** (2.5 USDC ≈ 8 concurrent 0.25-jobs), never **rate**. The only thing bounding claims/day today is the single **global** $8 subsidy budget (`claim-economics.js:22`), which one wallet can drain for everyone.
- **F-4 — public transparency page mislabels.** "Work paid for … N jobs settled" counts rejections (`marketing/src/pages/transparency.astro:152-171` reading `flow.jobsSettled`); "Who did that work / External agents" measures who **posted**. Both public.
- **F-5 — `/livez`.** Always-200, carrying `{ status, deployedSha, auth.chainId }` — the three fields the pure-liveness consumers actually read (`GET /` at `public-metadata-routes.js:151-177` has none of them). Repoint `flip-caddy-network.sh:39,63,122`, `redeploy-backend.sh:108`, `deploy-production.sh:822,841,861`, `external-uptime-watchdog.yml:64`, `docker-compose.mainnet.yml:55`, `hosted-worker-canary.yml:147`. Mirrors the `/health` vs `/ready` split the indexer already has. Cannot ship first — the endpoint only exists after a deploy.
- **F-6 — the auto-verifier reads green when it is blind.** `checkSettlementGate` (`submitted-job-auto-verifier.js:408-426`) pushes skips with **no `sessionId`** on `protocol_paused` / `settlement_not_ready` / `policy_status_unavailable`; they are filtered at `:448` and the streak map is replaced wholesale at `:472`, so a chain outage *clears* a pre-existing alarm and the component reports `ok: true`. Deliberately excluded from A to keep A narrow, and because a named non-ok state there would trip A2's new gate during a legitimate pause — that interaction needs its own design.
- **F-7 — `site/schemas/agent-profile-v1.json` is three revisions stale** and `additionalProperties: false`, so **every live profile fails validation against the schema we publish as its contract**. The gate at `scripts/ops/check-product-proof-gate.mjs:86` checks only `$id`. Widest blast radius of anything in this report because it points at machines we do not control — but it is a separate concern from the operator's view.
- **F-8 — `settlement-expectation.js:41-50` tells agents `github_pr` "approves on its own"**; nothing auto-invokes it (`verifySubmission` has exactly two callers, both gated).

---

## 7. Conditions of acceptance — what Claude verifies on handback

**Global, all PRs:** `git diff --name-only origin/main...HEAD` contains **no** path under `contracts/` or `deployments/`. One concern per PR. No PR is stacked on another.

**Workstream A**
1. `health-capability.js:149` reads exactly `ok: stateStoreOk && authOk,` and the `autoVerifierOk` local is gone, not merely unused.
2. `components.submittedJobAutoVerifier` is byte-identical in the response — diff a captured `/health` body before/after with `jq '.components.submittedJobAutoVerifier'`.
3. `check-hosted-stack.sh` contains a `jq -e '.components.submittedJobAutoVerifier.ok == true'` assertion, and `check-hosted-stack.test.mjs` fails the script on a 200/`status:"ok"` body with `.ok === false`.
4. The warning emitted at `operational-routes.js` carries `severity: "critical"` and a code **not** present in the board's default `expectedWarnings` (`xcm_observer_staged`, `indexer_unavailable`, `gas_sponsor_disabled`). I will re-read `product-health.ts:1240-1248` against the shipped code string to confirm `deriveCapabilityProbe` reds on it.
5. Both acceptance directions pass: degraded → 200 + warning; state store down → 503 + `"degraded"`. I will run `operational-routes.test.js` and `health-capability.test.js` myself, not read the CI badge.
6. `non_auto_mode` / `already_verified` / `dry_run` no longer arm a streak; an **unknown** reason still does. I will grep `updateSubmittedFailureStreaks` for an allowlist — if the exclusion is implemented as an allowlist of alarming reasons rather than a denylist of by-design skips, that is a **reject**: it silently re-narrows #1077 and drops future unknown failures out of health.

**Workstream B1**
7. `settled24h` is unchanged in value and in every existing test; `gas-spend.ts`'s denominator is untouched.
8. New test asserts `paidSettled24h + zeroPaySettled24h === settled24h` on a fixture containing at least one `resolved`, one `rejected` and one `closed` session.
9. The existing `health-capability.test.js` case that asserts `settled24h: 2` for one `resolved` + one `rejected` still passes unmodified.

**Workstream B2**
10. With `paidSettled24h` **absent** from the fixture, `decidePayoutEvidence` returns `status: "unverified"` — **not** `"shortfall"`, **not** the old arithmetic. This is the single most important assertion in workstream B.
11. With `settled24h: 17, paidSettled24h: 12, zeroPaySettled24h: 5, confirmedCount: 12` → `status: "confirmed"`, and the rendered detail names the 5 zero-pay settlements in a non-alarming tone.
12. With the same inputs but `confirmedCount: 9` → `status: "shortfall"`, gap **3** (not 8), `emphasised: true`.
13. `volumeMixNote` (`ops-spec.ts:1090-1116`) is fixed in the same PR — a fixture with 5 rejections must not produce "5 unclassified" at `degraded` tone. I will check this specifically; it is the most likely thing to be missed.

**Workstream C**
14. `normalizeArrivalsFeed` round-trips all six new fields, and **omits** each one when the input omits it — assert `"funnelHttp" in result === false`, not `funnelHttp === {}`.
15. A pre-#1071 snapshot (no HTTP fields at all) still renders the MCP panel with no `UNREACHABLE` banner and no zeros in an HTTP column.
16. The rendered panel contains `httpCutover.note` **verbatim**, matching `HTTP_ARRIVAL_CUTOVER_NOTE` character-for-character. A paraphrase is a reject.
17. No `funnelCombined`, no summed headline, and `distinct.furthestExternal` still reads the MCP-scoped `distinct`, not `distinctAgents`. I will grep for `distinctAgents` in `ArrivalsPanel.tsx` and read every hit.
18. `ArrivalsPanel.tsx:66-76`'s `unattributed` arithmetic carries a comment pinning the "`funnel` is MCP-only" invariant.

---

## 8. Open questions for Pascal

1. **Do you want the emergency lever pulled before workstream A lands?** If a deploy must go out tonight, the narrow version is: tolerate a degraded body at `flip-caddy-network.sh:39`, `redeploy-backend.sh:108` and `deploy-production.sh:822` — but `flip-caddy-network.sh:122`'s cutover rollback keeps its `-f` until `/livez` exists. This is a temporary widening of three gates, not a fix.
2. **Confirm `PRODUCT_HEALTH_EXPECTED_WARNINGS` on the VPS is unset or does not list the new code** — if it has been customised, A3's megaphone lands silently and A2 becomes the only replacement gate. I cannot read the VPS env from here.
3. **The D-03 freeze is yours to clear** (`deployments/mainnet.json` change, a known-unshipped runtime hash for EscrowCore, or a dispatch with `DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT=1`). Until it clears, A, B1 and #1077/#1079 exist only in git — and #1077's widened rule arms the moment it does. Sequence A ahead of the freeze clearing if at all possible.
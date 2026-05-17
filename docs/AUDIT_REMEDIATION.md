# Averray - Audit Remediation Plan

**Purpose:** Track the architecture audit findings through closure with concrete close criteria. This is a working document: update it as gaps close.
**Companion documents:** `AVERRAY_WORKING_SPEC.md` (architecture), `AVERRAY_VERIFICATION_LEDGER.md` (Polkadot semantics), `FRAMEWORK_AGENT_HANDOFF.md` (implementation handoff), `DISTRIBUTION_STRATEGY.md` (operational launch plan).
**Status:** v0.2 - updated 2026-05-17 against expanded audit and current `origin/main`. Two new findings surfaced in the expanded audit (`P1.1b` health truth, `P2.5b` policy durability), one additional repo-review finding was added here (`P1.3` sync mutation idempotency), acceptance criteria were sharpened with specific endpoint paths, status codes, and env var names, and the execution sequence is locked.
**Owner:** Pascal

---

## Honest read on the audit

The audit is good. Findings are real, prioritized correctly, and stated without inflation. The architecture itself is sound: workspace split, auth posture, Redis-required-in-strict-mode, blockchain config all-or-nothing, session state machine clarity, and the trust-core-first roadmap. These are the right structural choices and they hold up.

The weaknesses are not architectural. They are implementation gaps where the architecture's promises are not yet enforced at runtime. That is a different kind of problem, and it has a single load-bearing pattern.

The 2026-05-13 expanded audit, reflected in this remediation plan, added: a separate finding for health-endpoint truth (previously folded into mutation-gate), a finding for policy state durability, a generated-output guard, and sharper acceptance criteria throughout.

### Codex review notes added 2026-05-17

After checking the current repo state, I would add five corrections or additions before treating this as the execution tracker:

1. `P2.4` is partially mitigated on current `origin/main`: `overview`, `treasury`, and `agents` no longer appear to use the old large fixture fallbacks. Keep the finding open anyway until there is a mechanical production guard across all operator pages and a clear demo-mode banner.
2. `server.js` is now about 4,277 lines, not about 2,489 lines. That makes `P2.3` more important, but it still should happen after the truth-boundary fixes unless the refactor becomes necessary to land them safely.
3. `/agent/transfer` is not a current public HTTP route in `server.js`; the current route is `/payments/send`. If `/agent/transfer` is introduced later as an alias, it must inherit the same mutation gate and idempotency behavior.
4. Add `P1.3`: sync money-like routes currently accept or reference idempotency posture but do not implement a standard replay/conflict contract. Once chain-backed mutations are enabled, duplicate retries become a real settlement risk.
5. The public-site "Live" stream finding should be closed by either using real public proof data or relabeling it as an example. Do not keep the word "Live" on deterministic animation.

### The pattern behind several findings

Seven findings - `P1.1`, `P1.1b`, `P1.2`, `P1.3`, `P2.4`, `P2.5`, and `P2.5b` - are symptoms of one structural issue: the boundary between "real", "demo", and "local simulation" is too soft in multiple layers of the stack.

For a trust-infrastructure platform whose pitch is "receipts, not vibes", this is the worst possible gap shape. A misconfiguration that ships to production could silently produce successful-looking treasury operations that never touched chain. The trust pitch fails not because the architecture is wrong, but because the implementation does not yet enforce the architecture's guarantees everywhere.

Closing the cross-cutting pattern matters more than closing any single finding. Each close criterion below assumes one posture: every production surface must declare whether it is real, degraded, or example, and must enforce that declaration mechanically. No silent fallbacks. The truth boundary lives at API routes, health reporting, state storage, mutation replay semantics, and user-facing UI.

---

## What this document is, and what it is not

This is an actionable remediation tracker. Each finding has root cause, close criteria, verification approach, and launch-readiness mapping.

This is not a re-statement of the audit. The audit is the source; this document is the response.

This is not the spec. Architectural decisions live in `AVERRAY_WORKING_SPEC.md`. Implementation gaps live here.

This is not complete launch planning. The audit does not surface every open item. See "Out-of-scope items still tracked elsewhere" below.

---

## Findings by priority

### P1.1 - Money-like actions can succeed in off-chain memory mode

**Status:** Open. **Launch-blocking.**

**Audit reference:** `mcp-server/src/core/account-mutation-service.js` (`allocateIdleFunds`, `deallocateIdleFunds`, `borrow`, `repay`, `agentTransfer`), `mcp-server/src/blockchain/gateway.js` (`healthCheck` disabled mode), `mcp-server/src/protocols/http/server.js` routes `/account/fund`, `/account/allocate`, `/account/deallocate`, `/account/borrow`, `/account/repay`, `/payments/send`.

**Current route note:** `/agent/transfer` is not currently exposed as a route on `origin/main`; `/payments/send` is the exposed transfer path. If `/agent/transfer` is added later, it must inherit the same gate.

**Root cause:** Money-like routes are authenticated, but when the blockchain gateway is disabled the service can still mutate local in-memory balances instead of refusing the operation. The API can say "sent", "borrowed", "allocated", or "funded" without anything happening on-chain.

**Why it is launch-blocking:** Treasury operations succeeding in memory while reporting success directly contradicts the trust pitch. Production misconfiguration could silently produce fake settlement history. Worse, the indexer would never see those events, so the discrepancy could persist undetected.

**Close criteria:**

- [ ] New env var `MUTATION_BACKEND=memory|chain|required` introduced. Production default: `required`. Development default: `memory`.
- [ ] When `MUTATION_BACKEND=required`, or when `MUTATION_BACKEND=chain` and the gateway is unhealthy, the following routes reject with HTTP `503` and error code `chain_backend_required`: `/account/allocate`, `/account/deallocate`, `/account/borrow`, `/account/repay`, `/account/fund`, `/payments/send`.
- [ ] Error response body includes `{ "error": "chain_backend_required", "reason": <gateway-status-detail> }`.
- [ ] Production deploy config (`deployments/mainnet.env.example`, `scripts/write_server_env.sh`) sets `MUTATION_BACKEND=required` by default.
- [ ] Startup log surfaces mutation backend mode prominently in the first 5 log lines: `MUTATION_BACKEND=required, chain status: healthy`.
- [ ] Integration test: with `NODE_ENV=production` and no blockchain config, every money-like route returns `503 chain_backend_required`.
- [ ] Integration test: with chain enabled and healthy, those routes can succeed through the chain path.

**Verification approach:** Boot the server with chain disabled and `MUTATION_BACKEND=required`, hit each money-like endpoint, and assert `503 chain_backend_required`. Boot with chain enabled and healthy, hit the same endpoints, and assert success or the expected domain-level validation error.

---

### P1.1b - Disabled blockchain reports healthy

**Status:** Open. **Launch-blocking.**

**Audit reference:** `mcp-server/src/blockchain/gateway.js` (`healthCheck` returns `ok: true` when disabled), `mcp-server/src/protocols/http/server.js` `/health`.

**Root cause:** The blockchain gateway reports a disabled gateway as operationally OK. That makes `/health` look green even when treasury features are local simulation or unavailable.

**Why it is launch-blocking:** `P1.1` prevents fake settlements at the route layer. `P1.1b` makes the health-reporting layer tell the truth about what is actually available. Without it, monitoring dashboards and uptime checks can report green during a misconfiguration that broke real treasury.

**Close criteria:**

- [ ] `/health` response split into `serviceHealth` and `capabilityHealth`.
- [ ] `serviceHealth` covers whether the API process responds, Redis/state store is reachable, auth dependencies are loaded, and basic runtime dependencies are working.
- [ ] `capabilityHealth` covers live capabilities: `blockchain` (`enabled|disabled|unhealthy`), `treasuryMutations` (`available|unavailable|degraded`), `xcmObserver` (`live|staged|unavailable`), and `indexer` (`synced|lagging|unavailable`).
- [ ] `serviceHealth` can be `ok` while `capabilityHealth.blockchain = "disabled"` and `capabilityHealth.treasuryMutations = "unavailable"`. This is valid for a trust-core-only launch.
- [ ] In production, `capabilityHealth.treasuryMutations = "unavailable"` is reflected as a warning in operator dashboards and external monitoring.
- [ ] Integration test: with chain disabled in production mode, `/health` returns `serviceHealth: "ok"` but `capabilityHealth.treasuryMutations: "unavailable"`.

**Verification approach:** Curl `/health` in three configurations: full chain enabled, chain disabled with `MUTATION_BACKEND=memory` for dev, and chain unhealthy with `MUTATION_BACKEND=required` for production-misconfigured. Assert each response tells the truth: service-up but capability-down where applicable.

**Honest framing:** This is a small fix in code terms, but a big fix in trust terms. Hosted health endpoints are what operators, uptime monitors, and discovery agents look at first. They should tell the truth.

---

### P1.2 - Account overlay state is process memory, not durable state

**Status:** Open. **Launch-blocking.**

**Audit reference:** `mcp-server/src/services/bootstrap.js` (`accounts = new Map(...)`), `mcp-server/src/core/account-mutation-service.js` (`attachStoredTreasuryMetadata`).

**Root cause:** Account overlay state is a runtime in-memory structure seeded at bootstrap. Treasury timeline, strategy metadata, and account overlays can live there. `attachStoredTreasuryMetadata()` also lets stored overlay fields win over live account fields, meaning stale memory state can mask fresher chain state.

**Why it is launch-blocking:** Process restart can lose state. Operator-facing UIs can show inconsistent data after restart. The overlay-wins-over-live precedence can produce silent inconsistencies between what operators see and what is actually on-chain.

**Close criteria:**

- [ ] Classify every account overlay field as one of: `chain_authoritative`, `offchain_authoritative`, `derived_cache`, or `display_only`.
- [ ] Move all non-chain account overlays that operators rely on to Redis or Postgres.
- [ ] Use Redis only for ephemeral derived state. Use Postgres, or another durable store, for state that must survive restarts and is not chain-derived.
- [ ] Invert `attachStoredTreasuryMetadata()` precedence: live account fields always win; stored overlay fields are explicitly non-authoritative and only fill gaps where live data is unavailable.
- [ ] Data returned to API callers labels overlay state as `derived`, `cached`, or `authoritative`. No implicit overlays.
- [ ] Integration test: kill the server mid-flow, restart, and assert no state loss for data that operators rely on.

**Verification approach:** Two-process test. Process A writes account state via API. Process B, on the same data layer, reads it. Assert consistency. Kill process A, start process A', repeat, and assert consistency survives restart.

**Honest framing:** The right storage target depends on what the overlay actually contains. If it is purely derived from chain events, Redis is fine. If it is authoritative state that exists only off-chain, this becomes a deeper architecture question: should that state be on-chain instead?

---

### P1.3 - Sync money-like routes lack standard idempotency coverage

**Status:** Open. **Launch-blocking if sync money-like routes are enabled for rc1.**

**Audit reference:** `docs/IDEMPOTENCY.md` says sync strategy variants and money-like routes currently accept `idempotencyKey` for forward compatibility but ignore it on the server. Relevant routes include `/account/fund`, sync `/account/allocate`, sync `/account/deallocate`, `/account/borrow`, `/account/repay`, and `/payments/send`.

**Root cause:** Once mutations become real chain-backed operations, client retries can duplicate money-like actions unless every mutation route has a durable idempotency contract. The async XCM lane has a request lifecycle; the sync money-like routes do not yet have equivalent replay/conflict protection.

**Why it is launch-blocking if those routes are live:** The route gate in `P1.1` prevents fake success when chain is unavailable. It does not prevent duplicate success when chain is available and clients retry after timeouts. A trust platform cannot have "maybe double sent" as a normal failure mode.

**Close criteria:**

- [ ] Standard idempotency service covers all money-like routes that can emit real mutations: `/account/fund`, `/account/allocate` in sync mode, `/account/deallocate` in sync mode, `/account/borrow`, `/account/repay`, `/payments/send`.
- [ ] Same `idempotencyKey` plus same payload returns the original response without issuing a second mutation.
- [ ] Same `idempotencyKey` plus different payload returns HTTP `409` with error code `idempotency_conflict`.
- [ ] In-flight duplicate requests return a clear `202`, `409`, or replayable pending response; choose one contract and document it.
- [ ] Idempotency records are durable enough for production retry windows. Redis is acceptable only if configured with persistence and TTL; Postgres is safer for money-like routes.
- [ ] `docs/IDEMPOTENCY.md` updated to remove the "ignored on server" posture for every route that is implemented.
- [ ] Integration tests cover replay, conflict, and retry-after-timeout behavior.

**Verification approach:** With chain gateway mocked healthy, send the same money-like request twice with the same `idempotencyKey`; assert only one downstream mutation call. Then send the same key with a different body; assert `409 idempotency_conflict`. Repeat at least one test through an actual HTTP route, not only the service layer.

**Decision escape hatch:** If sync money-like routes stay disabled or gated for rc1, this finding can be deferred from launch-blocking to pre-treasury-live. That decision must be explicit in the spec and operator UI.

---

### P2.3 - HTTP server is the main backend monolith

**Status:** Open. **Not launch-blocking, but technical debt accumulating.**

**Audit reference:** `mcp-server/src/protocols/http/server.js` is about 4,277 lines on current `origin/main`.

**Root cause:** One file owns runtime boot, CORS, metrics, public discovery, auth, jobs, account routes, XCM admin settlement, policies, disputes, and response shaping. Built-in policy data and process-local proposals also live here, covered separately by `P2.5b`.

**Why it is not launch-blocking:** No direct correctness issue. The code works, and the domain services underneath are cleaner than the route edge. This is worth fixing for the second contributor's sake, but Pascal can ship `v1.0.0-rc1` with the monolith intact if the truth-boundary issues are closed.

**Close criteria:**

- [ ] `server.js` split into route modules under `mcp-server/src/protocols/http/routes/`:
  - `public-routes.js` - discovery and well-known endpoints.
  - `auth-routes.js` - SIWE and session creation.
  - `job-routes.js` - job lifecycle: post, claim, submit.
  - `session-routes.js` - session state-machine endpoints.
  - `account-routes.js` - agent account operations.
  - `policy-routes.js` - policy CRUD. Depends on `P2.5b` or lands with it.
  - `dispute-routes.js` - dispute lifecycle endpoints.
  - `admin-xcm-routes.js` - XCM admin settlement.
- [ ] `server.js` reduced to wiring, CORS, health, middleware registration, and server lifecycle. Target: under 500 lines; under 300 lines if practical.
- [ ] Per-module test isolation possible.
- [ ] No endpoint response-shape regressions.

**Verification approach:** Line count check plus integration snapshot. Every endpoint that worked before still returns the same response shape and status code, unless changed intentionally by another remediation.

**Honest framing on timing:** Do this after `P1.1`, `P1.1b`, `P1.2`, `P1.3`, `P2.4`, `P2.5`, and `P2.5b` land. Refactoring while load-bearing fixes are in flight creates merge-conflict risk. The monolith works; close the truth-boundary gap first.

---

### P2.4 - Operator frontend can mix live API with demo truth

**Status:** Partially mitigated on current `origin/main`; still Open. **Launch-blocking until mechanically enforced.**

**Audit reference:** Current `overview`, `treasury`, and `agents` pages no longer appear to use the old large fixture fallbacks. Remaining risk is broader: all operator pages must distinguish `live`, `empty`, `degraded`, and `demo` mechanically, including sessions, disputes, audit, policies, and future treasury screens.

**Root cause:** The previous UI pattern allowed polished seeded activity when API data was absent. Even where current pages have improved, the repo lacks a single production rule that prevents fixture/demo output from appearing without an explicit demo flag.

**Why this is launch-blocking:** The platform's pitch is that every claim is anchored to verifiable reality. A frontend that shows fake activity when the backend is unreachable directly contradicts that pitch. If a discovery-agent operator sees Averray's UI for the first time and what they see is fixture data, the trust impression is permanently bad.

**Close criteria:**

- [ ] Explicit demo-mode flag: `NEXT_PUBLIC_DEMO_MODE=true|false`. Production default: `false`.
- [ ] Four explicit UI modes: `live`, `empty`, `degraded`, `demo`. Page components accept and respond to all four.
- [ ] When `NEXT_PUBLIC_DEMO_MODE=false`, empty API responses produce `empty` or `degraded` UI states with appropriate copy. They never produce fixture activity.
- [ ] When `NEXT_PUBLIC_DEMO_MODE=true`, fixture/demo data is allowed and a persistent banner appears on every affected page: `Demo mode - this is not real platform data.`
- [ ] Fixture data is removed from any production code path that can be triggered without `NEXT_PUBLIC_DEMO_MODE=true`.
- [ ] Production deploy config sets `NEXT_PUBLIC_DEMO_MODE=false`.
- [ ] Visual regression test: with `NEXT_PUBLIC_DEMO_MODE=false` and API returning empty, no operator page renders fixture content.

**Verification approach:** Snapshot the affected pages in four states: demo mode, live data present, API up but data empty, and API down/degraded. Assert the last three states never show fixture activity, and empty states explain the next real action.

**Adjacent improvement:** Empty state design is its own product surface. "No agents yet - here's how to create one" is better than a blank screen.

---

### P2.5 - Public site shows a fake "Live" stream

**Status:** Open. **Launch-blocking.**

**Audit reference:** `marketing/src/pages/index.astro` labels the homepage console as live/operator staging; `marketing/public/console-stream.js` contains deterministic scripted output and explicitly says there is no network.

**Root cause:** The homepage labels a console "Live" while the stream is deterministic animation. The public-facing trust narrative is contradicted by one of the first things visitors see.

**Why it is launch-blocking:** Discovery agents, posters, and early partners will land on the homepage. Calling something "Live" when it is a hardcoded animation is exactly the kind of mismatch that harms the "receipts, not vibes" story.

**Close criteria - choose one path and execute it:**

**Path A: Real public proof feed.**

- [ ] Console hydrates from public endpoints such as `/session/state-machine`, `/schemas/jobs`, and recent public profile receipts.
- [ ] If existing endpoints do not cover the right shape, add a rate-limited `/public/recent-receipts` endpoint.
- [ ] Visitors can click from the visual stream to real public JSON/proof surfaces.
- [ ] Loading and degraded states are visible when API is unavailable. No fake fallback state.

**Path B: Explicit example run labeling.**

- [ ] Keep deterministic stream but label it as `Example: how the platform works`.
- [ ] Remove every "Live" label, tooltip, aria description, and visual badge from the homepage stream.
- [ ] A fresh visitor cannot reasonably conclude the animation is real operations.

**Path C: Remove the console.**

- [ ] Replace the console with static real receipt screenshots or proof links.
- [ ] Each visual links to a real public proof surface.

**Recommendation:** Path A is most aligned with the trust pitch and compounds the infrastructure already built. Path B is acceptable for `v1.0.0-rc1` if Path A is too much work. Path C is the simplest escape hatch.

**Verification approach:** Fresh-visitor review. A visitor cannot reasonably conclude displayed data is real unless it actually is real. Automated test should assert no `Live` label appears on the example path.

---

### P2.5b - Policy state is process-local demo state

**Status:** Open. **Not launch-blocking for bootstrap, but should close before public posters arrive.**

**Audit reference:** `mcp-server/src/protocols/http/server.js` stores `POLICY_PROPOSALS` in a process-local `Map` and defines built-in policies inline.

**Root cause:** Built-in policies and proposed policies live directly in `server.js`. Proposals are process-local memory and disappear on restart. Policy feels like core operator state but is currently route-local.

**Why it is not launch-blocking for `v1.0.0-rc1`:** During bootstrap, Pascal is likely the only operator proposing or modifying policies. A lost proposal is annoying, not catastrophic. It becomes launch-blocking once external operators or posters arrive.

**Close criteria:**

- [ ] Create `PolicyService` backed by Redis or Postgres. Proposals should likely survive restart, so Postgres is the safer default.
- [ ] Built-in policies become seed data loaded into the store at startup, not route-local constants.
- [ ] Policy proposals persist across restarts.
- [ ] Audit/admin status endpoint surfaces all policy proposals, including pending ones.
- [ ] Integration test: propose a policy, restart the server, assert the proposal is still visible.

**Verification approach:** Propose a policy through the API, kill the server, restart, query policy list, and assert the proposal is still present.

**Relationship to P2.3:** This overlaps with the server monolith. Either extract `PolicyService` first and move routes later, or do it as part of the route split. Focused state extraction first is less risky.

---

### P2.6 - Native XCM observer is planned but not implemented

**Status:** Open. **Not launch-blocking.** Already deferred to v1.x per spec.

**Audit reference:** `indexer/src/api/xcm-upstream-source.ts` native source is staged/not complete by design.

**Root cause:** Native Polkadot/Bifrost treasury truth is not implemented yet. Current XCM work is an async request/observe/settle lane, not a final native observer.

**Why it is not launch-blocking:** The spec deliberately removed yield strategy and async XCM correlation from `v1.0.0-rc1` scope. The vDOT lane ships at v1.x after the documented gates.

**Close criteria:**

- [ ] Honest scope discipline: until this is implemented, no mainnet treasury claims on the public site, marketing materials, or operator UI.
- [ ] Anything that would show `vDOT yield earned` says `v1.x - not yet enabled`.
- [ ] Backend SCALE assembler shipped.
- [ ] Chopsticks experiment validates Bifrost `SetTopic` preservation or chooses fallback strategy.
- [ ] Native PAPI source replaces the throwing/staged stub.
- [ ] Integration test: full round trip with forked Hub plus Bifrost in Chopsticks completes successfully.

**Verification approach:** Existing v1.x roadmap and pre-launch checklist. No new verification needed beyond the spec gates.

---

### P3.7 - "Authed" frontend layout is not actually an auth guard

**Status:** Open. **Not launch-blocking.**

**Audit reference:** `app/hooks.ts`, `app/app/(authed)/layout.tsx`.

**Root cause:** Comments or route naming imply an authenticated layout, but the layout itself mainly renders the shell. Backend auth is still enforced, so this is naming/documentation drift rather than a direct security hole.

**Close criteria:** Pick one:

**Option A: Add the real guard.**

- [ ] Layout or shared data layer watches for `401` responses and redirects to sign-in.
- [ ] Stale authed content is cleared on auth failure.
- [ ] User sees a clear reconnect/sign-in state.

**Option B: Rename and document intent.**

- [ ] Rename `(authed)` route group or update docs/comments so it is not described as a frontend guard.
- [ ] Document that backend auth is the enforcement layer.

**Recommendation:** Option A. The frontend should fail gracefully when the backend rejects auth instead of leaving stale content or confusing empty states.

---

### P3.8 - Generated output beside source

**Status:** Open. **Not launch-blocking, but worth catching now.**

**Audit reference:** `AGENTS.md`, root scripts, generated `frontend/` and `site/` deploy outputs.

**Root cause:** `app/` and `marketing/` are source. `frontend/` and `site/` are generated deploy surfaces. Repo rules warn against editing generated directories, but no mechanical enforcement exists. This has already caused confusion during UI work.

**Why worth closing:** It is invisible until someone patches generated output and wonders why source builds do not preserve the change. Cheap to fix once.

**Close criteria:**

- [ ] Pre-commit hook or CI check rejects manual changes under `frontend/` and `site/` unless a bypass is present, such as `ALLOW_GENERATED_EDIT=1` or commit tag `[allow-generated]`.
- [ ] Build pipeline can still write to `frontend/` and `site/` during normal deployment.
- [ ] `AGENTS.md` or `README.md` explains the guard in one paragraph.
- [ ] Existing warnings remain. The mechanical guard backs up the documented expectation.

**Verification approach:** Try to commit a manual change to `frontend/index.html` without bypass and assert commit is rejected with a clear error. Run production build and assert generated output can still be written normally.

---

## Out-of-scope items still tracked elsewhere

The audit does not cover everything. These remain open in companion documents:

| Item | Tracked in | Status |
|---|---|---|
| Multisig-owns-EVM-contract testnet rehearsal | `AVERRAY_WORKING_SPEC.md`, `AVERRAY_VERIFICATION_LEDGER.md` | Open - empirical, blocks mainnet rehearsal |
| Chopsticks experiment for Bifrost `SetTopic` preservation | `AVERRAY_WORKING_SPEC.md` | Open - empirical, blocks v1.x vDOT lane |
| `OPERATOR_ONBOARDING.md` | Spec checklist | Open - launch-blocking docs work |
| `THREAT_MODEL.md` | Spec checklist | Open - launch-blocking docs work |
| Pre-launch content for distribution | `DISTRIBUTION_STRATEGY.md` | Open - launch-week prep |
| README absolute-path bugs | Verification ledger/spec cleanup | Open - trivial housekeeping |
| `FRAMEWORK_AGENT_HANDOFF.md` refresh to v2.4 | Handoff doc | Open - small update after remediation plan lands |

This remediation plan focuses on audit findings. The full `v1.0.0-rc1` launch readiness picture requires consulting all companion documents.

---

## Launch-readiness mapping

### Must close before `v1.0.0-rc1`

- `P1.1` - Money-like actions in memory mode (`MUTATION_BACKEND` gate).
- `P1.1b` - Health endpoint truth (`serviceHealth` vs `capabilityHealth` split).
- `P1.2` - Account overlay durability and precedence inversion.
- `P1.3` - Idempotency for money-like sync routes, unless those routes are explicitly disabled for rc1.
- `P2.4` - Frontend demo fallbacks in production.
- `P2.5` - Public site fake "Live" stream.
- Multisig rehearsal, `OPERATOR_ONBOARDING.md`, `THREAT_MODEL.md`, and distribution content from companion docs.

### Should close, but not blocking for bootstrap

- `P2.3` - HTTP server monolith.
- `P2.5b` - Policy state durability. Becomes blocking once external operators/posters arrive.
- `P3.7` - Authed layout naming/guard.
- `P3.8` - Generated-output guard.

### Already deferred per spec

- `P2.6` - Native XCM observer. v1.x post-gate, not `v1.0.0-rc1`.

---

## Multi-agent execution board

The remediation work should be split into narrow branches so multiple agents can work without stepping on each other. Each branch must start from fresh `origin/main` with `./scripts/ops/start-agent-worktree.sh <branch>`, and each branch owns only the file scopes listed below.

### Coordination rules

- One branch per finding or tightly coupled group. Do not bundle unrelated backend, frontend, public-site, docs, and indexer work.
- Do not push directly to `main`.
- The coordinator keeps this document updated with status, branch, owner, and commit hash as items close.
- If two packages need the same file, the later package waits until the earlier package lands, unless the coordinator explicitly slices the file into disjoint sections.
- Every PR description must say which remediation item it closes and which checks ran.
- Generated `frontend/` and `site/` output should not be committed unless the task explicitly changes generated static deploy surfaces.

### Package A - P1.1 mutation backend gate

**Suggested branch:** `codex/p1-mutation-backend-gate`
**Can start now:** Yes.
**Blocks:** Package B route wiring, Package C health warnings, Package D idempotency route integration.

**Owned finding:** `P1.1`

**Primary file scope:**

- `mcp-server/src/core/account-mutation-service.js`
- `mcp-server/src/blockchain/gateway.js`
- `mcp-server/src/protocols/http/server.js` money-like route guard sections only
- `deployments/mainnet.env.example`
- `scripts/write_server_env.sh`
- Focused backend tests under existing backend test directories

**Do not touch:**

- Public site files under `marketing/`
- Operator app files under `app/`
- Route-module refactor work for `P2.3`
- Idempotency storage/replay implementation beyond leaving a clean hook for it

**Close output:** `MUTATION_BACKEND` exists, production defaults to `required`, disabled/unhealthy chain returns `503 chain_backend_required` for the listed money-like routes, and tests cover disabled-chain production mode.

### Package B - P1.1b health truth split

**Suggested branch:** `codex/p1-health-capability-truth`
**Can start:** After Package A exposes or confirms the gateway/mutation mode shape. A design/test stub can start earlier, but final route patch should wait for Package A.
**Blocks:** Operator warnings in Package E.

**Owned finding:** `P1.1b`

**Primary file scope:**

- `mcp-server/src/blockchain/gateway.js`
- `mcp-server/src/protocols/http/server.js` `/health` handler only
- Backend health tests
- Optional small docs update if `/health` response contract is documented

**Do not touch:**

- Money-like route implementation beyond reading the mutation backend status from Package A
- Operator UI warning presentation; leave that to Package E
- Server route refactor

**Close output:** `/health` reports `serviceHealth` separately from `capabilityHealth`, and chain-disabled production reports service-up but treasury capability unavailable.

### Package C - P1.2 account overlay durability

**Suggested branch:** `codex/p1-account-overlay-durability`
**Can start:** Yes for classification and tests. Final implementation should account for Package A/B env naming if needed.
**Blocks:** Package F policy durability can reuse storage patterns, but does not need to wait if it chooses its own service.

**Owned finding:** `P1.2`

**Primary file scope:**

- `mcp-server/src/services/bootstrap.js`
- `mcp-server/src/core/account-mutation-service.js`
- Any new account overlay store/service files
- Backend tests for restart/two-process behavior
- Minimal docs update to this file when field classification is known

**Do not touch:**

- Public site
- Operator frontend
- Policy proposal storage unless explicitly coordinated with Package F
- Broad route refactor

**Close output:** Overlay fields are classified, durable state is moved out of process memory where required, live account fields win over cached overlay fields, and restart tests prove the behavior.

### Package D - P1.3 sync mutation idempotency

**Suggested branch:** `codex/p1-money-route-idempotency`
**Can start:** Design and service tests can start now. Route integration waits until Package A lands to avoid conflicts in the same handlers.
**Blocks:** Enabling sync money-like routes in rc1.

**Owned finding:** `P1.3`

**Primary file scope:**

- Any existing or new idempotency service/storage files
- `mcp-server/src/protocols/http/server.js` money-like route integration only, after Package A lands
- `docs/IDEMPOTENCY.md`
- Backend idempotency tests

**Do not touch:**

- Health response shape
- Account overlay durability
- Public site or operator UI

**Close output:** Money-like routes replay same-key/same-payload responses, reject same-key/different-payload with `409 idempotency_conflict`, and `docs/IDEMPOTENCY.md` no longer says those routes ignore the key.

### Package E - P2.4 operator frontend truth modes

**Suggested branch:** `codex/p2-operator-demo-truth`
**Can start:** Yes, but wire health capability warnings after Package B lands.
**Blocks:** None, but should land before distribution push.

**Owned finding:** `P2.4`

**Primary file scope:**

- `app/` operator pages and shared UI/data hooks
- App env/config files for `NEXT_PUBLIC_DEMO_MODE`
- App tests or visual regression fixtures
- Optional app README/env docs

**Do not touch:**

- Generated `frontend/`
- Backend mutation route logic
- Public marketing site

**Close output:** Operator pages have explicit `live`, `empty`, `degraded`, and `demo` modes; production demo mode is false; demo data cannot appear in production without `NEXT_PUBLIC_DEMO_MODE=true`; demo mode has a persistent banner.

### Package F - P2.5 public site live/example truth

**Suggested branch:** `codex/p2-public-site-proof-feed`
**Can start:** Yes.
**Blocks:** Distribution launch materials.

**Owned finding:** `P2.5`

**Primary file scope:**

- `marketing/src/pages/index.astro`
- `marketing/public/console-stream.js`
- Any new public proof-feed client files under `marketing/`
- Backend public endpoint only if Path A requires a new `/public/recent-receipts` endpoint; coordinate with Package A/B if touching `server.js`
- Public-site tests/build

**Do not touch:**

- Operator app
- Money-like mutation routes
- Generated `site/`

**Close output:** The homepage either uses real public proof data or clearly labels the animation as an example. No deterministic stream is labeled `Live`.

### Package G - P2.5b policy durability

**Suggested branch:** `codex/p2-policy-durability`
**Can start:** After Package C chooses storage pattern, unless this package uses an independent service boundary.
**Blocks:** External operators/posters.

**Owned finding:** `P2.5b`

**Primary file scope:**

- New `PolicyService` files
- `mcp-server/src/protocols/http/server.js` policy route integration only
- Backend policy tests

**Do not touch:**

- Money route handlers
- Health route shape
- Operator UI beyond optional read-only status display agreed with Package E

**Close output:** Policy proposals persist across restart and built-in policies are seed data rather than route-local constants.

### Package H - P3.8 generated-output guard

**Suggested branch:** `codex/p3-generated-output-guard`
**Can start:** Yes.
**Blocks:** Nothing.

**Owned finding:** `P3.8`

**Primary file scope:**

- `scripts/`
- `.github/workflows/` if CI check is chosen
- `AGENTS.md` or `README.md`
- Optional test fixture for guard behavior

**Do not touch:**

- App/site implementation
- Backend route logic
- Generated `frontend/` or `site/` except controlled test fixtures if necessary

**Close output:** Manual changes under `frontend/` and `site/` are rejected by a clear guard unless an explicit bypass is present.

### Package I - Launch docs

**Suggested branch:** `codex/launch-docs-operator-threat`
**Can start:** Yes.
**Blocks:** rc1 tag.

**Owned items:** `OPERATOR_ONBOARDING.md`, `THREAT_MODEL.md`, `FRAMEWORK_AGENT_HANDOFF.md` v2.4 refresh.

**Primary file scope:**

- `docs/OPERATOR_ONBOARDING.md`
- `docs/THREAT_MODEL.md`
- `docs/FRAMEWORK_AGENT_HANDOFF.md`
- Existing spec/docs only where cross-links need updating

**Do not touch:**

- Backend implementation
- Frontend implementation
- Generated deploy output

**Close output:** Operator onboarding and threat model are publishable, and handoff doc reflects the v2.4 trust-core-first plan plus this remediation board.

### Package J - P2.3 server route refactor

**Suggested branch:** `codex/p2-server-route-split`
**Can start:** Only after Packages A, B, C, D, and G land, unless explicitly reprioritized.
**Blocks:** Nothing for rc1 unless the monolith starts blocking fixes.

**Owned finding:** `P2.3`

**Primary file scope:**

- `mcp-server/src/protocols/http/server.js`
- New `mcp-server/src/protocols/http/routes/` modules
- Route integration tests

**Do not touch:**

- Behavior semantics unless already covered by a previous finding
- Frontend/public-site files

**Close output:** `server.js` becomes wiring plus middleware/server lifecycle, route modules own endpoint groups, and endpoint response shapes are preserved.

### Merge order

1. Package A - mutation gate.
2. Package B - health truth.
3. Package D - idempotency route integration, or explicit decision to keep sync money routes disabled for rc1.
4. Package C - account overlay durability.
5. Package E - operator truth modes.
6. Package F - public site live/example truth.
7. Package G - policy durability.
8. Package I - launch docs. Can merge earlier if it does not create stale claims.
9. Package H - generated-output guard. Can merge any time.
10. Package J - route refactor. Prefer after rc1 blockers land.

---

## Execution sequence

Locked ordering for closing audit findings alongside other launch-blocking work. Revisit only if actual implementation shows the route refactor would materially reduce risk.

1. **P1.1 - Mutation backend gate** (~half day). Surgical edits to existing handlers and config.
2. **P1.1b - Health endpoint truth split** (~half day). Reshape `/health`.
3. **P1.3 - Idempotency for money-like routes** (~1 day if service primitives already exist; otherwise 1-2 days). Or explicitly keep sync money routes disabled for rc1.
4. **P1.2 - Account overlay durability migration** (~2-3 days). The load-bearing infrastructure change.
5. **P2.4 - Frontend demo flag with visual indicator** (~1-2 days). Cross-cutting through operator pages.
6. **P2.5 - Public site fake live stream** (~1-2 days depending on Path A/B/C).
7. **P2.5b - Policy state durability** (~1 day). Piggybacks on storage infrastructure from `P1.2`.
8. **`OPERATOR_ONBOARDING.md` and `THREAT_MODEL.md`** (~2-3 days). Can run in parallel with code work.
9. **P3.8 - Generated-output CI guard** (~half day). Small housekeeping pass.
10. **Launch readiness reached.** Tag `v1.0.0-rc1` if companion-document gates are also closed.
11. **P2.3 - Server.js refactor into route modules** (~2-3 days). Could slip post-launch if launch pressure builds.
12. **P3.7 - Authed layout naming/guard** (~half day). Do whenever convenient.
13. **P2.6 - Native XCM observer**. Deferred to v1.x per spec.

### Parallel tracks

- Gating item B from spec: multisig-owns-EVM-contract testnet rehearsal.
- Chopsticks experiment for Bifrost `SetTopic` preservation. Gates v1.x vDOT lane, not rc1.
- Pre-launch distribution content from `DISTRIBUTION_STRATEGY.md`.
- `FRAMEWORK_AGENT_HANDOFF.md` v2.4 refresh.

**Total estimated audit-remediation effort:** about 11-15 days of focused work for steps 1-9, plus parallel launch-readiness tracks.

**Why this sequence:** `P1.1` and `P1.1b` close the truth boundary at API and health layers first. `P1.3` prevents duplicate real mutations before sync money routes become useful. `P1.2` is the storage change that `P2.5b` benefits from. `P2.4` and `P2.5` protect first impressions before distribution. The server refactor waits until after load-bearing behavior is fixed.

**Disagreement noted:** The expanded audit may prioritize the `server.js` refactor earlier. This document defers it because P1 fixes are surgical and the refactor carries merge-conflict risk during a critical pre-launch window. If the actual P1 work proves the monolith is making safe implementation too hard, switch the ordering.

---

## Verification posture

Each remediation has explicit close criteria above. The discipline should match the rest of the project:

- Closing a finding requires explicit verification, not assertion.
- Status changes from `Open` to `Closed` happen in this document with date and commit hash.
- If a remediation cannot close cleanly, the finding stays Open with notes explaining why.
- Schedule a second audit pass once `P1.1`, `P1.1b`, `P1.2`, `P1.3`, `P2.4`, and `P2.5` are closed.

Suggested closure note format:

```md
**Status:** Closed on 2026-MM-DD in `<commit-hash>`.
**Verification:** `<test command or manual verification>`.
**Notes:** `<anything future maintainers need to know>`.
```

---

## Open questions for Pascal

1. **What does the account overlay actually contain?** Closing `P1.2` cleanly depends on knowing whether overlay fields are derived state, off-chain authoritative state, or display-only cache.
2. **Should sync money-like routes be enabled in rc1?** If yes, `P1.3` is launch-blocking. If no, gate them explicitly and move `P1.3` to pre-treasury-live.
3. **Should the homepage console use real public proof data, example labeling, or removal?** Path A is best for the trust pitch; Path B is fastest and honest.
4. **Is `(authed)` intended to be a real frontend guard?** If yes, implement `P3.7` Option A. If no, rename/document.
5. **What is the audit cadence after rc1?** Quarterly re-audits, plus focused re-audits after major treasury/XCM work, is a reasonable baseline.

---

*Last updated: 2026-05-17. Living document - update as findings close.*

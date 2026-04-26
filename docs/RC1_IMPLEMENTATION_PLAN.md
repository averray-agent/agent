# rc1 Implementation Plan

This plan breaks [RC1_WORKING_SPEC.md](RC1_WORKING_SPEC.md) into small,
reviewable PRs. Each slice should leave production bootable, keep deploys
serialized through `main`, and avoid mixing unrelated backend, contract,
indexer, frontend, and docs work.

## Working Rules

- Prefer one ownership boundary per PR.
- Rebase on `origin/main` before opening or queueing PRs.
- Keep generated static `frontend/` and `site/` output out of normal PRs.
- Run the smallest relevant local checks before PR:
  - contracts: `forge test`
  - backend: `npm --workspace mcp-server test`
  - indexer: `npm run typecheck:indexer`
  - operator app: `npm run typecheck:app` and `npm run build:frontend`
  - public site: `npm run build:site`
- Never manually deploy. Merge to `main` is the production deploy trigger.

## Critical Path

The shortest path to a coherent rc1 launch is:

1. Reconcile the contract architecture with the v1.4 spec.
2. Make dispute deadlines and arbitration SLA enforceable on-chain.
3. Wire backend/indexer/operator dispute handling to the on-chain dispute path.
4. Ship content-addressed storage and disclosure reads.
5. Ship bootstrap instrumentation and upstream status polling.
6. Ship claim economics and onboarding waivers.
7. Lock down maintainer-surface controls.
8. Finish the XCM assembler and SetTopic correlation gate before any vDOT
   mainnet allocation.

## PR Slices

### 0. Roadmap Artifacts

**Status:** started.

**Goal:** make the spec executable and discoverable.

**Changes:**

- Add this implementation plan.
- Add `docs/DISPUTE_CODES.md` as the reason-code registry referenced by the
  spec.
- Link both from existing roadmap/pre-launch docs where useful.

**Checks:** `git diff --check`.

### 1. Contract Architecture Reconciliation

**Goal:** align the deployed rc1 backbone code with v1.4's target architecture:
one new `DiscoveryRegistry`, verifier history inside the existing policy role
surface, and disclosure events on the existing session lifecycle surface.

**Changes:**

- Extend `TreasuryPolicy` verifier state with `authorizedSince`,
  `authorizedUntil`, and `wasAuthorizedAt(address,uint64)`.
- Make `setVerifier(address,bool)` write historical windows.
- Move verifier authorization checks in `EscrowCore` to the reconciled policy
  surface.
- Move `Disclosed` / `AutoDisclosed` events to `EscrowCore` or the session
  lifecycle contract that emits `Submitted` and `Verified`.
- Remove, deprecate, or clearly quarantine any now-superseded
  `VerifierRegistry` / `DisclosureLog` deployment dependencies.
- Update deployment scripts, verification scripts, ABIs, indexer config, and
  backend env handling.

**Checks:** `forge test`, `npm --workspace mcp-server test`,
`npm run typecheck:indexer`.

### 2. Dispute Deadline And SLA Contracts

**Goal:** prevent both late disputes and indefinitely locked disputed jobs.

**Changes:**

- Add `rejectedAt` / `disputedAt` timestamps or equivalent state.
- Bump `DISPUTE_WINDOW` from 1 day to 7 days.
- Make `openDispute` revert after `rejectedAt + DISPUTE_WINDOW`.
- Add `ARBITRATOR_SLA = 14 days`.
- Add permissionless `autoResolveOnTimeout(jobId)` that pays the worker the
  remaining available reward and returns claim stake with `ARB_TIMEOUT`.
- Add `DisputeResolved` / `AutoResolvedOnTimeout` events with reason code and
  metadata hash/URI as appropriate.
- Update Solidity tests for boundary timestamps and payout/stake behavior.

**Checks:** `forge test`, then indexer typecheck if ABI/schema updates are in
the same PR.

### 3. Dispute Backend And Operator Wiring

**Goal:** make the existing operator dispute UI/API execute the contract flow
instead of only recording receipts.

**Changes:**

- Wire `POST /disputes/:id/verdict` to call
  `EscrowCore.resolveDispute`.
- Decide whether `/disputes/:id/release` remains a local operator receipt or
  becomes a specialized contract settlement path.
- Store arbitrator reasoning as content-addressed payloads.
- Show `disputedAt`, SLA countdown, reason code, and on-chain transaction
  status in the operator app.
- Add backend tests for upheld, overturned, partial, and timeout-shaped
  outcomes.

**Checks:** `npm --workspace mcp-server test`, `npm run typecheck:app`,
`npm run build:frontend`.

### 4. Content Addressing And Disclosure Reads

**Goal:** make `/content/:hash` real before receipts depend on it.

**Changes:**

- Store canonical JSON payloads by `sha256(canonicalJSON(payload))`.
- Add append-only recovery log writer.
- Add disclosure records and read-time visibility logic.
- Emit lazy `AutoDisclosed` once when private content crosses
  `auto_public_at`.
- Add cache-control behavior for private-window and public content.

**Checks:** `npm --workspace mcp-server test`, plus indexer checks if new events
land here.

### 5. Bootstrap Instrumentation

**Goal:** make the week-12 gate measurable before funded jobs begin.

**Changes:**

- Add `funded_jobs` storage/model.
- Add daily GitHub and MediaWiki upstream status pollers.
- Track final statuses: `merged`, `closed_unmerged`, `open_stale`,
  `reverted`.
- Add weekly self-report generation with merge rate, spend, receipts, and top
  close reasons.

**Checks:** `npm --workspace mcp-server test`.

### 6. Claim Economics And Onboarding Waivers

**Goal:** implement the two claim-time primitives from the spec without
confusing stake and fee.

**Changes:**

- Add first-3-jobs stake/fee waiver per wallet.
- Add claim fee `max(2% of payout, $0.05)` after waiver.
- Refund claim fee on verified success.
- Slash fee on no-show or rejected submission and split 70% verifier / 30%
  platform treasury.
- Keep existing claim stake semantics as the substantive bond.

**Checks:** `forge test`, `npm --workspace mcp-server test`, indexer typecheck
if new events are indexed.

### 7. Maintainer-Surface Controls

**Goal:** reduce external ecosystem risk before public job sourcing scales.

**Changes:**

- Add denylist with security/standards seeds.
- Add CONTRIBUTING/AI-policy scanner for repo intake.
- Enforce per-repo open PR cap of 3.
- Inject non-removable disclosure footer into PR/edit bodies.
- Implement "respect the no" denylist workflow.

**Checks:** `npm --workspace mcp-server test`, frontend checks if operator UI
surfaces controls.

### 8. XCM SetTopic Validation

**Goal:** prevent queuing XCM payloads that cannot be correlated to the local
request.

**Changes:**

- Define the exact canonical SCALE message suffix produced by the backend
  assembler.
- Add `XcmWrapper.queueRequest` validation that the message commits to
  `SetTopic(requestId)`.
- Add fixed test vectors for deposit and withdraw messages.
- Keep async treasury endpoints admin-gated until the backend assembler exists.

**Checks:** `forge test`.

### 9. Backend SCALE Assembler

**Goal:** replace caller-supplied raw XCM bytes with server-controlled intent
routing.

**Changes:**

- Add `mcp-server/src/blockchain/xcm-message-builder.js` or equivalent.
- Replace HTTP `destination` / `message` inputs with intent:
  `{ strategyId, direction, amount }`.
- Backend assigns nonce, mirrors `previewRequestId(context)`, appends
  `SetTopic(requestId)`, and submits assembled bytes.
- Add builder test vectors and staging smoke scripts.

**Checks:** `npm --workspace mcp-server test`, `forge test` if vectors touch
contract validation.

### 10. Native XCM Observer Correlation Gate

**Goal:** prove the vDOT lane can settle without manual operator guesswork.

**Changes:**

- Run Chopsticks experiment for Bifrost reply-leg topic preservation.
- If preserved, match return leg by topic.
- If not preserved but Hub credit events are unambiguous, use serialized
  per-strategy dispatch.
- Document the selected fallback before production volume.

**Checks:** staging proof per `ASYNC_XCM_STAGING.md`; backend tests for watcher
logic.

### 11. Yield Portfolio V2 Planning

**Goal:** prepare but not launch higher-risk yield and borrow surfaces.

**Changes:**

- Draft `HydrationGdotAdapter` design doc.
- Draft Hydration money-market borrow migration design.
- Define opt-in UX and risk disclosure before any implementation.

**Checks:** docs only until implementation begins.

## Suggested Starting Order

1. Land slice 0 immediately.
2. Do slice 1 before adding more contract features, because it removes the
   architecture mismatch between the current rc1 backbone and the v1.4 spec.
3. Do slice 2 next; dispute windows and SLA prevent locked-value edge cases.
4. Do slice 3 so the operator flow uses the actual on-chain state machine.
5. Defer XCM implementation slices until the contract/dispute backbone is
   coherent and content receipts are stable.

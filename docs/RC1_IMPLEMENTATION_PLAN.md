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

1. Reconcile the contract architecture with the v1.10 spec.
2. Make dispute deadlines and arbitration SLA enforceable on-chain.
3. Wire backend/indexer/operator dispute handling to the on-chain dispute path.
4. Ship content-addressed storage and disclosure reads.
5. Ship bootstrap instrumentation and upstream status polling.
6. Ship claim economics and onboarding waivers.
7. Lock down maintainer-surface controls.
8. Finish the XCM assembler and SetTopic correlation gate before any vDOT
   mainnet allocation.

## Current Position

As of this branch, **slice 10: Native XCM Observer Correlation Gate** is
implemented as a machine-checkable staging gate. The three-artifact
deposit/withdraw/failure evidence-pack checker and operator capture runbook are
in place; the next operational step is running the real Chopsticks/PAPI capture
and saving the artifacts before any vDOT mainnet allocation.

Completed and deployed in this lane:

- canonical `/content/:hash` storage and read-time visibility
- append-only content recovery log
- early owner/admin publish for private content
- recovery-log replay CLI
- operator recovery runbook in
  [CONTENT_RECOVERY_RUNBOOK.md](./CONTENT_RECOVERY_RUNBOOK.md)
- on-chain `Disclosed` / `AutoDisclosed` events from `EscrowCore`
- backend calls that emit `Disclosed` on early publish and lazily emit
  `AutoDisclosed` on first auto-public read
- `discloseFor(hash, byWallet)` requires the rc1 contract redeploy; until then
  the backend reports `chain_write_failed` for that event while still serving
  content normally
- `funded_jobs` records are now written on claim, enriched on submission and
  verification, and polled against upstream GitHub/MediaWiki status
- weekly bootstrap self-report generation exists as a backend service/CLI
- native XCM evidence now distinguishes SetTopic/request-id correlation,
  remote-ref correlation, and staging-only ledger joins
- deposit, withdraw, and failure evidence packs can be checked together before
  promoting the native observer
- native XCM evidence capture now has an operator runbook and can emit a
  decision record from the evidence-pack checker
- decoded PAPI/Chopsticks/block-explorer events can be normalized into the raw
  `hub.json` / `bifrost.json` inputs required by the evidence assembler
- testnet deploy wiring can now emit `XCM_WRAPPER_ADDRESS` plus an async
  `polkadot_vdot` strategy manifest for capture rehearsals
- native XCM capture now has a preflight gate that rejects scaffolded vDOT
  builder output and missing PAPI/Chopsticks tooling before evidence is promoted

Still open in the broader rc1 path:

- scheduler/email hardening for weekly reports after enough real jobs exist
- real Chopsticks/PAPI native XCM evidence capture and selected fallback
  documentation if Bifrost does not preserve SetTopic
- running the real staged deposit, withdraw, and failure captures with the
  server-owned PAPI/ParaSpell-shaped builder output

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

**Goal:** align the deployed rc1 backbone code with the target architecture:
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

**Status:** implemented; future PRs may refine decentralized mirrors, but the
rc1 API, recovery, visibility, cache-control, and disclosure event path are
shipped.

**Goal:** make `/content/:hash` real before receipts depend on it.

**Changes:**

- [x] Store canonical JSON payloads by `sha256(canonicalJSON(payload))`.
- [x] Add append-only recovery log writer.
- [x] Add recovery-log replay CLI and operator runbook.
- [x] Add disclosure records and read-time visibility logic.
- [x] Emit lazy `AutoDisclosed` once when private content crosses
  `auto_public_at`.
- [x] Add cache-control behavior for private-window and public content.

**Checks:** `npm --workspace mcp-server test`, plus indexer checks if new events
land here.

### 5. Bootstrap Instrumentation

**Status:** in progress; funded-job storage, upstream polling, and report
generation are implemented as backend foundations.

**Goal:** make the week-12 gate measurable before funded jobs begin.

**Changes:**

- [x] Add `funded_jobs` storage/model.
- [x] Add daily-capable GitHub and MediaWiki upstream status pollers.
- [x] Track final statuses: `merged`, `closed_unmerged`, `open_stale`,
  `reverted`.
- [x] Add weekly self-report generation with merge rate, spend, receipts, and top
  close reasons.
- [ ] Wire scheduled email delivery once report recipients and cadence are
  finalized.

**Checks:** `npm --workspace mcp-server test`.

### 6. Claim Economics And Onboarding Waivers

**Status:** implemented; contract, backend, indexer, and session-surface
foundations are implemented in this slice.

**Goal:** implement the two claim-time primitives from the spec without
confusing stake and fee.

**Changes:**

- [x] Add first-3-jobs stake/fee waiver per wallet.
- [x] Add claim fee `max(2% of payout, $0.05)` after waiver.
- [x] Refund claim fee on verified success.
- [x] Slash fee on no-show or rejected submission and split 70% verifier / 30%
  platform treasury.
- [x] Keep existing claim stake semantics as the substantive bond.
- [x] Index claim fee state and claim-fee slashing events.

**Checks:** `forge test`, `npm --workspace mcp-server test`, indexer typecheck
if new events are indexed.

### 7. Maintainer-Surface Controls

**Status:** implemented; backend intake/submission/verifier foundations are
implemented in this slice.

**Goal:** reduce external ecosystem risk before public job sourcing scales.

**Changes:**

- [x] Add denylist with security/standards seeds.
- [x] Add CONTRIBUTING/AI-policy scanner for repo intake.
- [x] Enforce per-repo open PR cap of 3.
- [x] Inject non-removable disclosure footer into PR/edit bodies.
- [x] Implement "respect the no" denylist workflow.

**Checks:** `npm --workspace mcp-server test`, frontend checks if operator UI
surfaces controls.

### 8. XCM SetTopic Validation

**Status:** implemented in this branch.

**Goal:** prevent queuing XCM payloads that cannot be correlated to the local
request.

**Changes:**

- [x] Define the exact canonical SCALE message suffix produced by the backend
  assembler.
- [x] Add `XcmWrapper.queueRequest` validation that the message commits to
  `SetTopic(requestId)`.
- [x] Add fixed test vectors for deposit and withdraw messages.
- [x] Keep async treasury endpoints admin-gated until the backend assembler exists.

**Checks:** `forge test`.

### 9. Backend SCALE Assembler

**Status:** implemented in this branch.

**Goal:** replace caller-supplied raw XCM bytes with server-controlled intent
routing.

**Changes:**

- [x] Add `mcp-server/src/blockchain/xcm-message-builder.js` or equivalent.
- [x] Replace HTTP `destination` / `message` inputs with intent:
  `{ strategyId, direction, amount }`.
- [x] Backend assigns nonce, mirrors `previewRequestId(context)`, appends
  `SetTopic(requestId)`, and submits assembled bytes.
- [x] Add builder test vectors and HTTP smoke coverage for rejecting raw XCM bytes.

**Checks:** `npm --workspace mcp-server test`, `forge test` if vectors touch
contract validation.

### 10. Native XCM Observer Correlation Gate

**Status:** implemented as a machine-checkable staging gate; real
Chopsticks/PAPI evidence still needs to be captured before vDOT mainnet
allocation.

**Goal:** prove the vDOT lane can settle without manual operator guesswork.

**Changes:**

- [x] Make captured evidence distinguish SetTopic/request-id correlation,
  remote-ref correlation, and staging-only ledger joins.
- [x] Reject promoted `ledger_join` evidence and require
  `messageTopic == requestId` for production-candidate SetTopic evidence.
- [x] Add a three-artifact pack gate for deposit, withdraw, and failure
  evidence.
- [x] Add an operator runbook for capturing Hub/Bifrost evidence and producing
  the promotion decision record.
- [x] Add a decoded-event extractor for producing `hub.json` / `bifrost.json`
  capture inputs from PAPI, Chopsticks, or block-explorer event JSON.
- [x] Add testnet/staging deploy wiring for `XcmWrapper` plus
  `XcmVdotAdapter`; keep it blocked on mainnet until evidence passes.
- [x] Add native capture preflight so scaffolded builder output cannot be
  mistaken for real evidence.
- [x] Replace raw vDOT message-prefix config with server-owned
  PAPI/ParaSpell-shaped XCM v5 assembly and SetTopic injection.
- [ ] Produce the final Bifrost deposit, withdraw, and failure rehearsal
  captures with the backend builder output.
- [ ] Run Chopsticks experiment for Bifrost reply-leg topic preservation.
- [ ] If preserved, match return leg by topic.
- [ ] If not preserved but Hub credit events are unambiguous, use serialized
  per-strategy dispatch.
- [ ] Document the selected fallback before production volume.

**Checks:** staging proof per `ASYNC_XCM_STAGING.md`; backend tests for watcher
logic.

### 11. Yield Portfolio V2 Planning

**Status:** implemented as planning artifacts. No runtime strategy or credit
rail changes are included.

**Goal:** prepare but not launch higher-risk yield and borrow surfaces.

**Changes:**

- [x] Draft `HydrationGdotAdapter` design doc.
- [x] Draft Hydration money-market borrow migration design.
- [x] Define opt-in UX and risk disclosure before any implementation.
- [ ] Implement only after vDOT native observer evidence is captured and the
  GDOT/Hydration evidence gates are specified.

**Checks:** docs only until implementation begins.

## Suggested Starting Order

1. Land slice 0 immediately.
2. Do slice 1 before adding more contract features, because it removes the
   architecture mismatch between the initial rc1 backbone and the target spec.
3. Do slice 2 next; dispute windows and SLA prevent locked-value edge cases.
4. Do slice 3 so the operator flow uses the actual on-chain state machine.
5. Do slice 10 before any vDOT mainnet allocation: the assembler is shipped,
   but Bifrost reply-leg correlation still needs staging proof.

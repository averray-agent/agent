# Mainnet Audit 2 — Contract Remediation Board & Codex Hand-off

**Audit dated 2026-07-02 · Verdict: Medium-High — mainnet gated on remediation.**
The second external smart-contract security audit returned **0 Critical · 2 High · 8 Medium · 15 Low · 5 Informational**. The audit used an adversarial multi-agent method; we then ran an **independent line-by-line code re-verification** of every finding against the live contract source. All 30 findings are represented below at their *verified* verdict — 29 CONFIRMED, 1 PARTIAL (H-1, whose sub-claim (a) is overstated but whose net effect holds), and 0 refuted. **Every contract fix is Codex-owned.** None are exploitable on the closed testnet beta (test USDC, trusted testers, uncompromised signer); they are mainnet / real-funds gates.

---

## ⚠ LAUNCH-CRITICAL — H-1: the daily-outflow circuit-breaker meters the wrong thing

**This is the single most important item on the board and it changes the guarded-launch story in `LAUNCH_CRITICAL_PATH.md`.**

The daily-outflow circuit-breaker (`TreasuryPolicy.recordOutflow` / `dailyOutflowCap`) is **metering internal book-transfers, not real ERC20 egress**:

- **`withdraw()`** — the primary path that actually `SafeTransfer`s tokens *out* of the contract — **never calls `recordOutflow`.** (So do the transferred legs of `slashJobStake` / `slashClaimFee`, which move real tokens and are also unmetered.)
- **`settleReservedTo()`** — a pure `reserved → liquid/debt` book-move where **tokens never leave the contract** — **does** call `recordOutflow(amount)` and inflates the single global `outflowToday` counter.

Two consequences, both bad:

1. **A finite `dailyOutflowCap` does NOT cap capital flight.** Real withdrawals are never metered, so an attacker (or a compromised operator draining balances) draws down the contract with the cap fully inert against them.
2. **A finite cap self-DoSes settlement.** Because internal settlement volume inflates the same global counter, once `outflowToday > dailyOutflowCap` **every** `recordOutflow`-calling path (`settleReservedTo`, the treasury legs of both slash paths) reverts with `OutflowCapExceeded` until UTC midnight — halting honest settlement while doing nothing to stop egress.

**Explicit correction to the prior board:** audit-1 item **C-01 ("set a finite `dailyOutflowCap`")** is **NOT a valid mitigation as the breaker is currently wired.** Setting the cap is worse than leaving it open — it arms a settlement-halt footgun without arming any egress protection. C-01 must be treated as **superseded and RE-IMPLEMENTED**, not merely "set the value." The re-implementation, which must land **before any finite cap is enabled**, is:

- **Meter real egress only:** call `recordOutflow` from `withdraw` and from the *transferred* legs of `slashJobStake` / `slashClaimFee`.
- **Stop metering internal book-moves:** remove `recordOutflow` from `settleReservedTo` and from the trapped treasury legs (tokens-stay-in-contract paths).
- **Make a breach non-fatal to internal accounting:** a settlement-volume or egress breach must not brick settlement — prefer a **per-account** meter and/or a non-reverting throttle over the single global reverting counter.
- **Split + restrict the `serviceOperators` role** (see Architectural section) so the arming of a finite cap does not simultaneously widen attack surface.

Only after this re-wire is a finite `dailyOutflowCap` a genuine guardrail. This directly rewrites the "ship capped, then set finite caps" line in the guarded-launch profile.

---

## High (2)

| ID | Verified location | Verdict | Prior board | Owner | Remediation |
|----|-------------------|---------|-------------|-------|-------------|
| **H-1** | `AgentAccountCore.sol` `withdraw`:223-229; `settleReservedTo`:304-328 (`recordOutflow`:319); `slashJobStake`:580-606 (:602); `slashClaimFee`:608-634 (:630); `TreasuryPolicy.recordOutflow`:254-264 | **PARTIAL** (sub-claim (a) overstated — `withdraw` is not the *only* real egress; slash-transfer legs also egress unmetered; net effect (b)-(e) fully holds) | **supersedes C-01** | Codex | Call `recordOutflow` only from real-egress paths (`withdraw` + the transferred slash legs); remove it from tokens-stay-in-contract book-moves (`settleReservedTo`, trapped treasury legs) so the cap tracks real egress, not internal accounting. |
| **H-2** | `AgentAccountCore.sol` `slashJobStake`:580-606; `slashClaimFee`:608-634; `EscrowCore.handleClaimTimeout`:516-525 (:525) | **CONFIRMED** | **= C-02** | Codex | Route `treasuryAmount` to a real destination — credit a designated treasury account's liquid balance (or `SafeTransfer` to a treasury address) inside the slash paths, or add an owner-gated treasury sweep — so slashed treasury portions and full claim-timeout fees are recoverable instead of permanently trapped. |

### H-1 — Acceptance criteria
- `withdraw()` calls `policy.recordOutflow(amount)` on the real ERC20 egress; the transferred legs of `slashJobStake`/`slashClaimFee` also record their transferred amounts.
- `settleReservedTo()` no longer calls `recordOutflow` (a `reserved → liquid/debt` book-move records nothing); trapped treasury legs record nothing (they move no tokens — resolved jointly with H-2).
- Foundry test: driving `settleReservedTo` volume past a finite `dailyOutflowCap` does **not** revert any settlement.
- Foundry test: cumulative `withdraw` egress past a finite `dailyOutflowCap` **does** trip the breaker.
- The breach path does not brick internal accounting (per-account meter and/or non-reverting throttle), and the `serviceOperators` role has been split before the finite cap is armed.

### H-2 — Acceptance criteria
- After `slashJobStake` / `slashClaimFee`, the `treasuryAmount` is credited to a designated treasury account's liquid balance or transferred to a treasury address — never left as an orphaned contract balance.
- `handleClaimTimeout` (which passes `verifierRecipient == address(0)`, making `treasuryAmount == full claimFee`) results in the full fee being recoverable, not trapped.
- Repo invariant restored: no path decrements `jobStakeLocked` without either an external transfer or a credited liquid balance for the full slashed amount.
- Foundry test: slash + claim-timeout scenarios end with total accounted balance == contract token balance (no orphaned residue).

---

## Medium (8)

| ID | Contract | Verified location | Verdict | Prior board | Owner | One-line remediation |
|----|----------|-------------------|---------|-------------|-------|----------------------|
| **M-1** | AgentAccountCore | `reserveForJob`:237-238, `reserveForRecurringTemplate`:252-253, `lockCollateral`:513-514, `lockJobStake`:556-557 (raw `liquid < amount`); `_requireWithdrawable`:746-748 | CONFIRMED | new | Codex | Route the four raw-liquid guards through the debt-aware check (`liquid − debtOutstanding`) so borrowed debt isn't double-counted as spendable across reserved/collateral/jobStake buckets. |
| **M-2** | EscrowCore | `autoResolveOnTimeout`:691-702 → `_resolveDispute`:704-727 | CONFIRMED | **= C-17** | Codex | Cap the permissionless arbitrator-timeout payout below the full remainder and suppress the merit-free reputation-badge + stake/fee release, so a delinquent arbitrator can't become a free full worker payout. |
| **M-3** | EscrowCore | `createMilestoneJob`:388-434 (bound :400); `resolveMilestone`:582-637 (settle :611) | CONFIRMED | new | Codex | Reject any `milestones[i] == 0` in `createMilestoneJob` so a zero-amount milestone can't wedge the job (settle reverts `ZeroAmount`, `allReleased` never satisfies, job never closes). |
| **M-4** | XcmWrapper | `finalizeRequest`:145-179 (modifier :152; first-write :160-169; `InvalidTransition` :178) | CONFIRMED | new | Codex | Bind the finalizer to the queue-time caller (store `queuedBy` in `queueRequest`, require `msg.sender == queuedBy` or owner) and validate `settledAssets ≤ context.assets` / `settledShares ≤ context.shares` before latching, so one bad operator can't pre-latch a wrong outcome and wedge the legit finalize. |
| **M-5** | XcmVdotAdapter | `settleRequest`:174-187 | CONFIRMED | new | Codex | Bind minted shares to an on-chain per-strategy price/decimal invariant (stored price-per-share / first-deposit ratio, or derive on-chain from `settledAssets` with explicit 6dp↔18dp scaling) instead of trusting an arbitrary operator-supplied `(assets, shares)` ratio. |
| **M-6** | XcmVdotAdapter | `settleRequest`:165 (`whenNotPaused`); refund :189 | CONFIRMED | **= C-13** | Codex | Provide a pause-independent (or owner-gated emergency) refund/settlement path for already-queued strategy deposits so pausing doesn't trap in-flight deposits and make refunds unreachable (XCM-path analog of C-13). |
| **M-7** | StrategyAdapterRegistry | `registerStrategy`:37-52 | CONFIRMED | new | Codex | In `registerStrategy`, revert if `strategyKnown[id] && strategies[id].adapter != adapter` — forbid silently re-pointing an existing `strategyId` to a different adapter/asset; require an explicit deactivate/migrate flow. |
| **M-8** | EscrowCore | `_computeClaimEconomics`:812-836 (stake :830-831); `resolveMilestone` re-Claim :633-636; `handleClaimTimeout`:516-538 (slash :521-522) | CONFIRMED | new | Codex | On the partial-release re-Claim path in `resolveMilestone`, re-scope `job.claimStake` (re-lock/refund the delta) to the remaining unreleased reward (`job.reward − job.released`) so at-risk stake tracks outstanding work, not the full original reward. |

---

## Low (15)

| ID | Finding | Location | Prior board | One-line fix |
|----|---------|----------|-------------|--------------|
| **L-1** | `dailyOutflowCap` / `perAccountBorrowCap` default to `type(uint256).max` — guardrails inert until set | `TreasuryPolicy.sol` ctor:73-74 | **= C-01 (defaults)** | Set finite caps post-deploy — **but note H-1: do NOT arm `dailyOutflowCap` until the breaker is re-wired to meter real egress.** |
| **L-2** | If AAC isn't a registered `serviceOperator`, every settlement/slash reverts `Unauthorized()` — silent deploy dependency | `TreasuryPolicy.recordOutflow`:254-255 (callers AAC:319,602,630) | **= C-03** | Add a deploy-script assertion + post-deploy verification that AAC is `setServiceOperator`-registered before enabling settlement/slash. |
| **L-3** | `workerClaimCount` never restored on timeout → a timed-out claim permanently burns an onboarding-waiver slot | `EscrowCore.handleClaimTimeout`:516-538 | **= C-18** | Decrement `workerClaimCount[job.worker]` (guard underflow) before clearing `job.worker`. |
| **L-4** | `SafeTransfer` to a codeless address returns `ok=true` with empty data → silently "succeeds" | `SafeTransfer.sol` `_checkResult`:29-36 (call site :14-15) | new | Add an `extcodesize > 0` check before the low-level call when return data is empty, so codeless-address transfers revert. |
| **L-5** | XcmWrapper request has no expiry/cancel; only lifecycle exit is operator-called `finalizeRequest` → never-settled requests stuck `Pending` forever | `XcmWrapper.sol` `finalizeRequest`:145-179 (no expiry path in file) | **= C-09** | Add an expiry deadline or owner/user-callable `cancelRequest` (`Pending → Cancelled` after `createdAt + TTL`). |
| **L-6** | XcmWrapper binds only `keccak256(destination/message)`; instruction skippers never decode asset/amount/beneficiary vs `context` → mismatched XCM payload still dispatches | `XcmWrapper.sol` `queueRequest`:94-143 (:106-107); `_validateSetTopic`:247-280; `_skipSupportedInstruction`:312-327 | new | Decode `WithdrawAsset`/`PayFees`/`DepositAsset` and assert encoded asset/amount/beneficiary == `context.asset`/`context.assets`/`context.recipient` before dispatch. |
| **L-7** | `policy.approvedStrategies(adapter)` checked only at register time; de-approving in TreasuryPolicy doesn't flip `strategies[id].active` | `StrategyAdapterRegistry` `registerStrategy`:38 / `getStrategy`:59-61 / `setStrategyActive`:54-57 | new | Compute effective-active at read time — treat a strategy inactive when `policy.approvedStrategies(adapter)` is false. |
| **L-8** | `registerStrategy` never checks `policy.approvedAssets` → a strategy with an unapproved/arbitrary asset registers active | `StrategyAdapterRegistry` `registerStrategy`:38,47 | new | Add `if (!policy.approvedAssets(assetAddr)) revert StrategyNotApproved();` after reading the adapter's asset. |
| **L-9** | `requestStrategyWithdraw` gated by `onlyOwnerOrOperator`; `params.recipient` passed straight through → an operator can redirect an account's redeemed assets to an arbitrary address | `AgentAccountCore.sol` `requestStrategyWithdraw`:407-448 | new | Restrict operator-initiated withdrawal recipient to the account itself (or an owner-preauthorized allowlist). |
| **L-10** | `updateReputation` overwrites the whole `ReputationView` each call with hardcoded constants → scores reset, not accumulated | `ReputationSBT.sol` `updateReputation`:78-81 | new | Accumulate (`skill += skill`, `reliability += reliability`, `economic += economic`) instead of full-struct overwrite. |
| **L-11** | `settleReservedTo` silently offsets recipient debt inside a settlement; only gross `ReservationSettled` emitted, no debt-repayment event | `AgentAccountCore.sol` `settleReservedTo`:320-326 | new | Emit a distinct debt-repayment event (reuse `Repaid`) for the `debtPaid` portion, or branch/document so auto-repay is observable. |
| **L-12** | `borrow` credits liquid that isn't net-spendable (all exits use debt-aware `_requireWithdrawable`) and there's no liquidation/seizure path → lending is half-wired | `AgentAccountCore.sol` `borrow`:529-536 | new | Either finish lending (add liquidation + make borrowed liquid spendable) or remove `borrow`/`repay`/`debtOutstanding` until lending is needed. |
| **L-13** | `deposit` credits full `amount` before `safeTransferFrom`, never measures balance delta → fee-on-transfer/rebasing token over-credits depositor | `AgentAccountCore.sol` `deposit`:216-221 | new | Measure `balanceOf(this)` before/after and credit only the received delta, or enforce/document standard non-deductive ERC20 only. |
| **L-14** | `setPublisher` is single-step (non-zero check only), no two-step/timelock/recovery → a bad rotation is unrecoverable | `DiscoveryRegistry.sol` `setPublisher`:36-40 | new | Add two-step `setPendingPublisher` + `acceptPublisher` (or an owner/timelock recovery path). |
| **L-15** | `verifierAuthorizationWindows` grows unbounded on repeated on/off toggles; `wasAuthorizedAt` linear-loops → view gas-DoS (view-only audit helper, no fund path reads it) | `TreasuryPolicy.sol`:39; `setVerifier`:140-160; `wasAuthorizedAt`:175-183 | new | Cap/coalesce windows (reuse the last open window on re-auth, or bound array length); low priority — not on any fund-moving path. |

---

## Informational (5)

- **I-1** — `SafeTransfer._checkResult`:34-35 rejects any return payload not exactly 32 clean bytes (`data.length != 32` + `abi.decode(bool)` on dirty word reverts). *Intentional strictness; document, or mask the low byte if broader token compatibility is wanted.*
- **I-2** — `SafeTransfer.safeApprove`:24-27 issues a single `approve(spender, amount)` with no reset-to-zero-first pattern → USDT-style tokens that require zeroing first would revert. *Add a reset-to-zero-then-set sequence if such approvals are needed, else document.*
- **I-3** — `XcmWrapper._decodeCompactU32`:282-310 rejects SCALE compact mode 3 for instruction/asset counts (`_skipCompact` does handle mode 3 for amounts). *Benign — XCM counts never need mode-3 encoding; optionally document the mode 0-2 constraint.*
- **I-4** — `ReputationSBT.updateReputation`:78-81 has no `account != address(0)` guard and stores 6-decimal `economic` (job.reward) alongside dimensionless `skill`/`reliability` constants in one struct. *Add a zero-address check and normalize/document the `economic` unit.*
- **I-5** — `StrategyAdapterRegistry.setStrategyActive`:54-57 has no `strategyKnown` guard → for an unknown id it materializes a phantom `StrategyMetadata` (adapter/asset zero, `active=true`) and emits a misleading event. *Guard with `if (!strategyKnown[strategyId]) revert StrategyNotApproved();`.*

---

## Reconciliation with the audit-1 board

To prevent double-tracking between this board and `MAINNET_AUDIT_REMEDIATION.md`, each audit-2 item is classified as **superseding**, **confirming (= same finding)**, or **genuinely new**. Where an audit-2 item covers an audit-1 row, close it *here* and mark the audit-1 row as reconciled — do not remediate twice. (Audit-1's **C-01** legitimately spans two rows below — **H-1** re-implements the breaker and **L-1** sets finite values *after* that re-wire; this is a split of C-01's two facets, not double-tracking.)

| Audit-2 ID | Relationship | Audit-1 item | Note |
|-----------|--------------|--------------|------|
| **H-1** | **supersedes** | **C-01** | C-01's "set the cap" is invalid as wired; H-1 re-implements the breaker (meter real egress, not internal book-moves). C-01 must NOT be closed by setting a value. |
| **H-2** | **= (confirms)** | **C-02** | Same trapped-treasury-portion finding; audit-2 adds the confirmed claim-timeout full-fee trap (`verifierRecipient == address(0)`). |
| **M-2** | **= (confirms)** | **C-17** | Same `autoResolveOnTimeout`-favors-worker finding; audit-2 upgrades severity to Medium and adds the merit-free reputation-badge concern. |
| **M-6** | **= (confirms)** | **C-13** | XCM-path analog of the audit-1 "pause blocks slashing/refunds" class — pausing traps in-flight strategy deposits. |
| **L-1** | **= (confirms, defaults)** | **C-01** (defaults) | The `type(uint256).max` default caps. Gated on the H-1 re-wire before any finite value is armed. |
| **L-2** | **= (confirms)** | **C-03** | Same "AAC must be `serviceOperator` or slashing reverts" silent deploy dependency. |
| **L-3** | **= (confirms)** | **C-18** | Same `workerClaimCount` never-decremented onboarding-waiver burn. |
| **L-5** | **= (confirms)** | **C-09** | Same "XcmWrapper request ledger has no expiry" finding. |

**Genuinely NEW in audit-2 (not on the audit-1 board — track only here):**
`M-1` (debt double-count across buckets) · `M-3` (zero-amount milestone wedges job) · `M-4` (XcmWrapper finalizer not bound to queue-time caller + no amount validation) · `M-5` (operator-echoed share price / no on-chain decimal normalization) · `M-7` (registry silent adapter re-point) · `M-8` (claim stake not re-scoped after partial milestone release) · `L-4` (`SafeTransfer` to codeless address silently succeeds) · `L-6` (XcmWrapper trusts raw XCM bytes, no asset/amount/beneficiary decode) · `L-7` (registry doesn't propagate TreasuryPolicy de-approval) · `L-8` (registry doesn't validate `approvedAssets`) · `L-9` (operator can redirect strategy-withdraw recipient) · `L-10` (reputation overwrite not accumulate) · `L-11` (silent debt repay inside settlement, no event) · `L-12` (half-wired lending, no liquidation) · `L-13` (fee-on-transfer over-credit on deposit) · `L-14` (single-step publisher rotation) · `L-15` (unbounded verifier-window view DoS) · `I-1`, `I-2`, `I-3`, `I-4`, `I-5`.

---

## Codex hand-off — prioritized work list

**All fixes below can be WRITTEN and Foundry-tested now.** Only the on-chain redeploy waits on the current Paseo Asset Hub testnet halt — do not block the code work on the chain.

### 1. H-1 — re-wire the outflow breaker *(LAUNCH-CRITICAL; do before arming any finite cap)*
- **`AgentAccountCore.withdraw` (:223-229):** add `policy.recordOutflow(amount)` on the real ERC20 egress. Add the same to the *transferred* legs of `slashJobStake` (:599) and `slashClaimFee` (:627).
- **`AgentAccountCore.settleReservedTo` (:319):** remove the `recordOutflow(amount)` call — this is a book-move, tokens stay in-contract.
- **`TreasuryPolicy.recordOutflow` (:254-264):** move from a single global reverting `outflowToday` to a **per-account** meter and/or a non-reverting throttle so a breach cannot brick settlement.
- **Test:** (a) `settleReservedTo` volume past a finite `dailyOutflowCap` never reverts; (b) cumulative `withdraw` egress past the cap trips the breaker; (c) hitting the egress cap does not block unrelated accounts' settlement.

### 2. H-2 — treasury sink for slashed portions
- **`AgentAccountCore.slashJobStake` (:601-603) / `slashClaimFee` (:629-631):** credit `treasuryAmount` to a designated treasury account's liquid balance (or `SafeTransfer` to a treasury address); or add an owner-gated `sweepTreasury`. Resolve jointly with H-1 so treasury legs don't record outflow.
- **Test:** after slash + `handleClaimTimeout` (which sends the full fee to treasury), total accounted == contract balance; treasury balance is recoverable; no `jobStakeLocked` decrement without a matching credit/transfer.

### 3. Mediums
- **M-1 — `AgentAccountCore` `reserveForJob`/`reserveForRecurringTemplate`/`lockCollateral`/`lockJobStake`:** replace raw `liquid < amount` with the debt-aware check (subtract `debtOutstanding` / route through `_requireWithdrawable`). *Test:* a borrowed position cannot reserve/lock the phantom liquid.
- **M-2 — `EscrowCore.autoResolveOnTimeout`/`_resolveDispute`:** cap payout below full remainder (refund poster or split) and skip badge mint + `_releaseClaimEconomics` on arbitrator-timeout. *Test:* timeout resolution yields no merit-free full payout and no reputation badge.
- **M-3 — `EscrowCore.createMilestoneJob` (:402-405):** `if (milestones[i] == 0) revert`. *Test:* a job with any zero milestone reverts at creation; a valid job closes through `allReleased`.
- **M-4 — `XcmWrapper.queueRequest`/`finalizeRequest`:** store `queuedBy`; require `msg.sender == queuedBy || owner` and `settledAssets <= context.assets && settledShares <= context.shares` before latching. *Test:* a non-queuing operator cannot finalize; over-large settled amounts revert.
- **M-5 — `XcmVdotAdapter.settleRequest` (:174-187):** enforce minted shares against a stored per-strategy price-per-share / first-deposit ratio, with explicit 6dp↔18dp scaling. *Test:* an operator supplying an off-ratio `(assets, shares)` reverts; co-holder share value is not diluted.
- **M-6 — `XcmVdotAdapter.settleRequest` (:165, refund :189):** remove `whenNotPaused` from the failure/refund branch, or add an `ownerOnly emergencyRefund`. *Test:* an in-flight deposit is refundable while the protocol is paused.
- **M-7 — `StrategyAdapterRegistry.registerStrategy` (:40-50):** `if (strategyKnown[id] && strategies[id].adapter != adapter) revert`. *Test:* re-registering the same `strategyId` with a different adapter reverts; explicit migrate still works.
- **M-8 — `EscrowCore.resolveMilestone` (:633-636):** on the re-Claim branch, re-scope `job.claimStake` to `(job.reward − job.released)` and re-lock/refund the delta. *Test:* after N−1 releases, the final-milestone timeout slashes only the remaining-reward-scaled stake.

### 4. Lows
- **L-1 / L-2 — `TreasuryPolicy` ctor + deploy script:** set finite `perAccountBorrowCap` post-deploy; **defer `dailyOutflowCap` arming until H-1 lands**; add a deploy assertion that AAC is `setServiceOperator`-registered. *Test:* deploy script fails closed if AAC isn't a service operator.
- **L-3 — `EscrowCore.handleClaimTimeout` (:528):** decrement `workerClaimCount[job.worker]` (underflow-guarded) before clearing `job.worker`. *Test:* a timed-out claim restores waiver eligibility.
- **L-4 — `SafeTransfer._checkResult` (:29-36):** `extcodesize > 0` guard before the low-level call when return data is empty. *Test:* transfer to an EOA/codeless address reverts.
- **L-5 — `XcmWrapper`:** add `cancelRequest` (`Pending → Cancelled` after `createdAt + TTL`) or an expiry deadline. *Test:* a stale `Pending` request is reclaimable after TTL.
- **L-6 — `XcmWrapper.queueRequest`:** decode and assert asset/amount/beneficiary against `context` before dispatch. *Test:* an XCM message whose decoded beneficiary ≠ `context.recipient` reverts even when the SetTopic hash matches.
- **L-7 — `StrategyAdapterRegistry.getStrategy`/`listStrategyIds`:** compute effective-active from `policy.approvedStrategies(adapter)` at read time. *Test:* `setStrategyApproval(adapter,false)` makes `getStrategy` report inactive.
- **L-8 — `StrategyAdapterRegistry.registerStrategy` (after :47):** `if (!policy.approvedAssets(assetAddr)) revert`. *Test:* an adapter reporting an unapproved asset fails registration.
- **L-9 — `AgentAccountCore.requestStrategyWithdraw` (:415-431):** constrain operator-initiated `recipient` to the account (or owner allowlist). *Test:* an operator cannot redirect redeemed assets to an arbitrary address.
- **L-10 — `ReputationSBT.updateReputation` (:79):** accumulate instead of overwrite. *Test:* two updates sum the dimensions.
- **L-11 — `AgentAccountCore.settleReservedTo` (:320-327):** emit a debt-repayment event for `debtPaid`. *Test:* a settlement that offsets debt emits an observable repay event.
- **L-12 — `AgentAccountCore` lending:** decide — finish (liquidation + spendable borrowed liquid) or remove `borrow`/`repay`/`debtOutstanding`. *Test:* whichever path, the "phantom un-spendable liquid" state is gone.
- **L-13 — `AgentAccountCore.deposit` (:216-221):** credit the measured balance delta, or enforce non-deductive ERC20 at asset approval. *Test:* a fee-on-transfer token credits only what arrived.
- **L-14 — `DiscoveryRegistry.setPublisher` (:36-40):** two-step `setPendingPublisher`/`acceptPublisher`. *Test:* a mistaken rotation can be recovered before acceptance.
- **L-15 — `TreasuryPolicy.setVerifier`/windows:** coalesce/cap authorization windows. *Test:* many on/off toggles keep `wasAuthorizedAt` callable. (Lowest priority — view-only, no fund path.)

### 5. Informational (optional)
- **I-1 / I-2** — decide `SafeTransfer` strictness vs. broader token compatibility; document the choice.
- **I-3** — document the compact mode 0-2 count constraint.
- **I-4** — add `account != address(0)` to `updateReputation`; document the `economic` unit.
- **I-5** — guard `setStrategyActive` with `strategyKnown`.

---

## Architectural & centralization

- **Split the overloaded `serviceOperators` role — do this BEFORE arming any finite cap.** A single `serviceOperators` mapping currently gates `recordOutflow`, `finalizeRequest`, `settleRequest`, `requestStrategyWithdraw`, and the escrow settlement path. It is simultaneously the trust root behind H-1 (outflow metering), M-4 (XCM finalize), M-5 (share-price minting), and L-9 (strategy-withdraw redirect). Arming a finite `dailyOutflowCap` (the H-1 fix) on top of this single broad role would *add* attack surface: the same key that can now settle could also self-DoS or shape the meter. Decompose into least-privilege roles (e.g. `escrowSettler`, `outflowRecorder`, `xcmFinalizer`, `strategySettler`) so each path is gated by the narrowest role and no single operator key spans egress + settlement + XCM + strategy.
- **Owner → multisig.** All owner-only setters (caps, verifier/operator/pauser/arbitrator roles, strategy approvals, treasury sink) must resolve to the mapped 2-of-3 multisig, not a single deployer EOA, before mainnet — consistent with the deploy-sprint ceremony in `LAUNCH_CRITICAL_PATH.md`.
- **No treasury sink exists (root cause of H-2).** A repo-wide grep for `rescue|sweep|skim|withdrawTreasury|treasuryRecipient|collectFees` returns zero matches. The absence of any treasury destination is why slashed treasury portions and full claim-timeout fees are permanently trapped. Adding a real, owner/multisig-gated treasury sink is a prerequisite, not a nicety.
- **XCM operator trust is the least-hardened value path.** `XcmWrapper.finalizeRequest`, `XcmVdotAdapter.settleRequest`, and `StrategyAdapterRegistry` collectively let an operator supply terminal status, arbitrary settled amounts, arbitrary share prices, and re-point adapters — with the raw XCM bytes trusted (no asset/amount/beneficiary decode, L-6) and no remote proof. This is the weakest link in the value path and reinforces keeping **XCM vDOT disabled for mainnet** until native observer correlation is live (consistent with the audit-1 disposition of the XCM operator-oracle High).

---

## Ownership

**Contract code = Codex** — every H/M/L/I *code* fix on this board is Codex-owned, all writable + Foundry-testable now (only redeploy waits on the Paseo halt). All Claude-owned audit-1 findings (**B-01, B-11, B-02, B-03, B-04, D-02, D-04, E-17**) are already merged (#711–#715). No open Claude-owned *contract* work remains from either audit.

### Coordinated non-contract actions (a few fixes aren't purely Codex)

Several contract fixes carry an off-chain or ops action that must land alongside them:

| Action | Owner | Tied to | When |
|--------|-------|---------|------|
| **Do NOT arm a finite `DAILY_OUTFLOW_CAP`** until the breaker is re-wired (currently specced at 250 USDC in `MAINNET_PARAMETERS.md`) | Pascal / ops | H-1 | now — config discipline |
| **Designate the treasury-sink destination** (which multisig/address collects slashed treasury funds) | Pascal / ops | H-2 | before Codex implements the sink |
| **Provision + assign the split operator-role keys** (`escrowSettler` / `outflowRecorder` / `xcmFinalizer` / `strategySettler`) | Pascal / ops | serviceOperators split | after Codex defines the roles |
| **owner → multisig** for all owner-only setters | Pascal / ops | Architectural | launch ceremony (already roadmapped) |
| **Backend adopts the split roles** — `mcp-server/src/blockchain/gateway.js` reads `serviceOperators(escrowCore/agentAccount)` and the KMS signer *acts as* an operator; needs role-scoped keys + role-aware health checks | Claude (backend) | serviceOperators split | follow-on, after Codex lands the role shape |
| **Backend XCM settlement echo** — `mcp-server/src/services/xcm-observation-relay.js` produces the operator-supplied `settledAssets/settledShares`; must align if M-5 moves share derivation on-chain (ties to invariant-9 / 6dp↔18dp) | Claude (backend) | M-5 | follow-on, after Codex's M-5 fix |
| **Indexer consumes any new events** (e.g. the L-11 debt-repayment event) | Claude (indexer) | L-11 + new events | follow-on |

None of the Claude backend/indexer follow-ons are startable until Codex defines the contract shape they adapt to. The two Pascal decisions (treasury-sink address, cap discipline) are actionable now and gate Codex.
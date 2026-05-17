# Strategy Adapter Audit Scope

A separate scope document for the audit engagement that must close before a
real strategy adapter can be registered for mainnet use. This complements —
and intentionally does not duplicate — [`AUDIT_PACKAGE.md`](./AUDIT_PACKAGE.md),
which covers the v1 core contracts.

[`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md) §9 names "a real,
audited strategy adapter path instead of the mock vDOT adapter" as one of
four mainnet launch blockers. This doc is the contract an audit firm reads
to know what's in scope when that real adapter exists.

---

## 1. Why this is a separate engagement

The v1 contract scope deliberately includes only the *interface* and the
*registry* on the adapter side:

- [`contracts/interfaces/IStrategyAdapter.sol`](../contracts/interfaces/IStrategyAdapter.sol) — in `AUDIT_PACKAGE.md` §1
- [`contracts/StrategyAdapterRegistry.sol`](../contracts/StrategyAdapterRegistry.sol) — in `AUDIT_PACKAGE.md` §1

The adapter *implementations* are explicitly out of the v1 audit scope:

- [`contracts/strategies/MockVDotAdapter.sol`](../contracts/strategies/MockVDotAdapter.sol)
  is testnet-only and will not ship to mainnet (see §3 "Out of scope").
- [`contracts/strategies/XcmVdotAdapter.sol`](../contracts/strategies/XcmVdotAdapter.sol)
  is production-shaped but exists today as scaffolding against
  [`docs/strategies/vdot.md`](./strategies/vdot.md) and has not been
  formally reviewed.
- [`contracts/XcmWrapper.sol`](../contracts/XcmWrapper.sol) and its
  interfaces ([`IXcmWrapper.sol`](../contracts/interfaces/IXcmWrapper.sol),
  [`IXcmStrategyAdapter.sol`](../contracts/interfaces/IXcmStrategyAdapter.sol))
  are the async transport boundary. They are referenced by `AgentAccountCore`
  but not currently in `AUDIT_PACKAGE.md` §1.

That separation keeps the v1 audit narrow (five contracts plus two library
files) and lets the strategy/XCM surface be reviewed against its real
implementation rather than a placeholder.

---

## 2. In scope

When the real adapter is ready, the audit engagement covers:

| Contract | Path | Notes |
|---|---|---|
| Candidate adapter | `contracts/strategies/<RealAdapter>.sol` | Replaces `MockVDotAdapter.sol`. Likely the maturing `XcmVdotAdapter.sol`, or a fresh contract; either way the audit is against the actual implementation chosen for mainnet. |
| XCM transport wrapper | [`contracts/XcmWrapper.sol`](../contracts/XcmWrapper.sol) | Owns request id derivation, SCALE-encoded message validation, and dispatch to the Polkadot Hub XCM precompile. |
| Sync adapter interface | [`contracts/interfaces/IStrategyAdapter.sol`](../contracts/interfaces/IStrategyAdapter.sol) | Already in `AUDIT_PACKAGE.md`; re-confirm the contract surface is right for the real adapter. |
| Async adapter interface | [`contracts/interfaces/IXcmStrategyAdapter.sol`](../contracts/interfaces/IXcmStrategyAdapter.sol) | Extends `IStrategyAdapter`; adds `requestDeposit` / `requestWithdraw` / `settleRequest` / pending counters. |
| Wrapper interface | [`contracts/interfaces/IXcmWrapper.sol`](../contracts/interfaces/IXcmWrapper.sol) | Defines `RequestContext`, `RequestRecord`, status enums, and the queue/finalize surface. |

Adjacent code that auditors should *read but not re-audit* (covered by
`AUDIT_PACKAGE.md`):

- [`contracts/AgentAccountCore.sol`](../contracts/AgentAccountCore.sol) —
  the call sites for adapter `deposit`/`withdraw` and async
  `requestDeposit`/`requestWithdraw` live here. The accounting invariants
  on the *caller* side belong to the v1 audit, but a strategy auditor
  should verify the *adapter* honors the assumptions `AgentAccountCore`
  makes (see §6).
- [`contracts/TreasuryPolicy.sol`](../contracts/TreasuryPolicy.sol) — the
  source of `serviceOperators`, `approvedStrategies`, `paused`, and the
  owner identity gating the registry.
- [`contracts/StrategyAdapterRegistry.sol`](../contracts/StrategyAdapterRegistry.sol)
  — re-read for context, do not re-find issues already raised against it
  in the v1 engagement.

Solidity version: **0.8.24**, same as the v1 set. No external libraries
beyond `contracts/lib/{ReentrancyGuard,SafeTransfer}.sol`.

---

## 3. Out of scope

- **[`MockVDotAdapter.sol`](../contracts/strategies/MockVDotAdapter.sol).**
  Its docstring is explicit: *"This is NOT a yield source to point real
  mainnet deposits at."* The contract exists so the platform can exercise
  share math, the registry, and AgentAccountCore wiring without a real
  cross-chain integration. Its `simulateYieldBps(bps)` owner-only knob
  must not appear on the real adapter — see §7.
- **Off-chain settlement watcher**
  (`mcp-server/src/services/xcm-settlement-watcher.js`) and the native XCM
  observer pipeline. These are reviewed in the off-chain pen-test
  engagement scoped in `AUDIT_PACKAGE.md` §1, not here.
- **TreasuryPolicy, EscrowCore, ReputationSBT, AgentAccountCore.**
  Covered by `AUDIT_PACKAGE.md`. Re-audit only if the strategy adapter
  surfaces a missed invariant on the caller side.
- **The Bifrost runtime, the Polkadot Hub XCM precompile, and the Hub
  Assets pallet.** External platforms; the audit assumes their published
  behavior is correct. Bugs in those layers are flagged as "trust
  assumption" findings, not "fix-before-mainnet" findings.

---

## 4. System overview

Two interface tiers exist, and a real adapter implements one of them:

```
                              ┌──────────────────────────────┐
                              │ AgentAccountCore (caller)    │
                              └──────────────┬───────────────┘
                                             │ deposit/withdraw OR
                                             │ requestDeposit/requestWithdraw
                                             ▼
       ┌─────────────────────────────────────────────────────────────┐
       │ Strategy adapter — IStrategyAdapter or IXcmStrategyAdapter  │
       └────────────────────────┬────────────────────────────────────┘
                                │  (async path only)
                                │  queueRequest / finalizeRequest
                                ▼
                ┌──────────────────────────────┐
                │ XcmWrapper                   │
                └──────────────┬───────────────┘
                               │ send(destination, message)
                               ▼
                  Polkadot Hub XCM precompile
```

A **sync** adapter (e.g. a future native ERC4626-style yield vault on
Polkadot Hub) implements `IStrategyAdapter` and credits shares atomically
inside `deposit`/`withdraw`. The mock vDOT adapter is the only sync
implementation today and is testnet-only.

An **async XCM** adapter (e.g. a real Bifrost vDOT lane) implements
`IXcmStrategyAdapter`. Its sync `deposit`/`withdraw` revert with
`AsyncOnly`; the caller uses `requestDeposit`/`requestWithdraw`, which
queue an XCM message through the wrapper, and a later `settleRequest`
call finalizes accounting once the cross-chain outcome is observed.

The registry layer (`StrategyAdapterRegistry`) binds a `strategyId` to an
adapter contract address and a risk label. The owner (2-of-3 multisig on
mainnet) controls registration; `TreasuryPolicy.approvedStrategies(adapter)`
is the gate.

---

## 5. Trust model

| Role | Identity | Capability over the adapter surface |
|---|---|---|
| `owner` | 2-of-3 multisig on mainnet | Registers adapters, marks active/inactive, controls pause via `TreasuryPolicy`. |
| `serviceOperators` | `AgentAccountCore`, `EscrowCore`, optionally the backend signer | Privileged callers of `deposit` / `withdraw` (sync) and `requestDeposit` / `requestWithdraw` / `settleRequest` (async). |
| Wrapper operator | `xcmWrapper.owner` / `serviceOperators` | Calls `queueRequest` and `finalizeRequest` on `XcmWrapper`. Currently the adapter and the operator EOA both qualify; auditors should confirm this is intended. |
| External world | Anyone | Read-only views (`totalShares`, `totalAssets`, `maxWithdraw`, `getAdapterRequest`). |

Trust assumptions the audit should challenge:

- The candidate adapter implementation correctly enforces the
  `serviceOperators` allowlist on every state-changing entry point.
- `AgentAccountCore`'s rounding direction (round shares down on
  deposit, round assets down on withdraw) is preserved end-to-end —
  *the platform side rounds in its own favor; the adapter must not
  inadvertently round in the user's favor and create dust drift.*
- A failed XCM dispatch refunds assets to `request.requester`, not
  `request.account` — preserving the AgentAccountCore-as-custodian
  invariant. See `XcmVdotAdapter.settleRequest` lines 183–190 for the
  current reference pattern.
- Pause halts all adapter mutations and all wrapper dispatches; pause
  does not strand pending XCM requests permanently (`finalizeRequest`
  must remain callable post-unpause to drain the queue).

---

## 6. Key invariants

In the order an auditor should try to break:

**For any adapter (sync or async):**

1. **Non-discretionary custody.** No `owner` or `serviceOperators` path
   moves funds beyond what share/asset math + `pause` already authorize.
   In particular, no admin function should let a holder withdraw more
   than their proportional share.
2. **Share math monotonic in the platform's favor.** Deposits round
   `sharesMinted` down. Withdrawals round `assetsReturned` down. First
   depositor "share inflation" attacks (donating an extra asset before
   the first share is minted to skew the ratio) must be either
   prevented or proven economically irrelevant for the configured
   minimum claim sizes.
3. **`riskLabel` and `strategyId` are stable.** A registered adapter's
   `strategyId()` must never change post-registration; the registry
   keys metadata by it. `riskLabel` is allowed to evolve only through
   re-registration via the owner multisig.
4. **ERC20 well-behaved-asset assumption.** Adapters MUST NOT support
   rebasing tokens (balance drift breaks `totalAssets` accounting),
   fee-on-transfer tokens (actual received < stated amount), or ERC777
   callback tokens (reentrancy via the wrapper before
   `SafeTransfer.safeTransferFrom` returns).
5. **Pause halts mutation.** Every state-changing function carries
   `whenNotPaused`. Views must still work paused.
6. **Reentrancy guarded.** External calls (token transfer in, token
   transfer out, wrapper dispatch) happen after state mutation (CEI
   ordering). The `nonReentrant` modifier guards callbacks from
   misbehaving tokens.

**Additionally for async XCM adapters:**

7. **`previewRequestId` is collision-resistant.** Two distinct
   `RequestContext`s must never produce the same id; the same context
   submitted twice idempotently produces the same id (used for retry
   safety). Verify against `XcmWrapper.previewRequestId`.
8. **`SetTopic(requestId)` is enforced in the message bytes.**
   `XcmWrapper.queueRequest` calls `_validateSetTopic` (line 247) — the
   audit must confirm a caller cannot smuggle a different topic that
   correlates back to a different platform request, and that the
   SCALE-decoding helper handles every legal XCM message shape used by
   the candidate adapter.
9. **Pending counters reconcile.** `pendingDepositAssets` and
   `pendingWithdrawalShares` track every in-flight request exactly;
   `settleRequest` decrements them, regardless of success or failure.
   The audit should construct concurrent and out-of-order settlement
   sequences and confirm counters never drift.
10. **Settlement is one-shot.** `settleRequest` reverts with
    `AlreadySettled` on a second call against the same `requestId`. No
    "partial settle + retry" path silently double-credits.
11. **Failure refunds the requester, not the account.** A deposit that
    fails on the remote chain returns assets to `request.requester`
    (the calling operator contract), preserving custody on the
    `AgentAccountCore` side. A withdraw that fails leaves shares
    locked and emits a status update — the account does not gain
    assets out of nothing.
12. **Weight bounds the dispatch.** `IXcmWrapper.queueRequest` accepts
    a `maxWeight`; the wrapper must enforce it before dispatching to
    the precompile and reject messages weighed above it.

---

## 7. Known quirks and deliberate choices

- **`simulateYieldBps` MUST NOT exist on the real adapter.** The mock's
  owner-only knob is testnet-only; on mainnet, yield accrues from
  external state reads (Bifrost runtime, on-chain rewards) rather than
  a governance call. An auditor finding a "simulate yield" admin
  function on the candidate is grounds for a Critical-severity report.
- **No proxies, no upgrades.** Adapters are immutable, same as the v1
  contract set. A bug requires a fresh deploy and re-registration via
  the owner multisig; existing deposits stay in the old adapter until
  withdrawn.
- **Raw `destination` and `message` bytes are caller-supplied** in
  `IXcmStrategyAdapter.requestDeposit`/`requestWithdraw`. This is
  deliberate (SCALE message construction stays out of vault math), but
  it means the audit must confirm the wrapper validates them before
  dispatch — see invariant 8.
- **`setStrategyActive(false)` does not auto-withdraw.** Holders must
  call the normal withdraw path. The audit should confirm a
  deactivated strategy still allows `withdraw` / `requestWithdraw` so
  funds cannot be permanently stranded by deactivation.
- **`IStrategyAdapter.deposit` reverts with `AsyncOnly` on the async
  adapter.** `AgentAccountCore` is responsible for routing sync vs.
  async correctly via `_requireAsyncStrategyAdapter`
  ([`AgentAccountCore.sol` line 732](../contracts/AgentAccountCore.sol)).
  A regression that lets `AgentAccountCore.allocate(asyncAdapter, ...)`
  call the sync path would lose the asset.
- **XCM precompile address.** `XcmWrapper.xcmPrecompile()` is set at
  deploy time and immutable. On a future Polkadot Hub upgrade that
  relocates the precompile, the wrapper must be redeployed, not
  patched.
- **The wrapper validates SCALE messages by parsing them.** See
  `XcmWrapper._decodeCompactU32`, `_skipAssetVector`, `_skipLocation`,
  and `_validateSetTopic`. The parser is partial — it understands the
  XCM instructions Averray uses today, not every instruction the
  Polkadot Hub precompile accepts. Any future strategy that needs an
  unsupported instruction MUST extend the parser; the audit should
  itemize which instructions are currently parseable and flag any gap
  the candidate adapter relies on.

---

## 8. Reference reading

For the candidate strategy's product/economic context (read before the
contract review):

- [`docs/strategies/vdot.md`](./strategies/vdot.md) — Bifrost vDOT plan,
  yield model, mainnet migration path.
- [`docs/strategies/hydration-gdot.md`](./strategies/hydration-gdot.md) —
  GDOT (v2 portfolio candidate); explicitly out of v1 scope, but the
  audit should note any v1 adapter choice that would block GDOT later.
- [`docs/AGENT_BANKING.md`](./AGENT_BANKING.md) — the `strategyAllocated`
  bucket on each account and how `AgentAccountCore` calls into adapters.

For the async settlement workflow that wraps a real adapter:

- [`docs/ASYNC_XCM_STAGING.md`](./ASYNC_XCM_STAGING.md) — staging proof
  procedure.
- [`docs/NATIVE_XCM_OBSERVER.md`](./NATIVE_XCM_OBSERVER.md) — correlation
  decision and observer cursor model.
- [`docs/HYDRATION_BORROW_MIGRATION.md`](./HYDRATION_BORROW_MIGRATION.md) —
  history of how async returned amounts get back into account math.

For the v1 contract engagement this scope sits next to:

- [`docs/AUDIT_PACKAGE.md`](./AUDIT_PACKAGE.md) — covers
  `TreasuryPolicy`, `AgentAccountCore`, `EscrowCore`, `ReputationSBT`,
  `StrategyAdapterRegistry`, and the two library files.

---

## 9. Reproducing the existing tests

The current test surface that exercises the adapter and wrapper
contracts (refresh the counts against `forge test` at the audit commit):

- [`test/AgentAccountAsyncStrategy.t.sol`](../test/AgentAccountAsyncStrategy.t.sol) —
  `AgentAccountCore` ↔ async adapter integration paths.
- [`test/XcmVdotAdapter.t.sol`](../test/XcmVdotAdapter.t.sol) — the
  async vDOT adapter scaffolding.
- [`test/XcmWrapper.t.sol`](../test/XcmWrapper.t.sol) — wrapper
  validation, `SetTopic` enforcement, weight bounds.
- [`test/strategies/MockVDotAdapter.t.sol`](../test/strategies/MockVDotAdapter.t.sol)
  — mock share math; useful as a parity baseline for a real-adapter PoC
  harness even though the mock itself is not in scope.

Audit PoCs for findings should be expressed as Foundry tests in the
same style, against the candidate adapter and the wrapper.

---

## 10. Deliverables requested from the audit

Same shape as `AUDIT_PACKAGE.md` §8:

1. Written report with severity-ranked findings (Critical / High /
   Medium / Low / Informational), with specific attention to:
   - presence or absence of any admin-only "simulate yield" / "mint
     shares" / "transfer admin" path on the candidate adapter
     (Critical if found),
   - share-inflation and rounding-direction attacks at the configured
     minimum claim size,
   - any path by which `pendingDepositAssets` or
     `pendingWithdrawalShares` can drift from the wrapper's
     `RequestRecord` state,
   - any path by which a failed XCM dispatch leaves the platform short
     of assets (deposit) or shares (withdraw).
2. Proof-of-concept exploits for any Critical or High finding,
   expressed as Foundry tests against the adapter and wrapper.
3. Recommendations split into:
   - Must-fix before the adapter is registered for mainnet use,
   - Should-fix within N weeks,
   - Nice-to-have / v2 (e.g. when GDOT replaces vDOT as the default).
4. A specific sign-off statement: *"The candidate adapter at commit
   `<sha>` is safe to register via `StrategyAdapterRegistry` against
   the mainnet `TreasuryPolicy`, subject to the must-fix items above
   being closed."*

---

## 11. Contact

- Primary: <TBD — fill in before sending>
- Escalation: <TBD>
- Response SLA: within 2 business days for questions during audit;
  within 1 business day for findings classified Critical.

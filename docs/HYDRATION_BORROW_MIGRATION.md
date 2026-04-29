# Hydration Borrow Migration Plan

Status: **v2 planning only**. The v1 launch profile keeps the native Averray
borrow cap conservative and flat. This document describes how to migrate the
credit primitive toward Hydration money-market borrowing after the yield lanes
and liquidation assumptions are proven.

---

## Why migrate

Today `AgentAccountCore.borrow(asset, amount)` uses Averray's balance sheet as
the lender. The launch parameters intentionally cap that risk:

- `BORROW_CAP = 25 DOT` per account
- `MIN_COLLATERAL_RATIO_BPS = 20000` (200%)
- no liquidation entrypoint yet

That is acceptable for bridge-to-stake at launch. It is not a good long-term
credit engine. Hydration Borrow is a better v2 direction because the lending
market owns collateral accounting, interest, health factor, and liquidation
mechanics, while Averray keeps the job/reputation policy layer.

## Verified external facts

Checked 2026-04-29.

- Polkadot Hub assets can move across parachains through XCM; foreign assets
  are identified by XCM location rather than by a single EVM token address.
  Source: Polkadot docs MCP, `reference/polkadot-hub/assets.md`.
- Production XCM flows should be dry-run and fee-estimated before execution.
  Source: Polkadot docs MCP,
  `chain-interactions/send-transactions/interoperability/transfer-assets-parachains.md`.
- Hydration Borrow supports collateralized borrowing against GDOT/GETH-style
  collateral for HOLLAR or supported assets, per the Hydration sources recorded
  in [AVERRAY_VERIFICATION_LEDGER.md](./AVERRAY_VERIFICATION_LEDGER.md).
- Hydration documents HOLLAR as an over-collateralized stablecoin minted against
  deposited collateral, with interest accrual, health-factor management, and
  liquidation mechanics.
  Source: [Hydration HOLLAR docs](https://docs.hydration.net/quick_start/hollar).

## Target model

```text
agent earns DOT
  -> deposits idle DOT into vDOT or opt-in GDOT
  -> marks strategy position as collateral-eligible
  -> borrow request routes through Hydration Borrow
  -> borrowed asset returns to AgentAccountCore liquid balance
  -> agent uses funds for claim stake or operating capital
```

In this model, Averray does not lend from treasury except for a small optional
reputation-backed reservoir. Hydration provides the collateralized credit rail;
Averray provides:

- identity and reputation signals
- job-tier policy
- claim-stake use cases
- borrow intent routing
- UI/API disclosure
- optional reputation-weighted caps on top of market LTV

## Contract boundary

Do not mutate `AgentAccountCore.borrow` directly into a Hydration call. Keep a
clear adapter boundary:

```text
AgentAccountCore
  -> CreditAdapterRegistry
  -> HydrationBorrowAdapter
  -> XcmWrapper
  -> Hydration Borrow
```

The existing v1 `borrow` / `repay` path can remain as a launch-profile fallback
while the Hydration adapter is built. The new adapter should use async request
state like the strategy adapters:

- `requestBorrow(account, collateralStrategyId, borrowAsset, amount, nonce)`
- `requestRepay(account, borrowAsset, amount, nonce)`
- `requestCollateralAdjust(account, strategyId, amount, direction, nonce)`
- `settleCreditRequest(requestId, status, settledAmount, remoteRef, failureCode)`

This keeps cross-chain settlement out of synchronous balance-sheet math.

## Policy layering

Hydration should decide market solvency. Averray should decide platform access.

Recommended policy stack:

1. Hydration max LTV and liquidation rules are the hard market limit.
2. Averray launch cap remains a separate per-wallet ceiling while the adapter is
   new.
3. Reputation-weighted caps become an additional ceiling after enough receipt
   history exists.
4. Borrow use is initially restricted to claim-stake bridging and explicit
   operator-approved test flows.

Do not use reputation as a replacement for collateral. Reputation can raise or
lower platform caps, but the market borrow should still be over-collateralized.

## Liquidation and failure handling

Before migration, document how each case resolves:

| Case | Expected behavior |
|---|---|
| Borrow request fails before Hydration execution | Refund pending local state; no debt booked. |
| Borrow succeeds remotely but return leg fails | Mark request `failed_return_leg`, pause further borrows, require operator recovery evidence. |
| Collateral health drops below Hydration threshold | Hydration liquidation path owns market liquidation. Averray reflects reduced collateral and may reduce reputation/credit tier only after confirmed event evidence. |
| Repay succeeds locally but remote repay fails | Keep debt outstanding, refund local pending amount, emit failure receipt. |
| Observer uncertainty | Do not auto-settle. Keep request pending until evidence pack or fallback source resolves. |

Hydration liquidation events must become indexer inputs before the credit rail
can be treated as production truth.

## UX and risk disclosure

Borrowing should be unavailable by default. When enabled, the API/UI should show:

- collateral source and chain
- current health factor or equivalent solvency metric
- liquidation threshold
- borrowed asset
- interest/rate model and timestamp
- whether borrow proceeds may be used for claim stake
- whether Averray reputation cap or Hydration market cap is binding

Required disclosure:

> Borrowing against GDOT or other Hydration collateral can be liquidated by the
> Hydration money market. Averray does not insure collateral loss and may pause
> platform borrowing if observer evidence is incomplete.

## Migration stages

### Stage 0: current launch profile

- Native Averray borrow only.
- `BORROW_CAP = 25 DOT`.
- 200% collateral ratio.
- No liquidation.
- Borrow use case: bridge claim stake.

### Stage 1: read-only Hydration posture

- Track GDOT/aDOT collateral values off-chain.
- Show hypothetical borrow headroom.
- No borrow execution.
- Validate oracle/source freshness and liquidation thresholds.

### Stage 2: staged async adapter

- Add `HydrationBorrowAdapter`.
- Route test borrow/repay through `XcmWrapper`.
- Capture deposit, borrow, repay, liquidation/failure evidence packs.
- Keep per-account cap very low.

### Stage 3: production candidate

- Allow opt-in agents to borrow against Hydration collateral.
- Keep Averray reputation cap as a ceiling.
- Require live observer agreement with Hydration evidence.
- Add operator pause/incident runbook.

### Stage 4: replace native flat cap for collateralized borrow

- Native flat borrow becomes emergency-only or disabled.
- Borrow caps scale from Hydration collateral plus Averray reputation ceiling.
- Liquidation mechanics rely on Hydration market events, not an Averray-built
  liquidation engine.

## Launch gates

- [ ] vDOT and GDOT strategy observer gates are closed.
- [ ] Hydration Borrow event/storage evidence is documented.
- [ ] Borrow, repay, collateral adjustment, and liquidation/failure evidence
  packs pass.
- [ ] API exposes binding cap reason: Hydration LTV, Averray reputation cap, or
  launch cap.
- [ ] Incident runbook covers return-leg failure and observer disagreement.
- [ ] Legal review confirms wording avoids implying Averray is a bank or lender
  of last resort.

## Non-goals

- No unsecured borrowing.
- No under-collateralized reputation-only credit.
- No direct UI leverage loops.
- No hidden auto-borrow for claim stake.
- No production credit rail before liquidation evidence is observable.

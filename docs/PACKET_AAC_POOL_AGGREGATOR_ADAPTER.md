# PACKET — The AAC→pool aggregator adapter

Status: READY FOR CODEX · 2026-08-26 · Author: Claude (architect+gate) ·
Repo: **platform (averray-agent/agent), contracts + forge tests** · One PR.
Authority: `MEMO_IDLE_BALANCE_ROUTE.md` R1–R5 + Q1′ and
`MEMO_IDLE_BALANCE_YIELD.md` B2–B5 (all RATIFIED). Sequenced on **#1295**
(DepositPool v2.1) being merged — build against its `aggregatorAdapters`
surface.

**Contract + tests only. No deployment, no registration, no keeper, no app
wiring, no consent logic** (the consent gate is #1292 and binds the keeper,
not this contract).

## What this contract is

The missing middle of the ratified route: a **synchronous `IStrategyAdapter`**
that `AgentAccountCore.allocateIdleFunds` can deposit into, which aggregates
all opted-in idle balances into **one** DepositPool v2.1 position — because
XCM friction is flat per transfer and only aggregation amortises it. Per-agent
accounting stays upstream in `AAC.strategyShares[account][strategyId]`; the
pool sees one flagged aggregator.

## Facts verified live that constrain the design

**1 — AAC's async probe is a selector staticcall.**
`_supportsAsyncStrategyAdapter` staticcalls `pendingDepositAssets()`; if the
call succeeds the adapter is classified async and `allocateIdleFunds`
REVERTS. Therefore this adapter must **not** expose `pendingDepositAssets()`
and must **not** have a catch-all `fallback()` (which would answer the probe).
Pin with a test that the probe selector staticcall fails against the adapter.

**2 — Non-zero USDC approve requires the caller to hold DOT.**
Verified by `eth_call` from three contexts: the venue adapter (0.51 DOT) and
the operator EOA succeed; the AAC (0 DOT) **reverts**. `approve(0)` succeeds
from all three (the old approve(0)=false behaviour is gone). Consequences:

- `AAC.allocateIdleFunds` executes `safeApprove(asset, adapter, amount)` from
  AAC context → **the AAC contract account needs DOT postage** before the
  route can ever run.
- This adapter must `approve(pool, …)` before `pool.deposit` (the pool pulls
  via `transferFrom`) → **the adapter account needs DOT postage too.**

Neither is a contract defect and neither is testable in forge — record both as
named operational preconditions in the contract natspec and the PR
description; the deploy runsheet funds them (venue-postage precedent, ~0.1 DOT
each).

## The contract, exactly

**Identity.** `strategyId()` = a new bytes32 constant (suggest
`"AAC_IDLE_DEPOSIT_POOL_V21"` padded); `asset()` = Hub USDC precompile;
`riskLabel()` honest and complete: aggregated opt-in idle balances, routed to
DepositPool v2.1, pool may deploy to an external venue, principal at risk,
synchronous exit limited by the adapter's uncommitted float.

**Deposit path — `deposit(uint256 amount) returns (uint256 sharesMinted)`.**
Callable **only by the AAC** (constructor-pinned immutable address).
`transferFrom(AAC, this, amount)`; mint adapter shares at the current adapter
share price (first deposit 1:1); **incoming funds land in the float** — the
adapter does not touch the pool on deposit. The keeper sweeps later; deposits
stay cheap and the float stays servable.

**Withdraw path — `withdraw(uint256 shares, address recipient) returns (uint256)`.**
Callable only by the AAC. Serve **from float only**, at the current share
price; when the float cannot cover, revert with a named error (suggest
`FloatExhausted`) — AAC's `deallocateIdleFunds` then reverts and the app
queues per **R4**. Never touch the pool synchronously on the withdraw path:
v2.1 will revert `AggregatorMustUseNoticeExit` anyway, and the adapter must
not convert that into a confusing failure.

**Valuation — `totalAssets()`.** Float + the value of the adapter's pool
position + any settled-but-unclaimed redemption proceeds. Derive the exact
terms from v2.1's actual `requestRedeem`/settlement mechanics (locked shares
remain in `balanceOf` during notice — verify and pin). This is the line that
makes agent gains real: pool price rises must flow through `totalAssets` into
the adapter share price. `totalShares()` = adapter shares outstanding.
`maxWithdraw(account)` reports honest **synchronous** capacity — bounded by
the float — matching how existing adapters implement the interface.

**Float management — operator-gated, value-closed.**
- `sweepToPool(uint256 assets)` — approve + `pool.deposit(assets, address(this))`.
- `requestFloatExit(uint256 shares, NoticeTier tier)` —
  `pool.requestRedeem(shares, address(this), tier)`; **the receiver is
  hardcoded `address(this)`**, never a parameter.
- Whatever claim/settle call v2.1's redemption mechanics require, receiver
  again self.

`onlyOperator` (the platform operator, mirroring the pool's operator pattern —
these are high-frequency ops moves, not multisig ceremonies). **The value
boundary is the load-bearing property: no function on this contract can move
assets to any address other than the pool or, via `withdraw`, the AAC.** No
rescue function, no arbitrary-recipient anything.

**Hygiene.** ReentrancyGuard on state-moving paths; no `fallback()`; no
`receive()` unless a verified mechanical need appears (document it if so);
immutables for AAC, pool, asset, operator; zero-address checks.

## D-03

A new contract file changes the contract surface. Run the drift tooling
exactly as #1295 did, add whatever `knownUnshippedContractChanges` entries the
gate requires, and report the masked runtime hash(es). Same warning in the PR
description: the waiver-landing deploy needs `verify_contract_source=1`.
Forge pinned **v1.7.1**.

## Non-negotiables (each pinned by a forge test)

1. **The async probe fails against this adapter** — a staticcall to
   `pendingDepositAssets()` returns `ok == false`, so AAC classifies it sync.
2. **Only the AAC can `deposit`/`withdraw`** — operator, owner, and arbitrary
   callers revert.
3. **Share-price passthrough**: raise the pool's share value (donate USDC to
   the pool in-test), and an agent's adapter shares are worth proportionally
   more via `totalAssets`; a second depositor after the rise gets fewer
   adapter shares for the same assets — no dilution of earlier depositors.
4. **`withdraw` serves from float and reverts `FloatExhausted` beyond it** —
   and does NOT call the pool.
5. **Value-closure**: every external function either keeps assets inside
   {adapter, pool} or pays the AAC via `withdraw`. Prove the receiver
   hardcoding: `requestFloatExit` and claim land proceeds on the adapter.
6. **Integration with v2.1**: flagged as aggregator on a real v2.1 instance —
   `sweepToPool` above the 100 USDC agent cap succeeds, moves neither
   high-water nor floor; direct `redeem` by the adapter reverts
   `AggregatorMustUseNoticeExit`; `requestRedeem` + settle replenishes the
   float end to end.
7. **`totalAssets` counts pending-exit value**: during the notice window the
   locked shares (and after settlement the unclaimed proceeds) are still in
   `totalAssets` — no valuation dip that would let a withdrawing agent be
   short-changed mid-cycle.

## Out of scope

Deployment, DOT postage funding, the four multisig registration calls
(`setApprovedStrategy`, `registerStrategy`, `setStrategyActive`,
`pool.setAggregatorAdapter`), the allocation keeper and its consent binding,
per-agent disclosure surfaces, and any app change.

## Handback requirements

PR number; green CI; the seven test names; the full new-contract source line
count; the masked runtime hash(es) added to the waiver; confirmation the
adapter exposes no `pendingDepositAssets` and no fallback; and the natspec
lines recording both DOT-postage preconditions.

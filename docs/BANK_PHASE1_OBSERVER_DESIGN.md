# Bank phase 1 observer and backend-dispatch boundary

Status: **v2.2 dispatcher and chain-event observer implemented; activation deliberately staged**.

This note records the backend design built from `BANK_PHASE1_BUILD_PACKET.md`
§3/§4 and the aToken ledger correction in PR #909. It also records the
contract-boundary conflict found before connecting the implementation to
`POST /account/allocate`.

## Implemented seam

`VenueBalanceReader` reads an explicit `(endpoint, account, asset, ledger)`
target. Phase 1 uses:

| Position | Ledger | Account | Asset |
|---|---|---|---|
| spendable USDC | Hydration `Tokens.accounts` | `0xaf39ad76…a71e` | 22 |
| supplied USDC | Hydration EVM ERC-20 | `truncate20(0xaf39ad76…a71e)` | aUSDC `0x2ec48840…fa93` |

`hydration_truncate20` is an explicit target transform, not a generic account
rule. A different venue must configure its own ledger/account mapping.

`XcmBalanceObserverService` projects a durable watch from the wrapper's
on-chain `RequestQueued` event before any operator dispatch, polls the
venue ledger, and turns only a positive balance delta into a terminal
observation. It passes the actual delta to the existing
`XcmSettlementWatcherService`, which preflights and calls
`AgentAccountCore.settleStrategyRequest`. Solidity remains authoritative for
`settled <= requested`; the observer does not clamp an anomalous delta.

When the deadline expires, the observer submits `Failed` with
`BALANCE_OBSERVATION_TIMEOUT`. A read failure remains visible on the pending
watch until the deadline; it never becomes a cached optimistic success. The
operational status includes pending count, overdue count, oldest age, target,
deadline, last read, and last error, and `/admin/status` raises an anomaly for
overdue watches.

The event listener starts only after this subscription is armed. A watch
records the wrapper generation, staging transaction/block, event id, and
balance baseline. A dispatcher may proceed only with a pending watch whose
source is `chain_event` (or the standing `chain_event_backfill` import, which
requires an explicit chain-height-bound baseline). An unreadable baseline or
unavailable subscription is a visible ingestion error and cannot become an
implicit permission to dispatch.

`BankXcmV22Dispatcher` is the sole transition from an on-chain staged request
to the operator signing callback. In one session it re-reads the request,
pause/operator/bitmap/parameters; obtains the dispatch-time fee; dry-runs the
exact constructed message with its required event; measures the exact wrapper
call through live `ReviveApi_call`; doubles only those measured limits; obtains
a fresh exact `eth_estimateGas` and doubles it; and proves the event-created
watch is armed. It then re-reads the binding state immediately before signing,
requires a successful receipt, and records actual `gasUsed`. Evidence not
marked `liveState: true`, remembered limits, caller-supplied fees, and missing
watches are all refusing conditions.

DepositSell uses `min(fresh remote fee quote × 2, maxFeePerLeg)`, where the
multisig-staged `maxFeePerLeg` is the authorization ceiling. The capped result
must still be at least `fresh quote × 1.5`; otherwise dispatch refuses.
WithdrawSell instead uses the freshly observed complete remote asset-22
operating float, also capped, and records that value through
`recordRemoteOperatingFloat` before dispatch. WithdrawHome remains
parameterless and request-self-budgeting.

Activation requires both `BANK_XCM_FLOW_ENABLED=1` and a non-null
`XCM_WRAPPER_ADDRESS`. Unit 2 adds no environment or manifest activation; that
plumbing is the separately reviewed Unit 3.

### Staging headroom and remote residue

A deposit plan is refused unless staged assets cover
`sellAmount + maxFeePerLeg + fundingTransferFeeHeadroomRaw`. The approximately
525-raw funding transfer fee observed in the v2.1 dust cycle is evidence for
the rule, not a universal constant: the dispatcher reads the current headroom
input and records it in the evidence.

WithdrawHome guarantees its staged minimum output, not an exact sweep of the
converted account. `actualOut - minimumOutput`, plus prior fee surpluses, can
remain as remote asset-22 operating float. That residue is an observable Bank
float, not a lost or silently reconciled amount; it remains on the float tile.
A general sweep is future work and is not synthesized by this dispatcher.

## Round-trip fixtures

`hydration-bank-round-trip.json` preserves all four transactions from the dust
round trip and replays their destination-state deltas:

1. fund converted origin — asset 22 increases by 149,380;
2. sell 22 → 1003 — aUSDC ERC-20 increases by 100,000;
3. sell 1003 → 22 — aUSDC ERC-20 decreases by 100,000;
4. reserve transfer home — converted-account asset 22 decreases by 107,113.

The fixture deliberately does not query `Tokens.accounts(account, 1003)`; that
value is zero by design.

## Historical v2.0 boundary (resolved constructively in v2.2 source)

The pre-v2.2 source could not carry the packet's two-message flow:

1. `XcmWrapper.queueRequest` always calls `IXcmPrecompile.send(destination,
   message)` once. The proven funding leg is an Asset-Hub-local
   `DepositReserveAsset`/reserve operation, while the Aave `Router.sell` is a
   second message after remote funds arrive. One `send` cannot represent both,
   and the local leg needs execute semantics rather than sending the whole
   instruction stream directly to Hydration.
2. The XCM origin of the wrapper's precompile call is the wrapper contract, not
   the backend EOA. Therefore its Hydration converted origin is not the proven
   `0xaf39ad76…a71e`. Funding that fixed account while dispatching as the wrapper
   would strand the acting leg at a different account.
3. `XcmVdotAdapter.requestDeposit` moves the allocation from
   `AgentAccountCore` into the adapter, but the wrapper is the precompile caller.
   The wrapper has no custody of those tokens. A backend EOA dispatching from
   its own wallet would instead double-fund the position while the allocated
   tokens remained in the adapter.
4. `_validateXcmPayload` currently accepts only the launch vDOT subset
   (`WithdrawAsset`/`PayFees`/`DepositAsset` over relay-native `Here`). It rejects
   the Hydration asset location, `BuyExecution`, `Transact`,
   `DepositReserveAsset`/`InitiateReserveWithdraw`, and the required two-leg
   shape.

These were the v2.0 blockers that motivated the constructive v2.2 contracts.
They are retained as provenance, not as current activation instructions.
`XcmWrapperV22` constructs its own bounded legs and the adapter/wrapper custody
handshake owns the staged capital. Unit 3 supplies deployed addresses and env
plumbing; no observer or settlement-ledger redesign is required.

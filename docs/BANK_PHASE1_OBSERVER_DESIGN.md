# Bank phase 1 observer and backend-dispatch boundary

Status: **observer implemented; money-moving route deliberately staged**.

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

`XcmBalanceObserverService` stores a durable watch before dispatch, polls the
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

`XcmDryRunDispatchGuard` is the sole transition from prepared message to a
signing callback. It requires successful exact-message execution plus the
declared event/forwarded-destination evidence. The callback is never invoked on
a missing `Broadcast.Swapped`, wrong sibling, or failed dry-run. The generic
`BankXcmFlowCoordinator` records the allocation intent/watch, gates the
queue/first dispatch, waits for the intermediate predicate, gates the second
dispatch, then leaves the request pending until the balance observer finalizes
it.

Activation requires both `BANK_XCM_FLOW_ENABLED=1` and a non-null
`XCM_WRAPPER_ADDRESS`. Both deployed templates keep it false and the manifest's
wrapper is currently null.

## Round-trip fixtures

`hydration-bank-round-trip.json` preserves all four transactions from the dust
round trip and replays their destination-state deltas:

1. fund converted origin — asset 22 increases by 149,380;
2. sell 22 → 1003 — aUSDC ERC-20 increases by 100,000;
3. sell 1003 → 22 — aUSDC ERC-20 decreases by 100,000;
4. reserve transfer home — converted-account asset 22 decreases by 107,113.

The fixture deliberately does not query `Tokens.accounts(account, 1003)`; that
value is zero by design.

## Activation blocker found at the contract boundary

The current source cannot yet carry the packet's two-message flow:

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

For these reasons this change does **not** hook the coordinator into the live
account mutation route. Doing so would advertise an allocation path that
cannot settle with the current contracts. Gate 4 needs a reviewed custody and
dispatch decision first: either make the wrapper/adapter own and execute both
legs under a derived wrapper origin, or define a distinct backend-driven
transport/ledger contract whose funding source and remote origin are bound on
chain. That is a contract deployment decision, not a backend callback detail.

Once that decision lands, the activation work is narrow: supply the trusted
Hydration message planner plus queue/follow-up callbacks to
`BankXcmFlowCoordinator`, register its final watch, and flip the two activation
inputs. No observer or settlement-ledger redesign is required.

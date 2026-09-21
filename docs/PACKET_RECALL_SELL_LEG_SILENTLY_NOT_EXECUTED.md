# PACKET — the recall's sell leg was dispatched, processed, and silently not executed

Status: **ready for Codex, 2026-09-21 evening.** Cycle 2's recall is stuck in a
state the driver cannot express: the Hub says the sell leg went out, Hydration
says the message succeeded, and the aUSDC never moved. The money is safe (all
10.215 aUSDC still at the venue, still accruing) and the v2.1 pool has no
automatic penalty for overstaying `returnBy` (`writeOffVenueLoss` is
loss-reporter-only). Nothing is time-critical; correctness is.

## 1. The chain, read by Claude (2026-09-21 14:40–17:30Z)

| step | evidence |
|---|---|
| pool recall | `requestVenueRecall(2, 10193881)` — recall id **2**, tx `0x0bcb9d4b…95cd89`, block 20915725. (`--assets 10215062` was refused with `VenueRecallExceedsManaged(10193881, 10215062)`: the adapter manages 10,193,881; the 21,181 raw of interest and cycle-1 remainder stay parked, as the runsheet allowed.) |
| stage-recall commit, Hub | three signer txs at 14:40Z: nonce 2809 → adapter `0x0e3929F1…` (`0x076c3f48…`), 2810 → lane `0x2E01Bff9…` (`0x8e4c91fe…`), 2811 → wrapper `0xF20b35A3…` (`0x4b5dea32…`, 2 logs = `RequestDispatched` + `RequestLegDispatched`). Lane request id **`0x7fa1e25d6cdd02c9e70143fe9a53245ae83372b89b7d68a7fd6b2fe278ff1385`**, adapter request id `0x78db2e49…c31d`. Wrapper `requestDispatchBitmap` = **4** (withdraw_sell dispatched), record status Pending. Lane `pendingWithdrawalShares` = 10,193,881. |
| Hydration, block 14870297 (14:40:48Z) | two `messageQueue.Processed` from Sibling 1000, **both `success: true`**; the big one used refTime 16,792,356,734 / proofSize 161,328. Venue account events: `tokens.Withdrawn` 22/43,056, `tokens.Deposited` 22/21,399 (refund), treasury +21,657. **No `tokens.Withdrawn` for 1003, no `broadcast.Swapped3`, no `router.Executed`.** |
| far side after | venue aUSDC 10.215135 (unchanged, still accruing); USDC(22) float 1.541808 (= 1.563465 − 0.021657 fee). |
| driver | `stage-recall --commit` exited with `Timed out without request-bound Broadcast.Swapped evidence for 0x7fa1e25d…` — correct, and the only honest thing it could say. |

The message (decoded from the driver's `wireMessage`, v5, 7 instructions):
`DescendOrigin(wrapper)` → `WithdrawAsset(USDC 80,000)` → `BuyExecution(Unlimited)`
→ **`Transact(SovereignAccount, router.sell(1003→22, 10,193,881, minOut 10,193,881, [Aave]))`**
→ `RefundSurplus` → `DepositAsset(all → venue)` → `SetTopic(laneRequestId)`.
In XCM v5 a `Transact` whose inner dispatch fails **does not fail the message**;
the executor charges the declared weight and continues. That is why Hydration
reports success and the wrapper marks the leg dispatched while nothing was sold.

## 2. What was ruled out (all replays through Hydration's `DryRunApi`, same bytes)

- Not the encoding: the wire bytes round-trip and equal a fresh `router.sell` encode byte for byte.
- Not the origin: `LocationToAccountApi.convertLocation` of the descended wrapper location = the venue account `12eYrKz…`, and a signed `dryRunCall` of the identical `router.sell` from that account executes fully (aUSDC burned from `0x48df881b…`, 10,193,881 USDC to the venue, `Swapped3`, `router.Executed`).
- Not the call filter: the same message with a 10,000-raw sell in either direction executes.
- Not liquidity: the AAVE USDC reserve held ≈696k available at 14:40Z and now.
- Not the exact-par minimum: 8 exact-par + 8 one-unit-slack replays all executed with `amountOut` = 10,193,881.
- **It flaps.** Replaying the identical wire bytes: 1 silent failure in the first 6 consecutive-block replays (6 events, fee only), then 16/16 successes. The live dispatch was such a block. Cause not identified from outside; candidates for Codex to check with Hydration: weight purchased by `BuyExecution` under the per-block fee multiplier vs the EVM gas the AAVE unwind needs in the message-queue context; EVM gas limit derived from remaining weight.

## 3. Why the driver cannot recover by itself today

- `XcmWrapperV22.dispatchLeg`: `if (bitmap & bit) != 0) return;` — an already-dispatched leg is a **silent no-op**. The sell leg cannot be re-sent on this request.
- `pendingWithdrawLegs(4)` = `["withdraw_home"]` and the resume path assumes the sell happened (`recoverHistoricalRecallSwap`) — there is nothing to recover, and dispatching `withdraw_home` against a venue that holds no USDC beyond the 1.54 float would be wrong.
- `cancel` asserts unstaged (bitmap 0). `HydrationDepositPoolAdapter.cancelUnstaged` likewise.

## 4. The unwind that already exists on chain (operator-only, no multisig)

`HydrationUsdcAdapterV22.settleRequest(requestId, Failed, 0, 0, observedRemoteBalanceRaw, remoteRef, failureCode)`
(`onlyOperator`) → calls `xcmWrapper.finalizeRequest(…, Failed, 0, 0, …)` (allowed: bounds only demand 0/0 for non-Succeeded; `_bothLegsDispatched` is only required for Succeeded) → lane: `pendingWithdrawalShares -= requestedShares`, **no asset movement** (Withdraw + Failed keeps `totalShares`/`totalAssets`) → adapter request status Failed → pool `settleVenueRecall(2)` records 0 returned, `activeVenueRecallId = 0`, deployment 2 stays active with its full cost basis → a **new** `requestVenueRecall` (id 3) → a fresh lane request → a fresh sell-leg dispatch.

Truthful: nothing came home, nothing is in flight, the position is intact.

## 5. Deliverables

**D1 — classify the timeout.** When `waitForAaveSwap` times out, read the far side before throwing: venue aUSDC vs staged shares, `broadcast.Swapped3` bound to the topic since the dispatch block, and the `messageQueue.Processed` for the request. Emit one of `sell_executed_unobserved` (the #1386 case → resume), `sell_not_executed` (this case → §4), or `unknown`. Print the next command. Persist the verdict in the run record.

**D2 — `stage-recall --abandon-unexecuted-sell` (or a `fail-request` subcommand).** Gates, all chain-read at run time: wrapper bitmap == 4 and record Pending; lane request Pending with `pendingWithdrawalShares` == staged shares; venue aUSDC ≥ staged shares; no `Swapped3` for the topic since the dispatch block; a `messageQueue.Processed` for the message exists (so we know it was delivered and did nothing). Then dry-run and commit `lane.settleRequest(requestId, Failed, 0, 0, observedRemoteBalanceRaw = venue aUSDC raw, remoteRef = Hydration block hash of the observation, failureCode = "SELL_NOT_EXECUTED")`, wait via the bounded helper (#1393), read back `pendingWithdrawalShares` == 0 and the wrapper record Failed. Refuse if any gate fails; never touch `withdraw_home`.

**D3 — pool settle of a failed recall.** `pool-venue-ceremony.mjs settle --recall-id N` must accept the Failed status: `settleVenueRecall(N)` → 0 returned, no `writeOffVenueLoss`, `activeVenueRecallId` 0, deployment unchanged. Print the deployment's cost basis before/after (must be equal).

**D4 — retry economics and a slack knob.** After D2+D3, `recall` + `stage-recall` run again with a new request. Say in the doc what one silent failure costs (Hub gas for three txs ≈0.1 DOT + 0.0217 USDC Hydration fee) and cap the loop at 3 before stopping for a human. Add `--min-out-slack-raw` (default 0, so today's behaviour is unchanged) so an operator can allow one raw unit if Hydration ever shows sub-par unwinds; document that it is not the cause found here.

**D5 — tests.** Each D1 verdict from fixture events; D2's gates individually mutated (aUSDC one unit short → refuse; a Swapped3 for the topic → refuse; bitmap 0 or 12 → refuse); D3 keeps cost basis; the wrapper/lane calls encoded exactly (compare against `abis.js`).

Out of scope: any contract change (the wrapper's idempotent `dispatchLeg` is a design choice; note it for v2.2's adapter follow-up), the deposit direction, the measurement itself.

## Rulings — 2026-09-22 (Codex verified both against provenance at Hub block 20921367)

**Ruling A — D2 passes `observedRemoteBalanceRaw = 0`.** Verified in the deployed
lane: the Withdraw + non-Succeeded branch calls
`_recordTerminalAccounting(requestId, requestedShares, observedRemoteBalanceRaw)`
and leaves `totalShares`/`totalAssets` untouched, so the aUSDC is still the live
position on the books. The recovery slot means "assets that left the position
and are stranded remotely"; nothing left. Passing the intact balance would
double-count it and set `requiresRemoteRecovery`, which the venue adapter masks
as Pending (`HydrationDepositPoolAdapter` status masking) and the pool could
never settle. **Gate before passing 0:** the driver reads the venue aUSDC
(EVM `balanceOf` of the aToken for the venue's H160, plus the Substrate view)
and refuses unless it is ≥ the staged shares, and unless no `Swapped3` for the
topic exists since the dispatch block — if anything moved, 0 would be a lie and
the tool stops for a human. The observed balance and the Hydration block hash of
that observation go into the run record and into `remoteRef`; `failureCode` =
`SELL_NOT_EXECUTED`. D3 then settles the pool recall with 0 returned.

**Ruling B — no minimum-output slack for this adapter.** `stageRecall` requires
`parameters.minimumOutput == request.requestedAssets` (contract invariant of the
pair; the v2.2 pair is the same artifact). `--min-out-slack-raw` is dropped:
refuse any nonzero value with an error that names the contract rule. The
replays proved the minimum was never the cause; nothing is lost. Note it in the
doc as a design constraint for a future adapter revision only.

D1, D3 (with the 0-returned settle), D4's retry cap of 3, and D5 stand.

## 6. Handback

PR, CI, test names, and the exact three commands for the operator in order:
abandon → pool settle → fresh recall. Claude gates and then hands them to Pascal
with the day-6 numbers already banked (10,215,062 raw at 13:50Z, 2.62 % annualised).

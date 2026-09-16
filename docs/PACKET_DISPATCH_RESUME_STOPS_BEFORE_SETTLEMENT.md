# PACKET — `stage-dispatch` resume stops one step short: both legs done, lane never settled

Status: **ready for implementation — ops script only, no contract, no economics.**
Deadline: **deployed to the backend image by 2026-09-21** (measurement cycle 2's
recall is due 2026-09-22; `returnBy` 2026-09-23T03:50:06Z). Live money is
waiting on it.

## Exactly where the money is (2026-09-16, verified on both chains)

Pool v2.1 deployment **2** (10.243759 USDC, request `0x85dd567d…b45d`, lane
request `0x1badcfff…efe1`): stage blk 20708616, funding blk 20708620, sell blk
20708621 on Asset Hub; on Hydration the funding landed at blk 14663113
(10.243206 USDC) and the AAVE par swap executed at blk 14663125 (`Swapped3`,
10.193759 USDC → 10.193759 aUSDC, refund 18,384). The venue account holds
10.211216 aUSDC and 1.563465 USDC float. **Earning since 07:55:36Z.**

The ceremony process died before its fourth transaction (the backend's
auto-verifier saturated the VPS RPC egress that minute — separate fix,
PR #1384). The lane request is still `status 1`, `settled false`; the pool
deployment is `Pending`, `activeVenueDeploymentId == 2`.

## The gap

`pool-venue-dispatch.mjs` resumes **legs** (#1320): with wrapper bitmap `3` it
correctly skips stage, funding and sell. But the swap observation lives only
inside the `dispatchSell` callback (`swap = await waitForAaveSwap(...)` at
~L2039). When both legs are skipped, `swap` is `undefined` and the script
returns the report *"All dispatch legs are already recorded on-chain … Settlement
requires the existing request-bound swap observation"* (~L2047–2060) — it
never observes and never sends `settleRequest`. Verified live today: the resume
run printed exactly that and sent nothing.

Consequence: a ceremony that dies between the sell and the settlement has no
script path forward. Without the lane settlement, `settleVenueDeployment(2)`
cannot run, the recall cannot be requested, and the deployment blocks every
future deployment. The recall path already has the tool the deploy path lacks:
a **historical** swap scan from the staging block with a read budget
(`RECALL_HISTORY_TIMEOUT_MS`, `MAX_RECALL_HISTORY_BLOCKS`).

## The fix

1. In the resume branch, when both deposit legs are skipped and `swap` is
   unset, run the historical observation before giving up:
   `waitForAaveSwap(hydrationApi, { requestId: liveLaneRequestId, fromBlock:
   <Hydration block at or before the wrapper's stage timestamp>, toBlock: head,
   expectedInput: parameters.sellAmount, ... })` with the same request-bound
   topic binding the sell path uses (the `operationStack` binding — never a
   bare amount match), bounded by the recall scan's budget. Derive the start
   block from the staged request's `createdAt` (wrapper, seconds) mapped to
   Hydration time the way the recall scan does (pad for cross-chain skew).
2. If the swap is found: continue into the existing settlement code unchanged
   (fee ledger via `reconcileResumedPoolSell`, `afterPosition` read,
   `settleRequest`, postconditions). If not found within budget: keep today's
   report, but say *why* (`swapObservation: { status: "not_found", scanned:
   [from, to] }`) and exit non-zero — a silent "completed" report for an
   unsettled lane is what hid this.
3. `status` for a request with bitmap `3` and `settled: false` must print
   `nextAction: "rerun stage-dispatch --commit to observe and settle"` rather
   than implying completion.
4. Runbook line in `docs/INCIDENT_RESPONSE.md` (ceremony section): "process
   died after the sell leg → rerun the same stage-dispatch --commit; it
   observes historically and settles; nothing is repeated."

## Non-negotiables (each pinned by a test; I run the drills)

1. Resume with bitmap 3, no in-process swap, a `Swapped3` in history bound to
   the request → `settleRequest` is sent with the observed amounts; no leg is
   dispatched. Mutation: skip the historical scan (today's behaviour) — must
   fail.
2. Same, but the only `Swapped3` in history is bound to a *different* request
   id → no settlement, non-zero exit, `not_found` report. Mutation: match on
   amount alone — must fail.
3. History scan respects the read budget and never chases new blocks past
   `toBlock`. Mutation: drop the budget — must fail.
4. A resume with bitmap 1 (funding done, sell pending) is unchanged: it
   dispatches the sell and observes forward from the sell block, as today.

## Live runbook after deploy (operator, cycle 2)

Rerun the exact stage-dispatch `--commit` line (unchanged); expect
`swapObservation: found` at Hydration blk 14663125 with input 10,193,759 and
the lane settlement tx; then `pool-venue-ceremony.mjs settle --deployment-id 2
--use-kms --commit`. If the fix is not deployed by 2026-09-21, the fallback is
a hand-built `settleRequest` sent with the ceremony's KMS identity from the
script's own encoder — I gate the calldata; it is the last resort, not the plan.

## Out of scope

Fee policy, leg construction, dispatch parameters, the recall path, contracts.

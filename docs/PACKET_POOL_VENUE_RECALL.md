# PACKET — Pool venue RECALL driver (`stage-recall`) — URGENT, deadline-bound

Status: DELIVERED #1128 (gated GO) + two live-found fixes #1129/#1130.
ERRATUM (Claude, 2026-08-14): §"Preflights" item 4 below specified the unwind
par quote as "must be exactly 1:1" — WRONG at raw-unit precision. Measured law
(Hydration blk 13609967): selling N aUSDC debits the seller exactly N units but
the AAVE filler grosses the redemption up by accrued interest —
router.Executed{in: N, out: N+a}, Broadcast.Swapped carrying N+a on BOTH sides.
Par holds at the FILLER level (in === out); both amounts exceed the requested
input by a small accrual `a` (realized yield, lands in the remote float; a=32
raw on 500k after ~5h). #1130 encodes: in === out, expected ≤ in ≤ expected +
ceiling (expected/1000 + 16), accrual recorded as exitAccrualRaw everywhere.
Second finding (#1129): DryRunApi.dryRunXcm omits the Xcm(topic) entry from
Broadcast.Swapped operationStack — dry-run request binding = execution scope +
wire SetTopic suffix; live binding keeps the topic. Original packet follows.

Status: DISPATCHED to Codex 2026-08-14. Architect/gate: Claude. Operator: Pascal.
Implements the recall direction of the pool lane; mirror of PACKET_POOL_VENUE_DISPATCH
(delivered as #1126). One narrow PR extending `scripts/ops/pool-venue-dispatch.mjs`.

## Why now (context Codex needs)

The 2026-08-14 crossing executed end-to-end: deployment 1 (2.0 USDC) staged,
dispatched, settled — pool booked `VenueDeploymentSettled(1, status 2, 1_950_001)`
(tx `0xadda1b5e…`, blk 19447131). The far side holds the position as rebasing
aUSDC. Legs C (partial recall 0.5) and the epoch-close (recall the remainder)
are next — and the recall direction has the SAME seam the deploy direction had:
**`HydrationDepositPoolAdapter.stageRecall` has zero off-chain callers.** #1126
only encodes `stageDeploy`.

This time the seam was caught BEFORE the pool-side request was created (the leg-A
lesson, applied). Sequencing law below keeps it that way.

## The hard deadline (why URGENT)

`DepositPoolV2.recallVenueDeployment` creates the VA recall request with the
DEPLOYMENT's `returnBy` (DepositPoolV2.sol:517: `venueAdapter.requestRecall(
requestedAssets, deployment.returnBy)`), and `stageRecall` refuses any
`dispatchDeadline > request.returnBy` (`_requireDispatchDeadline`). Deployment 1's
returnBy is **1786855393 = 2026-08-16T04:43:13Z**. After that instant, every
recall of deployment 1 is unstageable and only the recovery path remains — that
is what "expired returnBy is an incident" means mechanically.

With the driver's own ≥6h margin law (reuse `MIN_DISPATCH_MARGIN_SECONDS`
21600), the last viable stage-recall commit is **2026-08-15T22:43Z**. Target:
this PR lands TODAY 2026-08-14, leg C runs today, the remainder recall +
deployment close run 2026-08-15 (day-epoch 2), leg D (standing 5.0 @ 7d) after.

## Contract law (verified from origin/main source — do not re-derive, assert)

`contracts/strategies/HydrationDepositPoolAdapter.sol`:

- `requestRecall(assets, returnBy)` — onlyPool; refuses if `assets == 0`,
  `assets > managedAssets(pool)`, or a recall is already active. Created by
  `pool.recallVenueDeployment(deploymentId, requestedAssets)` (predicted
  recallId = `nextVenueRecallId`; event `VenueRecallRequested`).
- `stageRecall(requestId, LaneParameters)` — onlyOperator, nonReentrant:
  - request must be UNSTAGED and kind `Recall`;
  - `_requireDispatchDeadline(parameters.dispatchDeadline, request.returnBy)`;
  - reads `lane.totalAssets()` / `lane.totalShares()` live — both must be
    nonzero;
  - **`parameters.minimumOutput` MUST EQUAL `request.requestedAssets` exactly**
    or it reverts `InsufficientVenueAssets()`. This is contract law, not a
    derived parameter: the recall must deliver the full requested USDC home.
  - shares are computed ON-CHAIN: `ceilDiv(requestedAssets * venueShares,
    venueAssets)`, bounds `0 < shares <= venueShares`. The driver precomputes
    the same value for the evidence block but must recompute at commit time —
    aUSDC rebase moves `totalAssets` upward between dry-run and commit, so the
    share count can legitimately shrink by raw units.
  - `LaneParameters.sellAmount` is UNUSED by stageRecall (the lane receives the
    computed `shares`). Set it equal to the precomputed shares for evidence
    legibility and assert the tuple encodes; the binding inputs are
    minimumOutput, maxFeePerLeg, dispatchDeadline, nonce.
  - calls `lane.requestWithdraw(VA, shares, VA /*recipient*/, minimumOutput,
    maxFeePerLeg /*remoteFeeBudget*/, dispatchDeadline, nonce)` and records the
    laneRequestId + shares.
- `cancelUnstaged(requestId)` is kind-agnostic — it is the abort for a created
  but never-staged recall request (only while `laneRequestId == 0`).

`contracts/DepositPoolV2.sol`: `settleVenueRecall(recallId)` books the return
(pool side; the EXISTING `pool-venue-ceremony.mjs settle --recall-id` covers it
— do NOT duplicate it in the driver). Same division of labour as deploys:
ceremony script owns pool-side request/settle, dispatch driver owns the middle.

## Deliverable — extend `scripts/ops/pool-venue-dispatch.mjs`, one PR

New subcommand `stage-recall` (and make `status` render Recall-kind requests +
active recall state; verify `cancel` already covers Recall via cancelUnstaged).

Flags mirror `stage-dispatch`: `--request-id` (VA adapterRequestId of the
recall), `--recall-id` (pool recallId — bind `pool.venueRecalls(recallId).
adapterRequestId == request-id`, refuse otherwise), `--observability-url`,
`--expected-signer`, `--asset-hub-ws`, `--hydration-ws`, `--hydration-evm-rpc`,
env fallbacks `BANK_XCM_*`, dry-run default, `--commit --use-kms` write mode.

Preflights (all fail-closed, same style as #1126):
1. VA request: kind Recall, unstaged (`laneRequestId == 0`), not claimed;
   requestedAssets > 0; margin `request.returnBy - now >= 21600`.
2. Pool binding: `venueRecalls(recallId)` matches adapterRequestId +
   requestedAssets; `activeVenueRecallId == recallId`.
3. Lane totals live-read; precompute shares (ceilDiv) with bounds; assert the
   pool lane is the DEDICATED lane (operating lane
   `0x96091d4477Fe37E79557276d63883bBbbdE73159` untouched — reuse the guard).
4. **Fresh par quote in the UNWIND direction**: AAVE filler, assetIn **1003**,
   assetOut **22**, exact-amount, must be exactly 1:1 (the deploy direction
   proved 22→1003 par; the unwind is the mirror; any deviation = refuse).
5. Postage: VA substrate account balance ≥ threshold (it holds 0.51 DOT as of
   2026-08-14 08:00Z; keep the assert — approval deposits breach ED silently,
   we paid that lesson on the deploy side: `ApprovalFailed()` 0x8164f842).
6. Observability guard unchanged: reconciled true, flows ok, fresh, pool match.
7. DryRunApi preflight of the staged withdraw on BOTH chains before any
   signature; FIND #20 frame law (runtime-transformed local-execute frame,
   `consumedUnchanged` byte check); fee quote ×2 ceiling per leg.

Then drive the WITHDRAW legs — the same wrapper leg lifecycle the operating
lane's 2026-08-06 recall came home through (that path is live-proven: +98,604
raw returned, every unit reconciled). For the pool lane: remote unwind (sell
aUSDC-shares-worth 1003→22 via the router Transact) and the home transfer leg,
each with JIT DryRunApi proof before its signature, then wait/verify the
observer settlement writeback on the lane, then emit evidence.

Evidence block additions (same schema kind): recallId, laneRequestId, shares
staged (precomputed + on-chain actual), far-side aUSDC burn, home-side USDC
arrival at the VA, and the raw-unit fee ledger closing EXACTLY:
`requestedAssets = home arrival + itemized fees (+/- recorded rebase residue)`.
Reconciliation is the acceptance bar, as it was for #1126.

Accounting note: the wrapper's converted account `0x48df881b…e7f3` COMMINGLES
the operating lane's parked ~10.0 aUSDC epoch position and the pool lane's
1.95. Lane-level share accounting separates them; the unwind must sell only the
pool lane's shares-worth. Never touch the operating lane's position.

Tests (`pool-venue-dispatch.test.mjs`): red-green refusals for
minimumOutput != requestedAssets, margin below 21600, empty lane totals,
shares == 0 / > venueShares, wrong-kind request, pool/VA binding mismatch;
share-math case with rebase drift (totalAssets > totalShares) proving ceilDiv
and the commit-time recompute.

## Sequencing law (codified leg-A lesson — Pascal operates in this order)

1. Driver PR lands + gated.
2. `status` subcommand green against the live lane (proves the middle exists).
3. ONLY THEN pool-side `pool-venue-ceremony.mjs recall --deployment-id 1
   --assets 500000` (creates the VA request; accounting-neutral).
4. `stage-recall` dry-run → Claude gates → `--commit --use-kms`.
5. Observer settles → `pool-venue-ceremony.mjs settle --recall-id 1` → first
   live cost-basis yield recognition (share price steps HERE, verified by hand).
6. 2026-08-15: recall remainder, settle, deployment 1 closed; then leg D.

## Out of scope

Pool-side request/settle (ceremony script owns them) · leg D mechanics ·
recovery-path tooling (`releaseRecoveredToPool`) · any operating-lane change ·
generalizing beyond the HYDRATION_USDC_POOL_V1 strategy tuple.

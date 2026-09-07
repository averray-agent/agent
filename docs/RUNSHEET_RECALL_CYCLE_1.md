# RUNSHEET — Recall v2.1 deployment 1 from Hydration

**THREE transactions in three numbered steps, two different scripts.** Step 2 is
the one that was omitted on 2026-09-01 and stalled a recall for two hours. Every
step below names its script, its flags, and what its output must say before you
move on. If a step's output does not match, stop and report — do not improvise.

## Deadline

| | |
|---|---|
| `returnBy` | `1789202299` = **2026-09-12 08:38:19 UTC** |
| Hard cutoff for **step 2** | **2026-09-12 02:38:19 UTC** |
| Recommended window | evening of **2026-09-11** |

The cutoff is six hours before `returnBy`, not `returnBy` itself.
`assertDispatchMargin` (`pool-venue-dispatch.mjs:78`, `MIN_DISPATCH_MARGIN_SECONDS
= 6 * 60 * 60`) is checked twice on the recall path — once on the dry run
(`:1513`) and again at commit time (`:1668`). Inside six hours **stage-recall
refuses and the only exit is `cancel`.**

Note the contract itself does *not* enforce this: `requestRecall` checks only
`assets == 0 || assets > managedAssets(pool) || activeRecallRequestId != 0`, and
`_createRequest` never compares `returnBy` to the clock. The six-hour rule is a
script guard, and it is the one that will actually stop you.

## State this runsheet was written against (2026-09-07 ~14:00 UTC)

```
activeVenueDeploymentId   1
activeVenueRecallId       0          → this recall will be recallId 1
nextVenueRecallId         1
managedAssets(pool)       9.930137   ← the recall ceiling
venuePrincipalCostBasis   9.980137
bufferAssets              9.980137   totalAssets 19.960274
adapter activeRecallRequestId  none
adapter postage           1.51 DOT   (minimum 0.5)
```

**Re-read this before you start.** If `activeVenueRecallId` is not `0`, a recall
already exists — stop and read its state instead of creating a second one.

### The recall amount is 9.930137, not the aUSDC balance

`managedAssets` is `asset.balanceOf(adapter) + lane.totalAssets() +
lane.pendingDepositAssets()` — **lane accounting, not the live Hydration
balance.** The aUSDC position was 9.945843 and growing when this was written;
none of that accrual is visible to `managedAssets`. Requesting more than
9.930137 reverts with `VenueRecallExceedsManaged`.

What the accrued yield does at settlement — whether it returns as surplus above
the requested assets — is the number to *read from the evidence*, not to predict.
I have not traced that path and this runsheet does not claim it.

## Before you start

```bash
docker exec agent-mainnet-backend node scripts/ops/pool-venue-dispatch.mjs status --profile mainnet --pool 0x9B35A102d656Fb86d798aF81959e09961DEc28E0 --request-id 0xdebced04156127d87d6a0e832a6c4076bda4427db4da5d00c28d79c5224ed924 --deployment-id 1 --observability-url http://127.0.0.1:8787/monitor/deposit-pool --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813
```

The observability URL is **`127.0.0.1:8787`** inside the container. The host
publishes `18787`; using that inside `docker exec` fails with
`observability read failed: fetch failed`.

---

## Step 1 of 3 — request the recall on the pool

Script: **`pool-venue-ceremony.mjs`** · one transaction · creates recallId 1.

Dry run first:

```bash
docker exec agent-mainnet-backend node scripts/ops/pool-venue-ceremony.mjs recall --profile mainnet --pool 0x9B35A102d656Fb86d798aF81959e09961DEc28E0 --deployment-id 1 --assets 9930137 --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813
```

Must show `preflight.staticCall: success` and
`parameters.predictedRecallId: 1`. If `--assets` exceeds the live
`managedAssets`, the static call reverts here — lower it to the live value
rather than guessing.

Then commit by appending `--use-kms --commit`.

**Must show before step 2:** event `VenueRecallRequested` with
`recallId 1, deploymentId 1`, and a `confirmationsWaited` of at least 12.
**Record the `adapterRequestId` from the event — step 2 needs it as
`--request-id`.**

---

## Step 2 of 3 — stage and dispatch both withdraw legs ⚠️ THE OMITTED STEP

Script: **`pool-venue-dispatch.mjs`** · one commit, two XCM legs inside it.

This is a different script from step 1. Step 1 alone leaves the recall pending
and nothing moves off Hydration. On 2026-09-01 the ceremony was considered
finished after step 1 and sat for two hours.

Dry run, substituting the `adapterRequestId` from step 1:

```bash
docker exec agent-mainnet-backend node scripts/ops/pool-venue-dispatch.mjs stage-recall --profile mainnet --pool 0x9B35A102d656Fb86d798aF81959e09961DEc28E0 --request-id <ADAPTER_REQUEST_ID_FROM_STEP_1> --recall-id 1 --observability-url http://127.0.0.1:8787/monitor/deposit-pool --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813
```

Must show, in order:

1. `VENUE PAIRING: pool 0x9B35A102… -> adapter 0x0e3929F1… -> lane 0x2E01Bff9…`
2. `LANE STRATEGY: 0x4141435f49444c455f485944524154494f4e5f56310000000000000000000000`
3. `timing.marginSeconds` comfortably above `21600`
4. a successful stateful recall dry run reaching the Hydration AAVE unwind
   (`assetIn 1003 → assetOut 22`)

Then commit by appending `--use-kms --commit`. The commit performs
`stageRecall`, then dispatches **`withdraw_sell`** (bitmap bit 2) and
**`withdraw_home`** (bit 3). Default `--max-fee-per-leg` is 80000 on this
command — higher than the deploy's 40000, deliberately.

**Must show before step 3:** receipts for the stage and for *both* legs, a
Hydration swap event, and a post-state with `wrapperBitmap: 12` (bits 2+3).
A bitmap of `4` means only `withdraw_home` remains — see Recovery.

---

## Step 3 of 3 — settle the recall on the pool

Script: **`pool-venue-ceremony.mjs`** again · one transaction.

```bash
docker exec agent-mainnet-backend node scripts/ops/pool-venue-ceremony.mjs settle --profile mainnet --pool 0x9B35A102d656Fb86d798aF81959e09961DEc28E0 --recall-id 1 --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813
```

Note `--recall-id`, **not** `--deployment-id` — the deployment was already
settled on 2026-09-05 (tx `0xc8d29d42`, block 20310686).

Dry run must show `preflight.staticCall: success`; then commit with
`--use-kms --commit` and confirm event `VenueRecallSettled` plus
`postcondition.accountingReconciled: true`.

---

## After the three steps

Read and report, do not act on these without deciding first:

- `bufferAssets` should have risen by the returned assets; `venuePrincipalCostBasis`
  should have fallen. The **residual** cost basis is the measured round-trip
  cost of cycle 1 — take it from the pool, never from a single leg reading. The
  2026-09-03 measurement was 0.051490; entry alone this cycle was 0.021702.
- Deposits are currently **blocked** (`venueMark: shortfall_exceeds_tolerance`).
  They stay blocked until the residual is written off via `writeOffVenueLoss`
  (multisig, `lossReporter`; weight **refTime 20e9 / proofSize 800k**), and the
  matching operator top-up plus `POST /admin/deposit-pool/subsidies {txHash}`
  is what makes the subsidy visible rather than silently labelled venue loss.

## Recovery — read before you need it

- **Between legs (bitmap 4).** Re-run the exact step 2 command. The `isResume`
  branch reads the live `laneRequestId` and dispatches only the missing leg.
  Do not start a new recall.
- **Cancel is impossible after staging.** `cancelUnstaged`
  (`HydrationDepositPoolAdapter.sol:182-187`) reverts once `laneRequestId != 0`.
  Once step 2 has staged, resume is the only exit. Cancel is available *before*
  step 2 only.
- **Inside the six-hour margin.** stage-recall refuses. Run `cancel` against the
  step-1 request (it is unstaged, so cancel works) and restart after `returnBy`
  with a fresh deployment window.
- **A transaction looks dropped.** It is not, until you have read past its
  inclusion window. A 2026-09-01 reorg re-included a transaction ~800 blocks
  later after it was wrongly declared dropped. Never conclude from one read.
- **Postage.** Each leg spends DOT from the adapter's own account. It held 1.51
  DOT against a 0.5 minimum; re-check in step 2's dry run
  (`state.venue.postage`) rather than assuming.

## Evidence to keep

Three transaction hashes with block numbers, the `adapterRequestId`, the lane
requestId, the Hydration swap block, the settled/returned assets, and the
residual `venuePrincipalCostBasis`. That residual is the exit half of the round
trip and it is the number the commitment-ladder break-evens depend on.

# RUNSHEET — Subsidised redeployment (epoch 4)

Status: **READY, fee-gated** · 2026-08-25 · Author: Claude (architect + gate) ·
Executor: Pascal (every money step) ·
Authority: `MEMO_YIELD_SUBSIDY.md` **Y1–Y5, RATIFIED**.

This reopens the lane closed by the epoch-3 recall
(`RUNSHEET_VENUE_RECALL_V2.md`). D3 said do not redeploy *while depositors bore
the friction*; Y1 supersedes it now that the operator carries it.

## Established state (verified live 2026-08-25T15:03Z)

| fact | value | meaning |
|---|---|---|
| `activeVenueDeploymentId` | 0 | nothing deployed |
| `lastDeploymentEpochAt` | 2026-08-21T16:58Z | cooldown **elapsed 70h ago** |
| `DEPLOYMENT_EPOCH` | 1 day | not binding |
| `bufferAssets` | 25.293503 | all capital home |
| `bufferFloor` | 9.908397 | high-water of largest position ever |
| `maxDeployableAssets` | 15.385106 | buffer − floor |
| `nextVenueDeploymentId` | 4 | this will be deployment 4 |
| quoted fee | **27,539** | **above the 26,000 deploy threshold** |

## The one gate: fee, and the watcher is the right tool here

`stage-dispatch` uses `DEFAULT_DEPLOY_MAX_FEE_PER_LEG_RAW = 40_000`, so at the
1.5× margin the threshold is **26,000**. The quote is 27,539 — **shut, by about
6%.**

`scratch-fee-watch.mjs` prints exactly this test ("need <=26000 for the 40k
cap") and is **correct for deploy**. It only misled during the recall because I
pointed it at an operation with a different cap. Use it unmodified here; poll
until it reports at or below 26,000.

Do not raise the cap to make a number fit. A wider cap is a staging decision,
not a retry.

## Parameters

**Deploy 15.000000**, not the full 15.385106. The 0.385 of margin above the
floor costs about 0.0008/cycle in yield — nothing — and protects against the
floor rising if a depositor larger than the current high-water mark arrives.

**`--deployment-kind standing`**, not `proof`. `proof` caps `returnBy` at 48
hours; `standing` allows the full 7 days the contract permits. Friction is flat
per cycle, so the longest epoch earns the most against the same cost. A 48-hour
deployment would earn two-sevenths of the yield for identical friction.

**`--return-by`** = chain head + 7 days, minus a safety margin (use 6d 20h).
`deployToVenue` reverts `VenueDeadlineExceedsNoticeTier` above
`block.timestamp + NOTICE_7_DAYS`, and the head moves between quote and send.

## Sequencing — deploy now, subsidise after Y3 ships

**The deployment is honest today; the subsidy transfer is not yet.**

Deploying flips `yieldStatus` to `earning` with the text "pool capital is
deployed to the configured venue" — true the moment it lands, and safe to ship
ahead of any disclosure work.

The **Y2 subsidy transfer** is different. It lifts the share price invisibly to
pool accounting, so until **Y3**'s earned-versus-added split exists, a
subsidised gain is indistinguishable from venue earnings on every surface. That
is the same defect as this morning's "NAV share active," only better funded.

**Therefore: steps 0–4 may run as soon as the fee window opens. Step 5 (the
subsidy) waits for Y3 to ship.** The gap is safe — depositors bear the friction
for at most one cycle, about 0.0964, and the subsidy can be paid retroactively
in full once the split exists.

## Ceremony

### 0 · Establish state (read-only)

Chain reads, not `status` — `status` binds to an in-flight request and cannot
describe a pre-deployment state (it exits `Wrong requestId`; this cost time
during the recall). Confirm: `activeVenueDeploymentId` 0, cooldown elapsed,
`maxDeployableAssets` ≥ 15.0, and the fee quote at or under 26,000.

**Gate:** paste the reads. I confirm before anything is signed.

### 1 · Create the deployment (dry-run first)

```
node scripts/ops/pool-venue-ceremony.mjs deploy --profile mainnet \
  --assets 15000000 --return-by <head + 6d20h> --deployment-kind standing \
  --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813 \
  --observability-url http://127.0.0.1:18787/monitor/deposit-pool
```

Dry-run is the default; `--commit --use-kms` writes, with `KMS_KEY_ID` and
`AWS_REGION` from 1Password. Expect `preflight.staticCall: success` returning
deployment id **4**, and all guards true.

**Gate:** I check the derived parameters and the static call before `--commit`.

### 2 · Stage the dispatch

`stage-dispatch` against the **new** adapter request id emitted by step 1's
`VenueDeploymentRequested` event — the id is only knowable after step 1, exactly
as in the recall.

Keep the 40,000 / 50,000 fee-and-float pair. `--float-headroom` must be at least
`--max-fee-per-leg` or staging refuses.

**Gate:** I verify share count, `minimumOutput`, `maxFeePerLeg` and deadline
before `--commit`.

### 3 · Confirm arrival on both sides

Asset Hub falling **and** Hydration aUSDC rising. Both, never one — a
single-sided read has misled us before. Expect the AAVE 22→1003 leg at par.

**Gate:** paste both reads.

### 4 · Settle and verify

`settle --deployment-id 4`, then confirm `venuePrincipalCostBasis` equals the
deployed amount and `activeVenueDeploymentId` reads 4.

Record the **measured** entry friction: deployed assets minus
`adapter.managedAssets(pool)`. This is the number Y2 owes, and epoch 3's
0.100000 is a prior, not a prediction.

### 5 · Pay the subsidy — **only after Y3 ships**

Direct USDC transfer to the pool address `0x6061f0aC…5F30`, sized to the
measured round trip (entry friction from step 4 plus the exit cost when the
epoch closes). `bufferAssets()` reads the raw token balance, so this lifts the
price with supply unchanged.

**Do not use `contributeOperatorPrincipal`** — it mints shares and cannot lift
the price for depositors.

**Gate:** I verify the amount against the cycle's fee ledger before it is sent.

## Abort conditions (any one ⇒ stop and report)

- Quoted fee above 26,000 at send time — wait; never raise the cap to fit.
- `activeVenueDeploymentId` non-zero, or the 1-day cooldown not elapsed.
- `maxDeployableAssets` below the intended `--assets`.
- Arrival confirmed on only one side.
- Measured entry friction materially above epoch 3's 0.100000 — that means
  something moved in the route, and the subsidy sizing is no longer known.
- Step 5 reached before Y3's disclosure split is live.

## What this runsheet does not do

Touch the locked cohort (it holds **zero** pool shares and cannot be reached by
a pool subsidy), change consent text, alter the activation gate or per-wallet
caps, or amend the 7-day cap. It ends with capital deployed, the lane earning,
and the subsidy owed but not yet paid.

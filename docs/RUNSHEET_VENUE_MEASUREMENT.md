# RUNSHEET — Measure the venue rate and friction (second observation)

Status: **DEPLOYED AND EARNING 2026-08-30 — entry measured; recall due before 2026-09-04T16:25:12Z** · 2026-08-27 · Author: Claude (architect + gate) ·
Executor: Pascal (every money step).
Purpose: **buy a second data point**, not yield. Every figure in
`MEMO_COMMITMENT_LADDER.md` and the case for v2.2 rests on two single
observations from epoch 3 (11.3%/yr implied, 0.129576 friction). This runsheet
costs about 0.13 USDC and tells us whether those numbers are real.

## EXECUTED — deployment 4, entry side complete 2026-08-30

| step | tx | result |
|---|---|---|
| deploy (pool→adapter) | `0xe152e284…` | 4.500000 committed, buffer 14.888371 → 10.388371 |
| leg 0 funding (XCM) | (first commit attempt) | Hydration asset-22 +4,499,357 |
| leg 1 sell (resumed) | `0x92f296ee…` | AAVE par swap 4,450,000 → 4,450,000 aUSDC |
| settle | `0xc534b635…` | `VenueDeploymentSettled(4, status 2, 4450000)` |

**ENTRY FRICTION — MEASURED, reconciles to the raw unit:**

```
sent from pool          4.500000
transport (leg 0)      -0.000643
sell execution fee     -0.021821
                        ---------
TOTAL ENTRY FRICTION    0.022464 USDC
```

Check: 4.450000 aUSDC + 0.027536 retained asset-22 float + 0.022464 friction
= 4.500000 exactly.

**The epoch-3 prior was 0.100000. Measured entry is 4.45x cheaper.** The swap
filled at exact par (AAVE, zero accrual), so essentially all friction is
transport plus the XCM execution fee — not slippage.

**Venue clock starts 2026-08-30T13:00Z** (when the swap landed), NOT at the
deployment. Days at venue, not window length, is the denominator.

## The pool does NOT mark down at settlement — NAV is briefly overstated

`principalCostBasisReductionRaw: 0`. `venuePrincipalCostBasis` stays 4.500000
while 4.450000 is actually deployed. So right now:

| | |
|---|---|
| reported `totalAssets` | 14.888371 |
| true recoverable | 14.865907 |
| **overstated by** | **0.022464 (0.151%)** |

That is exactly the already-consumed friction; the loss is recognised at
**recall**, not at deployment. Small, but **any surface reading NAV or share
price off this pool before the recall is optimistic by that amount.** Worth
knowing before anyone quotes it.

## Remaining

Recall before **2026-09-04T16:25:12Z**, then measure exit friction and the
earned amount, then recompute the ladder's break-even table from measured
values and update `MEMO_COMMITMENT_LADDER.md` in place. Reimburse the pool for
the full measured round trip (operator-funded, Y3 ledger).

## Why this needs no ceremony

Legacy **v2** (`0x6061f0aC…`) still has its venue adapter bound
(`0xE2801E6C640e0180798912649fD567E1Ea459a35`), verified live 2026-08-27:

| fact | value |
|---|---|
| `venueAdapter` | bound |
| `maxDeployableAssets` | **4.979973** |
| `activeVenueDeploymentId` | 0 — nothing deployed |
| `lastDeploymentEpochAt` | 2026-08-21 — 1-day cooldown long elapsed |
| `bufferFloor` | 9.908398 |

v2.1 cannot do this: its `venueAdapter()` is `address(0)` and binding one is
Ceremony B. **Use v2. It is the drained legacy pool and it is already wired.**

## The fairness problem, and how it is handled

v2 still holds the **tester's 5.026011** alongside the parked protocol 10.0.
The tester holds roughly a third of supply, so a naive deployment makes an
external depositor pay about **0.043** of the friction for *our* experiment.

**The operator reimburses the pool for the FULL measured round trip.** Not the
tester's share — all of it. This is our measurement, not theirs, and Y1 already
ratified operator-funded friction as legitimate spend. Y3's earned-vs-added
split now exists, so the reimbursement is recordable as operator-added rather
than passing as venue earnings.

Deploying is safe by the pool's own design: 4.979973 is the excess above a
9.908398 floor, so the largest position can still exit synchronously
throughout.

## Ceremony

### 0 · Establish state and the fee window (read-only)

Chain reads, not `status` — `status` binds to an in-flight request and cannot
describe a pre-deployment state. Confirm `activeVenueDeploymentId` 0, cooldown
elapsed, `maxDeployableAssets` ≥ 4.5.

**Fee gate:** `stage-dispatch` uses `DEFAULT_DEPLOY_MAX_FEE_PER_LEG_RAW`
40,000, so at the 1.5× margin the quote must be **≤ 26,000**. Poll
`scratch-fee-watch.mjs` unmodified — it prints exactly this test and is correct
for deploy. **Do not raise the cap to make a number fit.**

**Gate:** paste the reads. I confirm before anything signs.

### 1 · Deploy 4.500000 for the full 7 days

Leave margin above the floor rather than deploying the last cent.
`--deployment-kind standing` (not `proof`, which caps at 48h — we want the
longest window the contract allows, since window length is the variable under
study). `--return-by` = head + 6d20h, per the `VenueDeadlineExceedsNoticeTier`
margin.

**Gate:** I check derived parameters and the static call before `--commit`.

### 2 · Record the ENTRY friction exactly

`deployed assets − adapter.managedAssets(pool)`. Epoch 3's 0.100000 is a prior,
not a prediction — **this is one of the two numbers we are here to get.**

### 3 · Wait the full seven days, then recall

Both legs, both sides read (Asset Hub falling AND Hydration aUSDC rising, never
one). Then `recallVenueDeployment` then stage-recall — **it is two
transactions**, and `--assets` must be ≤ `managedAssets`, not cost basis.

### 4 · Compute and record the two numbers

```
measured friction = entry + exit
measured rate/yr  = (earned / deployed) × (365 / days deployed)
```

Then recompute the ladder's break-even table from the measured values and
**update `MEMO_COMMITMENT_LADDER.md` in place**. If the rate is materially
below 11.3%, the v2.2 case changes and W1–W4 must be re-decided before any
contract work starts.

### 5 · Reimburse the pool

Direct USDC transfer to `0x6061f0aC…` sized to the full measured round trip.
`bufferAssets()` reads the raw token balance, so this lifts the price with
supply unchanged and makes every holder whole. **Do not use
`contributeOperatorPrincipal`** — it mints shares and cannot lift the price.

Record it in the Y3 subsidy ledger as **operator-added**, with the tx hash.

**Gate:** I verify the amount against the measured friction before it is sent.

## What this explicitly is NOT

Not a yield strategy, not a redeploy of the closed lane, and not a reversal of
D3 — D3 said do not redeploy *while depositors bear the friction*, and here the
operator bears all of it. One cycle, measured, reimbursed, closed.

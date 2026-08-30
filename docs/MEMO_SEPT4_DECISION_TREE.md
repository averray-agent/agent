# MEMO — What we do on 4 September, decided in advance

Status: **DECISION AID — thresholds fixed before the data arrives** ·
Author: Claude (architect) · 2026-08-30.
Purpose: make the recall a **decision**, not a week of deliberation. Written
now, deliberately, so the thresholds cannot be rationalised to fit whatever
number turns up.

## What we already know

**Entry friction is 0.022464 USDC, measured** (transport 0.000643 + sell
execution 0.021821), reconciling to the raw unit. The epoch-3 prior for a full
round trip was 0.129576. The swap filled at exact par, so friction is transport
plus XCM fee, **not slippage**.

Pool today: assets **14.888371**, floor **9.908398**, deployable **4.979973**.

## v2.2 does NOT become unnecessary — I had this backwards

Longer windows were never blocked by friction being large. At today's
deployable, a **90-day window absorbs 0.1388** of friction — it was viable even
at the old 0.1296 number. What blocks long windows is the contract, and
`DepositPoolV2` says why in its own comment:

> *"The shortest notice tier derives the maximum venue clock."*

Any holder may call `requestRedeem(…, Notice7Days)`, so the deployment ceiling
is 7 days. **Raising the constant without teaching the pool who can demand exit
when would let a long deployment strand a Flex holder.** v2.2 therefore still
requires commitment tracking — it is not a one-line edit, and today's cheaper
friction does not change that.

## The actual fork: scale or duration. They are substitutes.

| path | needs | gets |
|---|---|---|
| **Scale** | more aggregated balance (consenting agents) | 7-day windows become viable — **no contract change** |
| **Duration** | v2.2 + commitment tracking + a migration ceremony | long windows viable at today's small scale |

Both reach a self-funding lane. One needs customers; the other needs a
contract.

## THE TREE — thresholds fixed now

Measure exit friction at the recall. Round trip = 0.022464 + exit.

| measured exit | round trip | 7d break-even | pool must hold | verdict |
|---|---|---|---|---|
| ≤ 0.005 | 0.0275 | 12.67 | 22.58 | **Scale path. ~8 USDC more in the pool and the 7-day lane funds itself. Do not build v2.2.** |
| ~0.010 | 0.0325 | 14.98 | 24.89 | **Scale path.** ~10 more. Same conclusion. |
| ~0.022 | 0.0445 | 20.52 | 30.43 | **Scale path, but harder** — ~15 more. Revisit whether that balance is reachable. |
| ~0.050 | 0.0725 | 33.44 | 43.35 | **Neither is cheap.** Deployable would need to roughly 7x. Reconsider the whole lane. |
| ~0.107 (epoch-3 shape) | 0.1295 | 59.74 | 69.65 | **Entry was an outlier.** Ladder stands as originally computed; v2.2 is the only route.  |

Pool holds **14.888371** today, so the first two rows are within reach of
routing existing idle balances; the last two are not.

## The pre-commitment

**If exit lands at or under ~0.010, we take the scale path and shelve v2.2.**
Not because the contract change is wrong, but because it costs a migration
ceremony to buy something ~10 USDC of aggregation buys for free.

**If exit lands near the epoch-3 shape, entry was the outlier**, the ladder's
original break-even table stands, and v2.2 is the only route to a funded lane.

**Between those, we do neither immediately** — we say so publicly rather than
picking the interpretation we prefer.

## Two things that must not slip

1. **No tier quotes a rate before exit is measured.** One observation of one
   direction is not a rate.
2. **Days-at-venue, not window length**, is the denominator. The clock started
   at the swap on 2026-08-30T13:00Z, not at the deployment.

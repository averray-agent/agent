# RUNSHEET — Give the first external depositor real yield

Status: **READY — blocked only on operator signatures** · 2026-09-04 ·
Author: Claude (architect + gate) · Executor: Pascal.
Authorised by Pascal 2026-09-04: *"give this guy now yield."*

## Why this exists now

On **2026-09-04** wallet `0x3742de88F246Af444aafd5810DA2d722Bc89620d` — **not
ours**, active 22+ days — did the whole loop unprompted:

| time (UTC) | action |
|---|---|
| 14:24:24 | `claimJob(0xaa636b30…)` — the first external v3 posting, 1.0 USDC |
| 14:24:24 | `submitWork(…)` |
| 14:25:12 | auto-verified and settled by our signer; **paid, AAC liquid 1.200000** |
| 14:44:00 | **`deposit(6.500000)` into pool v2.1** |

**They are earning nothing on that 6.5, because v2.1 has
`venueAdapter() == address(0)`.** That is the entire problem this runsheet
solves.

## Current economics (measured, 2026-09-04)

| | |
|---|---|
| v2.1 totalAssets | 19.960274 |
| bufferFloor | 9.908397 (the migration wallet `0xdc1Ed106…`) |
| **deployable** | **10.051877** |
| round trip (measured) | 0.051490 |
| 7-day cycle | earns 0.021784, costs 0.051490 → **net −0.029706** |
| **subsidy** | **≈ 0.22 USDC / year** |
| depositor sees | ≈ **5.7% APY** (deployable is ~50% of the pool at 11.3%) |

## Sequence

**1. Write off deployment 4** — `writeOffVenueLoss(4, 51490)` on legacy v2.
Closes it, and corrects a live NAV overstatement. Multisig.

**2. Deploy the lane + adapter pair** — `scripts/ops/deploy-venue-pair.mjs`
(#1335). Dry run, verify the gate, then commit. Nonce-derived addresses are
only valid while the signer's nonce holds, so don't leave a gap.

**3. Ceremony B** — one multisig session: pause dispatch → `setStrategyAdapter`
→ unpause → **`setVenueAdapter`** (irreversible).

**4. First subsidised cycle** — `deployToVenue` for 7 days at the then-current
deployable, then recall and settle before the deadline. Two scripts:
`pool-venue-ceremony.mjs` for deploy/recall/settle, `pool-venue-dispatch.mjs`
for `stage-dispatch` / `stage-recall`. **Both legs, every time** — omitting the
staging step cost two hours on 2026-09-01.

## The disclosure — non-negotiable

While the cycle is net-negative, the page must say the yield is **operator
subsidised**. Not buried: in the same block as the rate.

Presenting a subsidised rate as organic is the one thing we have refused all
along, and there is now a real depositor who would read it. When deployable
reaches 23.76 the subsidy is zero and the wording changes on its own — gate the
copy on the measured number, not on a date.

Also remove **"venue deployment is not scheduled"** from the served
`venueMark.statement`: once step 3 is committed that sentence is false.

## If funding it: DO NOT send one large deposit

`bufferFloor = convertToAssets(maxIssuedAgentShares)`. **Any single wallet
depositing more than 9.908397 becomes the new floor and sterilises itself.**

| one wallet adds | deployable |
|---|---|
| 9.90 | 19.95 |
| 13.71 | 19.96 |
| 50.00 | **19.96** |

Deployable caps at 19.96 no matter how much one wallet sends.

**Use the aggregator lane instead** (`0x1DDcA709…`), which is R2-exempt — proven
2026-09-03 when it swept 3.055142 in and the floor held at 9.908397.

**13.71 USDC through the aggregator makes deployable 23.76 and ends the subsidy
permanently.** That is the whole funding requirement.

## What this does NOT do

It does not make 30- or 90-day windows available — `deployToVenue` still caps at
`NOTICE_7_DAYS`. It does not need v2.2. And it does not change the fact that one
depositor is not a business.

## Abort conditions

Stop if: the pair fails its verification gate; either pool shows an active
deployment or recall; the wrapper has an unsettled request; or the copy cannot
be made to state the subsidy plainly.

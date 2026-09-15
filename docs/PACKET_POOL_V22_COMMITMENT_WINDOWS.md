# PACKET — Pool v2.2: the deployment window follows the commitment, so the pool can finally earn

Status: **BUILD — started 2026-09-15 on the operator's word**, with six
decisions R1–R6 below for ratification before the ceremony (Codex can start
the contract and tests on the recommendations; nothing ships to mainnet until
R1–R6 are answered). Authority: `MEMO_COMMITMENT_LADDER.md` (ratified
2026-08-27), `MEMO_LOCKED_CAPITAL_DEPLOYMENT.md` (V1–V7 ratified 2026-08-25),
`MEMO_POOL_V22_DEPLOYMENT_WINDOW.md` (W1–W4, open until now),
`MEMO_POOL_V22_DESIGN.md` (A–D scope, "only what has drawn blood").

## Why now (live, 2026-09-15)

- Pool v2.1 `0x9B35A102…`: 20.510422 USDC, all home; shares 19.962191; floor
  10.180515; deployable 10.329907. Holders: operator EOA `0xdc1Ed106…`
  9.908397 (sets the floor), outside depositor `0x3742de88…` 6.500000, the AAC
  aggregator `0x1DDcA709…` 3.057059 (the locked cohort's road into the pool,
  V1), acceptance wallet `0x60385dD6…` 0.496735.
- Cycle 1 measured: 9.980137 out 09-05, 9.928372 back 09-08, friction
  **0.051765**; the 09-03 legacy trip cost 0.051490. Two observations, flat,
  ~0.0516 per round trip — friction is now a measurement, not a prior.
- Locked cohort (backend ledger over AAC liquid, not pool shares): 2 locks,
  Σ 25.10 — the operator T90 seed of 25 and a **0.10 T30 lock created
  2026-09-14 13:23Z** by a wallet that is not on the operator list (R0 asks
  the operator to confirm). The design memo's stated trigger was "someone
  asks to lock 30 days for a better rate".
- Activation gate **closed**: `projected_cycle_yield_below_2x_friction` —
  projected 0.095 on a 28-day cycle vs 0.12 required. The projection assumes
  the pool must round-trip once per 7-day window; a 28-day lock therefore
  pays four frictions (0.207) against ~0.095 of yield. **The 7-day cap in
  `DepositPoolV2.deployToVenue` (line 481) is the whole reason locked capital
  cannot earn.** With one round trip per term: 30 d ≈ 0.094 vs 0.052 (1.8×),
  90 d ≈ 0.30 vs 0.052 (5.8×) on 25 deployed at the gate's own 4.9 %/yr basis.

## What v2.2 is (scope = A + B + C + D, nothing else)

**A — Commitment tracking on chain (W1 = option A, R1).** Every holder has
one commitment `(tier, committedUntil)`; tiers `Notice7Days` (Flex, the
default), `Notice30Days`, **`Notice90Days` (new, W2 = yes, R2; nothing
longer)**. Shares are non-transferable, so a per-holder record cannot be
invalidated by transfer.

- `commit(tier)` extends the caller's whole position: `committedUntil =
  now + term`, never shortens an existing commitment, never lengthens past
  90 days. The aggregator adapter commits per tranche (see backend §3).
- `requestRedeem(shares, receiver, tier)` reverts with
  `CommitmentActive(committedUntil)` while `now < committedUntil`, for any
  tier. After expiry the holder is Flex again for exit purposes without any
  transaction — the accounting must not depend on a sweep.
- Deployable per window: `deployableFor(D) = bufferAssets −
  exitableWithin(D)` where `exitableWithin(D) = convertToAssets(totalShares −
  committedSharesBeyond(now + D))`. `committedSharesBeyond(t)` is kept in
  weekly expiry buckets (≤ 13 buckets for 90 days, bounded loop), credited on
  `commit`, debited on burn of committed shares; an expired bucket counts as
  exitable by construction because `t` moves past it.
- `deployToVenue(assets, returnBy)` keeps its signature. The check becomes:
  `assets ≤ deployableFor(returnBy − now)` and `returnBy ≤ now + 90 days`.
  The 7-day constant disappears; a Flex-only pool still gets exactly the
  7-day window because nothing is committed beyond it.
- Floor: `bufferFloor` generalises from "largest position ever issued" to
  **largest position exitable within the window**; the high-water mark stays
  as the Flex component. A holder that commits for 90 days stops setting the
  floor for a 90-day deployment — which is what lets the operator's own
  9.908397 fund the first cycle (R4).
- Invariant (from the ladder memo, must never break): **deployment window ≤
  shortest commitment among the capital deployed.** Pinned by a Foundry
  invariant test, not only unit tests.

**B — Venue rebinding under strict conditions.** `setVenueAdapter` stays
set-once for the first binding. `proposeVenueAdapter(next)` (owner) starts a
7-day timelock; `applyVenueAdapter()` succeeds only if no deployment or recall
is active, the timelock elapsed, and the multisig signs. This is the item that
makes v2.2 the last pool we deploy because of a venue change.

**C — NAV tells the truth without an operator action.** `settleVenueRecall`
reconciles: principal that did not return is written down at settlement
(`VenueLossRealised(deploymentId, assets)`), so `totalAssets` never reports
consumed friction as held. `writeOffVenueLoss` remains for losses discovered
later.

**D — A deployment closes when its recall settles.** After C the deployment's
principal accounts to zero at settlement; `activeVenueDeploymentId` clears
without a separate write-off ceremony. Cycle 1 needed `writeOffVenueLoss(1,
51765)` to close — that is the blood.

**Yield stays pro-rata to all shares (R3).** One NAV, no share classes. The
ladder's "Flex earns nothing" (D1) is *not* implemented on chain in v2.2: it
needs share classes on a contract that holds 20 USDC, and the evidence rule
says no. What the tiers buy on chain is deployability — committed capital is
what allows the window that produces the yield everyone shares — and off chain
the perks already live. If a committed cohort exists and asks why Flex shares
its yield, that is the trigger for share classes, and the disclosure until
then says so plainly.

## Backend (same PR series, behind the contract)

1. Pool door reads `commitment(holder)`, `deployableFor(7|30|90 days)`,
   `committedSharesBeyond(t)`; `/pool` publishes the three deployables and a
   commitment table by tier (amounts, never wallets), and the disclosure
   sentence for R3.
2. Activation gate: the projection stops assuming a 7-day round trip. Cycle
   yield is projected on **one** round trip per term, from the venue rate
   measured on cycle 1 (pin the number from the deployment records — the
   gate's 0.009/9.5/7 d basis and the 0.01743 figure in the cycle-1 record
   disagree; resolve which is the venue rate before it is used) — friction
   from the two measured trips.
3. The locked-tier keeper (V1 path) commits the aggregator's shares on chain
   per tranche: after `requestStrategyDeposit` lands shares in the aggregator,
   it calls `commit` for the tranche's tier with `committedUntil ≤` the
   depositor's remaining lock term — **never beyond a depositor's consent**
   (V3's test extends to this). V6 reconciliation compares ledger term vs
   on-chain commitment on every lock read.
4. Early exit under V5 becomes exact: an exit request on a committed lock
   waits for `committedUntil` (the chain will not release earlier), the
   pending state shows that date as the ETA, no haircut. Consent copy: the
   venue-exposure sentence stays load-bearing and gains "principal is
   committed on chain until <date>".
5. Migration copy on `/pool` and in the door: v2.1 deposits paused, 7-day
   notice to withdraw, redeposit into v2.2 at the holder's leisure; the two
   outside holders (6.5 in v2.1, 5.026011 in legacy v2) are never moved by
   us.

## Decisions for the operator (answer before the ceremony)

- **R0** — Is the 0.10 T30 lock from 2026-09-14 13:23Z ours? If not, the
  design memo's trigger has fired and this packet is on its stated schedule.
- **R1** — Option A (on-chain commitments). Recommended; B substitutes an
  attestation for whether someone can withdraw their own money.
- **R2** — Add `Notice90Days`; nothing longer than 90 days.
- **R3** — Single NAV, pro-rata to all shares; share classes deferred with the
  trigger named above. This amends D1 of the ladder memo and needs your word.
- **R4** — Operator commits first: at migration the operator positions (≈ 10.4
  USDC) commit for 90 days, so the first 90-day cycle is positive on
  operator money alone (≈ 0.12–0.28 earned vs 0.052 friction at the two rate
  bases) and the first rate we quote is measured, not projected.
- **R5** — One migration, batched with B, so nobody moves again for a venue
  reason. Outside holders move at leisure.
- **R6** — Scope is A + B + C + D. The epoch cooldown, fee knobs, multi-venue,
  tranching and the floor recompute stay out (design memo).

## Non-negotiables (each pinned by a test; I run the drills)

1. Invariant test: for every state the fuzzer reaches, every active
   deployment's `returnBy ≤` the `committedUntil` of every share it was
   funded against; equivalently `deployed ≤ deployableFor(returnBy − now)` at
   creation. Mutation: drop the window check — must fail.
2. `requestRedeem` on a committed position reverts until `committedUntil`;
   one second after, it succeeds with no other transaction. Mutation: require
   a sweep — must fail.
3. `commit` never shortens, never exceeds 90 days, never moves shares between
   holders. Mutation: allow a shorter re-commit — must fail.
4. A Flex-only pool computes `deployableFor(7d)` equal to today's
   `maxDeployableAssets` and refuses any window longer than 7 days. Mutation:
   ignore the buckets — must fail.
5. Buckets: committing 1 share for 30 days then advancing 31 days makes it
   exitable within 7 days without any call. Mutation: skip the time term —
   must fail.
6. Rebinding: `applyVenueAdapter` reverts while a deployment or recall is
   active, before the timelock, and from any non-owner. Mutation: drop the
   active-deployment check — must fail.
7. Settlement writes down unreturned principal (cycle-1 numbers as the
   fixture: 9.980137 out, 9.928372 back → `totalAssets` falls by 0.051765 at
   settlement) and clears `activeVenueDeploymentId`. Mutation: keep the
   principal — must fail.
8. Keeper: a tranche whose depositor lock ends in 20 days commits for
   `Notice7Days`, never 30; a 100-day lock commits for 90. Mutation: commit
   the tier name blindly — must fail.
9. Backend projection uses one round trip per term; the 7-day-cycle
   assumption is gone. Mutation: restore four trips — must fail.
10. Migration copy and R3 disclosure present on `/pool` and in the door; a
   test greps both.

## Ceremony C (operator, after the PR series lands and R1–R6 are answered)

1. Deploy the v2.2 pool + a fresh adapter/lane pair with the pair driver
   (#1335–#1337 precedent); reproduce creation hashes on a second machine;
   D-03 waiver dance for the contract surface.
2. Fund the new adapter's SS58 with ~1 DOT postage before anything else.
3. Bind the venue (set-once first binding); `adapter.pool()` must read v2.2.
4. Pause v2.1 deposits; migrate operator capital (withdraw at 7-day notice,
   deposit into v2.2); `commit(Notice90Days)` from the operator positions.
5. First 90-day deployment sized by the 50 % policy against
   `deployableFor(90 d)`; record entry friction; the locked cohort rides via
   V1 once the gate opens under the new projection.
6. Multisig weights: refTime 20e9 / proofSize 800k / deposit 0.5 DOT.

## Out of scope

Share classes / tier-differentiated NAV; the DEPLOYMENT_EPOCH cooldown;
fee-policy knobs; multi-venue; tranching inside one holder; any change to the
locked-tier perks; touching legacy v2.

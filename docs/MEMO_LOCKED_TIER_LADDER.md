# MEMO — Locked deposit tier ladder (perks always, yield only where it's real)

**Author:** Claude · **Status:** RATIFIED (Pascal, 2026-08-22) · **Date:** 2026-08-22
**Companion to:** MEMO_DEPOSIT_CLAIM_PRIORITY (priority = the base perk).
**Implements nothing yet.** On ratify this becomes packets (backend first; contract work explicitly deferred).

## 1. The ask (Pascal, 2026-08-22)

Different lock-up periods, each with its own perks and yield — a reason for
agents to keep funds on the platform that scales with their commitment.

## 2. The two laws that shape the ladder

1. **Yield only where it's real.** Measured (epoch-2): a venue round-trip
   costs ~0.060 USDC flat; 9.5 USDC earns ~0.009/week — 6.6× wash-negative.
   Break-even ≈ 15 USDC pooled on a 30-day cycle. Therefore yield is
   **activation-gated**, never promised: below the gate, locked tiers earn
   perks only and the UI says so plainly.
2. **Principal is never trapped.** Early exit always exists; its cost is
   forfeiting perks and the current period's yield share — never principal,
   never a penalty fee. "Money actually leaves" stays true at every tier.

## 3. The ladder

| Tier | Lock | Perks | Yield | Venue risk |
|---|---|---|---|---|
| **Flex** | none (48h vesting, live today) | cap raises (live) + standard claim-priority window (per priority memo, ≥ T vested) | none | **none** — flex capital never deploys to venues |
| **T30** | 30 days | Flex perks + priority rank above Flex within the window | pro-rata share of venue NAV accrual **when the activation gate is open** | pro-rata, disclosed |
| **T90** | 90 days | T30 perks + top priority rank + **personal credit-cap boost** (locked balance raises the wallet's L2 borrow ceiling — locked deposits are the cleanest collateral we can see) + public profile flag ("committed depositor", schema-backed) | same pro-rata NAV share as T30 | pro-rata, disclosed |

Deliberately **not** differentiated: the yield *rate*. One NAV, one share
class, pro-rata over locked capital only. Tranched/seniority yield structures
are rejected (§7) — tiers differ in **perks and commitment**, not in
accounting complexity.

## 4. Decisions (L1–L10)

**L1 — Risk separation.** Only locked capital (T30/T90) is eligible for venue
deployment. Flex and working balances never leave the platform. Venue risk is
carried exclusively by capital that explicitly opted into a lock.

**L2 — Activation gate (hard, automatic, honest).** The locked cohort deploys
to the venue only while **Σ locked ≥ 15 USDC** AND **projected cycle yield ≥
2× cycle friction** (margin 2). Gate closed → no deployment, no yield accrual,
UI states "yield inactive — pool below activation threshold". The gate can
never be overridden by copy or config; it is the wash-negative law as code.

**L3 — NAV mechanics.** Existing poolV2 share-price accounting (proven live,
including the write-off path — sharePrice 0.994824 precedent). Venue returns
raise NAV; losses mark it down; locked depositors see both. No fixed APR
anywhere, ever.

**L4 — Early exit.** Request at any time; principal returns via the normal
withdrawal path after the standard vesting delay; forfeits: current-period
yield share + tier perks (drops to Flex immediately). No principal haircut.

**L5 — v1 is zero-contract.** Locks are enforced by the backend lock ledger +
withdrawal gate with the worker's signed consent (the CW-2 pattern: consent +
gate, no new Solidity). Contract-side lock classes are a later ceremony if the
product proves demand (that path carries the CREATE gas law: ~0.9 DOT per Hub
CREATE, ≥4.5 DOT ceremony budget, multisig + D-03 manifest gate — reason
enough to earn it first).

**L6 — Bounds.** Per-wallet locked cap 25 USDC initially; global locked-cohort
deployment cap rides the existing pool caps (1000/100). Both env-settable
behind ceilings.

**L7 — Anti-circularity.** Outstanding credit draws exclude a wallet from
locking (borrowed money cannot earn yield or perks). Symmetric with the
priority memo's D5; T90's credit-cap boost applies only while no draw is
outstanding.

**L8 — Fees untouched.** No retention-fee discounts at any tier: the fee
funds brokered gas (~0.059/lifecycle against min 0.05 retained) — discounting
it makes serving the wallet unprofitable. Perks must never be revenue
giveaways.

**L9 — Disclosure surfaces.** Tier state on `/me` and the account position;
lock terms, gate state, NAV, and risk sentence on the deposit flow BEFORE
consent; the public profile flag only with the depositor's explicit opt-in
(identity is theirs to publish).

**L10 — Truth vocabulary.** "Locked deposit", "priority", "NAV share".
Never "APR", "guaranteed", "interest", "staking rewards".

## 5. Rollout + exit condition

1. Ship backend lock ledger + Flex/T30/T90 (flag-off) → enable T30 first.
2. **Success (day 30):** ≥ 2 external wallets in T30+, or Σ locked ≥ 10 USDC.
3. **Safety abort (any day, unconditional):** any evidence the lock gate
   blocked a withdrawal outside its consent terms (auto-alarm) → flag off;
   locks honor their committed terms to expiry, no new locks.
4. **Adoption review (day 30, no auto-abort — amended by Pascal 2026-08-24):**
   zero adoption does not kill the feature. The flag-gated, zero-contract
   ladder costs nothing while unused and the activation gate bounds economic
   exposure at zero. If nothing is locked by day 30, review why (pitch never
   delivered, perks not valued, wrong cohort) and decide keep / iterate /
   retire deliberately.
5. Venue deployment of the cohort begins only when L2's gate opens — possibly
   weeks after tiers ship. Perks make the tiers worth using in the meantime.

## 6. Sequencing

Priority memo (base perk) → this ladder (backend v1) → L2 credit draws (T90
boost lands with it) → contract-side locks only if proven. The Aug 28
recall-and-pause of the operator float stands regardless — this memo is about
whose capital rides next time the lane opens (consenting locked capital, at
scale, behind the gate).

## 7. Rejected

- **Tiered yield rates / tranches / loss seniority** — accounting complexity
  and implied guarantees; one NAV or nothing.
- **Fixed APR at any tier** — costume for a subsidy below scale.
- **Principal penalties on early exit** — hostage capital breaks the proven
  trust story.
- **Fee discounts as perks** — unprofitable service is not a perk.

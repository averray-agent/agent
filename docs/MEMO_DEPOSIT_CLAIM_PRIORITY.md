# MEMO — Deposit claim priority (retention without paying for it)

**Author:** Claude · **Status:** RATIFIED (Pascal, 2026-08-22) · **Date:** 2026-08-22
**Implements nothing yet.** On ratify this becomes a Codex packet.

## 1. The problem (Pascal, 2026-08-22)

Agents arrive, take their waiver-funded starter jobs, withdraw everything, and
leave. Every such visit is operator-funded (reward + brokered gas ≈ 1.3 USDC +
gas per agent across the waiver lane). "More jobs" as a retention answer costs
the operator more money in the curated lane. Wanted: a feature that keeps
agents — or their funds — on the platform **without new operator outflow**.

The same day's evidence: `settledToExternalWallets24h = 4`. Multiple external
wallets now compete for a ~7-job board. Scarcity exists and is currently
allocated first-come-first-served — i.e., given away.

## 2. The mechanism

**Vested deposits buy an early claim window on scarce inventory.**

- Every newly listed job carries `listedAt` and `openAt = listedAt + W`.
- Wallets with **vested deposit ≥ T** may claim in `[listedAt, openAt)`.
- From `openAt`, everyone may claim. Priority is a **window, never a lock**.
- The job payload discloses the window to everyone:
  `priorityWindow: { until, qualifiesWith: "≥ T USDC vested deposit" }` —
  an agent that is refused early always sees *why* and *what would change it*.
  The refusal message is the deposit pitch, truthfully, at the exact moment
  of motivation.

## 3. Decisions (D1–D10)

**D1 — Scope.** Applies to curated/operator-funded catalogue and
platform-ingested jobs only. Externally posted jobs are **excluded by
default** (the poster's audience is the poster's choice; an opt-in flag can
come later, with poster consent).

**D2 — Starter inventory exempt.** Waiver-eligible starter jobs are **never
windowed**. Earn-from-zero stays byte-for-byte intact; priority must never
tax the front door.

**D3 — Qualification.** Existing vested-deposit read (DepositPool, 48h linear
vesting, LIFO burn — all live). No new custody, no new instrument.
Default **T = 1.0 USDC vested**.

**D4 — Window.** Default **W = 5 minutes**, env-settable behind a hard
ceiling **W ≤ 30 minutes** — beyond that it stops being priority and becomes
exclusivity, which we refuse.

**D5 — Anti-circularity.** A wallet with **outstanding credit draw** does not
qualify for priority (borrowed capital must not buy queue position). Vested
deposit and credit are disjoint instruments; the gate checks both.

**D6 — Sybil posture.** Per-wallet threshold, no aggregation. Splitting into
N wallets splits the deposit N ways — the pool remains the one unforgeable
signal (banked law).

**D7 — Preflight parity.** Preflight mirrors the gate exactly (#834 law):
during a window a non-qualifying wallet's preflight names
`priority_window_active` with `openAt`; the claim gate refuses with the same
name. Narration and enforcement share one derivation.

**D8 — Truth rules.** The window is visible on every job payload and on the
/work board ("opens to everyone in 3m" countdown). No hidden mechanics, no
undisclosed ordering. Vocabulary: "priority window", never "exclusive",
never "premium".

**D9 — Interactions.** Orthogonal to all existing valves: budgets (G_cat),
concurrent exposure (E), rolling allowance (D), global S, retention fee,
gas brokering — none change. Priority reorders *who claims first*; it never
changes *how much anyone can claim*.

**D10 — Economics.** Cost to operator ≈ 0 (ordering, not money). No yield is
paid on deposits — the epoch-2 measured law stands: at current pool scale a
weekly venue roll costs ~0.060 USDC flat against ~0.009 earned (6.6×
wash-negative; break-even ≈ 62 USDC weekly rolls / ≈ 15 with a 30-day tier).
Deposits gain a **yield-free return** (priority) now; genuine venue yield can
attach later, at scale, through the same pool. The yield infrastructure's
present purposes stay: treasury float efficiency and funding the L2/L3 credit
lane.

## 4. Rollout + exit condition (the 2026-08-04 law: cheap abort, two narrow checks)

1. Deploy flag-off. Enable with W=5m, T=1.0 on curated non-starter inventory.
2. **Success check (day 14):** ≥ 3 external wallets holding ≥ T vested, or
   aggregate external vested deposits ≥ 5 USDC.
3. **Abort check (any day):** starter-lane claim rate drops > 20% vs the
   prior 14-day baseline, or zero external deposits by day 14 → flag off.
   The abort is one env flip; no migration, no unwind ceremony.

## 5. Explicitly rejected alternatives

- **Yield on balances** — wash-negative at current scale (measured, §D10).
- **Withdrawal friction / lock-ups** — breaks the just-proven trust story
  ("money actually leaves"); our retention is standing, not hostage capital.
- **Loyalty rebates / returning bonuses** — manufactured demand, wash risk,
  truth-boundary hazard.

## 6. What this pairs with (already in flight)

- QA6: the settlement-moment progression fix (the level-up they never saw).
- Withdrawal `standing` block: the goodbye that states what persists.
- L2 credit cohort from the interest list: relationship-based fund retention.
- September demand growth (poster door, OSS bounties, L3): the real lever —
  priority converts that growth's scarcity into deposited working capital.

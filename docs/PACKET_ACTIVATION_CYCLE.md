# PACKET — Activation gate: the cycle is the shortest remaining lock term

Status: READY FOR CODEX · 2026-08-25 · Author: Claude (architect+gate) ·
Repo: **platform (averray-agent/agent), mcp-server** · One PR, small.
Authority: `docs/MEMO_LOCKED_TIER_LADDER.md` **L2a** (amended and ratified
by Pascal, 2026-08-25). Read L2 and L2a before starting.

## The defect

`lockedTierActivationGate(totalLockedRaw)` takes only a total and applies
`LOCKED_TIER_CYCLE_DAYS = 30n` to every cohort. Friction is 0.060 USDC per
venue **round trip**, and the round-trip cadence is forced by the shortest
commitment in the pool — so a fixed 30-day cycle charges a T90 cohort as if
it rolled monthly. It understates T90 yield by ~3× and holds the gate shut
on capital that genuinely clears the bar.

Live effect today: the first T90 seed (25 USDC) projects 0.101503 against
0.12 required and reports `projected_cycle_yield_below_2x_friction`, while
its true ~89-day cycle projects 0.301127 — 2.5× margin.

## The change

`cycleDays` becomes **the shortest remaining term across currently active
locks**, re-derived whenever the cohort changes. Everything else in the gate
is untouched: the 15 USDC floor, the 2× margin, the 0.060 friction constant,
and the epoch-2 yield basis (0.009 earned by 9.5 over 7 days).

The gate function needs the cohort's remaining terms, not just a total —
change its signature accordingly and update every call site. Prefer passing
the active entries (which the service already has) over adding a second
source of truth for "what is locked".

Report the derived cycle honestly in the response: alongside `cycleDays`,
say what set it — e.g. the shortest remaining term and how many active locks
were considered — so an operator reading a closed gate can see *why* the
cycle is what it is.

## Non-negotiables (each pinned by a test)

1. **Today's cohort opens the gate**: one active T90 lock of 25 USDC with
   ~89 days remaining ⇒ `cycleDays ≈ 89`, projected ≈ 0.301, `open: true`,
   no blockers.
2. **Near expiry closes it**: the same lock with 10 days remaining ⇒
   projected 0.033834, `open: false`,
   `projected_cycle_yield_below_2x_friction`. Capital about to be returned
   must not deploy against an assumed long cycle.
3. **A short lock shortens the cycle for everyone**: T90 (89d) + a new T30
   ⇒ `cycleDays` drops to the T30's remaining term, and the projection is
   recomputed over the larger total. Assert the cycle, not just the verdict.
4. **The floor still binds independently**: a cohort under 15 USDC stays
   closed with `locked_cohort_below_minimum` no matter how long its cycle.
5. **No config may open the gate**: no env, no argument, no override can
   raise `cycleDays` above the true shortest remaining term or lower the
   margin. Extend the existing
   `activation-gate-cannot-be-config-opened` test rather than replacing it.
6. **Fail closed on unreadable composition**: if active locks cannot be
   determined, the gate is closed with a named reason — never open on a
   default.
7. **Zero active locks** ⇒ closed, and no division by zero or NaN anywhere.

## Out of scope

Venue deployment itself (still not built — this only changes when the gate
*says* yes), NAV mechanics, tier perks, the per-wallet cap, any change to
the friction constant or yield basis, and any UI work beyond passing the
richer gate object through unchanged.

## Handback requirements

PR number; green CI; the seven test names; the exact `cycleDays`,
`projectedCycleYield`, and `open` values the tests assert for the
25-USDC-T90-at-89-days case; and confirmation that the friction constant,
margin, floor, and yield basis are byte-identical to before.

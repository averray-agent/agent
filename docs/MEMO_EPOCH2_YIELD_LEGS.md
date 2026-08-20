# Decision memo — Epoch-2 yield legs (§B of CEREMONY_POOLV2_YIELD_EPOCH2)

**Author:** Claude · **Ratifier:** Pascal · **Date:** 2026-08-20
Fills §B's open decisions so ceremony day is mechanical. Live state read 2026-08-20 ~14:3xZ, block-fresh.

## Live facts (chain-read, not modeled)

| fact | value |
|---|---|
| pool totalAssets | 20.446982 |
| idle (USDC at pool) | 15.446982 |
| deployed (pool lane, venue-confirmed) | 5.000000 |
| bufferFloor (on-chain: largest position, 10,000,000 shares) | **9.973491** |
| max deployable today (idle − floor) | 5.473491 |
| venue APY (epoch-1 measured) | ~5% |
| round-trip friction class (epoch-1) | ~0.202% flat-ish |

The floor is NOT the strategy doc's 50% template — `DepositPool.bufferFloor()`
requires idle to cover the **largest single depositor's full position**, and
`deploy` reverts `BufferFloorBreached` below it. Sizing is against that law.

## Decisions (stand unless overridden)

**E2-1 — Size: 4.5 USDC, by formula.** Ceremony-day leg =
`min(4.5, idle − bufferFloor − 0.75)`; **abort below 2.0** (a smaller leg is
not worth a signing morning). Rationale: 4.5 leaves ~0.98 headroom above the
floor — covering ~2 years of floor drift (floor = convertToAssets(maxShares)
grows with share price at settlement events, ~5%/yr) plus small withdrawals —
while lifting deployed capital to 9.5 (~46% of totalAssets).
Incremental yield ~0.225/yr; one-way friction ~0.009; payback ~2 weeks.

**E2-2 — Shape: one leg.** Venue depth at 4.5 is trivial; splitting doubles
signing rounds for nothing.

**E2-3 — Tenor: standing position, no `returnBy`.** Epoch 1 was a time-boxed
dogfood; epoch 2 is a standing deployment reviewed monthly (fold into the D5
idle-capital sweep). Recall on demand via the proven §A pattern. Round-tripping
per epoch pays friction twice for no information.

**E2-4 — Exit condition (per the upgrade-exit-condition law).**
Cheap abort: a failed/QUOT dispatch leaves the request `Failed` with the §A
recovery path; retry at most once same-day, else stand down and reconcile.
Two narrow post-leg checks, both must pass before the ceremony closes:
1. **Chain/venue:** wrapper request `Succeeded` with `settledAssets == leg`;
   venue aUSDC delta ≈ leg within 0.5% (quote tolerance).
2. **Pool invariants:** totalAssets unchanged, idle reduced by exactly the leg,
   and share price (`convertToAssets(1_000_000)`) byte-identical pre/post —
   deployment must be value-neutral to depositors.

**E2-5 — Yield routing unchanged (D7).** 0 bps pool fee; venue yield accrues
100% to depositors pro-rata at settlement events. This epoch buys the moat and
the depositor story, not operator revenue.

## Reconciliation rule (inherited)
Every raw unit is principal, operator yield, transfer fee, remote execution
fee, or identified refund/residue; unexplained balance must be zero.

## Notes
- The five historical pool-lane requests currently spamming the observer are
  ALREADY terminal on-chain (sweeper fix dispatched separately); do not let
  their noise gate this ceremony — read `getRequest(id).status` directly.
- §B in the runsheet gets the final numbers on ceremony day via the formula
  above plus fresh reads (probe pattern: totalAssets / balanceOf / bufferFloor).

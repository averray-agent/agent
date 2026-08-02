# The gas-and-banking flywheel (decision note)

A strategy note, not a build spec — sits beside `BANK_YIELD_WORKSHOP.md`. It ties three
things that were found separately on 2026-08-02 into one loop: the measured brokered-gas
cost, the DOT-staking Bank angle, and the incentive to keep agent balances on-platform.
Pascal's framing: *this is the flywheel — start it early, and give agents a reason to bank
with us.*

## The loop

```
jobs run → protocol fees (USDC) + gas cost (DOT)
   → a slice of fees converts to staked DOT
      → DOT yield pays the gas  (FX-MATCHED: DOT cost, DOT yield)
         → gas is covered for agents who KEEP their balance on-platform
            → those balances are float
               → float is the money market
                  → the market pays yield → attracts more agents → more jobs
```

Usage funds its own gas; the float that usage leaves behind becomes the Bank. The thing
that creates the cost is the thing that pays for it.

## Why the FX match is the whole point

Gas is denominated in **DOT** (`~0.0748 DOT ≈ $0.059` per full job lifecycle, measured from
real mainnet receipts — `reference_brokered_gas_economics`). Funding it from **DOT** yield
means price drops out of the equation: you need N DOT/year, the pool produces N DOT/year,
DOT at $0.79 or $8 is irrelevant. This is the one place the Bank workshop's FX-trap
objection **inverts** — there, DOT yield paid USDC obligations (mismatched, punishing);
here, DOT yield pays a DOT obligation (matched). It is not a bet on DOT; it is the structure
where DOT's price stops mattering to us.

## The three moves, sequenced by precondition

### Move 1 — fee→DOT harvest (a policy, buildable ~now)
A standing rule: a fixed slice of accrued protocol fees converts USDC→DOT (via the live
Asset-Conversion precompile) and joins a staked pool. **The endowment is harvested, not
funded** — no "when do we have $2.4k" capital decision; the pool grows with usage. Composes
with the existing "fees accrue to 50 USDC before we touch them" decision — this just names
where the first slice goes. Endowment arithmetic: `principal = annual gas ÷ yield`, so at
~2.5% net, ~40× the annual gas bill fully self-funds it (1k jobs/yr → ~3,000 DOT; 10k →
~30,000). Below that it partially offsets — halving the gas line halves the exposure.

### Move 2 — gas-perk for on-platform balances (ships with the gas-fee change)
Reframe the *existing* gas subsidy, not a new one:

> Agents who keep earnings on-platform get gas covered; agents who sweep to their own
> wallet pay their own (via the retained-claim-fee mechanism —
> `reference_brokered_gas_economics` option 1).

Costs nothing extra; gives balances a reason to stay; and idle balances are exactly what a
money market needs. Same code path as the fee-retention change, plus one condition.

### Move 3 — agent yield (HARD precondition: observer proven on our own money first)
Paying agents yield on their balances is the flywheel's payoff **and its biggest risk** —
the moment a balance earns, we custody other people's money against an async cross-chain
settlement path that has never run in anger. This stays gated behind the treasury-first
phase-1 decision (`BANK_YIELD_WORKSHOP.md` + the Hydration verification): the observer must
prove out on operator capital before one agent's USDC is exposed. Do not accelerate this
one.

## Honest risks (attach to every move)

- **Float is a liability, not revenue.** The instant balances earn, we owe the yield. The
  truth-boundary rules apply to the UI: show the agent's balance, their accrued yield, and
  our obligation honestly — never a projected number as earned.
- **Gas-perk gaming.** An agent could park a nominal balance to qualify. Needs a threshold
  or proportionality rule (perk scaled to balance/activity), not a binary flag.
- **FX timing on the harvest itself.** Converting USDC→DOT on a schedule is a sell of USDC
  for DOT — be deliberate (fixed slice, regular cadence), not opportunistic/clever.
- **The unslashable flag is governance, not a constant** (`project_bank_yield_workshop`) —
  one referendum could reverse it; the staked pool inherits that risk.
- **Every DOT endowed is USDC not held.** Still a balance-sheet choice, just a well-hedged
  one; size it against the treasury's other needs.

## Recommendation

1. **Now:** adopt the fee→DOT harvest as policy (Move 1) — a decision, not a build; the pool
   starts compounding immediately and the first slice is tiny.
2. **With the gas-fee change:** ship Move 2 (retain claim fee post-tier + condition it on
   on-platform balance). One backend change, break-even by the gas measurement.
3. **Later, gated:** Move 3 agent yield — only after the observer proves phase 1 on treasury
   capital.

Nothing here commits capital today. Move 1 is the one tooth of the flywheel that can engage
now; the rest sequence behind preconditions already decided. Related:
`BANK_YIELD_WORKSHOP.md`, `reference_brokered_gas_economics`,
`project_supply_demand_competition`, `reference_reward_economics`.

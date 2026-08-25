# MEMO — How idle balances reach the venue

Status: **PROPOSED — for ratification** · Author: Claude (architect) ·
2026-08-25 · The design pass owed by `MEMO_IDLE_BALANCE_YIELD.md`, whose B1 I
sent back. **B2–B5 and Q1–Q3 there stand; this decides only the route.**

## I changed my mind twice. Here is what decided each turn.

1. **Pool as an AAC strategy (B1).** Sent back: `_checkAgentCap` caps a single
   adapter at 100 USDC *total*, and `_recordAgentShareHighWater` makes the
   adapter's balance the new `bufferFloor`, so
   `deployable = (25.29 + X) − X = 25.29` — flat. The floor absorbs the whole
   contribution.
2. **Direct per-agent venue allocation.** Also wrong, on economics rather than
   mechanics — see below.
3. **Back to the pool, with a targeted guard fix.** Where this lands.

The reversals were driven by measured facts, not preference, and the third
position explains why the first two failed.

## Why per-agent direct allocation cannot work

XCM round-trip friction is **flat per allocation** (~0.1296 measured in epoch
3), not proportional. If each agent allocates directly to the venue, each pays
it in full:

| agent balance | annual yield | weeks to repay ONE round trip |
|---|---|---|
| 5 | 0.5650 | **11.9** |
| 15 | 1.6950 | 4.0 |
| 25 | 2.8250 | 2.4 |
| 52 | 5.8760 | 1.1 |

Against the contract's **7-day** epoch cap, an agent with 5 USDC can never
break even — every cycle costs 0.1296 and earns 0.0109. Most agents are small,
so per-agent direct allocation is not a slow path, it is an impossible one.

Pooled, one round trip is amortised across every holder: ~68 deployed earns
7.68/yr and repays the same 0.1296 in **0.88 weeks**.

**The pool is not an obstacle to this design. The pool is the mechanism that
makes it possible.** Aggregation is precisely what a flat per-transfer cost
demands.

## The actual blocker, stated exactly

`DepositPoolV2` treats a strategy adapter as if it were an agent:

- `_checkAgentCap(receiver, …)` measures `balanceOf[receiver]` against
  `PER_AGENT_ASSET_CAP` — one adapter inherits one agent's allowance for the
  whole platform.
- `_recordAgentShareHighWater(receiver)` sets `maxIssuedAgentShares` to the
  adapter's balance, so `bufferFloor` rises to match it.

An adapter is **not** an agent. It is an aggregator whose underlying holders
are individually tracked in `AgentAccountCore.strategyShares[account][strategyId]`.
Both guards mis-classify it.

## Why relaxing the floor is correct, not a shortcut

The floor's own doc says what it is for:

> *"Non-transferable shares make the largest position ever issued an upper
> bound for every current agent position. Keeping the high-water mark is
> deliberately conservative after that agent exits."*

It exists to guarantee a **synchronous** exit. And the pool already has two
exit paths:

- `redeem(shares, receiver, owner)` — synchronous, needs buffer
- `requestRedeem(shares, receiver, NoticeTier)` — asynchronous, notice-tiered

**So the exemption is safe if it is paired with an obligation:** a registered
strategy adapter exits via `requestRedeem` only, never synchronous `redeem`.
The floor then reserves for exactly what it was designed to reserve for —
synchronous agent redemptions — and stops reserving against an aggregator that
does not use that path.

That is a coherent trade, not a weakening: we relax a guard *and* remove the
behaviour it was guarding against.

## Decisions proposed (R1–R5)

**R1 — Route idle AAC balances through DepositPoolV2**, not directly to the
venue. Aggregation is required by the flat XCM cost.

**R2 — Exempt registered strategy adapters from `_checkAgentCap` and
`_recordAgentShareHighWater`**, on the basis that an adapter is an aggregator
with per-holder accounting upstream in AAC. This is a **contract change to a
live pool holding real external money** — ceremony-grade, and it must be
scoped to adapters the registry actually knows, never to arbitrary contracts.

**R3 — In exchange, adapters exit only via `requestRedeem`.** Enforced in the
contract, not by convention. R2 without R3 is a genuine weakening of the
buffer guarantee.

**R4 — Amends B4.** `MEMO_IDLE_BALANCE_YIELD.md` promised deallocation
"synchronous, no notice, no penalty". Under R3 that cannot hold for the
adapter's own pool exit. The honest form: **an agent's deallocation is
synchronous while the adapter's uncommitted balance covers it, and queues with
a disclosed ETA beyond that.** Netting helps — one agent leaving while another
joins needs no pool interaction at all — but the promise must not overstate.
**A deallocation that silently takes days after we advertised "instant" is the
same defect class as "NAV share active".**

**R5 — Authority is the cold multisig, three calls.** Verified live:
`policy.owner()` = `0x01E6eed8…` (the 2-of-3), and both the registry's
`registerStrategy`/`setStrategyActive` and the policy's approval are
`onlyOwner`. Enabling the route needs
`setApprovedStrategy` → `registerStrategy` → `setStrategyActive`.

## Established state (verified live 2026-08-25)

| fact | value |
|---|---|
| `policy.owner()` | `0x01E6eed8…874C` — cold 2-of-3 multisig |
| `policy.approvedStrategies(v1 venue adapter)` | **false** — blocks registration |
| `policy.approvedAssets(USDC)` | true |
| AAC strategy registry | **no active strategy** |
| v1 venue adapter `0x96091d44…` | drained: totalShares 0, totalAssets 0, holds 0 USDC |
| pool `maxIssuedAgentShares` | 10.000000 |
| pool `bufferFloor` / `maxDeployableAssets` | 9.908397 / 15.385106 |

The v1 adapter is intact, implements `IStrategyAdapter`, and self-describes as
*"Async Hydration USDC supply; observer-capped terminal recovery account"*. It
was deliberately deregistered after the v1 recall. **Under R1 it is not needed**
— the pool's existing venue lane is the route, and this adapter was the
per-account direct path that R1 rejects. Leave it deregistered.

## Open questions for the ratifier

**Q1 — Is a live-pool contract change acceptable for this?** R2 modifies
`DepositPoolV2` while it holds real external money (the tester's 5 USDC among
it). The alternative is deploying a pool v3 and migrating, which costs a
migration that must price itself — the same trap the bank lane hit before.
I lean to the targeted change: it is small, its semantics are provable, and
migration risk exceeds it. **But this is the highest-risk item in the memo and
it is your call, not mine.**

**Q2 — Should the per-agent cap apply to the aggregate at all?** R2 exempts the
adapter, but a single agent could still route more than `PER_AGENT_ASSET_CAP`
through it, since AAC tracks their share separately. If the cap is a real risk
limit rather than a pilot guardrail, it must be re-enforced **upstream in AAC**
per account — otherwise R2 quietly removes it.

**Q3 — What is the adapter's uncommitted-balance target?** R4's "instant while
covered" needs a number. Too low and deallocation queues often, breaking the
retention promise; too high and capital sits idle, defeating the purpose. This
wants measurement once there is real allocation behaviour, not a guess now.

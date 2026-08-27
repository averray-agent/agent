# MEMO — The commitment ladder: why longer locks earn more, honestly

Status: **DRAFT — decisions D1–D5 open** · Author: Claude (architect) ·
2026-08-27 · Operator direction: Pascal, 2026-08-27 —
*"flex without any binding is less and no perk, then 7 day, 30 and 90 each with
more yield and more perks. Also on the locks the credit comes into play as a
perk."*

Supersedes the premium-funding constraint in `MEMO_IDLE_BALANCE_YIELD.md`
(Q2), which offered only two sources for a tier premium: the operator pays it,
or Flex holders are quietly paid less than they earned. **There is a third
source, and it is the honest one.**

## The finding that makes the ladder self-funding

XCM round-trip friction is **flat** — 0.129576 measured in epoch 3 — while
venue yield is **proportional and time-based** (~11.3%/yr implied). So the net
rate a holder can earn depends on how long their capital can stay deployed:

| deployed | 7d window | 30d window | 90d window |
|---|---|---|---|
| 10 | −56.3% | −4.5% | **+6.0%** |
| 20 | −22.5% | +3.4% | **+8.7%** |
| 50 | −2.2% | +8.1% | **+10.2%** |
| 100 | +4.5% | +9.7% | **+10.8%** |

Break-even deployed size: **7d 59.79 · 30d 13.95 · 90d 4.65 USDC.**

**A lock is not a marketing instrument. It is the input that makes yield
possible.** Committed capital can be deployed for longer, pays the flat toll
less often, and therefore genuinely earns more per unit. The premium is
produced by the commitment, not transferred from anyone.

This also explains why Flex must pay ~nothing at our scale and why that is
truthful rather than stingy: at 7 days, capital below ~60 USDC **loses** money
every cycle. Paying Flex a yield today would be the operator subsidising a
negative-carry position and calling it a return.

## The blocker

`DepositPoolV2.deployToVenue` hardcodes its ceiling:

```solidity
uint64 maximumReturnBy = uint64(block.timestamp + NOTICE_7_DAYS);
if (returnBy > maximumReturnBy) revert VenueDeadlineExceedsNoticeTier(...);
```

The pool already defines `NOTICE_30_DAYS` and `requestRedeem` already uses a
`NoticeTier` enum — but **deployments can never exceed 7 days, and the enum has
no 90-day member.** The 30-day tier exists and is unreachable for deployment.

So the entire ladder is gated on a **v2.2 contract change plus a migration
ceremony** — the same cost we just paid for v2.1. That is the honest price.

## The invariant the design must not break

**The deployment window may never exceed the shortest commitment among the
capital deployed.** Deploy Flex money on a 90-day window and the pool cannot
honour a synchronous exit — that is a depositor-facing lie of exactly the class
we have been strict about, and it would be discovered at the worst moment.

Concretely the pool must track committed capital by maturity and cap each
deployment's `returnBy` at the earliest maturity in the deployed set (minus a
safety margin, as with the existing 6d20h practice). A 90-day deployment may
only draw on 90-day-committed capital.

This is the whole engineering problem. Everything else is parameters.

## Decisions needed

**D1 — Tier set.** Operator direction is Flex / 7 / 30 / 90. Confirm, and
confirm Flex pays **no** yield (which the arithmetic says is the truthful
position at current scale, not a product choice).

**D2 — Is the rate purely earned, or floored?** Purely earned means the rate
each tier quotes is whatever its window produces, and it moves with venue rate,
friction and cohort size. A floor means the operator tops up to a promised
number. **Earned-only is honest and self-funding; a floor is acquisition spend
and must be disclosed as such under Y3's earned-vs-added split.** Recommend
earned-only until there is a reason otherwise.

**D3 — Credit as a lock perk.** Operator direction: locks unlock credit. The
L2/L3 book already underwrites from settlement history. Open: does a lock raise
the borrow cap, lower the rate, or both — and is locked capital collateral
(changing the risk model) or merely a qualification signal (not)? These are
very different builds. Recommend **qualification signal first**: locked
balances are already debt-gated on withdraw, and treating them as collateral
invites a liquidation design we do not want yet.

**D4 — Early exit.** `LOCKED_TIER_EARLY_EXIT_TERMS` and a forfeit-terms hash
already exist. Confirm they carry forward, and that early exit forfeits *yield*
rather than principal — principal forfeiture on a technical pilot would be
indefensible.

**D5 — Sequencing.** The ladder needs v2.2 + ceremony. Options: (a) build the
contract change now and ship the ladder as one programme; (b) ship the
*non-yield* perks first (priority, caps, credit qualification) on the existing
contracts, and add the yield ladder when v2.2 lands. **Recommend (b)** — it
delivers the retention levers in weeks rather than after another ceremony, and
the measured latency finding says friction removal may matter more to agents
than rate anyway.

## What must not be built before the numbers are re-measured

The 11.3% rate and the 0.129576 friction are each **a single observation** from
epoch 3. Every figure in this memo scales off them. Before any tier advertises
a rate to an external agent, re-measure both on a live deployment — a ladder
quoting a rate derived from one historical data point is a forecast wearing the
costume of a fact.

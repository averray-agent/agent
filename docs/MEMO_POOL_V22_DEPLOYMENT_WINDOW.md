# MEMO — v2.2: letting the pool deploy for longer than seven days

Status: **DRAFT — decisions W1–W4 open** · Author: Claude (architect) ·
2026-08-27 · Authority to act on: `MEMO_COMMITMENT_LADDER.md` (RATIFIED),
whose yield ladder is entirely gated on this.

## I under-scoped this. It is not a one-constant change.

I have been describing v2.2 as "let `deployToVenue` use a window longer than
seven days," pointing at:

```solidity
uint64 maximumReturnBy = uint64(block.timestamp + NOTICE_7_DAYS);
if (returnBy > maximumReturnBy) revert VenueDeadlineExceedsNoticeTier(...);
```

**That constant is a symptom, not the cause.** Verified in the v2.1 source:

- The pool has **no concept of commitment or maturity**. `lockedShares` is a
  pending redeem request; `pledgedShares` is credit collateral. Neither is a
  time commitment.
- The 7-day cap exists because **any** holder may call
  `requestRedeem(shares, receiver, Notice7Days)` and must be paid within seven
  days. The pool must therefore always be able to recall from the venue in
  seven.
- The `NoticeTier` enum has only `Notice7Days` and `Notice30Days`; there is no
  90-day member.

Raising the constant without teaching the pool who can demand exit when would
let a 90-day deployment strand a Flex holder's synchronous redemption. **That
is a depositor-facing lie of the worst kind** — discovered exactly when someone
needs their money.

## The correct generalisation

`bufferFloor` already reserves against worst-case *synchronous* exit. The
window question is the same idea with a time axis:

```
deployableFor(D) = bufferAssets − assetsExitableWithin(D)
```

Deploy for D days only what nobody can demand back inside D days.

**One fact makes this tractable: shares are NON-TRANSFERABLE**
(`transfer`/`transferFrom` both revert). Balances change only on mint and burn,
so per-holder tier accounting cannot be silently invalidated by a transfer.

## Options

**A — On-chain per-holder notice tiers.** Add `Notice90Days`; record each
holder's minimum notice tier; maintain aggregate share totals per tier on
mint/burn; `deployToVenue` takes a window and checks it against those
aggregates. *Strongest guarantee, fully verifiable by anyone, largest audit
surface.*

**B — Operator-declared commitment floor.** The multisig declares "N assets are
committed for at least D days," derived from the backend locked-tier ledger;
the pool bounds deployment windows against that declaration. *Far less code;
moves the guarantee from arithmetic to operator attestation. Must be disclosed
as operator-attested, exactly like the Y3 subsidy ledger — and a wrong
declaration means a holder cannot exit.*

**C — Tier-segregated pools.** One pool instance per commitment tier, each
deploying on its own window. *Cleanest invariant; fragments liquidity badly at
14 USDC of assets and multiplies every ceremony by the number of tiers.*

## The sequencing problem — read this before choosing

**v2.2 buys nothing on the day it ships.** Under any option,
`deployableFor(90d)` is the capital that genuinely cannot leave for 90 days,
and **today that is zero**: every current holder is effectively Flex. We would
be building the machine before there is anything to put in it.

And the ladder cannot fill it first, because agents commit for yield and yield
needs v2.2. That is circular.

**The way out is the operator's own capital.** The adapter position is
4.073522 today, and a 90-day window breaks even at **4.65 deployable**. If the
operator commits its own capital for 90 days, the lane crosses into positive
territory on operator money alone — and only then can we quote an *earned*
rate to an external agent without it being a forecast.

That is also the honest order: we take the illiquidity risk first, measure the
real rate, and sell only what we have actually observed.

## Decisions needed

**W1 — Which option?** Recommend **A**, on the grounds that B's guarantee is an
attestation about whether someone can withdraw their own money, which is the
one place this platform should not substitute a promise for arithmetic.

**W2 — Add `Notice90Days`?** The ladder assumes it. Confirm, and confirm no
tier longer than 90 days for now.

**W3 — Does the operator commit first, and how much?** Recommend yes: it is the
only way to bootstrap out of the circularity, and it makes the first quoted
rate a measurement rather than a projection.

**W4 — Migration.** v2.2 is a new contract; the v2.0→v2.1 choreography
(withdraw → redeploy → re-migrate, tester at leisure) applies again, plus the
D-03 waiver dance. **The tester still holds 5.026011 in v2** — they would be
asked to move a second time in under a month. Decide whether to migrate now or
batch v2.2 with any other pool change so they move once.

## Before any of this is built

Every figure justifying v2.2 rests on **two single observations** from epoch 3
(11.3%/yr implied, 0.129576 friction). The case for spending a contract
ceremony on a 4.3× break-even improvement is only as good as those two numbers.
**Re-measure both on a live deployment first** — which, note, requires no
contract change at all: a 7-day deployment at today's size would cost about
0.12 and buy a second data point on both.

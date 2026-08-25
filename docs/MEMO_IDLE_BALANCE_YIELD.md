# MEMO — Earn where the money already sits

Status: **RATIFIED — B1–B5 + Q1/Q2 answered (Pascal, 2026-08-25)** · Author: Claude (architect) ·
2026-08-25 · Supersedes the framing of the locked-capital question in
`MEMO_YIELD_SUBSIDY.md` ("the real open question this exposed").

## The operator thesis

> *"Why should the agent take his money out when he doesn't need it right
> away? Everything has to build around it to make it the best choice to just
> keep their funds with us. So one part is yield, so it's not just sitting
> idle in our platform."* — Pascal, 2026-08-25

Retention, not a yield product. Yield is one reason among several for funds to
stay. That reframing is correct and this memo adopts it.

## A correction I made twice, because it decides everything

I first read `ReservationSettled(account, recipient, …)` as value leaving to a
worker's wallet, and reported that funds are "already out" — that retention was
hopeless because nothing ever sits with us. **That was wrong.** In
AgentAccountCore the `recipient` is a *position key*, not a transfer
destination; the USDC never leaves the contract. The three wallets I sampled
read zero because they are ephemeral canary wallets that had already swept.

Measured live 2026-08-25:

```
USDC held INSIDE AgentAccountCore   119.348522
  operator signer   liquid 16.073522 | reserved 9.950000
  tester            liquid  0.150000 | reserved 1.050000
DepositPoolV2 totalAssets            25.293503
```

**So there is roughly 119 USDC on the platform right now, earning nothing** —
about 4.7× the entire deposit pool. The thesis is not aspirational; the idle
balance already exists and is the larger pot.

## The structural problem

The only route from an earned balance to yield today is:

> withdraw from AAC → deposit into DepositPoolV2 → receive pool shares

Three things are wrong with that, and they are exactly the shape that makes
leaving easy and staying hard:

1. **It requires a decision.** Retention that depends on an agent choosing to
   act is retention you mostly do not get.
2. **It moves working capital.** The same balance backs claims and bonds. An
   agent that deposits it into the pool cannot use it for work.
3. **It is a separate product.** Pool shares are not the earned balance; they
   are a thing you migrate into.

The locked tier does not fix this — it is a *third* pot with its own consent,
its own cap, and (per `RUNSHEET_VENUE_REDEPLOY_SUBSIDISED.md`) no venue
exposure at all. Verified: the locked T90 seed holds **0.000000 pool shares**.

## The mechanism already exists on chain

`AgentAccountCore` has per-account strategy allocation, live today:

```solidity
function allocateIdleFunds(address account, bytes32 strategyId, uint256 amount)
    onlyAccountOrSettlementBroker(account)
{
    ...
    position.liquid -= amount;
    uint256 sharesMinted = adapter.deposit(amount);
    strategyShares[account][strategyId] += sharesMinted;   // per-account yield
}
```

Four properties that matter, all already true:

- **Per-account accounting.** `strategyShares[account][strategyId]` — each
  agent's yield is tracked individually. No pooled-share migration needed.
- **The platform may act for the agent.** `onlyAccountOrSettlementBroker` —
  so this can be automatic rather than a decision. *This is also the sharpest
  risk; see Y3′ below.*
- **Reserved funds are protected.** `_requireWithdrawable` respects reserved
  and debt, so escrowed job capital cannot be swept into a venue.
- **Withdraw is already debt-gated** (established at the credit workshop).

**What is missing is only a destination.** Live read: the AAC strategy
registry has **no active strategy** — `HYDRATION_USDC_POOL_V1` resolves to
adapter `0x0000…`, `active: false`. The allocation path exists and points
nowhere.

Note `allocateIdleFunds` reverts for **async** adapters. DepositPoolV2's
`deposit`/`redeem` are synchronous, so a thin pool adapter fits the sync path;
the async `requestStrategyDeposit` remains available if a direct venue route is
ever wanted.

## The proposal

**Register DepositPoolV2 as an AAC strategy, so an idle balance earns where it
already sits.**

An agent's `liquid` allocates into the pool; the pool does what it already does
(buffer, venue, gate); `strategyShares` tracks the agent's claim. No migration,
no second product, working balance stays in the working account, and
deallocation is synchronous back into `liquid`.

Locked tiers then become what they should always have been: a **commitment tier
on top of a balance that already earns**, buying priority and perks — not the
only door to yield.

## The scale effect — this may retire the subsidy

The venue lane needs **~60 USDC deployed** to break even at the 7-day cap. The
pool can currently deploy **15.4**, which is why Y1 requires an operator
subsidy.

Bring AAC idle balances into the same pool and the deployable base grows toward
the ~119 USDC already on the platform. **At that scale the lane plausibly
funds itself**, and Y5's retirement condition is met by wiring rather than by
waiting for deposits. The capital to make the yield lane viable is already
here — it is in the wrong pot.

I have not modelled how much of the 119 is genuinely free versus reserved
against open jobs. That number gates the claim above and must be measured
before anyone relies on it.

## Decisions — RATIFIED (Pascal, 2026-08-25)

**B1 — Idle AAC balances become yield-eligible** by registering DepositPoolV2
as an active AAC strategy. No new venue, no new pot.

**B2 — Allocation leaves working headroom.** An agent must never be unable to
claim work because its balance was allocated. Reserve a floor (and respect
`_requireWithdrawable`), sized so the agent's typical claim + bond stays
instantly available.

**B3 — Consent is explicit and per-agent, never implied by holding a
balance.** `onlyAccountOrSettlementBroker` lets the platform allocate an
agent's money automatically. **That is the most dangerous line in this memo.**
Automatic allocation of a balance an agent has not opted in to is
indistinguishable, from their side, from us spending their funds. Opt-in,
revocable, and legible on every surface.

**B4 — Deallocation must be as easy as it is automatic.** Synchronous return
to `liquid`, no notice, no penalty. The retention argument only holds if
staying is attractive rather than sticky; anything else converts a yield
feature into a lock-in complaint.

**B5 — Yield shown per agent, and honestly split.** With Y3 the surface must
already separate venue earnings from operator subsidy; here it must also
attribute per-agent. An agent should see what its own balance earned, and how
much of that we added.

## What this does not change

The activation gate, per-wallet caps, the deposit gate (#1287), consent text
for existing locks, or the shelved `PACKET_LOCKED_CAPITAL_DEPLOYMENT.md`.

## Questions — ANSWERED (Pascal, 2026-08-25)

**Q1 — Opt-in or opt-out? → OPT-IN, with a strong offer.** The agent
explicitly enables earning on its idle balance, and we make the offer
obviously worth taking: a real rate, instant deallocation, no penalty. We
accept losing the retention from agents who never opt in. The reasoning stands
as written — `onlyAccountOrSettlementBroker` means we *could* do this silently,
and the first time an agent discovers we moved funds it did not consent to, we
lose the trust the platform runs on. **B3 is therefore binding, not advisory.**

**Q2 — What happens to locked tiers? → THEY BECOME THE TOP OF A LADDER.**
Not retired, not priority-only. A lock buys **more yield than an idle balance,
plus priority, plus further perks still to be designed.** The product becomes
one continuous story rather than three pots:

| | liquidity | yield | priority |
|---|---|---|---|
| idle AAC balance (opt-in) | instant | base rate | none |
| T30 | 30-day term | **above base** | above Flex |
| T90 | 90-day term | **best rate** | top, + committed flag |

**Q3 — How much of the 119 is free? → at least 52.568522 USDC.** Measured live
2026-08-25 across 9 accounts holding positions: liquid **52.568522**, reserved
11.000000, strategyAllocated 0. A further **55.78** is unattributed — accounts
outside the 200k-block scan window — so the true free figure is higher, not
lower. **This clears the scale claim:** 52.57 free plus the pool's 15.4
deployable is ~68 against a ~60 break-even, so the lane can be self-funding
without the Y1 subsidy once idle balances are wired in.

## The constraint Q2 creates — where does the premium come from?

A lock must pay **more** than an idle balance. The venue produces **one** rate,
so a premium has to come from somewhere, and there are only two sources:

1. **The operator pays it** — the premium is acquisition spend, exactly as Y1
   framed the friction subsidy. Honest, bounded, and disclosable.
2. **Flex holders are paid less than they earned** — a cross-subsidy from
   liquid depositors to locked ones.

**Option 2 is prohibited unless it is disclosed in those words.** Quietly
routing part of a Flex depositor's earnings to locked depositors is the same
class of defect as this morning's "NAV share active": a surface describing a
benefit the holder is not actually receiving. If a cross-subsidy is ever
wanted, it must say so plainly on the Flex surface.

**Default: option 1.** The premium is operator-funded and disclosed under
**Y3**'s earned-versus-added split, which already exists to separate venue
earnings from operator contribution. The tier ladder is a marketing
instrument funded like one.

Sizing is a later decision. It should be set against what the tier is meant to
buy — retention and commitment — not against what the venue happens to yield.

## Still to invent

Perks beyond yield and priority are explicitly open (Pascal, 2026-08-25). The
tier ladder is the frame; what fills the T30/T90 rows past the rate premium and
claim priority has not been designed. Candidates worth considering when that
work starts: higher per-wallet caps, credit-line terms (the L2 book already
underwrites from settlement history), reduced retention on rewards, or
priority in dispute handling — none of these are decided.

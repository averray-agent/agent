# MEMO — Yield as acquisition spend, not as a P&L line

Status: **PROPOSED — for ratification** · Author: Claude (architect) ·
2026-08-25 · Follows the epoch-3 recall (`RUNSHEET_VENUE_RECALL_V2.md`) and
amends the posture set by **D3**.

## The correction that prompted this

I reported the venue lane as "5.4× wash-negative" and recommended closing it.
The ratio is right and the framing was wrong. The decision-relevant number is
absolute: the round trip costs **0.1296 USDC per 7-day cycle — about $6.75 a
year.** That is not a bleeding wound, and presenting a ratio where magnitude
was the operative fact pushed toward the wrong conclusion.

Operator judgment (Pascal, 2026-08-25): we already spend to acquire agents, and
a live yield story is a genuine demand lever. Judged as acquisition spend rather
than as a profit centre, $6.75/year is trivially cheap. **That reasoning is
sound and this memo adopts it.**

## The real objection — it was never cost

Friction is paid out of pool assets. `totalAssets() = bufferAssets() +
venuePrincipalCostBasis`, so every cycle's cost lands on the share price and is
borne by **depositors**, pro-rata. Running the lane for the story therefore
means depositor balances tick down while we advertise yield.

At current size the pool nets **−0.0964/cycle**: 0.0332 earned on 15.385
deployable against 0.1296 of friction — about −0.38%/year to depositors.

So the objection is not "it loses money." It is **"it loses *their* money."**
That is a truth-boundary problem, and it dissolves entirely once the operator
carries the friction.

## The mechanism already exists — no contract change

`bufferAssets()` reads `IERC20PoolAsset(asset).balanceOf(address(this))`, the
pool's raw token balance. **A plain USDC transfer to the pool address therefore
raises `totalAssets` with `totalSupply` unchanged, lifting the share price for
every holder.** That is a donation, and it is the subsidy rail.

Do **not** use `contributeOperatorPrincipal` for this. It mints shares
(`_mint(address(this), …)`) and books `operatorContributedPrincipal` — operator
capital *participating* in the pool, not subsidising it. It cannot raise the
price for depositors because it raises supply alongside assets.

## Subsidy vs. topping up — the capital-efficiency answer

Both work. They are not close.

Relevant fact: `_recordAgentShareHighWater` is called only from the agent
deposit/mint paths. **`contributeOperatorPrincipal` never raises
`maxIssuedAgentShares`, so operator capital does not raise the buffer floor and
is fully deployable.** Topping up is genuinely efficient in that narrow sense —
it just needs a great deal of capital.

| approach | cost to operator | depositor APY at today's size |
|---|---|---|
| **Subsidise friction** | **~$6.75/year, no capital locked** | **~6.9%** |
| Top up to break-even | ~45 USDC parked | ~0.1% (nobody gains) |
| Top up for ~6% | ~125 USDC parked | ~6.0% |

Subsidising delivers a *better* depositor rate than a 125-USDC top-up, for
seven dollars a year and no locked capital. **Recommendation: subsidise; do not
top up for this purpose.** Add capital only if you want the TVL or buffer depth
for their own sake.

Break-even for an unsubsidised lane remains ~60 deployed (~70 TVL, a 44.6 gap),
and that number is unreachable-by-growth in any near term. The subsidy removes
it as a constraint entirely — the lane runs at any size.

## Decisions proposed (Y1–Y5)

**Y1 — Reopen the lane, subsidised.** D3's "do not redeploy" was correct while
depositors bore the friction. With the operator carrying it, redeployment is no
longer a knowing loss to anyone and the ~62-USDC threshold stops binding.

**Y2 — The operator pays the measured round-trip cost into the pool each
cycle**, by direct USDC transfer to the pool address, sized from the cycle's
actual fee ledger rather than an estimate. Underpaying silently shifts the
remainder back onto depositors, so the payment is part of the cycle, not an
afterthought.

**Y3 — Disclose the split. This is the load-bearing condition.** A raw transfer
is invisible to pool accounting, so a subsidised price rise is indistinguishable
from venue earnings unless we say otherwise. Depositor surfaces must show **what
the venue earned** and **what the operator added**, separately, and must not
describe subsidised yield as earned. Presenting subsidy as yield is the same
failure as the "NAV share active" defect found today, only better funded.

**Y4 — Label the lane as operator-backed while it is subsidised.** The kind of
depositor we want will work out unaided that a 25-USDC pool cannot generate real
yield; saying it first costs nothing and buys credibility. It also makes Y5
legible rather than looking like a rate cut.

**Y5 — Retirement condition, stated up front.** The subsidy ends when the lane
is self-supporting: **~60 USDC deployed at the 7-day cap**, or **~14 deployed if
`Notice30Days` becomes usable in `deployToVenue`** (currently hard-capped at
`NOTICE_7_DAYS`, `DepositPoolV2.sol:444-445`). The 30-day amendment is worth
more than four times what the deposits are — it is the highest-leverage change
available to this lane.

## What this does not change

Consent text, activation-gate economics, per-wallet caps, the deposit gate
(#1287), and the locked-tier ladder. `PACKET_LOCKED_CAPITAL_DEPLOYMENT.md`
stays shelved: deploying *locked* capital is a separate decision from running a
subsidised operator lane, and the locked cohort's consent describes venue gain
or loss, not a subsidised rate.

## Open question for the ratifier

**Q — Does the subsidy extend to locked deposits, or only to Flex?** Locked
consent promises pro-rata venue gain *or loss*; a subsidy that erases the loss
is more generous than what was signed, which is safe, but it makes the locked
tier's advertised risk profile untrue in the depositor's favour. Cleanest is to
subsidise the pool as a whole — everyone holds the same shares — and to describe
it accurately for both tiers rather than splitting the rail. Recommendation:
**one pool, one subsidy, disclosed to both.**

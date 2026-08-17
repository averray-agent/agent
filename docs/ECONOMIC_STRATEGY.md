# Economic strategy — where the money goes, where it should come from

**Author:** Claude · **Ratifier:** Pascal · **Date:** 2026-08-12
Status: analysis + seven decisions, each with a recommendation that stands unless overridden.
Every number below is measured on mainnet, not modeled.

## 1. The measured constants

| constant | value | source |
|---|---|---|
| Gas per job lifecycle (brokered) | 0.0748 DOT ≈ **$0.059** | measured 2026-08-02 |
| Gas share of a 0.25 job | **24%** | same |
| Venue round-trip friction | **0.202% absolute** at 10 USDC (≈ flat cost, shrinks with size) | epoch-1 |
| Peak uncapped reward burn | 17.95 USDC / 24h | 2026-08-12 chain tally |
| Capped burn ceiling | ~1.50 /day/wallet (+1:1 per deposited) | D live |
| Poster fee | 5% poster-side additive, LIVE | EscrowCore v2 |
| Protocol revenue to date | **0.29 USDC** | treasury multisig |
| Claim-fee retention | built, **inert until v3 ceremony**; `claimFeeBps` is per-job, currently 0 | #1078 |
| Pool platform fee | **0 bps** (compile-time) | DepositPool |
| Canary cost | 0.1 USDC/run, accepted | #1085 |

## 2. Per-job P&L — the whole business in three rows

| job type | reward | gas (ours) | fee in | **net to us** |
|---|---|---|---|---|
| Self-posted, today | −0.25 | −0.06 | 0 (self-fee is circular) | **−0.31** |
| Self-posted, post-v3 (claim fee ≈ gas) | −0.25 | −0.06 | +0.06 | **−0.25** |
| **External-posted, post-v3** | 0 (poster funds it) | ≈−0.03 settle | +5% + retention | **positive** |

Three consequences, in ascending importance:

1. **The v3 ceremony is worth $0.06 on every job forever** — the single highest-ROI
   pending action. It also retires the D-03 waivers.
2. **Gas is flat, so job size is an efficiency lever.** On a 0.25 job gas is 24%; on a
   1.00 job it is 6%. Dust jobs are the most expensive thing we sell.
3. **The business is the mix shift.** Every self-posted job is marketing spend; every
   external job is margin. The one metric that is the strategy:
   **% of settled jobs that are externally posted** (today: ~0%).

## 3. The flow map — nothing moves by itself

```
YOU ──top-ups──► REWARD BANK ──payouts──► workers
YOU ──ceremony──► POT 1 (venue) ──yield──► accrues (unbooked until recall)
external posters ──5% fee──► TREASURY MULTISIG ──► (accumulates, no outflow wired)
depositors ──deposits──► POOL ──(post-ceremony)──► venue yield ──100%──► depositors
```

Every inter-bucket move is an operator ceremony. Correct at this scale (provable books),
but it means "fees fund the platform" is a design with two unlocks in front of it:
external demand, and v3.

## 4. Seven decisions

**D1 — Fee routing: 100% of protocol revenue recycles into the reward bank** until
monthly protocol revenue ≥ monthly reward spend (the crossover). Growth phase: fees fund
more jobs, not a balance sheet that is currently ~$20. Revisit at crossover — that day,
routing to pot 1 becomes a real question.

**D2 — Ceremony order: yield legs A–C with the dogfood week (already scripted, 2 USDC,
proves the depositor story), v3 immediately after.** Pure ROI says v3 first; product
momentum says the dogfood chain shouldn't break. Both are mornings; do both within days.
After v3, set `claimFeeBps` per D4.

**D3 — Catalogue spend is CAC; tune it per lane by what it buys.**
- Liveness-only lanes (Data.gov, OpenAPI, standards): cut rewards to **0.10** — they buy
  proof-of-life, which 0.10 buys as well as 0.25.
- OSS-anchored lanes: keep **0.25–0.50** — they buy public artifacts, maintainer
  relationships, and the funnel (the first external worker came through them).
- Add a **≥0.50 standard tier** for post-onboarding jobs: halves gas share, raises the
  quality bar, and makes D4's fee math gentle.
- Metric: cost per retained external worker (arrived-and-still-active), not cost per job.

**D4 — `claimFeeBps` policy at v3: price to recover measured gas at each size, floor it
at dust.** Gas is ~flat $0.06 → on a 0.10 job that is 60% (unpayable — dust jobs stay
fee-waived as onboarding spend, knowingly); 0.25 → ~2400 bps; ≥0.50 → ≤1200 bps. Publish
the schedule in the job listing — workers must see the fee before claiming (preflight
parity applies to economics too).

**D5 — Idle-capital sweep policy: monthly, every wallet.** Test wallets (~5.5 USDC,
task #41), our worker EOA's accumulated earnings, any residue — swept to the reward bank.
An idle USDC outside a position is dead capital; at our scale the discipline matters more
than the amount.

**D6 — Do NOT deploy reward-bank float to the venue yet.** Payout liquidity is the
product's heartbeat; cents of yield never justify a payout failure. Revisit at ≥100 USDC
standing float with a hard liquidity-floor rule — the pool's 50% policy is the template.

**D7 — The pool stays at 0 bps deliberately.** Depositors keep 100% of venue yield. The
pool pays us in Sybil resistance, throughput gating, and capital stickiness — that is the
moat, and 0 bps is its adoption price. Revisit only at TVL approaching the 1,000 cap,
as a pool-v2 question (the fee is a compile-time constant; changing it is a redeploy).

## 5. North-star metrics (the board should grow these tiles eventually)

1. **External share of settled jobs** — the strategy in one number
2. **Protocol revenue vs reward spend** — distance to crossover (today: 0.29 vs ~45/mo capped)
3. **Cost per retained external worker** — is the catalogue CAC working
4. **Idle-capital ratio** — USDC outside any position ÷ total operator USDC
5. **Pool TVL + depositor count** — the moat's depth

## 6. The strategy in one sentence

Spend deliberately on the catalogue as CAC, recover costs at v3, shift the mix toward
external posters who pay us 5% to use rails we already run, and let the pool make worker
capital sticky at zero margin — because the durable business is being the place agent
money lives, not the place it passes through.

## 7. External review — consolidated verdict, recorded 2026-08-13

The second pair of eyes returned **conditional adoption**: the strategy stands, gated on three
blockers. Status at recording:

1. **D0 — entitlement design (BLOCKER, design-for-scale not live emergency).** Deposits must buy
   concurrency, job-risk limits, and access to externally funded work — never renewing entitlement
   to operator-funded catalogue rewards, which move under a separate global budget deposits cannot
   raise. Vesting 24–72h, instant decay on withdrawal, concave scaling; onboarding = finite lifetime
   credit. **Answered: `PACKET_D0_VESTING.md` (this branch, 382ab66)** — must land before pool-cap
   or catalogue-budget raises. Reframe adopted everywhere: a time-weighted deposit is one
   capital-backed trust-and-capacity signal alongside verified work history, not "identity."
2. **Measurement before pricing (BLOCKER) — CLOSED.** `GAS_STUDY_2026-08-13.md`: worked path
   $0.038/claim, posting path $0.028/listing, external settle-only p50 $0.017 (82 samples), settle
   p95 = 2× p50, zero failed txs; the old $0.059 figure bundled both paths. D4 fee design is
   unblocked and must cite these numbers, not the bundled figure.
3. **D8 — Swiss regulatory memo (BLOCKER for deposit scale).** Operating rule ratified and in
   force until the memo returns: pool stays **capped** (1,000/100), **quiet** (no solicitation),
   **disclosed** ("Technical pilot. Principal at risk. No depositor protection." — shipping via
   D0-F). Commissioning the memo is operator-side and outside this repo. Credit-layer carve-out
   per the addendum: protocol-style peer-to-pool design work may proceed; only operator-held or
   operator-directed lender funds wait on the memo.

**Decision-table dispositions:** D1 keep (catalogue = CAC under explicit capped budget, relabeled
subsidy); D2 keep with sequence — D4 fee schedule finalized **before** the EscrowCore v3 ceremony,
so the ceremony ships the fee constants once; D3 add lane-level hypothesis/cap/stop discipline
(open packet); D4 hybrid fee schedule now unblocked by the gas study; D5 keep minimum-payout
threshold, fold into the test-wallet sweep; D6 keep; D7 keep with the verification-economics
caveat below.

**Named risk to carry:** verification economics — auto-verify (benchmark + deterministic modes)
is what makes $0.038/claim viable; any drift toward human/dispute-heavy verification breaks the
unit economics before it breaks the software. Watch dispute rate as a cost signal, not just a
trust signal.

**30-day plan (clock started 2026-08-12, gates due by 2026-09-11):** D0 landed in production;
gas-informed D4 fee schedule decided on measured numbers; Swiss memo commissioned; 20 qualified
poster conversations (the three-threshold crossover math says external posting volume, not
deposit volume, is what moves the business); pool unchanged at 1,000/100 throughout.

**Status 2026-08-16 — D2/D4 LIVE AND PROVEN.** The v3 fee era (live since #1111, 2026-08-13)
produced its first real charges in settlement tx `0x4f0c2a63…7038` (blk 19535884): gas retention
0.05 + poster fee 0.05 → treasury on a non-waived brokered 0.25 claim (worker net 0.20, claim
lock returned exactly), and `cancelOpenJob` proved both floor directions same day (revert at 54s
inside the 1h floor; success at 3,623s with the exact 0.150 refund, tx `0x30175585…`). Caveat for
every revenue read: operator-curated non-waived jobs pay the poster fee from the operator's own
bank (`ensureJob` couples fee waiver to the onboarding flag), so self-paid fees must never be
presented as external revenue. 30-day gates: D0 ✓, D4 ✓ proven; Swiss memo and the 20 poster
conversations remain the open gates.

**Superseded 2026-08-17 evening (outcome-assurance pivot, ratified by Pascal):** the
"20 qualified poster conversations" back half of the 30-day plan is replaced by the
outcome-assurance experiment — same due date (2026-09-11), same conversation budget
(19 of 20 remaining), re-segmented 8 MCP/agent-tool operators · 6 devtool/OSS
maintainers · 6 agent-platform builders, with the ask changed to "what result are you
currently paying for where payment is disconnected from objective proof it worked?".
Success criteria and kill conditions live in `docs/PROJECT_ROADMAP.md` (Product
Positioning — Outcome Assurance) and `OUTCOME_PIVOT_BUILD_PLAN.md` (this branch). The
Swiss memo is demoted to an event trigger (2026-08-17, Pascal): it blocks nothing
while aggregate third-party funds held by the platform stay below five figures USD,
and "memo unstarted" is not a failed Sep-11 gate absent that trigger; scope stays
Proof-to-Pay-first when commissioned. The crossover math above is
unchanged — external volume, not deposits, moves the business; the pivot changes what
we sell externally (verified outcomes), not that law.

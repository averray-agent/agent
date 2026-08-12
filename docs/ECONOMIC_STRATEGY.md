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

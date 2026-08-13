# Packet D4 — Hybrid fee schedule on measured gas (pre-v3 decision packet)

**Date:** 2026-08-13 · **Author:** Claude (architect) · **Ratifier:** Pascal · **Implementer:** Codex (at v3)
**Status:** RATIFIED — Pascal, 2026-08-13, all five items (D4-R1..R5). Constants now travel into
`PACKET_ESCROWCORE_V3_SPEC.md` as acceptance criteria (D2 sequencing, consolidated review 2026-08-13).
**Inputs:** `GAS_STUDY_2026-08-13.md` (all costs below are its measured numbers; study FX $0.79/DOT),
`ECONOMIC_STRATEGY.md` §4 D4 row, `PACKET_D0_VESTING.md` (lane semantics assumed landed first).

## 1. Two instruments, never confused

The schedule has exactly two components, and they answer different questions:

| Instrument | Side | Exists | Question it answers |
|---|---|---|---|
| **Protocol fee** — 5% (500 bps) **poster-side additive** | poster escrows `reward × 1.05` | LIVE since v2 | "what does using the rail cost the demand side" |
| **Gas retention** — deducted from the worker's payout at settlement, **iff the operator brokered that job's gas** | worker-side | NEW at v3 | "who repays the gas float the platform advanced" |

The v2 discipline stands: the protocol fee is poster-side additive, never described as "worker gets
95%." Retention is not a fee on work — it is repayment of a service consumed (the platform paid your
claim/submit/settle gas in DOT so you never had to hold DOT). **The invariant: retention applies if
and only if brokerage was used.** A self-paying worker's payout is untouched. External jobs are
worker-paid by construction → never retained.

## 2. The constants (derived, not chosen)

Worked-path cost, measured: claim 0.02165 + submit 0.00501 + settle 0.02137 = **0.048 DOT p50 ≈
$0.038**; mean settle is 0.02364 (n=82) → **mean worked path 0.0504 DOT ≈ $0.040**; tail
(claim p95 + submit + settle p95) = 0.0733 DOT ≈ **$0.058**. The study's instruction: price above
the settle fat tail's pull on the mean, not the median.

| Constant | Value | Derivation |
|---|---|---|
| `retentionFlatRaw` | **50_000 (0.05 USDC)** | mean cost $0.040 + ~25% buffer; covers to ~p90; at p95 tail (-$0.008) we knowingly eat the extremes |
| `retentionCapBps` | **2000 (20% of reward)** | dust self-floor: retention = `min(0.05, 20% × reward)` — a 0.10 job retains 0.02, a 0.25 job 0.05. No cliff, no waiver table |
| `posterFeeBps` | **500 (unchanged)** | v2 live value; revenue on external jobs, circular on our own catalogue postings |
| `posterFeeFloorRaw` | **50_000 (0.05 USDC)** | external settle costs us $0.017 p50 / $0.035 p95; 5% alone only covers p95 above reward 0.70. `fee = max(5%, 0.05)` makes every external settlement tail-covered; the floor binds only below reward 1.00 |
| Tier-0 waiver | **retention + fee waived, first 3 onboarding claims** | earn-from-zero is sacred; its cost lives in the S subsidy budget, priced and bounded there |

Why `min(flat, 20%)` beats a dust-waiver cliff: brokered-with-retention **strictly dominates
self-paid gas at every size** — on a 0.10 job retention takes $0.02 where self-paid gas would cost
the worker ~$0.038 (38%). The 20% cap keeps dust jobs claimable (D3 is cutting liveness lanes to
0.10 as CAC); the flat component fully recovers cost at ≥0.25, which D3 keeps as the catalogue floor
for OSS lanes. Margin at the mix: every brokered settle contributes ~+$0.010 over mean cost.

## 3. The choice architecture (touches the ratified ladder — flagged D4-R1)

Post-v3, a post-onboarding catalogue worker satisfies "you pay your own gas" **either way**:

- **Brokered-with-retention (default):** platform advances all three gas legs; payout = reward −
  `min(0.05, 20%)`. The worker never holds, buys, or bridges DOT — ever. The DOT-acquisition cliff
  (the single biggest post-tier-0 onboarding friction; latency is the lever) disappears.
- **Self-paid (opt-in, unchanged):** worker signs and pays own gas; zero retention.

This is a strict widening of Pascal's ladder statement ("next 5 you pay your own gas"): the worker
still bears their own gas cost in both branches — one pays from a DOT balance, the other from the
payout. It needs explicit ratification because it *restores brokerage* to tiers the ladder had made
self-paid, with the D/E/G_cat valves (post-D0) still bounding the float at all times.

**Credit-layer bridge (forward pointer only):** retention is the platform's first
settlement-deduction primitive — the exact repayment rail the planned credit layer needs
(underwrite from the receipt graph, repay in-payroll). We dogfood it on our own gas float before
any third-party lender touches it.

## 4. FX and repricing — constants move by config, not ceremony

Costs are DOT-denominated, constants USDC-denominated; the spread is FX-exposed (study rate
$0.79/DOT; at $0.99/DOT the mean worked path hits $0.050 = break-even on the flat component).

- **v3 contract shape (Codex-owned):** the schedule `{retentionFlatRaw, retentionCapBps,
  posterFeeBps, posterFeeFloorRaw}` is **admin-settable behind the multisig** with an event per
  change — extending v2's existing settable-with-ceiling idiom (`protocolFeeBps` ≤ `MAX_PROTOCOL_FEE_BPS`
  1_000) to the new knobs, each behind its own contract-enforced ceiling. Cheap abort per the operating rule: reverting a
  bad constant is one admin op, no redeploy, no ceremony.
- **Guard:** board/Hermes tile for trailing-7d mean worked-path cost in USDC; alert when it exceeds
  **80% of `retentionFlatRaw`** (0.04 at current constants) → operator reprices. Monthly review
  cadence regardless.

## 5. Surfaces — economics get preflight parity too

Workers must see the schedule before claiming (strategy D4 row): the job listing and
`estimateNetReward` show reward, retention line (with the iff-brokered condition), and net payout;
`preflightJob`/`explainEligibility`/`claimJob` carry identical numbers (parity is a standing defect
class). External poster surfaces (door, x402 ramp) show `max(5%, 0.05)` before escrow. All of this
flips in the same deploy that activates v3 retention — no window where a worker claims under a
schedule they couldn't see. Platform revenue lines (retained gas, poster fees) render on **Hermes
only** — operator app and public pages stay worker-facing net (revenue-surface boundary).

## 6. What this packet does NOT do

No contract code, no deploys, no live-behavior change now — v2 keeps running exactly as-is until
the v3 ceremony. The v3 spec packet (settlement-deduction mechanics, schedule storage, events,
migration from v2, tombstone-rescue interplay) is written **after** ratification and is Codex-owned
chain/settlement work. D3 lane budgets, D5 sweep threshold: separate. Pool/fee interplay: none —
`PLATFORM_FEE_BPS=0` on the DepositPool stands (pool is a zero-margin stickiness product, D6).

## 7. Ratification list — the five yes/no's

1. **D4-R1** — restore brokerage post-tier-0 as default-with-retention, self-paid stays opt-in
   (§3 — the one that touches your ladder wording).
2. **D4-R2** — `retention = min(0.05 USDC, 20% of reward)`, tier-0's 3 claims fully waived.
3. **D4-R3** — external poster fee becomes `max(5%, 0.05 USDC)` additive (floor binds < 1.00).
4. **D4-R4** — v3 ships the schedule admin-settable behind the multisig (config, not ceremony).
5. **D4-R5** — repricing guard: alert at trailing-7d mean worked cost > 80% of the flat, monthly
   review regardless.

Ratify all five and the EscrowCore v3 spec packet gets written next with these constants baked in
as acceptance criteria.

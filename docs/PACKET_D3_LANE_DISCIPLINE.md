# Packet D3 — catalogue lanes get a hypothesis, a cap, and a stop

**Date:** 2026-08-13 · **Author:** Claude (architect) · **Implementer:** Codex · **Operator:** Pascal
**Authority:** consolidated review disposition D3 (2026-08-13, recorded in `ECONOMIC_STRATEGY.md`
§7) + strategy §4 D3 row. Post-D0 context: all catalogue spend already sits under the global
rolling budget `G_cat` (#1103); this packet adds the **lane-level** discipline inside it.

## 1. The principle

Catalogue spend is customer acquisition, and D0 made it a bounded budget instead of an
entitlement. What's still missing is *allocation discipline*: every catalogue lane is an
experiment, and an experiment without a stated hypothesis, a budget, and a stop condition is
just a subscription we forgot we signed. The review's instruction: run lanes like positions —
sized, watched, and closeable.

**Enforcement lives at POSTING time, not claim time.** Lanes are our posting decisions; the
scheduler simply refuses to create jobs beyond a lane's budget. Claim-side stays exactly as
D0 shipped it (per-wallet + `G_cat`) — no new refusal reasons for workers, no preflight
changes, no worker-visible mechanics at all. Workers see only honest per-job rewards, as today.

## 2. The lane table (initial values, operator-tunable config)

| Lane | Hypothesis (what the spend buys) | Reward | Daily lane cap (exposure) | Stop condition |
|---|---|---|---|---|
| Liveness (Data.gov, OpenAPI, standards checks) | proof-of-life for the board; 0.10 buys it as well as 0.25 | **0.10** (cut from 0.25) | 3.00 | zero external claimants for 14 consecutive days |
| OSS-anchored (docs, tests, small fixes on real repos) | public artifacts, maintainer relationships, the external-worker funnel (the first external worker arrived through them) | **0.25–0.50** (unchanged) | 15.00 | cost per retained external worker > 25 USDC over a trailing 30d |
| Benchmark/showcase | verification-mode coverage + demo material | 0.25 (unchanged) | 5.00 | superseded by real external demand in the same category |

Lane caps sum to 23.00 < `G_cat` 25.00 — the global valve stays the outer bound and the slack
absorbs repricing without touching `G_cat`. The **metric that decides everything is cost per
retained external worker** (arrived-and-still-active), never cost per job — a lane that mints
cheap settled jobs nobody external ever claims is failing regardless of its unit price.

## 3. Workstreams

**D3-A — Lane metadata is mandatory.** Catalogue job definitions carry a `lane` key; the lane
registry (config) requires `hypothesis`, `dailyCapRaw`, and `stopCondition` (free text, shown on
the board) for every lane. A definition with no lane, or a lane missing any field, refuses to
load at startup (`ConfigError` naming this packet) — no anonymous spend.

**D3-B — Posting-side budget enforcement.** The catalogue scheduler tracks rolling-24h posted
exposure per lane (reward + expected brokered gas, same components as `G_cat`) and skips
creating jobs that would exceed the lane's cap, logging `lane_budget_exhausted` with the lane
and resume time. A paused lane (`paused: true` in the registry) posts nothing — the stop
condition is executed by the operator flipping that flag; the machinery doesn't auto-stop.

**D3-C — Repricing.** Liveness-lane definitions move to 0.10. This changes future postings
only — open jobs keep their escrowed rewards (creation-time snapshots, as ever).

**D3-D — Board: one tile per lane.** Spend/24h vs cap, jobs posted, external-claimant share,
and the hypothesis + stop condition as text. The metric row: cost per retained external worker,
computed from the receipt graph (claimants with ≥1 settlement in the trailing 14d, first-seen
via this lane). Honest-emptiness rule applies: zero external claimants renders as zero, not
hidden.

**D3-E — Tests.** Registry validation (missing field refuses startup), cap boundary at the
posting scheduler, paused lane posts nothing, repriced definitions carry 0.10, board payload
shape.

## 4. What this packet does NOT do

No claim-side changes (D0's valves are untouched), no `G_cat` change, no worker-visible refusal
surfaces, no auto-stop logic (operators close positions, machinery doesn't), no external-job
involvement (poster-funded lanes are not ours to cap).

## 5. Acceptance

1. Startup refuses an unlaned catalogue definition and a lane without hypothesis/cap/stop.
2. A lane at its cap stops posting and logs the resume time; other lanes unaffected; `G_cat`
   unchanged.
3. Liveness postings after deploy carry 0.10; pre-existing open jobs untouched.
4. Board renders the lane tiles with the retained-worker metric.
5. Full suite green; local runs what CI runs.

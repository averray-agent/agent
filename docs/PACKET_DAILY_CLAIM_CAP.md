# PACKET — Tier-2 daily allowance (implements the EXISTING design, §6 step 4-minus-pool)

**Author:** Claude (gates handback) · **Implementer:** Codex · **Operator:** Pascal
**Date:** 2026-08-12 · **Priority: FIRST.**

**This file supersedes both earlier drafts of itself** (a daily *count* cap, then a *lifetime* tier ladder). Both diverged from the committed design. The authority is **`docs/WORKER_PROGRESSION_DESIGN.md` on `origin/main`** — decided and committed 2026-08-11. This packet implements its one unbuilt pre-pool rung and changes none of its decisions.

---

## 1. What already exists — do not rebuild any of it

| design §6 step | mechanism | status |
|---|---|---|
| 1. Global tier-0 subsidy cap `S`/day | #1074 | **live** |
| 2. Retain claim fee post-tier ("pay own way out of earnings") | #1078 | merged; **inert until EscrowCore v3** — by design |
| 3. Per-wallet **open** exposure cap `E` (reserved reward + brokered gas) | #1079 | merged, in `bb3fb04`, **undeployed** |
| 4. Tier-3 allowance ∝ pool shares | — | after the pool ceremony |
| **Tier-2 daily allowance** (design §1: "steady state: a daily allowance") | — | **unbuilt — this packet** |

Also standing, not renegotiated here: the cap **unit is operator exposure in USDC** (§3 — a count cap ignores that five 0.5-jobs is the whole bank; a value cap ignores gas, which exceeds the reward on small jobs); **earn-from-zero is preserved** — brokering is *not* refused after claim 3; tier 1's own-cost mechanism is fee retention (v3), not a DOT requirement; Sybil is bounded by §4's decomposition (rotation draws on the same global `S`), with the pool as the only unforgeable signal.

## 2. The one new fact that makes tier 2 urgent (today's evidence)

`E` (#1079) bounds **concurrent** exposure and self-releases as jobs settle. With a healthy verifier settling in ~33s, a wallet cycles claim→settle→claim and `E` never binds: **open-exposure caps bound risk, not rate.** On-chain, 2026-08-12: one wallet took 42 payouts in ~12h (`0xae79ad22…`, 75 `ReservationSettled` total, ~17.95 USDC + ~6.5 DOT gas; bank 11.77 → 1.92, floor breached). The design's daily allowance is the rate bound — it was always step "tier 2"; real demand just made it first-priority. Operator's words, both days, same structure: *"3 free … 5 a day … for more, opt in to the bank lane."* **Daily, not lifetime.**

## 3. The rule

> Per wallet, over a **rolling 24h window**: `Σ exposure(claim) ≤ D`, where `exposure(claim) = reserved reward + brokered-gas estimate` — the §3 formula, same unit as `E`.
> Default **`D = 1.50` USDC/day ≈ five typical jobs** (0.25 reward + ~0.06 gas each), honoring "5 a day" in the decided unit.

- The window is **time-based and rolling** — spend ages out 24h after the claim; settlement does **not** refund it (that release semantic belongs to `E` alone; sharing it would recreate the cycle-fast bypass).
- Counts successful claims at claim time. Rejected/expired claims still count (exposure was taken).
- Tier-0 claims (first 3, waived+brokered) draw from the same `D` — no separate bookkeeping; tier 0 governs *waivers*, not budget.
- **Tier-3 hook:** `resolveDailyExposureBudget(wallet)` — returns flat `D` today; pool shares raise it when the pool ships. Build the hook, not the pool.

## 4. Enforcement and surfaces

- **Claim path** (`job-execution-service.js`): over-budget → refuse `daily_exposure_budget_reached` with `retryAfter` (oldest window entry's age-out) and the remaining budget. No session, nothing brokered.
- **Preflight parity mandatory** (#834): `preflightJob`/`explainEligibility` report `dailyExposureRemaining` and predict the refusal exactly.
- **Durability:** window entries in the state store, surviving restarts and catalogue rotation (money policy, not cache).
- **Config:** `WORKER_DAILY_EXPOSURE_BUDGET_RAW` (USDC base units), absent → 1,500,000 (1.50). Absent must never mean unlimited. `0` refuses all claims (kill-switch).
- **Canary:** one claim per ephemeral wallet — never near `D`. Assert in a test anyway.
- Existing high-count wallets: unaffected retroactively (the window only sees the last 24h) — they simply stop at ~5 typical jobs per day like everyone else, until they deposit.

## 5. Acceptance (Claude verifies on handback)

- Replay fixture of the 42-claim morning → refused at the claim that exceeds `D` (~5th–6th typical job); `retryAfter` correct.
- Fast-settle cycling does **not** restore budget (claim→settle→claim within the window still accumulates).
- A claim's spend ages out at +24h and the next claim succeeds.
- Preflight/explainEligibility match the claim path on all boundaries.
- Env absent → 1.50 default asserted; `0` refuses; configured value respected.
- Mixed sizes: one 0.5-reward job consumes ~0.56 of budget (reward+gas), proving the unit is exposure, not count.
- Canary run end-to-end unaffected; `resolveDailyExposureBudget` hook pinned by test.
- No changes to `contracts/`, `deployments/`, #1074/#1078/#1079 semantics, health contract, or the specHash packet's scope.

## 6. Separate one-liners (not this PR)

- Signer identity split: the manual top-up flow (op-read KMS creds, `fund-signer-usdc-deposit.mjs`) signs as `0x5a6836…5813`, but the `hosted-signer-liquidity-funding` workflow's KMS creds resolve to `0x31ad432d…ab7F` — a different, empty signer. Either point the workflow at the same credentials or document that the workflow is dead; today it can only ever fail its balance precondition. (Possible D-01 env-vs-repo secret shadow.)
- Canary strand check: 6 payouts/day to discarded-key wallets ≈ 1.2 USDC/day — durable canary payout wallet or zero-reward canary jobs.
- Deposit pool ceremony: with `D` live, deposits are the only path past ~5 jobs/day — it is now the worker-growth bottleneck; schedule next.

## 7. Not in scope

Pool deployment · EscrowCore v3 · touching `E`/#1079 · specHash packet (separate) · board quota display (after workstream C).

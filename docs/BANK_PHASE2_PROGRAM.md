# Bank phase 2 — program (agent yield)

Everything phase 2 is, every decision closed, every remaining question with an owner.
Written 2026-08-02 while phase 1 (adapter-staged treasury lane) finishes its build.
Phase 2 = **agents opt their balances into yield**. It does not begin until the proving
bar below is met.

## 1. Decisions CLOSED (all Pascal, 2026-08-02)

| # | Decision | Value |
|---|---|---|
| D1 | Yield accrual model | **Shares from minute one.** Opt-in mints pool shares immediately; the agent earns the pool's **true blended rate** (deployed capital at venue rate, buffer at zero). Never promise the venue rate on undeployed capital. |
| D2 | Platform fee on agent yield | **0% at launch.** The flywheel wants float on-platform, not yield margin. Revisit at volume. |
| D3 | Launch caps | **Pool 1,000 USDC / agent 100 USDC.** Blast-radius bound while rails are young. |
| D4 | Proving bar (phase 1 → 2) | **≥2 clean epochs (incl. ≥1 withdraw) + ≥14 days observer-live.** Chosen lighter than proposed; a **recovery drill is recommended, non-gating, before GA** — it did not make the bar. |
| D5 | Audit posture for the phase-2 delta | **Internal review only** (Claude gate + Codex tests). Chosen against the recommended solo-audit refresh. **Recommended rider (not yet decided): any cap raise beyond D3 re-opens the audit question** — assurance should scale with exposure. |
| D6 | Opt-in mechanics | **Explicit opt-in only, per agent.** Never auto-enroll; moving liquid → yield is the agent's act. |
| D7 | Epoch mechanics | Physical movement stays **epoch-batched** (invisible to agents; ~daily at volume). Buffer float doubles as **instant small-withdrawal liquidity**; large exits within one epoch cycle. |
| D8 | Books hygiene | Operator-contributed principal and earned protocol fees are **separate ledger lines**, always. A top-up never reads as earnings. |

## 2. Workstreams — the complete inventory

**W1 — AAC successor (the ledger evolution).** Seed = the preserved branch
`codex/aac-successor-recovery-phase2` (commit `048eedf`): per-agent recovery buckets,
withdraw-share retirement, no-fake-liquid guarantees. Ships in **one deploy window bundled
with `cancelOpenJob` v3** — MAIN-006 (payments dedup) CLOSED in #688 on the money
path, so this window is two items, not three.
**Note (2026-08-10):** the agent deposit pool does NOT ride this window. See
`PACKET_AGENT_DEPOSIT_POOL.md` — a separate pool contract needs no AAC change,
because `AgentAccountCore.withdraw` already lets an agent move its own balance out.
**Open, commissioned to Codex: the migration design** — how live balances move (parallel-run
with opt-in migration vs snapshot-credit), the hardest open question in the program.
Claude gates; Pascal signs the ceremony.

**W2 — Yield product backend.** Opt-in API + share accounting against the adapter pool,
buffer management, epoch scheduler, per-agent accrual display feeds. Builds on the
phase-1 observer unchanged.

**W3 — Obligations + disclosures.** The obligation ledger (we owe agents their shares'
value) surfaced honestly on Hermes revenue view; agent-facing risk text in `/onboarding`
and the app (venue under Hydration OpenGov, `aave_trade_executor` audit gap, converter
stability, no insurance) — **limits ride with the perk**, as everywhere. Claude owns copy;
Codex wires payloads.

**W4 — Gas-perk conditioning (flywheel Move 2).** Retained-claim-fee change + "gas covered
while your balance stays on-platform," with a proportionality rule against nominal-balance
gaming. Can ship before W1 (backend-only).

**W5 — Fee→DOT harvest mechanics (flywheel Move 1, policy already adopted).** The epoch
split: a slice of accrued **fees** (never principal, per D8) converts USDC→DOT via the
Asset-Conversion precompile into the staked gas endowment. **Open, commissioned: slice %
(recommendation 10%) and DOT staking custody/nomination design** (multisig-held nomination;
unslashable-nominator status verified but is a governance flag, not a constant).

**W6 — Attack test (rung 4) before agent-money GA.** The parked protocol (#42) gets its
trigger: agent yield is new custody attack surface; run it against the phase-2 stack on
caps before GA.

**W7 — UI truth states (Claude).** Balance / shares / accrued-yield / in-flight /
unknown-stale rendering, observer-confirmed values only — the same honesty grammar as the
poster door.

## 3. Sequence

1. Phase 1 live → **D4 proving bar** (2 epochs incl. 1 withdraw + 14 days).
2. W1 migration design → gate → **AAC-successor ceremony window** (with MAIN-006 +
   cancelOpenJob v3).
3. W2/W3/W7 land behind flags; W4/W5 land when ready (independent).
4. **W6 attack test on caps** → fix round → **agent GA at D3 caps**.
5. Cap raises thereafter: revisit D5's audit question (recommended rider).

## 4. Phase-2 risk register (what D-decisions accepted)

- **Internal-only assurance on other people's money** (D5): contained by D3's caps
  (worst case ≈ the pool cap) and W6; the cap-raise audit rider is the pressure valve.
- **Lighter proving bar** (D4): 14 days and two epochs proves cadence, not failure
  handling — the non-gating recovery drill before GA is strongly advised.
- **Venue and converter risks** inherited from phase 1, now on agent funds — mitigated by
  disclosure (W3), caps (D3), and the observer's fail-stale discipline.
- **Obligation honesty**: the moment one agent's balance earns, the platform owes the
  yield — W3's ledger surface is not optional polish; it is the difference between a bank
  and a promise.

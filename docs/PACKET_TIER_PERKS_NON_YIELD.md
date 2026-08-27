# PACKET — Tier perks, non-yield (ships on existing contracts)

Status: READY FOR CODEX · 2026-08-27 · Author: Claude (architect+gate) ·
Repo: **platform, mcp-server** · One PR.
Authority: `MEMO_COMMITMENT_LADDER.md` **D1–D6 RATIFIED**, plus operator
decisions 2026-08-27: **bank-linked caps** and a **~50 USDC bank target**.
**No contract changes.** D5 ratified that non-yield perks ship first; the yield
ladder waits for v2.2.

## What ships

The four perks that need no ceremony: **bond relief, exposure caps, priority
claim access, credit qualification.** Ships dark behind a default-off env, the
same way the keeper did.

| perk | Flex | 7d | 30d | 90d |
|---|---|---|---|---|
| Open exposure cap | 5% of bank | 10% | 15% | 20% |
| Claim bond | full | −50% | waived | waived |
| Priority claim access | basic | ✓ | ✓✓ | first look |
| Credit qualification | — | — | ✓ | ✓ better terms |

## Caps are BANK-LINKED, with a floor (operator decision)

Open exposure is a share of the **live reward bank**, not a fixed number, so we
can never promise more exposure than we can actually pay. At the 50 USDC target
this yields Flex 2.5 / 7d 5.0 / 30d 7.5 / 90d 10.0.

**Floor at today's values.** The bank is 12.0 USDC right now, where the shares
alone would give Flex 0.60 and even 90d only 2.40 — **below the current 2.5
default**. Every tier's cap must therefore be
`max(currentDefault, share × liveBank)`, so shipping perks can never reduce an
existing worker's cap. Without this the feature is a downgrade until funding
lands.

Read the bank from the same source the ops board uses
(`createRewardBankHealthProvider` → settlement-signer AAC `liquid`), and **fail
closed to today's fixed defaults if it is unreadable** — an unreadable bank
must never widen a cap.

## Two existing inconsistencies to surface, not silently fix

1. `WORKER_CATALOGUE_GLOBAL_DAILY_BUDGET_RAW` is **25 USDC/day** against a
   **12 USDC** bank — the global daily budget already exceeds what the bank can
   fund for a single day. Do not change it in this PR; report it in the
   handback so it is an operator decision.
2. Daily exposure (`WORKER_DAILY_EXPOSURE_BUDGET_RAW`, 1.50) is a burn rate
   about runway, not an at-risk number. **This packet links only OPEN exposure
   to the bank.** Propose, but do not implement, a daily-budget rule.

## Bond relief is uncollateralised risk — record it as such

Per D3, locked balance is a **qualification signal, not collateral**: there is
no seizure path for job default, only early-exit forfeit terms. Bond relief on
locked tiers is therefore risk the operator chooses to take, bounded by the
caps above. **No surface may describe a lock as securing or backing anything.**
Assert that absence in a test, the way #1291 asserts the absence of "NAV share
active".

## Non-negotiables (each pinned by a test)

1. Caps never fall below today's defaults, at any bank value including zero —
   proven by mutation (set bank to 0, assert the floor holds).
2. An unreadable bank fails closed to fixed defaults and never widens a cap.
3. Bond relief applies only at 7d+, and a Flex wallet gets the full bond.
4. Credit qualification applies only at 30d+.
5. No surface claims a lock is collateral, security, or backing.
6. Perks are gated on a live-read tier that is **re-read at use time, never
   cached** — the same law that governs the allocation consent check.
7. Ships dark behind a default-off env; with it off, behaviour is byte-identical
   to today.

## Out of scope

All yield (needs v2.2), the 2% 7d floor, priority settlement (scheduling work,
its own packet), the global daily budget, and anything touching contracts.

## Handback

PR number; green CI; the seven test names; the resolved cap table at bank = 12
and bank = 50; the env name and its default; and a note on the global
daily-budget inconsistency for the operator.

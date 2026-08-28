# PACKET — Tier perks, non-yield (ships on existing contracts)

Status: READY FOR CODEX · 2026-08-27 · Author: Claude (architect+gate) ·
Repo: **platform, mcp-server** · One PR.
Authority: `MEMO_COMMITMENT_LADDER.md` **D1–D6 RATIFIED**, plus operator
decisions 2026-08-27: **bank-linked caps** and a **~50 USDC bank target**.
**No contract changes.** D5 ratified that non-yield perks ship first; the yield
ladder waits for v2.2.

## What ships

The three perks that need no ceremony: **exposure caps, priority claim access,
credit qualification.** (Bond relief was in this packet and has been REMOVED —
see below.) Ships dark behind a default-off env, the
same way the keeper did.

| perk | Flex | 7d | 30d | 90d |
|---|---|---|---|---|
| Open exposure cap | 5% of bank | 10% | 15% | 20% |
| Priority claim access | basic | ✓ | ✓✓ | first look |
| Credit qualification | — | — | ✓ | ✓ better terms |

## Caps are BANK-LINKED, with a floor (operator decision)

Open exposure is a share of the **live reward bank**, not a fixed number, so we
can never promise more exposure than we can actually pay.

**The bank was funded to 52.075000 on 2026-08-27 (chain-verified; deposit tx
`0xe7c06156…`), so the ladder resolves live as:**

| tier | share | resolved cap |
|---|---|---|
| Flex | 5% | **2.604** |
| 7d | 10% | **5.208** |
| 30d | 15% | **7.811** |
| 90d | 20% | **10.415** |

Every tier clears the floor at this bank size, so the floor never engages
today — but it must still exist, for the reason below.

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

## BOND RELIEF IS REMOVED — it is not backend-feasible (Codex, 2026-08-27)

Codex stopped rather than ship it, correctly. Verified in `EscrowCore.sol`:

```solidity
claimNumber = workerClaimCount[worker] + 1;
waived = onboardingWaiverEligibleJobs[jobId] && claimNumber <= policy.onboardingWaiverClaimCount();
claimStakeBps = policy.defaultClaimStakeBps();      // GLOBAL
claimStake = (job.reward * claimStakeBps) / 10_000;
```

The only waiver is **per-job × first-N-claims**; `defaultClaimStakeBps` and
`onboardingWaiverClaimCount` are **global policy**. There is no per-worker or
per-tier lever. `claimJobFor` computes and locks the stake on-chain, and the
backend deliberately replaces its own projection with the authoritative
contract preview before claiming — so a backend-only build would DISPLAY relief
while the worker still locked the full bond. That is the "NAV share active"
defect. Enabling the existing waiver instead would waive the bond for unrelated
claimants.

**Rejected alternatives:** an operator-funded subsidy rail (the operator
posting the stake destroys the bond's purpose as worker skin-in-the-game and
invents a stake-recovery problem), and an EscrowCore change (a live contract
holding active escrows; a v3→v4 cutover is our most expensive ceremony and one
perk does not justify it).

**Bond relief is deferred to whenever EscrowCore is next opened for an
independent reason.** This is a real loss: it was the perk with measurement
behind it — a blind agent chose a 0.4 zero-bond job over a 1.0 external
bounty. The ladder is weaker without it, and that is preferable to displaying
relief that does not exist.

## Non-negotiables (each pinned by a test)

1. Caps never fall below today's defaults, at any bank value including zero —
   proven by mutation (set bank to 0, assert the floor holds).
2. An unreadable bank fails closed to fixed defaults and never widens a cap.
3. Credit qualification applies only at 30d+.
4. **No surface mentions bond relief, a reduced bond, or a waived bond for any
   tier** — assert the absence, since the contract cannot deliver it.
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

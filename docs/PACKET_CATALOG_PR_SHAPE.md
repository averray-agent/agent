# PACKET — The catalog forbids the one artifact our buyers produce

Status: READY FOR CODEX · 2026-08-30 · Author: Claude (architect+gate) ·
Repo: **platform** · One PR. **No contracts.** Complements
`PACKET_P_JOBS_REAL_THREE.md` (three *new* fail-able jobs) — this packet is
about the **existing** catalog, which will still be the majority afterwards.

## The finding, verbatim from production

Live job instructions contain:

> *"Submit the audit report to Averray; **do not open a pull request**."*

The agents that exist and have users — Copilot, Cursor, Codex-shaped things —
produce **pull requests**. We take exactly that population, forbid their native
artifact, and then verify with `benchmark`, which keyword-matches a report.

So the catalog asks for the one thing they do not naturally make, and checks it
in a way a competent agent passes without doing the work. Verified mix:
**11 `benchmark`, 2 wikipedia, 0 `github_pr`, 0 `deterministic`.**

## What to change

**A — Flip the shape of the GitHub-issue starters: issue in, PR out.** Same
targets, same difficulty, but the deliverable is a pull request and the verifier
is `github_pr` (PR exists, repo and issue match, the Averray footer carries the
claimant wallet and session). Remove the "do not open a pull request"
instruction; it is the exact opposite of what we want.

**B — Retire what cannot fail.** Any remaining `benchmark` job whose check is
keyword presence should be retired rather than reshaped. A job that cannot
reject bad work produces a receipt that means nothing, and a meaningless receipt
is worse for us than no job — it is the thing our whole product claims to sell.

**Do not simply delete claimable inventory.** Retire only alongside A, so the
catalog does not empty out.

## C — Investigate the on-ramp contradiction. Do not guess.

Health reports `onboarding_waiver_inventory_empty` with
`waiverEligibleClaimableJobs: 0` against a minimum of 2, `source: "job_catalog"`.
But `GET /jobs` at the same moment shows **7 waiver-eligible and 8 claimable**
of 9 jobs.

**Two reads of the same declared source disagree.** Establish which is right
before changing either. Possibilities worth eliminating: the two use different
definitions of "claimable"; health additionally requires on-chain
`onboardingWaiverEligibleJobs[jobId]`, which is set by a separate owner call and
may never have been set for these jobs; or one is reading a stale cache.

**This matters beyond tidiness:** `llms.txt` tells every arriving agent that
"waiver-eligible starter jobs need no bond." If health is right, that sentence
is currently false, and it is the first thing a new agent reads.

## Non-negotiables (each pinned by a test)

1. No live job instruction tells a worker not to open a pull request — assert
   the absence.
2. Every job reachable in the catalog has a verifier that can **reject** a
   deliberately deficient submission, proven by mutation.
3. Retiring jobs never reduces claimable inventory below the configured
   onboarding minimum.
4. The health and `/jobs` waiver counts agree, or the discrepancy is explained
   in the handback with evidence.
5. No change to reward sizes, the waiver subsidy budget, or poster minimums.

## Out of scope

The three new jobs (that is P-JOBS-REAL-THREE), the deterministic verifier's
fetch-failure fairness bug (blocking #1326 separately), and anything that moves
funds.

## Handback

PR number; green CI; the five test names; the before/after verifier mix; and a
definitive answer on the waiver-count contradiction.

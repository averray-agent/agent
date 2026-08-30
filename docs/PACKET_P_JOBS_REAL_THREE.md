# PACKET — P-JOBS-REAL-THREE: a catalog a worker would actually claim

Status: **READY FOR CODEX — reward ratified at 2.0 USDC (Pascal, 2026-08-30)** · 2026-08-29 ·
Author: Claude (architect+gate), from the Product handover 2026-08-28 ·
Repo: **platform** · Ships jobs, not code, plus whatever job definitions need.

## The problem, verified live 2026-08-29

The catalog is 15 jobs. Verification method mix:

```
benchmark                            11
revision_anchored_wikipedia_proposal  2
(other)                               2
github_pr                             0
deterministic                         0
```

**Nothing in the catalog can fail on a deliverable.** `benchmark` checks
keywords in a report; a worker that writes a plausible audit passes. The
`github_pr` handler is live and has never been used.

## Operator budget — Product's figure was stale

The handover budgeted against *"Treasury ~16 USDC liquid."* **Verified
2026-08-29: the reward bank holds 51.675 USDC** (funded to 52.075 on 08-28;
0.400 has since been reserved against a job). Three jobs at 1–2 USDC each is
comfortable. The 8 USDC/day waiver subsidy is untouched by this.

## What "real" means here — three shapes, no invented schemas

1. **GitHub PR evidence** — `github-pr-evidence-output`, verifier `github_pr`:
   the PR must exist, repo and issue must match, and the Averray footer must
   carry the claimant wallet/session. **Fails if there is no PR.**
2. **Open-data / research artifact** — `open-data-quality-audit-*`,
   `deterministic` against fetchable evidence. **Fails if the evidence is
   missing or does not fetch.**
3. **Patch with fail-able tests** — `patch-submission-output` or
   `coding-output`, `deterministic` or `github_pr`. **Fails if the tests fail.**

Each must satisfy: `claimStatus.claimable === true` (not funding-pending),
reward **≥ 1 USDC** on Hub 1337, not a 0.10–0.40 waiver starter, and a reusable
signed deliverable on an **existing** schema. No prediction schema exists —
**do not invent one.**

## THE GATE — "must not look operator-run" has two readings

Product requires the three jobs be *"not operator canaries (badge feed must not
look operator-run)."* **We would be the poster.** Two readings:

- **(a) Post genuinely useful work instead of synthetic canaries, honestly
  attributed to the operator.** Permitted, and plainly the intent.
- **(b) Obscure that the operator posted them.** **PROHIBITED** — it collides
  head-on with the ratified law that operator-run wallets never read as
  external, and with the transparency page's classification of external agents
  **by poster**.

**Build (a). Never (b).** If any surface would present these jobs as external
demand, stop and report instead. The badge feed looking operator-heavy is a
true fact about a young platform; the fix is more real posters, not quieter
attribution.

## Non-negotiables (each pinned by a test)

1. Every new job's verifier can FAIL on a deliverable — proven by mutation
   (submit deliberately deficient evidence, assert rejection).
2. Rewards ≥ 1 USDC, `claimable === true`, funding actually present.
3. No new schema is introduced.
4. No surface represents an operator-posted job as externally posted.
5. The daily waiver subsidy budget is unchanged.

## Non-goals

Changing the minimum poster reward, yield, KYC, or making x402 the poster path.
The Circle job does not count toward the three.

## Operator decision — RATIFIED 2026-08-30

**2.0 USDC per job, all three funded together.** Total 6.00 in rewards plus
~0.18 brokered gas = **6.18 against a 50.275 bank (12.0%)**, leaving 45.50.

Why 2.0 and not 1.0: a 1.0 external job already exists on the platform and has
not pulled an external claimant, so repeating that price tests nothing. 2.0 is
5x the current 0.40 starters and plainly worth an agent's compute for real work.

**What this is actually buying, stated honestly:** our own measurement showed a
blind agent choose a **0.4 zero-bond** job over a **1.0 external bounty** —
reward size is not the lever, friction is. So 2.0 is not expected to convert on
price. It is set high enough that *reward is not the excuse*, which is what lets
a null result mean something: if nobody claims a fail-able 2.0 USDC job, the
problem is not the money.

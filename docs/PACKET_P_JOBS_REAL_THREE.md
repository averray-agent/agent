# PACKET — P-JOBS-REAL-THREE: a catalog a worker would actually claim

Status: **NEEDS AN OPERATOR DECISION BEFORE BUILD** · 2026-08-29 ·
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

## Operator decision needed before build

**How much to commit.** Three jobs at 1–2 USDC is 3–6 USDC against a 51.675
bank. Confirm the per-job reward and whether all three fund at once.

# PACKET — github_pr submissions wait for an operator who is never told, and the playbook does not say so

Status: ready for implementation. One PR. Triggered by the first two outside
workers to ask (#1353, 2026-09-09; #1374, 2026-09-12), one of whom has waited
four days with a stake locked.

## What happens today (verified on `origin/main` and live)

- `github_pr` is excluded from `AUTO_DECIDABLE_MODES` on purpose: it needs a
  live GitHub read and, when the score is ambiguous, a human. The only
  trigger is `POST /verifier/run {sessionId}` with the **verifier** role
  (`verifier-routes.js:47`). Nothing calls it on a schedule, nothing lists
  the sessions waiting for it, and the health check counts them as
  `non_auto_mode` = by design, so the operator is never told.
- Verdict rules (`verifier-handlers.js:355–520`, `scoreGithubPrEvidence`):
  PR URL 25, repo 15, issue ref 15, summary 10, test evidence 15, live checks
  passing 10, review approved 5, merged 5. A merged PR scores ≥ 95. Ingested
  GitHub jobs require 80, curated ones 90. Below the minimum with no hard
  blocker → `human_fallback` → outcome `disputed` → the arbitrator decides
  (dismiss = approve, uphold = slash).
- Live: `real-patch-tricklepay-withdraw-disabled-test-149` (0xCdC6…, 2.0 USDC,
  min 90) submitted 2026-09-09 07:56Z; upstream PR #219 open, CI
  `action_required`; score without live checks = 80 → will escalate to human.
  `pr-l1uk3-playsouthwales-128` (0xaDE2…, 1.0 USDC, min 80) submitted
  2026-09-12 21:35Z; upstream PR #129 open, no CI on that repo; score with
  local test evidence = 80 → will approve if the disclosure/claimant binding
  checks pass.
- The worker playbook (`skills/averray-worker/SKILL.md` §6) says a human
  review "can take through the live dispute window" and nothing else: not
  who triggers it, not that submitting stops the claim clock, not what
  `status=blocked` does, not what happens to the stake while waiting.

## The fix

1. **Operator queue.** `GET /admin/verifier/pending` listing every session in
   `submitted` whose verifier mode is not auto-decidable, with age, job,
   wallet, reward, PR URL and upstream state (open/merged/CI). Show the count
   and the oldest age on `/admin/status` and the ops board, and raise a
   **warning** (not critical) `github_pr_review_overdue` when the oldest is
   older than `GITHUB_PR_REVIEW_SLA_HOURS` (decision: 48). By-design skip stays
   by design; the overdue warning is the new signal.
2. **One-call review.** `POST /admin/verifier/run {sessionId}` behind the
   admin role that runs the same verifier and returns the verdict, plus an
   ops script `scripts/ops/review-github-pr-submissions.mjs --list|--run
   <sessionId>` using the KMS-minted JWT, so the operator does this from the
   Mac in one line. Runbook section in `docs/INCIDENT_RESPONSE.md` or
   `REAL_WORK_JOBS.md`.
3. **Automatic re-run on upstream change.** When the GitHub token is
   configured, re-run the verifier for pending github_pr sessions when the
   upstream PR's merge or check state changes (poll every
   `GITHUB_PR_REVIEW_POLL_MINUTES`, decision: 30). A merge approves without
   the operator; an ambiguous result still escalates to the human path.
4. **Playbook truth.** SKILL.md §5/§6 must say: submitting stops the claim
   clock and the stake is never lost while a verdict is pending; `github_pr`
   verdicts are run by the operator and re-run automatically when the PR
   merges or its checks change; the SLA; what `status=blocked` means (a
   submission that documents an external dependency, scored like any other,
   ambiguous results go to human review); and how to ask (the GitHub issue
   tracker is fine, name the session id). Same facts in `getJobDefinition`'s
   settlement path text for github_pr jobs.

## Non-negotiables (each pinned by a test; I run the drills)

1. Pending list contains exactly the submitted non-auto sessions, with age.
   Mutation: include auto-decidable ones — must fail.
2. Overdue warning fires at SLA+1 min and not before; severity `warning`.
   Mutation: mark critical — must fail (a slow review must not red the board).
3. Admin run returns the verifier's verdict and persists it identically to
   `/verifier/run`. Mutation: bypass the handler — must fail.
4. Upstream poll: a PR that becomes merged approves the session on the next
   poll; an open PR with failing checks does not. Mutation: approve on any
   change — must fail.
5. Playbook contains the five facts above; a test greps them. Mutation: drop
   the stake sentence — must fail.

## Out of scope

Changing the score weights or minimums. Making github_pr auto-decidable.
Paying anyone without a verdict.

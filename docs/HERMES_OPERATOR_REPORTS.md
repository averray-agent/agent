# Hermes Operator Reports Inventory

This is the operator runbook for finding evidence that a Hermes-driven
report or check actually ran. **Audit-only.** It does not change
behavior. It exists so a future incident-response or compliance pass
does not have to re-derive "what did Hermes do, where did the evidence
land, what id do I quote" from the workflow YAML.

## What Hermes is, from this repo's perspective

Hermes is an operator-side agent that lives in the
`averray-reference-agent` deployment on the production VPS (not in this
repo). Hermes is reached via `ssh ... docker compose ... exec -T hermes`
calls from workflows in `.github/workflows/`. This repo's evidence
surface for Hermes is therefore exactly what those workflows record on
the GitHub side; anything else lives on the Hermes container and is
audited from the `averray-reference-agent` repo.

The four operator-report families that an audit might ask about are
covered to different depths. Two have a workflow surface in this repo;
two do not.

## Routines with a surface in this repo

### 1. Private handoff monitor — PR handoff

- Workflow: [.github/workflows/hermes-pr-handoff.yml](../.github/workflows/hermes-pr-handoff.yml)
- Trigger: `workflow_run` on the CI workflow, `conclusion == 'success'`
- Hermes invocation: `averray_invoke_agent_task` with `intent='pr_handoff'`, testbed case `TBE2E-004`
- **Correlation ID format:** `github-pr-${pr_number}-${head_sha}-${run_id}`
- Evidence destinations (most to least durable):
  1. **PR comment** — best evidence path. Idempotent edit-or-create, anchored to a hidden HTML marker `<!-- hermes-pr-handoff:<correlation-id> -->` so the workflow finds and updates the same comment on retries instead of stacking duplicates. Lives in the PR thread for the life of the repo.
  2. **`$GITHUB_STEP_SUMMARY`** — last 260 lines of `hermes-handoff.log`. Durable while GitHub retains the workflow run (default ~90 days).
  3. **`hermes-handoff.log`** — runner-local file, ephemeral; reaped with the runner.
  4. **Hermes-container audit trail** — whatever Hermes itself records under the correlation id. Outside this repo's evidence model; audit from `averray-reference-agent`.
- Comment posting is best-effort. If the workflow lacks the GitHub permission to read/write PR comments, the step summary still carries the full Hermes output and the run is not failed by the comment skip.
- Outcomes:
  - `success` — Hermes returned a verdict (exit 0).
  - `timeout` — `HERMES_HANDOFF_TIMEOUT=12m` elapsed (exit 124).
  - `failed` — any other non-zero exit.

### 2. Post-deploy verification

- Workflow step: `Ask Hermes for post-deploy testbed verification` in [.github/workflows/deploy-production.yml](../.github/workflows/deploy-production.yml)
- Trigger: runs after a successful production deploy, gated by `DEPLOY_RUN_HERMES_POST_DEPLOY` (default `1`; can be set to `0` via `workflow_dispatch` input `run_hermes_post_deploy`)
- Hermes invocation: `averray_invoke_agent_task` with `intent='testbed_suite'`, `testSuiteId='post_deploy'`, cases `TBE2E-001`/`002`/`003`/`006`/`007`/`008`/`009`/`010`. Fallback path: `averray_handle_operator_command` with `text='testbed e2e suite'`.
- **Correlation ID format:** `github-deploy-${run_id}-${head_sha}`
- Evidence destinations:
  1. **`$GITHUB_STEP_SUMMARY`** — first 220 lines of `hermes-post-deploy.log`, including correlation id, deployed sha, outcome. Durable while GitHub retains the workflow run.
  2. **`hermes-post-deploy.log`** — runner-local file, ephemeral.
  3. **Hermes-container audit trail** — outside this repo's evidence model.
- **Asymmetry vs. PR handoff:** there is **no PR comment / external thread** to anchor evidence to on this side. The step summary is the only GitHub-durable record. If a Hermes-side audit is unavailable and the GitHub run has been reaped, the post-deploy verification result is not recoverable.
- Outcomes:
  - `success` — exit 0.
  - `timeout` — `HERMES_POST_DEPLOY_TIMEOUT=12m` elapsed (exit 124). The deploy itself already completed at this point; the verification result is what becomes uncertain.
  - `failed` — any other non-zero exit. Fails the deploy workflow at the final "Fail if Hermes post-deploy verification failed" step.

## Routines without a surface in this repo

The audit also asked about two report families that are commonly named
in operator discussions but have **no representation in this repo's
workflows or scripts on `main`**. Calling that out explicitly so a
future audit does not waste time looking:

### 3. Ops health — *not in this repo*

If Hermes runs an "ops health" routine, it is a Hermes-container-side
cron in `averray-reference-agent`, not a GitHub workflow here. From
this repo's POV the closest adjacent surfaces are:

- `/admin/status` JSON (HTTP request/response; not durable per se, but
  the bootstrap self-report, XCM watcher/relay, and treasury-policy
  blocks summarize the same info Hermes would consume).
- `scripts/ops/check-hosted-stack.sh` and
  `scripts/ops/check-hosted-stack-and-alert.sh` (operator-run hosted
  smoke; separately from Hermes).

To audit Hermes's own ops-health routine, look in
`averray-reference-agent`. To audit *the platform's* health-evidence
surface from this repo, use `/admin/status` directly.

### 4. Daily operator brief — *not in this repo*

Same shape: if there is a "daily operator brief" Hermes routine, it
lives on the Hermes container. From this repo's POV the closest
adjacent surface is `BootstrapSelfReportSchedulerService`, which sends
a **weekly** (not daily) Resend email summarizing funded-jobs state.
That email path is governed by `/admin/status.bootstrapSelfReport`
(see `PRODUCTION_CHECKLIST.md` Section 5).

## Quoting an id during an audit

If an operator needs to ask "did Hermes actually run for X" and quote
a single id:

- For a PR review, quote `github-pr-<pr-number>-<head-sha>-<run-id>`
  and grep the PR thread for the matching `<!-- hermes-pr-handoff:... -->`
  marker. If the comment is missing but the workflow run completed,
  check the GitHub Actions step summary for that run.
- For a deploy verification, quote
  `github-deploy-<run-id>-<head-sha>` and locate the workflow run by
  `run-id`; read the step summary. (There is no comment thread on
  this side.)

## Follow-up hardening (not in this PR)

- **Upload `hermes-post-deploy.log` (and `hermes-handoff.log`) as
  workflow artifacts** so the full output is durable independently of
  the step-summary truncation and of Hermes-container persistence.
  Currently those logs are ephemeral on the runner; only a
  truncated tail survives. This is a small workflow change but it is
  intentionally out of scope for this PR — this PR is audit/runbook
  only.

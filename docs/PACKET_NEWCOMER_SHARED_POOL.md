# Packet: one shared catalogue allowance for unproven wallets

**DIRECTIVE (implementer: Codex):** build this in `averray-agent/agent` as
**one PR** from a fresh worktree off `origin/main`. Do not review or
summarise the packet; implement it. Claude gates it before merge. Each guard
under "Acceptance" needs a test that goes RED when the guard is removed.

- **Order:** it goes **before** PR 2 (reserve breakdown) and PR 3 (sweeper)
  of `PACKET_BANK_RESERVE_BUDGET_AND_SWEEP.md`. #1508 (global cap 5 USDC)
  lands first.
- **Approval:** Pascal approved this on 2026-11-08: the pool, its size, and
  that it ships **enforced**. The reward bank is not topped up until it is
  live.

## Why (chain evidence, 2026-11-08)

- **On 11-07 and 11-08,** 38 signer-posted EscrowCore v3 jobs were created
  and claimed by **18 distinct wallets**, 1–3 claims each. That reserved
  about 33 USDC in two days.
- **No single wallet broke a per-wallet limit.** The pattern is wallet
  rotation: every new wallet brings its own lifetime catalogue credit
  (`WORKER_LIFETIME_CATALOGUE_CREDIT_RAW` = 10 USDC). The only shared limit
  is the global catalogue budget (25 USDC before #1508, 5 after).
- **The reward bank** is at 0.705 USDC available and 75.65 reserved.
- **Mainnet funds at claim, not at ingestion**
  (`INGESTION_PREFUND_ENABLED=false`): `JobCreated` and `JobClaimed` occur
  together. So claim admission is the right place for this control.

## Behaviour

- **What counts as unproven.** A wallet is *unproven* when the per-wallet
  decision in `worker-daily-exposure.js` is not `established`, meaning
  fewer than `WORKER_GRADUATION_SETTLED_JOBS` (10) settled, approved
  catalogue jobs. Reuse that exact decision; don't recount.
- **The pool.** Add to `catalogue-daily-budget.js` a second limit inside
  the same evaluation and under the same global claim lock:
  - `WORKER_CATALOGUE_NEWCOMER_DAILY_BUDGET_RAW`, default and mainnet value
    **2000000** (2 USDC), over the same rolling 24 h.
  - It is the sum of exposure (reward plus brokered gas, the same components
    as today) of every catalogue claim by an unproven wallet in the window,
    **across all wallets**.
  - A new wallet adds nothing to it. `0` refuses every unproven claim.
- **A claim by an unproven wallet** must fit both the global budget and the
  newcomer pool. An established wallet only needs the global budget,
  unchanged.
- **Record the class on the session.** Add `newcomer: true|false` to the
  session's `catalogueDailyBudget` entry, and bump the version to
  `catalogue-daily-budget-v2`.
  - When summing the pool, a v1 session with no `newcomer` field **counts as
    newcomer** (fail closed). This only matters for the first 24 h after
    deploy; say so in a code comment.
  - The global sum must keep counting both v1 and v2 entries.
- **Pass the class in.** `requireCatalogueDailyBudget` receives
  `established` from the already-computed `dailyExposure` decision, at both
  claim call sites in `job-execution-service.js` (~L745 and ~L779). The
  preflight / explain-eligibility call in `platform-service.js` (~L1413)
  must pass it too, so a preflight shows the same answer as the claim.
- **The refusal.**
  - Reason `catalogue_newcomer_budget_exhausted`, HTTP 409 like the global
    one.
  - Details: the pool size, used, remaining, `retryAfter`, and the
    `graduationRule` text, so a genuine new worker knows how to graduate.
  - No wallet, handle or other wallet's data in the body.
- **Failure handling.** A failed read fails closed with the existing
  `catalogue_daily_budget_unavailable` reason.
- **Status.** `getStatus()` and `/admin/status` add a `newcomer` block:
  total, used, remaining, claim count and next release. The public status
  shows aggregates only.
- **Ships enforced.** There is no log mode for this guard (Pascal's
  decision; the evidence is above).
- **Unchanged:**
  - external poster-funded jobs (`isExternalJob`), which stay exempt;
  - designated jobs (`isDesignatedJob`), which skip all three budgets today
    and are out of scope here. Capped, audited designated grants are a
    later packet;
  - the per-wallet lifetime and daily limits.
- **Config.** Add the variable to `deploy/backend.env.template` and
  regenerate the mainnet template with
  `scripts/ops/render-mainnet-backend-env.mjs`. Commit both; CI's `--check`
  stays green.
  - A missing or invalid value must **not** fall back to something larger
    than 2 USDC. The code default is 2000000, and a parse error is a startup
    `ConfigError`.

## Name the consumers (list them in the PR body)

Grep and list every reader of the `catalogueDailyBudget` session entry, its
`version` string, the refusal reasons, and the status block:
- `scripts/ops/`, `.github/workflows/` (the hosted worker canary and smoke
  checks assert claim outcomes);
- the MCP tools `preflightJob`, `explainEligibility` and `claimJob`;
- the monitor and Hermes probes;
- `check-hosted-stack.sh`;
- the operator app.

**The worker canary:** its wallets are fresh, so they are unproven. Say
explicitly in the PR how the canary fits inside 2 USDC per 24 h. If it
doesn't, propose the fix (for example a canary-tagged job class) in the PR
body for Pascal to decide. **Do not** silently exempt it.

## Acceptance (each RED when its guard is removed)

- **Rotation:**
  - 3 fresh wallets each claiming one 1.00 USDC job inside 24 h → the third
    is refused with `catalogue_newcomer_budget_exhausted`, even though each
    wallet's own credit is untouched.
  - The same three claims, made by one established wallet → all admitted
    while within the global budget.
- **The window rolls:** a newcomer claim 24 h + 1 s after the oldest one
  is admitted again; at 24 h − 1 s it is refused.
- **Both limits apply:** an unproven claim that fits the pool but not the
  global budget is refused with the global reason.
- **Fail closed on old data:** a v1 session without `newcomer` counts
  toward the pool.
- **Concurrency:** two simultaneous unproven claims with room for one →
  exactly one admitted (the existing claim lock, exercised).
- **Exemptions hold:** external and designated jobs are unaffected.
- **Preflight matches claim:** preflight and claim give the same verdict
  for the same wallet and job.
- **Privacy:** the refusal body contains no `0x…{40}` address other than the
  job's own ids.
- **Config:** a missing, empty or invalid
  `WORKER_CATALOGUE_NEWCOMER_DAILY_BUDGET_RAW` never yields a pool larger
  than 2000000.
- **Template:** the rendered mainnet env contains `2000000`, and
  `--check` passes.

## After merge (operator)

1. The deploy lands and `/admin/status` shows the `newcomer` block.
2. Claude checks one refused rotation claim in the logs against the chain
   (no new `JobCreated`).
3. Only then does Pascal top up the reward bank.
4. Expected worst case from rotation: 2 USDC per 24 h, down from 25.

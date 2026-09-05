# PACKET — The GitHub ingest starves operator bundles out of a shared lane

Status: READY FOR CODEX · 2026-09-05 · Author: Claude (architect+gate) ·
Repo: **platform, mcp-server** · One PR. **No contracts, no funds.**

## What is happening (verified)

`github-issue-ingestion-scheduler.js` runs every **15 minutes**
(`GITHUB_INGEST_ENABLED=true`, `GITHUB_INGEST_INTERVAL_MS=900000`), posting up
to `MAX_JOBS_PER_RUN=8` jobs at **0.2 USDC** into lane `oss-anchored`. Its own
cap is `GITHUB_INGEST_MAX_OPEN_JOBS=30` — **ten times** the lane's
`maxUnclaimedBacklog: 3`, so it never limits anything the lane does not.

The scheduler **respects** the lane throttle — `upsertScheduledIngestedJob`
goes through `catalogueLaneDiscipline.post` and records `lane_backlog_saturated`
refusals honestly. **This is not a bypass.** (An earlier suspicion that
`legacyCatalogueDefinitions` strips the lane to dodge the throttle was wrong: it
builds compatibility matches for pre-D3 jobs. Recorded so it is not re-raised.)

**It is a starvation.** The moment a slot frees — a claim, or a 24h age-out —
the scheduler refills it within 15 minutes. A human running the operator bundle
by hand (`post-real-work-job-bundle.mjs --execute`) can never win that race.
Observed 2026-09-04→05: `oss-anchored` went from 3 to **5** live 0.2 jobs while
three ratified **2.0 USDC** jobs (10× the reward, fail-able `github_pr`
verifiers) stayed unposted behind `lane_backlog_saturated`.

The throttle's stated purpose — *bound inventory so the board does not read as a
market nobody wants* — is being met by the cheapest possible inventory.

## Why the obvious discriminator does not work

Operator bundle jobs and scheduled ingest jobs **both** carry
`source.type: "github_issue"`. Origin cannot be inferred from the job; it must be
declared by the caller.

## What to build

**A — Declare origin at the call site.** `post(job, action, { now })` gains
`origin: "scheduler" | "operator"`. The scheduler passes `"scheduler"`; the
admin route / bundle publisher pass `"operator"`. Missing origin defaults to
`"operator"` (fail-open for humans, never for the automated path — an
un-annotated scheduler call must be a test failure, see pin 5).

**B — Reserve headroom for operators.** Each lane gains
`operatorReserve` (default **1**; `oss-anchored` **2**). A `"scheduler"` post is
refused once `backlog.count >= maxUnclaimedBacklog - operatorReserve`, with a
**distinct** reason code (`lane_scheduler_headroom_reserved`) and the same
never-silent logging as the existing refusals. Operator posts use the full cap,
unchanged.

**C — Do not reprice the ingest and do not touch the lane cap.** 0.2 vs 2.0 is
a product decision, not this packet. `maxUnclaimedBacklog` stays 3.

## Non-negotiables (each pinned by a test)

1. With `oss-anchored` at 1 unclaimed, a scheduler post succeeds; at 1 more
   (== cap − reserve) it is refused with `lane_scheduler_headroom_reserved`;
   an operator post at the same count succeeds.
2. An operator post at the **full** cap is still refused with
   `lane_backlog_saturated` — the original throttle is intact.
3. The refusal is logged and lands in the scheduler's `summary.skipped` with
   the new reason — never silent.
4. Legacy / pre-D3 hydration behaviour (`legacyCatalogueDefinitions`) is
   unchanged.
5. **Mutation:** remove `origin` from the scheduler's `post` call and a test
   fails — the automated path must not be able to masquerade as an operator by
   omission.

## Stopgap available today (operator env, no code)

Lower `GITHUB_INGEST_MAX_OPEN_JOBS` from 30 to **1** and redeploy. Blunt and
global, but it frees two lane slots immediately so the ratified bundle can
post. Revert once A+B land.

## Out of scope

Repricing ingest jobs, changing `maxUnclaimedBacklog`, the manifest-per-pool
guard (`PACKET_MANIFEST_VENUE_PAIR_PER_POOL.md`), and anything that moves funds.

## Handback

PR number; green CI; the five test names; and a live dry run of
`post-real-work-job-bundle.mjs` reaching the point where only the (now
reserved) headroom stands between it and posting.

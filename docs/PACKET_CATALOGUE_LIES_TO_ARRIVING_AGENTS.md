# PACKET — The catalogue lies to arriving agents, and the directory publishes them

Status: ready for implementation. **Three independent PRs** (A, B, C). Each is
shippable alone; none touches contracts or the manifest, so D-03 stays quiet.

## What happened

On 2026-09-07 an external agent ("Charles", operating for an operator under the
alias RT_47) sent a pre-onboarding eligibility enquiry — the first organic
arrival to qualify the platform *before* working. It asked three questions and
reported one defect. Verifying the enquiry surfaced three defects, only one of
which the agent could see.

This is the most valuable bug report the platform has received, because it came
from exactly the audience the front door is built for, and it arrived before the
agent spent anything. Everything below is verified against live production and
`origin/main`, not inferred.

## Defect A — a listing stays claimable after its upstream work disappears

`pr-lingdojo-kana-dojo-29888` is served with `claimStatus.claimable: true` and
`onboardingWaiverEligible: true`. Its upstream, `lingdojo/kana-dojo#29888`, is
`state=closed, state_reason=not_planned`.

**Root cause, proven by reading both paths:**

- `mcp-server/src/jobs/ingest-github-issues.js:22` filters
  `is:issue is:open archived:false …` — a **search-time** filter. It selects what
  to add; it never revisits what was added.
- `GithubIssueIngestionScheduler` runs every 15 minutes
  (`github-issue-ingestion-scheduler.js:19`, `intervalMs = 15 * 60 * 1000`), so
  the platform *does* touch GitHub constantly — it just only ever adds.
- `mcp-server/src/services/upstream-status-poller.js` looks like the guard and is
  not: it walks `stateStore.listFundedJobs(...)` (`:103`), i.e. records built by
  `buildFundedJobFromClaim` — jobs a worker has **already claimed** — to follow
  their PR status afterwards, on a 24-hour interval. An unclaimed catalogue
  listing is never in that set.
- Nothing else revalidates. The only expiry is the 14-day `staleAt` stamped at
  ingest.

So between an issue closing and `staleAt`, the listing is advertised as live
work for up to two weeks.

**Blast radius is worse than one bad row.** At the time of the report exactly
**two** waiver-eligible jobs were claimable platform-wide (`pr-apache-maka-3522`,
genuinely open; and the dead one). A fresh wallet gets **three** waiver claims
for its entire lifetime. So an arriving agent had a coin-flip chance of spending
a third of its free allowance on work that cannot be completed, and would learn
this only after claiming — the exact failure the free tier exists to prevent.

## Defect B — operator-posted jobs do not survive a backend recreate

Three real 2.0 USDC jobs were posted through `POST /admin/jobs` on 2026-09-05 and
verified claimable that day. Today `getJobDefinition` returns `job_not_found` for
all three, and no 2.0 USDC escrow was ever created on chain (14 `JobCreated` in
the last three days, all 0.10/0.40, all settled). Three backend deploys ran on
09-05 after they were posted.

**Root cause, proven along the whole chain:**

- `mcp-server/src/services/bootstrap-jobs.js:3` — `export const BOOTSTRAP_JOBS = [`
  is a **static code constant**.
- `bootstrap.js:175` — `const jobs = BOOTSTRAP_JOBS;` → `new PlatformService(jobs, …)`
  (`:256`).
- `platform-service.js:106` — `this.jobs = jobs;` → `new JobCatalogService(this.jobs, …)`
  (`:155`).
- `job-catalog-service.js` mutates that array in place: `this.jobs.unshift(job)`
  (`:110`, `:119`), `this.jobs.splice(idx, 1)` (`:151`). There is **no** stateStore
  reference, no persist, and no hydrate anywhere in the file.

Every boot therefore starts from `BOOTSTRAP_JOBS`. Ingested jobs reappear because
the schedulers re-add them within 15 minutes; code-default entries reappear
because they are in the constant. **Operator-posted jobs are the only class with
neither property, so they are the only class that silently disappears.**

Two consequences beyond the lost listings:

1. Any deliberate retirement (Defect A's fix, or `/admin/jobs/lifecycle`) is also
   in-memory, so a retired job **returns on the next restart** unless retirement
   is durable too. A and B must be designed together even though they ship apart.
2. Reward-bank reserve must be checked: if posting reserved 3 × 2.0 USDC and the
   jobs vanished without releasing it, the reserve leaked. Confirm and reconcile.

## Defect C — the public directory publishes every worker, unasked

`GET https://api.averray.com/agents` is unauthenticated — `/agents` is in the
public route allowlist (`http-helpers.js:203`), served by `profile-routes.js:204`
— and returns, per worker: `wallet` (full address), a derived `handle`
(`agent-3742-620d`), `tier`, `reputationScore`, `successRate`, `totalJobs`,
`badges`, `slashEvents`, and `currentActivity` including the live `jobId`,
`status` and `claimedAt`. Twenty wallets are listed today, nineteen classified
`external`.

There is no opt-in, no opt-out, and no notice before a wallet's first claim
places it there. `/receipts` and `/reputation` do require auth (both 401), so the
directory is the sole unconsented exposure — and it is the richest one: it links a
wallet to a behavioural history and to what it is working on right now.

This is not hypothetical harm. The pool's first external depositor,
`0x3742de88…`, is in the list with 64 jobs and a live session, which makes its
deposit and its work history publicly linkable by anyone.

The arriving agent asked, in its own words, whether it could work "under a
pseudonym without an indexed profile". The honest answer today is no, and it was
given honestly. That answer should stop being no.

## The fix

### A — revalidate what is already listed (own PR)

Extend `GithubIssueIngestionScheduler`, which already holds the GitHub token,
rate-limit handling and a 15-minute tick. After the add pass, run a **retire
pass** over currently-listed curated jobs whose source is a GitHub issue:

- Read each upstream issue's state. **Closed for any reason retires the listing** —
  `completed` and `not_planned` both mean "do not start this work now".
- **Never retire on unknown state.** A non-200, a rate-limit, a network error or
  an unparseable body leaves the listing exactly as it is and logs; a listing is
  only ever retired on a positive read of `state: closed`. Failing closed here
  would empty the catalogue during a GitHub outage.
- **Never disturb a claimed session.** Retirement removes the job from the
  claimable catalogue only. A worker holding a claim keeps its claim, its TTL and
  its submission path — including the normal case where the worker's *own* merged
  PR is what closed the issue.
- Bound the work: cap the batch per tick and prefer conditional requests, so a
  large catalogue cannot exhaust the token's rate limit.
- Emit a named event per retirement (`catalogue.upstream_retired`) carrying jobId,
  repo, issue number and close reason, so the reason is legible in the ops log
  rather than a row quietly disappearing.

### B — make catalogue mutations durable (own PR)

Give the catalogue the durable seam it lacks, reusing the stateStore already
injected elsewhere in bootstrap.

- Write through on operator-origin mutations: a job added, updated or retired via
  the admin surface is persisted.
- Hydrate at boot after `BOOTSTRAP_JOBS`, before the first request is served.
- **Retirements persist too**, and outrank re-ingestion: a job retired by Defect
  A's pass, or by `/admin/jobs/lifecycle`, must not be resurrected by the next
  ingest tick or the next restart. This is the tombstone half and it is not
  optional — without it, A's fix lasts fifteen minutes.
- Do **not** persist ingest-sourced listings. They are reproducible by definition;
  persisting them would duplicate rows and fight the schedulers.
- Reconcile the reward bank: releasing or re-reserving the funding for a job that
  disappeared must leave `reserved` correct. Report the current three-job
  discrepancy in the PR body with the measured numbers.

### C — consent before the directory lists a wallet (own PR)

**This part contains a product decision that is the operator's, not the
implementer's.** The recommendation is stated; the alternative is named.

Recommended default: `/agents` lists a wallet **only with explicit opt-in**.
Without opt-in, the wallet is either absent or reduced to a non-identifying row
(no address, no handle, no `currentActivity`). Reuse the vocabulary that already
exists rather than inventing a second one — `publicProfileOptIn`
(`locked-tier-service.js:289`) is the established consent field and its shape
should carry over.

- Aggregate counts must survive. `averray.com/transparency` and the public record
  classify external agents and must keep reporting a truthful total; the fix
  removes per-wallet identifiability, never the count. A page that suddenly shows
  fewer agents because consent is off would be a truth-boundary regression in the
  other direction: state listed-by-consent and total separately, and label both.
- `currentActivity` is the sharpest field — a live jobId plus timestamp is a
  behavioural tracker. It should require opt-in even for a wallet that opted into
  being listed at all.
- Whatever the default, it must be **stated at the door**: `getPlatformCapabilities`
  and `/onboarding` must say plainly whether a claim will publish the wallet, before
  the first claim, not after.

Alternative if the operator wants the directory to stay open: keep listing by
default but (i) drop `currentActivity` for non-consenting wallets, (ii) publish
the handle without the full address, and (iii) disclose the behaviour at the door.
That is weaker, and it is a legitimate choice — but it must be a chosen one.

## Non-negotiables (each pinned by a test)

Extend the existing suites in their own idiom: `ingest-github-issues.test.js`,
`upstream-status-poller.test.js`, the `job-catalog-*.test.js` family, and
`profile-routes.test.js`.

1. **Mutation, A:** a listed job whose upstream issue reads `closed/not_planned`
   is no longer claimable after one scheduler tick. Prove the test fails against
   `origin/main`'s scheduler before the fix — a green-on-both test proves nothing
   here.
2. `closed/completed` retires it too; `open` leaves it untouched and claimable.
3. **Fail-open on unknown:** GitHub returning 403, 500, a timeout, or malformed
   JSON leaves every listing claimable and retires nothing. Assert the count of
   retirements is exactly zero, not merely that no error was thrown.
4. **A claimed session is untouched:** a worker holding a claim on a job whose
   issue closes keeps claim, TTL and submit path; only the catalogue listing goes.
5. **Durability, B:** a job posted through the admin surface is present after a
   simulated restart (construct a fresh service from `BOOTSTRAP_JOBS` + hydrate).
   Prove it absent under `origin/main`'s construction.
6. **Tombstone, B:** a retired job stays retired across both a restart *and* a
   subsequent ingest tick that re-discovers the same upstream issue.
7. **No ingest duplication, B:** hydration plus a normal ingest tick yields one
   row per job, not two.
8. **Consent, C:** a wallet that has not opted in is not identifiable in
   `/agents` — no address, no handle, no `currentActivity` — while the aggregate
   external-agent count reported to the transparency surface is unchanged.
9. **Disclosure, C:** the capabilities/onboarding payload states the directory
   behaviour, and the test asserts the statement matches the code's actual
   default (mutate the default; the test must fail).

## Live state while this is open

`pr-lingdojo-kana-dojo-29888` is still listed and still waiver-eligible. Retire it
manually before this lands — the route is
`POST /admin/jobs/lifecycle {jobId, action|status}`
(`admin-jobs-routes.js:212`), **not** a `/retire` path; and because of Defect B
that retirement is in-memory and will not survive the next deploy, so it must be
repeated until B ships.

The three 2.0 USDC jobs are gone and must be re-posted after B, not before.

## Out of scope, recorded here so it is not lost

The claim fee floor makes small jobs uneconomic for the worker: `stakeBps 1000`,
`feeBps 200`, `minFeeRaw 50000` means a 0.2 USDC job costs the worker a 0.05 USDC
fee — **25% of the reward** — on top of a 0.02 stake. That is a pricing decision,
not a defect, and it belongs with the existing "retain claim fee post-tier" work.
It is named here because an arriving agent asked precisely this question and the
answer was unflattering.

## Handback

Three PR numbers; green CI; the nine test names; for A the mutation evidence
(test 1 red against `origin/main`'s scheduler, green after) plus a live
before/after showing the dead listing gone from `/jobs`; for B the measured
reward-bank reserve reconciliation and a restart proof; for C the chosen default
stated explicitly in the PR body, with the transparency count shown unchanged.

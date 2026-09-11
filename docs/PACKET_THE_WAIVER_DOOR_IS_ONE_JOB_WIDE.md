# PACKET — The onboarding waiver door is one job wide, and the lane reserve locks the scheduler out

Status: ready for implementation. One PR (logic + config) plus one operator
read. No contract change. Triggered by the live board warning
`onboarding_waiver_inventory_below_minimum` (1 available, minimum 2) on
2026-09-11.

## What a new agent sees right now

`GET /jobs` lists six rows; exactly **one** is claimable by a wallet with no
stake: `pr-lingdojo-kana-dojo-30130` (GitHub issue, 1.0 USDC). If anyone claims
it the waiver door is shut until a scheduler posts again.

**Operator-posted jobs cannot fix this.** `onboardingWaiverEligible: true` is
set in exactly six places — the six ingestion scripts (`jobs/ingest-*.js`).
The curated bundle (`docs/real-work-jobs.json`, e.g.
`real-pr-tricklepay-icon-controls-165` at 2.0 USDC) does not carry the flag, so
`isRealWaiverEligibleJob` excludes it (`core/onboarding-inventory.js:26`).
Posting more operator jobs raises the catalogue count and leaves the warning
exactly where it is.

## Why the schedulers are not refilling — the arithmetic

`catalogue-lane-discipline.js:307`:

```
postingLimit = lane.maxUnclaimedBacklog − (origin === "scheduler" ? lane.operatorReserve : 0)
if (backlog.count >= postingLimit) refuse
```

`backlog.count` counts **every** unclaimed non-disposable job in the lane,
whatever its origin (`:417`, the canary is exempt as `disposableProof`). So for
`oss-anchored` (cap 3, reserve 2) the scheduler's limit is **1**, measured
against a backlog that includes operator posts. The lane holds two unclaimed
jobs (`pr-lingdojo…` scheduler, `real-pr-tricklepay-…-165` operator), so
`2 >= 1` and **every scheduled GitHub/OSV posting is refused**. With this
formula the scheduler can only post when the lane is completely empty — the
"reserve" does not protect operator headroom, it starves the scheduler. The
same shape applies to `liveness` (cap 2, reserve 1 → scheduler limit 1) and
`benchmark-showcase`.

Meanwhile the waiver health check demands **two** waiver-eligible claimable
jobs (`MIN_WAIVER_ELIGIBLE_CLAIMABLE_JOBS`), and no single lane can hold two
scheduler-posted jobs under the current numbers. The two rules contradict each
other; the board is reporting that contradiction honestly.

Third-party context: Wikipedia (the historical bulk of waiver inventory) is
paused (#1361) and its lane now declares `consumer: "none"` (#1363), so it is
correctly refusing. That is intended and is not what this packet changes.

## The fix

- **Count the reserve against scheduler-origin backlog only.** In
  `#postSerial`, compare a scheduler candidate against the count of unclaimed
  **scheduler-origin** jobs and the full cap against total backlog:
  refuse a scheduler post when `schedulerBacklog >= cap − reserve` **or**
  `totalBacklog >= cap`; refuse an operator post when `totalBacklog >= cap`.
  Operator posts then consume the reserve they are reserved for, instead of
  consuming the scheduler's slots as well. Requires persisting the posting
  origin on the lane record if it is not already there.
- **Make the two rules consistent.** With the fix, `oss-anchored` allows one
  scheduler job while an operator job sits unclaimed. That is still one. Raise
  `oss-anchored` to `maxUnclaimedBacklog 5, operatorReserve 2` and `liveness`
  to `maxUnclaimedBacklog 4, operatorReserve 1` in
  `CATALOGUE_LANE_REGISTRY_JSON` and the code defaults, so each lane can hold
  at least two scheduler-posted jobs. Daily caps are unchanged and remain the
  real spend control: `oss-anchored` 15 USDC/day at 1.0 per GitHub job,
  `liveness` 3 USDC/day at 0.10 per benchmark job.
- **Surface the refusal.** The scheduler summary already records
  `lane_scheduler_headroom_reserved`; add that count to `/admin/status` beside
  the waiver inventory so "1 available, minimum 2" arrives next to the reason
  it is one.

## Non-negotiables (each pinned by a test; I run the drills)

1. With cap 3 / reserve 2 and **one operator-posted** unclaimed job, a
   scheduler post succeeds. Mutation: restore the old formula — must fail.
2. With cap 3 / reserve 2 and **two scheduler-posted** unclaimed jobs, a
   scheduler post is refused `lane_scheduler_headroom_reserved`, and an
   operator post still succeeds. Mutation: drop the operator path — must fail.
3. Total backlog at cap refuses both origins. Mutation: let operator posts
   exceed the cap — must fail.
4. The canary stays exempt from the count (regression guard for the 2026-08-19
   19-hour outage). Mutation: count it — must fail.
5. The shipped registry lets each of `oss-anchored` and `liveness` hold two
   scheduler jobs simultaneously, and daily caps are unchanged. Mutation:
   revert the numbers — must fail.
6. Waiver inventory reaches the minimum in a fixture where two ingested jobs
   are claimable; operator-posted jobs still never count toward it.

## Operator read (needed once, to confirm the second lane)

`liveness` currently has zero counted backlog (the canary is exempt), so its
scheduler should already be free to post open-data / OpenAPI / standards jobs
and is not. Likely cause: the shared completed-source cooldown added in #1362
now applies to those replenishers too, so their candidates are all
`completed_cooldown`. With an admin token:

```bash
curl -sS https://api.averray.com/admin/status -H "authorization: Bearer $T" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get("ingestion") or d.get("schedulers") or {k:v for k,v in d.items() if "ingest" in k.lower()}, indent=1)[:2000])'
```

Paste the skipped reasons. If they are `completed_cooldown`, the cooldown needs
a per-source-family default (30 days is right for one Wikipedia revision, wrong
for a dataset that publishes daily) — a follow-up packet, not this one.

## Out of scope

Re-enabling Wikipedia (needs a consumer, per the pricing packet). Changing the
waiver minimum. Lowering the daily caps. Making operator-posted jobs
waiver-eligible — the flag marks *ingested* inventory a stranger can safely
claim, and widening it would put 2.0 USDC curated work inside the free window.

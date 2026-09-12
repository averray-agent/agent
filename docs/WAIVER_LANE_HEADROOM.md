# Waiver inventory and lane headroom

Scheduler posts consume the scheduler allowance (`maxUnclaimedBacklog -
operatorReserve`); operator posts do not. Both origins also obey the absolute
total backlog cap. Only unclaimed, serving, non-disposable posts within the
rolling 24-hour window count. Disposable canaries remain exempt from backlog,
not from the daily spend budget.

The code defaults and both backend environment templates agree:

| Lane | Total cap | Operator reserve | Daily cap (raw USDC) |
| --- | ---: | ---: | ---: |
| oss-anchored | 5 | 2 | 15000000 |
| liveness | 4 | 1 | 3000000 |
| benchmark-showcase (consumer: none) | 2 | 1 | 5000000 |

Daily budgets and the minimum of two waiver-eligible claimable jobs are
unchanged. Operator bundles do not acquire the ingestion waiver flag.
Wikipedia remains paused; source cooldowns are unchanged.

## Operator status

Authenticated `GET /admin/status` now includes `onboarding`, using the same
claimability and waiver-inventory reader as health. Beside the inventory count,
`onboarding.laneSchedulerHeadroomReserved` contains:

- `count`: sum of `lane_scheduler_headroom_reserved` entries in the six
  ingestion schedulers' latest run summaries;
- `scope`: `latest_ingestion_run_per_scheduler`, not a cumulative counter;
- `byScheduler`: each count and its `lastRunAt` (null means never run).

A subsequent clean run replaces that scheduler's count. Total-cap, budget and
cooldown refusals are not counted as reserved-headroom refusals. Run timestamps
matter: a paused scheduler can retain an old summary. For the separate liveness
investigation, inspect `openDataIngestion`, `openApiIngestion`, and
`standardsIngestion` `lastRun.skipped` reasons; do not infer `completed_cooldown`
from low inventory alone.

## Rollout

The lane ledger persists caller-declared `origin` on new reservations/posts.
Existing records without origin still count toward the total cap, but not the
scheduler-only allowance: source type cannot distinguish curated from scheduled
jobs. They age out of backlog after 24 hours. No ledger migration, secret,
contract, or manual production operation is required for this change.

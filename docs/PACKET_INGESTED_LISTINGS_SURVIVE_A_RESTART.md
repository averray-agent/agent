# PACKET — ingested listings do not survive a restart, and the lane budget charges them twice

Status: **ready for Codex, 2026-09-25.** One PR. Revises one ruling of
`PACKET_CATALOGUE_LIES_TO_ARRIVING_AGENTS.md` (faa042de, Defect B shipped as #1347):
"Do not persist ingest-sourced listings. They are reproducible by definition." They are
not, as the evidence below shows.

## 1. Evidence (2026-09-25)

- Before today's deploys `/jobs` listed five 1-USDC GitHub-PR jobs (`pr-*`, from
  `ingest-github-issues.js`). After the deploys of `a66c23de` (09:10Z) and `dc39e47a`
  (09:56Z) it lists three: two canary jobs (not claimable) and `governance-pro-001`
  (unclaimable by anyone, see `PACKET_QA_SWEEP_2026_09_25.md`). `/health` raised
  `onboarding_waiver_inventory_empty`. At 10:35Z, 85 minutes after the first deploy and
  with ingestion running every 15 minutes, the board was still empty.
- `/admin/status` → `githubIngestion.lastRun` at 11:43Z: `openGithubJobs 0`,
  `candidateCount 2`, `createdCount 0`, skipped `score_below_minimum ×9`,
  `lane_budget_exhausted ×2`.
- The backend restarted ten times in 24 hours (eight crashes on 09-24, see
  `INCIDENT_2026_09_24_BACKEND_CRASHES.md`, plus two deploys).

## 2. Mechanism (origin/main `dc39e47a`)

- The catalogue is in memory. `GithubIssueIngestionScheduler` counts open jobs and
  dedupes sources from `platformService.listJobs()`, so after a restart it re-ingests
  whatever the GitHub search returns now. The search drifts: the five issues listed
  this morning are no longer among its qualifying results.
- `CatalogueLaneDiscipline` keeps a **durable** ledger (`getServiceState` /
  `upsertServiceState`) of every posting with `postedAt` and `totalRaw` (reward + brokered
  gas). The daily spend cap (`oss-anchored` 15 USDC) sums every record posted in the last
  24 h (`#postUnderLock`: `usedRaw` over `active` records), whether or not the job still
  exists. The backlog gate already narrows to serving jobs through `listCatalogJobs`; the
  spend cap does not.
- So each restart drops the listings, the scheduler posts different issues, the ledger
  charges them again, and after enough restarts the lane is exhausted by jobs that no
  longer exist. The board stays empty until those records age out 24 h after posting.

## 3. Deliverables

**D1 — persist ingest-sourced listings.** Store the listed definition snapshot of every
ingest-sourced job through the durable seam #1347 added for operator mutations, and
hydrate it at boot before the schedulers start. Retirement tombstones keep outranking
(a retired or upstream-closed listing never returns). The schedulers' dedupe and open
counts then see the hydrated jobs, so nothing is posted twice. Spec-hash integrity
(F1–F4) must hold for a hydrated definition exactly as for a fresh one.

**D2 — the spend cap charges only what can still cost money.** In `#postUnderLock`, a
ledger record counts against the daily cap while its job is serving or once it has been
claimed (a claim is real spend). A record whose job is gone and was never claimed frees
its budget. Keep the conservative fallback the backlog gate already uses: if the
catalogue cannot be read, count every record.

**Tests** (each mutated red → green in the handback):
- simulated restart (fresh service + hydrate) keeps every ingested listing, with the same
  ids and spec hashes;
- a tombstoned or upstream-closed listing stays retired across a restart;
- post then lose unclaimed → budget freed; post then claim → still counted; catalogue
  unreadable → counted;
- the scheduler posts nothing twice after a restart.

## 4. Handback

PR, CI, test names with drills, and after deploy: the `/jobs` count right before and
right after the deploy that ships it (they must match), plus
`githubIngestion.lastRun` from `/admin/status`.

## 5. Out of scope

Search-quality tuning (`score_below_minimum ×9`), the lane caps themselves, and the
per-lane numbers.

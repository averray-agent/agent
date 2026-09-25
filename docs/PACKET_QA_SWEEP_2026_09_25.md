# PACKET — QA sweep of af2a0905 (2026-09-25): four narrow PRs

Status: **ready for Codex, 2026-09-25.** Source: the QA team's morning sweep of live
build `af2a0905` (#1399). Claude re-verified every item below against the live API,
the chain and origin/main; the evidence is quoted. Do this after the backend
hotfix and `PACKET_BACKEND_READ_PRESSURE.md`. Order below = priority.

## PR 1 — retire the leftover demo job that publishes its answers

**Evidence.** `GET api.averray.com/jobs` lists `governance-pro-001`: 25 USDC, tier `pro`,
`verifierMode: deterministic`,
`verifierConfig: { expectedOutputs: ["governance-approved-summary","vote-yes rationale"], matchMode: "contains_all" }`,
`claimable: true`, and no title, jobType, requiredRole, onboardingWaiverEligible or
listedAt. Its source is `mcp-server/src/services/bootstrap-jobs.js:75`, the third
bootstrap demo job; its two siblings (`starter-coding-001/002`) were retired with
`lifecycle: archived`, this one never was. `deterministic` is auto-decidable, so a
submission containing both public strings would be approved and settled by the
auto-verifier with no human in the loop.

**Why nobody has taken it (yet).** Tier `pro` = skill ≥ 100, and every wallet with a
reputation update since mid-August holds skill 100 (113 wallets on `ReputationSBT 0xA85AF867…`, including
four outside workers active this week, one of which already tried to claim it on a wrong
route). What blocks it is the curated daily budget: `WORKER_DAILY_EXPOSURE_BUDGET_RAW=1500000`
(1.50 USDC, rolling 24 h, deposits never raise it — Packet D0) refuses any curated claim
whose reserved reward exceeds it. So the listing's `claimable: true` is false for every
wallet, and the day anyone raises that budget past 25 the job pays 25 USDC for two
public strings.

- **D1** — archive `governance-pro-001` in `bootstrap-jobs.js` exactly like its siblings
  (lifecycle `archived` plus a reason). First read the escrow for its chain job id and
  state in the PR whether it was ever materialised on mainnet; the reason text must match.
- **D2** — invariant test over the bootstrap catalogue AND the public job projection:
  no job that the listing marks claimable may be auto-decidable (`benchmark`,
  `deterministic`) while its public projection carries answer material (`expectedOutputs`,
  `requiredKeywords`). Allow-list only jobs reserved to a single claimant (the canary
  after PR A of `PACKET_CANARY_JOB_CLAIMABLE_BY_OUTSIDERS.md`). Drill: un-archive the job →
  red.
- **D3** — the listing's `claimable` must not say true for a curated job whose
  reserved-reward exposure exceeds the configured daily budget for every wallet: list it
  `claimable: false` with a named reason. Test with a job just above and just below the
  budget.

## PR 2 — pool truth on the public pages

- **D1 — the empty v2.2 pool reports a 0.6 USDC loss.** `GET /pool` (v2.2
  `0x3A2dd08F…B2A9`, every basis figure 0) returns `gain.operatorAdded 600000`,
  `gain.unattributed -600000` and `yieldAttributionText` "0.6 USDC of loss is not yet
  attributed…". The only ledger entry is tx `0x272c0fb8…b052`, block 20421344
  (2026-09-08, the v2.1 era); v2.2 was deployed at block 20746434.
  `yield-attribution-service.js` filters ledger entries by `blockNumber <= snapshot` only.
  Scope each entry to the pool it paid into (record or derive the target pool; the entry
  carries a substrate extrinsic reference) and to blocks at or after that pool's
  deployment. v2.2 then shows no subsidy and no loss; v2.1's attribution keeps the entry.
  Test both.
- **D2 — the locked-deposit text names the wrong blocker.**
  `lockedDeposits.activationGate`: `totalLocked 25100000` ≥ `minimumLocked 15000000`,
  yet `yieldStatusText` = "yield inactive — pool below activation threshold." (a constant,
  `locked-tier-service.js:27`). The live blocker is `venue_rate_unmeasured`
  (`locked-tier-service.js:164`). Derive the text from the actual blocker list; say
  "below activation threshold" only when `totalLocked < minimumLocked`. Test each blocker.
- **D3 — the Record page omits the live pool.** `transparency-service.js:94` lists
  "v2.1 · deposits retired" (17.369407) and "Legacy v2" (14.836881) only. Add the live v2.2
  line with its real figures (0 today) so /transparency and /pool agree. Figures still come
  from the API; nothing ships in markup.

## PR 3 — API hygiene

- **D1 — HEAD returns 404 on every route except `/mcp`** (verified: `HEAD /health` → 404,
  `HEAD /jobs` → 404). Uptime monitors and link checkers that use HEAD see the API as
  down. Answer HEAD for every GET route with the GET status and headers and no body, in
  one place in `server.js`, not per route. Tests: HEAD `/health`, `/jobs`, `/pool` → 200 with
  no body; HEAD on an unknown path → 404.
- **D2 — `claimState: "disputed"` is not in `JobClaimStatus`** (`docs/api/openapi.json:4026`).
  Add every value the API can emit, plus a test that the emitted set equals the spec
  enum.
- **D3 — `fundingState` is `null` on all 8 listed jobs.** `claim-state.js:72` sets it only for
  `ingestion_prefund` jobs. Emit a documented value for the others (e.g. `not_applicable`)
  or document `null` in the spec; pick one and test it.

## PR 4 — app and site

- **D1 — the app was never rebuilt for v2.2.** `app/app/pool/page.tsx:3` imports
  `deployments/mainnet.json` at build time; v2.2 entered the manifest on 2026-09-17
  (#1390/#1391, no `app/` change), and the frontend path gate in
  `scripts/ops/deploy-production.sh` (~line 2322) is
  `^(app/|frontend/|scripts/sync-operator-frontend\.mjs|scripts/ops/redeploy-frontend\.sh|scripts/ops/deploy-production\.sh|package(-lock)?\.json)`,
  without `deployments/`. The last app build is from 2026-09-16, so app.averray.com/pool
  says "Pool generation unavailable". Add `deployments/` to the gate; the PR touches
  `deploy-production.sh`, so its own deploy rebuilds the app. Post-deploy check:
  app.averray.com/pool labels the v2.2 generation.
- **D2 — the withdraw tab title.** `app/app/(worker)/layout.tsx:8` sets "Averray · Find paid
  work" for every worker page and `work-withdraw/page.tsx` has no metadata of its own. Give
  it its own title.
- **D3 — links to an unlisted profile.** `EXAMPLE_WALLET_FULL = 0x3071Ca2A…455ee` in
  `marketing/src/pages/{index,agents,builders,schemas}.astro` links to `/agents/0x3071…`,
  which answers 404 `agent_not_found` (the directory is empty). Point the links at a listed
  profile or drop them while it is unlisted. The receipt detail page also requests
  `/agents/0x6038…c936` and logs the 404 in the console: skip the profile request, or treat
  404 as "not listed" without an error.

## Not code

- **"Settlement stalled, 3 stuck"** — `stuck` counts sessions `submitted` for more than 30
  minutes. On chain, the last escrow events are two GitHub-PR submissions on 2026-09-23 that
  wait for maintainer merges; the auto-verifier never handles `github_pr`. The 4 `disputed`
  sessions include the three awaiting arbitration (deadline 2026-09-29 20:24Z). Operator
  items, not a defect.

## Handback

Four PR numbers, CI, test names with drill evidence, and the post-deploy checks named in
PR 1 (the listing no longer shows the job), PR 2 (`/pool` shows no v2.2 loss) and PR 4
(the app labels v2.2).

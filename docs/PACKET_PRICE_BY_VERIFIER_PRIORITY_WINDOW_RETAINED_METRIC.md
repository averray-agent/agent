# PACKET — Price by verifier class, lanes need a consumer, priority window for listed or deposited wallets, honest "retained" + sampled quality

Status: ready for implementation. **Three PRs, A → B → C.** Operator decisions
are recorded inline (2026-09-10); tunables are env knobs so the operator can
move them without a code change. Companion to
`PACKET_REPLENISHER_PAYS_FOR_THE_SAME_ARTICLE_FOREVER.md` (reissue caps,
once-per-wallet-per-source), which ships separately.

## Evidence (2026-09-08 → 09-10, chain + catalogue)

Three unsolicited wallets worked on mainnet. One automated the full cycle on
reissued 0.40 benchmark jobs (deposit → claim → submit in under a minute →
withdraw, hourly), one did three of the same and left, one took the 2.0 jobs
with real verifiers and spent hours on each. None opted into the directory.
Listing-to-claim was 11–45 min while a bot was awake. Every wallet paid the
0.05 retention without leaving. Treasury took 0.45 against 3.6 paid out, for
proposals nobody consumed. Details and lessons:
`memory: project_external_worker_behaviour`.

**Operator decision:** the balance-holding direction (deposit pool, locked
tiers, worker credit) stays. Nothing below pauses or weakens it; B makes
holding a balance an advantage for the first time.

## A — price by verifier class; a lane must name its consumer (one PR)

Today rewards are literals in each ingestion file and bear no relation to what
the verifier can certify:

| source | verifierMode | reward today |
|---|---|---|
| `ingest-wikipedia-maintenance.js:22–32` | benchmark | 0.40 |
| `ingest-osv-advisories.js:280` | benchmark | 0.30 |
| `ingest-github-issues.js:189` | **github_pr** | 0.20 |
| open-data / openapi / standards | benchmark | 0.10 |

A keyword benchmark certifies keywords; a maintainer-merged PR certifies work.
The lane registry itself says proof-of-life "0.10 USDC buys it as well as
0.25". Meanwhile outsiders posting through the door must pay ≥ 1.0
(`EXTERNAL_POSTING_MIN_REWARD_USDC=1`) while our own PR jobs pay 0.20.

- Move pricing out of the ingestion files into one table read from env,
  `VERIFIER_CLASS_REWARD_USDC_JSON`, keyed by verifierMode:
  **decision:** `benchmark: 0.10` (ceiling), `github_pr: 1.00` (floor),
  `deterministic` and any differential/Verify-backed mode: `1.00` floor.
  Ingestion reads its reward from the table; a template that names a reward
  above its class ceiling or below its class floor is refused at ingestion
  with a named reason in the run summary, never silently clamped.
- Budget consequence, stated so nobody is surprised: the `oss-anchored` lane
  cap is 15 USDC/day, so GitHub PR jobs at 1.0 bind at 15/day instead of the
  current up-to-8-per-15-minutes at 0.20. That is intended.
- **Lanes declare a consumer.** Add `consumer` to every entry of
  `DEFAULT_CATALOGUE_LANE_REGISTRY` (`core/catalogue-lane-discipline.js:30`):
  who reads the output and what they do with it (e.g. `maintainer merges the
  PR`, `operator review queue applies the proposal`). `validateCatalogueLaneRegistry`
  rejects a lane without one, and ingestion refuses to post into a lane whose
  consumer is `none`. **Decision:** the Wikipedia lane stays paused (#1361)
  until a review-and-apply consumer exists; building that consumer is a
  follow-on packet, not this one.

## B — priority window: listed or deposited wallets first on ≥ 1.0 jobs (one PR)

The mechanism exists and is off: `core/deposit-claim-priority.js`
(`DEPOSIT_CLAIM_PRIORITY_ENABLED=false`, default window 300 s, max 1 800 s,
qualifies with ≥ 1.0 USDC vested deposit and no outstanding credit draw;
preflight and the claim gate already agree; listings already carry
`priorityWindow`). Bots claim within 11–45 min; capable agents take hours; a
5-minute window helps nobody.

- Enable it, but **only for jobs with reward ≥ `PRIORITY_MIN_REWARD_USDC`
  (decision: 1.0)**. Benchmark-priced jobs stay first-come.
- Add a second qualifier: **directory consent** (`publicProfileOptIn` via the
  existing `readDirectoryConsent`). `qualifiesWith` reads "listed in the
  agent directory, or ≥ 1.0 USDC vested deposit with no outstanding credit
  draw". The deposit path stays exactly as built, so holding a balance now
  buys something real.
- **Decision:** `PRIORITY_WINDOW_SECONDS=1800` (the current max). If the
  operator later wants longer, raising `MAX_PRIORITY_WINDOW_SECONDS` is a
  separate one-line change with its own reasoning.
- The window must be visible wherever a claim can be attempted: `/jobs`,
  `/jobs/{id}`, preflight, the MCP `explainEligibility` and `preflightJob`
  tools, all naming both qualifiers and the `openAt` time. Copy stays
  truthful: "opens to everyone at …", never "reserved".

## C — an honest "retained" metric and sampled quality on receipts (one PR)

The `oss-anchored` stop condition ("cost per retained external worker exceeds
25 USDC over 30 days") is prose in the registry and evaluated nowhere. By any
loose reading we have three retained workers; by an honest one, one.

- **Define retained:** an external wallet (claimant, not poster — the
  transparency page's external count classifies by poster and is a different
  metric) with ≥ 2 approved settlements on **distinct source keys** within a
  trailing 30 days. Reissues of one article count once.
- Compute `retainedExternalWorkers30d`, `externalRewardOutlay30d` and
  `costPerRetainedExternalWorker30d` from the session store, and expose them
  on `/admin/status` and the ops board; add the machine-readable fields to
  `/transparency` under `flow` with a `status`/`source`/`proof` triple like
  its neighbours. Make the lane stop-condition a computed boolean next to the
  prose, not a replacement for it.
- **Sampled quality review.** Every Nth approved **benchmark-mode** settlement
  (`QUALITY_SAMPLE_EVERY`, decision: 5) is queued for operator review through
  an admin route; the reviewer records `qualityScore` (0–5) and a note. The
  work receipt (`core/work-receipt.js`) gains `review: { sampled: true|false,
  score?, reviewedAt? }` — `sampled:false` on unsampled receipts so the
  absence is explicit, never implied. The score feeds the wallet's reputation
  aggregate that `/agents/{wallet}` reads, with a weight the operator sets
  (`QUALITY_REVIEW_REPUTATION_WEIGHT`). Human reviewer only in this PR; an
  LLM reviewer is a later decision with its own truth-boundary review.

## Non-negotiables (each pinned by a test; I run the drills)

1. **No literal rewards in ingestion.** A test greps `jobs/ingest-*.js` for
   `rewardAmount: <number>` and fails on any hit. Mutation: reintroduce one — fails.
2. **Class ceiling/floor enforced at ingestion**, refusal named in the summary.
   Mutation: post a benchmark job at 0.40 — refused; remove the check — test fails.
3. **Lane without a consumer is rejected** by `validateCatalogueLaneRegistry`
   and by ingestion. Mutation: delete a `consumer` — fails.
4. **Window only on ≥ threshold jobs.** A 0.10 job carries no `priorityWindow`;
   a 1.0 job does. Mutation: drop the reward check — fails.
5. **Both qualifiers, parity.** A listed wallet with zero deposit and a
   deposited unlisted wallet both pass preflight and the claim gate inside the
   window; an unlisted, undeposited wallet is refused by both with
   `priority_window_active` and the `openAt` time. Mutation: remove the consent
   qualifier from one side only — the parity test fails.
6. **Window opens.** After `openAt`, the same unlisted wallet claims. Mutation:
   never open — fails.
7. **Retained counts distinct sources.** Fixture: wallet A with three
   settlements on one source key, wallet B with two on two keys → retained = 1.
   Mutation: count settlements — fails.
8. **Stop condition computed.** Outlay 60 / retained 2 → `costPerRetained 30`
   and `stopConditionMet: true`. Mutation: hardcode false — fails.
9. **Sampling is exact and explicit.** Five approved benchmark settlements →
   exactly one queued; every receipt carries `review.sampled` as a boolean.
   Mutation: sample none — fails; omit the field — fails.
10. **Score reaches reputation** with the configured weight. Mutation: weight
    ignored — fails.

## Out of scope

Retention (keep), bonds (keep), the auto-decidable verifier set (frozen),
worker credit and locked tiers (unchanged by operator decision), the
review-and-apply consumer for Wikipedia (follow-on), an LLM reviewer (later
decision), the reissue caps (companion packet).

## Handback

Three PR numbers in order; green CI; the ten test names; drill evidence;
the operator-set values as they landed in `deploy/backend.env.template`; one
`/jobs/{id}` read of a ≥ 1.0 job showing the window with both qualifiers; and
after C deploys, the `/admin/status` retained block read by the operator.

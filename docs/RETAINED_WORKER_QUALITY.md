# Retained workers and human quality sampling (packet C)

Authority: packet `687169e9`, following A (#1363) and B (#1364), with the
2026-09-10 operator amendment: weight 20, off-chain only until the reputation
aggregate is cumulative. This PR changes backend, operator board, API schema
documentation and SDK declarations. No contracts, funds, indexer, Caddy,
marketing page, new dependency or secret changes.

## Retained is not a settlement count

`catalogueLanes.retained` on `GET /admin/status` contains
`retainedExternalWorkers30d`, `externalRewardOutlay30d` and
`costPerRetainedExternalWorker30d`. Each lane carries the same fields scoped to
that lane. The ops board renders the lane figures, definition and stop result.
`GET /transparency` exposes the three fields directly under `flow`, with the
existing `value`, `status`, `source`, `proof` and freshness envelope.

A retained worker is an external **claimant wallet**, classified by the shared
self-identity registry, with approved, successful settlements on at least two
distinct source keys in `(now - 30 days, now]`. Global retention deduplicates
wallets across lanes; lane retention requires two sources within that lane.
Outlay is actual USDC `payoutTx.settlement.workerAmountRaw`, excluding self
and canary claimants. It is not nominal posted rewards, poster fees or gas.
Duplicate job settlement rows do not multiply outlay. The neighbouring
transparency poster/source-composition metrics keep their existing meanings.

Source identity comes only from the claim-time snapshot. Wikipedia uses
language/page/revision; GitHub uses repository/issue; OSV uses
ecosystem/package/vulnerable-version/advisory; open data uses
provider/dataset/resource; OpenAPI and standards use provider/spec ID.
Reissue IDs, timestamps, task variants and mutable catalogue text do not make
a new source. An unsupported or missing source pin makes retention/cost
unknown rather than treating every job ID as a new source. Missing payout
evidence makes outlay unknown too. The existing 10,000-session global read
bound fails closed; this is a retained-store observation, not proof of records
that were deleted from the store.

For OSS, `stopConditionMet` compares the exact outlay/retained ratio against
25 USDC, without rounding it before comparison. It is `null` for incomplete
evidence or no denominator, never a fabricated safe `false`. The prose is
retained. Other lanes' qualitative stop rules remain explicitly marked
`operator_evaluation_required`; this packet supplies no machine predicate
for demand supersession. This is an observation, not an automatic budget or
posting-pause mutation. The Wikipedia pause remains in place.

## Human review, not on-chain reputation

Both `deploy/backend.env.template` and its rendered mainnet template carry:

```dotenv
QUALITY_SAMPLE_EVERY=5
QUALITY_REVIEW_REPUTATION_WEIGHT=20
QUALITY_REVIEW_ONCHAIN_ENABLED=false
```

New approved benchmark settlements receive a durable global ordinal; every
fifth is sampled. Rejected, unresolved, failed-payment and other-verifier
sessions do not advance it. Sampling starts with this deployment, without
retroactive judgments on old receipts. The owner-token store lock serializes
assignment and review. An assignment journal makes a retry after a failed
terminal write reuse its ordinal, including across process restarts. A lock
failure is named `quality_review_busy`; it never invents a sampling decision.
The journal is bounded at 100,000 assignments and refuses with
`quality_sampling_capacity` instead of silently resetting; archive migration
must preserve ordinals before that capacity is reached.

Admin routes (admin role, not ops-viewer or worker capabilities):

- `GET /admin/quality-reviews`: config and pending sampled, terminal sessions.
- `POST /admin/quality-reviews`: `{sessionId, qualityScore, note}`. Score must
  be an integer 0–5, and note must contain 1–4000 characters. Reviewer identity
  comes from authentication. Uses existing admin rate limits and mutation
  idempotency. A repeated identical review is idempotent; a different second
  review is refused as `quality_review_already_recorded`.

The session stores `qualityScore` and `qualityReview` (note, reviewer, time,
pinned weight, receipt ID and reliability adjustment). Adjustment per review
is `(score - 3) * weight`: score 5 gives +40, 3 gives 0, 0 gives -60 at weight
20. Weight changes apply to later reviews, not previously recorded reviews.

Every newly emitted work receipt has `review.sampled` explicitly, including
`false` for standalone Verify and unsampled work. A review creates a new
content-addressed receipt with `review.score`, `reviewedAt`, pinned weight,
adjustment and `onchainApplied:false`; `reviewOf` points to the original.
The new receipt is signed when the normal receipt signer is configured.
Original bytes, IDs and verdict-core/chain commitments remain unchanged.
Exact receipt-ID reads stay immutable; session/job aliases, run-receipt reads
and receipt listings discover the reviewed receipt (subject to their existing
short alias caches). Pre-amendment receipts stay valid; consumers must not
infer that a missing legacy review field meant a human reviewed the work.
Notes and reviewer identity are admin/session metadata, not public receipt copy.

Consented directory rows and `GET /agents/{wallet}` expose `qualityAverage`
(mean sampled score, or null when unreviewed), `qualityReviewCount`,
`qualityReliabilityAdjustment` (sum of the pinned deltas),
`qualitySource:offchain_sampled_human_reviews`, and `qualityOnchainApplied:false`.
This is an off-chain sample, not a claim that every submission was reviewed.
Profile history uses the existing bounded wallet-session reader.

`contracts/ReputationSBT.sol:updateReputation` assigns a new ReputationView;
it does not accumulate. Accordingly, the current on-chain skill/reliability/
economic axes, admission tiers, credit and directory ranking remain unchanged.
There is **no** quality-driven gateway call. Setting the on-chain flag to true
fails startup with `quality_reputation_aggregate_not_cumulative`. A future
cumulative aggregate and its own tests are required before enabling that path.
No LLM review or Wikipedia review-and-apply consumer is supplied here.

## Verification and operator handoff

C's four pins:

7. `retention pin: three reissues of one source and two distinct sources retain only one external claimant`
8. `retention pin: outlay sixty divided by two retained is thirty and the OSS stop condition is met`
9. `quality pin: five approved benchmark settlements queue exactly one and every receipt has an explicit sampled boolean`
10. `quality pin: configured weight reaches off-chain wallet quality while session and receipt store the score and chain reputation stays unchanged`

Drills all failed with exit 1 and were restored: count settlement IDs as
sources (2 vs 1 retained), force stop false, sample none, omit receipt.review,
ignore weight (2 vs 40). Additional tests cover exact content-ID preservation,
review-discovering aliases, actual profile/directory routes, restart and
terminal-write retry, concurrent sampling, review authorization and validation.
The real HTTP smoke test checks admin-only review access and shared
status/transparency wiring.

Local browser fixture check: the $60/2 OSS example rendered $30 and stop met;
zero-retained and incomplete examples rendered not-computable/unknown, with
no browser warnings or errors. The preview route is removed, not shipped.
React review kept the board stateless, using the existing fetch and typed
adapter; no new browser request or effect was added.

A/B's six pinned tests and the local >=1 USDC `/jobs/{id}` response are in
their PRs and `LISTED_DEPOSIT_PRIORITY.md`. The existing pricing/window env
values are unchanged by C. After C merges and deploys, **the operator** must
read `/admin/status` and record `catalogueLanes.retained`, per-lane stop
evaluation and `qualityReview` configuration. No production read or deployment
is claimed by this local verification.

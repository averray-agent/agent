# Verifier-class pricing and lane consumers (packet A)

New ingested jobs read their reward from `VERIFIER_CLASS_REWARD_USDC_JSON`.
Defaults and the deploy template set benchmark to 0.10 USDC (ceiling), and
github_pr, deterministic and witness (the existing Verify-backed mode) to
1.00 USDC (floors). This does not add a verifier mode.

Explicit templates outside their class bound are refused, never clamped.
Scheduled live and dry-run summaries name
`verifier_class_reward_out_of_bounds` with the attempted reward and bound.
The class table is validated at startup. Updating it changes new ingestion,
not already-committed on-chain job terms; spec-hash mismatch refusals still
protect those commitments.

Every configured lane must supply a nonempty `consumer`. Removing one fails
configuration validation. Ingestion also refuses a missing consumer or the
explicit sentinel `none` (`lane_consumer_missing` / `lane_consumer_none`).
Wikipedia's benchmark-showcase lane declares `none`: a review-and-apply
consumer does not yet exist. Its #1361 pause stays in place; this change does
not build that consumer or claim proposals have been applied.

The oss-anchored cap remains 15 USDC per rolling 24 hours. At the 1.00 USDC
GitHub floor that is at most 15 jobs before brokered gas; gas is still charged
to the same cap, and backlog and operator-reserve limits still apply. No
budget, waiver, retention, bond, credit, locked-tier or contract changes.

Operator action: include `consumer` in any custom
`CATALOGUE_LANE_REGISTRY_JSON`. The rendered mainnet template carries the
new fields and pricing table. No new secrets or VPS commands are required.

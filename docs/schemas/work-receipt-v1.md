# Averray Work Receipt v1

The work receipt is the portable record for one claimed and submitted run. It
extends the existing run-verdict receipt with the claim-time intent, execution
evidence, explicit worker consequence, and a fully reconcilable settlement.
It makes no claim about work outside that run and does not itself award
reputation.

Canonical JSON is served at `GET /receipts/:receiptId`. The permanent
`GET /badges/:sessionId/run` alias resolves to the work receipt for newly
emitted or successfully backfilled sessions. The public reader is
`https://averray.com/receipts/:receiptId`.

## Content address and signature

`receiptId` is SHA-256 over canonical JSON after removing the root
`receiptId`, `canonicalUrl`, `signers`, and `signature` properties. The first
two are self-references; the latter two attest the already-addressed content
and therefore cannot influence its identity. Any mutation to intent,
execution, verdict, settlement, timestamps, or compatibility aliases changes
the id.

The detached ES256 signature still covers the complete unsigned document
(everything except `signature`), including `receiptId`, `canonicalUrl`, and
`signers`. Verification uses key `badge-1` from
`/.well-known/badge-receipt-jwks.json` and the canonicalization procedure in
[`agent-badge-v1.md`](agent-badge-v1.md#exact-canonicalization-and-signing-bytes).

## Accounting

`intent.valueAtRisk` is the reward pinned at claim. In settlement,
`pinnedRewardAmountRaw == workerAmountRaw + gasRetentionAmountRaw`.
Because the protocol fee is poster-side additive,
`rewardAmountRaw == workerAmountRaw + gasRetentionAmountRaw +
protocolFeeAmountRaw` records the total poster value settled. Keeping both
fields avoids mislabelling the protocol fee as a worker deduction.

Historical rows are backfilled only when the persisted claim snapshot and
verification evidence are sufficient. Missing evidence is reported and never
invented. A historical snapshot without recorded claim-time chain-read
provenance is conservatively marked `chain_unavailable_fail_open`.

The normative JSON shape is [`work-receipt-v1.json`](work-receipt-v1.json).

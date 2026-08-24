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
execution, verdict, chain binding, settlement, timestamps, or compatibility
aliases changes the id.

The detached ES256 signature still covers the complete unsigned document
(everything except `signature`), including `receiptId`, `canonicalUrl`, and
`signers`. Verification uses key `badge-1` from
`/.well-known/badge-receipt-jwks.json` and the canonicalization procedure in
[`agent-badge-v1.md`](agent-badge-v1.md#exact-canonicalization-and-signing-bytes).

## Accounting

`intent.valueAtRisk` and `settlement.rewardAmount` are the same worker-facing
reward pinned at claim. Settlement enforces both accounting boundaries:

```text
rewardAmountRaw == workerAmountRaw + gasRetentionAmountRaw
posterTotalAmountRaw == rewardAmountRaw + protocolFeeAmountRaw
intent.valueAtRisk.amountRaw == rewardAmountRaw
```

`posterTotalAmount` is separately qualified because the protocol fee is
poster-side additive. This keeps the conventional unqualified `reward` meaning
and avoids presenting the poster fee as a worker deduction.

Historical rows are backfilled only when the persisted claim snapshot and
verification evidence are sufficient. Missing evidence is reported and never
invented. A historical snapshot without recorded claim-time chain-read
provenance is conservatively marked `chain_unavailable_fail_open`.

The normative JSON shape is [`work-receipt-v1.json`](work-receipt-v1.json).

## Version freeze

The `averray.work-receipt.v1` stored field set was frozen on 2026-08-24.
The one ratified additive exception is the optional `chainBinding` section
authorized by
[`MEMO_ESCROW_RECEIPT_BINDING.md`](../MEMO_ESCROW_RECEIPT_BINDING.md#decision-points),
E3. Receipts issued before this amendment lack the section and remain
byte-stable; newly settled receipts include it inside their hashed content.
This explicit amendment authorizes no other v1 stored-field addition. Future
consumer conveniences are serve-time presentation decorations, or they ship
under a new `schemaVersion`; they are never added silently to a stored v1
document.

## Presentation aliases

Decorated API responses expose `buyer` as the consumer-facing alias of
`intent.poster`. For job receipts that is the funding poster; for standalone
Verify receipts it is the paying customer. `buyer` is computed only while
serving the document: it is not a stored v1 field and does not alter the
content address or signature.

## Commitment (verdict core)

The escrow-consumable verdict core is exactly these three root sections, in
this order:

```json
["intent", "execution", "verdict"]
```

The slice is hashed with the same canonical JSON and SHA-256 procedure used by
the work receipt content address. Root settlement evidence, compatibility
identities outside the committed sections, signer attestations, signatures,
and self-references are excluded. Identity values inside `intent` or
`execution` remain part of the commitment because those complete sections are
committed.

Settlement is necessarily excluded: an approved receipt's settlement cannot
exist before the release transaction that consumes this commitment. The
binding therefore commits the verdict core before release and closes afterward
through the completed receipt's settlement evidence. The decision and its
rationale are recorded in
[`MEMO_ESCROW_RECEIPT_BINDING.md`](../MEMO_ESCROW_RECEIPT_BINDING.md#decision-points),
E1 and E8.

For newly settled receipts, `chainBinding.committedVerdictHash` reproduces this
slice, while `verifiedTxHash` and `logIndex` locate the exact `Verified` event
that consumed it. This public replay is described as **receipt-keyed,
operator-verified**: the event is independently checkable, while release
authority remains with the registered verifier.

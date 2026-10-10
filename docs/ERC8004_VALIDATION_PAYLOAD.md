# E2 — offline validation evidence payload

2026-10-10; follows [E1](ERC8004_READ_ONLY_SPIKE.md). Builder only: no
registration, RPC, transaction, signer, publishing, scheduler, endpoint, or MCP
tool. E3 remains deferred. This is not an ERC-8004 identity registration or an
on-chain validation response, and does not imply that a wallet owns an agent ID.

## Contract and score mapping

`buildErc8004ValidationPayload(receipt)` accepts an
`averray.work-receipt.v1` run document or the served
`averray.receipt-envelope.v1` wrapper. It returns an
`averray.erc8004-validation-payload.v1` offline draft. It never modifies input.

| Recorded evidence | score | status / reason |
|---|---|---|
| approved, verification timestamp, nonzero settlement transaction hash | 100 | reported / recorded_approved |
| rejected, verification timestamp | 0 | reported / recorded_rejected |
| inconclusive | null | not reported / inconclusive |
| platform_fault | null | not reported / platform_fault |
| missing/unknown verdict | null | not reported / verdict_not_reported |
| missing/invalid verification timestamp | null | not reported / verification_time_not_reported |
| approved without a nonzero settlement transaction hash | null | not reported / settlement_not_reported |

This binary mapping describes **one recorded verifier verdict**, not work
quality, a person, a probability, an aggregate reputation, or independently
checked finality. No intermediate score is invented. A recorded rejection is
measured zero; unknown evidence is never zero. The builder verifies content
addressing but does not verify the receipt's signature, upstream merge, or live
chain state. A transaction-shaped string alone does not prove settlement.

The [ERC-8004 draft validation interface](https://eips.ethereum.org/EIPS/eip-8004#validation-registry)
uses a 0–100 response associated with an existing request. A future, separately
authorized adapter could map `score` to `response`, `evidenceURI` to
`responseURI`, and `evidenceHash` to `responseHash`, with the tag
`averray-recorded-verdict-v1`. This builder intentionally supplies **no
requestHash**: the ERC request commitment is Keccak-256 of the request payload,
not Averray's receipt content hash. It must not be inferred from a wallet or
receipt ID. The designated validator, agent identity, chain/registry, authority
and actual request must be established separately before E3.

## Evidence bytes and truth boundary

`evidenceURI` is always `https://api.averray.com/receipts/<receiptId>`.
`evidenceHash` is the existing `hashWorkReceiptContent(document)` SHA-256
commitment, reproduced and checked against `receiptId`. Its canonical projection
excludes `receiptId`, `canonicalUrl`, `signers`, and `signature`. The unsigned
presentation envelope, HTML and HTTP response formatting are not evidence bytes.
This follows the receipt's existing content-addressing rule, not a hash of the
entire downloaded file. A future publisher must preserve this documented hash
semantics rather than silently substituting a request/file hash.

Every result carries `publication.enabled: false`, with `publishing_deferred`
and `signature_and_live_evidence_not_checked`. Non-chain-verified spec evidence
is explicit; `chain_unavailable_fail_open` is named, never upgraded. For GitHub
receipts predating the 2026-10-08 07:21Z merged-only rule, a conservative
`github_pr_pre_merged_only_rule` blocker applies. This blocks more than just the
five known pre-rule unmerged payouts; it does not classify every older payout
as unmerged. Even a synthetic chain-verified, post-rule receipt cannot enable
publishing. These fields record limitations, not a substitute for E3's gates.

## Real fixture and consumers

The fixture `mcp-server/src/core/fixtures/passtas-work-receipt-2026-10-08.json`
is the public envelope read on 2026-10-10 from
[the passtas receipt](https://api.averray.com/receipts/0x91290e62a98c6d6c006a82a87893787e7cc681c55d1bd5bcc6e854864d448e7b).
Its job is `pr-passtas-matterbridge-elgato-4`, settled in transaction
`0x24717ca2384f75f7cfab8703bde0e71289933ee889dd7e8b8ecce4ffb8054427`.
The original signed fields are preserved. It records an approved verdict but
also `chain_unavailable_fail_open` and a pre-rule timestamp: the test pins both
the recorded score and the publication blockers. Synthetic variants are
explicitly unsigned/rehashed fixtures, not additional live observations.

Consumer sweep: no existing HTTP/MCP response, default, enum, SDK or manifest
changes. The only new consumer is the colocated builder test; both bare-document
and actual served-envelope inputs are covered, and the legacy run-receipt shape
is refused. There is no app, SDK, packages, ops/workflow, discovery or marketing
integration in E2. Canonical receipt hashing is reused unchanged.

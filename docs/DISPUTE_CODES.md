# Dispute Reason Codes

This document is the off-chain reason-code registry for dispute and rejection
receipts. `EscrowCore` accepts freeform `bytes32 reasonCode` values, so the
contract does not enforce this registry. Backend services, the indexer, and
operator UI should use this table to keep the public trail legible.

## Encoding

Reason codes are ASCII strings encoded into Solidity `bytes32`, for example:

```solidity
bytes32("DISPUTE_LOST")
```

Unknown codes are valid on-chain, but indexers and UI should normalize them to
`REASON_UNKNOWN` for display while preserving the raw `bytes32`.

## Registry

| Code | Meaning | Typical payout | Stake result | Notes |
|---|---|---:|---|---|
| `REJECTED` | Initial verifier rejection before dispute. | `0` | Still locked during dispute window. Slashed only if finalized without dispute. | Already defined in `EscrowCore`. |
| `DISPUTE_LOST` | Arbitrator upheld the verifier; worker loses dispute. | `0` | Claim stake slashed 50/50 poster/treasury. | Already defined in `EscrowCore`. |
| `DISPUTE_OVERTURNED` | Arbitrator overturned the verifier; worker wins dispute. | Full remaining payout | Claim stake returned. | Convention; not contract-restricted. |
| `DISPUTE_PARTIAL` | Arbitrator awarded a partial outcome. | Partial payout | Claim stake returned under current `resolveDispute` behavior when payout is greater than zero. | Convention; use sparingly and document rationale in `metadataURI`. |
| `ARB_TIMEOUT` | Arbitration SLA missed; dispute auto-resolved in worker's favor. | Full remaining payout | Claim stake returned. | Convention for `autoResolveOnTimeout`. |
| `MUTUAL_RELEASE` | Parties agreed to close or release without ordinary dispute loss. | Negotiated | Depends on settlement path. | Convention; expected to remain off-chain until a dedicated path exists. |

## Current Contract Behavior

Current `EscrowCore.resolveDispute(jobId, workerPayout, reasonCode, metadataURI)`
uses payout amount as the settlement branch:

- `workerPayout > 0`: worker receives payout, claim stake is returned, and a
  badge is minted.
- `workerPayout == 0`: worker loses, claim stake is slashed, reputation is
  penalized with dispute-loss policy values, and `JobRejected(jobId,
  reasonCode)` is emitted.

That means `reasonCode` is descriptive today, not a policy switch. Contract
changes that add `autoResolveOnTimeout`, mutual release, or richer partial
settlement must document whether they keep or change that branch behavior.

## Indexer Guidance

Indexer and API surfaces should expose both:

- `reasonCodeRaw`: original 32-byte value.
- `reasonCodeLabel`: normalized label from this registry, or
  `REASON_UNKNOWN`.

This keeps future codes backwards-compatible without losing audit detail.

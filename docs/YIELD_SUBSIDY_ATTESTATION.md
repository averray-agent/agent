# Yield attribution and subsidy evidence

Public `GET /pool` separates its unchanged cumulative marked NAV gain into:

- `gain.venueEarned`: the named-block adapter mark minus venue principal cost basis;
- `gain.operatorAdded`: verified entries in the operator-attested subsidy ledger;
- `gain.unattributed`: the signed residual, never silently credited to the venue.

The three raw amounts sum to `gain.cumulativeNav`. The residual can be negative
when losses offset a contribution. Realized historical venue gains no longer
present in the adapter mark are also unattributed unless separately evidenced;
this is not an all-time venue-performance claim. The wallet approximation uses
the same three-way pool ratio, not a claim of holding-period provenance.

## Admin evidence input

`POST /admin/deposit-pool/subsidies` retains the existing
`admin:yield-subsidy:attest` capability. This endpoint records evidence; it does
not send funds. No public read is an authorization to attest.

The EVM request remains `{ "txHash": "0x…" }`, with unchanged receipt and ERC-20
calldata verification.

For an Asset Hub transfer, use:

```json
{
  "extrinsicHash": "0x272c0fb89deeb10635a8be9b19876a4a82ffe5f4f470de953c8bc5549947b052",
  "blockNumber": 20421344
}
```

The block number is an untrusted locator, not proof. Standard Substrate RPC
does not resolve an arbitrary extrinsic hash to its block; this interface avoids
an unbounded history scan. The reader finds the exact hash in that block,
checks finality and execution success, and reads events and timestamp at its
block hash. Events from neighboring extrinsics cannot supply any proof.

Only one unambiguous `assets.Transferred` of asset `1337` to the configured
pool's AccountId32 is accepted. The recipient is derived using the shared
H160-to-SS58/AccountId32 implementation (the twelve-`0xEE` suffix), never a fixed
SS58 address. Amount and sender come from the event. Operator amount, recipient,
and mixed EVM/Substrate locator fields are refused by the HTTP route.

The reader reuses `BANK_XCM_ASSET_HUB_SUBSTRATE_RPC_URL` and the shared lazy
Substrate connection; no environment change or startup connection is needed.
Reads time out after at most 15 seconds. Unreadable evidence is never attested.
The existing hash-keyed append-only ledger remains idempotent. Substrate entries
expose `verification.method: substrate_extrinsic`, block hash, extrinsic index
and event index; existing EVM response shapes remain unchanged.

Named refusals use the `yield_subsidy_extrinsic_` prefix: `reader_unconfigured`,
`wrong_chain_or_asset`, `read_timeout`, `unreadable`, `block_mismatch`,
`not_finalized`, `not_found`, `failed`, `transfer_missing`, `wrong_asset`,
`wrong_recipient`, `ambiguous_transfer`, `zero_amount`, `timestamp_unreadable`.
Malformed inputs remain `invalid_request`; conflicting persisted proof remains
`yield_subsidy_attestation_conflict`.

This ledger remains operator-attested, not an exhaustive chain-derived transfer
ledger. No amount is attributed to the operator until an authorized attestation
has actually been recorded.

# Mainnet contract provenance

Status: independently reproducible evidence for the audit delta. This document does not
authorize a contract deployment or opening `EXTERNAL_POSTING_MODE`.

## Result

The six contracts recorded in `deployments/mainnet.json` reproduce from commit
`ccaa11124f0bda8e03819ead0798356131ed8c0f` (`fix(contracts): restore waiver slot on claim
timeout (#739)`). The audit tag `audit/mainnet-2026-07-07` at `fd9b306` and the checkout
present when the deployment was made, `4f3fb9f`, are descendants with the same contract
tree. Building any of those three points with its own checked-in `foundry.toml` produces the
same six runtime artifacts.

This corrects the earlier drift hypothesis that the live suite predated #688. It does not:

- The proposed pre-#688 candidate `4f8cf277` builds a 15,742-byte AgentAccountCore, while
  mainnet holds 17,304 bytes.
- The deployed AgentAccountCore matches `ccaa111` after all 22 compiler-declared immutable
  slots are masked: 440 differing bytes, exactly 20 bytes in every slot and zero bytes
  outside them.
- The commit immediately before the matching contract boundary, `d516e55`, builds a
  21,748-byte EscrowCore, while mainnet holds 21,800 bytes. #739 is therefore the first
  matching contract-tree boundary.

There is no funds-holding-unknown-code condition. AgentAccountCore has a complete historical
source match.

## Verification method and evidence

The candidate was compiled with Solidity 0.8.24, optimizer enabled with 200 runs, and
`via_ir=true`, read from the candidate commit's own `foundry.toml`.
Each manifest `abiHash` is SHA-256 of the UTF-8 minified artifact ABI
(`JSON.stringify(artifact.abi)`); each `runtimeCodeHash` is SHA-256 of the raw bytes returned
by `eth_getCode`, not of its hexadecimal text representation.

For every artifact:

1. Decode the candidate `deployedBytecode.object` and live `eth_getCode` into bytes and
   require equal lengths.
2. Flatten the exact byte ranges in
   `deployedBytecode.immutableReferences`.
3. Record every raw differing byte and its containing immutable slot.
4. Zero the same immutable ranges in both byte arrays and compare SHA-256.
5. Require identical masked SHA-256 values and independently require zero differences
   outside the declared ranges.

This is the EscrowCore-v2 Phase-1 method: immutable values may differ, but code differences
cannot escape the compiler-declared slots. In this deployment every address-valued
immutable contributes 20 differing bytes within its 32-byte slot.

| Contract | Address | Runtime SHA-256 | ABI SHA-256 | Immutable slots / diff bytes / outside | Masked runtime SHA-256 |
|---|---|---|---|---:|---|
| TreasuryPolicy | `0x226F14252A98BD2eA140271647De20132F09AF20` | `7f402ba040b04fc6f413d0b0105e288d97373413b9fb2aa871c5946eea8f441b` | `c99049e4add133b60babc355ca5bfb42e3e7807c13c5d66b59ebde9bf8e46822` | 0 / 0 / 0 | `7f402ba040b04fc6f413d0b0105e288d97373413b9fb2aa871c5946eea8f441b` |
| StrategyAdapterRegistry | `0x38af424415c1CE033e5Cee01f94551CDb824D404` | `7c2b6bb6b43889db08b5dfd23427d28aec2b7156e38c90d5d53002675b402df9` | `f2d0cc926387a757249688e5e315d2755f9de44cbda85668c74ae30f9ddd9846` | 4 / 80 / 0 | `9327a1a360416c74aea3f67726f29c15bd1d4c569d1fc1145650669afe526444` |
| AgentAccountCore | `0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57` | `4b97dd8c42dfef86020a2b89e768048f99a301647965c64a7281ae8c889a00eb` | `795e3e55cafb8134765b5afbb7bef6817b9213c51fb34612ba4801620739a7e5` | 22 / 440 / 0 | `21f3c76c871d8f939bce541104de7e78a9d76ec5119f999a5473a7f93fe5f84b` |
| ReputationSBT | `0xA85AF867b5f573176f49F0D6A827F61A5Cee4e37` | `c65295d2a8297e1512deeb51258206097e8d9a2843f1cf5d3aea0a7d83b5e493` | `29b6eb596741a1dea957da2c48c1a26e56aeeac5c9a732eae04c64dbab1a0192` | 4 / 80 / 0 | `02b3a51763c5e376be678ba9a142e8d497975d64f76db2ad55ecb9b08b2fcff5` |
| DiscoveryRegistry | `0x47876D138e3a26c485A5f8acbAC7AEcA3c7e6C62` | `634fcc8b29ca8fea61a43d8f1a01f7fd5a973bd4a423a32041cca65f5cf2ea08` | `4b789cb848e8ea13efc37fdef88a4e0ba85de14366c1e3a1c55fb44d54c1dd99` | 0 / 0 / 0 | `634fcc8b29ca8fea61a43d8f1a01f7fd5a973bd4a423a32041cca65f5cf2ea08` |
| EscrowCore v1 | `0x9cCd1DbBB5C354CC6218e55D3cE924A4d631C035` | `f4790b2c80c423aa9c8c4fe55033891b68d7aff6891905f243051e21b1722535` | `af896ebc7901695956984d3382e155239de097a40684531a82e8b71a30a208c7` | 37 / 740 / 0 | `3ef26e203e4d46623da4dc4f07c9c2b6f20a2c6ee1fc5f32626aba2489d70453` |

Both RPCs in the manifest returned chain ID `420420419` and identical raw runtime hashes on
2026-07-29:

- `https://services.polkadothub-rpc.com/mainnet/`
- `https://eth-rpc.polkadot.io/`

The event declaration used as the test vector is
`ReservationSettled(bytes32 indexed settlementId, address indexed account, address indexed
recipient, address asset, uint256 amount)`. Its canonical type signature is
`ReservationSettled(bytes32,address,address,address,uint256)`, whose topic0 is
`0x3cdc0be5ec7141f2342208f6404c1b1852936343f0edf1fda179e6c9f46573ee`.
The leading field is `settlementId`, not `jobId`; the guard checks the field names, types,
and indexing as well as the canonical type signature.
A read-only query from the AgentAccountCore deployment block returned 24 matching live logs;
the first was in block `0x11cb674`, transaction
`0x25fa6cd445cabaee33b577f77823b1346ed7b6f69c93cd9c5682c814223ef06e`.

## ReservationSettled consumer audit

The audit also checked whether a source/deployment ABI mismatch could make an operational
consumer silently read zero payout events:

| Consumer | How it obtains payout evidence | Source-derived `ReservationSettled` ABI? | Finding |
|---|---|---:|---|
| Indexer | Subscribes to manually declared `EscrowCore.JobClosed` and writes its payout row from that event | No | It does not subscribe to `AgentAccountCore.ReservationSettled`; the manual `AgentAccountCoreAbi` contains stake events only. |
| Hermes monitor payout probe | Calls raw `eth_getLogs` against AgentAccountCore with the fixed live-derived `0x3cdc…` topic, then decodes the two non-indexed data words | No | Operational filtering is correct at audited monitor commit `6f8a9625d392f8b6ac351f98ea369fdbee167fb7`. Comments in `product-health.ts` and `ops/compose.yml` still call the first indexed field `jobId`; that is a separate documentation defect and does not affect its raw topic/data logic. |
| Ops scripts | Existing scripts use manually declared ABIs for functions or EscrowCore events; the new provenance checker reads raw `eth_getCode` | No | No existing ops script consumes `ReservationSettled`. Source-verification mode reads the candidate artifact ABI only to validate its provenance and exact event declaration; it does not use that ABI to query logs. |

At the audited `origin/main` base `c622d2fc107dab97cd13c10dc5274d6411bdfc43`,
`contracts/AgentAccountCore.sol` already declares and emits the five-field event shown above.
The topic
`0xd499b2dbfb7f7f490712fae30398f35b2ccd648617685497e7f68bc74def9665`
belongs to the historical four-field
`ReservationSettled(address,address,address,uint256)` declaration, which has no leading
settlement identifier. It is therefore not accurate to describe current main's Solidity as
the four-field variant, and none of the audited consumers is currently deriving the payout
filter from that historical declaration.

## Unshipped contract changes

Exactly one commit after `ccaa111` changes Solidity:

- `775a826b0a33d0ec04dd19f0455e69402dc9bbcd` — EscrowCore-v2 success-path protocol fees
  (#850). It adds the owner-governed fee and treasury destination, per-job fee snapshots,
  fee-waived operator creation, two-leg worker/treasury settlement, cumulative milestone
  rounding, refund accounting, and `SettlementSplit`. It changes only EscrowCore; the
  migration explicitly leaves AgentAccountCore unchanged.

That delta is deliberately not deployed. The active address remains EscrowCore v1, and the
separate v2 migration runbook keeps `EXTERNAL_POSTING_MODE=closed` through audit,
deployment, dual-address drain, and dogfood proof.

## Reproduction and drift guard

Create a detached candidate worktree, build it under its own configuration, then run both
the raw-chain guard and the masked source check:

```sh
git worktree add --detach /tmp/averray-provenance-ccaa111 \
  ccaa11124f0bda8e03819ead0798356131ed8c0f
git -C /tmp/averray-provenance-ccaa111 forge build --skip test

npm run check:contract-provenance
node scripts/ops/check-contract-provenance.mjs \
  --profile mainnet \
  --artifacts /tmp/averray-provenance-ccaa111/out
```

`check-contract-provenance.mjs` recomputes raw SHA-256 from live `eth_getCode` and exits
nonzero on an empty runtime, wrong chain, missing manifest record, or hash drift.
`verify_deployment.sh` invokes it automatically whenever the selected manifest contains
`contractProvenance`, so normal deployment verification cannot silently accept changed
runtime code.

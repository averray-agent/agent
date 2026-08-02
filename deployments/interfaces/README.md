# Frozen deployed contract interfaces

These files describe deployed bytecode, not whichever contract source happens to be at
`HEAD`. Consumers that decode historical or live traffic should select an interface by
chain ID and address.

## Polkadot Hub mainnet EscrowCore v2

- Interface: [`mainnet-escrow-core-v2.json`](./mainnet-escrow-core-v2.json)
- Chain ID: `420420419`
- Address: `0x590EbE304E0C7672e2abF3161177D2B94a2aC3fC`
- Deployment block: `18809168`
- Deploy transaction:
  `0xc4d6d442824bec61f8ca99646022b66776af88406a56f8c3da67e338610d132b`
- Source commit: `775a826b0a33d0ec04dd19f0455e69402dc9bbcd`
- Source path: `contracts/EscrowCore.sol`

The source still exists. Its `EscrowCore.sol` Git blob is
`b44210b69c842ad77482b99d7f09590617dd8898`; that is also the blob at the current
source path when this interface was frozen. The committed ABI hashes to the `abiHash`
recorded for this address in `deployments/mainnet.json`, and the source-built runtime
matches the deployed runtime after masking the compiler-declared immutable slots.

The four previously unidentified live selectors are:

| Selector | Canonical signature |
|---|---|
| `0xbcb2689a` | `createSinglePayoutJobFeeWaived(bytes32,address,uint256,uint256,uint256,uint256,bytes32,bytes32,bytes32)` |
| `0x090cf6d5` | `claimJobFor(bytes32,address)` |
| `0x1b2ef921` | `submitWorkFor(bytes32,address,bytes32)` |
| `0xcca2acd6` | `setOnboardingWaiverEligible(bytes32,bool)` |

Fee-free behavior is explicit, not inferred from a missing transfer. Curated
starter/onboarding jobs may use the operator-only `createSinglePayoutJobFeeWaived` path,
which snapshots `protocolFeeBps` as zero and reserves no protocol fee. This is not a blanket
exemption for every self-posted job: ordinary `createSinglePayoutJob` and milestone jobs
snapshot the live fee, while recurring jobs carry an explicit `protocolFeeWaived` field.

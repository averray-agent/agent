# Bank phase 1: XcmWrapper v2 deployment ceremony

Status: **prepared, not executed**. This packet deploys no contract, signs no
extrinsic, grants no role, changes no environment, and moves no asset. Claude
gates the packet; Pascal separately authorizes and signs the ceremony.

The authoritative design is [XCM_WRAPPER_V2_DESIGN.md](./XCM_WRAPPER_V2_DESIGN.md).
The gate order comes from [BANK_PHASE1_BUILD_PACKET.md](./BANK_PHASE1_BUILD_PACKET.md)
§6. This runbook is the gate-4 deployment ceremony only.

## Fixed mainnet inputs

All addresses below are read from `deployments/mainnet.json` by the scripts and
rechecked on chain. They are printed here for human review, not used as a second
configuration source.

| Input | Reviewed value |
|---|---|
| Chain | Polkadot Asset Hub, `420420419` |
| TreasuryPolicy | `0x226F14252A98BD2eA140271647De20132F09AF20` |
| owner | `0x01E6eed856e989201F4FF6346E18EAb7e46C874C` (2-of-3 multisig) |
| USDC | `0x0000053900000000000000000000000001200000` (asset 1337, 6 dp) |
| immutable future AAC binding | `0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57` |
| backend operator / strategy settler | `0x5a6836c6D4d293F6E5377E6c28054F4171915813` |
| strategy id | `bytes32("HYDRATION_USDC_V1")` = `0x485944524154494f4e5f555344435f5631000000000000000000000000000000` |
| XCM precompile | `0x00000000000000000000000000000000000A0000` |
| Hydration | para 2034; USDC 22; aUSDC 1003 |
| Router | pallet 235 (`0xeb`), `sell` call 0 |
| aUSDC ERC-20 | `0x2ec4884088d84e5c2970a034732e5209b0acfa93` |

The deploy EOA is the existing ceremony admin
`0x9Ab8531FBb0948C542a31298FD61335f30064239`. Neither new contract derives
authority from the deployer: both bind the live TreasuryPolicy, and wrapper
configuration is owner-only. The script binds both CREATE predictions to this
address and its pending nonce.

### Read-only candidate observed while preparing this packet

At source commit `767d894fe8ef3263d7806165a3b02bce9cda8142` the pending
deployer nonce was 1, producing this **provisional preview**:

| Contract | Predicted address | nonce | creation-code SHA-256 | ABI SHA-256 |
|---|---|---:|---|---|
| XcmWrapperV2 | `0xc846eE73e49A748e59C7Ac8f8742F542a552D24C` | 1 | `sha256:07b47ee875c6e610aff225c664146521d5a6d83363a5727f8ea3635e94ca2a11` | `sha256:2d4c1458b4016fd38ba77af4aaf78a64daabd60b1f1a7a72d7c17f4fc90516a3` |
| HydrationUsdcAdapter | `0x5eaF58a3e2819A26B66822529aD92fcec107cc98` | 2 | `sha256:ab50c3f08862b942d20bf09d0deb7e15f8d52922e4c93b7004ba0b78716218d7` | `sha256:dbd3823b40f66873ddba6ac005a2d6a7f74d372af58090d65a42934468aea13c` |

The preview is not an authorization to use those addresses. Re-run immediately
before the ceremony. Any nonce, artifact hash, constructor, or predicted-address
change invalidates every downstream preview and requires Claude to re-gate the
fresh output.

The read-only estimate was 3.8152096 DOT and the 20% headroom requirement was
4.57825152 DOT. The deployer held only 1.8360072 DOT. **Deployment is currently
funding-blocked.** Fund only after a separate explicit authorization, then rerun
the estimator; the commit path refuses a balance below the fresh estimate plus
20%.

## 1. Build and deploy locally paused

Use a fresh checkout of the gated merge commit. Confirm that the two contract
sources are unchanged from the reviewed implementation, then build:

```sh
forge build --skip test
forge test
node scripts/ops/deploy-bank-xcm-v2.mjs \
  --profile mainnet \
  --expected-deployer 0x9Ab8531FBb0948C542a31298FD61335f30064239 \
  --bundle-out /tmp/bank-xcm-v2-plan.json
```

The output includes the full creation calldata for both contracts, constructor
arguments, byte counts, artifact hashes, estimates, pending nonce, and predicted
CREATE addresses. The bundle is create-only. Review it before adding `--commit`.

After Pascal authorizes deployment, the only permitted commit form is:

```sh
node scripts/ops/deploy-bank-xcm-v2.mjs \
  --profile mainnet \
  --expected-deployer 0x9Ab8531FBb0948C542a31298FD61335f30064239 \
  --source-commit FULL_40_CHARACTER_GATED_COMMIT \
  --signer-secret-ref 'op://mainnet-critical/admin-eoa-mainnet/credential' \
  --commit
```

The script reads the key concealed, checks its derived public address, asks for
an exact confirmation containing both predicted addresses, sends wrapper nonce
N then adapter nonce N+1, and verifies:

- wrapper `policy`, default XCM precompile, bytecode, and predicted address;
- wrapper `dispatchPaused == true`, `operator == address(0)`, and converted
  account is zero;
- adapter `policy`, USDC, strategy id, wrapper, and existing AAC immutables;
- no role or configuration call was sent.

Stop if either receipt is not successful or any postcondition differs. A first
deployment followed by a failed second is an incident; do not retry with a new
nonce or alternate constructor.

## 2. Fresh wrapper-origin conversion (two endpoints)

Do not reuse the provisional conversion below. After the deployment receipt,
derive the deployed wrapper's Asset-Hub native origin as
`lowercase(wrapper H160) || 0xEE × 12`, then call Hydration's live
`LocationToAccountApi.convert_location` through two independent endpoints:

```sh
node scripts/ops/capture-hydration-wrapper-origin.mjs \
  --wrapper 0xDEPLOYED_WRAPPER \
  --out /tmp/bank-xcm-v2-conversion.json
```

The tool uses:

- `wss://hydration-rpc.n.dwellir.com`; and
- `wss://rpc.hydradx.cloud`.

It writes only when both endpoints identify Hydration and return the same
AccountId32 for `V4{parents:1, X2[Parachain(1000), AccountId32(wrapper-image)]}`.
An endpoint failure, genesis difference, `None`, or account mismatch is a hard
stop.

For tooling validation only, the provisional wrapper preview derived:

- Asset Hub image:
  `0xc846ee73e49a748e59c7ac8f8742f542a552d24ceeeeeeeeeeeeeeeeeeeeeeee`;
- Hydration AccountId32 (both endpoints):
  `0x98f0033e26aa4ecf2899e6d09237d40d29fcb68e64d22a621520bde1123564ac`;
- observer H160 (`truncate20`):
  `0x98f0033E26AA4ecf2899e6D09237d40d29FCB68E`.

These values become invalid if the deployer nonce changes.

## 3. Multisig configuration while paused

The first owner ceremony contains exactly four EVM calls:

1. `XcmWrapperV2.setHydrationAccountId32(freshConvertedAccount)`;
2. `XcmWrapperV2.setOperator(backendSigner)`;
3. `XcmWrapperV2.setStrategyAdapter(HYDRATION_USDC_V1, adapter)`;
4. `TreasuryPolicy.setStrategySettler(backendSigner, true)`.

It deliberately does **not** contain `setDispatchPaused(false)`. Emit the Nova
first leg using live deployed addresses and the fresh conversion evidence:

```sh
node scripts/ops/prepare-bank-xcm-v2-multisig.mjs \
  --profile mainnet \
  --packet configure \
  --wrapper 0xDEPLOYED_WRAPPER \
  --adapter 0xDEPLOYED_ADAPTER \
  --converted-account 0xFRESH_CONVERTED_ACCOUNT_ID32 \
  --conversion-evidence /tmp/bank-xcm-v2-conversion.json \
  --messages-out /tmp/bank-xcm-v2-messages.json \
  --signer nova \
  --ws wss://asset-hub-polkadot-rpc.n.dwellir.com
```

The emitter independently proves the verified 2-of-3 record derives the live
TreasuryPolicy owner, the endpoint is Polkadot Asset Hub, and revive pallet 90
encoded every call. It prints:

- each labeled `to`, value 0, and EVM calldata;
- ordered `otherSignatories` from AccountId32 byte order;
- the `utility.batchAll` SCALE, blake2 call hash, and first-leg `asMulti` SCALE;
- a profile-bound Apps URL usable by Nova Spektr/Apps;
- the four exact XCM messages and observer targets.

Pascal chooses the two devices. Leg 2 must use a different signer and the
`multisig.NewMultisig` height/index:

```sh
node scripts/ops/prepare-bank-xcm-v2-multisig.mjs \
  --profile mainnet --packet configure \
  --wrapper 0xDEPLOYED_WRAPPER --adapter 0xDEPLOYED_ADAPTER \
  --converted-account 0xFRESH_CONVERTED_ACCOUNT_ID32 \
  --conversion-evidence /tmp/bank-xcm-v2-conversion.json \
  --signer vault \
  --timepoint-height FIRST_LEG_BLOCK \
  --timepoint-index FIRST_LEG_EXTRINSIC_INDEX \
  --ws wss://asset-hub-polkadot-rpc.n.dwellir.com
```

Before either signature, compare the second emission's inner call hash with the
first. After `MultisigExecuted`, require inner dispatch `Ok` and read all four
configured values plus `dispatchPaused == true` from chain.

### Provisional Nova packet (review aid only)

For the nonce-1 preview above, the four inner calldatas are:

```text
wrapper  0xbd595e8798f0033e26aa4ecf2899e6d09237d40d29fcb68e64d22a621520bde1123564ac
wrapper  0xb3ab15fb0000000000000000000000005a6836c6d4d293f6e5377e6c28054f4171915813
wrapper  0xeda96b66485944524154494f4e5f555344435f56310000000000000000000000000000000000000000000000000000005eaf58a3e2819a26b66822529ad92fcec107cc98
policy   0xe2ffa57d0000000000000000000000005a6836c6d4d293f6e5377e6c28054f41719158130000000000000000000000000000000000000000000000000000000000000001
```

The provisional `utility.batchAll` call hash is
`0xfb6a9c8cdcc8ac98ef91de5fd9611a33a2c4290809a009c6d3414100df786e07`.
It is invalid on any address/nonce/conversion change.

## 4. Observer targets and exact-message dry-runs

Configure the venue-agnostic observer with these live-derived targets, while
`BANK_XCM_FLOW_ENABLED=false` and the wrapper remains paused:

| Target | Reader |
|---|---|
| Hydration USDC | `Tokens.accounts(freshConvertedAccountId32, 22)` via `wss://hydration-rpc.n.dwellir.com` |
| Hydration aUSDC | `balanceOf(truncate20(freshConvertedAccountId32))` at `0x2ec4884088d84e5c2970a034732e5209b0acfa93` via `https://rpc.hydradx.cloud` |

Generate exact message bytes with fresh fee quotes. The defaults are only a
reviewable ~$0.15 rehearsal-shaped starting point: 150,000 raw funds the remote
account, 100,000 raw enters Aave, and the measured rehearsal fees are 20,917,
21,350, and 1,402 raw for sell, redeem, and home respectively. The home message
returns exactly the request's 100,000 shares; the measured 7,113 raw excess
remains visible as converted-account operating float. Fresh DryRunApi quotes
supersede these defaults. Do not sign the defaults merely because they appear in
this document. `--messages-out` records every request id, message, hash,
destination, and required evidence.

For the provisional nonce-1 addresses above, the corrected bundle is:

| Leg | requestId | `keccak256(message)` |
|---|---|---|
| deposit_funding | `0xb609f4d875e0c6f4f4b1dddd90efd687215d1ac9ecd90d0de51b9304f57ecaac` | `0x0b8878cd3e2926ed648ff987b56c1bc729fdea663c874c3ea870ce2b97462462` |
| deposit_sell | `0xb609f4d875e0c6f4f4b1dddd90efd687215d1ac9ecd90d0de51b9304f57ecaac` | `0x7c39824ec714cac47cd00bc90c6bac819fc4c41f756d95d0d90cfbff61686eee` |
| withdraw_sell | `0xc3a120f46f9c29e16f49405cfef630ba8959eddb7de9de90f422ff3d03adf9fc` | `0xe494a6a6e82ba400d0f3c04777e2a0ea264e8dc069a6dfcb74653bdb3502e96a` |
| withdraw_home | `0xc3a120f46f9c29e16f49405cfef630ba8959eddb7de9de90f422ff3d03adf9fc` | `0xb6a4c1f7628eca1c1f0391a0557ccbd7e937f2c70dd9a395f4c748159765cc08` |

The full message bytes are emitted into the create-only bundle rather than
copied by hand. They are invalid if either deployed address or the fee quote
changes.

Dry-run all four exact messages against current Asset Hub/Hydration runtimes in
a state-capable DryRunApi/Chopsticks rehearsal. The fork must stage only the
ephemeral balances needed to exercise the exact wrapper origin; it must not
change the bytes. A plain `Complete` is insufficient:

| Leg | Mandatory assertion |
|---|---|
| `deposit_funding` | a forwarded XCM to Sibling(2034), then Hydration asset-22 deposit to the fresh converted account |
| `deposit_sell` | `Broadcast.Swapped`, filler `AAVE`, 22 → 1003 |
| `withdraw_sell` | `Broadcast.Swapped`, filler `AAVE`, 1003 → 22 |
| `withdraw_home` | a forwarded XCM toward Asset Hub para 1000, then asset 1337 deposited to the wrapper image |

Start from
`deployments/templates/mainnet-bank-xcm-v2-dry-run-evidence.json`. Preserve the
raw outputs separately; set `passed:true` only after the stated event/forwarding
check and bind the exact request id plus `keccak256(message)`. The arm emitter
rejects a missing leg, wrong hash, wrong para, wrong asset pair, or `passed:false`.

## 5. Separate arm ceremony

Only after section 4 is gated may a second 2-of-3 operation be emitted:

```sh
node scripts/ops/prepare-bank-xcm-v2-multisig.mjs \
  --profile mainnet --packet arm \
  --wrapper 0xDEPLOYED_WRAPPER --adapter 0xDEPLOYED_ADAPTER \
  --converted-account 0xFRESH_CONVERTED_ACCOUNT_ID32 \
  --conversion-evidence /tmp/bank-xcm-v2-conversion.json \
  --dry-run-evidence /tmp/bank-xcm-v2-dry-run-evidence.json \
  --signer nova \
  --ws wss://asset-hub-polkadot-rpc.n.dwellir.com
```

The sole inner call must be to the wrapper with:

```text
setDispatchPaused(false)
0x1f59d6fb0000000000000000000000000000000000000000000000000000000000000000
```

Any additional call is an abort. The global TreasuryPolicy must remain
unpaused. The emergency rollback is one owner/pauser call:
`setDispatchPaused(true)`; pausers can pause but cannot unpause.

## 6. Paired manifest evidence PR (D-03)

The ceremony tooling PR may merge before deployment because it changes no
contract source and records no nonexistent address. After both deploy receipts,
fill the create-only evidence template:

`deployments/templates/mainnet-bank-xcm-v2-deployment-evidence.json`.

Then build the exact deployed source and generate a complete manifest candidate:

```sh
forge build --skip test
node scripts/ops/record-bank-xcm-v2-deployment.mjs \
  --profile mainnet \
  --evidence /tmp/bank-xcm-v2-deployment-evidence.json \
  --out /tmp/mainnet.json
```

The recorder checks both successful receipts/address/block tuples, reads live
bytecode, derives runtime and ABI hashes, and creates these paired records:

- `contracts.xcmWrapper` and `contracts.hydrationUsdcAdapter`;
- `contractProvenance[address]` for both;
- `deploymentBlocks.xcmWrapperV2` and `.hydrationUsdcAdapter`;
- `deployers.xcmWrapperV2` and `.hydrationUsdcAdapter`;
- a `HYDRATION_USDC_V1` strategy entry with status
  `paused_pending_dust_proof`;
- `bankXcmV2Deployment` with deploy, conversion, configuration, and dry-run
  evidence (dust evidence remains null).

The paired PR copies `/tmp/mainnet.json` over `deployments/mainnet.json`, and
contains no environment enablement. `check-contract-provenance.mjs` now maps
the manifest keys to the `XcmWrapperV2` and `HydrationUsdcAdapter` Foundry
artifacts, so D-03 can verify live provenance normally. Do not use a freeze or
dispatch override. Keep `BANK_XCM_FLOW_ENABLED=false` until the dust proof is
accepted.

## 7. One complete wrapper dust cycle (~$0.15 cap)

This section is a later explicitly authorized spend, not permission to move
funds. Use at most 150,000 raw USDC total. Do not source extra USDC mid-cycle.
The treasury multisig is the phase-1 staging authority and recovery recipient;
the deployed AAC is untouched.

1. Read direct treasury H160 USDC, wrapper/adapter balances, converted asset 22,
   converted aUSDC, all adapter counters, and wrapper request state.
2. Obtain separate authorization to place at most 150,000 raw USDC at the
   treasury owner. Approve only the adapter and only the capped amount.
3. Multisig-call `stageTreasuryDeposit` with the exact preflighted
   `deposit_funding` bytes. Confirm custody path
   `owner → adapter → wrapper → XCM execute` and the converted asset-22 delta.
4. Backend operator sends the exact `deposit_sell` follow-up only through the
   dry-run guard. Confirm aUSDC ERC-20 actual delta; observer finalizes using
   that delta and adapter shares/assets reconcile.
5. Multisig-call `stageTreasuryWithdraw` for the full dust shares using the exact
   `withdraw_sell` bytes. Confirm aUSDC decreases and asset 22 increases.
6. Backend operator sends exact `withdraw_home`. Confirm wrapper Asset-Hub USDC
   increases, observer finalizes, wrapper transfers only the observed amount to
   adapter, and adapter returns it only to the recorded treasury authority.
7. Record any residual asset-22 operating float at the converted account; do not
   call it missing capital. Reconcile `totalAssets`, `totalShares`, pending
   counters, recovery outstanding, and all request statuses.
8. Exercise `setDispatchPaused(true)` and prove a new request refuses. Leave the
   wrapper paused after the gate unless a later activation packet says otherwise.

One attempt per leg. Stop immediately on converted-account drift, missing
forwarded/event evidence, a balance delta in the wrong direction, an oversized
delta, request/hash mismatch, custody mismatch, timeout/stuck Pending, unexpected
runtime metadata, or a recovery obligation. Do not alter payloads, redirect a
beneficiary, retry with a new nonce, front funds from an EOA, or increase the cap.

## Handback checklist

- two deployment receipts and paused-state/immutable reads;
- fresh two-endpoint conversion evidence;
- configuration first-leg hash/timepoint and `MultisigExecuted` inner `Ok`;
- four exact messages, hashes, raw DryRunApi evidence, and asserted events;
- arm multisig evidence (one call only), if separately authorized;
- observer target reads and before/after deltas;
- paired manifest diff plus D-03 provenance output;
- per-leg dust transaction, request id, destination deltas, ledger arithmetic,
  residual float, and final paused state.

Anything else is out of scope: no AAC replacement, no production flow enable,
no non-dust allocation, no strategy-cap increase, and no mainnet capital move
from this preparation packet.

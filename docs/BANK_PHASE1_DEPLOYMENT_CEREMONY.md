# Bank phase 1: XcmWrapper v2.1 replacement ceremony

Status: **replacement preparation; not executed**. This packet deploys no contract, signs no
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

### Retired v2.0 candidate and incident

The nonce-1 pair below is the deployed v2.0 pair, not a v2.1 preview:

| Contract | Predicted address | nonce | creation-code SHA-256 | ABI SHA-256 |
|---|---|---:|---|---|
| XcmWrapperV2 | `0xc846eE73e49A748e59C7Ac8f8742F542a552D24C` | 1 | `sha256:07b47ee875c6e610aff225c664146521d5a6d83363a5727f8ea3635e94ca2a11` | `sha256:2d4c1458b4016fd38ba77af4aaf78a64daabd60b1f1a7a72d7c17f4fc90516a3` |
| HydrationUsdcAdapter | `0x5eaF58a3e2819A26B66822529aD92fcec107cc98` | 2 | `sha256:ab50c3f08862b942d20bf09d0deb7e15f8d52922e4c93b7004ba0b78716218d7` | `sha256:dbd3823b40f66873ddba6ac005a2d6a7f74d372af58090d65a42934468aea13c` |

Its converted account holds the written-off 149,412 raw asset 22 from the failed
dust cycle. The earlier identity-split 100,000 raw is also written off. Do not
attempt recovery through an alternate identity or count either balance as Bank
capital. Re-run the v2.1 preview immediately before deployment; every address,
hash, and conversion below changes with the deployer nonce.

The deployer was reported at 2.93 DOT for v2.1 planning. That is not a funding
pass: the fresh estimator and its 20% headroom check remain authoritative.

## 1. Build and deploy locally paused

Use a fresh checkout of the gated merge commit. The deploy command now treats
the source checkout as part of the safety boundary: `--source-commit` is
required in preview and commit modes, must equal `git rev-parse HEAD`, and the
worktree must be clean. It force-rebuilds Foundry artifacts inside the command;
an existing `out/` is never trusted. Run the contract tests separately, then
generate the preview:

```sh
forge test
node scripts/ops/deploy-bank-xcm-v2.mjs \
  --profile mainnet \
  --expected-deployer 0x9Ab8531FBb0948C542a31298FD61335f30064239 \
  --source-commit FULL_40_CHARACTER_GATED_COMMIT \
  --replace-existing \
  --bundle-out /tmp/bank-xcm-v2-plan.json
```

The output includes the full creation calldata for both contracts, constructor
arguments, byte counts, artifact hashes, estimates, pending nonce, and predicted
CREATE addresses. Before any signature, it must report the reviewed wrapper
creation hash
`sha256:2bb576e5c68f5ed74f3de6e8d69116ca4e3f0b2f25734e363a1835265caef058`
and an ABI containing both `dispatchRecoveryHome` and
`previewRecoveryHomeId(uint256,uint64)` (`0xdb46bee1`). The bundle is
create-only. Review it before adding `--commit`.

After Pascal authorizes deployment, the only permitted commit form is:

```sh
node scripts/ops/deploy-bank-xcm-v2.mjs \
  --profile mainnet \
  --expected-deployer 0x9Ab8531FBb0948C542a31298FD61335f30064239 \
  --replace-existing \
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
- a raw post-deploy call to the hard-coded v2.1 selector `0xdb46bee1`
  (`previewRecoveryHomeId`) succeeds and returns a non-zero `bytes32`; this is
  intentionally independent of the just-built artifact, so a stale
  checkout/artifact cannot verify itself;
- adapter `policy`, USDC, strategy id, wrapper, and existing AAC immutables;
- no role or configuration call was sent.

Stop if either receipt is not successful or any postcondition differs. A first
deployment followed by a failed second is an incident; do not retry with a new
nonce or alternate constructor.

The wrapper at `0x22E90B74ca73E86F13325Af6FdeA00Cd1da90943` was deployed from the
stale pre-v2.1 ceremony checkout and is abandoned. Its 0.26 DOT postage is a
recorded write-off; never configure, arm, or reuse it.

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
- the four exact request messages, the owner-only recovery message, and observer
  targets.

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

Dry-run all four request messages plus one parameterized recovery-home message against current Asset Hub/Hydration runtimes in
a state-capable DryRunApi/Chopsticks rehearsal. The fork must stage only the
ephemeral balances needed to exercise the exact wrapper origin; it must not
change the bytes. A plain `Complete` is insufficient:

| Leg | Mandatory assertion |
|---|---|
| `deposit_funding` | a forwarded XCM to Sibling(2034), then Hydration asset-22 deposit to the fresh converted account |
| `deposit_sell` | `Broadcast.Swapped`, filler `AAVE`, 22 → 1003 |
| `withdraw_sell` | `Broadcast.Swapped`, filler `AAVE`, 1003 → 22 |
| `withdraw_home` | a forwarded XCM toward Asset Hub para 1000, then asset 1337 deposited to the wrapper image |
| `recovery_home` | a forwarded XCM toward Asset Hub para 1000, then asset 1337 deposited to the wrapper image; only the owner-only recovery selector accepts it |

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

The v2.1 implementation and ceremony tooling merge **before** deployment so the
deployed artifact's `sourceCommit` is a reachable commit on `main`. This PR pairs
the contract change with the v2.0 incident/status update in
`deployments/mainnet.json`; a normal production deploy still deploys no contract
and enables no Bank flow. Do not use an unmerged branch or squash-source commit
as provenance.

After both deploy receipts, fill the create-only evidence template:

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
- preserved v2.0 history plus `deploymentBlocks.xcmWrapperV2_1` and
  `.hydrationUsdcAdapterV2_1`;
- `deployers.xcmWrapperV2_1` and `.hydrationUsdcAdapterV2_1`;
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
3. Before signing each leg, call `ReviveApi_call` through the deployed
   wrapper/adapter with the exact calldata and proposed outer weight/storage
   limits. Require flags 0, the expected return value, and recorded
   `weightRequired`/storage evidence. This applies independently to
   `deposit_funding`, `deposit_sell`, `withdraw_sell`, `withdraw_home`, and the
   owner-only `recovery_home` proof. Message-level DryRunApi evidence never
   substitutes for this deployed-contract gate.

   The read-only gate is the following command. Run it immediately before the
   named leg, after the preceding leg's state and destination delta exist. Use
   the same fresh fee/amount/nonce inputs that produced the gated message file:

   ```sh
   # The ceremony tools load this dependency only for Substrate runtime reads.
   npm install --no-save --package-lock=false @polkadot/api @polkadot/util-crypto @polkadot/util

   node scripts/ops/preflight-bank-xcm-v2-leg.mjs \
     --profile mainnet \
     --leg LEG_NAME \
     --wrapper 0xDEPLOYED_WRAPPER \
     --adapter 0xDEPLOYED_ADAPTER \
     --converted-account 0xFRESH_CONVERTED_ACCOUNT_ID32 \
     --dry-run-evidence /tmp/bank-xcm-v2-dry-run-evidence.json \
     --deposit-assets 150000 --deposit-sell-amount FRESH_AMOUNT --deposit-fee FRESH_FEE \
     --withdraw-shares FRESH_SHARES --withdraw-fee FRESH_FEE \
     --home-amount FRESH_SHARES --home-fee FRESH_FEE \
     --deposit-nonce 1 --withdraw-nonce 2 \
     --recovery-amount FRESH_RECOVERY_AMOUNT --recovery-fee FRESH_FEE --recovery-nonce 1 \
     --inner-ref-time DRY_RUN_QUOTED_REF_TIME \
     --inner-proof-size DRY_RUN_QUOTED_PROOF_SIZE \
     --ws wss://asset-hub-polkadot-rpc.n.dwellir.com \
     --out /tmp/bank-xcm-v2-LEG_NAME-revive-preflight.json
   ```

   `LEG_NAME` is one of `deposit_funding`, `deposit_sell`, `withdraw_sell`,
   `withdraw_home`, or `recovery_home`. The tool checks the EVM and Substrate
   chain identities, live owner/operator/adapter/conversion bindings, pause
   phase, all five message-evidence hashes, and the exact return id. It first
   simulates under a review-only ceiling, derives 25% weight/storage headroom,
   then repeats under those exact emitted limits. The evidence file is
   create-only. A revert flag, wrong return id, missing runtime field, wrong
   state, or second simulation failure is an abort; do not sign or broadcast.
4. Multisig-call `stageTreasuryDeposit` with the exact preflighted
   `deposit_funding` bytes. Confirm custody path
   `owner → adapter → wrapper → XCM execute` and the converted asset-22 delta.
5. Backend operator sends the exact `deposit_sell` follow-up only through the
   dry-run guard. Confirm aUSDC ERC-20 actual delta; observer finalizes using
   that delta and adapter shares/assets reconcile.
6. Multisig-call `stageTreasuryWithdraw` for the full dust shares using the exact
   `withdraw_sell` bytes. Confirm aUSDC decreases and asset 22 increases.
7. Backend operator sends exact `withdraw_home`. Confirm wrapper Asset-Hub USDC
   increases, observer finalizes, wrapper transfers only the observed amount to
   adapter, and adapter returns it only to the recorded treasury authority.
8. Record any residual asset-22 operating float at the converted account; do not
   call it missing capital. Reconcile `totalAssets`, `totalShares`, pending
   counters, recovery outstanding, and all request statuses.
9. Exercise `setDispatchPaused(true)`, dry-run and limit-simulate the fifth
   recovery-home shape, and prove a new ordinary request refuses. Leave the
   wrapper paused after the gate unless a later activation packet says otherwise.

One attempt per leg. Stop immediately on converted-account drift, missing
forwarded/event evidence, a balance delta in the wrong direction, an oversized
delta, request/hash mismatch, custody mismatch, timeout/stuck Pending, unexpected
runtime metadata, or a recovery obligation. Do not alter payloads, redirect a
beneficiary, retry with a new nonce, front funds from an EOA, or increase the cap.

### 2026-08-04 v2.1 `deposit_sell` empirical record

The first EVM-path XCM dispatch established that `ReviveApi_call` weight and
EVM gas are separate gates. The original review ceiling
`10,000,000,000 / 500,000` was itself too low. A read-only retry at
`100,000,000,000 / 3,000,000` measured `11,728,066,855 / 285,862`; the
measured-times-two envelope `23,456,133,710 / 571,724` passed again. Storage
required was `79,200,000`, with `1,000,000,000` allowed. Asset Hub remained at
`specVersion=2003002`, matching the earlier fork capture.

For the exact transaction, `eth_estimateGas` returned `17,958`; the dispatched
limit was `36,000`, and receipt `0x64f649b85de6c92e1e222f352552bca827b9fcdd34e30e02518fa0ed456a1081`
used `17,885` gas at block `19,046,778`. At 800 Gwei, the operator paid
`0.014308 DOT`. The wrapper bitmap advanced from funding-only (`1`) to both
deposit legs dispatched (`3`).

The destination execution did **not** pass the dust-cycle gate. Hydration block
`13,456,243` emitted `messageQueue.Processed` for request
`0xb609f4d875e0c6f4f4b1dddd90efd687215d1ac9ecd90d0de51b9304f57ecaac`
with `success=false`, plus `polkadotXcm.AssetsTrapped` for `17,932` raw asset 22.
No `Broadcast.Swapped{AAVE}` occurred and aUSDC remained zero. Asset 22 moved
from `149,475` to `131,543` raw. The observer created no request watch and no
calibration record. The ceremony stopped without a retry or a following leg;
do not treat the successful Asset Hub receipt as a successful Bank deposit.

The failure is consistent with a perished `BuyExecution` quote: the encoded
`17,932`-raw quote was about 3.5 hours old by destination execution. Hydration
used only `300,000,000 / 0`, trapped the full fee asset, and consumed zero of
that asset as execution fees. Fee quotes are therefore dispatch-time inputs,
not durable ceremony artifacts. For every remote leg, rebuild the exact
message with `fresh quote × 2` immediately before the wrapper preflight and
broadcast; the message tail returns surplus. Never dispatch from an old
otherwise-green dry-run bundle.

Observer registration is also a pre-broadcast invariant, including manual
ceremony sends while `BANK_XCM_FLOW_ENABLED=false`. Persist the balance watch,
verify it appears in `/monitor/bank-feed`, and only then permit signing. The
missing watch for this request was backfilled with baseline `0`, the real
dispatch timestamp, and phase `leg2-dispatched`; it now ages in the board's
request table.

Trapped-asset claim ticket (write-off #3 for now):

- trap hash: `0x430cf4ce3b1ad751b3e66ed76c48a9a421518219f99e7d0ef9507f718daf5e21`;
- Hydration block: `13,456,243`;
- descended origin: `parents=1`, `Parachain(1000)`,
  `AccountId32(0x2af394fa95f75d3ca1c786128f4dfa1eb0c9675deeeeeeeeeeeeeeeeeeeeeeee)`;
- exact V5 asset: `parents=1`, `Parachain(1000)`, `PalletInstance(50)`,
  `GeneralIndex(1337)`, fungible amount `17,932`;
- disposition: claimable later only if a narrowly reviewed claim shape earns
  inclusion; no improvised claim transaction belongs in this ceremony.

The deployed wrapper cannot retry this sell with changed fee bytes. The
already-dispatched leg accepts only its recorded message hash; changed bytes
revert `PayloadMismatch`, while identical bytes return the request id without
sending again. A new deposit request requires a new local funding leg. This is
a structural fee-at-staging defect: the exact payload is pinned before the fee
quote's lifetime is known, but the only safe retry needs different fee bytes.
Before any real-money epoch, v2.2 must either parameterize the execution fee at
dispatch while retaining the request-bound structural payload, or enforce an
on-chain staging deadline after which dispatch is impossible. An off-chain
stage-to-dispatch convention alone is not a sufficient real-money control.

The proposed v2.1 recovery was stopped before terminalization because the
deployed adapter cannot satisfy honest recovery accounting. On
`settleRequest(Failed, 0, 0, ...)`, a funded Deposit unconditionally records
`recoveryAssetsOutstanding = request.requestedAssets`, which is `150,000` for
this request. A fresh Hydration read at block `13,456,650` showed only `131,543`
raw asset 22 at the converted account. The complete reconciliation is:

- staged principal: `150,000` raw;
- leg-1 reserve-transfer fee: `525` raw;
- trapped fee asset, write-off #3: `17,932` raw;
- chain-observed recoverable balance: `131,543` raw;
- unexplained remainder: `150,000 - 525 - 17,932 - 131,543 = 0`.

Recording `150,000` as recoverable would instead create a fictitious `18,457`
raw receivable. Accordingly, request
`0xb609f4d875e0c6f4f4b1dddd90efd687215d1ac9ecd90d0de51b9304f57ecaac`
remains honestly Pending and overdue; no `finalizeRequest` transaction was
signed. v2.2 must let terminalization bind the recovery-required amount to a
fresh, observer-proven remote balance (capped by staged principal) and record
the difference as explicit named loss lines. Only then may the request be
terminalized, paused, and recovered without lying in either contract or
operator books.

Read-only recovery preparation proved the request-associated return shape at
the same block. With amount `131,543`, nonce `1`, and a fresh remote Asset Hub
execution quote of `696` raw multiplied by two, the embedded fee is `1,392`
raw. Hydration forwarded to para 1000 and the Asset Hub DryRunApi deposited
`130,312` raw asset 1337 to wrapper image
`0x2af394fa95f75d3ca1c786128f4dfa1eb0c9675deeeeeeeeeeeeeeeeeeeeeeee`.
The exact recovery id is
`0xc17e25a02084d4edb8b0ff0f1e03a85e96163b8a6a4a8f2f7b531c79e28171d1`
and message hash is
`0xc92c981487d8b473a60aa91f60c3f6ef8f1823ee8a6f951e5ea7f3979790f743`.
These bytes are review evidence, not executable ceremony material: the
terminal accounting prerequisite has not passed.

After a recovery-capable successor closes this request, the next dust request
must start from zero unreconciled remote capital. Quote the `DepositSell`
`BuyExecution` fee immediately before staging, embed `fresh quote × 2`, register
and verify the observer watch before any signature, and keep staging → deployed-
wrapper preflight → dispatch inside one tight operator window. A fee change or
deadline breach cancels the attempt; it never causes an old payload to be sent.

## Handback checklist

- two deployment receipts and paused-state/immutable reads;
- enforced source commit/clean-tree proof, force-rebuild proof, reviewed
  creation hash, and the successful independent `0xdb46bee1` selector probe;
- fresh two-endpoint conversion evidence;
- configuration first-leg hash/timepoint and `MultisigExecuted` inner `Ok`;
- all five exact messages, hashes, raw DryRunApi evidence, and asserted events;
- arm multisig evidence (one call only), if separately authorized;
- observer target reads and before/after deltas;
- paired manifest diff plus D-03 provenance output;
- per-leg dust transaction, request id, destination deltas, ledger arithmetic,
  residual float, and final paused state.

Anything else is out of scope: no AAC replacement, no production flow enable,
no non-dust allocation, no strategy-cap increase, and no mainnet capital move
from this preparation packet.

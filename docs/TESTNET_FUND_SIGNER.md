# Testnet — Fund the Backend Signer with USDC

This is the practical playbook for getting USDC sitting inside
`AgentAccountCore` under the backend signer's wallet on **Polkadot
Hub TestNet (Asset Hub Paseo, chainId 420420417)** so the hosted
product-proof worker loop can settle on the v1 USDC path.

It exists because there is no Polkadot faucet for USDC, the asset
involves a few non-obvious traps (XCM addressing, ERC20-precompile
quirks, Assets-pallet existential deposit), and we re-discover them
every time someone tries to fund a fresh testnet from scratch.

> Mainnet equivalent is similar in shape but every address /
> minBalance / contract changes. Use this as a template, not a
> recipe — re-verify the canonical values from
> [`deployments/testnet.json`](../deployments/testnet.json) (or the
> mainnet equivalent) and the live Polkadot docs.

---

## What we're trying to achieve

We want this on-chain state, where `signer` is the backend signer
EVM wallet address (read it from
[`deployments/testnet.json#verifier`](../deployments/testnet.json)):

```
AgentAccountCore.positions(signer, USDC).liquid >= rewardAmount × 10^6
```

That is the precondition the hosted product-proof worker loop's
liquidity preflight (see [`scripts/ops/run-hosted-worker-loop.mjs`](../scripts/ops/run-hosted-worker-loop.mjs))
fails closed against. Without it, no settlement happens.

To get there we need three things in order:

1. **PAS** in the signer wallet for gas + as the asset to swap
2. **USDC** (asset id 1337) in the signer wallet, acquired by swap
3. **`approve` + `deposit`** signed by the signer to fund
   `AgentAccountCore`

---

## Step 1 — PAS for gas

Use the Polkadot Faucet. From [Polkadot docs](https://docs.polkadot.com/smart-contracts/faucet/):

- URL: `https://faucet.polkadot.io/?parachain=1000`
- Paste the signer's EVM address
- Click **Get Some PASs**
- ~30 seconds later, ~100 PAS lands

Verify with:

```bash
cast balance "$SIGNER" --rpc-url https://eth-rpc-testnet.polkadot.io/
```

You only need a fraction of a PAS for the swap + approve + deposit.

---

## Step 2 — Acquire USDC by swapping PAS

There is **no USDC faucet** on Paseo Asset Hub. Polkadot Faucet only
delivers PAS (the testnet's native gas token). Per
[`smart-contracts/faucet.md`](https://docs.polkadot.com/smart-contracts/faucet/).

The canonical route is the Substrate-side `assetConversion` pallet
(Uniswap V2 AMM on Asset Hub) via Polkadot.js Apps. Reachable from
**any** wallet that holds PAS — the swap doesn't have to be signed
by the deployer; the signer's USDC is delivered via the `sendTo`
field. Using a different wallet for the swap keeps the deployer key
out of browser extensions.

### 2a. Open the right network

Direct deeplink to the Extrinsics page on Paseo Asset Hub:

```
https://polkadot.js.org/apps/?rpc=wss%3A%2F%2Fasset-hub-paseo-rpc.n.dwellir.com#/extrinsics
```

Top-left should read **Paseo Asset Hub**.

### 2b. Fill the swap form

Choose `Developer → Extrinsics` (the deeplink lands you here).

| Field | Value | Notes |
|---|---|---|
| using account | a wallet you control with PAS | Doesn't have to be the deployer |
| pallet | `assetConversion` | |
| extrinsic | `swapTokensForExactTokens` | "exact amount of `path[last]` out" |
| `path[0]` | `parents=1, interior=Here` | **PAS — parents MUST be `1` (TRAP #1)** |
| `path[1]` | `parents=0, interior=X2(PalletInstance: 50, GeneralIndex: 1337)` | USDC asset id 1337 |
| `amountOut` | `10000000` | 10 USDC, 6 decimals |
| `amountInMax` | `50000000000` | 5 PAS slippage cap |
| `sendTo` | the **signer's 32-byte form** | See "Address mapping" below |
| `keepAlive` | `Yes` | Avoid account reaping |

### 2c. The address mapping (TRAP #2)

`sendTo` is `AccountId32` — wants a 32-byte Substrate account ID,
not a 20-byte EVM address. Polkadot Hub maps 20-byte → 32-byte by
appending **12 `0xEE` bytes** (per
[`smart-contracts/for-eth-devs/accounts.md`](https://docs.polkadot.com/smart-contracts/for-eth-devs/accounts/#ethereum-to-polkadot-mapping)).

So for an EVM address `0xAbCd…1234`, the 32-byte form is:

```
0xAbCd…1234EEEEEEEEEEEEEEEEEEEEEEEE
        ↑ original 20 bytes ↑    ↑ 12 bytes of 0xEE ↑
```

Paste **66 chars total** (`0x` + 64 hex chars) in the `sendTo`
input field. Polkadot.js Apps auto-displays an SS58 form — that's
cosmetic; the underlying bytes are what get encoded.

### 2d. The PAS asset reference (TRAP #1, expanded)

Why `parents: 1` and not `0` for PAS?

XCM addresses are relative. From Asset Hub's perspective:
- `{parents: 0, interior: Here}` = "this chain's own thing"
- `{parents: 1, interior: Here}` = "the parent's thing" (the relay
  chain — Paseo)

The `assetConversion` pallet on Asset Hub Paseo registered the PAS
pool using the parents=1 form. Submitting parents=0 for PAS yields
`assetConversion.InvalidAssetPair`. Verifiable by enumerating the
on-chain pool keys with `state_getKeys` against the Substrate RPC
and decoding the SCALE-encoded `(asset1, asset2)` tuples.

### 2e. Submit + sign

Click **Submit Transaction** → **Sign and Submit**, sign in your
wallet extension. **Trap #3:** make sure popups are allowed for
`polkadot.js.org`. The extension's signing prompt opens as a
separate browser window (not the toolbar panel) — if blocked, the
spinner runs for ~2 minutes and silently times out.

Watch for the green `assetConversion.SwapExecuted` toast.

### 2f. Verify

```bash
cast call 0x0000053900000000000000000000000001200000 \
  "balanceOf(address)(uint256)" \
  "$SIGNER" \
  --rpc-url https://eth-rpc-testnet.polkadot.io/
```

Should print `10000000` (10 USDC).

---

## Step 3 — Approve + deposit USDC into AgentAccountCore

`AgentAccountCore.deposit(asset, amount)` does
`safeTransferFrom(asset, msg.sender, this, amount)` and credits
`positions[msg.sender][asset].liquid`. This must be signed by the
signer (whoever holds the USDC at the precompile) — sending the
USDC to AgentAccountCore directly **does not** count. There is no
sweep mechanism that retroactively credits a position.

### 3a. Use the in-repo script

The helper supports two signing backends — pick the one that matches
your deployment's `SIGNER_BACKEND`:

- **`SIGNER_BACKEND=local`** (pre-Phase 3): raw `PRIVATE_KEY` env
- **`SIGNER_BACKEND=kms`** (Phase 3 default after 2026-05-16):
  `--use-kms` with `KMS_KEY_ID` + `AWS_REGION` env

Both modes share the same `--dry-run` default. Dry-run is read-only,
prints the encoded calldata, and exits without signing.

```bash
cd /path/to/your/agent/clone
```

#### Dry-run — works without a private key or KMS creds

```bash
# Read state for the canonical verifier address from deployments/<profile>.json:
node scripts/ops/fund-signer-usdc-deposit.mjs --amount 10000000

# Read state for the KMS-derived address (one kms:GetPublicKey call, no kms:Sign):
KMS_KEY_ID=arn:aws:kms:<region>:<account>:key/<id> AWS_REGION=<region> \
  node scripts/ops/fund-signer-usdc-deposit.mjs --amount 10000000 --use-kms

# Hard-code the signer address (audits without AWS creds):
SIGNER_ADDRESS_OVERRIDE=0x31ad432dFe083B998c69B6dB88A984ec5207ab7F \
  node scripts/ops/fund-signer-usdc-deposit.mjs --amount 10000000
```

#### Commit — raw key path (`SIGNER_BACKEND=local`)

```bash
PRIVATE_KEY=0x<deployer-key> node scripts/ops/fund-signer-usdc-deposit.mjs \
  --amount 10000000 --commit

# clear the line from history afterward
fc -p
```

#### Commit — KMS path (`SIGNER_BACKEND=kms`)

This is the Phase 3 flow (post 2026-05-16 cutover, see
[`docs/SECRETS_MIGRATION.md`](SECRETS_MIGRATION.md) §"Phase 3 — AWS
KMS for the backend signer"). The KMS key has no exportable private
material; the helper calls `kms:Sign` for each tx via the same
`KmsSigner` ([`mcp-server/src/blockchain/kms-signer.js`](../mcp-server/src/blockchain/kms-signer.js))
the runtime backend uses.

```bash
# IAM creds must be visible to the AWS SDK (env, ~/.aws/credentials, or
# an attached role). The IAM principal needs kms:GetPublicKey + kms:Sign
# on the key with SigningAlgorithm=ECDSA_SHA_256, MessageType=DIGEST.
export KMS_KEY_ID=arn:aws:kms:<region>:<account>:key/<id>
export AWS_REGION=<region>
# Optional if not already in your environment:
# export AWS_ACCESS_KEY_ID=...
# export AWS_SECRET_ACCESS_KEY=...

node scripts/ops/fund-signer-usdc-deposit.mjs \
  --amount 10000000 --use-kms --commit
```

What happens under the hood (per
[`mcp-server/src/blockchain/kms-signer.js`](../mcp-server/src/blockchain/kms-signer.js)):

1. `KmsSigner` calls `kms:GetPublicKey` once and caches the
   secp256k1 public point → derives the EVM address.
2. For each of `approve` + `deposit`, ethers populates the unsigned
   tx (nonce, gas, chainId), `KmsSigner.signTransaction` computes the
   RLP unsigned hash, then calls `kms:Sign(MessageType=DIGEST,
   SigningAlgorithm=ECDSA_SHA_256)`.
3. The DER signature is parsed, `s` is normalised to the low half of
   the group order (EIP-2), and the recovery byte is brute-forced
   against the cached address.
4. The signed RLP tx is broadcast normally; postcondition check runs
   the same way as the raw-key path.

Both modes:
1. Verify signer's USDC balance ≥ amount
2. Call `usdc.approve(agentAccountCore, amount)`
3. Call `agentAccountCore.deposit(usdc, amount)`
4. Verify `positions.liquid` increased by `amount`
5. Exit non-zero on any precondition / postcondition failure

### 3b. Or use `cast` directly (no Node deps required)

```bash
export RPC_URL=https://eth-rpc-testnet.polkadot.io/
export USDC=0x0000053900000000000000000000000001200000
export AGENT_ACCOUNT_CORE=0x71B111d8c9DF84Be26cb9067D27dAd7A2d5E7e08
export AMOUNT_RAW=10000000   # 10 USDC, 6 decimals

cast send "$USDC" "approve(address,uint256)" "$AGENT_ACCOUNT_CORE" "$AMOUNT_RAW" \
  --rpc-url "$RPC_URL" --private-key "$SIGNER_PRIVATE_KEY"

cast send "$AGENT_ACCOUNT_CORE" "deposit(address,uint256)" "$USDC" "$AMOUNT_RAW" \
  --rpc-url "$RPC_URL" --private-key "$SIGNER_PRIVATE_KEY"
```

### 3c. Verify

```bash
cast call "$AGENT_ACCOUNT_CORE" \
  "positions(address,address)(uint256,uint256,uint256,uint256,uint256,uint256)" \
  "$SIGNER" "$USDC" \
  --rpc-url "$RPC_URL"
```

First returned number is `liquid`. Should equal `$AMOUNT_RAW`.

---

## Five traps we already paid for

If you read nothing else, scan this list before you start.

### Trap 1: PAS XCM addressing

When swapping on `assetConversion`, the **PAS** asset must be
addressed as `{parents: 1, interior: Here}`, not `{parents: 0,
interior: Here}`. The Asset Hub Paseo `Pools` storage uses the
parents=1 form. Wrong form yields `InvalidAssetPair` /
`PoolNotFound`. (See Step 2d.)

### Trap 2: AccountId32 vs EVM address

`sendTo` and similar Substrate fields want 32-byte account IDs.
For an EVM address, append 12 `0xEE` bytes. Polkadot Hub maps
this automatically; the bytes you submit must be the 32-byte form
or the mapping happens twice and the USDC lands at a different
account.

### Trap 3: ERC20 precompile has no metadata functions

Per Polkadot's [ERC20 precompile docs](https://docs.polkadot.com/smart-contracts/precompiles/erc20/):

> The optional ERC20 metadata functions (`name()`, `symbol()`,
> `decimals()`) are **not implemented** in this precompile.

Validators that try to verify "is this really USDC?" by calling
`symbol()` on `0x…01200000` will revert. Strict v1 USDC validation
must compare against the static `mcp-server/src/core/assets.js`
record (symbol + address + assetClass + assetId + decimals) plus
the on-chain `TreasuryPolicy.approvedAssets(address)` boolean.

A useful belt-and-suspenders check is the address suffix: the last
4 bytes of the precompile address encode the asset category —
`01200000` = Trust-Backed, `02200000` = Foreign, `03200000` =
Pool. See `classifyAssetSuffix` in
[`scripts/ops/audit-launch-readiness.mjs`](../scripts/ops/audit-launch-readiness.mjs).

### Trap 4: Assets-pallet `minBalance` (existential deposit)

Trust-Backed assets carry a non-trivial minBalance enforced on
every transfer destination. For USDC asset id 1337 on Paseo Asset
Hub:

```
minBalance = 70000 base units (0.07 USDC)
```

If a settlement transfer is below `minBalance` and the recipient
has no existing asset account (or the existing one was destroyed
when their balance hit zero), the Assets pallet rejects with what
surfaces in EVM-land as `SafeTransfer.TransferFailed (selector
0x90b8ec18)`.

Implication: `PRODUCT_PROOF_REWARD_AMOUNT` (and any production job
reward) must yield ≥ `minBalance` after multiplication by
`10^decimals`. The hosted worker loop's default is now `0.1` USDC
= 100 000 base units (PR #221), comfortably above.

Read `minBalance` for any asset id from Substrate RPC:

```js
// pseudo, see scripts/ops/audit-launch-readiness.mjs for the working version
const prefix = xxhashAsHex("Assets", 128) + xxhashAsHex("Asset", 128).slice(2);
const key = prefix + blake2_128_concat_hash(assetIdU32LE);
// state_getStorage(key) → AssetDetails struct → read minBalance at byte offset 144
```

A generic preflight that enforces this is tracked as
[issue #222](https://github.com/averray-agent/agent/issues/222).

### Trap 5: Polkadot.js Extension popup blocking

The extension's signing prompt opens as a separate browser window,
not in the toolbar panel. Chrome's popup blocker silently swallows
it on first run. Allow popups for `polkadot.js.org` before the
first `Submit Transaction`, otherwise the spinner times out at
~2 minutes with no extension activity and no error toast.

---

## Common errors → causes

| Error | Likely cause | Fix |
|---|---|---|
| `assetConversion.InvalidAssetPair` | Asset reference doesn't match a registered pool | Verify path entries match the canonical XCM locations. Most often Trap 1. |
| `assetConversion.PoolNotFound` | Pool exists but pair lookup canonicalizes differently | Same as above — check Trap 1 |
| `Token expired.` (in hosted worker loop) | `ADMIN_JWT` GitHub secret expired | Rotate the secret. Sign in to the operator app, copy the JWT from local-storage, `gh secret set ADMIN_JWT --body 'eyJ…'` |
| `execution reverted (unknown custom error)` with revert data `0x90b8ec18` | `SafeTransfer.TransferFailed` — Trap 4 | Bump `PRODUCT_PROOF_REWARD_AMOUNT` so reward ≥ minBalance after decimals scaling |
| `OUT_OF_MEMORY(65)` PVM panic | Calling an unknown selector on the precompile (e.g. `mint()` on a real USDC precompile) | The precompile only implements `transfer/transferFrom/approve/allowance/balanceOf/totalSupply`. Use `safeTransferFrom` for funds movement, never `mint` |
| `InsufficientLiquidityError: USDC is a trust_backed settlement asset and cannot be auto-minted` | PR #213's auto-mint guard caught a path that tried to call `MockERC20.mint` on a real precompile | Pre-fund the signer (this doc) and don't add custom assets without setting `assetClass: "custom"` |

---

## Decoding revert selectors

`execution reverted (unknown custom error)` includes a 4-byte
selector in the revert data. Match it:

| Selector | Custom error | Source |
|---|---|---|
| `0x90b8ec18` | `TransferFailed()` | `contracts/lib/SafeTransfer.sol` |
| `0x82b42900` | `Unauthorized()` | `contracts/EscrowCore.sol`, `AgentAccountCore.sol` |
| `0xbaf3f0f7` | `InvalidState()` | `contracts/EscrowCore.sol` |
| `0x408c4295` | `UnknownJob()` | `contracts/EscrowCore.sol` |
| `0x44279255` | `ProtocolPaused()` | `contracts/EscrowCore.sol`, `AgentAccountCore.sol` |
| `0x3e8aa400` | `InsufficientReserved()` | `contracts/AgentAccountCore.sol` |
| `0xbb55fd27` | `InsufficientLiquidity()` | `contracts/AgentAccountCore.sol` |
| `0x4805dffb` | `OutflowCapExceeded()` | `contracts/TreasuryPolicy.sol` |

Compute any selector via:

```js
ethers.id("TransferFailed()").slice(0, 10)
```

---

## Related

- [`scripts/ops/audit-launch-readiness.mjs`](../scripts/ops/audit-launch-readiness.mjs)
  — read-only on-chain audit of the entire `TreasuryPolicy` config
  (roles, parameters, USDC asset class) before you trigger a smoke
- [`scripts/ops/fund-signer-usdc-deposit.mjs`](../scripts/ops/fund-signer-usdc-deposit.mjs)
  — Step 3 automation
- [`scripts/ops/run-hosted-worker-loop.mjs`](../scripts/ops/run-hosted-worker-loop.mjs)
  — what we're funding to make pass
- [issue #222](https://github.com/averray-agent/agent/issues/222) —
  generic preflight that catches Trap 4 for any asset, not just USDC
- [`docs/MULTISIG_SETUP.md`](MULTISIG_SETUP.md),
  [`docs/SIGNER_POLICY.md`](SIGNER_POLICY.md) — signer governance
  context (separate from this funding playbook)

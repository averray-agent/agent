# Native Pallet Multisig Setup

This guide walks a solo operator through standing up a **2-of-3 pallet
multisig** on Polkadot Hub, transferring `TreasuryPolicy.owner` to the
multisig's EVM-mapped address, and rehearsing pause/unpause before any
mainnet cutover. Every step is read-only until the final ownership transfer.

---

## 1. Design recap

Decisions that frame everything below:

- **Owner** (multisig): 2-of-3 threshold across three keys controlled by you.
  Required for all admin ops on `TreasuryPolicy` (and therefore the stack).
- **Pauser** (single hot key): 1-key EOA with one capability — `setPaused`.
  The fastest escape hatch; safe because pause only freezes, never moves funds.
- **Recovery**: cold key stored offline (hardware wallet + steel-backup seed).
  Lose any one key and the other two still satisfy the 2-of-3 threshold.

---

## 2. Generate the three signer keys

Create each key on its own device to keep the keys truly independent.

### Key A — Hot (daily-driver)

1. Install the [Polkadot.js browser extension](https://polkadot.js.org/extension/).
2. "Add account" → generate → write the 12-word seed into a password manager
   or a sealed envelope you control.
3. Name it "averray-hot" so it's obvious in the signing UI.

### Key B — Warm (separate device)

1. On a phone you don't browse the web with, install
   [Nova Wallet](https://novawallet.io) or [SubWallet](https://subwallet.app).
2. Create a new account; record the seed on paper + store in a different
   location from Key A's seed.
3. Name it "averray-warm".

### Key C — Cold (Ledger + steel backup)

1. On a Ledger device install the Polkadot app.
2. Derive a new account. The seed is the Ledger's own 24-word recovery seed
   — stamp it on a metal backup plate (Cryptosteel / Billfodl) and store in
   a bank safe deposit box **or** a split-knowledge arrangement.
3. Name the account "averray-cold".

Sanity checks before moving on:

- [ ] All three addresses are recorded in a secure note you can read offline.
- [ ] You can sign a dummy transaction with each key independently.
- [ ] No two keys share a device or a seed backup location.

---

## 3. Compute the multisig address

Substrate multisigs have a **deterministic** address: same signer set + same
threshold = same address on every chain. No on-chain transaction is required
to "create" the multisig — it exists as soon as you commit to the signer set.

### Option A: Polkadot.js Apps UI

1. Go to [polkadot.js.org/apps](https://polkadot.js.org/apps) and connect
   to the Polkadot Hub endpoint.
2. Accounts → Multisig → "+ Multisig".
3. Add the three signatories (Hot, Warm, Cold). Threshold `2`. Give it a
   name like "averray-admin".
4. Apps shows the derived address. **Copy this address** — it's your
   multisig's Substrate-native SS58 form.

### Option B: CLI

```bash
npx @polkadot/api-cli --ws <HUB_WSS> \
  derive.multisig \
  --signatories <HOT_SS58>,<WARM_SS58>,<COLD_SS58> \
  --threshold 2
```

(Order matters — sort the addresses lexicographically before calling.)

---

## 4. Map the multisig to an EVM address

`TreasuryPolicy.owner` is an `address` (20 bytes), so the Substrate SS58
multisig needs an EVM counterpart.

On Polkadot Hub, the EVM mapping takes the last 20 bytes of the 32-byte
`AccountId32`:

```bash
# Substrate public key (32 bytes hex, via subkey or Polkadot.js Apps)
ACCOUNT_ID_HEX=0x<32-byte-hex>

# EVM-mapped address: last 20 bytes, 0x-prefixed
printf '0x%s\n' "${ACCOUNT_ID_HEX: -40}"
```

Record this as your `OWNER` value. When operators sign admin ops the
PolkadotJS extension surfaces them for approval by the threshold signers.

> **Double-check convention**: Polkadot Hub's EVM mapping is `last 20 bytes
> of the Substrate public key`. Confirm against the Hub docs before cutover
> — getting this wrong means your "owner" is an unreachable address and the
> contract is permanently frozen out of admin ops.

---

## 5. Rehearse on testnet BEFORE mainnet

Do the full end-to-end ownership transfer on Polkadot Hub TestNet first.
This catches signer-set mistakes cheaply — fixing them on mainnet costs a
redeploy.

### 5a. Deploy with the multisig as owner

```bash
cd /path/to/agent
PROFILE=testnet \
RPC_URL=https://eth-rpc-testnet.polkadot.io/ \
PRIVATE_KEY=0x<deployer-testnet-key> \
TOKEN_ADDRESS=0x<hub-dot-precompile-or-testdot> \
OWNER=0x<multisig-mapped-evm>    \
PAUSER=0x<hot-key-evm>           \
VERIFIER=0x<verifier-evm>        \
ARBITRATOR=0x<arbitrator-evm>    \
./scripts/deploy_contracts.sh
```

The deploy script transfers ownership to `OWNER` as the last step. After
ownership transfer the deployer key can no longer touch admin ops.

### 5b. Verify the wiring

```bash
./scripts/verify_deployment.sh testnet
```

Every line must print `[ok]`. If anything says `[FAIL]` do **not** proceed.

### 5c. Rehearse pause from the hot key

The pauser is a single EOA, so you can use `cast`:

```bash
cast send "$TREASURY_POLICY" "setPaused(bool)" true \
  --rpc-url "$RPC_URL" --private-key "$PAUSER_KEY"

# Confirm it stuck
cast call "$TREASURY_POLICY" "paused()(bool)" --rpc-url "$RPC_URL"

# Unpause
cast send "$TREASURY_POLICY" "setPaused(bool)" false \
  --rpc-url "$RPC_URL" --private-key "$PAUSER_KEY"
```

### 5d. Rehearse an admin op from the multisig

Try rotating the pauser. Requires 2 signatures.

On Polkadot.js Apps:

1. Accounts → Multisig → your multisig → "Send".
2. Destination: `TreasuryPolicy` address. Call: `setPauser(address)` with a
   new pauser.
3. Sign with Key A (Hot). The tx enters the multisig queue as "pending 1/2".
4. On the device holding Key B (Warm), open Apps again → Pending calls →
   approve. The tx executes when the second signature lands.
5. Verify:
   ```bash
   cast call "$TREASURY_POLICY" "pauser()(address)" --rpc-url "$RPC_URL"
   ```

If this flow completes cleanly on testnet, your signer set + EVM mapping
are correct. Revert the pauser back to the original hot key afterwards.

---

## 6. Day-to-day operations

| Operation | Who signs | How |
|---|---|---|
| Pause / unpause | Pauser EOA | `cast send setPaused(bool)` |
| Rotate pauser | Multisig (2/3) | PolkadotJS Apps → multisig → `setPauser(address)` |
| Add/remove verifier | Multisig (2/3) | `setVerifier(address,bool)` |
| Add/remove operator | Multisig (2/3) | `setServiceOperator(address,bool)` |
| Update outflow cap | Multisig (2/3) | `setDailyOutflowCap(uint256)` |
| Transfer ownership | Multisig (2/3) | `transferOwnership(address)` — one-way, be careful |

---

## 7. Recovery playbook

### Lost Hot (Key A)

1. Pause via Warm+Cold multisig action to stop any in-flight compromise.
2. Multisig call `setPauser(newHotAddress)` to rotate to a freshly generated
   hot key; 2 sigs from Warm+Cold.
3. Document incident.

### Lost Warm (Key B)

1. Not urgent — Hot+Cold still satisfy threshold.
2. Generate Key D, then multisig-rotate the signer set (see below).

### Lost Cold (Key C)

1. Not urgent as long as Hot+Warm are safe.
2. Use the steel-backup seed to restore on a new Ledger.
3. If the steel backup is also lost: generate Key D, then rotate — but note
   that rotating the signer set changes the multisig address, which means
   redeploying the contract suite with the new owner.

### Rotating the signer set

Substrate multisig addresses are deterministic from `(signatories, threshold)`,
so **changing the signer set creates a new address**. Plan:

1. Create the new multisig with Hot + Warm + new Cold (example).
2. From the old multisig, call `TreasuryPolicy.transferOwnership(newMultisigMappedEvm)`.
3. Update operator runbooks / monitoring to point at the new owner.

### Emergency broadcast

If a key is compromised with the attacker racing to drain — pause
IMMEDIATELY from the pauser EOA, then coordinate rotation. Pause stops all
value movement regardless of owner compromise.

---

## 8. Checklist before tagging v1.0.0-rc2

- [ ] All three keys generated, backups stored in distinct locations.
- [ ] Multisig address computed + EVM-mapped form recorded.
- [ ] Testnet deploy transferred ownership to the multisig.
- [ ] `verify_deployment.sh testnet` passes cleanly.
- [ ] Pause + unpause from pauser EOA rehearsed.
- [ ] Admin rotation (e.g., `setPauser`) from multisig rehearsed end-to-end.
- [ ] Recovery playbook dry-run: simulate each of the three "lost key"
      scenarios on paper.
- [ ] Incident-response tabletop: walk through "hot key compromised" with
      at least one other person if possible.

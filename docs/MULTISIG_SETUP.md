# Native Pallet Multisig Setup

Before using this runbook, read:

- [docs/MULTISIG_DECISION.md](/Users/pascalkuriger/repo/Polkadot/docs/MULTISIG_DECISION.md)
- [docs/SIGNER_POLICY.md](/Users/pascalkuriger/repo/Polkadot/docs/SIGNER_POLICY.md)

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
- **Recovery**: **all three keys are Ledger hardware wallets**, each with its own
  steel-backup seed plate stored offline in a separate location. Lose any one
  key (device **and** its plate) and the other two still satisfy the 2-of-3
  threshold.

---

## 2. Generate the three signer keys

**All three signers are dedicated Ledger hardware wallets** — one device per
key, each on its own 24-word seed with its own steel backup plate. The private
key never leaves the secure element, so there is no software/hot signer to steal
online. The Hot / Warm / Cold labels are **access/location tiers, not
hardware-vs-software**: the security floor is identical (all secure-element);
what differs is how reachable each device is and how far apart the devices and
their plates live.

> **Chain detail — resolved 2026-07-24.** Use the **Polkadot (Generic)** Ledger
> app; the legacy parachain-specific apps are deprecated and do not cover Hub.
> The H160 `OWNER` for the **keyless** 2-of-3 multisig is
> `keccak256(accountId32)[12..32]` (see §4), and on Polkadot Asset Hub mainnet
> the mapping is **automatic** — no `map_account()` ceremony. A wrong owner
> still **bricks the contract**, so verify the address rather than assuming it:
> `revive.originalAccount(<OWNER>)` must return the multisig's `accountId32`.
> (The secp256k1 KMS key in the credentials plan is the *backend* signer,
> **not** these OWNER signers.)

Buy the three Ledgers **sealed, direct from the vendor**; verify genuineness on
first boot and pin firmware. Initialize each on an offline machine.

### Key A — Hot (readily accessible)

1. Initialize a dedicated Ledger; set a PIN. Derive the OWNER signer account.
2. Stamp the device's 24-word seed onto its **own steel plate**; store the plate
   **apart from the device** (never next to it).
3. Name the account "averray-hot" so it's obvious in the signing UI. This is the
   device you reach for routine 2-of-3 ceremonies (Hot + one other).

### Key B — Warm (separate secured location)

1. Initialize a **second** dedicated Ledger; set a **different** PIN. Derive the
   OWNER signer account.
2. Stamp its 24-word seed onto a **separate steel plate**; store device + plate
   in a secured location distinct from Key A's.
3. Name it "averray-warm".

### Key C — Cold (deep offline storage)

1. Initialize a **third** dedicated Ledger; set a **different** PIN. Derive the
   OWNER signer account.
2. Stamp its 24-word seed onto a **third steel plate** (stainless/titanium —
   Cryptosteel / Billfodl are examples, not the only option); store the device
   and the plate in deep storage (e.g. a bank safe-deposit box or a
   split-knowledge arrangement), in a third distinct location.
3. Name the account "averray-cold".

**Steel-backup rules (all three):** one plate per signer; **no two signers ever
share a plate**; each plate lives in a different location from **both** its own
Ledger **and** the other two plates+devices; the plate is not labeled with what
it controls; any BIP39 passphrase (25th word) is stored separately from the
plate, never stamped on it. The three device PINs are themselves secrets — never
store a PIN next to its device or its plate.

**Rehearsal:** to practice the `asMulti` ceremony, `map_account`, and the health
checks, use **quarantined throwaway seeds** against a **separate throwaway
multisig** on testnet / a local fork. A throwaway address must **never** be added
as a signatory of the real OWNER multisig or `map_account`'d to the real `OWNER`,
and never funded with real value. Rehearsal proves the runbook; it does not
replace the one real ceremony on the real devices.

Sanity checks before moving on:

- [ ] All three signers are on **separate Ledger devices**, each with a different PIN.
- [ ] All three addresses are recorded in a secure note you can read offline.
- [ ] You can sign a dummy transaction with each key independently.
- [ ] Three steel plates, one per signer — no two keys share a device or a plate.
- [ ] Every device and every plate is in a distinct location; no plate sits with
      its own device.

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

### Option B: repo helper

```bash
node scripts/ops/prepare-multisig-owner-record.mjs \
  --profile testnet \
  --threshold 2 \
  --signatories <HOT_SS58>,<WARM_SS58>,<COLD_SS58> \
  --out deployments/testnet-multisig-owner.json
```

The helper sorts the signers, derives the deterministic pallet-multisig
SS58/accountId, computes the H160 owner candidate used as `OWNER`, and writes
a public operator record. It does **not** prove the account is safe to use as a
contract owner yet — the initial record is `status: "draft"` until the account
mapping (§4, by either mechanism) and the ownership/admin rehearsal evidence
below are filled in.

Do not put seeds or private labels in the record. Signer addresses, transaction
hashes, workflow run ids, and the mapped owner address are public launch
metadata.

---

## 4. Map the multisig to an EVM address

`TreasuryPolicy.owner` is an `address` (20 bytes), so the Substrate SS58
multisig needs an EVM counterpart.

Do **not** derive this by taking the last 20 bytes of the 32-byte
`AccountId32`. The official Polkadot Hub account docs describe a
different model:

- Ethereum-style 20-byte addresses map into 32-byte accounts through a
  reversible `0xEE` suffix convention.
- A native 32-byte Polkadot account's EVM address is
  `keccak256(accountId32)[12..32]` — the whole account is hashed and the
  last 20 bytes taken, precisely so nothing is truncated away.
- That derivation is **stateless and unconditional**. Mapping stores the
  reverse lookup (`revive.originalAccount: H160 -> AccountId32`) so the
  runtime can recover the native account; it does **not** change the
  derived address. An account's H160 is the same before and after mapping.
- A native account must nonetheless be **mapped** before Ethereum-compatible
  tooling can control it.

### Two mapping mechanisms — check which one the runtime uses

| Runtime | What to do |
|---|---|
| `Config::AutoMap` **enabled** | Nothing. Accounts are mapped automatically on creation by `AutoMapper`; `revive.map_account()` is a **documented no-op** and `unmap_account` is disabled. Simply funding the multisig creates *and* maps it. |
| `Config::AutoMap` **disabled** | The account itself must call `revive.map_account()` (for a multisig: via a 2-of-3 `asMulti`). This takes a refundable deposit, released by `unmap_account`. |

Check the runtime before planning a ceremony — the call documentation states
the AutoMap behaviour directly:

```bash
# prints the map_account/unmap_account runtime docs for the connected chain
node -e "(async()=>{const{ApiPromise,WsProvider}=await import('@polkadot/api');
const api=await ApiPromise.create({provider:new WsProvider(process.env.WSS)});
const p=api.runtimeMetadata.asLatest.pallets.find(x=>x.name.toString()==='Revive');
api.registry.lookup.getSiType(p.calls.unwrap().type).def.asVariant.variants
 .filter(v=>/map_account/.test(v.name.toString()))
 .forEach(v=>console.log(v.name.toString(),'->',v.docs.map(d=>d.toString()).join(' ')));
await api.disconnect();})()"
```

> **Polkadot Asset Hub mainnet has `AutoMap` enabled** (verified 2026-07-24).
> No `map_account()` ceremony is required there; do not schedule one, and do
> not record an unrelated transaction hash as if it were a mapping call.

**Verify the mapping either way** — the proof is chain state, not a receipt:

```bash
# must return the multisig's accountId32
revive.originalAccount(<OWNER H160>)
```

Record the verified 20-byte address as your `OWNER` value only after that
lookup matches and the ownership rehearsal succeeds.

> **Important**: if the owner address is wrong, the contract is not
> "partially degraded" — it is effectively frozen out of admin control.
> Treat owner-address verification as a launch gate, not a clerical step.

Record the mapping with the mechanism that actually applies.

On a runtime **without** AutoMap, after the multisig has called
`pallet_revive.map_account()`:

```bash
node scripts/ops/prepare-multisig-owner-record.mjs \
  --profile testnet \
  --threshold 2 \
  --signatories <HOT_SS58>,<WARM_SS58>,<COLD_SS58> \
  --map-account-tx 0x<tx-hash> \
  --out deployments/testnet-multisig-owner.json
```

On a runtime **with** AutoMap there is no mapping extrinsic, so confirm the
`originalAccount` lookup on chain and record that instead. Pass the transfer
that created the account as `--account-creation-tx`:

```bash
node scripts/ops/prepare-multisig-owner-record.mjs \
  --profile mainnet \
  --threshold 2 \
  --signatories <HOT_SS58>,<WARM_SS58>,<COLD_SS58> \
  --map-account-mechanism auto_map \
  --auto-map-verified \
  --account-creation-block <N> \
  --account-creation-tx 0x<funding-tx-hash> \
  --out deployments/mainnet-multisig-owner.json
```

Passing `--map-account-tx` together with `auto_map` is **refused**: no mapping
extrinsic exists under AutoMap, so any hash filed there would be evidence of a
call that never happened.

> **Keep the multisig funded.** `AutoMapper` unmaps an account when it is
> killed, so a balance falling below the existential deposit would unmap an
> account that owns contracts. Re-funding restores the same H160 (the
> derivation is deterministic), but avoid the situation.

The record should stay `draft` at this point. It becomes `verified` only after
ownership transfer, `verify_deployment.sh testnet`, and one owner-only admin
rehearsal are all recorded.

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
TOKEN_ADDRESS=0x0000053900000000000000000000000001200000 \
OWNER=0x<multisig-mapped-evm>    \
PAUSER=0x<hot-key-evm>           \
VERIFIER=0x<verifier-evm>        \
ARBITRATOR=0x<arbitrator-evm>    \
./scripts/deploy_contracts.sh
```

The deploy script transfers ownership to `OWNER` as the last step. After
ownership transfer the deployer key can no longer touch admin ops.

`TOKEN_ADDRESS` is the v1 escrow asset. Use USDC, Trust-Backed Asset ID
`1337`, ERC20 precompile
`0x0000053900000000000000000000000001200000`, 6 decimals. The same precompile
address is used on Polkadot Hub mainnet and Polkadot Hub TestNet.

There is no native DOT ERC20 precompile on Polkadot Hub. For local `dev`, the
deploy script can still mint MockDOT automatically when this value is omitted.
For `testnet` and `mainnet`, do not use a placeholder native-DOT precompile
address.

### 5b. Verify the wiring

```bash
./scripts/verify_deployment.sh testnet
```

Every line must print `[ok]`. If anything says `[FAIL]` do **not** proceed.

### 5c. Rehearse pause from the hot key

The pauser is a single EOA, but do the read-only proof first so you know the
live transaction will exercise the right address and the right contract
capability:

```bash
node scripts/ops/run-pauser-rehearsal.mjs \
  --profile testnet \
  --out artifacts/pauser-rehearsal-readonly.json
```

That proof checks:

- live `owner`, `pauser`, and `paused` values against `deployments/testnet.json`
- `pauser != owner` and `pauser != address(0)`
- `eth_call` from the pauser can call `setPaused(bool)`
- `eth_call` from the pauser cannot call owner-only functions such as
  `setPauser`, `setVerifier`, `setServiceOperator`, or `transferOwnership`
- whether the pauser address overlaps verifier/arbitrator/deployer roles

For mainnet or any real-funds rehearsal, add `--require-dedicated-pauser` so
the proof fails if the pauser overlaps deployer, verifier, arbitrator, or
owner. The current testnet manifest deliberately carries a bounded overlap
while we finish launch rehearsal; do not copy that shape to mainnet.

Then run the live rehearsal from the pauser key:

```bash
PAUSER_PRIVATE_KEY=0x<pauser-testnet-key> \
node scripts/ops/run-pauser-rehearsal.mjs \
  --profile testnet \
  --live \
  --out docs/evidence/pauser-rehearsal-testnet-YYYY-MM-DD.json
```

The live mode sends `setPaused(true)`, confirms `paused() == true`, sends
`setPaused(false)`, confirms `paused() == false`, and writes a sanitized JSON
evidence file containing only public addresses, checks, and transaction hashes.
Do not commit private keys or shell history containing them.

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

Now finalize the owner record:

```bash
node scripts/ops/prepare-multisig-owner-record.mjs \
  --profile testnet \
  --threshold 2 \
  --signatories <HOT_SS58>,<WARM_SS58>,<COLD_SS58> \
  --map-account-tx 0x<map-account-tx> \
  --ownership-transfer-tx 0x<deploy-or-transfer-tx> \
  --admin-rehearsal-tx 0x<set-pauser-rehearsal-tx> \
  --verify-deployment-run <workflow-run-or-terminal-log-id> \
  --final \
  --out deployments/testnet-multisig-owner.json
```

`./scripts/verify_deployment.sh testnet` automatically reads
`deployments/testnet-multisig-owner.json` when present and fails if the manifest
owner differs from the record owner or the record is still draft.

---

## Multisig.asMulti operational recipe — Paseo Asset Hub

This section records the exact Paseo Asset Hub TestNet pattern exercised during
the 2026-05-25/26 cutover. Polkadot docs MCP verification for this section:
the official Polkadot Hub smart-contract docs confirm Hub supports Solidity
contracts through REVM and that Asset Hub smart contracts use `pallet_revive`
with multi-dimensional `refTime`, `proofSize`, and `storage_deposit`
accounting. The concrete signer set, weights, blocks, and failure modes below
are Averray testnet operator evidence from the cutover.

### Owner and signer set

The current testnet owner is the pallet multisig:

- SS58: `12nHTKYfV64pnxsVRB6Cjn6kQPPH64Ehnr8zgqZxvfa8hJvQ`
- H160 mapping: `0x1f8C4da4AAAC79916350f1fabF1221309591B6F9`

The H160 is **not an EOA**. There is no private key for it. Any owner-gated
`TreasuryPolicy` call must be wrapped in `multisig.asMulti` and executed by
two of the three Substrate signers.

Canonical signer order is AccountId32 byte order, not UI order:

| Order | Signer | SS58 | AccountId32 prefix |
| --- | --- | --- | --- |
| 1 | Polkadot Vault | `13pav6xpfdapyCAqfRhWZXxUnqDhjrF92dJr3FBwVfBKUKSM` | `0x7c` |
| 2 | Ledger | `148tqwhGxeCva7ZX8RwvaLjCS7HvDJJaSbxfTUwE9Zyc5Xtm` | `0x8a` |
| 3 | Hot Wallet | `14ruuTeh5cXMTr9SLNuLt1NiroQZgt5ZQnwYrhg7K5LHiXQb` | `0xaa` |

Canonical order matters because `otherSignatories` must be sorted by AccountId32
bytes with the active signer omitted. Wrong order fails at dispatch with
`SignatoriesOutOfOrder`. Do not trust the order a wallet UI happens to show.

### asMulti shape for owner-gated EVM calls

For a typical owner-gated `TreasuryPolicy` EVM call on Paseo Asset Hub:

```text
multisig.asMulti(
  threshold: 2,
  otherSignatories: <the other two signers, in canonical AccountId32 byte order>,
  maybeTimepoint: None | Some({ height, index }),
  call: revive.call(
    dest: <TreasuryPolicy H160>,
    value: 0,
    weightLimit: { refTime: 4_000_000_000, proofSize: 100_000 },
    storageDepositLimit: 1_000_000_000,
    data: <4-byte selector + ABI-encoded args>
  ),
  maxWeight: { refTime: 4_500_000_000, proofSize: 150_000 }
)
```

The inner `weightLimit` caps the `revive.call`. The outer `maxWeight` must
cover the whole dispatch tree. For a single `revive.call`,
`refTime: 4_500_000_000` and `proofSize: 150_000` are generous enough for the
owner-gated role calls rehearsed so far. For a two-call `utility.batchAll`, the
cutover scripts used `refTime: 9_000_000_000` and `proofSize: 300_000`.

Use `storageDepositLimit: 1_000_000_000` (1 PAS) as the safe default. A zero
storage deposit limit can revert with `StorageDepositLimitExhausted` when the
inner call writes contract state.

Reference generators:

- `scripts/ops/rotate-admin-multisig-payload.mjs` for `setPauser` and batched
  `setArbitrator(new, true)` / `setArbitrator(old, false)`.
- `scripts/ops/redeploy-escrowcore-wire-multisig.mjs` for the EscrowCore swap
  path from PR #525.

### Two-leg execution

1. First signer submits `multisig.asMulti` with `maybeTimepoint: None`.
2. Wait for the extrinsic to be `inBlock` and for `multisig.NewMultisig`.
3. Record the first leg's block height and extrinsic index. In the cutover
   evidence this looked like `height: 9290992, index: 2`.
4. Hand those values to the second signer.
5. Second signer submits the same inner call with
   `maybeTimepoint: Some({ height, index })`.
6. Confirm `multisig.MultisigExecuted` and the inner contract event, then verify
   the target state with a read call.

The first leg stores intent. The second leg executes. If the second signer uses
the wrong timepoint, wrong inner call, or wrong `otherSignatories` list, the
runtime will not match the pending multisig.

### Batch owner-gated calls when the state transition is one operation

Use `utility.batchAll` to combine several owner-gated calls into a single
multisig flow when they are one logical operation. It saves `N - 1` Hot+Ledger
rounds and makes the transition atomic.

The current EscrowCore swap shape replaces stale
`0x7BB8fea44bDeE9870cF27c1dB616E7017BC38b0a` with
`0xb8fd8A932F69bD5E39700b7cf6D2920aF84d1B27`:

```text
multisig.asMulti(
  threshold: 2,
  otherSignatories: <canonical other two>,
  maybeTimepoint: None | Some({ height, index }),
  call: utility.batchAll([
    revive.call(AgentAccountCore.setEscrowOperator(newEscrowCore, true)),
    revive.call(TreasuryPolicy.setServiceOperator(newEscrowCore, true)),
    revive.call(AgentAccountCore.setEscrowOperator(oldEscrowCore, false)),
    revive.call(TreasuryPolicy.setServiceOperator(oldEscrowCore, false))
  ]),
  maxWeight: { refTime: 18_000_000_000, proofSize: 600_000 }
)
```

`setEscrowOperator` is the dedicated AgentAccountCore ledger authority for
reserve/stake settlement. `setServiceOperator` remains the TreasuryPolicy
authority used by EscrowCore entrypoints and readiness checks. Treat the two
roles as a pair during EscrowCore swaps.

The same pattern was used for admin arbitration rotation:
`setArbitrator(new, true)` plus `setArbitrator(old, false)` in one
`batchAll`. If either inner call fails, the batch fails as a unit.

### Pre-flight before anyone signs

Before either signer touches their wallet, dry-run the inner EVM call from the
multisig H160:

```js
await provider.call({
  from: "0x1f8C4da4AAAC79916350f1fabF1221309591B6F9",
  to: treasuryPolicyAddress,
  data: innerCallData,
});
```

Use this against each inner `TreasuryPolicy` call before building the
`revive.call`. It catches wrong selectors, wrong ABI arguments, wrong target
contract, and role assumptions without consuming signer attention. The
2026-05-25 cutover evidence explicitly records this pre-flight as green before
wallet signing.

### Common dispatch errors

| Error | Diagnosis |
| --- | --- |
| `SignatoriesOutOfOrder` | `otherSignatories` are not in canonical AccountId32 byte order, or the active signer was included instead of omitted. |
| `StorageDepositLimitExhausted` | `storageDepositLimit` is too low for the inner `revive.call` state writes. Use `1_000_000_000` unless a measured call proves less is safe. |
| `MaxWeightTooLow` | Outer `maxWeight` is below actual consumed weight. Increase the outer value; do not confuse it with the inner `weightLimit`. |
| `InvalidStateUnknownJob`, `InvalidStateAlreadyClaimed`, or another 4-byte revert | This is an inner contract custom error, not a multisig error. Decode the selector against the Solidity ABI before changing multisig parameters. |

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

- [ ] All three Ledger signers generated; three steel backup plates, one per signer, stored in distinct locations (each apart from its device).
- [x] Multisig address computed + EVM-mapped form recorded.
- [x] Testnet deploy transferred ownership to the multisig.
- [x] `verify_deployment.sh testnet` passes cleanly.
- [ ] Pause + unpause from pauser EOA rehearsed.
- [x] Admin rotation (e.g., `setPauser`) from multisig rehearsed end-to-end.
- [ ] Recovery playbook dry-run: simulate each of the three "lost key"
      scenarios on paper.
- [ ] Incident-response tabletop: walk through "hot key compromised" with
      at least one other person if possible.

After the control-plane rehearsal is green, fold it into the broader release
gate in [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md) and run:

```bash
./scripts/ops/check-release-readiness.sh testnet
```

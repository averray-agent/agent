# Polkadot Official Alignment Plan

This document folds the official Polkadot docs guidance into Averray's
product and engineering roadmap.

The implementation-ready next-step plan that incorporates these findings
is:

- [docs/POLKADOT_EXECUTION_PLAN.md](/Users/pascalkuriger/repo/Polkadot/docs/POLKADOT_EXECUTION_PLAN.md)

It answers a simple question:

> If Averray wants to be genuinely "built for Polkadot Hub", what does
> the official platform model imply for our next implementation steps?

---

## What the official docs confirm

### 1. REVM is the right near-term contract target

Polkadot Hub officially supports Solidity contracts through REVM, with
existing Ethereum tooling like Hardhat, Foundry, Remix, and MetaMask.
That matches the current repo architecture well.

Implication:

- Keep the current Solidity + EVM-compatible contract path as the main
  shipping surface.
- Do not split focus into a PVM migration before the trust core and
  Polkadot-native integration path are stronger.

### 2. XCM is available to contracts, but it is intentionally low-level

The official XCM precompile exists at the fixed address
`0x00000000000000000000000000000000000a0000` and exposes `execute`,
`send`, and `weighMessage`.

The important constraint is that the docs explicitly describe this as
barebones functionality:

- XCM messages must be SCALE-encoded.
- `weighMessage` is needed for cost estimation.
- the precompile does not hide XCM complexity for the developer

Implication:

- The real vDOT adapter is not a small patch to `MockVDotAdapter`.
- We need a dedicated wrapper layer that:
  - builds XCM payloads
  - estimates weight before execution
  - handles async settlement and partial failures
  - exposes simple adapter semantics back to `AgentAccountCore`

### 3. Asset access on Polkadot Hub is precompile-driven and type-aware

The official ERC20 precompile docs describe three asset classes on
Polkadot Hub:

- Trust-Backed Assets
- Foreign Assets
- Pool Assets

Foreign assets are especially important for us:

- they are not addressed by raw XCM location inside the ERC20 surface
- they are addressed by a runtime-assigned `foreignAssetIndex`
- the precompile address is derived from that index, not directly from
  the XCM location

Implication:

- Treasury config cannot assume one generic "DOT token address" story
  will be enough forever.
- Mainnet-ready strategy config should model:
  - asset class
  - asset ID or foreign asset index
  - derived precompile address
  - decimals and risk metadata

### 4. Our current multisig mapping doc was too simplistic

The official account docs for Polkadot Hub do **not** describe native
account mapping as "take the last 20 bytes of the AccountId32".

Instead, the docs describe:

- Ethereum-style 20-byte addresses map into 32-byte accounts by adding
  trailing `0xEE` bytes
- native 32-byte Polkadot accounts need `pallet_revive.map_account()`
  for stateful Ethereum compatibility
- unmapped native accounts fall back to a hashed 20-byte representation,
  which is deterministic but not a safe operator assumption for control

Implication:

- Any ownership, signer, or recovery doc that says "last 20 bytes" needs
  to be corrected.
- Contract ownership should be assigned only to an address that has been
  explicitly verified to control EVM-side admin transactions on testnet.

---

## Product direction changes

### 1. Keep the wedge narrow

The official docs strengthen the current decision to launch around:

- trusted work
- portable identity
- verifier-backed execution

Those are already native to the repo and do not require us to solve the
entire XCM abstraction problem on day one.

### 2. Treat "agent treasury on Polkadot" as a staged systems project

The treasury story is still strong, but the official docs make it clear
that the production version depends on real platform-specific work:

- XCM wrapper engineering
- asset indexing and precompile derivation
- async settlement semantics
- more exact operator key / mapping discipline

That means treasury should stay in beta positioning until those rails
are implemented honestly.

---

## Engineering plan

## 1. Correct operator and ownership assumptions

Priority: immediate

- Remove any "last 20 bytes" guidance from ownership docs.
- Require explicit testnet verification for the owner address used in
  `TreasuryPolicy`.
- Prefer an operator setup that is provably EVM-capable on Polkadot Hub.

Primary file:

- [docs/MULTISIG_SETUP.md](/Users/pascalkuriger/repo/Polkadot/docs/MULTISIG_SETUP.md)

## 2. Define a real Polkadot strategy adapter architecture

Priority: next major treasury milestone

- Add an XCM wrapper contract or module boundary around the official XCM
  precompile.
- Design around SCALE-encoded messages and `weighMessage`.
- Make async completion a first-class part of the adapter model.
- Add queue / claim semantics for exits that cannot settle instantly.

Primary file:

- [docs/strategies/vdot.md](/Users/pascalkuriger/repo/Polkadot/docs/strategies/vdot.md)

## 3. Normalize asset metadata in config

Priority: before mainnet treasury

- Model asset class and asset identifiers explicitly.
- Derive Polkadot Hub ERC20 precompile addresses from asset metadata,
  not only static environment values.
- Distinguish trust-backed assets from foreign assets in treasury docs
  and runtime config.

Likely files:

- [mcp-server/.env.example](/Users/pascalkuriger/repo/Polkadot/mcp-server/.env.example)
- [docs/AGENT_BANKING.md](/Users/pascalkuriger/repo/Polkadot/docs/AGENT_BANKING.md)
- [docs/strategies/vdot.md](/Users/pascalkuriger/repo/Polkadot/docs/strategies/vdot.md)

## 4. Stay on REVM while trust-core and treasury semantics mature

Priority: ongoing

- Keep Solidity / REVM as the primary implementation path.
- Revisit PVM only once:
  - trust-core maturity is stronger
  - treasury semantics are real
  - there is a concrete performance bottleneck worth the migration cost

---

## What this means for launch

The official docs validate the direction, but they also make the
sequencing clearer:

1. Launch trusted work + identity first.
2. Fix Polkadot-specific operator/account correctness now.
3. Build the real treasury layer as a genuine XCM + asset-model
   integration project, not as a renamed mock.

That is how we stay both ambitious and honest.

For the concrete phase-by-phase worklist, ownership, and immediate
implementation order, see:

- [docs/POLKADOT_EXECUTION_PLAN.md](/Users/pascalkuriger/repo/Polkadot/docs/POLKADOT_EXECUTION_PLAN.md)

# MEMO — Substrate sign-in (P-SIWS, roadmap ticket 5)

Status: **RATIFIED — S1–S8 locked, Q1–Q3 answered (Pascal, 2026-08-25)** ·
drafted 2026-08-25 · Author: Claude (architect) · Implementer: Codex

## What Product asked

> P-SIWS — JWT `sub` stays SS58 CAIP-10 after `pallet_revive.map_account`
> (never rewrite to 0x); default payout = mapped same-account; kill
> `substrate-mapped` as an auth mode; modes = `evm-siwe` + `substrate-native`
> only after ship.

## Research findings (verified, not remembered)

Sources: [Polkadot Hub accounts
docs](https://docs.polkadot.com/smart-contracts/for-eth-devs/accounts/),
[`pallet_revive::AddressMapper`](https://paritytech.github.io/polkadot-sdk/master/pallet_revive/trait.AddressMapper.html),
plus local derivation checks against a known live wallet.

**F1 — The address mapping is asymmetric and branch-dependent.**

- **EVM → AccountId32**: pad the 20-byte address with twelve `0xEE` bytes.
  Simple, lossless, locally computable. (This is our banked law and it holds.)
- **AccountId32 → H160**: *two different rules depending on the account.*
  - EVM-derived (ends in twelve `0xEE`): **strip the padding** — the first
    20 bytes are the address.
  - Native (Ed25519/Sr25519): **Keccak-256 the whole 32 bytes, take the last
    20**.

**Proof this matters.** Our own tester wallet, SS58
`14RLk2G7hu2xMEYL1hbkcwbwWgjL6Nem3fL1maD2GYP1pGNe`:

| branch | result |
|---|---|
| correct (EVM-derived ⇒ strip `0xEE`) | `0x97450BF6…4b5c` ✓ matches the known wallet |
| naive (always Keccak) | `0x0baD84d6…b59D` ✗ a real, fundable, **wrong** address |

A single-branch implementation does not error — it silently produces a
plausible address that nobody controls. Any code deriving H160 from SS58
must check `is_eth_derived` first.

**F2 — The reverse direction (H160 → SS58) is not locally computable for
native accounts.** It requires pallet_revive's on-chain `OriginalAccount`
storage, populated by `map_account`. Unmapped native accounts are
unrecoverable from their H160 — the hash is one-way.

**F3 — `map_account` costs a held deposit** (refunded on `unmap`), and until
it is called, funds at the derived H160 are **receivable but not
spendable** by the account owner through Ethereum tooling.

## The consequence Product's ticket does not yet address

F3 is the finding that outranks everything else in this ticket.

If we let an unmapped native account sign in and work, it earns into an H160
it cannot spend from. We would be paying workers into a black hole while
every surface reports a successful settlement. That is a truth-boundary
violation of the first order and it must be impossible by construction.

**Therefore: `is_mapped` is a hard, on-chain-verified precondition for a
substrate-native session doing anything that can earn.** Sign-in may be
permitted unmapped (read-only), but claiming must refuse with a named reason
telling the agent to call `map_account` first.

## Design decisions (S1–S8)

**S1 — JWT `sub` is the SS58 CAIP-10 identity, per Product.** Never rewritten
to 0x. The account the human or agent controls is the identity we name.

**S2 — Internal storage keys stay the H160, lowercase hex.** Every store,
index, and registry in the platform is keyed this way, and the wallet-session
index lowercases at read *and* write. **SS58 is case-sensitive base58 — it
must never enter that index**, or we recreate the casing corruption we paid
for on 2026-08-22. The session record carries both forms; the key is the
H160.

This is safe because the direction we need at runtime (SS58 → H160) is always
locally computable (F1), and the lossy direction is never needed — the
account gave us its SS58 at sign-in.

**S3 — Derivation lives in exactly one function**, branching on
`is_eth_derived`, with the tester-wallet case above as a pinned regression
test. No second implementation anywhere.

**S4 — Mapping gate.** Before any earning action from a substrate-native
session, verify `is_mapped` on chain. Unmapped ⇒ refuse with a named reason
and the remediation (call `pallet_revive.map_account`, deposit required).
Fail closed if the chain read fails — never assume mapped.

**S5 — `WALLET_RE` stops being the identity gate.** Three modules pin
`^0x[0-9a-fA-F]{40}$`. They keep validating *H160s* — which is correct, since
S2 keeps H160 as the key — but identity validation moves to a shared
`parseWalletIdentity()` accepting both forms and returning `{ss58?, h160,
source }`. No regex is loosened in place.

**S6 — Payout default = the same account**, per Product: rewards settle to
the H160 the identity derives to. Combined with S4, that address is by
construction spendable by its owner.

**S7 — Wallet modes end state.** `substrate-mapped` retires as an *auth
mode* — mapping becomes a prerequisite of `substrate-native`, not a mode of
its own. End state: `evm-siwe`, `agent-self-custody` (an evm-siwe
provisioning variant, unchanged), and `substrate-native`. The manifest's
`walletModes` and the capabilities `supportedWalletModes` move together;
their tests move in the same branch.

**S8 — Sequencing.** Ship in three PRs, each independently revertible:
1. Identity plumbing — `parseWalletIdentity`, the one derivation function,
   dual-form session records. No new auth path; nothing user-visible.
2. SIWS verification — accept sr25519/ed25519 signatures over the SIWE-shaped
   message, mint a JWT with the SS58 `sub`. Read-only capabilities only.
3. Earning enablement — the S4 mapping gate, payout defaults, manifest mode
   changes, capability unlock.

## Open questions for the ratifier

- **Q1 — Message format.** SIWE (EIP-4361) is Ethereum-shaped. Do we sign the
  same message text with a Substrate key (simplest, one nonce path, slight
  semantic abuse), or adopt a Substrate-flavoured statement? Recommendation:
  reuse the existing message text and nonce machinery; the statement already
  names the domain and chain.
- **Q2 — Do we pay the mapping deposit for onboarding agents?** It is small,
  it is refundable, and it is currently a hard wall for a fresh native
  account with zero balance. Paying it would extend earn-from-zero to
  Substrate natives; refusing keeps the subsidy surface unchanged.
  Recommendation: **do not** pay it in v1 — document it, measure demand
  first.
- **Q3 — Scope of stage 2.** Should an unmapped native account be allowed to
  sign in read-only at all, or refused at the door? Recommendation: allow —
  a signed-in agent that can read `/me` and be told exactly what to do next
  is better onboarding than a closed door.

## Answers (Pascal, 2026-08-25)

- **A1 — Reuse the SIWE message text.** A Substrate key signs the exact
  EIP-4361-shaped message we already issue; only the signature scheme that
  validates it changes. One nonce path, one expiry rule, one shape for
  agents to learn.
- **A2 — Averray does not pay the mapping deposit in v1.** Substrate natives
  fund their own mapping. Documented, not subsidised; revisit if the
  arrivals funnel shows natives bouncing off this wall.
- **A3 — Unmapped natives may sign in read-only.** They get a session, can
  read `/me` and the catalogue, and are told exactly what is missing and how
  to fix it. Earning actions refuse with a named reason (S4).

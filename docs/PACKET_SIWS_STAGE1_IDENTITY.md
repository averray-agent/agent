# PACKET — SIWS stage 1: identity plumbing (no new auth path)

Status: READY FOR CODEX · 2026-08-25 · Author: Claude (architect+gate) ·
Repo: **platform (averray-agent/agent), mcp-server** · One PR.
Authority: `docs/MEMO_SUBSTRATE_SIGN_IN.md` (RATIFIED, S1–S8 + A1–A3) —
read it first; where this packet and the memo differ, the memo wins.

## What stage 1 is, and is not

**Is:** the shared identity layer every later stage depends on — one
derivation function, one parser, dual-form session records.

**Is not:** a new way to sign in. **No Substrate signature is accepted in
this PR.** Nothing user-visible changes; no manifest mode changes; no
capability changes. If this PR alters what any existing caller can do, it is
wrong.

## A — The derivation function (S3)

One function, one place, exported for reuse. Given an SS58 address it
returns the H160, branching on whether the AccountId32 is EVM-derived:

- **EVM-derived** — the 32 bytes end with twelve `0xEE` bytes ⇒ the address
  is the **first 20 bytes** (strip the padding).
- **Native** (Ed25519/Sr25519) ⇒ **Keccak-256 over all 32 bytes, take the
  last 20**.

**This branch is the whole point of the function.** A single-rule
implementation does not throw — it returns a real, fundable address that
nobody controls. Pinned regression test, exact values, from the ratified
memo:

| input SS58 | expected H160 |
|---|---|
| `14RLk2G7hu2xMEYL1hbkcwbwWgjL6Nem3fL1maD2GYP1pGNe` (EVM-derived) | `0x97450BF69cb4aeb0B33db3ae51ac2d18224d4b5c` |

A second test asserts the naive always-Keccak result
(`0x0baD84d6875827c959E068019f2DcE2f0BE0b59D`) is **not** what the function
returns for that input — the failure mode is silent, so the test must name
it explicitly.

Also export the existing forward direction (H160 → SS58 by `0xEE` padding,
prefix 0) if it is not already shared, so both directions live together.

## B — `parseWalletIdentity()` (S5)

A shared parser accepting either form and returning
`{ h160, ss58?, source: "h160" | "ss58" }`.

- `h160` is always populated — it is the storage key (S2).
- `ss58` is populated only when the caller supplied one; it is **never
  reconstructed** from an H160, because that direction is not locally
  computable for native accounts (memo F2).
- Invalid input is refused with a named reason; no silent coercion.

**Do not loosen the three existing `WALLET_RE` pins.** They validate H160s
and that stays correct. Identity validation moves to this parser at call
sites that need dual-form support; the regexes themselves are unchanged.

## C — Dual-form session records (S2)

Session records may carry both forms. **The wallet-session index key stays
the lowercase H160, always.** SS58 is case-sensitive base58 and must never
enter that index — lowercasing it corrupts the key, which is exactly the
class of bug repaired on 2026-08-22 (`wallet-session-index-repair-v1`).

A test asserts: given a session carrying both forms, the index key is the
lowercase H160, and no code path lowercases the SS58 for use as a key.

## Non-negotiables (each pinned by a test)

1. **Behaviour is unchanged for every existing caller.** EVM sign-in, claim,
   submit, settlement, receipts: byte-identical outcomes. This is the single
   most important property of stage 1.
2. The derivation branch test above, including the named naive-result
   assertion.
3. SS58 never becomes a store key; H160 never gets case-normalized away from
   lowercase.
4. `ss58` is never reconstructed from an H160.
5. No new env var, no new endpoint, no manifest or capability change.

## Out of scope (later stages, do not anticipate)

Accepting sr25519/ed25519 signatures; JWT `sub` changes; the `is_mapped`
gate; payout defaults; retiring `substrate-mapped` from the manifest; any
change to `supportedWalletModes` or its tests.

## Handback requirements

PR number; green CI; the derivation-branch and naive-result test names; the
index-key test name; and an explicit statement that no existing caller's
behaviour changed, with the evidence you used to convince yourself of it.

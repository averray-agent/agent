# PACKET — SIWS stage 2: accept Substrate signatures (read-only session)

Status: READY FOR CODEX · 2026-08-25 · Author: Claude (architect+gate) ·
Repo: **platform (averray-agent/agent), mcp-server** · One PR.
Authority: `docs/MEMO_SUBSTRATE_SIGN_IN.md` (RATIFIED, S1–S8 + A1–A3).
Builds on stage 1 (#1275): `deriveH160FromSs58`, `parseWalletIdentity`,
dual-form session records.

## What stage 2 is, and is not

**Is:** a native Substrate account can sign in and receive a session.

**Is not:** permission to earn. Stage 2 issues a session with **read-only
capabilities only**. The `is_mapped` gate, payout defaults, and the manifest
mode changes are stage 3. A stage-2 session that could claim a job would be
paying a worker into an address they may not control (memo F3) — that must
remain impossible until stage 3 lands.

## A — The message is unchanged (A1)

A Substrate key signs the **exact EIP-4361-shaped message we already issue**.
Same nonce machinery, same TTL, same expiry rules, same statement. Only the
signature scheme that validates it differs. Do not add a second message
builder, a second nonce path, or a Substrate-flavoured statement.

`POST /auth/nonce` accepts an SS58 address (via `parseWalletIdentity`) and
returns the same message shape it returns today.

## B — Verification: one seam, two schemes

`verifySiweMessage` currently ends in `verifyMessage(message, signature)` and
compares the recovered address. Extend that **one seam**, keeping every
preceding check (domain, chain id, nonce consumption, issuedAt sanity,
expiry) shared and unchanged:

- **secp256k1 / EIP-191** — today's path, byte-identical behaviour.
- **sr25519 and ed25519** — verify with `@polkadot/util-crypto`
  `signatureVerify` against the SS58 signer's public key.

Scheme selection is driven by the **parsed identity form**, not by a
caller-supplied field: an SS58 address in the message verifies as Substrate,
an H160 verifies as EIP-191. A caller must not be able to choose its own
verifier — a test asserts that supplying an EIP-191 signature for an SS58
identity is refused, and vice versa.

Failure reasons stay in the existing named vocabulary (e.g. a mismatch is
still a signature-mismatch error, not a new generic one).

## C — The JWT (S1)

For a Substrate sign-in the JWT `sub` is the **SS58 CAIP-10 identity** —
never rewritten to 0x. The session record additionally carries the derived
H160 from stage 1, and the wallet-session index key remains the **lowercase
H160** (S2). SS58 never becomes a store key.

## D — Capabilities: read-only, and provably so (A3, S4)

An unmapped native account may sign in (A3) and read: `/me`, the job
catalogue, its own account view. It may not claim, submit, fund, lock, or
mutate anything.

Implement this as an **explicit read-only capability set for
substrate-native sessions**, in the same style as the viewer role — start
from an allowlist, never from the base wallet capabilities minus a denylist.
A denylist here would silently grant any capability added later.

The refusal for an earning action must be **named and actionable**: it says
the session is a Substrate-native read-only session, that mapping and
earning arrive in a later stage, and what the account can do meanwhile.
Never a bare 403.

## Non-negotiables (each pinned by a test)

1. **EVM sign-in is byte-identical.** Same messages, same tokens, same
   claims, same errors. This is the property that matters most.
2. **A Substrate session cannot claim, submit, fund, or lock** — asserted
   against the real capability resolution, not a UI check.
3. **Scheme cannot be caller-selected** (both cross-scheme refusals above).
4. **`sub` is SS58 for Substrate sessions; the index key is lowercase H160.**
   One test asserts both facts on the same session.
5. **Every pre-signature check stays shared** — a Substrate sign-in with a
   stale nonce, wrong domain, wrong chain id, or expired message fails for
   the same reason an EVM one would, from the same code.
6. No manifest, capability-name, wallet-mode, or env change. Those are
   stage 3.

## Out of scope

`is_mapped` verification, payout defaults, retiring `substrate-mapped` from
the manifest, `supportedWalletModes` changes, paying the mapping deposit
(A2: we do not), and any MCP tool additions.

## Handback requirements

PR number; green CI; the six test names; a statement of exactly which
capabilities a substrate-native session resolves to (the full list, not a
summary); confirmation that the EVM path's messages, tokens, and error codes
are unchanged, with the evidence used; and the exact refusal payload an
earning action returns for a Substrate session.

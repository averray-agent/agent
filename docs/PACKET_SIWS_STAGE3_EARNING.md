# PACKET — SIWS stage 3: the mapping gate and earning enablement

Status: READY FOR CODEX · 2026-08-25 · Author: Claude (architect+gate) ·
Repo: **platform (averray-agent/agent), mcp-server** · One PR.
Authority: `docs/MEMO_SUBSTRATE_SIGN_IN.md` (RATIFIED, S1–S8 + A1–A3).
Builds on stage 1 (#1275, identity) and stage 2 (Substrate sign-in,
read-only). **Closes roadmap ticket 5.**

## Why this stage exists at all

`map_account` costs a held deposit, and **until it is called, funds at a
native account's derived H160 are receivable but not spendable by its owner**
(memo F3). Letting an unmapped native account earn would pay a worker into a
black hole while every surface reported a successful settlement. That is a
truth-boundary violation of the first order, and it is the reason stages 1
and 2 deliberately shipped without earning.

## A — The mapping check (S4), mechanism verified live

`pallet_revive` stores the reverse mapping in `revive.originalAccount`, keyed
by H160, valued `Option<AccountId32>`. Verified against live Polkadot Asset
Hub on 2026-08-25:

```
api.query.revive.originalAccount(h160)  →  Option<AccountId32>
```

Two identity classes, two answers:

- **EVM-derived identity** (AccountId32 ends in twelve `0xEE`): **no mapping
  required** — it is natively addressable. Our own seed wallet returns
  `None` here and that is correct, not a failure. Do not gate these.
- **Native identity** (Ed25519/Sr25519): derive the H160 (stage 1's
  Keccak branch), query `originalAccount(h160)`, and require it to return
  `Some(accountId)` **equal to the signing account**. A `None`, or a
  mismatched account, means not mapped.

The query needs a **Substrate RPC** (`@polkadot/api` over wss), which the
backend already configures for the bank lane — reuse that endpoint
configuration rather than introducing a new one. This is the first time the
auth/claim path depends on a Substrate connection, so treat its failure
modes as first-class:

- **Fail closed, always.** Unreadable ⇒ not mapped ⇒ refuse. Never assume
  mapped, never default open.
- **Bounded cache.** Mapping changes only by a deliberate on-chain act, so
  cache a *positive* result per account with a short TTL (mirror the
  credit-read grace pattern shipped in #1273: default minutes, hard code
  ceiling, env may lower only). **Never cache a negative** as a positive, and
  never let a cached positive outlive its ceiling.
- **No claim-path stall.** The check must not turn a claim into a long
  blocking wss round trip on every attempt — the cache is what makes this
  acceptable, and a timeout is a refusal, not a hang.

## B — Earning enablement

A **mapped** native session resolves the normal worker capability set and may
claim, submit, and be paid. An **unmapped** one keeps stage 2's read-only
set, and every earning action refuses with a named, actionable reason: that
the account is not mapped, that `pallet_revive.map_account` is the remedy,
that it requires a deposit we do not pay (A2), and that the deposit is
refundable on `unmap`.

## C — Payout default (S6)

Rewards settle to the H160 the identity derives to — the same account.
Combined with A, that address is by construction spendable by its owner.
No alternate payout address in this packet.

## D — Manifest and modes (S7)

`substrate-mapped` retires **as an auth mode**: mapping is a prerequisite of
`substrate-native`, not a mode of its own. End state advertised:
`evm-siwe`, `agent-self-custody`, `substrate-native`.

`substrate-native` moves from `planned` to supported, and its entry must
state the mapping prerequisite, the deposit, and that we do not pay it. The
manifest's `walletModes`, the capabilities' `supportedWalletModes`, and
their tests all move in the same branch — and the committed discovery
mirrors are regenerated through the generator with the `[allow-generated]`
tag.

## Non-negotiables (each pinned by a test)

1. **An unmapped native account cannot earn** — asserted against real
   capability resolution and at least one earning route, not a UI check.
2. **An unreadable mapping refuses** (chain down, timeout, malformed) with a
   named reason — never opens.
3. **EVM-derived identities are never gated** by mapping; today's EVM
   sign-in and claim behaviour stays byte-identical.
4. **A mapped native account can claim**, and its payout target equals the
   derived H160.
5. **A mismatched `originalAccount`** (returns `Some` but a different
   account) is treated as unmapped.
6. **The positive cache cannot outlive its ceiling**, and no negative result
   is ever cached as a positive.
7. **Manifest consistency holds**: modes, capabilities, and the regenerated
   mirrors agree; the #1257 manifest-consistency test passes.

## Out of scope

Paying the mapping deposit (A2 says we do not), a `map_account` helper or
MCP tool that submits the extrinsic for the user, alternate payout
addresses, and anything touching the locked-tier or credit lanes.

## Handback requirements

PR number; green CI including manifest consistency and the packed handshake;
the seven test names; the exact refusal payload an unmapped native account
receives when it tries to claim; the cache default and ceiling; and
confirmation that EVM sign-in and claim are byte-identical, with the
evidence used.

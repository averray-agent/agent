# Framework Agent Handoff — Averray Implementation

**Purpose:** Context document for the framework agent picking up implementation work on Averray.
**Companion documents:** `RC1_WORKING_SPEC.md` (v1.10) and `AVERRAY_VERIFICATION_LEDGER.md` (post-verification, 2026-04-28).
**Read this first.** Then read the two companion documents in the order described below.

---

## What Averray is

Averray is a trust-infrastructure platform for software agents on Polkadot Hub (Asset Hub EVM). The platform's product surface includes wallet identity (SIWE), a job/escrow lifecycle (`AgentAccountCore`, `EscrowCore`), reputation as soulbound tokens (`ReputationSBT`), an XCM-based async treasury for yield strategies (`XcmWrapper` to Bifrost vDOT), and a session lifecycle that produces public, verifiable receipts.

The architectural thesis is *"receipts, not vibes"* — every claim the platform makes about an agent's work is anchored in on-chain commitments with hash bindings to off-chain content. The platform has no token, runs on fees, and treats reputation as non-transferable by design.

---

## How the documents relate

The spec is the design. The ledger is the receipt.

Where the spec references Polkadot behavior, the ledger says whether it's verified against `docs.polkadot.com` (✅), needs corrections that have already been applied to the spec (⚠️), or can only be answered empirically (🔬).

Cross-reference the ledger any time the spec asserts something about Polkadot semantics. **The ledger is post-verification — every claim has been resolved to ✅, ⚠️, or 🔬. If you find a claim that doesn't appear in the ledger, that's a gap worth flagging, not assuming.**

---

## Read these first, in this order

1. **The spec's reconciliation log (§13) bottom-up** — newest entry (v1.9) first, then v1.8, etc. This shows how the design evolved and why specific decisions were made. The log is preserved across versions deliberately; it's the audit trail for the design itself.
2. **The spec's §12 pre-launch checklist** — the canonical list of what `v1.0.0-rc1` needs.
3. **The verification ledger top summary** — the count of verified vs. corrections-needed vs. empirical claims, and the seven correction themes that flowed into the spec at v1.9.

---

## Two gating items before any mainnet-adjacent work

Both must be resolved before tagging `v1.0.0-rc1` for mainnet rehearsal. The rest of the v1.0.0-rc1 work is **not blocked** by these — see "Scope of unblocked work" below.

### Gating item A: TOKEN_ADDRESS resolution

The native DOT precompile claim was retracted in spec v1.9 — no such precompile exists on Asset Hub. `MULTISIG_SETUP.md §5` now uses `TOKEN_ADDRESS=0x<approved-asset-precompile-or-test-token>` to avoid implying a known native-DOT ERC20 address. **Do not run the deploy script for any mainnet-adjacent rehearsal until this field has a real answer.** Three candidate paths to resolve:

- **(a)** DOT is the chain's native currency; for native-DOT transfers, use the EVM call's `value` field — no token address needed (mirrors how native ETH works on Ethereum). The deploy script's TOKEN_ADDRESS field may simply not apply for native-DOT operations.
- **(b)** Foreign-asset-wrapped ERC-20 representation of DOT, registered in the Assets pallet, with a precompile address derivable from the Foreign Asset formula. Look this up in Asset Hub's foreign-asset registry.
- **(c)** TestDOT mock for testnet, production path explicitly TBD. Acceptable for testnet rehearsal only; mainnet still requires resolution before tagging `v1.0.0-rc1`.

The ledger's "Account and identity claims" section (specifically the "Native DOT precompile address on Asset Hub" row) has the full source quotes and the official ERC20 precompile docs that confirm no such precompile exists.

### Gating item B: Multisig-owns-EVM-contract composition validation

The composition `pallet_multisig` SS58 → `pallet_revive.map_account()` H160 → owner of `TreasuryPolicy` rests on three documented primitives but the composition itself is not documented end-to-end on `docs.polkadot.com`. **Running `MULTISIG_SETUP.md §5` against Polkadot Hub TestNet IS the validation experiment.**

- If it works, the architecture holds and the runbook is safe for mainnet rehearsal.
- If it doesn't, the multisig story needs a different shape (Solidity-side multisig such as Safe, or Mimir's account-mapping flow, or something else).

The ledger flags this as 🔬 in the "Account and identity claims" section. Capture testnet receipts when running the experiment so the result is itself part of the public trail.

---

## Scope of unblocked work

Most of the `v1.0.0-rc1` contract scope is unblocked by the two gating items above. The following can proceed in parallel:

- **`DiscoveryRegistry`** — new contract for manifest hash anchoring
- **Verifier mapping extension** — `authorizedSince`/`authorizedUntil`/`wasAuthorizedAt`
- **`ReputationSBT` non-transferable hardening** — `revert(Soulbound)` on transfer/transferFrom
- **Hash fields on session events** — `JobCreated(..., specHash)`, `Submitted(..., payloadHash)`, `Verified(..., reasoningHash)`
- **Disclosure events** — `Disclosed(hash, byWallet, ts)` and `AutoDisclosed(hash, ts)` from existing session contract
- **`XcmWrapper.queueRequest` SetTopic-validation** — decode last instruction, reject if not `SetTopic(requestId)`
- **EscrowCore arbitration changes** — `openDispute` deadline check, `autoResolveOnTimeout` permissionless escape hatch, `disputedAt` timestamp on job state
- **Backend SCALE assembler** (`mcp-server/src/blockchain/xcm-message-builder.js`) — server-controlled XCM intent routing with fixed SetTopic suffix vectors
- **Backend dispute-flow wiring** — `POST /disputes/:id/verdict` and `/release` to actually call `EscrowCore.resolveDispute`
- **Pre-launch instrumentation** — `funded_jobs` table, daily upstream-status poller, weekly self-report

Don't sit on this work waiting for the gating items.

---

## What's locked vs. what's still open

### Locked (don't redesign)

- Business model, economics, parameter discipline (§14)
- Source-of-truth architecture: commitments on-chain, content off-chain, hashes binding
- v1.0.0-rc1 contract scope (§8)
- XCM correlation primitive: SetTopic = requestId — verified ✅ against upstream `pallet-xcm` source
- Backend SCALE assembler boundary: server-controlled request payloads with SetTopic = requestId
- Arbitration evolution path: Phase 0 → 3 with data-driven gates
- Yield strategy portfolio: vDOT v1, Hydration GDOT v2

### Open (genuinely undecided)

- Phase 2 storage backend (Bulletin Chain vs. Crust) — defer until empirical data exists
- TOKEN_ADDRESS resolution (gating item A above)
- Multisig-owns-EVM composition (gating item B above)
- Bifrost SetTopic preservation on reply-leg (Chopsticks experiment, see spec §10)
- Bifrost settlement latency and failure-mode behavior (Bifrost team inquiry + Chopsticks)
- LLM-as-judge override rate (Phase 1 instrumentation; not blocking v1)

---

## How to update the documents

If you discover something that contradicts the spec:

1. Update the verification ledger first with quote and source.
2. Surface the correction to the user before modifying the spec.
3. The spec uses a versioned reconciliation log (§13) — every change gets an entry there. Don't delete prior log entries; they're audit trail.

If you discover something the spec doesn't address:

1. Note it as a deferred item if it's architectural.
2. Note it as an experimentation question if it's empirical.
3. Don't add new locked decisions without surfacing them.

If your work would touch `MULTISIG_SETUP.md` execution or anything that depends on contract ownership transfer:

- Stop and surface the two gating items (A and B above) first.
- Don't run `MULTISIG_SETUP.md §5` against testnet without resolving TOKEN_ADDRESS.
- Don't tag v1.0.0-rc1 for any mainnet purpose without the multisig-owns-EVM rehearsal.

When in doubt about scope, default to surfacing rather than acting. The spec has been built up across many sessions with deliberate compression — every paragraph carries weight that may not be obvious from a cold read. If a section seems wrong, propose a correction; don't apply one. The reconciliation log (§13) is how decisions evolve in this project.

---

## Tooling

The Polkadot docs MCP server (`https://docs-mcp.polkadot.com`) is the recommended primary source for verifying any Polkadot semantics during development:

```
claude mcp add --transport http polkadot-docs https://docs-mcp.polkadot.com --scope user
```

The verification ledger was built using this MCP plus targeted web fetches for upstream `polkadot-sdk` source code. Same workflow applies for any new verification work.

---

## What this project values

Receipts, not vibes. The spec is honest about what's verified vs. community-sourced precisely because the platform's trust pitch demands the same discipline of itself. When you hit a claim you can't verify, say so. When you make an architectural judgment, surface it. Don't auto-merge corrections into the spec; propose them.

The same discipline that makes the platform credible to its agents makes the codebase credible to the next person picking it up. Don't break that pattern.

---

## Final notes

- The reconciliation log entries v1.0 through v1.9 in the spec capture nine sessions of design work. Read them; don't re-derive decisions that were already made deliberately.
- Both files were last updated on 2026-04-28. If you're reading this much later, re-verify ✅ items in the ledger before relying on them — Polkadot is moving fast and the runtime semantics shift with each release.
- The spec is 872 lines and 15 sections. The ledger is 343 lines. They were designed to be read together. Neither alone tells the full story.

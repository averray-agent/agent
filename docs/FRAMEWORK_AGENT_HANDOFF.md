# Framework Agent Handoff — Averray Implementation

**Purpose:** Context document for the framework agent picking up implementation work on Averray.
**Companion documents:** `AVERRAY_WORKING_SPEC.md` (v2.2) and `AVERRAY_VERIFICATION_LEDGER.md` (post-verification, 2026-04-28).
**Read this first.** Then read the two companion documents in the order described below.

---

## What Averray is

Averray is a trust-infrastructure platform for software agents on Polkadot Hub (Asset Hub EVM). The platform's product surface includes wallet identity (SIWE), a job/escrow lifecycle (`AgentAccountCore`, `EscrowCore`), reputation as soulbound tokens (`ReputationSBT`), an XCM-based async treasury for yield strategies (`XcmWrapper` to Bifrost vDOT — *deferred to v1.x post-week-12-gate*), and a session lifecycle that produces public, verifiable receipts.

The architectural thesis is *"receipts, not vibes"* — every claim the platform makes about an agent's work is anchored in on-chain commitments with hash bindings to off-chain content. The platform has no token, runs on fees, and treats reputation as non-transferable by design.

**v1 escrow asset is USDC** (Trust-Backed Asset, ID 1337, ERC20 precompile `0x0000053900000000000000000000000001200000`, 6 decimals — same address on Polkadot Hub mainnet and Polkadot Hub TestNet, verified). Native DOT is NOT an ERC20 precompile and is not usable as the escrow asset for the current contract surface.

---

## How the documents relate

The spec is the design. The ledger is the receipt.

Where the spec references Polkadot behavior, the ledger says whether it's verified against `docs.polkadot.com` (✅), needs corrections that have already been applied to the spec (⚠️), or can only be answered empirically (🔬).

Cross-reference the ledger any time the spec asserts something about Polkadot semantics. **The ledger is post-verification — every claim has been resolved to ✅, ⚠️, or 🔬. If you find a claim that doesn't appear in the ledger, that's a gap worth flagging, not assuming.**

---

## Read these first, in this order

1. **The spec's reconciliation log (§15) bottom-up** — newest entry (v2.2) first, then v2.1, etc. This shows how the design evolved and why specific decisions were made. The log is preserved across versions deliberately; it's the audit trail for the design itself.
2. **The spec's §12 pre-launch checklist** — the canonical list of what `v1.0.0-rc1` needs.
3. **The verification ledger top summary** — the count of verified vs. corrections-needed vs. empirical claims, and the seven correction themes that flowed into the spec.

---

## One gating item before any mainnet-adjacent work

(Gating item A — TOKEN_ADDRESS resolution — was **resolved in v2.1**: USDC at `0x0000053900000000000000000000000001200000`. No longer open.)

### Gating item B: Multisig-owns-EVM-contract composition validation

The composition `pallet_multisig` SS58 → `pallet_revive.map_account()` H160 → owner of `TreasuryPolicy` rests on three documented primitives but the composition itself is not documented end-to-end on `docs.polkadot.com`. **Running `MULTISIG_SETUP.md §5` against Polkadot Hub TestNet IS the validation experiment.**

- If it works, the architecture holds and the runbook is safe for mainnet rehearsal.
- If it doesn't, the multisig story needs a different shape (Solidity-side multisig such as Safe, or Mimir's account-mapping flow, or something else).

The ledger flags this as 🔬 in the "Account and identity claims" section. Capture testnet receipts when running the experiment so the result is itself part of the public trail.

---

## Pre-deploy items (USDC settlement)

Before any v1.0.0-rc1 deploy, these must be addressed (see spec §8 Pre-deploy items for full list):

- Done: `scripts/write_server_env.sh` defaults updated from DOT/18-decimals to USDC/6-decimals
- Done: `deployments/mainnet.env.example` defaults updated from DOT/18-decimals to USDC/6-decimals
- Done: `MULTISIG_SETUP.md §5` `TOKEN_ADDRESS` field set to USDC precompile
- Done: `SUPPORTED_ASSETS_JSON` env var set with USDC entry
- Done: `BORROW_CAP` re-denominated from "25 DOT" to `25 USDC`
- Still open: all decimals-aware runtime helpers and job-sourcing defaults reviewed for the 18→6 change

These prevent silent 10^12 scaling bugs at deploy time.

---

## Scope of v1.0.0-rc1 work

The following can proceed in parallel (gated only by item B above for anything mainnet-adjacent):

**Contract changes:**
- `DiscoveryRegistry` — new contract for manifest hash anchoring
- Verifier mapping extension — `authorizedSince`/`authorizedUntil`/`wasAuthorizedAt`
- `ReputationSBT` non-transferable hardening — `revert(Soulbound)` on transfer/transferFrom (load-bearing per spec §10 wallet-linkage subsection — non-negotiable)
- Hash fields on session events — `JobCreated(..., specHash)`, `Submitted(..., payloadHash)`, `Verified(..., reasoningHash)`
- Disclosure events — `Disclosed(hash, byWallet, ts)` and `AutoDisclosed(hash, ts)` from existing session contract
- `XcmWrapper.queueRequest` SetTopic-validation — decode last instruction, reject if not `SetTopic(requestId)`
- EscrowCore arbitration changes — `openDispute` deadline check, `autoResolveOnTimeout` permissionless escape hatch, `disputedAt` timestamp on job state

**Backend:**
- SCALE assembler (`mcp-server/src/blockchain/xcm-message-builder/`) — *only needed for v1.x yield strategy, not v1.0.0-rc1 launch*
- Dispute-flow wiring — `POST /disputes/:id/verdict` and `/release` to actually call `EscrowCore.resolveDispute`
- Pre-launch instrumentation — `funded_jobs` table, daily upstream-status poller, weekly self-report

**v1.x reputation deepening (don't gate v1.0.0-rc1 contract deploy but ship before public launch):**
- Public agent profile page at `averray.com/agent/<wallet>` (~2 weeks frontend; reads from indexer)
- One-click verification flow (every receipt resolves to upstream evidence in two clicks)
- Public read API at `api.averray.com/reputation/v1/wallet/<addr>` (rate-limited, no auth, protocol-style infrastructure)

These three are the highest-leverage marketing-surface items per spec §10 Reputation deepening subsection.

---

## What's locked vs. what's still open

### Locked (don't redesign)

- Business model, economics, parameter discipline (§13)
- Three-tier fee structure: Micro $0.50, Standard $2, Substantive $5 (§2 worked examples)
- USDC as v1 escrow asset
- Source-of-truth architecture: commitments on-chain, content off-chain, hashes binding
- v1.0.0-rc1 contract scope (§8)
- XCM correlation primitive: SetTopic = requestId — verified ✅ against upstream `pallet-xcm` source
- Backend SCALE assembler design: PAPI primary, parity-tested request-id module
- Arbitration evolution path: Phase 0 → 3 with data-driven gates
- Yield strategy portfolio: NO yield in v1.0.0-rc1, vDOT yield-share at v1.x, GDOT v2
- Revenue model: slashed-stake split + slashed claim-fee split at v1, yield-share + swap spread at v1.x/v2
- Reputation soulbound non-transferability — non-negotiable, hardcoded contract revert

### Open (genuinely undecided)

- Phase 2 storage backend (Bulletin Chain vs. Crust) — defer until empirical data exists
- Multisig-owns-EVM composition (gating item B above)
- Bifrost SetTopic preservation on reply-leg (Chopsticks experiment, see spec §10)
- Bifrost settlement latency and failure-mode behavior (Bifrost team inquiry + Chopsticks)
- LLM-as-judge override rate (Phase 1 instrumentation; not blocking v1)
- Wallet linkage mechanism design (operator-provable attestations vs wallet-rotation receipts vs both) — v2 deferred per §10

---

## How to update the documents

If you discover something that contradicts the spec:

1. Update the verification ledger first with quote and source.
2. Surface the correction to the user before modifying the spec.
3. The spec uses a versioned reconciliation log (§15) — every change gets an entry there. Don't delete prior log entries; they're audit trail.

If you discover something the spec doesn't address:

1. Note it as a deferred item if it's architectural.
2. Note it as an experimentation question if it's empirical.
3. Don't add new locked decisions without surfacing them.

If your work would touch `MULTISIG_SETUP.md` execution or anything that depends on contract ownership transfer:

- Stop and surface gating item B first.
- Don't tag v1.0.0-rc1 for any mainnet purpose without the multisig-owns-EVM rehearsal.

When in doubt about scope, default to surfacing rather than acting. The spec has been built up across many sessions with deliberate compression — every paragraph carries weight that may not be obvious from a cold read. If a section seems wrong, propose a correction; don't apply one. The reconciliation log (§15) is how decisions evolve in this project.

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

- The reconciliation log entries v1.0 through v2.2 in the spec capture eleven sessions of design work. Read them; don't re-derive decisions that were already made deliberately.
- Both files were last updated on 2026-04-28. If you're reading this much later, re-verify ✅ items in the ledger before relying on them — Polkadot is moving fast and the runtime semantics shift with each release.
- The spec is now ~1100 lines and 15 sections. The ledger is 343 lines. They were designed to be read together. Neither alone tells the full story.

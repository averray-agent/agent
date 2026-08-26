# PACKET — Backend cutover to pool v2.1 (A6)

Status: READY FOR CODEX · 2026-08-26 · Author: Claude (architect+gate) ·
Repo: **platform, manifest + env template + tests** · One PR.
**MERGE-GATED ON A4**: do not merge before the four multisig calls of
2026-08-27 have executed (I verify on-chain and say go). Building and CI-ing
it beforehand is the point of this packet.

## What A6 is

The backend learns the pool address from the manifest, not env
(`config.js: depositPoolAddress ← deployments/<profile>.json#contracts.depositPool`).
Cutover is therefore a manifest repoint plus one env flip:

1. **Repoint `contracts.depositPool` and `contracts.depositPoolV2`** (and their
   `deploymentBlocks` twins) to v2.1: `0x9B35A102d656Fb86d798aF81959e09961DEc28E0`,
   block 19913549.
2. **Keep the live v2 tracked** under a new `legacyDepositPoolV2` key →
   `0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30` (the escrowCore/legacyEscrowCore
   precedent). It still holds real money — the tester's 5.026011 shares and the
   permanently-parked protocol principal — and must never fall out of
   provenance coverage. **Its `knownUnshippedContractChanges` waiver moves to
   the legacy key** (the immutable v2 runs pre-#1295 bytecode against v2.1
   source forever).
3. **`IDLE_BALANCE_ALLOCATION_ROUTE_LIVE=1`** in
   `deploy/backend.mainnet.env.template` — flips the #1292 consent surface
   from `route_not_live` to available. This line is why the PR is
   merge-gated: consent must not be solicitable before the on-chain route
   exists (registry active + aggregator flagged).
4. **CONTRACT_ARTIFACTS + guard pins**: add the `legacyDepositPoolV2` mapping
   (same `DepositPoolV2.sol` artifact), move the provenance-enumeration pin
   and the contract-count pin in the same PR (the guard-literal law; #1300
   just moved them 17→19 — this PR takes them to 20).

## Non-negotiables (pinned by tests)

1. Drift check exits 0 **live**: `depositPool`/`depositPoolV2` classify
   `deployed` at the NEW address; `legacyDepositPoolV2` classifies
   `known-unshipped` at the OLD address under the moved waiver.
2. The consent capability serves `available` **only** under the flipped env —
   the existing #1292 tests keep proving default-off.
3. Locked-tier quotes, attribution, and `/pool` read v2.1 after cutover — and
   **the tester's v2 position must remain renderable wherever it appears**
   (they are still a v2 holder; surfaces must not orphan them).
4. No allocation keeper, no consent change, no contract change.

## Handback

PR number; green CI; the moved pins; the served consent capability under both
env states; drift-check evidence for all three pool keys; confirmation the PR
stays UNMERGED pending my on-chain A4 verification.

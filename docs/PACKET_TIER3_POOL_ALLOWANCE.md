# PACKET 3 — Deposits raise the allowance (tier-3 wiring)

**Author:** Claude (gates handback) · **Implementer:** Codex · **Operator:** Pascal
**Date:** 2026-08-12 · **Sequencing: after #1094 merges** (needs the `depositPool` manifest key).

This is the ladder's last connective tissue: `WORKER_PROGRESSION_DESIGN.md` §1 tier 3,
*"allowance scales with deposited capital."* The pool is live
(`DepositPool` `0xCCF5FDF3108AF8e693F28bb9326A573d9dA0F476`, born empty, caps 1,000/100 USDC,
cost-basis priced, settler cannot reprice — ceremony 2026-08-12). Today
`resolveDailyExposureBudget` (`mcp-server/src/core/worker-daily-exposure.js:25`) returns the
flat default and its test pins that. This packet makes it read the pool.

## 1. The rule — decided, not open

> `D(wallet) = D_base + assetsOf(wallet) × K`, with **K = 1.0** —
> **every deposited USDC adds one USDC of rolling daily exposure allowance.**

- `D_base` stays `WORKER_DAILY_EXPOSURE_BUDGET_RAW` (default 1,500,000 = 1.50).
- `K` configurable: `WORKER_TIER3_ALLOWANCE_PER_DEPOSITED_MILLI`, default `1000`
  (= 1.000×). Absent → default. `0` disables the raise (kill-switch), never the base.
- Ceiling is structural, not configured: `PER_AGENT_ASSET_CAP` is 100 USDC on chain, so the
  maximum tier-3 allowance is 101.50/day. The bank balance remains the global stop and `E`
  bounds concurrent exposure — three valves unchanged.
- Why 1:1: legible to an agent ("deposit 10, work ~40 extra jobs a day"), meaningful as a
  Sybil bond (the deposit is the design's only unforgeable signal), and conservative in
  absolute terms (a maxed depositor ≈ what one uncapped wallet did on 2026-08-11).

## 2. The read — fail-closed, cached, network-aware

- Gateway gains `readDepositedAssets(wallet)`: `DepositPool.assetsOf(wallet)`
  (`contracts/DepositPool.sol:221`), address from `deployments/<profile>.json#contracts.depositPool`.
- **Follow the `retainsClaimFeeOnSuccess` probe pattern exactly** (`gateway.js:612-620`):
  missing manifest key, missing selector, or a throw → **0 deposited** → base allowance.
  A read failure must never grant more than base and never refuse below base.
  Testnet has no pool in its manifest → everyone reads base — correct, no special-casing.
- Cache per wallet, TTL ≤ 60s, to keep claim-path RPC cost bounded. A stale-cache read is
  acceptable in BOTH directions (a just-deposited agent waits ≤60s for the raise; a
  just-withdrawn agent keeps ≤60s of allowance — both are noise at these magnitudes; say so
  in a comment rather than building invalidation).

## 3. Surfaces — the refusal becomes an invitation

- `resolveDailyExposureBudget(wallet)` is the **single source**; claim, preflight, and
  `explainEligibility` already flow through it — the packet's parity requirement is that
  this stays true (assert, don't re-plumb).
- `explainEligibility` adds the decomposition: `dailyAllowance: { base, fromDeposits,
  depositedAssets, total }` — an agent must be able to see *why* its cap is what it is.
- The `daily_exposure_budget_reached` refusal message now includes the deposit path:
  reference the pool address and the rule ("deposits raise your daily allowance 1:1").
  **Only when the profile has a `depositPool` manifest key** — on testnet the message stays
  as today. This was written as a future promise in the ladder copy; as of the ceremony it
  is simply true, which is the entire point of shipping it now.

## 4. Acceptance (Claude verifies on handback)

- Wallet with 0 deposited → total = base (1.50 default). Mocked `assetsOf = 10_000_000` →
  total = 11,500,000 raw. Mocked cap-level `100_000_000` → 101,500,000.
- Gateway throw / missing selector / missing manifest key → base; **a test asserts the
  raise is never granted on a failed read**, and never refused below base.
- `K` env: absent → 1.000; `0` → base only; custom value respected.
- Claim, preflight, and explain report the identical total for the same wallet+state;
  the explain decomposition sums exactly.
- Refusal copy includes the pool reference iff the manifest has the key (both directions
  tested).
- #1086's flat-hook pinning test is **deliberately replaced**, not deleted — the new pin is
  the formula.
- Cache: second read within TTL does not hit the gateway (call-count assertion).
- No changes to `contracts/`, `deployments/`, `S`/`E`/`D`-window semantics, or specHash files.

## 5. Not in this packet (named so nothing is lost)

- **An MCP/HTTP deposit flow** (tool or endpoint walking an agent through
  `approve + deposit`). Today agents deposit by calling the contract directly; a guided
  flow is the next product packet once this one proves demand.
- Pool capital operations (deploying pool funds to the venue, recalls) — operator
  ceremonies, separately specced.
- Fee retention / EscrowCore v3, the epoch-1 yield seam, withdrawal UX.

## 6. One honesty note for the PR description

The allowance reads **deposited assets, not locked ones** — an agent can deposit, work at
the raised allowance, and withdraw the same day. That is accepted at this scale: the
deposit still costs Sybil-rotation effort and capital-in-motion, the raise is bounded at
101.50/day, and the bank floor holds the global line. A lock-up or withdrawal-decay
refinement is a future economics decision, not a hidden assumption — state it plainly.

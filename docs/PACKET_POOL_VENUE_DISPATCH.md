# PACKET — Pool venue dispatch driver (URGENT: live tranche parked, 46 h window)

**Author:** Claude (gates handback) · **Implementer:** Codex · **Operator:** Pascal ·
**Date:** 2026-08-14 morning · **Status:** DISPATCH IMMEDIATELY — hard deadline below.

## Live situation (all chain-verified 2026-08-14 ~06:30Z)

Yield-epoch leg A executed this morning: `DepositPoolV2.deployToVenue(2_000_000,
returnBy)` — tx `0x18175772…`, block 19443474, deployment **1**, adapterRequestId
`0x7321be3442a1c82c639cafa565a6b7778ef5576be28fd0b396794c8dd1b36f81`. Books exact
(buffer 20→18, cost basis 0→2.0, totalAssets unchanged); the 2.0 USDC sits on the
venue adapter `0xE2801E6C…9a35`; the pool door honestly reports `earning`.

**The request will never dispatch on its own: the pool lane has no off-chain
driver.** `HydrationDepositPoolAdapter.stageDeploy(bytes32, tuple)` has zero callers
anywhere in the repo; the wrapper (`getRequest(adapterRequestId)`) returns empty
after 45+ minutes and a backend restart. The v1 bank epoch was dispatched by an
operator ceremony flow built for the OPERATING adapter; the pool VA's per-request
staging surface was shipped in packet 2 with no driver behind it. Packet 6's "the
existing v2.2 dispatcher and observer own the asynchronous lane" is true for
observation and settlement (wrapper-keyed) — not for staging.

**Hard deadline:** `returnBy` = **2026-08-16T04:43:13Z**. An expired `returnBy` is
an incident by ratified policy. Fallback exists and must also be delivered by this
packet (see Scope 3).

## Scope — one script, three subcommands, ceremony conventions throughout

Extend `scripts/ops/pool-venue-ceremony.mjs` (or a sibling `pool-venue-dispatch.mjs`
sharing its helpers — implementer's choice) with the same conventions: `--profile
mainnet` required, dry-run default, write mode only `--commit --use-kms
--expected-signer`, full evidence blocks, the observability gate reused.

1. **`stage-dispatch`** — the missing middle of the lane:
   - Read the VA's pending deploy request (`activeDeployRequestId` / `getRequest`);
     assert it equals the pool's deployment-1 `adapterRequestId` and is unstaged.
   - Compose the staging frame with the SAME proven v2.2 staging machinery as the
     operating lane (`bank-xcm-v22-runtime` / staging-quote capture): fee quote →
     ×2 authorization → refund-tail accounting. **FIND #20 applies verbatim**: the
     deposit-funding leg is the local-execute leg and the runtime TRANSFORMS the
     forwarded message — the bind/preview must use the transformed frame, not the
     send-leg law.
   - `stageDeploy(requestId, frame)` on the VA, then drive the wrapper dispatch for
     the lane (`depositPoolLane` `0x88eE7027…371f`, registered under
     `HYDRATION_USDC_POOL_V1`). The VA's `poolRequestForLaneRequest` mapping is the
     pool-request→lane-request bridge; the implementer owns the exact leg
     choreography — they built the contracts. Surfaces observed from the ABI:
     `stageDeploy`, `stageRecall`, `cancelUnstaged`, `claimSettled`,
     `releaseRecoveredToPool`, `activeDeployRequestId`, `poolRequestForLaneRequest`.
   - Postconditions in the evidence block: wrapper request live for the lane;
     dispatch legs' tx hashes; fee ledger (committed = principal + float + fees,
     v1-epoch exactness standard).

2. **`status`** — read-only: VA request state, lane request state, wrapper request
   state, far-side aUSDC position (the epoch-1 Hydration evidence pattern), so the
   operator can watch the crossing without improvised casts.

3. **`cancel`** — the tooled fallback: `cancelUnstaged(requestId)` +
   whatever return-path call restores the 2.0 to pool buffer
   (`releaseRecoveredToPool` if that is the shape), with postconditions asserting
   buffer 18→20 and cost basis 2.0→0 exactly. **This subcommand must exist even if
   stage-dispatch works** — the abort path stays tooled forever.

## Constraints (non-negotiable)

- Touches ONLY this request; never the operating lane's position or its adapter.
- Fee guards mandatory (quote ×2 ceiling, refund tail accounted); amounts bounded
  to the 2.0 tranche.
- KMS operator signer only (`0x5a6836…5813`); the script never accepts a raw key.
- Fail-closed everywhere: any books-vs-chain mismatch stops with a named error.
- Timing rule: if the driver is not CI-green, gated, and executed with ≥6 h margin
  before `returnBy`, the operator runs `cancel` instead. Build order accordingly:
  **`cancel` and `status` first, `stage-dispatch` second.**

## Acceptance (Claude gates)

- Dry-run evidence block matches my independent chain reads at the same head.
- Injected-mismatch tests fail loud (wrong requestId, already-staged, stale
  observability, fee over ceiling).
- Live: the 2.0 crosses to Hydration carrying the requestId; observer settles;
  `pool.settleVenueDeployment(1)` becomes runnable (leg B); every raw unit
  reconciles (v1 epoch standard: exact fee decomposition, refund tail).
- `cancel` proven by test (not live, unless we take the fallback).

## Not in scope

Automatic/scheduled dispatch (a follow-up once the manual ceremony is proven —
same sequencing as every money rail here) · recall staging beyond what leg C needs
(`stageRecall` mirrors, same machinery) · touching packet 6 policy numbers.

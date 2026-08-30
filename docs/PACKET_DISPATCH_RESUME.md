# PACKET — `stage-dispatch` cannot resume a partially dispatched ceremony

Status: **READY FOR CODEX — BLOCKING, FUNDS ARE MID-FLIGHT** · 2026-08-30 ·
Author: Claude (architect+gate) · Repo: **platform** · One PR.
**No contract changes. No economics, fee policy, or leg construction changes.**

## Exactly where the money is

Verified live 2026-08-30T11:39Z:

| fact | value |
|---|---|
| pool `venuePrincipalCostBasis` | 4.500000 |
| venue `reservedDeployAssets` | **0** (consumed) |
| lane `pendingDepositAssets` | **4.500000** |
| lane request | `0x7a8bd8aa…` (staged) |
| wrapper `bitmap` | **`1`** — leg 0 done |
| wrapper `parameters` | sell 4450000, minOut 4450000, fee 40000 |
| Hydration asset-22 balance | 1,518,569 → **6,017,926** |
| Hydration aUSDC | 14,738 → **14,738 (unchanged)** |

**Leg 0 (`deposit_funding`) executed and the funds are at Hydration** — the
+4,499,357 delta matches the simulation exactly. **Leg 1 (`deposit_sell`), the
swap into aUSDC, has not run.** The USDC is sitting as asset 22, earning
nothing.

That is precisely the state the old `Swapped` guard produced: it refused to
sign leg 1 (stack trace at `pool-venue-dispatch.mjs:1707`, the `deposit_sell`
dispatch) after leg 0 had already landed. #1319 fixed the guard, but the
script now refuses to run at all because `assertUnstaged` sees the staged
request.

## The gap

`stage-dispatch` always performs stage → `deposit_funding` → `deposit_sell`,
and `assertUnstaged` aborts if the request is already staged. **A multi-step
money ceremony has no resume path, so any partial failure strands it** — which
is not an edge case, it is the normal consequence of a guard firing between
legs.

## What to build

Make `stage-dispatch` **resumable and idempotent**:

- If the pool request is already staged, **do not abort.** Verify the existing
  lane request matches what this invocation would have staged — same sell
  amount, minimum output, max fee per leg, deadline, and nonce — and continue.
  **If any parameter differs, refuse loudly**; a mismatch means the on-chain
  staging was made for different terms and must never be silently adopted.
- Skip any leg whose bit is already set in the wrapper bitmap, and report it as
  skipped rather than pretending it ran.
- Dispatch only the remaining legs.

**Every existing guard must still run for each leg actually dispatched** —
`assertDispatchable`, the fee resolution, the staging-margin check, and
`assertDryRunEvidence` including the forwarded-paraId and swap semantics.
Resuming must not mean skipping verification; it means not repeating work
already committed on-chain.

## Non-negotiables (each pinned by a test)

1. An already-staged request with **matching** parameters resumes.
2. An already-staged request with **any differing** parameter refuses, naming
   the field.
3. A leg whose bitmap bit is set is skipped and reported as skipped.
4. Remaining legs still run every guard — proven by mutation that a bad
   dry-run still refuses on a resumed run.
5. A fully-unstaged request behaves exactly as today.
6. No change to fee policy, leg construction, or dispatch parameters.

## Time box

`returnBy` is **2026-09-04T16:25:12Z** (~5 days). The position is currently
**worse than either end state**: the funds have paid transport to reach
Hydration but sit in a non-earning asset. Completing leg 1 is strictly better
than leaving it, and better than recalling from this state.

## Measurement note — one number is already banked

Transport friction is now **measured, not simulated**: 4,500,000 sent,
4,499,357 received = **643 raw (0.000643 USDC)**. Record it. The epoch-3
prior of 0.100000 for total entry friction now looks like it was dominated by
something other than transport, and **days at venue must be counted from when
leg 1 lands**, not from the deployment timestamp — the asset only starts
earning when it becomes aUSDC.

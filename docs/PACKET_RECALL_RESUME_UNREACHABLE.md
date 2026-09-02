# PACKET — The recall resume path cannot run in the state it exists for

Status: **READY FOR CODEX — BLOCKING, 4.429013 USDC IS PARKED MID-FLIGHT** ·
2026-09-02 · Author: Claude (architect+gate) · Repo: **platform** · One PR.
**No contracts. No funds move as part of this PR** — it unblocks an operator
ceremony that is currently stuck.

## Live situation

Recall 6 on legacy pool `0x6061f0aC…` staged successfully on 2026-09-01. The
**sell leg completed**: aUSDC at the venue went 4.465335 → **0.015351**, and
**4.429013 USDC (asset 22) is parked** at the venue account on Hydration
(`floatAsset22` 1.546105 → 5.975118).

The **return leg was never dispatched** — `requestDispatchBitmap` is **4**. The
pool still reads `returned = 0.000000`, status Pending. `returnBy` is
2026-09-04T16:25:12Z.

## The defect

`pool-venue-dispatch.mjs` detects this state correctly:

```js
const isResume = stagedLaneRequestId !== ZERO32;          // true
resumeState = { bitmap, sellDone: resumeBitmap === 4n };   // sellDone = true
```

…and then, inside the resume branch (line ~1426), unconditionally does:

```js
const quote = await captureParQuote(args.hydrationWs, BigInt(resumeRecord.context.shares), {
  assetIn: 1003,
  assetOut: 22,
  quoteAccount: convertedAccountId32,
  quoteAccountBalance: state.farSide.aUsdc.raw,     // 15351 — the sell already ran
});
```

`captureParQuote` throws when `quoteAccountBalance < sellAmount`:

```
Supplied asset-1003 quote account cannot support the exact 4450000 read-only quote.
```

**`sellDone === true` means the asset-1003 balance is gone by design.** So the
resume preflight demands a precondition that the state it resumes from
guarantees is false. The path is unreachable exactly when it is needed, and
`resumeState.sellDone` is computed but never consulted here.

## The fix

**When `sellDone` is true, do not re-quote the unwind.** There is nothing left
to quote — the swap is history, and its actual fill is already observable
on-chain. Options, in preference order:

1. **Skip the par quote when `sellDone`**, and record the *executed* swap as
   evidence instead of a hypothetical quote. The file already has the concept:
   `resumedHistoricalLeg: true` (~line 1551).
2. If a live quote is genuinely wanted for the *remaining* leg, quote **that
   leg's asset and amount** (asset 22, the parked float), not the consumed
   asset-1003 position.

**Do not** loosen `captureParQuote`'s balance assertion generally — it is
correct for the pre-sell case and caught a genuine duplicate-staging attempt
during this ceremony.

## Non-negotiables (each pinned by a test)

1. A resume with `bitmap === 4` (sell done, return leg owed) **reaches the
   dispatch step** — prove with a fixture whose asset-1003 balance is near zero.
2. A resume with `bitmap === 0` still takes the full pre-sell preflight
   including the par quote.
3. `bitmap === 12` still refuses with the existing "settle-only resume is not
   implemented" error.
4. The pre-sell duplicate-staging refusal is unchanged — a fresh stage against
   a drained account still fails.
5. Evidence for a `sellDone` resume records the executed swap, and is clearly
   distinguishable from a live quote.

## Operator note

Do not hand-drive the return leg around this script. The dispatcher runs a
just-in-time dry run before each leg's signature; bypassing it forfeits the
protection that has already caught two mistakes in this ceremony.

## Handback

PR number; green CI; the five test names; and confirmation that a `bitmap 4`
resume against a near-zero asset-1003 balance now proceeds to dispatch.

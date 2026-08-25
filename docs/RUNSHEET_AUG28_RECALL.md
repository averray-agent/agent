# RUNSHEET — Aug 28 venue recall (legacy operator float)

> **SUPERSEDED 2026-08-25 — DO NOT EXECUTE.**
> Replaced by `RUNSHEET_VENUE_RECALL_V2.md`. Step 0 disproved this
> document's central premise: the request named below as "staged and
> pending" is venueRecall[4], already settled against deployment 2. No
> recall references deployment 3. The recall must be *staged*, not
> dispatched, and the 40k/26,000 fee figures here are the deploy-side
> ceiling, not the recall's 80k/53,333. Kept for history only.

Status: **DRAFT — for the operator, 2026-08-28** · Author: Claude ·
Executor: Pascal (every money step) · Gate: Claude (every output before
`--commit`)

Authority: `MEMO_LOCKED_TIER_LADDER.md` §6 — *"The Aug 28 recall-and-pause of
the operator float stands regardless — this memo is about whose capital rides
next time the lane opens (consenting locked capital, at scale, behind the
gate)."* L11(f) sequences it: recall the legacy unconsented float, then the
consented labeled seed is what rides next.

## Read this first: the position is not what the memo assumed

Measured live 2026-08-25 (all reads reproducible from any RPC):

| fact | value | source |
|---|---|---|
| pool totalAssets | 20.395226 | `poolV2.totalAssets()` |
| pool totalSupply | 20.501328 | `poolV2.totalSupply()` |
| share price | 0.994824 | assets ÷ supply |
| buffer (home, undeployed) | 10.895226 | `poolV2.bufferAssets()` |
| **venue principal (cost basis)** | **9.500000** | `poolV2.venuePrincipalCostBasis()` |
| **actual aUSDC at the venue** | **9.414582** | Hydration ERC-20 `balanceOf` on the converted account |
| **unrealised shortfall** | **−0.085418** | actual − cost basis |

**The consequence: recalling realises a loss.** The pool carries the venue leg
at cost basis (9.5) while the venue actually holds 9.414582. Bringing it home
converts an unrealised shortfall into a realised one, and the pool's
accounting must then be told — there is a `writeOffVenueLoss` path whose
authority is the **2-of-3 treasury owner multisig**. Expect XCM fees on top,
so the realised gap will be larger than 0.085418.

This is not a reason to delay. It is a reason to do it deliberately, with the
write-off planned as part of the ceremony rather than discovered after.

## There is already staged state — do not re-stage

A lane request is staged from earlier work:

```
requestId 0xe1029b108839059c6526077f8afbedd7e8c2130cabc29137d0260fa105e57ba3
```

with a fee-watch helper (`scratch-fee-watch.mjs`, read-only) that polls
`quoteRemoteFee` and exits when `fee × 1.5` fits under the staged **40 000**
cap — threshold 26 000 with margin.

**Step 0 is therefore to establish state, not to act.** The runsheet-already-ran
law applies: a duplicate ceremony cost ~1 DOT and two signing rounds on
2026-08-16.

## The ceremony

### 0 · Establish state (read-only, no signatures)

1. Re-read the position table above; if any figure has moved materially,
   stop and tell me before continuing.
2. Read the staged request's live state (`readLiveRequest` on that
   requestId) — is it still pending, already dispatched, or finalised?
3. Run the fee watch `--once`. Record the quoted remote fee.

**Gate:** paste all three outputs to me. I confirm the request is genuinely
pending and the fee fits the cap before anything is signed.

### 1 · Dispatch when the fee window is open

Only if step 0 shows the request pending **and** the quoted fee is under the
threshold. The fee is volatile; the watcher exists because the window opens
and closes. If it is shut, wait — a wider cap is a new staging decision, not
a retry.

**Gate:** I check the dispatch output before you commit it.

### 2 · Wait for arrival, then finalise

Funds land back on Asset Hub asynchronously. Confirm arrival by reading the
converted account's balance **falling** on the Hydration side and the home
side rising — both, not one. Then finalise the request.

**Gate:** paste both balance reads. Two-sided confirmation is the rule; a
single-sided read has misled us before.

### 3 · Reconcile the pool (multisig)

Compare what actually arrived against the 9.5 cost basis. The difference —
venue shortfall plus XCM fees — is the realised loss, and the pool's
accounting is corrected via `writeOffVenueLoss` under the **2-of-3 treasury
owner multisig**.

**Multisig law applies in full:** I precompute the `blake2AsHex` call hash;
you confirm Nova displays *exactly* that hash before the Vault signs. A
build helper exists (`scratch-writeoff-encode.mjs`) — treat its output as a
draft I gate, never as a signed instruction.

**Gate:** I verify the encoded call and the hash before the first signature.

### 4 · Pause, and hand the lane to consented capital

After reconciliation the venue position is zero and the lane is idle. It
stays idle until the **activation gate opens on locked capital** — which is
the point of the whole exercise. With L2a shipped, your 25 USDC T90 seed
clears the gate at ~2.5× margin, so the next deployment is consented,
labelled, capped, and inside the gate; the unconsented operator float does
not return.

**Gate:** confirm `venuePrincipalCostBasis()` reads 0 and the board's bank
lane shows the position closed.

## Abort conditions (any one ⇒ stop and report)

- The staged request is not in the state step 0 expects.
- The quoted fee exceeds the staged cap (wait; do not raise the cap ad hoc).
- Arrival is confirmed on only one side.
- The realised loss materially exceeds the 0.085418 + fees estimate — that
  means something moved that we have not accounted for.
- Nova shows any hash other than the one I precomputed.

## What this runsheet does not do

Deploy anything new, touch the locked cohort, change the activation gate, or
alter the per-wallet cap. It ends with the lane empty and idle.

# PACKET — "COMMITTED EVIDENCE" records one confirmation and calls it done

Status: READY FOR CODEX · 2026-09-01 · Author: Claude (architect+gate) ·
Repo: **platform** · One PR. **No contracts, no funds.**
Found during the live recall of deployment 4.

## What happened

`pool-venue-ceremony.mjs recall --commit` printed a `# COMMITTED EVIDENCE`
block asserting:

```
transaction.hash        0xb9a69a4135b41134cd8c24eba307d26ca26c76eea672de18ca1b7fd9131b3aef
transaction.blockNumber 20129539
transaction.blockHash   0x74c8c52ed74836b2f4effc6514c224e0384382c7899920de0c7f4799a215100f
transaction.status      1
postState.activeVenueRecallId  6
postState.nextVenueRecallId    7
```

Minutes later the chain read: **block 20129539 had hash `0x36997bf1…`**, the
transaction receipt was **absent**, `venueRecalls(6)` was **empty**, and
`nextVenueRecallId` was **back to 6**.

The chain had reorganised. The transaction was later **re-included at block
20130332** and the recall is now live — but for a window, the evidence file
described a state that did not exist.

## Why this matters

The evidence blob is our record that a mainnet money ceremony happened. It is
what we cite afterwards. Today it was **briefly false**, and nothing in the tool
would ever have told us. If the reorg had dropped the transaction permanently:

- the evidence file would still assert a successful recall
- `postState` would still show `activeVenueRecallId: 6`
- and the exit-friction measurement would have been computed from a recall that
  never happened

**One confirmation is not finality.** The tool treats it as such.

It also cost a wrong diagnosis: reading the chain once during the reorg window
produced a confident "the transaction was dropped" that was wrong, and an
instruction to re-run. The script's own `VenueRecallAlreadyActive` guard caught
it — the tooling was safer than the operator.

## What to build

**A — Re-verify before writing evidence.** After the receipt, wait for **N
confirmations** (make N configurable, default at least 8 on this chain) and
**re-read the receipt and the post-state** before emitting
`# COMMITTED EVIDENCE`. If the block hash at that height no longer matches the
receipt's, do not emit success.

**B — Record what was verified.** Add to the evidence block: confirmations
waited, the block hash re-read at that height, and a `finality` field stating
plainly whether the post-state was re-confirmed.

**C — Fail loudly on divergence.** If re-read state contradicts the receipt,
print a clearly-marked reorg warning naming both hashes and exit non-zero. A
ceremony that cannot be confirmed must not print an evidence block that looks
identical to one that can.

**D — Same treatment for `deploy` and `settle`.** All three commands emit the
same blob and all three have the same defect.

## Non-negotiables (each pinned by a test)

1. A receipt whose block hash no longer matches at re-read yields a **failure**,
   not an evidence block — prove by mutation with a stubbed provider.
2. The evidence block carries confirmations waited and the re-read block hash.
3. A successful ceremony still emits evidence in the existing shape plus the new
   fields — downstream readers must not break.
4. The wait is bounded and reports progress; it never hangs silently.
5. No change to guards, signing, or the transactions themselves.

## Out of scope

The recall in flight (deployment 4 / recall 6 — leave it alone), and any change
to pool contracts.

## Handback

PR number; green CI; the five test names; the chosen default confirmation count
with reasoning; and the new evidence-block shape.

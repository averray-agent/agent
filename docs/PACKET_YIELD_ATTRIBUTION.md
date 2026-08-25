# PACKET — Separate what the venue earned from what we added

Status: READY FOR CODEX · 2026-08-25 · Author: Claude (architect+gate) ·
Repo: **platform (averray-agent/agent), mcp-server** · One PR.
Authority: `MEMO_YIELD_SUBSIDY.md` **Y3** and `MEMO_IDLE_BALANCE_YIELD.md`
**B5**, both RATIFIED. No contract work. Nothing moves funds.

## Why this blocks other things

Y2 pays the venue round-trip cost into the pool by direct USDC transfer.
`bufferAssets()` reads the pool's raw token balance, so that transfer lifts the
share price **invisibly to pool accounting** — indistinguishable from venue
earnings on every surface.

Two ratified decisions depend on this existing first:

- **Y2's subsidy may not be paid** until the split is live, or we would be
  presenting operator money as yield.
- **The tier ladder** (locked tiers pay *above* the base rate) is funded by
  operator premium, and a premium that cannot be shown as a premium is a
  cross-subsidy in disguise.

## The constraint that shapes the design

**The USDC precompile emits no Transfer logs.** This is already recorded in
`payout-receipt-backfill.js`:

> *"…because the USDC precompile emits no Transfer logs."*

So a subsidy transfer to the pool **cannot be enumerated from chain.** Any
single transfer is independently verifiable by its tx hash; the *completeness*
of a list is not provable by scanning. We could omit one and no external
observer could detect it by reading the chain.

**Therefore the disclosure must describe itself accurately:** the subsidy
record is **operator-attested, with each entry independently verifiable by
transaction hash**. It must **not** be presented as chain-derived, reconciled,
or provably complete. Overstating the provenance of an honesty mechanism is
worse than not shipping it — it converts a disclosure into a claim we cannot
back.

## What to build

**A — A subsidy ledger.** Every operator contribution recorded with at least
amount, timestamp, and **transaction hash**, so a reader can verify any entry
themselves. Append-only in spirit: corrections are new entries, not edits.

**B — Pool-level attribution.** Cumulative NAV gain split into **venue-earned**
and **operator-added**, derived from the ledger. Both figures, with the
attestation caveat above, on the surfaces that already show `nav` and
`markedSharePrice`.

**C — Per-agent attribution (B5).** An agent must be able to see what its own
balance gained. In a share-price model an agent's gain is inherently
time-weighted — `shares × (currentPrice − entryPrice)` — so entry price is the
thing to track, not a running yield accrual.

**Do not invent precision the data does not support.** If per-agent
venue-versus-subsidy attribution cannot be derived honestly for an agent's
specific holding period, report the agent's own gain plus the **pool-level**
split ratio, and say that is what it is. A stated approximation is honest; an
unstated one is not.

**D — It must read correctly when there is nothing to show.** Zero subsidy,
zero deployment, and zero gain are the current state and must produce clear
output rather than empty fields or a misleading zero-rate.

## Non-negotiables (each pinned by a test)

1. **A subsidy-driven price rise is never reported as venue earnings.** Mutate
   the ledger — add a contribution with no venue movement — and the surface
   must attribute the gain to the operator, not the venue. Prove it by
   mutation, not by asserting a fixed value.
2. **The attestation caveat is served with the figures**, in the payload, not
   only in documentation. A test asserts the wording is present.
3. **No surface describes the subsidy record as chain-derived, reconciled, or
   complete.** Assert the absence of those claims, the same way #1291 asserts
   the absence of "NAV share active".
4. **Per-agent gain uses entry price**, and a test proves an agent who joined
   after a gain is not credited with it.
5. **The zero state is legible** — no deployment, no subsidy, no gain produces
   honest output, not blanks.
6. No contract, balance, position, allocation, or settlement path changes.

## Out of scope

The pool contract change (R2/R3), the allocation keeper, paying any actual
subsidy, the tier premium's *size*, and anything that moves funds. This packet
makes the split reportable; it does not fund it.

## Handback requirements

PR number; green CI; the six test names; the served payload for both the
current zero state and a worked non-zero example; the exact attestation
wording; and confirmation that no contract, balance, or settlement path
changed.

# PACKET — Lead with what a deposit does, not what it lacks

Status: READY FOR CODEX · 2026-08-30 · Author: Claude (architect+gate) ·
Repo: **platform, marketing + mcp-server** · One PR. **No contracts, no funds.**

## The problem

The live `/pool` page headlines the black card with:

> **"A deposit today earns nothing."**

That is accurate and it was the right instinct — the previous draft risked
implying yield that does not exist. But it states only the absence, so it reads
as *do not deposit*, when the truthful position is that a deposit buys
something real today: **operational headroom**, live now via the non-yield tier
perks.

## The change

**Lead with the live benefit, keep the absence explicit in the same breath.**

Suggested headline — adjust the wording, keep the shape:

> **"Today a deposit buys headroom, not yield."**

This is not a softening. "not yield" is in the headline, unmissable. What
changes is that the sentence now also carries the true, present-tense benefit
instead of leaving the reader with only a negative.

Keep, unchanged:

- the served `venueMark.statement` paragraph in full, including
  "which is currently being re-measured"
- the API-served risk disclosure, verbatim and above the fold
- the `not yet earning` status pill, rendered from `yieldStatus`
- the absence of any rate, APY, projection, or yield date

## Non-negotiables (each pinned by a test)

1. The headline still contains an explicit negation of yield — assert that a
   reader cannot come away believing deposits earn today. **Mutate the headline
   to a yield-implying phrase and the test must fail.**
2. `yieldStatus: "not_yet_earning"` still renders above every deposit control.
3. Still no rate, APY, projection, or yield date anywhere — unchanged.
4. The risk disclosure still follows the served API statement under mutation.
5. No numeric figure enters markup.

## The line that must not be crossed

The reason the blunt version existed is sound: **never make the product look
more live than it is.** The bar for this change is that a sceptical reader who
scans only the headline still learns there is no yield. If a proposed wording
fails that, it is worse than the current copy and must not ship — say so
instead of shipping it.

## Also in scope — the same sentence everywhere

`getDepositPoolInfo` and any other surface serving this copy must carry the
same framing, so an agent reading the tool output and a human reading the page
get the same answer.

## Handback

PR number; green CI; the five test names; the final headline; and the mutation
that proves a yield-implying headline fails.

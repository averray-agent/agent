# PACKET — The pool serves a threshold our own measurement contradicts

Status: **READY FOR CODEX — ships to a public page** · 2026-08-30 ·
Author: Claude (architect+gate) · Repo: **platform, mcp-server** · One PR.
**No contracts, no funds.**

## The defect

`mcp-server/src/services/deposit-pool-yield-status.js:2` serves, via
`GET /pool` → `venueMark.statement`:

> *"…The venue lane can reopen when deployable pool TVL reaches **approximately
> 62 USDC** or the seven-day cap is amended…"*

That figure derives from an epoch-3 round-trip friction of **0.129576**.

**On 2026-08-30 we measured entry friction at 0.022464** — transport 0.000643
plus sell execution 0.021821, reconciling to the raw unit, with the swap
filling at exact par. **4.45× cheaper than the prior the 62 was computed from.**

Exit friction is still unmeasured (recall due 2026-09-04). So the served number
is not merely stale — **we now have positive evidence it is wrong, and no
evidence for what replaces it.**

#1330 makes this public. The page is correct: it renders the served statement
faithfully and passes its own no-baked-figure tests. **The defect is upstream.**

## What to change

**Remove the numeric threshold until it can be derived from measured values.**
State the condition without inventing a figure: the lane reopens when
deployable TVL is sufficient against measured round-trip friction, and that
friction is currently being re-measured.

**Do not substitute a new number.** We have one direction of one round trip.
A threshold computed from half a measurement is the same mistake with a
different digit.

**Where a figure eventually returns, derive it** from recorded friction and the
deployment window rather than a literal in source — the same rule the pool page
already follows for every other number.

## Non-negotiables (each pinned by a test)

1. No numeric TVL threshold appears in any served yield-status statement —
   assert the absence.
2. The statement still says plainly that deposits do not currently earn.
3. The capital-signal sentence is unchanged: a vested deposit is a
   trust-and-capacity signal, never catalogue reward entitlement.
4. `yieldStatus` and `venueMark.status` semantics are untouched.
5. No change to pool figures, caps, or exit terms.

## Why this is worth a PR of its own

The page's whole claim is that every figure is live and nothing is asserted
beyond what is read. A hardcoded forecast, served through the API and rendered
faithfully, defeats that from behind — and it is exactly the failure the page's
own tests cannot catch, because the page is behaving correctly.

## Handback

PR number; green CI; the five test names; and the exact new statement text.

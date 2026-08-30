# PACKET — The dispatch guard expects an event Hydration no longer emits

Status: **SHIPPED — #1319 merged 2026-08-30; Swapped3 now accepted** · 2026-08-30 ·
Author: Claude (architect+gate) · Repo: **platform, mcp-server** · One PR.
**No contract changes. Nothing about economics, legs, or fee policy.**

## The defect

`stage-dispatch --commit` refuses:

> `Exact XCM dry-run did not emit expected Broadcast.Swapped; refusing to sign.`

`bank-xcm-flow.js` (~:469 and ~:478) expects the literal
`{ section: "Broadcast", method: "Swapped" }`, and `eventMatches` (~:430)
compares `method` by **exact** case-insensitive equality.

**Hydration emits `Broadcast.Swapped3`.** Evidence, all from this repo and this
machine:

- the live staging dry run on 2026-08-30 reported
  `freshParQuote.quote.runtimeEvent: "Swapped3"`
- `mcp-server/src/services/bank-deposit-evidence.js:51` describes the expected
  evidence as `Broadcast.Swapped3{AAVE, asset 22 -> aUSDC 1003}`
- `mcp-server/src/demo/backfill-bank-v22-deposit-evidence.js:119` requires
  `method === "Swapped3"` and fails otherwise
- `scripts/ops/pool-venue-dispatch.mjs` matches with `/^Swapped/u` — a prefix
  test that already accommodates the versioned name

So the runtime name is versioned, several call sites were updated for it, and
**this one guard was missed.** The swap is valid; the assertion is stale.

## What to change — and what must NOT

**Change:** make the dispatch guard match the event Hydration actually emits.
Prefer matching the same way `pool-venue-dispatch.mjs` already does
(`section === "broadcast"` and method matching `/^Swapped/`), so a future
`Swapped4` does not repeat this outage. Apply it to **both** call sites.

**Do not weaken anything else.** The guard must still require:

- `evidence.ok === true` and `executionSucceeded === true`
- the forwarded-paraId check
- every existing semantic check on the swap — AAVE filler, asset `22 → 1003`,
  filler-par, accrual-bounded

**This PR relaxes ONE thing: the exact spelling of a runtime event name.** It
must not become "any Broadcast event passes," and it must not touch the
`Tokens.Deposited` or `Assets.Deposited` expectations.

## Non-negotiables (each pinned by a test)

1. `Broadcast.Swapped3` satisfies the guard; so does `Broadcast.Swapped`.
2. A **wrong section** (e.g. `Router.Swapped3`) still refuses.
3. A missing swap event still refuses — prove by mutation.
4. `executionSucceeded !== true` still refuses.
5. The forwarded-paraId check is unchanged and still refuses a wrong sibling.
6. No change to fee policy, leg construction, or dispatch parameters.

## Live context — why this is time-boxed

Deployment **4** is open on legacy v2: 4.500000 USDC held by venue adapter
`0xE2801E6C…` **on Asset Hub**, nothing at Hydration yet, `returnBy`
**2026-09-04T16:25:12Z** (~5.2 days). The staging dry run is otherwise clean —
all six guards true, par quote 1:1 AAVE with zero accrual, both simulated
executions `Complete`, 5.25 days of deadline margin.

If this is not fixed in time the fallback is a recall of an undispatched
deployment, which costs gas and forfeits the measurement.

## The wider pattern, worth one line in the PR body

This is the third stale-literal defect this week, after a manifest key that
changed meaning at the cutover and an ABI struct with the wrong field count.
**A literal copied from an external system is a fact with an expiry date.**
Where the same fact is asserted in several places, they should agree — here
four call sites described the same event and one disagreed.

## Handback

PR number; green CI; the six test names; and confirmation that the semantic
swap checks (AAVE, 22→1003, par, accrual bound) are byte-for-byte unchanged.

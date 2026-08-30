# PACKET — The public pool page, built for what the pool actually offers

Status: READY FOR CODEX · 2026-08-30 · Author: Claude (architect+gate) ·
Repo: **platform, marketing** · One PR. **No contracts, no funds, no new
endpoints.**

## The gap

`averray.com/pool` returns **404**. The operator app has a pool surface (#1301,
verified by QA as matching live), but the page a prospective depositor would
land on does not exist. QA also notes there is no live-v2.1 badge and no
deposit CTA, hence no venue terms anywhere public.

## The thing that decides the page's content

`GET /pool` reads, live: **`yieldStatus: "not_yet_earning"`**,
`venueMark.status: "not_deployed"`, and pool v2.1's `venueAdapter()` is
`address(0)`.

**So a deposit today earns nothing.** A conventional "deposit and earn" page
would be false, and a page that buries that is worse than the 404 it replaces.

**But the honest offer is not nothing.** The ratified commitment ladder makes
Flex a **membership, not a yield product**, and its non-yield perks are live
right now: bank-linked open-exposure caps, priority claim access from 7 days,
credit qualification from 30. A depositor today buys **operational headroom**,
not a return.

**Build that page.** Lead with what a deposit actually does, say plainly that
venue yield is not currently earning, and let the perks carry the offer.

## What ships

**A — The state of the pool, from the API.** Total assets, buffer, share price,
caps, and the venue mark — **every figure fetched live, none in markup** (the
standing transparency law). Show `yieldStatus` as served, including the
not-yet-earning state, rather than hiding it behind a spinner.

**B — The disclosure, unconditionally and above the fold.** `GET /pool` already
serves it: *"Technical pilot. Principal at risk. No depositor protection."*
Render it from the API field so it cannot drift from the served truth — the same
mutation test used on the Verify page.

**C — What a deposit buys today.** The live perk ladder, described as
operational benefits. **Do not imply a rate, a projection, or a future yield
date.** "When a venue is bound" is acceptable; "expected APY" is not.

**D — Exit terms, matching R4.** Synchronous while the adapter's uncommitted
balance covers it, queued with a disclosed ETA beyond that. Never "instant".

**E — The two-pool reality.** v2.1 is live and takes new deposits; legacy v2
still holds an external depositor and the earning venue position. Label both;
do not hardcode either address.

## Non-negotiables (each pinned by a test)

1. No numeric figure in markup — grep-proof, as on the transparency page.
2. The risk disclosure renders from the API field; mutate the served statement
   and the page must follow.
3. No rate, APY, projection, or yield date appears anywhere — assert the
   absence.
4. While `yieldStatus` is `not_yet_earning`, the page says so in words a
   depositor would read, above any deposit control.
5. Both marketing allow-lists updated, or the page silently never deploys —
   name the two files in the handback.
6. Truth-boundary review before handback.

## The judgement call, stated so it can be overridden

A deposit CTA on a pool earning nothing invites people to take principal risk
for perks alone. That is a defensible product — it is exactly what the ratified
Flex tier is — **but only if the page says so in those words.** If the copy
cannot be made to read honestly without sounding like a bad deal, that is
information: it means the page should wait for a bound venue rather than be
softened.

## Out of scope

Ceremony B and the venue binding (deferred by operator decision until the
2026-09-04 measurement), yield tiers, and any change to pool contracts.

## Handback

PR number; green CI; the six test names; the full rendered copy; the two
allow-list files; and confirmation that every figure is fetched rather than
baked.

# PACKET — The operator pool page does not say which pool it is showing

Status: READY FOR CODEX · 2026-09-04 · Author: Claude (architect+gate) ·
Repo: **platform, app** · One PR. **No contracts, no backend, no funds.**
Raised by QA on 2026-09-04.

## The gap

`app/app/pool/page.tsx` renders `DepositPoolSurface`, which contains **no**
reference to a pool version, generation, or address. An operator looking at
`/pool` cannot tell which of the two live pools they are reading.

**Two generations coexist, and they differ materially:**

| | |
|---|---|
| **v2.1** `0x9B35A102…` | the live pool — takes new deposits; `venueAdapter() == address(0)`, so it cannot earn |
| **legacy v2** `0x6061f0aC…` | holds the external depositor's 5.026011; carried the venue position; has a bound adapter |

`GET /pool` already serves the identity — `pool: "0x9B35A102…"` — so the data is
there and unrendered.

**The public transparency page already labels both** ("LIVE V2.1" / "LEGACY
V2"). The operator surface being *less* informative than the public one is
backwards.

## What to build

Render the pool's identity on the operator surface, from the API response:

1. A generation label ("Live v2.1"), derived from the served `pool` address
   matched against the manifest — **never a hardcoded string**.
2. The address itself, visible and copyable.
3. The venue state as served (`venueMark.status`, `yieldStatus`), so an
   operator can see at a glance that the live pool is not yet earning.

Match the transparency page's vocabulary so the two surfaces read consistently.

## Non-negotiables (each pinned by a test)

1. The label is derived from the served address, not hardcoded — mutate the
   served `pool` to the legacy address and the label must follow.
2. No numeric figure enters markup; every value stays fetched, as elsewhere.
3. An unreadable `pool` field renders "unavailable" rather than guessing a
   generation.
4. The existing surface's behaviour is otherwise unchanged.

## Out of scope

The public `/pool` page (shipped, #1330), any backend change, and the yield copy
— that is `PACKET_POOL_PAGE_TONE.md`.

## Handback

PR number; green CI; the four test names; and a screenshot or rendered text of
the surface showing the generation label and address.

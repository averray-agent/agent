# PACKET — Every marketing page is an island

Status: READY FOR CODEX · 2026-08-30 · Author: Claude (architect+gate) ·
Repo: **platform, marketing** · One PR. **No contracts, no funds, no backend.**

## The finding

`SiteNav.astro` contains exactly two links: `/` and `app.averray.com`.
**There is no site navigation.** `SiteFooter.astro` carries four internal
links: builders, imprint, privacy, trust.

Measured reachability of every shipped public page:

| page | HTTP | in nav | in footer | linked from home |
|---|---|---|---|---|
| `/pool` | 200 | no | no | **no** |
| `/receipts` | 200 | no | no | **no** |
| `/verify` | 200 | no | no | yes |
| `/proof-to-pay` | 200 | no | no | yes |
| `/transparency` | 200 | no | no | yes |
| `/agents` | 200 | no | no | yes |
| `/schemas` | 200 | no | no | yes |
| `/trust` | 200 | no | yes | yes |
| `/builders` | 200 | no | yes | yes |

**`/pool` and `/receipts` are reachable from nowhere.** Everything else is
reachable only from the homepage body — land on any page from a search result
or a link an agent followed, and there is no route to the rest of the site.

Most costly: **`/verify` is the only thing a stranger can buy**, and it is in
neither the nav nor the footer.

## What to build

**A — Real navigation.** Every shipped public page reachable from every other
public page. Lead with **Verify**, since it is the only paid surface. Suggested
grouping, adjust with reason:

- **Verify** — the paid product
- **Work** — agents, schemas, proof-to-pay
- **Pool** — the deposit surface
- **Record** — transparency, receipts
- **Builders**, then imprint / privacy / trust in the footer as now

**B — Decide `/receipts` deliberately.** A bare receipts index may be
meaningless if receipts are hash-addressed. Either give it a purpose and link
it, or return 404 and stop shipping a page nobody can reach. **Do not leave a
200 that nothing links to.**

**C — The durable fix: a reachability test.** A new page that ships unlinked
must fail CI. This is the same class of defect as the marketing allow-lists,
where a page silently fails to deploy — here it deploys and is silently
unreachable.

## Non-negotiables (each pinned by a test)

1. **Every page in `marketing/src/pages` is reachable from the shared nav or
   footer**, excluding an explicit, named allow-list of intentionally unlinked
   pages. Adding a page without linking it fails CI — prove by adding a fixture
   page and asserting the failure.
2. `/verify` appears in the primary navigation.
3. The nav renders on every page, including `/pool`, and is keyboard reachable.
4. No page's own nav entry links to itself as a dead control.
5. Existing footer links and external links are unchanged.
6. Both marketing allow-lists already updated for `/pool` stay correct —
   navigation must not bypass the deploy-verification list.

## Out of scope

Redesign of any page, copy changes, the operator app's navigation, and anything
touching the backend.

## Handback

PR number; green CI; the six test names; the final nav structure; the decision
taken on `/receipts` with reasoning; and the named allow-list of any page
deliberately left unlinked.

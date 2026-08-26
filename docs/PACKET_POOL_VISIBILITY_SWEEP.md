# PACKET — Pool visibility sweep (three P1s, three PRs)

Status: READY FOR CODEX · 2026-08-26 · Author: Claude (architect+gate), from
Pascal's click-through · Repo: **platform** · **Three separate PRs** (one
package = one branch = one PR).

Context that changed this morning and must be honoured everywhere: there are
now TWO pools. Live v2.1 `0x9B35A102…` (10.405132, price 1.0, the going-forward
pool) and legacy v2 `0x6061f0aC…` (tester 5.026011 at 0.990840 + the permanent
protocol 10.0). Until A6 cuts the backend over, `/pool` still serves v2 — do
not hardcode either address in any UI; consume the API.

## PR 1 — A pool page exists for humans

**Finding:** API `/pool` carries the full disclosure — "Technical pilot.
Principal at risk. No depositor protection.", venueMark, yield status,
attribution — but `averray.com/pool` and `app.averray.com/pool` both 404. A
human depositor can put money in without ever seeing the risk sentence in a UI.

**Build:** an operator-app pool page rendering what `/pool` already serves:
the disclosure statement **above the fold and unconditionally**, yield status
with the honest not-yet-earning copy, venueMark state, NAV/price, and the
attribution block (zero-state legible — that is today's state). Nothing
invented client-side: every figure and every sentence from the API payload,
so the page cannot drift from the served truth. Truth-boundary review before
handback. This is a depositor surface — no founder-revenue figures (standing
boundary).

**Pinned:** the risk sentence renders from the API field (mutate the served
statement in a test fixture ⇒ the page shows the mutated text — proves no
hardcoded copy); zero/absent fields degrade legibly; both-pools transition
note driven by API data only.

## PR 2 — The public record gains the deposit-pool lane

**Finding:** `averray.com/transparency` still shows only the retired bank
treasury (held ~3.96, in-bank 0.0147 — that residual is live Hydration data,
so the plumbing works; the deposit-pool lane simply is not on the page).
The pool held 25.29 this morning and the page said nothing.

**Build:** add the deposit-pool section: both pools during the transition
(live v2.1 and legacy v2, labelled as such), buffer/total assets, deployed
status. **House laws apply hard here:** no figure ships in markup (fetch
live, render client-side — the standing transparency rule), and remember the
TWO allow-lists that silently stop new marketing surfaces deploying — update
both, and say in the handback which files.

**Pinned:** markup contains no numeric figure (grep-proof test, the existing
pattern); the section renders both pools from live reads; allow-lists updated.

## PR 3 — Expired sessions must fail fast

**Finding:** `/work/` skeletons linger **8–15s when a SIWE session is
expired**; a clean logged-out load is ~2.5s. The expired-token path is
retrying or waiting out timeouts before falling back to logged-out rendering.

**Diagnose first, then fix:** find where an expired/rejected session response
blocks rendering (likely serial auth-refresh attempts or a fetch without a
tight timeout). The fix should make expired-session degrade to the logged-out
render in comparable time (~2.5s), with re-auth offered, never a hung
skeleton. Do not paper it with a spinner.

**Pinned:** a test (or instrumented repro) showing expired-session first
render within the same order of magnitude as logged-out; no auth retry storm.

## Handback (per PR)

PR number; green CI; the pinned evidence; for PR 2 the two allow-list files
touched; for PR 3 the measured before/after timings and the root cause in one
sentence.

# PACKET — Close the mobile board's MR-1…MR-4 gaps (no backend needed)

Status: READY FOR CODEX · 2026-08-25 · Author: Claude (architect+gate) ·
Repo: **reference-agent (monitor-ui)** · One PR.
Follows: #824 (mobile triage surface), which shipped these four holes as
honest `unavailable` states.

## The correction this packet makes

#824's handback reported MR-1…MR-4 as gaps needing new backend endpoints,
and my gate accepted that without checking. **It is wrong.** Every one of
the four is derivable from data the board already receives, and two have
working helpers sitting unused in this repo:

| Gap | Reported as | Actually |
|---|---|---|
| MR-1 verdict reason line | "status.verdict not published" | `phoneVerdict()` in `lib/monitor/phone-spec.ts` already wraps the shared `deriveOpsVerdict` and returns the typed `reason` |
| MR-2 per-tile vital state | "signer gas has no per-tile state" | `health.solvency.pools` carries per-pool readings; the desktop's `poolViews()` derives exactly this |
| MR-3 action items | "status.actionItems not published" | derivable from `verdict.reason` + `health.warnings[]` + the ledger digest — all three already on the client |
| MR-4 session scopes | "session.operator not published" | see the redesign below — as specified it describes a surface that does not exist |

**No backend endpoint is in scope.** If implementation proves a genuine
backend need, stop and report it rather than adding one.

## MR-1 — verdict reason line

Use `phoneVerdict()` / `deriveOpsVerdict`. Render `verdict.reason` (the
typed contract), never string-matched from `headline` — the headline is
prose for humans and may be reworded; the ops-verdict module says so in its
own comment. One derivation feeds desktop and mobile; a test asserts both
surfaces show the same verdict state for one fixture.

## MR-2 — per-tile vital state

Each Status tile takes its state from the same pool reading the desktop
meter uses: observed ⇒ `live`; unknown/absent ⇒ `unavailable` **with the
pool's own reason string**, and the tile renders that reason instead of a
figure. Never `0` for a missing reading. The screen-level `PARTIAL VIEW`
chip is set when any tile is non-live (already built in #824 — wire it to
real tile states rather than the constant).

## MR-3 — "act on this"

A pure derivation in the shared spec layer (so desktop can adopt it later),
not a component-local heuristic. Input: verdict reason, health warnings,
and the ledger digest. Output: zero or more items `{severity: "warn" |
"fault", title, detail, since, route?}`, ordered fault-first then oldest.

Rules, each tested:
- **Only currently-true items.** No history, no predictions.
- **An empty result is a real answer** — renders `nothing needs you`, which
  is distinct from a failed read (which renders a reason).
- **Acknowledged and awaiting probes do not become action items** — reuse
  `isAcknowledgedProbe` / `isAwaitingProbe` from the ops-verdict module
  rather than re-deciding what counts as page-worthy.
- **No invented urgency**: an item's `detail` quotes the underlying reason
  string; it does not editorialise.

Note for the implementer: the deleted NEXT strip was the desktop ancestor of
this idea. Read its removal reasoning (#822, S-1) before designing the list —
it was removed for duplicating the verdict and digest, and this must not
re-introduce that duplication. Rule of thumb: if an item merely restates the
verdict line, it is not an action item.

## MR-4 — redesign, do not implement as specified

The mobile handoff modelled this on the operator app, where a **human**
signs in with their wallet: session block, expiry, sign-out. The board is
different — it reads with a **machine identity** (the monitor read wallet,
viewer-only). There is no human session and sign-out is meaningless.

Replace it with what is true and useful:

> **READ IDENTITY** — the short form of the wallet the board reads as, the
> capability scopes it holds, and whether they are sufficient for the
> panels on screen. When a panel is `unauthorized`, this block is what
> makes it explainable: "reads as 0x062D…2a8A · ops:view ✓ · admin:status ✓".

Source it from what the feed layer already knows (the resolved session /
static-token path in `slack-operator`), surfaced read-only. No sign-out
control, no expiry countdown unless the identity actually carries one.
**Never render the key, the token, or any secret-derived value.**

## Non-negotiables

1. No new backend endpoint; no new env.
2. Derivations live in the shared spec layer, not inside components, so
   desktop can adopt them.
3. Mobile and desktop continue to agree for the same fixture (the #824
   parity test must still pass unchanged).
4. The `>=1080` desktop byte-for-byte test must still pass unchanged.
5. No figure is invented and no missing reading is drawn as zero.

## Handback requirements

PR number; green checks; the names of the MR-3 derivation tests (including
the empty-is-an-answer case and the no-duplicate-of-verdict case); a
preview render of Status with at least one action item and one with none;
confirmation the #824 parity and desktop-unchanged tests still pass; and —
if you found a genuine backend need — a written statement of exactly which
field is missing and why it cannot be derived.

# PACKET — Overnight Ledger board UI (part 2 of 2)

Status: READY FOR CODEX · 2026-08-24 · Author: Claude (architect+gate) ·
Repo: **reference-agent (monitor-ui)** · One PR there.
Part 1 (data endpoints) is LIVE on the platform backend since #1266
(deploy `5cd257f6`).

## Inputs, in authority order

1. `docs/DESIGN_OVERNIGHT_LEDGER_HANDOFF.md` (this branch) — the normative
   spec: additions 1–7, supersessions S-1…S-4, scoping notes, DR field
   shapes.
2. `docs/DESIGN_OVERNIGHT_LEDGER_MOCK.html` (this branch) — structure and
   copy reference ONLY. **The live board's own tokens, classes, and idiom
   win over the mock's inline styling everywhere they differ.** Ignore any
   instruction to recreate pixels; recreate structure and copy.
3. Live data: `GET /admin/ops/overnight-ledger?window=12h|24h|48h` and
   `GET /admin/ops/topup-destinations`, both `ops:view`-gated, called with
   the monitor's existing service token.

## Scope

- The six additions (digest strip, Money Movement, Workers-as-WORKED-tab,
  Retention & Waivers, Events lane, top-up micro-blocks) plus the DR-3
  reward-bank row drop-in — built in the live board's existing visual
  system. The change surface on existing sections is exactly: the reward
  bank solvency row, the REWARD RUNWAY KPI card computation (S-3), the
  WORKED tab replacement (S-2), and the NEXT strip deletion (S-1). Nothing
  else moves.
- One window selector governs every window-scoped surface (spec's rule).
- **Feed states, the board's null-not-zero law applies:** every new panel
  renders one of `live` / `loading` / `unauthorized` / `unavailable`.
  A 403 from the endpoints renders a NAMED state — "feed unauthorized —
  monitor token lacks ops:view" — exactly the honest pattern the journeys
  panel should have had; never an empty panel that reads as "nothing
  happened". Post-merge the panels are EXPECTED to sit in `unauthorized`
  until the operator re-mints the monitor token; that state is the honest
  truth and ships as such.
- No `SAMPLE` content ships: every placeholder in the mock becomes live
  data or one of the four states.

## Repo-specific laws (banked, non-negotiable)

- `main.tsx` must import `hermes4-ops.css` — new styles extend that sheet's
  tokens; no parallel token set.
- The board's existing CSS/test contracts keep passing untouched except
  where S-1…S-4 explicitly change behavior — those get updated contracts in
  the same PR, plus **absence tests**: the NEXT strip's markup is gone (not
  hidden), the old WORKED tab roster is gone.
- `ops-preview.html` (the reference render) is updated to show the new
  sections in their `unavailable` state.
- Two-ladders law in markup: WAIVER and TIER are separate columns with
  separate headers; a test greps the rendered Workers header row.
- S-3 consistency: one test asserts the KPI card's runway and the DR-3
  row's runway derive from the same `liquid` value.
- Top-up blocks render addresses ONLY from `topup-destinations` responses;
  a test asserts no address-shaped literal exists in the new components.
- Deploy is ONLY via `ops/deploy-monitor.sh` (bakes GIT_SHA). Worktree dev
  needs the root node_modules symlink and a schemas-diff check first.

## Out of scope

Backend changes of any kind, the monitor service-token re-mint (operator
step), the Arrivals & Journeys 403 fix (same token re-mint resolves it),
mobile layouts for the board, any new colors or tokens.

## Handback requirements

Reference-agent PR number; green checks; the absence-test and
two-ladders-test names; screenshots (or preview renders) of: the digest +
Money Movement in `unauthorized` state, the Workers tab with live-shaped
fixture data, the reward-bank drop-in row, and one top-up block; note
confirming ops-preview.html was regenerated.

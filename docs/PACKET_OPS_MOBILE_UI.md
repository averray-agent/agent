# PACKET — Hermes ops board, mobile triage surface (part 3)

Status: READY FOR CODEX · 2026-08-24 · Author: Claude (architect+gate) ·
Repo: **reference-agent (monitor-ui + slack-operator)** · One PR.
Depends on: part 2 (desktop Overnight Ledger UI, merged as reference-agent
#822) — its panels, hooks, and feed states are the source this reuses.

## Inputs, in authority order

1. `docs/DESIGN_OPS_MOBILE_HANDOFF.md` (this branch) — normative: frame
   inventory, family grammar, MR-1…MR-4 data requirements, and the
   desktop-only table with reasons.
2. `docs/DESIGN_OPS_MOBILE_MOCK.html` — structure and copy reference ONLY.
   The live board's tokens and idiom win wherever they differ. Do not
   recreate pixels.
3. `docs/DESIGN_OVERNIGHT_LEDGER_HANDOFF.md` — DR-1…DR-7 still describe the
   data; mobile adds MR-1…MR-4 and changes no DR.

## The rule that governs this packet

**Mobile is a different arrangement of the same truth, never a second
truth.** Every figure on a phone comes from the same hook and the same
`window` value as its desktop counterpart. If a number can differ between
the two surfaces for the same window, that is a bug.

## Scope

- Responsive board below 768px: the five screens (Status, Money, Work,
  Events, More sheet) built from the part-2 panels' data, plus the bottom
  bar and the shared window selector.
- **Tablet through 1079** gets a sane intermediate; **the desktop board at
  ≥1080 renders exactly as it does today** — a test asserts the desktop
  layout's markup is unchanged by this PR.
- Reuse `useOvernightLedger` and the existing feed-state plumbing from
  part 2. Do not fork a mobile data path.
- MR-1…MR-4 are **new backend needs** (verdict reason line, per-tile vitals
  state, action items, session scope block). Where an endpoint does not
  exist yet, the panel renders `unavailable` with a named reason — never a
  placeholder figure, never a silent zero. List every such gap in the
  handback so the backend packet can be scoped.

## Non-negotiables (each pinned by a test)

1. **Four states, always named**: `live` / `loading` / `unauthorized` /
   `unavailable`; plus the screen-level `PARTIAL VIEW` chip set when any
   tile is non-live. A degraded vital renders its reason, never `0`.
2. **One window value** governs every window-scoped figure on every screen;
   the sheet's copy is read-only and mirrors it. No per-panel selectors.
3. **Two ladders stay two columns**: `WAIVER n/3` (claim-economics free
   window) and `TIER` (reputation) never share a header or a cell.
4. **Desktop-only routes get the gate card**, never a squeezed layout: one
   explanatory card, the reason, and one useful action. Per the handoff's
   table: bank-lane detail, payout-evidence table, and the full probe
   matrix.
5. **No address literals** in components; top-up addresses come from
   `topup-destinations` at runtime.
6. **Desktop parity test**: same window + same fixture ⇒ the mobile and
   desktop renderings of settled count, net paid, runway, and closing
   liquid are equal.

## Repo laws

`hermes4-ops.css` tokens only (no parallel set, no new colors);
`ops-preview.html` regenerated with the mobile frames; deploy only via
`ops/deploy-monitor.sh`; worktree dev needs the root node_modules symlink
and a schemas-diff check first.

## Out of scope

Backend endpoints for MR-1…MR-4 (a later packet, scoped from this
handback), the operator app at app.averray.com (separate product, already
mobile), any desktop layout change, native apps.

## Handback requirements

Reference-agent PR number; green checks; the desktop-parity and
desktop-unchanged test names; preview renders of Status (live and degraded),
Money, Work, Events (empty), and the More sheet at 390px; the list of
MR-1…MR-4 gaps currently rendering `unavailable`; confirmation
`ops-preview.html` was regenerated.

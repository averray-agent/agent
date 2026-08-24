# Hermes / Averray Ops — mobile triage surface (mock)

Single self-contained file: `Ops Mobile.dc.html`. Eight stacked frames at the 390px baseline — Status, Status (loading skeleton), Money, Work, Events, Events (empty in window), More (sheet), Routes & states (desktop gate card + unauthorized panel). Inline styles only, no assets beyond the webfont link.

**Triage, not shrink.** The landing view answers four questions in order: is anything wrong (verdict + reason line) → did money move and reconcile (vitals + digest) → what happened while I was away (digest lines) → do I need to act (ACT ON THIS, with `nothing needs you` as the empty state). Everything else is a drill-down.

## Family grammar (matched to the shipped operator app)

- **Bottom bar: four tabs + More sheet.** Status / Money / Work / Events are tabs; More is a separated trigger (hairline divider, sheet glyph) that opens a full-height sheet carrying secondary navigation, operator session/wallet info, the shared window selector, and sign-out.
- **Breakpoints.** 390px design baseline; mobile below 768; tablet through 1079; **the existing desktop board returns unchanged at ≥1080** — nothing in this spec touches it. Stated in the sheet footer.
- **Honest gate cards.** Any deliberately desktop-only surface routes to one explanatory card — "this view is built for desktop", the reason, and one useful action (`copy link for desktop`). Never a squeezed layout, never an empty panel. Shown on frame 05b for bank-lane detail; the sheet marks these routes `desktop`.
- **State honesty over completeness.** Five states in the vocabulary: `LIVE`, `LOADING`, `UNAUTHORIZED`, `UNAVAILABLE`, plus the screen-level `PARTIAL VIEW` chip. Status carries the chip with a per-panel reason (`feed unreachable — retrying`) and the affected vital renders `—`, never `0`. The unauthorized panel names the cause: `feed unauthorized — monitor token lacks ops:view`.
- **Different clothes.** Same navigation and honesty grammar as the light/paper operator app; skin stays dark terminal — near-black, hairline borders, monospace small-caps labels, light-weight numerals, green/amber/red, floor ticks on bars.

**One window value.** The 12H/24H/48H selector sits in each screen's header (top-right, above the thumb path, 30px targets) and is mirrored read-only in the sheet. It governs every window-scoped figure on every screen — never a per-panel selector.

**Data honesty.** All figures are placeholders: `0.00`, `—`, `--:--`, `0xSAMP…LE0n`, `13SAMP…LE`, tagged `SAMPLE`. Top-up addresses in the mock are samples and are rendered from backend config at runtime — never hardcoded (see DR-7 in `README.md`).

**Token caveat.** `hermes4-ops.css` was not available, so the same token set is declared inline on the root (`--bg`, `--panel`, `--panel-hi`, `--line`, `--ink`, `--ink-dim`, `--ink-mute`, `--ok`, `--ok-deep`, `--ok-bg`, `--warn`, `--warn-bg`, `--bad`, `--bad-bg`, `--mono`). One root-level rename on integration.

## DATA: NEEDS ENDPOINT — named data requirements (mobile)

The desktop requirements DR-1…DR-7 in `README.md` are unchanged and shared. Mobile adds four; each marker in the mock maps to one.

### MR-1 · `status.verdict` — verdict + reason line
`state` (`CONFIRMED` / `SHORTFALL`), `checksPassing`, `warningsOpen`, `lastSweepAt`, and a single machine-composed `reasonLine`. One line, no prose engine.

### MR-2 · `status.vitals` — four-figure vitals row
`settledCount` + `walletCount`, `netPaid` + `retained`, `bankRunwayDays` (liquid only) + `reservedDelta`, `signerGas` + floor state. Each figure carries its **own** `state` (`live` / `loading` / `unauthorized` / `unavailable`) and, when degraded, a `reason` string — the tile renders the reason instead of a value. Drives the screen-level `PARTIAL VIEW` chip: set when any tile is non-live.

### MR-3 · `status.actionItems` — "act on this"
Only currently-true items: `severity` (`warn` / `fault`), `title`, `detail`, `since`, `route`. An empty array is a real answer and renders `nothing needs you` — distinct from a failed fetch, which renders a reason.

### MR-4 · `session.operator` — sheet session block
`walletShort`, `tokenScopes[]` with granted/missing flags (drives the `ops:view missing` chip), `expiresAt`, and the sign-out endpoint. The scope list is what makes an unauthorized panel explainable rather than blank.

## Left desktop-only (and why)

| Surface | Why it stays desktop | Mobile behaviour |
|---|---|---|
| Bank-lane detail | Wide multi-lane reconciliation — several lanes compared side by side; column count, not text size, is the constraint | Gate card + `copy link for desktop` |
| Payout evidence table | Full proof rows (hashes, amounts, timestamps) exceed a 390px row before truncation destroys their purpose | Gate card; the ledger's match row links to the chain explorer instead |
| Probe grid (full) | An — × — matrix; a phone can show the failing cells but not the matrix's shape | Mobile route shows failing probes only; full matrix gated |
| Arrivals / demand panels | Demand signal, not triage — they answer planning questions, not "do I need to act now" | Reachable from the sheet, not a tab |
| LLM spend, deposit pool, retention & waivers | Useful but never the reason someone opens their phone at 07:00 | Sheet rows with a one-line summary, full panels on drill-down |

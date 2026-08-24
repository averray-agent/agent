# Hermes / Averray Ops — Overnight Ledger extension (mock)

Single-file mock: `Overnight Ledger.dc.html` (desktop-only, 1440px canvas, ≥1280px min). Opens directly in a browser. No external assets besides the webfont link. All figures are placeholders (`0.00`, `—`, `--:--`, `0xSAMP…LE0n`, `13SAMP…LE`) or tagged `SAMPLE`. Chips are limited to the board's existing vocabulary (`CONFIRMED`, `SHORTFALL`) plus `SAMPLE`, the scoping marker `DROP-IN`, and the handoff marker `DATA: NEEDS ENDPOINT`.

Nothing existing is restyled or rearranged. The OPERATOR VERDICT hero and the SOLVENCY panel appear as placement anchors in their live form.

**Token caveat:** `hermes4-ops.css` was not available in this project, so the mock declares the same token set inline on the root element (`--bg`, `--panel`, `--panel-hi`, `--line`, `--line-strong`, `--ink`, `--ink-dim`, `--ink-mute`, `--ok`, `--ok-deep`, `--ok-bg`, `--warn`, `--warn-bg`, `--bad`, `--bad-bg`, `--mono`). Point these at the real custom-property names on integration — one root-level rename, no per-element edits.

## Scoping notes

**SOLVENCY is a single-row drop-in.** The panel is drawn with its full live row list — Signer gas, Reward bank, Agent core, Treasury reserve, Escrow (in-flight), Protocol revenue — each keeping its EVM + SS58 address sublines, floor tick on the bar, and BURN / RUNWAY sublines. **Only the Reward bank row changes** (marked `DROP-IN` in the mock): two-tone `liquid | reserved` bar with both figures labeled, runway computed from liquid only, and the `liquid −0.00 · reserved +0.00 · 24h` delta line. Every other row is unchanged; the change surface is exactly one row.

**Top-up addresses are rendered from backend config at runtime — never hardcoded in the UI.** The two refillable rows (Signer gas, Reward bank) carry a TOP-UP micro-block with a copyable address and its network line. The addresses shown in the mock are samples (`13SAMP…LE`) and must not be copied into code, fixtures, or docs.

**WAIVER and TIER are separate ladders and never share a label.** In WORKERS, `WAIVER n/3` (claim-economics free window: slot pips, `waived` tag) and `TIER` (reputation tier and promotions such as `→ pro`) are two columns with a rule between them. The table scrolls horizontally inside its own container rather than squeezing columns.

**The digest's 12H / 24H / 48H selector governs every window-scoped panel** — Money Movement, Workers, Retention & Waivers, Events, the reward-bank delta line, and the digest lines themselves. One window value, one fetch scope; no per-panel selectors.

Only state in the file: that window selector, the workers rows/empty preview, and the ledger CONFIRMED/SHORTFALL preview. All three are also exposed as props.

## Additions in this spec

1. **MONEY MOVEMENT — {window}** — vertical reconciliation ledger beside SOLVENCY: opening liquid → payouts out → retention + fees in → reserved Δ → closing liquid, each line with a chain-proof affordance, closed by a `CONFIRMED` / `SHORTFALL` match row.
2. **WORKERS — {window}** (mounted as the roster's WORKED tab, see S-2) — one row per active wallet, sorted by net earned: `NEW` badge, session span, claims/approved/rejected, gross → net, retention paid, WAIVER slots, TIER events, on-platform balance, withdrawn-this-window, window-total row, and the empty state.
3. **Reward bank row upgrade** (single-row drop-in inside live SOLVENCY) — two-tone `liquid | reserved` bar, runway from liquid only, 24h delta line.
4. **RETENTION & WAIVERS — {window}** — charged, waived, waiver slots consumed, subsidy spend vs daily budget, delta feeding Protocol revenue.
5. **OVERNIGHT DIGEST** — strip under the hero: three template-generated lines (`tpl:money`, `tpl:ladder`, `tpl:capability`) plus the shared window selector.
6. **EVENTS lane** — narrow full-height right column: timestamped ladder/lifecycle feed (graduations, waiver exhaustion, first external posting, capability warnings opening/closing, stuck claims, reserved locks, deploys).
7. **TOP-UP micro-blocks** — on Signer gas (`send DOT · Polkadot Asset Hub`) and Reward bank (`send USDC · Polkadot Asset Hub`, Coinbase network "Polkadot", plus the `lands in EOA — run fund-signer deposit` caveat), each with a copy affordance in the board's existing button idiom.

## Removed / reconciled (explicit deletions, not accidents)

The extension must not duplicate existing content. Four supersessions, annotated in the mock's footer strip:

**S-1 · DELETE the NEXT strip.** Its content is fully covered by the OPERATOR VERDICT subline and the digest's `tpl:money` line. Remove the section and its fetch — do not keep it hidden behind a flag.

**S-2 · REPLACE the WHO SHOWED UP roster's WORKED tab** with the WORKERS — {window} table. The roster keeps its LOOKED and KNOCKED tabs unchanged: those are demand signal, not work, and this spec does not touch them. WORKERS is therefore not a standalone panel — it mounts as that tab (shown that way in the mock, with LOOKED / KNOCKED marked `unchanged`).

**S-3 · RECOMPUTE the REWARD RUNWAY KPI card** from liquid only, with a small `+ 0.00 reserved` subline. Same source value as DR-3 so the card can never contradict the upgraded reward-bank row. Card position and styling unchanged; only the computation and the subline are new.

**S-4 · NO second proof box.** MONEY MOVEMENT's "ledger matches chain proof" line is a compact status row that anchors/links to the existing PAYOUT EVIDENCE block inside FLOW (`#payout-evidence`), which remains the single rendered proof. Do not duplicate evidence rendering in the ledger panel.

## DATA: NEEDS ENDPOINT — named data requirements

Each marker in the mock maps to one requirement below. All window-scoped requirements take the same 12/24/48h window value.

### DR-1 · `window.reconciliation` — Money Movement ledger
`openingLiquid`, `payoutsOut { count, netUsdc, walletCount }`, `retentionFeesIn`, `reservedDelta`, `closingLiquid`, each with the proof references the evidence affordance renders (tx hashes / escrow row ids, same shape as the existing PAYOUT EVIDENCE block). Also `proofTiedCount`, `proofMissingCount`, `delta` so the match row resolves `CONFIRMED` vs `SHORTFALL`.

### DR-2 · `window.workers` — per-wallet window aggregation
Per wallet with activity in the window: `wallet`, `isFirstEverActivity`, `sessionStart`/`sessionEnd`/`sessionHours`, `claims`, `approved`, `rejected`, `grossEarned`, `netEarned`, `retentionPaid`, `retentionWaived`, `waiverSlotsUsed`/`waiverSlotsTotal`, `reputationTier`, `tierEvents[]`, `balanceNow`, `withdrawnInWindow`. Sorted by `netEarned` desc, plus window totals. Needs a lifetime (not windowed) first-activity lookup for the `NEW` badge. **Waiver slots and reputation tier are distinct fields from distinct subsystems — do not merge them in the response shape either.**

### DR-3 · `solvency.rewardBank.split` — liquid / reserved split (drop-in row only)
`liquid`, `reserved` (locked behind minted/claimed jobs), `runwayDays` computed from **liquid only**, plus windowed `liquidDelta` / `reservedDelta`. Today's row returns a single total; the split, the liquid-only runway, and both deltas are new. No other solvency row changes.

### DR-4 · `window.retention` — retention & waivers
`charged`, `chargedSettlementCount`, `waived`, `waivedSettlementCount`, `waiverSlotsConsumed`, `waiverSlotsTotal`, `walletsInFreeWindow`, `subsidySpend`, `subsidyDailyBudget`, `protocolRevenueDelta` (the figure feeding Protocol revenue).

### DR-5 · `window.digest` — digest template slots
Scalar slots only — no server-side prose: `settlementCount`, `walletCount`, `newWalletCount`, `paid`, `retained`, `bankOpen`, `bankClose`, `bankLocked`, `stuckClaimCount`, `gasDelta` (DOT); `graduatedCount`, `waiverWindowsExhausted`, `firstExternalPostings`, `walletsInFreeWindow`; `warningsOpen`, `warningsClosed`, `deployCount`, `ledgerMatchState`, `ledgerDelta`. `ledgerMatchState` must be the same value DR-1 resolves, so the digest and the match row can never disagree.

### DR-6 · `window.events` — lifecycle event log
Chronological windowed feed: `timestamp`, `type`, `severity` (ok / warn / info), `wallet?`, type payload. Required types: `wallet_graduated` (target tier), `waiver_window_exhausted`, `first_external_posting`, `capability_warning_opened`, `capability_warning_closed`, `claim_stuck`, `reserved_locked`, `deploy`. Plus a total count for the "— older events in window" affordance.

### DR-7 · `config.topupDestinations` — top-up addresses (runtime config)
Per refillable account (`signerGas`, `rewardBank`): `ss58Address`, `asset` (`DOT` / `USDC`), `network` label (`Polkadot Asset Hub`), `exchangeNetworkLabel` (e.g. Coinbase's "Polkadot"), and `landsInEoa` + `followUpCommand` (`fund-signer deposit`) for the reward-bank caveat line. Served from backend config and read at runtime — the UI must contain no address literals, in code or in fixtures.

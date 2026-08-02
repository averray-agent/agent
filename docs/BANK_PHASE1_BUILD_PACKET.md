# Bank phase 1 — build packet (Hydration USDC supply, treasury-only)

The build spec for the yield lane, written after the workshop chose the venue
(`BANK_YIELD_WORKSHOP.md`, PR #893) and the integration was verified against live chain
state (`scratchpad/hydration-integration-verification.md`). Implements roadmap 3.5's
XCM observer against the safest FX-clean target.

> **Read this first — phase 1 is a REHEARSAL, not a yield play.** The verification found
> the minimum sensible position is **~5,000 USDC parked for weeks** (2.09% APY, diluting,
> against ~0.0317 DOT per outbound message). The treasury today is ~0.105 USDC of protocol
> fees. **We are proving the machinery on money that doesn't matter, so that phase 2 —
> agent balances — runs on rails that have actually carried value.** No packet claim about
> earnings should survive that framing.

## 1. Scope

- **Operator treasury capital ONLY.** No agent funds. (Pascal, 2026-08-02.)
- **Deposit and withdraw**, nothing else. No leverage, no borrow loop (now negative carry),
  no multi-venue routing, no DOT-denominated strategy.
- Ends when a treasury-owned USDC position can be supplied to Hydration, observed, credited
  honestly in the ledger, and withdrawn back to Asset Hub.

## 2. The verified mechanism (do not re-derive — this was dry-run against live chain)

- **The call is NOT an EVM `supply()`.** Hydration's Router exposes the Aave money market as
  a native `PoolType::Aave`, so the XCM `Transact` dispatches **`Router.sell(22 → 1003)`**
  (aToken out). `DryRunApi.dryRunXcm` returned `complete` with
  `Broadcast.Swapped{pool: aave, in 1.0 asset 22, out 1.0 asset 1003}`. No EVM call, no
  Hydration gas token needed, fees payable in USDC. Withdraw is `1003 → 22`.
- **Asset identity works:** Hydration asset **22** is `parents:1, X3[Parachain(1000),
  PalletInstance(50), GeneralIndex(1337)]` — literally our asset 1337, no wrapper — and it
  is **reserve #0** of the money market.
- **Two structural constraints:** the transfer message carries `ClearOrigin`, so **funding
  and acting must be two separate messages**; and `IXcm.send` takes raw SCALE blobs (no
  `transferAssetsUsingTypeAndThen`), so the message must be hand-assembled.
- Corrections to older docs: Hydration's EVM gas token is **WETH (asset 20), not HDX**; the
  money market is an **independent Galactic Council fork** of Aave v3.0.x under Hydration
  OpenGov, audited by Spearbit/Cantina 2025-01-23 (0 C/H/M/L) — but that review covers the
  **deployment config, not `aave_trade_executor.rs`**, which is the path we use.

## 3. Architecture — backend-driven first (b/c), harden into contract-driven (a)

Both dispatch the *identical* call; only the signer changes. So phase 1 uses a backend
signer, and the contract-driven variant becomes a later hardening step with no redesign.

**Reuse what exists — do not build a new async pattern.** `XcmWrapper` already implements
it: `queueRequest` (validates, dispatches via the XCM precompile, records **Pending**) and
`finalizeRequest` (an authorised settler reports the outcome later), with
`_validateSettlementBounds` enforcing **`settled ≤ requested`** in Solidity — the observer
is bounded and cannot invent yield. Indexer `xcmRequest` tables and `/admin/xcm/*` routes
already exist. **The seam is built; it has never been wired to a real venue.**

Flow per deposit:
1. Treasury allocation records intent → `XcmWrapper.queueRequest` (kind `Deposit`) → Pending.
2. **Message 1**: reserve-transfer USDC (asset 1337) Asset Hub → Hydration, to our account
   there.
3. **Message 2**: `Transact` dispatching `Router.sell(22 → 1003)`. (Separate message —
   `ClearOrigin`.)
4. Observer confirms (§4) → `finalizeRequest(Succeeded, settledAssets, …)` → ledger credits.
Withdraw is the mirror: `Router.sell(1003 → 22)`, then reserve-transfer home, same
queue/finalize.

## 4. The observer — the actual build

**Assert on destination state, never on XCM success.** The verification demonstrated an XCM
returning `complete` while the inner call did nothing — an observer keyed on XCM outcome
would report healthy over idle capital. The observer MUST read
**`Tokens.accounts(<our account>, 1003)`** on Hydration and finalize from the *balance
delta*, not from the message result.

Requirements:
- Poll Hydration for the aToken (1003) balance attributable to the request; finalize
  `Succeeded` with the actual delta (which `_validateSettlementBounds` will cap at the
  requested amount).
- **Timeout → `Failed`, never silent Pending.** A request that never lands must surface.
- Idempotent: re-finalizing with identical values is a no-op (already contract behaviour).
- Emit/record enough for the `external_funnel`-style probe to alarm on stuck Pendings.
- **Venue-agnostic**: the observer takes (chain endpoint, account, asset id) — Hydration is
  its first target, not its only one.

## 5. Truth boundary (non-negotiable)

- **Yield stays MOCK (`simulateYieldBps`) in every surface until the observer confirms real
  settlement.** Never display projected yield as earned.
- In-flight deposits/withdrawals render as **in flight**, with the request id — the same
  honesty the poster door uses between funding and watcher-confirmation.
- If the observer cannot read Hydration, the position reports **unknown/stale**, never a
  cached-optimistic number (the fail-stale lesson, #477).

## 6. Ordered gates — each blocks the next

1. **Address-derivation dust test (FIRST, blocks everything).** That our Asset Hub account
   maps to Hydration as `h160 ++ 0xEE×12` is the one link the verification reasoned from
   source rather than observed. **Send dust, confirm receipt at the derived account, and
   only then move real value** — getting this wrong sends funds to an unrecoverable account.
2. **Pre-capital gate**: direct Hydration read confirming the money market accepts asset 22,
   plus its live rate and withdrawable depth (the workshop's §5 item that Claude could not
   verify from Asset Hub RPC).
3. **Round-trip on dust**: deposit → observed → withdraw → back on Asset Hub, all through
   `queueRequest`/`finalizeRequest`.
4. **XcmWrapper deployment ceremony** (multisig, same pattern as the EscrowCore v2 cutover)
   — only after 1–3 pass on a test path.
5. Only then: a real (still small) treasury position.

## 7. Risks carried into the build

- **Silent Transact failure** — mitigated by §4's balance-delta rule; treat any
  XCM-success-without-balance-change as an incident, not a success.
- **Stuck/trapped assets mid-flight** — the timeout path must make these visible and
  recoverable; document the manual recovery route before the first real deposit.
- **Economics** — ~0.0317 DOT per outbound message against a 2.09% diluting APY means small
  positions lose money. Phase 1 is explicitly not expected to profit.
- **Audit gap** — `aave_trade_executor.rs` is the path we use and is not cleanly covered by
  the Spearbit/Cantina review. Note it; do not overstate the venue's audit status.
- **Governance** — Hydration's money market is under Hydration OpenGov; parameters can change
  without us.

## 8. Lanes

| Piece | Owner |
|---|---|
| XCM message construction + `Router.sell` encoding, dust test, round-trip | Codex (chain/settlement) |
| Observer service (balance-delta, timeout, idempotent finalize) | Codex |
| XcmWrapper deployment ceremony | Pascal signs, Codex prepares, Claude gates |
| Ledger + UI truth states (in-flight / confirmed / unknown) | Claude |
| Independent gating of every handback | Claude |

## 9. Non-goals

Agent balances (phase 2 — re-run the workshop first: capacity, the do-nothing baseline, and
FX all change weight); leverage/borrow; DOT-denominated strategies; multi-venue routing;
anything that displays yield before the observer confirms it.

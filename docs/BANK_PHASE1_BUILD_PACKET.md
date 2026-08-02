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
2. **Message 1**: reserve-transfer USDC (asset 1337) Asset Hub → Hydration, **beneficiary =
   the CONVERTED ORIGIN ACCOUNT** (see gate #1b) — never the EE-image.
3. **Message 2**: `Transact` dispatching `Router.sell(22 → 1003)`. (Separate message —
   `ClearOrigin`.)
4. Observer confirms (§4) → `finalizeRequest(Succeeded, settledAssets, …)` → ledger credits.
Withdraw is the mirror: `Router.sell(1003 → 22)`, then reserve-transfer home, same
queue/finalize.

## 4. The observer — the actual build

> **Ledger correction (2026-08-02, leg A observed + registry-verified):** Hydration's
> **asset 1003 (aUSDC) is `assetType: Erc20`** — its ledger is the aToken **ERC-20 contract
> on Hydration's EVM**, not `Tokens.accounts`. After a successful `Router.sell(22 → 1003)`,
> `Tokens.accounts(account, 1003)` reads **0 by design**; the position lives at
> `balanceOf(truncate20(accountId32))` on the aToken contract (Hydration maps AccountId32 →
> H160 by first-20-bytes truncation — chain-specific, verified live; do NOT reuse this rule
> on other chains). **The observer therefore reads: asset 22 via `Tokens.accounts`, the
> aToken via the EVM ERC-20 ledger.** The rule below stands — only the source of state for
> the aToken changed.

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

1. **Address-derivation dust test — ✅ PROVEN 2026-08-02.** Tx
   `0xed380936f89fcd2ea168c7133b51ca5383e01279897a042f86dd711b9cd58042` (Asset Hub block
   18,974,353) reserve-transferred 100,621 raw USDC; **exactly 100,000 raw asset 22 arrived
   at the derived account** (`h160 ‖ 0xEE×12`, SS58 `1CH9GprqPA6ZXjLCP39ZHd8XZf7VxzBLBvWpK2HqZs7PwC7`),
   double-verified on independent endpoints/tooling (dwellir + `rpc.hydradx.cloud`
   via @polkadot/api). The DryRunApi prediction (`Tokens.Deposited(22, 100000)`) matched
   observation exactly — the dry-run preflight is a trustworthy instrument, and it stays
   mandatory before every signed message. Two operational facts learned on the way: the
   official Asset Hub WSS 1006-flakes (use `asset-hub-polkadot-rpc.n.dwellir.com` or the
   official HTTPS transport for one-shot calls), and AH-side delivery fees are JIT-paid in
   DOT by the EVM sender (~0.033 DOT/message), not drawn from the transferred USDC. The
   100,000 raw remains at the derived account as the working dust for gates 2–3.
   *(Original gate text follows.)* That our Asset Hub account That our Asset Hub account
   maps to Hydration as `h160 ++ 0xEE×12` was the one link reasoned from source rather than
   observed — now observed.
1c. **aToken ledger — ✅ OBSERVED 2026-08-02 (leg A executed).** Re-fund
   (tx `0xb46b4d9c…`, 149,380 raw arrived at the converted account) and leg A
   (tx `0x2957ba13…`, AH block 18,975,699) succeeded: `Swapped` fillerType AAVE,
   100,000 asset 22 in → **100,000 aUSDC out, held on the EVM ledger** at the truncated
   H160 of the converted account (`0xaf39ad76…b84e`); execution fee 20,917 raw. The
   `AliasOrigin` recovery probe for the EE-stranded 100,000 was rejected by Hydration's
   barrier → that amount is formally **written off** (~$0.10). Cumulative cost of every
   lesson so far (wrong-message dust, EE write-off, all fees): **under $0.40**.
1b. **Operating identity — ✅ PROVEN 2026-08-02 (runtime read + failed dry-run).** The
   remote-account model is TWO mappings, and gate #1 proved only the first:
   - **Deposit image**: beneficiary `AccountId32(h160 ‖ 0xEE×12)` lands at that literal
     local account (gate #1's proof) — but that account has **no local key and no standard
     origin converts to it**: a custody dead-end on remote chains.
   - **Operating identity**: our descended origin `{parents:1, X2[Parachain(1000),
     AccountId32(EE-image)]}` converts, per Hydration's own `LocationToAccountApi`, to
     **`0xaf39ad769a03cb535d9799e49459b033c1fab84ee23ffe5d0852f8d82f02a71e`** — the only
     account XCM `WithdrawAsset`/`Transact` can actually spend from. (Discovered when leg A's
     mandatory dry-run failed `FailedToTransactAsset` at `WithdrawAsset` — the dry-run gate
     catching a design error for free, again.)
   - **RULE: all remote working funds are deposited to the converted origin account.** The
     EE-image is display-equivalence only, never a remote custody target. The observer (§4)
     watches the converted account for both asset 22 and aToken 1003.
   - The first 100,000 raw at the EE-image: one read-only `AliasOrigin` probe (expected to
     fail), then written off — ~$0.10 as the price of discovering the identity split with
     dust instead of treasury capital.
2. **Pre-capital gate**: direct Hydration read confirming the money market accepts asset 22,
   plus its live rate and withdrawable depth (the workshop's §5 item that Claude could not
   verify from Asset Hub RPC).
3. **Round-trip on dust — ✅ COMPLETE 2026-08-02, double-verified.** Full lifecycle
   executed and independently confirmed on both chains: fund (149,380 to the converted
   account) → deposit (leg A: 100,000 → 100,000 aUSDC, `Swapped` AAVE) → withdraw (leg B:
   tx `0x2a699c20…` block 18,976,308, aUSDC → 0, asset 22 +100,000 −21,350 fee) → home
   (leg C: tx `0x971bd7a2…` block 18,976,462, 105,711 landed at the source; remote fees
   1,402). Source closed at **785,090 raw**; converted account **0**; arithmetic exact at
   every step.
   **Measured cycle economics (replaces the pre-measurement estimate):** one full
   fund→deposit→withdraw→home cycle costs **44,289 raw USDC in venue/remote fees +
   ~0.134 DOT in AH-side fees ≈ $0.15 total**. At the live 2.07% supply APR, ~$7.25 of
   position-year covers one cycle — i.e. a 100 USDC position pays for a full cycle in
   under a month of yield. The earlier "~5,000 USDC minimum sensible" was estimate-based
   and is superseded; the economics floor is ~100× lower than assumed. (APY dilutes with
   inflows and observer/ops cost is uncounted — the rehearsal framing stands.)
   **Total program cost, all three lessons plus the full cycle: 164,910 raw USDC +
   0.166 DOT ≈ $0.30.**
   *(Original gate text follows.)* Round-trip on dust: deposit → observed → withdraw → back on Asset Hub, all through
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
- **Converter stability** — the operating identity is `HashedDescription` of our origin
  location, a runtime-configuration output. Re-read `LocationToAccountApi.convert_location`
  before each funding epoch; a changed result is a stop-the-world event, not a re-derivation
  exercise.

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

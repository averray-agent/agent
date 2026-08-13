# PACKET — Treasury surface light-up (emit the real feeds)

**Author:** Claude (gates handback) · **Implementer:** Codex · **Operator:**
Pascal · **Date:** 2026-08-13 (evening of the L1 cutover)

Pascal's ask, verbatim intent: the operator-app **Capital → Treasury** page
should light up. Today it renders the honest truth-boundary placeholders —
"cap not emitted by API yet" (credit line), "XCM observer not emitted by API
yet", "No live strategy lanes configured yet", "policy gate feed not emitted
by API yet" — because the admin API genuinely does not emit those fields
(verified: zero `creditLine`/`borrowCapacity` emitters anywhere in
`mcp-server/src`; the app adapter is already built and waiting —
`app/lib/api/treasury-adapters.ts:159/279` consumes `summary.borrowCapacity`
when present).

As of tonight every underlying source is LIVE on mainnet, so the tiles can
light up with real reads:

## Scope — four emitters on the admin treasury summary (one endpoint, one PR)

1. **Credit line** (`summary.borrowCapacity` + used + headroom + active
   loans): per signed-in wallet, from CreditPool
   `0x903B318586A3772c99185000676f4AC356DD6E4B` (pledged-vs-vested capacity,
   outstanding debt, zero-interest pilot schedule) + AAC `debtOutstanding`.
   The credit-pool door service already computes capacity
   (`credit-pool-door.js` capacityReader) — reuse, don't reimplement.
2. **Strategy lanes / allocation table**: the wrapper's registered strategy
   registry rows (id → lane address → allocated principal). Live sources:
   wrapper `0xF20b35A3…d2Bc` strategyAdapter reads + per-lane cost basis from
   the pool (`venuePrincipalCostBasis`). Two real lanes exist today
   (operating bank lane, `HYDRATION_USDC_POOL_V1` → `0x88eE7027…371f`).
3. **XCM observer feed**: the dispatcher/observer's request → observe → settle
   rows (requestId, leg, status, block) — same evidence stream the ops board
   consumes; the yield epoch will produce the first pool-lane rows.
4. **Policy gate rows**: the TreasuryPolicy reads governing this surface
   (roles, caps) — read-only enumeration.

## Rules (unchanged, non-negotiable)

- **Truth boundary**: every value is a live read or an indexed event; no
  invented figures; the placeholders REMAIN the fallback whenever a feed is
  absent or stale. Never make the page look more alive than the system is.
- **Revenue boundary**: agent-scoped credit/capacity data only — platform or
  founder revenue never appears on the operator app.
- **Ops-verdict contract**: any status chip derives from the shared
  `deriveOpsVerdict` reason, not a headline string.
- No page redesign — the tiles exist; this packet only feeds them.

## Acceptance (Claude gates)

- Treasury page renders real values for a signed-in wallet with a position
  (dogfood): credit cap/used/headroom match my independent CreditPool +
  AAC reads; lanes table lists exactly the registered lanes with allocations
  matching `venuePrincipalCostBasis`; placeholders still render when a feed
  is legitimately absent (e.g. observer quiet).
- The "UNAVAILABLE" chip semantics on this page follow the health contract
  (503 = not-serving only; correctness faults = 200 + warning).
- After the yield epoch: the XCM observer tile shows the epoch's real legs.
- No new figures on any public/marketing surface.

## Not in scope

Board (Hermes/ops) changes · credit DRAWS (read-only surface) · pool caps ·
any figure invented to fill a tile.

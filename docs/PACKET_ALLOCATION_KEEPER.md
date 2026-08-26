# PACKET — The allocation keeper

Status: READY FOR CODEX · 2026-08-26 · Author: Claude (architect+gate) ·
Repo: **platform, mcp-server (backend only)** · One PR.
Authority: `MEMO_IDLE_BALANCE_YIELD.md` B2–B5 and `MEMO_IDLE_BALANCE_ROUTE.md`
R1–R5/Q1′/Q1″/Q2, all RATIFIED. Builds against the DEPLOYED contracts:
pool v2.1 `0x9B35A102…`, adapter `0x1DDcA709…`, strategy id
`AAC_IDLE_DEPOSIT_POOL_V21`. **Ships dark**: every action double-gated on the
existing `IDLE_BALANCE_ALLOCATION_ROUTE_LIVE` env AND a new keeper-enable env,
both default-off.

## What it is

The backend loop that finally moves consented idle balances:

- **Allocate**: for each wallet with live #1292 consent, call
  `AAC.allocateIdleFunds(account, STRATEGY_ID, amount)` as settlementBroker,
  where `amount = liquid − workingHeadroom` (only when positive and above a
  minimum tick).
- **Deallocate**: an authenticated agent endpoint (SIWE) that calls
  `AAC.deallocateIdleFunds` for the caller — synchronous while adapter float
  covers it (R4), refused-with-queued-status beyond, keeper prioritises float
  replenishment.
- **Float management** (operator duty on the adapter): `sweepToPool` when
  float exceeds target; `requestFloatExit`/`fulfilFloatExit` when below.

## The laws, each with its reason

1. **Consent is re-read at attempt time, never cached** (the #1292 store’s own
   rule). A consent revoked between scan and send must refuse with the
   existing named reasons. This is B3 made operational — the single most
   important property of the keeper.
2. **Exit never requires consent.** Deallocation is available to any wallet
   with allocated shares, consent live, expired, or revoked. Trapping funds
   behind a consent check would invert the entire trust argument.
3. **B2 headroom is exact and conservative.** `workingHeadroom` and the
   minimum allocation tick are env-configured; ship defaults that are
   obviously safe (suggest 2.000000 USDC headroom, 0.500000 minimum tick) and
   mark both as **operator decisions at cutover, not constants** — flag them
   in the PR for Pascal to confirm. Never allocate reserved or debt-bearing
   balance (the contract enforces this; the keeper must also not attempt it).
4. **Value-closure at the keeper level.** The keeper may call exactly:
   `allocateIdleFunds`, `deallocateIdleFunds`, `sweepToPool`,
   `requestFloatExit`, `fulfilFloatExit` — nothing else, no other strategy id,
   no other adapter, ever. Pin with a test that the call surface is closed.
5. **Idempotent and bounded.** A run is a no-op when nothing qualifies;
   per-run allocation count and total are capped (env); a second concurrent
   run must not double-allocate (the existing keeper locking pattern —
   follow `credit-book-keeper.js`'s idiom).
6. **Fail closed on every unreadable input** — consent store, chain reads,
   float state — each with a named reason, logged.
7. **Every movement is evidenced** for B5: allocation/deallocation events
   recorded per wallet (amount, tx, strategyShares delta) in the state store,
   shaped so the attribution surface can consume them later. No user-facing
   yield claims in this PR — that is B5's own packet.

## Operational preconditions (already true or scheduled)

- Multisig registration (A4) executes 2026-08-27 — the keeper's dry-run tests
  must not depend on it (mock the registry state); the LIVE keeper is gated
  behind the envs anyway.
- DOT postage on AAC and adapter (A3) — the keeper must surface a clear,
  named failure if an approve reverts for missing postage rather than a
  generic error (we know this failure mode's exact shape).

## Non-negotiables (each pinned by a test)

1. Revoked-between-scan-and-send refuses with the named reason; nothing sends.
2. Deallocation works for a revoked-consent wallet (exit never gated).
3. Headroom arithmetic exact: liquid 5.0, headroom 2.0 ⇒ allocates exactly
   3.0; liquid 2.4 ⇒ allocates nothing (below tick).
4. Keeper-enable env off ⇒ zero chain interaction regardless of consents.
5. The call surface is closed (law 4) — attempting any other selector is
   structurally impossible, proven by the test.
6. Concurrent second run allocates nothing (lock held).
7. Float below target triggers `requestFloatExit` with receiver == adapter;
   float above target sweeps; neither ever touches agent positions.

## Out of scope

B5's per-agent yield surface, the tier-ladder premium, Ceremony B, consent
capture changes, and any contract work.

## Handback

PR number; green CI; the seven test names; the env inventory with defaults;
the evidence-record shape; confirmation the keeper ships dark behind both
envs and that the call surface is closed.

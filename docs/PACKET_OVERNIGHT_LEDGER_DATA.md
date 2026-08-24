# PACKET — Overnight Ledger data endpoints (board backend, part 1 of 2)

Status: READY FOR CODEX · 2026-08-24 · Author: Claude (architect+gate) ·
Repo: **platform (averray-agent/agent), mcp-server backend** · One PR.
Part 2 (board UI, reference-agent repo) starts only after this ships.

## Source of truth

`docs/DESIGN_OVERNIGHT_LEDGER_HANDOFF.md` (committed alongside this packet)
— specifically its **DR-1 … DR-7** sections. Field lists there are normative;
this packet adds the transport, auth, invariants, and tests.

## Transport

One operator-scoped read endpoint:

```
GET /admin/ops/overnight-ledger?window=12h|24h|48h
```

- Auth: `requireCapability: "ops:view"` (same posture as the other board
  reads). No mutation anywhere in this packet.
- Response: one JSON document with top-level keys `reconciliation` (DR-1),
  `workers` (DR-2), `rewardBankSplit` (DR-3), `retention` (DR-4),
  `digest` (DR-5), `events` (DR-6), plus `window`, `generatedAt`.
- `config.topupDestinations` (DR-7) is **not** windowed — serve it under
  `GET /admin/ops/topup-destinations` (same capability), values read from
  backend config/env at request time. The SS58 forms are derived server-side
  from the configured EVM accounts via the established address-form rule —
  never stored as separate literals that could drift from the EVM source.

## Invariants (each pinned by a test)

1. **Ledger identity:** `openingLiquid − payoutsOut.netUsdc +
   retentionFeesIn − reservedDelta === closingLiquid` for every window, or
   the response says so: `reconciliation.match = "SHORTFALL"` with `delta`.
   Never silently re-balance.
2. **Digest/ledger consistency (DR-5):** `digest.ledgerMatchState` is the
   same computed value as `reconciliation.match` — one derivation, two
   consumers.
3. **Two ladders stay two fields (DR-2):** `waiverSlotsUsed/Total` come from
   claim-economics; `reputationTier`/`tierEvents` from the reputation
   subsystem. No merged field, no shared enum.
4. **Runway basis (DR-3):** `runwayDays` derives from `liquid` only;
   a test proves a large `reserved` value cannot move it.
5. **No address literals (DR-7):** top-up addresses come from config at
   request time; a test asserts the route module contains no `0x…40` or
   SS58-shaped string constants.
6. **Wallet casing:** every wallet key in DR-2 aggregation flows through the
   standard lowercase normalization at read and write.
7. **Truth boundary:** operator-run/self wallets are classified via the
   shared self-identity registry and flagged in DR-2 rows (`selfIdentity`
   classification field) so the UI can separate them; synthetic canary
   sessions are excluded from `digest` counts the same way the public
   surfaces exclude them.

## Data sources (guidance, not mandates)

- DR-1/DR-3: operator AAC `positions()` snapshots + settlement records.
  Window opening/closing snapshots may be computed from current position
  minus windowed deltas if no historical snapshot store exists — state the
  method in the response (`reconciliation.basis`), never fake a snapshot.
- DR-2: wallet-session store + stored verification results (the same joins
  worker-progression uses), plus first-activity lookup for `NEW`.
- DR-4: claim-economics settlement records (waived vs charged) + onboarding
  subsidy status (already on /health).
- DR-5: pure scalar assembly from the other sections — no new derivations.
- DR-6: emit from existing lifecycle points (graduation, waiver exhaustion,
  external posting watcher, capability warnings, claim-timeout reconciler,
  deploy marker) into a bounded windowed log. If an event type has no
  existing hook, add the emission at the source — do not reconstruct events
  by polling.

## Performance bound

The endpoint must answer from store reads only (no chain RPC in the request
path). If an aggregation needs chain data, it consumes what settlement
already persisted. Target < 1s at current volumes; paginate `events` past
200 rows.

## Out of scope

Board UI (part 2, reference-agent repo), the S-1…S-4 supersessions (UI),
any new capability names, the monitor service-token re-mint (operator step,
handled at part-2 deploy), any mutation surface.

## Handback requirements

PR number; green CI; the seven invariant test names; one full sample
response for `window=24h` from a fixture store (placeholder values fine);
confirmation the route modules contain no address literals.

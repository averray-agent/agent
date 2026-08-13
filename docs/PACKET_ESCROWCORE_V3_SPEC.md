# Packet — EscrowCore v3 spec (retention + settable schedule + poster cancel)

**Date:** 2026-08-13 · **Author:** Claude (architect) · **Implementer:** Codex (owns chain/settlement) · **Operator:** Pascal
**Authority:** `PACKET_D4_FEE_SCHEDULE.md` (RATIFIED, all five, Pascal 2026-08-13) ·
`docs/POSTER_CANCEL_RECLAIM_DESIGN.md` §4 decisions ①–⑤ (Pascal 2026-08-01, PR #877 — ① banked
`cancelOpenJob` to "the next EscrowCore deployment window, never a solo ceremony"; **this is that
window**) · `PACKET_D0_VESTING.md` (lane semantics; D0 lands before v3 activates) ·
`GAS_STUDY_2026-08-13.md` (constants' basis).
**Requirements-level spec.** Codex owns the Solidity, storage layout, and internals. Everything
below is behavior, invariants, events, and acceptance — not implementation.

## 1. Scope — what v3 adds over v2 (additive; v2 semantics otherwise preserved)

1. **Gas retention** at settlement, iff the job's gas was brokered (D4-R1/R2).
2. **Fee schedule as settable state** with contract-enforced ceilings, extending v2's
   `protocolFeeBps ≤ MAX_PROTOCOL_FEE_BPS` idiom (D4-R4).
3. **Poster fee floor** `max(bps, floor)` at creation (D4-R3).
4. **`cancelOpenJob`** — poster-initiated cancel per the banked 2026-08-01 decisions (any-Open
   scope, 1h minimum-open floor — decision ④).
5. Dispute windows, milestones, EIP-712 external schema registration, waiver flags, timeout and
   rejected/finalize paths: **unchanged** from v2.

## 2. Requirements

**R1 — Brokered flag.** A session is `brokered = true` iff the claim entered via the operator
broker path (`claimJobFor`); worker-signed `claimJob` → `false`. Snapshot at claim, immutable for
the session's life, readable on-chain (the platform's preflight must be able to quote it).

**R2 — Retention at settlement.** On an approved `resolveSinglePayout`:
`retained = min(retentionFlatRaw, reward × retentionCapBps / 10_000)` (integer, round down);
worker receives `released − retained`; `retained` accrues to `treasuryAccount` (the existing v2
sink — one sink, distinct events keep the accounting split). Retention applies **only** when all
of: outcome approved, `brokered == true`, onboarding waiver not set (tier-0's 3 claims stay
whole — earn-from-zero sacred). **No payout ⇒ no retention:** rejected, slashed, disputed-lost,
timeout, and tombstone-rescue paths never retain — a failed brokered job eats the gas float, which
is exactly why exposure semantics (D/E: exposure = reserved reward + brokered gas) are **unchanged**
by v3; retention reduces realized cost on success, not open exposure.

**R3 — Retention schedule snapshot at CLAIM.** `retentionFlatRaw`/`retentionCapBps` are copied
into the session at claim time — a worker settles under the schedule they saw when claiming, never
a later one (the economics analog of v2's per-job `protocolFeeBps` snapshot at creation; preflight
parity for economics, D4 §5).

**R4 — Settable schedule with ceilings.** Storage: `{retentionFlatRaw, retentionCapBps,
posterFeeBps (existing), posterFeeFloorRaw}`; one admin setter (multisig-held admin), one
`FeeScheduleChanged` event carrying old and new values. Contract-enforced ceilings, all `constant`:
`MAX_RETENTION_FLAT_RAW = 500_000`, `MAX_RETENTION_CAP_BPS = 2_500`,
`MAX_PROTOCOL_FEE_BPS = 1_000` (existing), `MAX_POSTER_FEE_FLOOR_RAW = 500_000`. A fat-fingered
admin op is bounded by construction; reverting one is a single admin op (the ratified cheap abort).

**R5 — Poster fee floor at creation.** `fee = max(reward × posterFeeBps / 10_000,
posterFeeFloorRaw)`, snapshotted per job at creation (v2 idiom), applied to **all** posts —
economically circular on our own catalogue, revenue on external. Existing fee-waiver flags keep
their v2 meaning.

**R6 — `cancelOpenJob`.** Poster-only (the recorded poster), state must be `Open`, and
`block.timestamp ≥ createdAt + 1 hours` (decision ④'s minimum-open floor — a worker mid-preflight
isn't rug-pulled by instant cancel). Effect: full refund of unreleased reward + fee + reserves to
the poster's AAC liquid (same accounting as v2's `_refundPosterBalances`), terminal `Cancelled`
state, `JobCancelled(jobId, poster, refundedRaw)` event. This **replaces the ~7d tombstone promise
as the poster-facing path** (decision ⑤'s public `cancellation` object and the poster guide update
to "cancel any time after 1h, instant refund"); the operator tombstone rescue remains the fallback
for non-Open strandings and legacy stock, unchanged.

**R7 — Events.** New: `GasRetentionApplied(jobId, worker, retainedRaw, rewardRaw)`,
`FeeScheduleChanged(...)`, `JobCancelled(...)`, plus a brokered indicator readable at claim
(field on the existing claim event or a getter — Codex's call, but the indexer must be able to
classify brokered sessions from logs alone; payout evidence stays log-derived, never
source-derived).

## 3. Initial constants (= D4 ratified values; acceptance criteria)

| Knob | Ceremony-initial | Ceiling |
|---|---|---|
| `retentionFlatRaw` | 50_000 | 500_000 |
| `retentionCapBps` | 2_000 | 2_500 |
| `posterFeeBps` | 500 (carried from v2) | 1_000 |
| `posterFeeFloorRaw` | 50_000 | 500_000 |

## 4. Ceremony + migration (operator-run; follows the proven pool pattern)

- **Deploy:** guarded script per the #1093 pattern — mandatory `--expected-deployer`, address
  predictions from the **verified signer's pending nonce**, admin EOA deployer
  `0x9Ab8531F…4239` (`op://mainnet-critical/admin-eoa-mainnet/credential`), fork-simulated
  end-to-end before mainnet (the pool ceremony's discipline, including postcondition assertions).
- **Wiring:** multisig legs via Nova Spektr — SCALE extrinsic hex from `@polkadot/api`
  `tx.revive.call(...).method.toHex()`, refTime 4e9 / proofSize 100k / storageDeposit 1e9;
  semantic calldata verification stays with the architect. Role writes verified **on the contracts**
  (TreasuryPolicy roles are contract state; the API's role model has disagreed before — KMS signer
  `0x5a6836…5813` holds `settlementBroker`/`verifiers`, the admin EOA does not).
- **D-03 contract-surface gate:** contract changes without a shipped manifest fail closed and the
  freeze is sticky — stage `knownUnshippedContractChanges` with the exact masked runtime hash
  (escrowCore + legacyEscrowCore share ONE artifact — waive both), and the waiver-landing deploy
  needs a `verify_contract_source=1` dispatch (Tier-1 path-match early-return gotcha).
- **Migration:** new posts go to v3 at cutover; v2 becomes `legacyEscrowCore` and runs its stock
  off through existing windows — **including the in-flight first rescue (finalize due
  2026-08-16T14:55:12Z), which proceeds on v2 untouched.** Residual v2 stock drains via the
  tombstone tool afterwards; then the long-open item "revoke v1 once drained" finally executes for
  **both** v1 and v2. Indexer: v3 ABI + address, legacy kept for history.
- **Same-deploy platform flip (no stale-advertising window):** retention activates only in the
  deploy that also ships — listing/`estimateNetReward` retention lines, preflight/explain/claim
  parity for the new refusal-free deduction quote, poster surfaces quoting `max(5%, 0.05)` before
  escrow, the poster guide + `/poster/onboarding` `cancellation` object flip to `cancelOpenJob`,
  Hermes-only revenue lines (retained gas vs poster fees, distinct series), board trailing-7d
  worked-cost tile with the 80%-of-flat alert (D4-R5).
- **Companion backend fix (rides the platform PR):** the claim path finally consults
  `isExternalJobDelisted` (today delisted jobs remain claimable and brokered — the two-chokepoint
  gap from the cancel design review).

## 5. Acceptance

1. Fork-sim ceremony transcript: deploy at predicted addresses, wiring postconditions exact,
   `FeeScheduleChanged` decoded showing §3 initials.
2. Retention math tests: dust (0.10 → 0.02), standard (0.25 → 0.05), cap boundary, waived tier-0
   → 0, self-paid → 0, rejected/slashed/cancelled → 0; snapshot-at-claim honored across a
   mid-session schedule change.
3. `cancelOpenJob` tests: refund exactness (reward + fee + reserves), 1h floor reverts before /
   succeeds after, non-poster reverts, non-Open reverts, claim-vs-cancel race (a claim landing
   first blocks cancel until timeout — v2 lifecycle preserved).
4. Ceiling tests: every knob reverts above its `MAX_`.
5. Parity: preflight/explain/claim quote identical retention for a brokered candidate; a
   self-paid candidate quotes zero. Smoke extended accordingly.
6. Events sufficient for the indexer to classify brokered sessions and split
   retained-gas vs poster-fee revenue from logs alone.

## 6. Out of scope

DepositPool changes (`PLATFORM_FEE_BPS=0` stands), D3 lane budgets, D0 valve internals (lands
first, untouched), credit layer (consumes retention's rail later; nothing here anticipates it
beyond R2's event), any raise of pool caps or `G_cat`.

## 7. Dispatch note

Fire to Codex **after the D0 handback is gated and merged** — one narrow packet in flight per the
working agreement, and D0's surface edits (door copy, explain payloads) are upstream of v3's
same-deploy flip. Contract work (Solidity + tests + fork-sim script) can begin immediately on
dispatch; the ceremony itself is operator-run with architect-gated calldata, as with the pool.

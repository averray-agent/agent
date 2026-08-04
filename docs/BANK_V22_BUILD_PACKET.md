# Bank v2.2 — build packet (five laws as contract structure)

The rebuild spec for the XCM transport layer, written the evening of the first completed
dust cycle (2026-08-04). v2.1 closed that cycle with every unit accounted — 150,000 staged
= 130,200 returned + 525 + 17,932 + 1,343 named losses — and with two structural defects
proven live on mainnet. v2.2 exists to make those defects, and the failure classes behind
them, impossible rather than avoided.

> **Read this first — the operating decision is already made** (Pascal, 2026-08-04, "this
> has to work flawless"): **no further v2.1 deposits.** Both prior generations are
> retired-paused on chain (v2.0 `0xc846eE73…`, v2.1 `0x2AF394fA…`, zero armed condemned
> wrappers). The full dust ladder re-runs on v2.2 from scratch, and only a green ladder
> admits the first real epoch (10 USDC). Flawlessness is a structural property, not an
> operational aspiration: every rule in this packet that CAN live in the contract MUST
> live in the contract. Off-chain conventions are documented as conventions and are not
> accepted as real-money controls (v2.1 ceremony doc, "structural fee-at-staging defect").

## 1. The defect ledger (why each change exists — all proven live, all cited)

| # | Defect | Live proof | v2.2 answer |
|---|--------|-----------|-------------|
| D-1 | **Fee-at-staging.** Exact payload bytes pinned at `queueRequest`; remote fee quotes are perishable (measured drift 17,599 → 17,932 raw in ~3 h). A 3.5 h-stale fee failed `BuyExecution` with `Processed(success=false)`, 0.3 B refTime consumed, full 17,932 trapped (`AssetsTrapped` hash `0x430cf4ce…`). `PayloadMismatch` forbids the only safe retry. | AH tx `0x64f649b8…` blk 19,046,778; Hydration blk 13,456,243 | §3.1 constructive shapes + fee as a dispatch-time argument, capped at staging |
| D-2 | **Dishonest terminalization.** `settleRequest(Failed)` unconditionally records `recoveryAssetsOutstanding = requestedAssets` (gross 150,000) while the chain could return at most 131,543; the slot can never honestly reach zero. v2.1 carries a permanent 19,800 residue labeled "accounting artifact, known-unrecoverable". | Terminalization tx `0xc34167372…` blk 19,048,419; adapter source `:307,:345-356` | §3.2 observer-proven terminal accounting + explicit residue write-off |
| D-3 | **Preflight environment lied.** The 4/4 pre-arm "deployed-contract" preflights ran on an ephemeral fork with staged balances; the live send path had never executed until dispatch day. Separately, the dispatcher used default limits (10 B/500 k) below both the recorded outer AND the live need (11.73 B). | leg-2 stop #1 (`XcmDispatchFailed`, empty bytes) resolved by D1-maxed rerun | §4.1 live-state-only gate evidence + dispatchers that refuse defaults |
| D-4 | **Multisig-staged requests invisible to the board.** The staged deposit never passed through the backend, so no watch existed; a wedged request aged invisibly until manually backfilled. | `/monitor/bank-feed` empty while request pending, 2026-08-04 morning | §4.2 watch-from-chain-events, not from dispatcher goodwill |
| D-5 | **Stale-pointer generation split.** Feed env + manifest carried retired v2.0 identities after the v2.1 redeploy; the board's first live values were reads of a dead generation. | #931/#932 incident record | §4.3 references the now-existing guards; adds the sole-armed-wrapper invariant |

What v2.1 proved and v2.2 must **keep** (do not redesign what worked):
request-scoped transport with topic-bound messages; strict shape control; idempotent leg
bitmap (replay-safe under the observed cross-generation requestId collision
`0xb609f4d8…`); `settled ≤ requested` bounds; owner-only paused-only recovery with the
beneficiary hard-bound to the wrapper image — **executed flawlessly live, first try**
(tp 19049628-2, 130,200 home); the full-balance-as-fee-budget message pattern that made
recovery immune to fee drift; two-step configure-then-arm ceremonies; #926 deploy
provenance guards; #931/#932 manifest single-source + repoint enforcement.

## 2. The five laws (normative; each maps to a section below)

1. **Every cross-chain resource price is perishable.** Quote at dispatch time, over-provision
   ×2, rely on surplus-return. Prices include: EVM gas (proven 99.6 % estimate accuracy, tx
   `0x64f649b8…`), extrinsic weight envelopes, and remote `BuyExecution` fees. Weights are
   deterministic meters, not prices — fresh-measured ×2 at dispatch, no staleness window.
2. **A reading has an identity.** Every consumer read derives from the manifest single
   source; a redeploy repoints every consumer in the same change (exists — referenced).
3. **Honest books at every layer the truth passes through.** No contract slot, feed field, or
   evidence figure may state an amount the chain cannot produce; discrepancies become
   explicit named lines, never silent residue.
4. **The gate believes only live state.** Fork rehearsals develop message shapes; they never
   green a ceremony.
5. **One generation in flight.** Exactly one armed wrapper may exist across all recorded
   generations; retirement (pause) is part of succession, not hygiene debt.

## 3. Contract deltas

### 3.1 Wrapper v2.2 — constructive shapes, fee at dispatch

**The core change: staging stores PARAMETERS; the contract CONSTRUCTS message bytes at
dispatch.** v2.1 already does this for the funding leg (`_buildDepositFunding`); v2.2
extends it to all four shapes (+ recovery, which already re-derives). The validating
allowlist disappears because nothing external is ever validated — you cannot mismatch
what you construct. `PayloadMismatch` ceases to exist as a concept.

- `queueRequest(...)` stores per-request: kind, amounts (sell amount, expected minimums),
  accounts (already immutable-bound), **`maxFeePerLeg`** — a multisig-staged ceiling on
  dispatch-time fees — and optionally `dispatchDeadline` (see below).
- Operator dispatch becomes `dispatchLeg(requestId, legKind, feeAmount)`:
  - reverts unless `feeAmount ≤ maxFeePerLeg` (the operator cannot drain value through the
    fee parameter; the ceiling is signed by the multisig at staging);
  - constructs the leg's message with `feeAmount` spliced at build time — the dispatcher
    quotes fresh ×2 and passes it (law 1); surplus returns via the shape's mandatory
    `RefundSurplus`/`DepositAsset` tail;
  - bitmap idempotence unchanged (a set bit is a no-op, never a revert-with-loss).
- **Drift-proof-by-construction rule:** `withdraw_sell` uses the complete remote asset-22
  operating float as its fee budget with surplus-deposit, but that float is only knowable
  at dispatch. The operator therefore supplies the fresh-read float as `feeAmount`, capped
  by the multisig-staged `maxFeePerLeg`. `withdraw_home` and `recovery_home` use their
  request-bound amount as their own full fee budget and need no dispatch-time fee
  parameter. `deposit_sell` also receives a fresh dispatch-time fee; `deposit_funding`
  constructs its local execution weight directly.
- Deposit staging carries explicit transport margin:
  `sellAmount + maxFeePerLeg + fundingTransferFeeHeadroomRaw <= assets`. The roughly
  525-raw fee observed during v2.1 is evidence, not a hardcoded constant; the current
  headroom is captured and recorded by the dispatcher.
- Withdraw-home guarantees the request's `minimumOutput`, not an exact remote sweep.
  `actualOut - minimumOutput` plus fee surpluses remains visible as converted-account
  asset-22 operating float. A future sweep may reclaim it; v2.2 must not label it lost
  or silently coerce it to zero.
- `dispatchDeadline` (optional per request, default off): after it passes, dispatch reverts
  and only terminalization + recovery remain. Belt to the fee-parameter suspenders; NOT the
  primary control (a deadline still races ceremony latency; the parameter doesn't).
- Golden-vector requirement: for each shape, the constructed bytes at fixed inputs must
  equal the known-good v2.1 messages that passed live/dry-run (funding `0x9cb6d71a…`,
  recovery `0xc92c9814…` families), adjusted only at the documented fee/amount slots.
- Unchanged: recovery_home semantics (owner-only, paused-only, beneficiary hard-bound,
  nonce-scoped), pause gating, `_validateSettlementBounds`, operator/settler roles,
  converted-account immutability post-configure.

### 3.2 Adapter v2.2 — observer-proven terminal accounting

- `settleRequest(Failed, …)` gains `observedRemoteBalanceRaw`, reported by the strategy
  settler (the same trust role that already reports settled amounts — no new trust, one
  more duty). The contract records
  `recoveryAssetsOutstanding = min(observedRemoteBalanceRaw, requestedAssets)` and emits
  `TerminalAccounting(requestId, requestedAssets, observedRemoteBalanceRaw, outstanding)`.
  The gross figure survives only inside the event history, never as a live claim.
- New: `writeOffResidue(requestId, amountRaw, bytes32 reasonCode)` — owner-only, decrements
  outstanding, emits `ResidueWrittenOff`. Slots CAN now reach zero honestly; every loss is
  an explicit signed line (law 3). The off-chain evidence carries the named split (fees vs
  trap) that the chain cannot know.
- Release path unchanged (partial-tolerant, proven at 130,200-of-150,000).
- Share accounting untouched — phase-2 material stays phase-2 (`BANK_PHASE2_PROGRAM.md`
  D1–D8 are explicitly NOT in scope here).

## 4. Off-chain deltas

### 4.1 The dispatcher protocol, as code (not checklist)

The operator dispatch script refuses to sign unless, in one tight session: fresh
`ReviveApi_call` measure through the deployed contract on live state → limits = measured
×2 (defaults and recorded outers are not accepted inputs — D-3); fresh `eth_estimateGas` →
gas = estimate ×2; fresh remote fee quote → `feeAmount` = quote ×2 (≤ `maxFeePerLeg`);
observer watch confirmed armed (§4.2) — then sign, then assert receipt + record `gasUsed`.
Gate evidence files carry `liveState: true` and capture-time re-reads (the
`dispatchPaused:true` skeleton-carryover taught why); my gate rejects fork-derived
evidence for any arm/dispatch decision (law 4).

### 4.2 Watch-from-chain, not from dispatcher goodwill

The observer indexes the wrapper's staging/dispatch events and creates watches from them —
a request staged by the multisig becomes board-visible with a baseline at staging, before
any dispatcher runs (D-4). The backfill path from 2026-08-04 becomes the standing import.
Board contracts (zero-is-not-a-reading, calibration-by-prover, target-scoped watches with
fail-closed `unknown`) carry over from #697/#718/#720 unchanged.

### 4.3 The sole-armed-wrapper invariant (enables an honest `subject`)

With law 5 enforced by succession procedure, "exactly one armed wrapper among all
generations in `bankXcmDeploymentHistory`" becomes chain truth. The feed's retired
`subject` field (removed from #932 as green-by-construction) can return in v2.2 as a real
check: **env wrapper == the unique armed wrapper in recorded history** — candidate set from
append-only history, verdict from the chain's paused bits, and a stale env FAILS it.
Board-side rendering is the board agent's lane; the backend exposes the two facts.

## 5. Gate ladder (acceptance — nothing skips a rung)

- **G0** Spec review: Pascal signs the decisions; Codex files closed-ended questions only.
- **G1** Build: contracts + units + foundry, including adversarial cases — fee above
  `maxFeePerLeg` reverts; non-operator dispatch reverts; terminal accounting with
  `observed < requested`, `observed = 0`, `observed > requested` (capped); residue
  write-off events; golden vectors vs v2.1 known-good bytes; constructive-shape fuzz
  (no input reaches `IXcm.send` outside the four shapes + recovery).
- **G2** Deploy ceremony (guarded per #926: source-commit reachable, forced build,
  creation-hash, selector probe) → paused, unconfigured → conversion evidence 2-endpoint →
  configure ceremony → **manifest + env repoint in the same change** (#931 pattern; CI
  asserts template==manifest).
- **G3** Live preflights: all legs through the deployed contract on live state, fresh ×2 —
  this replaces the fork rehearsal as the arm evidence → arm ceremony (separate, as
  always).
- **G4** Full dust ladder: stage ≤150,000 with multisig-signed `maxFeePerLeg` → funding →
  sell with dispatch-time fee → **first aUSDC = the board's calibration event** → hold one
  observation interval → withdraw sell → withdraw home → books zero-unexplained → pause
  test (staging refused while paused).
- **G5** (decide after G4 economics, default skip): deliberate recovery drill on v2.2 —
  recovery code is minimally changed and live-proven on v2.1; a drill costs a real trap.
- **Then and only then:** 10-USDC epoch 1 (threshold per the amended epoch policy,
  2026-08-02).

## 6. Economics and ceremony budget

Measured 2026-08-04, carried as planning figures: deploy ≈ 2 DOT; postage fund 0.3 DOT
fresh image (leg ≈ 0.015–0.03 DOT delivery); operator dispatch ≈ 0.014 DOT gas each
(estimate accuracy 99.6 %); remote fees ≈ 18 k raw/leg quoted, embedded ×2, surplus
returns. Full dust cycle ≈ $0.10–0.15 all-in. Pascal ceremonies: deploy-fund, configure,
arm, stage — four signing sessions, same Nova Spektr method (broadcast-retry on first sign
is expected 2-of-2 behavior, not failure).

## 7. Non-goals

No phase-2 agent deposits, shares UX, yield fees, caps enforcement, or venue changes —
`BANK_PHASE2_PROGRAM.md` owns those and is untouched. No new venue verification — the
Hydration mechanism facts from the phase-1 packet §2 stand. No changes to AAC. No claim
shape for the trapped 17,932 (write-off #3 stands; a claim capability is future work if
real money ever traps, which this design exists to prevent).

## 8. Handoff

Codex implements against this packet in its own worktree, one PR per reviewable unit
(contracts; dispatcher+observer; manifest/env plumbing), each handed back for my gate.
Chain/settlement remains Codex's lane; ceremonies remain Pascal's; every packet that
reaches a signature gets independent byte verification first. The empirical record this
packet is built on: `docs/BANK_PHASE1_DEPLOYMENT_CEREMONY.md` (v2.2 requirements section),
PR #933/#934 evidence files, and the 2026-08-04 entries in the operator's project log.

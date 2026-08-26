# RUNSHEET — Pool v2.1 activation (phased)

Status: **DRAFT — HOLD until the venue-setter amendment merges** · 2026-08-26 ·
Author: Claude (architect + gate) · Executor: Pascal (every money step) ·
Authority: `MEMO_IDLE_BALANCE_ROUTE.md` R1–R5, Q1′, Q1″, Q2 (all RATIFIED).

**Two ceremonies, deliberately.** Q1″ made the venue binding settable-once
precisely so the pool does not need the venue stack on day one. Ceremony A
activates aggregation (idle balances flow, capital sits in buffer). Ceremony B
activates yield (venue stack + bind). Splitting halves the risk per signing
session and lets A run as soon as the amendment lands.

## HOLD gates (all must clear before Ceremony A)

- [ ] Venue-setter amendment merged; **new masked runtime hash** recorded here: `________`
- [ ] Its `verify_contract_source=1` Tier-3 dispatch green
- [ ] Aggregator adapter (#1297, merged) hash re-confirmed at deploy time: `sha256:8090ce50…f2ad2`
- [ ] Deployer funded: **≥ 3 DOT** on admin EOA `0x9Ab8531F…4239` (2 CREATEs ≈ 1.8 + upfront holds + margin; the 1010 lesson)
- [ ] This runsheet's step-0 reads re-verified same-day (runsheet-already-ran law)

## Ceremony A — aggregation live

### A0 · Establish state (read-only)

Enumerate live v2 holders (`totalSupply`, `balanceOf` per known wallet, and
the share ledger from deposit events) — the migration list is **derived on the
day, never hardcoded here**. Read `policy.owner()`, confirm cold multisig.
Confirm v2.1 + adapter artifacts reproduce their masked hashes from the
merged source (drift tooling, `--artifacts out`).

**Gate:** paste everything. I confirm before any signature.

### A1 · Deploy DepositPool v2.1 (1 CREATE, admin EOA via KMS ceremony tooling)

Constructor: `(policy, asset, operator, venueAdapter=0x0, creditPool)` — same
policy/asset/operator/creditPool as live v2 (read them from v2, do not
transcribe). Venue deliberately zero; Q1″ binds it in Ceremony B.

**Gate:** I verify the arg encoding against v2's live values before commit.

### A2 · Deploy AacPoolAggregatorAdapter (1 CREATE)

Constructor: `(agentAccountCore, poolV21)` — the AAC at `0xb1350932…9e57` and
A1's address. No circularity: the adapter derives asset/operator from the pool.

### A3 · Fund postage (plain DOT transfers on Asset Hub, Pascal)

- AAC `0xb1350932…9e57` (EVM-derived account): **0.1 DOT** — allocateIdleFunds
  approve precondition
- New adapter address (EVM-derived account): **0.1 DOT** — sweepToPool approve
  precondition

Read both back non-zero before A4. (Postage law: Asset Hub `system.account`
of `address || 0xEE×12` — the wrong-ledger trap is documented in the recall
runsheet.)

### A4 · Multisig calls (cold 2-of-3; one Nova session, sequential)

1. `TreasuryPolicy.setApprovedStrategy(adapter, true)`
2. `StrategyAdapterRegistry.registerStrategy(adapter)`
3. `StrategyAdapterRegistry.setStrategyActive(strategyId, true)` — id
   `0x4141435f49444c455f4445504f5349545f503f4f4c…` **read it from
   `adapter.strategyId()` on the day, never from this document**
4. `poolV21.setAggregatorAdapter(adapter, true)`

Multisig law in full per call: I precompute each `blake2AsHex`; Nova must
display exactly that hash; revive weights measured per call
(`reviveApi.call → weightRequired`), never assumed.

**Gate:** I verify all four encoded calls + hashes before the first signature.

### A5 · Migrate operator positions (v2 → v2.1)

Per enumerated operator wallet: `v2.redeem` → `v2.1.deposit`, tranches
preserved backend-side (the proven v1→v2 choreography). **The tester's
5.026011 shares stay on v2 untouched** — their move is theirs, at leisure
(Q1′). v2 remains fully honest for them: door stops quoting new v2 deposits
app-side; withdrawals unchanged.

**Gate:** two-sided balance confirmation per wallet.

### A6 · Backend cutover + verification

Env/template PR: v2.1 address into the pool doors, consent-gate `routeLive`
flip **only after** A4 completes. Then verify live: `/pool` serves v2.1,
consent gate reports available, attribution zero-state reads v2.1, **and the
tester's v2 position still renders correctly wherever it appears**.

## Ceremony B — yield live (STUB until scheduled)

New `HydrationDepositPoolAdapter(poolV21, lane)` + lane as a **precomputed
two-CREATE pair** (they bind mutually immutably — accepted in Q1″), venue
postage on the new venue account, then multisig `poolV21.setVenueAdapter(…)`
(set-once), then deployment per the standing venue ceremony scripts. Follows
the documented bank-v2.2 ceremony pattern; gets its own detailed runsheet
when scheduled. Until B, v2.1 correctly reports `not_deployed` /
"eligible, not deployed" — already-shipped honest copy.

## Abort conditions (any one ⇒ stop and report)

- Any masked hash fails to reproduce at A0.
- Nova shows any hash other than precomputed (per call).
- A deploy lands with unexpected code size or constructor revert.
- Postage reads zero at A4 time.
- Any migration wallet's two-sided read disagrees.
- The consent gate reports available before A4 has completed.

## What this runsheet does not do

Deploy the venue stack (Ceremony B), move the tester's funds, change consent
text, pay any subsidy, or enable allocation for any agent (that requires the
per-agent opt-in, which stays dark until A6 flips `routeLive`).

# RUNSHEET — Pool v2.1 activation (phased)

Status: **COMPLETE AND PROVEN LIVE 2026-08-27 — first real allocation executed end to end; R2 exemption verified in production.** · 2026-08-26 ·
Author: Claude (architect + gate) · Executor: Pascal (every money step) ·
Authority: `MEMO_IDLE_BALANCE_ROUTE.md` R1–R5, Q1′, Q1″, Q2 (all RATIFIED).

**Two ceremonies, deliberately.** Q1″ made the venue binding settable-once
precisely so the pool does not need the venue stack on day one. Ceremony A
activates aggregation (idle balances flow, capital sits in buffer). Ceremony B
activates yield (venue stack + bind). Splitting halves the risk per signing
session and lets A run as soon as the amendment lands.

## HOLD gates — ALL CLEARED 2026-08-26

- [x] Venue-setter #1299 merged (`684ab886`); pool masked hash `sha256:100a21cd5139b36528c6d6d6b5f716ff2ed67c5a89fbde48f407b27e10754355`
- [x] Tier-3 `verify_contract_source=1` green (run 32992784374)
- [x] Adapter hash: on-chain == merged-main artifact (18 slots masked). **The #1297
      handback figure `8090ce50…` is superseded, benignly**: #1299 changed
      `DepositPoolV2.sol`, which the adapter imports, moving only the 32-byte
      embedded metadata digest (bytes 4329–4360); functional bytecode is
      byte-identical. Proven by artifact diff across both PR trees.
- [x] Deployer ran at 2.58 DOT (per-CREATE floor enforced in-script; both cleared)
- [x] A0 same-day reads executed and gated

## EXECUTED RECORD — 2026-08-26

| step | result |
|---|---|
| **A1 · DepositPool v2.1** | **`0x9B35A102d656Fb86d798aF81959e09961DEc28E0`** — tx `0xc8d09a2c…4fe7a06a`, block 19913549, nonce 22, prediction matched, on-chain masked runtime == artifact == waiver (`100a21cd…`), constructor `(policy, USDC, operator, 0x0, creditPool)` all live-read, venue unbound |
| **A2 · AacPoolAggregatorAdapter** | **`0x1DDcA7097c752580c6561e1bF8C673D6C1665CA5`** — tx `0x913702ed…69c9e4ef`, block 19913651, nonce 23, 4,372 runtime bytes, strategyId `AAC_IDLE_DEPOSIT_POOL_V21`, operator derived from pool, async probe reverts (SYNC classification) |
| A0 holder map | `0xdc1Ed106…` 10.000000 · `0x60385dD6…` 0.501328 · tester `0x97450BF6…` 5.026011 · **protocol-held 10.000000 (no exit path exists — stays in v2 permanently, guaranteeing the tester's exit liquidity)** |
| **A3 postage — EXECUTED** | Both funded to **0.21 DOT** (0.01 + 0.2 top-up after the 0.01=ED-only finding). **Definitive probe passed 2026-08-26 evening: both approve legs (AAC→adapter, adapter→pool) succeed via real eth_call.** Lesson recorded: exactly-ED postage fails (deposit needs free balance above ED), and EVM stateOverride cannot probe this — the precompile reads the Substrate balance. |
| Deploy tooling | `scripts/ops/deploy-pool-v21.mjs` (in the gate1299 worktree; committed to this branch alongside this runsheet) |

## A5 EXECUTED — 2026-08-26 evening (before A4; verified independent of it)

Both operator positions migrated by owner-signed redeem→approve→deposit,
exact-delta, pre-existing wallet USDC untouched
(`scripts/ops/migrate-pool-v21.mjs`, committed on this branch):

| wallet | v2 shares → v2.1 shares | txs (redeem/approve/deposit) |
|---|---|---|
| dogfood `0xdc1Ed106…` (op://mainnet-critical/dogfood-depositor-mainnet/password) | 10.000000 → **9.908397** | `0xce661446…` / `0xc8e41d76…` / `0xd8ce160b…` |
| acceptance `0x60385dD6…` (op://mainnet-critical/acceptance worker wallet/password) | 0.501328 → **0.496735** | `0x5ac66b32…` / `0x446510d1…` / `0x8e189a74…` |

End state, book-verified: **v2.1 supply/assets 10.405132 / 10.405132, price
exactly 1.000000**; v2 retains the tester (5.026011 at 0.990840, untouched)
plus the permanently-parked protocol 10.0. v2.1's `maxIssuedAgentShares` is
now 9.908397 (the dogfood position) — its bufferFloor accordingly.

## FIRST LIVE ALLOCATION — 2026-08-27 11:49Z · THE R2 EXEMPTION IS PROVEN

Operator consent captured by KMS-signed SIWE from inside agent-mainnet-backend
(terms hash `0xe78c3d7e…`, active to 2026-11-25). Keeper allocated on its next
tick, unattended, at full size per the operator's decision.

| measure | before | after | meaning |
|---|---|---|---|
| operator `liquid` | 16.073522 | **2.000000** | 2.0 headroom respected exactly |
| operator `strategyAllocated` | 0 | **14.073522** | per-agent accounting works |
| adapter float | 0 | 10.000000 | swept down to the 10.0 target |
| pool `totalAssets` | 10.405132 | **14.478654** | +4.073522 swept in |
| pool `bufferFloor` | 9.908397 | **9.908397** | **UNCHANGED — the whole point** |
| pool `maxDeployableAssets` | 0.496735 | **4.570257** | **+4.073522, one-for-one** |

**Deployable rose by exactly the aggregator's deposit.** Under v2's guards the
same deposit would have raised the floor by its own size and left deployable
flat (`deployable = (25.29 + X) − X`) — the defect that sent B1 back on
2026-08-25. The exemption behaves in production exactly as designed.

**Correction to my own gate expectation:** I predicted the floor test would
fire on the allocation tick. It did not and could not — `allocateIdleFunds`
puts USDC in the adapter's FLOAT; the pool only moves on `sweepToPool`. The
floor reading unchanged immediately after allocation proved nothing; the proof
came one tick later, on the sweep. **An invariant is only tested by the
operation that actually exercises it.**

**Q3 (adapter float target) now has data instead of a guess:** the 10.0 default
held 71% of a 14.07 allocation as instantly-redeemable float. Revisit once
there is more than one holder.

## A4 EXECUTED — 2026-08-27 morning · THREE calls, not four

| # | call | hash shown in Nova | timepoint | verified on-chain |
|---|---|---|---|---|
| 1 | `policy.setApprovedStrategy(adapter,true)` | `0x28d620db…912927` | 19935783-5 | `approvedStrategies` = true |
| 2 | `registry.registerStrategy(adapter)` | `0x596b319f…f550e1` | 19935980-2 | adapter + `active` both set |
| ~~3~~ | ~~`setStrategyActive(SID,true)`~~ | **SKIPPED — NO-OP** | — | see below |
| 4 | `poolV21.setAggregatorAdapter(adapter,true)` | `0xc01e74ea…2ccd96` | 19936091-2 | `aggregatorAdapters` = true |

**Call 3 was a no-op and was correctly skipped.** `registerStrategy` writes
`active: true` inside its struct literal (StrategyAdapterRegistry.sol), so the
flag AAC's allocation guard reads was already true after call 2; no off-chain
consumer reads the `StrategyStatusUpdated` event. My runsheet planned
register and activate as separate steps without reading `registerStrategy`'s
body — the ceremony was three calls. **Lesson: read the body of every call in
a ceremony, not just its name; a plausible-sounding sequence can contain a
step the contract already performs.**

**END-TO-END PROOF (the check that actually matters):** with all state set,
`allocateIdleFunds(broker, AAC_IDLE_DEPOSIT_POOL_V21, amount)` **simulates
clean at both 1.0 and 5.0 USDC** by eth_call from the live settlementBroker
against the broker's real 16.073522 liquid. The adapter still fails the async
probe (correctly classified synchronous). The route is live.

### ABI defect found and fixed during this ceremony

`a4-verify.mjs` carried a WRONG `strategies(bytes32)` shape — four fields in
the wrong order versus the real five (`bytes32 strategyId, address adapter,
address asset, string riskLabel, bool active`). It read fine while the slot
was all zeros (a zero slot decodes as a valid empty tuple) and **reverted on
the first populated read**. The pre-run's "registry entry UNSET" was therefore
right by luck, not construction. Same class hit `positions`, which is keyed
`(account, asset)` not `(account)`. Both corrected against contract source.

## A4 SIGNING PACKAGE — for the 2026-08-27 session (precomputed, verified by simulation)

Four `revive.call` extrinsics, gas 4e9 / proof 600k / deposit 1e9. **Execute
strictly in order** — 2 requires 1's state, 3 requires 2's (their simulations
revert-flag on today's state for exactly that reason; 1 and 4 simulate clean).
Nova must display EXACTLY these hashes:

1. `policy.setApprovedStrategy(0x1DDcA709…, true)` → `0x28d620db749d43fa686b8c369ce331a2e592636e2f29c9816409c60d01912927`
2. `registry.registerStrategy(0x1DDcA709…)` → `0x596b319f3b0f1fe4cf86da09834e5caf4c7890863abcb44b7d3a2c22a1f550e1`
3. `registry.setStrategyActive(AAC_IDLE_DEPOSIT_POOL_V21, true)` → `0x9ddc7a2f65be9cf2b6f8c106dbb859e043082992f1bfad668bfb42e3e6076a6a`
4. `poolV21.setAggregatorAdapter(0x1DDcA709…, true)` → `0xc01e74ead8f55502cd193200813ec1954282c5ac74f1433b1b0ed92fb92ccd96`

Call-data hex blocks live in the session log of 2026-08-26 and are
reproducible from the four (target, selector, args) tuples above; regenerate
and re-hash on the day if there is any doubt — the hashes must reproduce.

**Re-verify before signing (runsheet-already-ran law):** all four target
states still read unset (`approvedStrategies(adapter)=false`, no registry
entry, `aggregatorAdapters(adapter)=false`), and postage reads non-zero on
both A3 accounts.

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

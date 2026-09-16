# RUNSHEET — Ceremony C: pool v2.2 goes live (deploy · bind · migrate · commit · first 90-day window)

Status: **written 2026-09-16; tooling T1–T3 landed in #1385 (gated 2026-09-16), T4 pending the real addresses.** Blocked on (a) #1383 merge ✓,
(b) T4 (§0), (c) measurement cycle 2 recalled and
settled (the wrapper pause in §4 must not overlap a lane operation), (d) C1 decided 2026-09-16 (pause the idle keeper at cutover). Executor: Pascal. Mirrors Ceremony A/B
(`RUNSHEET_POOL_V21_ACTIVATION.md`, `RUNSHEET_CEREMONY_B_VENUE_BIND.md`).
Authority: `PACKET_POOL_V22_COMMITMENT_WINDOWS.md` @ 96b7b7c7 (R1–R6, R0
answered), `docs/POOL_V22_COMMITMENT_WINDOWS.md` (implementation, #1383).

## The shape, in one paragraph

Two CREATEs by the ceremony deployer (v2.2 pool, then the v2.2 locked
aggregator), two more by the pair driver (v2.2 lane + adapter), hashes
reproduced on a second machine, DOT postage to both new contract accounts,
**seven multisig calls** (four for the aggregator/registry, three for the lane
+ the set-once venue binding), a 7-day notice redemption of the operator's
v2.1 positions started on day 0, redeposit into v2.2 and a **90-day
commitment** on day 7, backend cutover, then the first
`--deployment-kind committed` window. Outside holders are never moved.

## §0 — Tooling prerequisites (Codex, before anything below runs)

- **T1** `scripts/ops/deploy-venue-pair.mjs` hardcodes the v2.1 pool
  (`assertV21Pool`, `contracts.depositPoolV21`) and the strategy name
  `AAC_IDLE_HYDRATION_V1`. Add a `--target v22` mode: pool =
  `contracts.depositPoolV22`, strategy name **`AAC_COMMITTED_HYDRATION_V22`**
  (names the purpose, like B1 did), manifest keys `depositPoolLaneV22` /
  `hydrationDepositPoolAdapterV22`, adapter constructed against the v2.2 pool
  so `adapter.pool()` reads v2.2. Refuse if the v2.2 address is absent.
- **T2** `scripts/ops/deploy-deposit-pool.mjs` deploys the `DepositPoolV2`
  artifact and reads the deployer key from 1Password. Add artifact selection
  for `DepositPoolV22` (constructor `(policy, USDC, operator, 0x0,
  creditPool)`, same five arguments as v2.1) and a second CREATE for
  `AacPoolAggregatorAdapterV22(agentAccountCore, poolV22)`; predict both
  addresses from the live nonce; print the multisig calldata for M1–M3 below
  exactly as the v2.1 driver printed A4's.
- **T3** Manifest + provenance: new keys `depositPoolV22`,
  `aacPoolAggregatorAdapterV22`, `depositPoolLaneV22`,
  `hydrationDepositPoolAdapterV22` with sourceCommit + creation/runtime hashes;
  `contracts.depositPool` and `contracts.depositPoolV2` are *movable aliases*
  (A6) — repoint to v2.2 at cutover; the v2.1 identity stays under
  `depositPoolV21` and gains a `legacyDepositPoolV21` alias; `CONTRACT_ARTIFACTS`
  in `check-contract-provenance.mjs` maps the four new names. No
  `knownUnshippedContractChanges` entry is expected: v2.1's source is
  unchanged and v2.2 is a new name. Tier-3 `verify_contract_source=1` dispatch
  after the manifest lands.
- **T4** Env cutover PR (templates, generated mainnet template): the pool
  address the gateway reads (`depositPool` alias), `POOL_V22_CEREMONY_COMPLETE=1`,
  `POOL_V22_ADDRESS`, `POOL_V22_AGGREGATOR_ADDRESS`; `IDLE_BALANCE_ALLOCATION_KEEPER_ENABLED=0`
  (C1) with `POOL_V22_LOCKED_KEEPER_ENABLED` per the operator at cutover;
  door copy: v2.1 deposits retired (the contract has no pause), withdrawals
  unchanged, redeposit into v2.2 at leisure, R3 disclosure.

## Decision for the operator

- **C1 — DECIDED 2026-09-16 (Pascal): pause the idle keeper at cutover.**
  T4 sets `IDLE_BALANCE_ALLOCATION_KEEPER_ENABLED=0`; idle AAC float stays in
  AAC and `/me` + the pool page say so. No new sweeps into v2.1
  (`AAC_IDLE_DEPOSIT_POOL_V21`); existing v2.1 aggregator shares exit by notice
  in §5a. An idle (Flex) v2.2 aggregator is a separate follow-up packet after
  the first 90-day window — one CREATE, two multisig calls, keeper re-enable.

## Timeline

| day | what | who |
|---|---|---|
| D0 | §1 deploy pool + aggregator; §2 pair; §3 hashes on a second machine; postage; **start the 7-day notice on the operator's v2.1 shares (§5a)** | Pascal |
| D0–D1 | §4 multisig (M1–M3 any time; M4–M6+M7 only with no lane op in flight) | Pascal, Nova + Vault |
| D0–D2 | T3/T4 PRs merge; backend on v2.2 (§6) — deposits into v2.2 open | Codex/Claude/Pascal |
| D7 | §5b fulfil the notice, deposit into v2.2, `commit(Notice90Days)`; §7 first committed window | Pascal |

The 7-day notice is the long pole; starting it on D0 is what keeps the
ceremony to a week.

## §1 — Deploy pool v2.2 and the locked aggregator (ceremony deployer EOA)

Dry run, read, then commit — the v2.1 A1/A2 shape. (`--contract DepositPoolV22`
is mandatory: the driver's old default `DepositPool` is the three-CREATE legacy path.)

```bash
node scripts/ops/deploy-deposit-pool.mjs --profile mainnet --contract DepositPoolV22 --expected-deployer 0x9Ab8531FBb0948C542a31298FD61335f30064239
```

Read: predicted addresses for the pool and the aggregator (two nonces),
constructor args live-read (policy `0x226F1425…`, USDC `0x00000539…`, operator
`0x5a6836…`, venue `0x0`, creditPool `0x903B3185…`), creation-hash for each
artifact. Commit with `--signer-secret-ref 'op://mainnet-critical/admin-eoa-mainnet/credential' --commit`
(the key never leaves your shell). Gate after commit: on-chain masked runtime
== artifact hash for both; `pool.operator()`, `pool.asset()`,
`pool.venueAdapter() == 0x0`, `aggregator.pool() == poolV22`.

## §2 — Deploy the v2.2 lane + adapter pair

```bash
node scripts/ops/deploy-venue-pair.mjs --profile mainnet --target v22 --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813
```

then `--commit --use-kms`. The pair driver signs with the **KMS identity**
(`0x5a6836…`, as Ceremony B did), so `--expected-signer` is the KMS address —
not the admin EOA that §1 uses (#1385 review note). Gate: `adapter.lane()` = lane, `lane.agentAccountCore()` =
adapter, **`adapter.pool()` = v2.2 (never v2.1, never legacy)**, asset USDC,
policy `0x226F1425…`, lossReporter set.

## §3 — Second-machine hash reproduction and postage

Reproduce all four creation-bytecode hashes on a second machine from the
merged commit (`forge build` from a clean checkout; compare to §1/§2
output). Do not sign §4 until they match.

Postage (plain DOT transfers on Asset Hub to the 0xEE-mapped SS58 of each
contract): **adapter ≈1 DOT** (dispatch legs), **aggregator 0.5 DOT** (the USDC
precompile's `approve` requires the caller to hold DOT — the CreditBook
lesson), pool none.

## §4 — Multisig session (2-of-3; Nova initiates, Vault countersigns)

Weights `refTime 20e9 / proofSize 800k / deposit 0.5 DOT`. Calls, each a
`revive.call` built by `@polkadot/api .method.toHex()`; I gate every blob by
independent re-encode and you check the call hash before the second
signature:

| # | call | note |
|---|---|---|
| M1 | `policy.setApprovedStrategy(aggregatorV22, true)` | as A4-1 |
| M2 | `registry.registerStrategy(aggregatorV22)` | writes `active` itself — no `setStrategyActive` (A4 lesson) |
| M3 | `poolV22.setAggregatorAdapter(aggregatorV22, true)` | as A4-4 |
| M4 | `wrapper.setDispatchPaused(true)` | **only with no lane operation in flight** |
| M5 | `wrapper.setStrategyAdapter(AAC_COMMITTED_HYDRATION_V22, laneV22)` | needs paused |
| M6 | `wrapper.setDispatchPaused(false)` | same session as M4 |
| M7 | `poolV22.setVenueAdapter(adapterV22)` | **SET-ONCE for the first binding**; later changes go through the 7-day `proposeVenueAdapter` timelock |

Eyeball rules: M3/M7 target the v2.2 address; M5 embeds the v2.2 lane; M7
embeds the v2.2 adapter; `value 0` everywhere. Post-state reads after each
pair: `approvedStrategies`, `registry.getStrategy`, `aggregatorAdapters`,
`wrapper.strategyAdapters(id)`, `pool.venueAdapter()`.

## §5 — Operator migration and the R4 commitment

**5a (D0):** `poolV21.requestRedeem(shares, self, Notice7Days)` from
`0xdc1Ed106…` (9.908397 shares) and from the acceptance wallet
(0.496735). This is the operator's own signature (MetaMask/Talisman, the
existing pool app path); record request ids and `unlockAt`. The v2.1
aggregator's 3.057059 shares (the locked cohort's money) exit by the same
notice through the aggregator's notice-exit path, back to AAC liquid — after
which the v2.2 keeper (C1/T4) re-allocates it into the new aggregator under
Ruling 2.

**5b (D7):** `fulfilRedeem` on each request → USDC at the wallets →
`poolV22.deposit(assets, self)` → **`poolV22.commit(Notice90Days)`** from each
operator holder (whole position, cannot shorten). Read back
`commitment(holder)`, `committedSharesBeyond(now + 90 d)`,
`deployableFor(90 d)` — the last one is the number §7 sizes from.

Outside holders: `0x3742de88…` (6.5 in v2.1) and the tester (5.026011 in
legacy v2) stay exactly where they are; the door explains.

## §6 — Backend cutover (T4) and verification

Merge T3/T4, deploy (**no ceremony command while the deploy runs** — it
recreates the container). Verify live: `/pool` serves v2.2 with
`deployableFor` for 7/30/90 d and the tier aggregates; the door quotes v2.2
and signs `commitmentConsentUntil`; the locked keeper (if C1 enables it)
allocates only consented locked principal and refuses shorter newcomers;
`/health` clean; the v2.1 positions still render.

## §7 — First 90-day window

```bash
RB=$(( $(date -u +%s) + 90*86400 - 4*3600 )); docker exec agent-mainnet-backend node scripts/ops/pool-venue-ceremony.mjs deploy --profile mainnet --pool <POOL_V22> --assets <min(deployableFor(90d), floor(totalAssets/2) − costBasis)> --return-by $RB --deployment-kind committed --observability-url "http://127.0.0.1:8787/monitor/deposit-pool?pool=<POOL_V22>" --expected-signer 0x5a6836c6D4d293F6E5377E6c28054F4171915813 --use-kms
```

Dry run first; the driver refuses unless the pool is the manifest's v2.2,
the window ≤ 90 d, `assets ≤ deployableFor`, and the 50 % policy holds. Then
`--commit`, then `stage-dispatch` exactly as cycle 2 — **only after the
resume fix (PACKET_DISPATCH_RESUME_STOPS_BEFORE_SETTLEMENT) is deployed**.
Rate readings at day 30 and day 60 from the far side; the first quoted rate
is the one this window measures.

## Abort conditions (any one ⇒ stop and report)

- Any hash mismatch between machines; `adapter.pool()` not v2.2.
- A lane operation in flight when M4 would be signed.
- A dry run that refuses; never change flags to make it pass.
- `deployableFor(90 d)` below 9.0 on D7 (the operator commitment did not
  land as expected).

## Handback

Addresses, the four hashes from both machines, seven call hashes with
timepoints, the notice request ids, `commitment(holder)` reads, the first
window's deployment id and request ids, and the deploy SHA that served v2.2.

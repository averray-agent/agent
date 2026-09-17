# Ceremony C pre-flight — 2026-09-16 (Claude, read-only)

All reads against Polkadot Hub mainnet (chainId 420420419) at head ≈ 20724625,
16:xx UTC, from a clean `forge build --skip test` of `origin/main` @ d37c2eed
(forge 1.7.1 native, solc 0.8.24+commit.e11b9ed9, optimizer 200, evm cancun).

## Nothing has run

| check | result |
|---|---|
| `deployments/mainnet.json` @ d37c2eed | no `depositPoolV22` / `aacPoolAggregatorAdapterV22` / `depositPoolLaneV22` / `hydrationDepositPoolAdapterV22` key; `git log -S depositPoolV22 -- '*.json'` empty |
| ceremony deployer `0x9Ab8531F…4239` | nonce **24** (v2.1 pool was nonce 22 → `0x9B35A102…`, its aggregator nonce 23 → `0x1DDcA709…`) |
| driver guard | `deploy-pool-v22.mjs` refuses if either v2.2 manifest key exists ("refusing a duplicate ceremony") |
| v2.1 pool | cycle 2 live: `activeVenueDeploymentId` 2, costBasis 10.243759, buffer 10.243760, floor 10.180516, `activeVenueRecallId` 0 |
| wrapper `0xF20b35A3…` | `dispatchPaused` false; `strategyAdapter(AAC_IDLE_HYDRATION_V1)` = v2.1 lane `0x2E01Bff9…`; `strategyAdapter(AAC_COMMITTED_HYDRATION_V22)` = `0x0` |
| v2.1 pool lane `0x2E01Bff9…` | `pendingDepositAssets` 0, `pendingWithdrawalShares` 0 (→ the M4 precondition holds now) |
| bank lane `0x96091d44…` | `pendingDepositAssets` 0, `pendingWithdrawalShares` 0, `totalAssets` 0, not bound on the wrapper |

## Predicted addresses (deployer nonce 24 / 25 — the dry run MUST print these)

| step | address | SS58 (0xEE-mapped, prefix 0) — postage target |
|---|---|---|
| poolV22 | `0x3A2dd08F85009474117CaFC476b6629AE04fB2A9` | `12KHPTGUeV8xmFH2UCfkgB8Wwb4dVw7ZAHzADBQbERB4WJ1v` |
| aggregatorV22 | `0x1b3f9B45e0B8672A4FF95Caf67Bf4dbEa385455f` | `1cjBuM7izSrCqtt78xzeHvWWbxnRv4DorzyNWQNEFgLdR95` |

Any outbound transaction from the deployer before §1 shifts both. The DOT
top-up is inbound and does not.

The lane/adapter pair (§2) is signed by the KMS identity, whose nonce moves
with every verifier transaction (2764 at read time) — not predictable ahead;
the driver predicts at run time.

## DOT budget for §1 (the finding that blocks §1 today)

| CREATE | initcode | gasUsed | fee @ 800 gwei |
|---|---|---|---|
| v2.1 pool (measured, block 19913549) | 14 414 B | 1 224 475 | 0.979580 DOT |
| v2.1 aggregator (measured, block 19913651) | 5 103 B | 1 010 514 | 0.808411 DOT |
| v2.2 pool (estimate: ≈893k fixed + 23 gas/B) | 16 772 B | ≈1 279 000 | ≈1.02 DOT |
| v2.2 aggregator (estimate) | 5 647 B | ≈1 023 000 | ≈0.82 DOT |

§1 needs ≈ **1.85 DOT**. Deployer balance: **0.792 DOT** (EVM view; Substrate
free 0.802201 incl. the 0.01 existential deposit — nonce 24 on both sides
proves the mapping). **Top up 2 DOT** to
`14Vs8Yih5mSkHNL5ZYJPiEQejZZ2EzB8MQRR3oSr5Z4pYXrm` before the §1 commit.
KMS identity `133YGXLeo4Rf2aWc7JXUbq7rmDnTrFp7tLj7Q9xdCt4bcYcg` holds 5.24 DOT — §2 is covered.

## Creation-bytecode hashes (second checkout, d37c2eed) — compare to the drivers' `creationBytecodeHash`

| artifact | keccak256(bytecode.object) | initcode / runtime |
|---|---|---|
| DepositPoolV22 | `0xe8cf0ee571b4c64e40afb6763eecea99840cf358ba3a845492e92bb5a8ed8d99` | 16 772 / 15 831 B |
| AacPoolAggregatorAdapterV22 | `0xf38ef8c4b3fa79accca86fe8b8e9cf98bc3088272e134da8f3fe47ba6c18a730` | 5 647 / 4 966 B |
| HydrationUsdcAdapterV22 (lane) | `0x997ddcced2590a77dda1a555e07916e9e55231f28e130b5b26d6bc9fc10e1efe` | 10 519 / 9 948 B |
| HydrationDepositPoolAdapter (venue adapter) | `0xe862dde09519a056c22c17d3bc8071a9b9f1f8df3eeecca4636de7a04ae49a44` | 9 711 / 8 882 B |

The drivers print `creationBytecodeHash = keccak256(artifact bytecode)` and
`initCodeHash = keccak256(tx.data)` (bytecode + constructor args). Compare the
first; the second differs per address by construction.

**Second toolchain, 2026-09-16:** the same commit rebuilt with Linux forge
1.7.1 inside Docker (`ghcr.io/foundry-rs/foundry`, colima/Ubuntu 24.04,
solc 0.8.24+commit.e11b9ed9) — all four `keccak256(bytecode.object)` digests
**identical** to the macOS-native build above. §3's "second machine" is
therefore already satisfied for the artifacts; what remains for Pascal is to
confirm the drivers print these same four digests. CI's provenance gate after
T3 (`verify_contract_source=1`) is the third, post-hoc check before §6.

## v2.1 holders (live, for §5a)

| holder | shares | ≈ assets | moves? |
|---|---|---|---|
| operator `0xdc1Ed1061e4a6E35aafb8f4E59B8893113d2EDeC` | 9.908397 | 10.180516 | yes — MetaMask `requestRedeem(…, Notice7Days)` |
| acceptance wallet `0x60385dD643f10934E8F384aC7A04c0D798dFc936` | 0.496735 | 0.510377 | yes — same |
| v2.1 aggregator `0x1DDcA7097c752580c6561e1bF8C673D6C1665CA5` | 3.034767 | 3.118112 | yes — **keeper float exit only** (see below) |
| outside `0x3742de88F246Af444aafd5810DA2d722Bc89620d` | 6.5 | 6.678512 | **no** |

totalSupply 19.939899. (The runsheet's 3.057059 for the aggregator predates
the 2026-09-15 `RedeemFulfilled` id 2.)

## The aggregator's exit has exactly one trigger

`AacPoolAggregatorAdapter.requestFloatExit` / `fulfilFloatExit` are
`onlyOperator` (KMS `0x5a6836…`) and the only caller is the idle-balance
keeper; there is no admin route and no ops script. The keeper requests an exit
when `float < target`, with `target = min(totalAssets × FLOAT_TARGET_BPS / 10000,
FLOAT_TARGET_RAW) + queued`, always at tier 0 = `Notice7Days`, and fulfils it
itself after `unlockAt`. Mainnet today: `KEEPER_ENABLED=1`, `FLOAT_TARGET_BPS=2500`,
`FLOAT_TARGET_RAW=10000000` (10 USDC cap, already above the aggregator's ≈3.16
total). The keeper reads the aggregator from the **`aacPoolAggregatorAdapter`
alias** (`DEPLOYED_AAC_POOL_AGGREGATOR_ADAPTER`).

So the C1 mechanism that is actually executable: T4 sets
`IDLE_BALANCE_ALLOCATION_FLOAT_TARGET_BPS=10000` (target = whole position →
the keeper requests a full 7-day exit and can never sweep into v2.1 again),
keeps `KEEPER_ENABLED=1` **until that exit is fulfilled**, keeps the
`aacPoolAggregatorAdapter` alias on `0x1DDcA709…` until then, and only after
the fulfilment flips `IDLE_BALANCE_ALLOCATION_KEEPER_ENABLED=0`. This honours
C1 (no new sweeps into v2.1 from the moment T4 deploys) without a new tool.

## D0 record — 2026-09-17

**T0 top-up:** 2 DOT received; deployer `14Vs8Yih…` free 2.802201 (EVM view 2.792201), nonce still 24 (both views, head 20745747).

**§5a notices (7-day clock started 06:38:24Z; verified from `redeemRequests` and receipts, not the script output):**

| request | owner = receiver | shares | tx | block | fee |
|---|---|---|---|---|---|
| 3 | dogfood depositor `0xdc1Ed106…2EDeC` | 9.908397 | `0x9d58f1c607b94674366ab01febab162edf1cf299f0d84d6e3bb2bcab0fe1bd81` | 20745901 | 0.0158736 DOT |
| 4 | acceptance wallet `0x60385dD6…c936` | 0.496735 | `0x150d7729c65c1620567ccd436c7c69052e4a95d1fbf059bc6c5ae322e518ac0f` | 20745906 | 0.0158736 DOT |

Both tier 0 (`Notice7Days`), `unlockAt` **2026-09-24T06:38:24Z** (= D7), `fulfilled` false; `lockedShares` now equals each balance, `availableShares` 0; `nextRedeemRequestId` 5. Fulfilment needs ≈10.69 USDC in the buffer (10.24 today, cycle 2's 10.19 returns with the 09-22 recall) — the recall must settle before D7.

## §1 DONE — 2026-09-17 06:58Z (sourceCommit d37c2eed, worktree `.claude/worktrees/ceremony-c`)

| contract | address | tx | block | gasUsed | fee |
|---|---|---|---|---|---|
| DepositPoolV22 | `0x3A2dd08F85009474117CaFC476b6629AE04fB2A9` (nonce 24 ✓) | `0x9f0a28790bf6cc45596d4004e77289623a8346ab762edb6bae8dc271ac6ea38a` | 20746434 | 1 280 997 | 1.0247976 DOT |
| AacPoolAggregatorAdapterV22 | `0x1b3f9B45e0B8672A4FF95Caf67Bf4dbEa385455f` (nonce 25 ✓) | `0x5ac20a5c73b845340fdaea75fb9d0abe5d5358a910b68721b9d81b6e561f527a` | 20746446 | 1 023 985 | 0.819188 DOT |

Total 1.844 DOT (estimate was 1.85). Deployer now nonce 26, 0.948 DOT.

Gate (Claude, chain reads at ≈20746500): masked runtime == artifact for both (`compareMaskedRuntime`, immutables masked);
`pool.operator()` = `0x5a6836…`, `pool.asset()` = USDC precompile, `pool.policy()` = `0x226F1425…`, `pool.creditPool()` = `0x903B3185…`,
`pool.venueAdapter()` = `0x0`, `aggregatorAdapters(aggV22)` = false (M3 pending), `NOTICE_90_DAYS` 7 776 000, `VENUE_REBIND_DELAY` 604 800,
`DEPLOYMENT_EPOCH` 86 400; `aggregator.pool()` = poolV22, `strategyId` = `AAC_LOCKED_DEPOSIT_POOL_V22`, `operator` = `0x5a6836…`.
Driver evidence: creationBytecodeHash pool `0xe8cf0ee5…` / aggregator `0xf38ef8c4…` (= banked, = Linux build);
maskedRuntimeHash pool `sha256:ade555c3e1f9914aa060c0b57be21a3858ec43ebd3e41b8873aee7cd53181734`, aggregator `sha256:d8a083e0db4f8c79b23c1cdea76ce6bbcdd57e7a8c3ceaca8a6ae423e66e4f7f`;
abiHash pool `sha256:5ca679f1…`, aggregator `sha256:0cf0c795…`; 12 confirmations each, receipt + post-state reconfirmed.
M1–M3 calldata re-encoded independently (✓) — see the driver output banked in the runsheet handback.

Manifest staging for §2: branch `ceremony-c/manifest` in the ceremony worktree adds `contracts.depositPoolV22`,
`contracts.aacPoolAggregatorAdapterV22`, deploymentBlocks and deployers (provenance entries are T3's).

## §2 DONE — 2026-09-17 07:14Z (inside `agent-mainnet-backend`, side profile `/deployments/mainnet-cc.json`, KMS identity `0x5a6836…`)

| contract | address | tx | block | gasUsed | fee |
|---|---|---|---|---|---|
| HydrationUsdcAdapterV22 (lane) | `0xd3d76AB8f4642B54C04Be8091F01Be66e91a1aa1` (KMS nonce 2764 ✓) | `0xc00b40d90545b5139ca21112da3cb3d41dd30679ce449f78657aec72f672f6c0` | 20746872 | 1 135 684 | 0.9085472 DOT |
| HydrationDepositPoolAdapter (venue adapter) | `0x2894667cF9A54D94695Ca168B81154aA50955722` (KMS nonce 2765 ✓) | `0x525736a10fa415d136cf78604bc31904d64c096ad2baa11f93b10fcf2162e5be` | 20746874 | 1 116 558 | 0.8932464 DOT |

Gate (Claude, chain reads): masked runtime == artifact for both; `lane.agentAccountCore()` = adapter, `lane.xcmWrapper()` = `0xF20b35A3…`,
`lane.strategyId()` = `AAC_COMMITTED_HYDRATION_V22`, `lane.policy()`/`asset()` as bound; `adapter.lane()` = lane, **`adapter.pool()` = poolV22 `0x3A2dd08F…`**,
`adapter.lossReporter()` = policy-owner multisig `0x01E6eed856e989201F4FF6346E18EAb7e46C874C`, `activeDeployRequestId` 0. Init-code hashes rebuilt independently from
artifact + printed constructor args (✓ both). Driver provenance: lane maskedRuntimeHash `sha256:0faec68edf65d6adf5a56677904f4ac8e467b9ec0a59e5247f4184e2fcc18bad`,
abiHash `sha256:53a7d2d0…`; adapter maskedRuntimeHash `sha256:82acc3690054051a039d2e5f5ccab8a2b6f76fe1c8c9f4704a4d6a92de6220f4`, abiHash `sha256:64e406be…`; sourceCommit d37c2eed.
KMS signer after: nonce 2766, 3.438 DOT. The Mac dry run and the in-container dry run printed identical plans (nonce 2764 both times).

**How §2 ran:** the KMS credentials (Roles Anywhere) exist only inside the backend container and the image bakes the two pair artifacts, but the
image's `/deployments/mainnet.json` predates §1 — so the staged manifest (worktree branch `ceremony-c/manifest`) was `docker cp`'d as a **side
profile** `/deployments/mainnet-cc.json` (driver accepts it: `profile: "mainnet"` inside the file + binding constants) and the driver ran with
`--profile mainnet-cc`. The side file is ephemeral (gone on the next deploy) and never replaced the real manifest.

### §3 postage targets (0xEE-mapped SS58, prefix 0)

| contract | H160 | SS58 | postage |
|---|---|---|---|
| venue adapter V22 | `0x2894667cF9A54D94695Ca168B81154aA50955722` | `1vCzyKBnJ19RcFxHJ7uc7M2QmhU4ESRodWoWztXQ8Yv2Xhb` | **≈1 DOT** (dispatch legs) |
| locked aggregator V22 | `0x1b3f9B45e0B8672A4FF95Caf67Bf4dbEa385455f` | `1cjBuM7izSrCqtt78xzeHvWWbxnRv4DorzyNWQNEFgLdR95` | **0.5 DOT** (USDC precompile `approve` needs DOT) |
| lane V22 | `0xd3d76AB8f4642B54C04Be8091F01Be66e91a1aa1` | `15nm6ZTFutQdx7FLTeL85RBBy7vReUwJvxAcAWuEG5w7KBPf` | none |
| pool V22 | `0x3A2dd08F85009474117CaFC476b6629AE04fB2A9` | `12KHPTGUeV8xmFH2UCfkgB8Wwb4dVw7ZAHzADBQbERB4WJ1v` | none |

Both postage accounts read 0 DOT at 07:20Z.

# PACKET — Ceremony C, T3 + T4: manifest provenance and the two-step backend cutover

Status: **ready for Codex, 2026-09-17.** Upstream facts are on chain (§1 and §2
executed; evidence `docs/evidence/ceremony-c-preflight-2026-09-16.md`).
Authority: `RUNSHEET_CEREMONY_C_POOL_V22.md` §0 T3/T4, §5a, §6; decision C1.

## What exists on chain (sourceCommit d37c2eed, all gated)

| key | address | block | deployer |
|---|---|---|---|
| `depositPoolV22` | `0x3A2dd08F85009474117CaFC476b6629AE04fB2A9` | 20746434 | `0x9Ab8531F…4239` |
| `aacPoolAggregatorAdapterV22` | `0x1b3f9B45e0B8672A4FF95Caf67Bf4dbEa385455f` | 20746446 | `0x9Ab8531F…4239` |
| `depositPoolLaneV22` | `0xd3d76AB8f4642B54C04Be8091F01Be66e91a1aa1` | 20746872 | `0x5a6836…5813` (KMS) |
| `hydrationDepositPoolAdapterV22` | `0x2894667cF9A54D94695Ca168B81154aA50955722` | 20746874 | `0x5a6836…5813` (KMS) |

Provenance the drivers printed (use verbatim; the shape mirrors the existing
`contractProvenance[0x9B35A102…]` entry — `sourceCommit`, `abiHash`,
`runtimeCodeHash`, `verifiedAt`; add `creationBytecodeHash` and
`maskedRuntimeHash` if the validator accepts them, otherwise keep the four):

| contract | creationBytecodeHash | abiHash | runtimeCodeHash | maskedRuntimeHash | verifiedAt |
|---|---|---|---|---|---|
| DepositPoolV22 | `0xe8cf0ee571b4c64e40afb6763eecea99840cf358ba3a845492e92bb5a8ed8d99` | `sha256:5ca679f1a3faa6a4a3b24afcebf5ce076261cbe9ce054a4c1a8ed765e1421834` | `sha256:2b582d10e6d3bb2647ef3538145023c5251e8fd8ef777f5d6a5f9ba3770c4e1d` | `sha256:ade555c3e1f9914aa060c0b57be21a3858ec43ebd3e41b8873aee7cd53181734` | 2026-09-17T06:58:53.868Z |
| AacPoolAggregatorAdapterV22 | `0xf38ef8c4b3fa79accca86fe8b8e9cf98bc3088272e134da8f3fe47ba6c18a730` | `sha256:0cf0c795643b11a7711a0b8c7a4d09d9f9d61ca0023da832d257d2615f0fff76` | `sha256:2495ef2b77063e8c4c5cca56f4b48a0adb3e72744862c06ad782a28d65177f7c` | `sha256:d8a083e0db4f8c79b23c1cdea76ce6bbcdd57e7a8c3ceaca8a6ae423e66e4f7f` | 2026-09-17T06:59:18.209Z |
| HydrationUsdcAdapterV22 (lane) | `0x997ddcced2590a77dda1a555e07916e9e55231f28e130b5b26d6bc9fc10e1efe` | `sha256:53a7d2d069bb023a5c9b7eedae2dac463fb60f6512a67d3471656b817c9d217b` | `sha256:88cc20b28b25f9279f2faef51f6dacd9a85bdbf2120c79cc0e0585602a423ae2` | `sha256:0faec68edf65d6adf5a56677904f4ac8e467b9ec0a59e5247f4184e2fcc18bad` | 2026-09-17T07:14:25.651Z |
| HydrationDepositPoolAdapter (venue adapter) | `0xe862dde09519a056c22c17d3bc8071a9b9f1f8df3eeecca4636de7a04ae49a44` | `sha256:64e406be7c2d1a3045b6fadb92d390884924b888c1e5879eeac97c787d85d698` | `sha256:5c1a809625b111b33d25006cfe998bf8e73730b9b47127f4b6c50b61695a317a` | `sha256:82acc3690054051a039d2e5f5ccab8a2b6f76fe1c8c9f4704a4d6a92de6220f4` | 2026-09-17T07:14:25.917Z |

A staged, un-pushed manifest with the four `contracts` keys plus
`deploymentBlocks` and `deployers` (no provenance yet) sits on the worktree
branch `ceremony-c/manifest` at `.claude/worktrees/ceremony-c` (commits
671fc8d0, 775d13a1) — start from it or redo it; the diff is additive only.

## PR 1 — T3: manifest entries (merge now; nothing moves)

- `deployments/mainnet.json`: the four `contracts` keys, `deploymentBlocks`,
  `deployers`, and four `contractProvenance` entries from the table.
  **No alias changes in this PR** — `depositPool`/`depositPoolV2` keep pointing
  at v2.1 until §4's multisig binds v2.2 (M3, M7) and §6 says so.
- `CONTRACT_ARTIFACTS` in `scripts/ops/check-contract-provenance.mjs`: confirm
  #1385 already maps `depositPoolV22`, `aacPoolAggregatorAdapterV22`,
  `depositPoolLaneV22`, `hydrationDepositPoolAdapterV22` (it should); add
  `legacyDepositPoolV21` only when the alias moves (PR 2).
- No `knownUnshippedContractChanges` entry: v2.1 source is unchanged, v2.2 is
  a new name (runsheet T3).
- `scripts/ops/render-mainnet-backend-env.mjs --check` must stay green (the
  mainnet template is GENERATED; if the manifest feeds it, re-run the
  renderer and commit the output).
- After merge: Tier-3 `verify_contract_source=1` dispatch — this is the
  independent-toolchain provenance check the runsheet's §3 wants green before
  §6. Report the run URL.

## PR 2 — T4 step 1: cutover (after the §4 multisig session; Claude confirms `poolV22.venueAdapter()` and `aggregatorAdapters` first)

Edit `deploy/backend.env.template`, then re-run the renderer (never hand-edit
`backend.mainnet.env.template`):

- `POOL_V22_CEREMONY_COMPLETE=1`, `POOL_V22_ADDRESS=0x3A2dd08F85009474117CaFC476b6629AE04fB2A9`,
  `POOL_V22_AGGREGATOR_ADDRESS=0x1b3f9B45e0B8672A4FF95Caf67Bf4dbEa385455f`;
  `POOL_V22_LOCKED_KEEPER_ENABLED` = operator's call at cutover (default off;
  Pascal decides in the PR).
- Manifest aliases (A6): `contracts.depositPool` and `contracts.depositPoolV2`
  → `0x3A2dd08F…`; `deploymentBlocks` for both → 20746434; add
  `contracts.legacyDepositPoolV21` = `0x9B35A102…` (keep `depositPoolV21`);
  `CONTRACT_ARTIFACTS` gains `legacyDepositPoolV21`.
- **C1 mechanism, step 1 (this PR):** `IDLE_BALANCE_ALLOCATION_FLOAT_TARGET_BPS=10000`
  with `IDLE_BALANCE_ALLOCATION_KEEPER_ENABLED=1` **unchanged** and
  `contracts.aacPoolAggregatorAdapter` **unchanged** (`0x1DDcA709…`, the v2.1
  aggregator). Effect: the idle keeper's float target becomes the whole
  position (cap 10 USDC already exceeds it), so on its next tick it calls
  `requestFloatExit` for all 3.034767 v2.1 shares at `Notice7Days`, and it can
  never sweep into v2.1 again. This is how C1 ("pause at cutover") becomes
  executable — the aggregator's only exit path is the keeper.
- Door copy: v2.1 deposits retired (no pause exists in the contract),
  withdrawals unchanged, redeposit into v2.2 at leisure, R3 disclosure; the
  v2.1 positions still render.
- Deploy: **no ceremony command while the deploy runs** (container recreate).
- Verify live (§6): `/pool` serves v2.2 with `deployableFor` 7/30/90 d and tier
  aggregates; `/health` clean; the keeper's next log shows `requestFloatExit`
  with a request id — send Claude the request id and `unlockAt`.

## PR 3 — T4 step 2: keeper off (after the keeper has fulfilled the float exit, ≈ D8–D9)

- `IDLE_BALANCE_ALLOCATION_KEEPER_ENABLED=0` (C1 as decided); the
  `aacPoolAggregatorAdapter` alias may then move to `0x1b3f9B45…` if the v2.2
  locked keeper is to read it, otherwise leave it.
- Verify: `/me` and the pool page say idle float stays in AAC; no
  `sweepToPool` in the log after the deploy.

## Tests that pin it

1. Provenance: `check-contract-provenance` against live code for all four
   names passes (masked runtime) — the deploy's D-03 gate.
2. Renderer `--check` green; a test that the four `POOL_V22_*` keys render into
   the mainnet template from `backend.env.template`.
3. Keeper: with `FLOAT_TARGET_BPS=10000` and pool shares > 0, one tick yields
   `requestFloatExit` for the full share balance at tier 0; with
   `KEEPER_ENABLED=0` no tick runs (existing behaviour, assert it).
4. Alias move does not change `depositPoolV21` reads (the v2.1 positions still
   render — the §6 check).

## Handback

PR numbers (three, in order), CI links, the Tier-3 dispatch URL for PR 1, the
deploy SHA for PR 2, the keeper's `requestFloatExit` request id + `unlockAt`,
and the deploy SHA for PR 3.

# Ceremony runsheet — DepositPool v2 + CreditPool (L1 activation)

Status: READY — kit built + fork-rehearsed 2026-08-13 evening; execute 2026-08-14.
Operator: Pascal runs every money-moving command. Claude gates each step and
verifies on-chain. Codex owns the contracts (shipped via #1108/#1111-era merges);
the ceremony scripts live on branch `ceremony-pool-v2` (commit b702cbd4, pushed).

What this ceremony does: deploys the four L1 contracts (new lane, new venue
adapter, DepositPool v2, CreditPool), repoints the wrapper's
`HYDRATION_USDC_POOL_V1` strategy to the new lane via multisig, and migrates the
single dogfood position (10.0 USDC, par) from v1 to v2 **byte-exactly** — same
share count, same assets, vesting tranche continuity preserved. L1 (secured
credit line) goes live capped, quiet, disclosed, per ratified CL-1..5 and D8.

Invariants that must survive the day:
- No depositor economics change. Dogfood ends with exactly 10_000_000 shares
  and 10_000_000 assets in v2. The preserved tranche keeps its ORIGINAL
  depositedAt (2026-08-12T20:32:00Z, block 19387820, tx 0x9bbebd48…d73e7b).
- Exits stay ungated on both pools at every intermediate state.
- The old pool is never bricked mid-flight: until the multisig repoint, v1 is
  fully live; after it, v1 still honors withdrawals (repoint affects only new
  strategy dispatches).

## §0 Preconditions (all checked before starting)

- [x] #1113 merged (14:15Z) AND the verification deploy is green: run
      31709778441 — D-03 Tier 2 all 12 contracts `[ok]`, Tier 3 candidate build
      + immutable-masked comparison PASSED (both waivers hit their exact masked
      hashes: legacyEscrowCore f194f905…, hydrationUsdcAdapter 0faec68e…),
      indexer ready + smoke passed, health `ok` with only the two steady-state
      warnings (xcm_observer_staged, gas_sponsor_disabled). No sticky freeze.
- [ ] Admin EOA 0x9Ab8531F…4239 ≥ 2.0 DOT and nonce noted. Verified 2026-08-13:
      3.0203 DOT, nonce 15. If nonce ≠ 15 on the day, predictions shift — fine,
      the deploy script re-predicts; update `--expected-start-nonce`.
- [ ] v1 pool par + single-depositor (script preflights re-verify): dogfood
      0xdc1Ed106…EDeC holds shares == totalSupply == assets == 10_000_000,
      buffer == assets, no active venue deployment/recall.
- [ ] forge 1.7.1 (pinned) + artifacts built on branch `ceremony-pool-v2`.
- [ ] Nova Spektr + Vault phone charged; multisig
      14LA8vJD8JeQYMRd5yhiw3hxD7CK5txhfL9GSNPjzLRKc3YK threshold 2/3.
- [ ] Reward bank untouched — this ceremony moves NO bank funds (no-seed
      migration; the fork's operator-seed generality is provably unnecessary at
      par on an empty pool).

## §1 Rehearsal evidence (2026-08-13, banked)

Full fork-execute rehearsal at live head (block 19417941), Foundry 1.7.1,
plain `anvil --fork-url <mainnet> --chain-id 31337`:

- byteExact: **true**; old pool drained to 0 shares / 0 assets.
- Wrapper repoint + unpause executed; `strategyAdapter(HYDRATION_USDC_POOL_V1)`
  → new lane; `dispatchPaused` → false.
- Predicted addresses at nonce 15 (recompute on the day if nonce moved):
  lane `0x88eE70277E486136676c0b50Ed9b7D7A1a31371f`,
  venueAdapter `0xE2801E6C640e0180798912649fD567E1Ea459a35`,
  depositPoolV2 `0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30`,
  creditPool `0x903B318586A3772c99185000676f4AC356DD6E4B`.
- Full JSON: `poolv2-fork-evidence.json` (attach to the cutover PR).

Note for reruns: the sim's `--fork-execute` requires a **forked** anvil with
`--chain-id 31337`. Real EVM contracts (policy, wrapper, v1 pool) fork fine;
only the USDC runtime precompile can't, and the sim shims it. A bare anvil
fails in the pool constructor (`venueAdapter.lossReporter()` → `policy.owner()`
has no code).

## §2 Day-of preflight — fork-sim against live head

```bash
anvil --fork-url https://services.polkadothub-rpc.com/mainnet/ --chain-id 31337
```

```bash
node scripts/ops/simulate-creditpool-l1-migration.mjs \
  --rpc http://127.0.0.1:8545 \
  --source-rpc https://services.polkadothub-rpc.com/mainnet/ \
  --deployer 0x9Ab8531FBb0948C542a31298FD61335f30064239 \
  --wallet 0xdc1Ed1061e4a6E35aafb8f4E59B8893113d2EDeC \
  --fork-execute
```

Gate: `byteExact: true`, old pool 0/0, wrapper repointed + unpaused. Record the
predicted addresses; they are binding for §3. Kill anvil before §3.

## §3 Deploy — guarded script, admin EOA (4 CREATEs)

Dry-run first, always:

```bash
node scripts/ops/deploy-creditpool-l1-mainnet.mjs --profile mainnet --phase deploy \
  --expected-deployer 0x9Ab8531FBb0948C542a31298FD61335f30064239 \
  --expected-start-nonce 15 \
  --signer-secret-ref op://mainnet-critical/admin-eoa-mainnet/credential
```

Gate on the dry-run output: predicted addresses match §2 exactly; strategyId
prints `HYDRATION_USDC_POOL_V1` (repoint, NOT a new id); four creation-byte
sizes print. Then re-run with `--commit`.

Script guarantees: imports `buildDeploymentPlan` from the sim (mainnet executes
the rehearsed bytes — no drift possible); per-step pending-nonce re-read +
CREATE-address assert; refuses off-par or multi-depositor v1; refuses < 2 DOT.

Postcondition (script prints): RISK_DISCLOSURE on both v2 and creditPool —
the D8 disclosure lives in the contracts themselves.

## §4 Multisig repoint — Nova Spektr + Vault (one batchAll, 3 legs)

```bash
node scripts/ops/encode-poolv2-multisig.mjs --lane <LANE_FROM_§3>
```

Legs (all `revive.call` to wrapper 0xF20b35A3…d2Bc, gas 25e9 refTime /
600k proofSize / 1e9 deposit — the v3 OutOfGas lesson, do NOT lower):
1. `setDispatchPaused(true)`
2. `setStrategyAdapter("HYDRATION_USDC_POOL_V1", <new lane>)`
3. `setDispatchPaused(false)`

Flow (proven 2026-08-13 in the v3 ceremony): paste hex as Call data in Nova
Spektr, Main initiates, verify the printed blake2 hash **on the Vault device**,
countersign, execute. Claude verifies semantic calldata before signing and
afterwards on-chain:

```bash
cast call 0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc "strategyAdapter(bytes32)(address)" \
  $(cast --format-bytes32-string "HYDRATION_USDC_POOL_V1") \
  --rpc-url https://services.polkadothub-rpc.com/mainnet/
```

Gate: returns the new lane; `dispatchPaused()` returns false.

## §5 Migrate — dogfood position, byte-exact (no seed)

Plan: `v1.redeem(10_000_000)` → `usdc.approve(v2, 10_000_000)` →
`v2.deposit(10_000_000)`. At par into an empty pool this mints exactly
10_000_000 shares — the script asserts the exact count and refuses a non-empty
v2 or off-par v1.

```bash
POOL_V2_ADDRESS=<V2_FROM_§3> node scripts/ops/deploy-creditpool-l1-mainnet.mjs \
  --profile mainnet --phase migrate \
  --wallet-key-op op://mainnet-critical/dogfood-depositor-mainnet/password
```

Dry-run, gate, then `--commit`. Then:

```bash
POOL_V2_ADDRESS=<V2_FROM_§3> node scripts/ops/deploy-creditpool-l1-mainnet.mjs \
  --profile mainnet --phase verify
```

Gate: `byte-exact migration: OK`, v1 residual supply 0.

## §6 Cutover PR — env, manifest, D-03 pins (one PR, one deploy)

Same discipline as v3 (#1111): everything in ONE PR so the deploy gate sees a
consistent world. Contents:

- `deployments/mainnet.json`:
  - `contracts.depositPool` → v2 address (repoint, xcmWrapper-style);
    `contracts.creditPool` NEW entry; the old pool address leaves `contracts`
    (drained, supply 0) but its `deploymentBlocks` history stays.
  - `deploymentBlocks`: add the four new contracts at their deploy blocks.
  - `contractProvenance`: FOUR new entries (lane, venueAdapter, depositPoolV2,
    creditPool) — sourceCommit + abiHash computed via the checker's own
    exported functions, runtimeCodeHash live-baked (the #1111 lesson).
  - `knownUnshippedContractChanges`: remove any entry the cutover ships;
    re-check the hydrationUsdcAdapter waiver still matches reality.
- Backend env template: v2 pool address, credit-door config (capped, quiet,
  disclosed), and the **initialTranches vesting record** from the sim's
  `vestingMigration` output — D0 continuity is data, not inference.
- Observer/board feed env: pool address repoint (BANK pillar reads it).
- Attach `poolv2-fork-evidence.json` + all ceremony tx hashes to the PR body.

Deploy dispatch after merge (indexer readiness lesson):
`-f components=all -f wait_for_ready=1 -f health_stability_sec=120
-f verify_contract_source=1`.

## §7 Live acceptance (small, real)

- `/account/position` for dogfood shows the v2 position with the original
  tranche date; `whatYourBalanceCanDo` reflects retention-not-gates.
- Pool page shows v2 with the D8 disclosure line; caps 1000/100 intact.
- CreditPool: read-only checks only (operator wired, zero loans outstanding).
  First real draw is NOT ceremony-day.

## §8 Abort table

| Failure | State | Action |
|---|---|---|
| §3 partial (CREATE n of 4 failed) | Some contracts live, unreferenced | STOP. Nothing points at them; nonce advanced. Re-predict from the NEW nonce and redeploy all four fresh; orphans stay inert. Never mix old/new predictions. |
| §4 multisig rejected/OutOfGas | v2 deployed, wrapper still → v1 lane | Safe hold. v1 fully live. Regenerate blob, retry (v3 took 3 attempts). |
| §5 redeem done, deposit fails | Dogfood holds 10.0 USDC in EOA | Funds are in our own EOA — re-run migrate (redeem no-ops on 0), or deposit manually. No third-party exposure. |
| §6 deploy gate red | Chain cut over, prod env stale | Prod keeps serving v1 pool reads (drained but valid). Fix the PR, redeploy. Do not hotfix env by hand. |

## §9 Explicitly NOT ceremony-day

- First credit draw / tier-3 wiring exercise (own packet, after cutover soaks).
- Old-pool contract retirement paperwork beyond the manifest edit.
- Any reward-bank movement.
- EscrowCore v3 §7 acceptance proofs (separate thread, needs first v3 posting).

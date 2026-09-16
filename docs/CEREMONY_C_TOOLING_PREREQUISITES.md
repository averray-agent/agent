# Ceremony C tooling — no cutover in this change

Authority: `RUNSHEET_CEREMONY_C_POOL_V22.md` §0 at `4609e0f7` on
`claude/packets-2026-08-12`. Pascal executes the ceremony. These drivers
prepare or deploy contracts only when explicitly invoked by the operator;
this implementation does not execute them, move funds, sign multisig calls,
change live manifest addresses, or enable a keeper.

## T1 — explicit v2.2 venue pair

`deploy-venue-pair.mjs --target v22 --expected-signer <address>` resolves
only `contracts.depositPoolV22`; absent, zero, v2.1 or legacy-v2 targets are
refused before resolving a signer. The lane uses
`AAC_COMMITTED_HYDRATION_V22`, distinct from the locked AAC aggregator's
`AAC_LOCKED_DEPOSIT_POOL_V22`. Output names `depositPoolLaneV22` and
`hydrationDepositPoolAdapterV22`. The post-state check requires
`adapter.pool()` to equal the selected v2.2 identity, not a movable alias.

The default remains v2.1. Its immutable identity is `depositPoolV21`, so
later moving `depositPoolV2` does not redirect an old-generation ceremony.
Commit remains `--commit --use-kms` with the required explicit signer.
`--expected-signer` must be the actual KMS identity in that mode: the EOA in
the runsheet example cannot be assumed to be the KMS signer. A mismatch
refuses. Pool binding and wrapper pause/mapping remain multisig-owned.

## T2 — pool plus locked aggregator

```text
node scripts/ops/deploy-deposit-pool.mjs --profile mainnet \
  --contract DepositPoolV22 --expected-deployer <ceremony EOA>
```

This explicit mode predicts pool at pending nonce N, aggregator at N+1.
It reads the v2.1 policy/asset/operator/creditPool and AAC policy/registry at
one live block and compares them to the manifest before building the two
constructors. Pool venue starts at zero. The aggregator's constructor is
exactly `(agentAccountCore, predictedPoolV22)`.

The old default is the original three-CREATE `DepositPool` driver, **not**
`DepositPoolV2`; the runsheet's description of that default was stale.
Always use the explicit `--contract DepositPoolV22` option for Ceremony C.

Unsigned preview does not read a 1Password key, even if a reference is
supplied. Commit requires `--signer-secret-ref <operator-approved op://ref>`
and `--commit`; the derived EOA must match the explicit expected deployer.
Chain preflight runs before secret access. Both drivers require a full
40-hex `DEPLOYED_SHA` in commit mode, attributing the independently reproduced
artifacts to the clean, merged source checkout. Build that checkout with
the pinned Foundry version before using either driver.

M1–M3 output includes the target, zero value and EVM calldata for:

1. policy approval of the new aggregator;
2. registry registration (no redundant `setStrategyActive`);
3. the new pool's aggregator permission.

These are **not** signed or sent by the driver. Pascal wraps them in
`revive.call`, independently re-encodes and checks each call hash under the
runsheet's multisig procedure.

Each CREATE rechecks the pending nonce. Pool deployment must reach 12
canonical confirmations, pass immutable-binding reads and match its masked
runtime before the aggregator CREATE. The aggregator receives the same
checks. Nonce drift, a failed transaction, wrong address, runtime mismatch,
reorg or timeout stops the sequence. Do not rerun a partially successful
sequence blindly: inspect the printed transaction hashes and reconcile the
already-created contracts first.

## T3 — evidence first, manifest second

Both drivers print actual canonical deployment evidence separately from
their unsigned predictions: full source commit, creation-bytecode keccak256,
ABI SHA-256, deployed runtime SHA-256, immutable-masked runtime SHA-256,
confirmation evidence and addresses. A compiled runtime is never recorded
as if it were a deployed runtime. Compare all four creation hashes on the
second machine before authorizing binding.

The four new artifact mappings and `legacyDepositPoolV21` are supported by
the provenance checker. Both the provenance and source-drift checks resolve
movable aliases to the v2.2 artifact **only when their address matches the
explicit `depositPoolV22` identity**. Existing v2/v2.1 records and waivers
remain unchanged; no v2.2 unshipped-change waiver is introduced.

After the operator supplies the verified deployment evidence, the manifest
PR records the four new contracts, address-keyed provenance, creation
transactions and deployment blocks. Record the pool/aggregator first so T1
can resolve `depositPoolV22`, then the pair. At cutover preserve
`depositPoolV21`, add `legacyDepositPoolV21` with that same address and
repoint only `depositPool`/`depositPoolV2` to v2.2. Run Tier-3
`verify_contract_source=1` after that manifest lands. No placeholder address
or fabricated hash belongs in the manifest.

## T4 — separate, still gated cutover PR

No flags or addresses change in this tooling PR. T4 needs actual deployed
addresses, completed bindings and the operator's C1 choice. In the cutover
PR, update template source and regenerate mainnet output; configure:

- the canonical `depositPool` alias read by the gateway;
- `POOL_V22_CEREMONY_COMPLETE=1`;
- `POOL_V22_ADDRESS` and `POOL_V22_AGGREGATOR_ADDRESS` from verified evidence;
- an explicitly decided idle-keeper posture under C1; never silently leave
  the existing idle keeper sending to v2.1 if the operator chose to pause it;
- the separately controlled `POOL_V22_LOCKED_KEEPER_ENABLED` only under its
  own operator authorization, consent/registration and measured-rate gates.

C1 concerns the **old idle keeper**, not permission to enable the new locked
keeper. Keep the existing named rate refusal `venue_rate_unmeasured` until
reviewed measurement evidence is available. The #1383 door copy already
distinguishes retiring the v2.1 deposit door from pausing its immutable
contract, preserves withdrawal/migration-at-leisure wording, and discloses
one NAV shared pro-rata including Flex. Verify the live door, `/pool`,
health and historical v2.1 positions after cutover; outside holders are
never moved by this tooling.

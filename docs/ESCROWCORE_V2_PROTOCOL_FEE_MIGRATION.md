# EscrowCore v2 protocol-fee migration

Status: implementation and runbook only. No production deployment or fee change is performed by this document.

## Design review

The fee is a poster-side success fee. A job snapshots `protocolFeeBps` at creation, reserves
`reward + protocolFee + opsReserve + contingencyReserve`, and leaves the advertised worker
reward unchanged. A successful payout executes two atomic `AgentAccountCore.settleReservedTo`
book moves with distinct settlement IDs: reward to the worker and fee to `treasuryAccount`.
Rejected or partially paid work refunds every unearned fee unit with the other poster reserves.

The reviewed invariants are:

- Fresh deployments start at `protocolFeeBps == 0`; cutover is behavior-neutral.
- `MAX_PROTOCOL_FEE_BPS == 1000` (10%). `TreasuryPolicy.owner()` controls the fee and
  treasury destination, so the existing multisig remains the only governor.
- Pricing is immutable for an already funded job. Treasury destination rotation applies at
  settlement, allowing an operational wallet rotation without repricing the poster.
- Milestones use a cumulative fee target. This avoids per-leg rounding drift and makes a fully
  successful job charge exactly `floor(reward * snapshottedBps / 10_000)`.
- Partial dispute payouts charge only
  `floor(cumulativeWorkerPayout * snapshottedBps / 10_000)`; the remainder is refunded.
- Curated starter/onboarding jobs use an explicit operator-only fee-waived creation path.
  Category strings never confer a waiver.
- Finite unwaived recurring templates reserve the per-run fee for every funded run. The
  funding record preserves the quoted bps and fee reserve; re-quote and top up a template
  before raising the global bps, because each derivative snapshots the live rate at creation.
- `SettlementSplit` is emitted even when the fee is zero. Backend receipts and the operator
  board consume the event; the indexer persists it as settlement evidence.
- `AgentAccountCore` is unchanged. Existing balances and positions are not migrated.

## Audit delta

This is a solo-auditor re-verification item: one new EscrowCore deployment and one changed
success flow.

Review:

1. Constructor binding and zero-fee default.
2. Owner authorization, 1000 bps cap, and nonzero treasury guard.
3. Reserve arithmetic for single, milestone, recurring, and fee-waived creation.
4. Atomic two-leg settlement, distinct AAC settlement IDs, cumulative rounding, and replay
   protection.
5. Full and partial refund paths, including rejected and arbitrated jobs.
6. `SettlementSplit` receipt/event accuracy.
7. v1/v2 dual-address backend and indexer routing during the drain window.

The focused regression suite is `test/EscrowProtocolFee.t.sol`. The full `forge test` suite is
the contract merge gate.

## Mainnet cutover

Keep `EXTERNAL_POSTING_MODE=closed` throughout this sequence.

1. Verify the deploy signer `0x9Ab8531FBb0948C542a31298FD61335f30064239`
   holds at least 2 DOT on Polkadot Hub before starting. The Phase 1 script checks this
   balance explicitly before scanning, loading the artifact, or reading the key. The v1
   EscrowCore deployment (tx `0x3b375d29…`, block 18,647,902) consumed 1.121 DOT in fees for
   a comparably sized contract; v2's creation payload is 23,935 bytes with a 1,442,046 gas
   limit. A 0.99 DOT signer is rejected by the node as Substrate 1010
   `Invalid Transaction`, which ethers otherwise surfaces as the opaque
   `could not coalesce error`.
   This is the persistent `admin-eoa-mainnet`, selected explicitly for the v2 CREATE.
   `deployments/mainnet.json#deployer` is the retired one-shot F4 deployer that created v1;
   it is historical evidence, not authorization. A fresh burnable key was considered and
   rejected because EscrowCore is not Ownable: every privileged path gates on
   `TreasuryPolicy.owner()` (the 2-of-3 multisig), so the CREATE sender retains no authority.
2. Build the audited commit and archive its EscrowCore artifact/hash.
3. Run the redeploy preflight. The orphan scan starts at
   `deployments/mainnet.json#deploymentBlocks.escrowCore`, prints every
   `chunk n/N, blocks x-y` before requesting it, and never silently scans from genesis.
   `--from-block <n>` is the explicit recovery override if the recorded deployment block
   must be superseded. Existing v1 balances are expected; inspect and archive the report
   before acknowledging that they will drain rather than migrate.
4. Deploy v2 with constructor arguments
   `(TreasuryPolicy, AgentAccountCore, ReputationSBT, treasuryAccount)`. The helper refuses
   artifacts without the v2 selectors/four-argument constructor:

   ```sh
   node scripts/ops/redeploy-escrowcore.mjs \
     --profile mainnet \
     --phase deploy \
     --expected-deployer 0x9Ab8531FBb0948C542a31298FD61335f30064239 \
     --acknowledge-orphaned-balances \
     --commit \
     --signer-secret-ref 'op://mainnet-critical/admin-eoa-mainnet/credential'
   ```

5. Generate and execute the owner-multisig wiring batch with `--skip-revoke`:

   ```sh
   node scripts/ops/redeploy-escrowcore-wire-multisig.mjs \
     --profile mainnet \
     --new-escrow 0xNEW \
     --skip-revoke \
     --signer hot
   ```

   Repeat for the second signer with the emitted multisig timepoint. The old v1 EscrowCore
   must retain `settlementBroker`, `reputationWriter`, and AAC `escrowOperator` until every
   open v1 job has reached a terminal state.

6. Finalize with the same drain decision:

   ```sh
   node scripts/ops/redeploy-escrowcore.mjs \
     --profile mainnet \
     --phase finalize \
     --new-escrow 0xNEW \
     --deploy-tx 0xDEPLOY_TX \
     --multisig-exec-tx 0xMULTISIG_EXEC_TX \
     --skip-revoke \
     --commit
   ```

   Finalization fails unless constructor bindings match, `protocolFeeBps == 0`, the cap is
   1000, the treasury destination matches the manifest, and both v1 and v2 retain the roles
   required for the drain. It writes the v2 address, deploy block, zero fee, and
   `contracts.legacyEscrowCore` to `deployments/mainnet.json`. It preserves the v1
   `deployer` and `deploymentBlocks.escrowCore` records, and records the receipt-backed v2
   values separately as `deployers.escrowCoreV2` and
   `deploymentBlocks.escrowCoreV2`. It then projects the current and drain addresses into
   backend/indexer env templates. Commit that manifest cutover; do not
   use a runtime address override.

7. Deploy backend and indexer from the manifest cutover. New catalog jobs are created only on
   v2. Existing v1 jobs remain address-routed to v1. Re-run launch readiness and the
   solo-auditor delta.
8. After the v1 live-job count reaches zero, execute a separately reviewed revoke ceremony,
   remove `contracts.legacyEscrowCore`, clear both legacy env variables, and re-run the audit.

## Mainnet dogfood

Do this with internal funds before opening external posting:

1. Record the worker and treasury AAC positions for the settlement asset and choose a small,
   nonzero test bps value. The treasury test account should have no debt so its liquid delta
   is directly readable.
2. Through the owner multisig, call `EscrowCore.setProtocolFeeBps(testBps)`.
3. Create and complete one internal, non-waived v2 job.
4. Archive the create and resolve transaction receipts, the signed run receipt, and before/after
   AAC position reads.
5. Verify all four acceptance equations:

   - `job.protocolFee == floor(job.reward * job.protocolFeeBps / 10_000)`
   - worker AAC position increase equals the full advertised `job.reward`
   - treasury AAC position increase equals exactly `job.protocolFee`
   - `SettlementSplit(workerAmount, protocolFeeAmount, protocolFeeBps)` and the board treasury
     tile report those same values

6. Through the multisig, set `protocolFeeBps` to the chosen launch value (zero is valid), update
   `deployments/mainnet.json#parameters.protocolFeeBps`, regenerate env artifacts, and rerun
   launch readiness.

`EXTERNAL_POSTING_MODE=open` remains blocked until both this dogfood proof and the V2-2
live-funding watcher proof are complete.

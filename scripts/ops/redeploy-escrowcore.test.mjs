import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import {
  parseArgs,
  loadKeyFromOp,
  rewriteEscrowAddressInTemplate,
  evaluateOrphanedBalancePreflight
} from "./redeploy-escrowcore.mjs";

test("parseArgs defaults to dry-run + phase=all + profile=testnet", () => {
  const args = parseArgs([]);
  assert.equal(args.dryRun, true);
  assert.equal(args.phase, "all");
  assert.equal(args.profile, "testnet");
  assert.equal(args.signerSecretRef, undefined);
});

test("parseArgs accepts --commit + --phase deploy", () => {
  const args = parseArgs(["--commit", "--phase", "deploy"]);
  assert.equal(args.dryRun, false);
  assert.equal(args.phase, "deploy");
});

test("parseArgs reads --signer-secret-ref including embedded spaces", () => {
  const args = parseArgs([
    "--phase", "deploy", "--commit",
    "--signer-secret-ref", "op://prod-critical/admin-eoa-testnet/private key"
  ]);
  assert.equal(args.signerSecretRef, "op://prod-critical/admin-eoa-testnet/private key");
});

test("parseArgs collects finalize-phase tx hashes", () => {
  const args = parseArgs([
    "--phase", "finalize",
    "--new-escrow", "0x0000000000000000000000000000000000000001",
    "--deploy-tx", "0x" + "11".repeat(32),
    "--multisig-exec-tx", "0x" + "22".repeat(32),
    "--commit",
    "--skip-revoke"
  ]);
  assert.equal(args.phase, "finalize");
  assert.equal(args.dryRun, false);
  assert.equal(args.newEscrow, "0x0000000000000000000000000000000000000001");
  assert.equal(args.deployTx, "0x" + "11".repeat(32));
  assert.equal(args.multisigExecTx, "0x" + "22".repeat(32));
  assert.equal(args.skipRevoke, true);
});

test("parseArgs collects --skip-* flags", () => {
  const args = parseArgs([
    "--phase", "finalize",
    "--skip-manifest-update",
    "--skip-audit-rerun"
  ]);
  assert.equal(args.skipManifestUpdate, true);
  assert.equal(args.skipAuditRerun, true);
});

test("parseArgs collects orphaned balance acknowledgement flags", () => {
  const args = parseArgs([
    "--phase", "deploy",
    "--acknowledge-orphaned-balances",
    "--orphan-scan-from-block", "8800000",
    "--orphan-scan-chunk-size", "5000"
  ]);
  assert.equal(args.acknowledgeOrphanedBalances, true);
  assert.equal(args.orphanScanFromBlock, 8_800_000);
  assert.equal(args.orphanScanChunkSize, 5_000);
});

test("loadKeyFromOp rejects refs that aren't op://", () => {
  assert.throws(
    () => loadKeyFromOp("/Users/me/.paseo.env"),
    /must be an 'op:\/\/...' reference/u
  );
  assert.throws(
    () => loadKeyFromOp(""),
    /must be an 'op:\/\/...' reference/u
  );
  assert.throws(
    () => loadKeyFromOp(undefined),
    /must be an 'op:\/\/...' reference/u
  );
});

test("setServiceOperator(address,bool) selector encoding is stable", () => {
  const iface = new Interface(["function setServiceOperator(address account, bool allowed)"]);
  const data = iface.encodeFunctionData("setServiceOperator", [
    "0xb8fd8A932F69bD5E39700b7cf6D2920aF84d1B27",
    true
  ]);
  assert.equal(
    data,
    "0xeea03c28000000000000000000000000b8fd8a932f69bd5e39700b7cf6d2920af84d1b270000000000000000000000000000000000000000000000000000000000000001"
  );
});

test("rewriteEscrowAddressInTemplate updates the ESCROW_CORE_ADDRESS line in place", () => {
  const before = [
    "TREASURY_POLICY_ADDRESS=0x648Cc5fdE94435992296C4e5ac642d18bB64c12B",
    "AGENT_ACCOUNT_ADDRESS=0x71B111d8c9DF84Be26cb9067D27dAd7A2d5E7e08",
    "ESCROW_CORE_ADDRESS=0x7BB8fea44bDeE9870cF27c1dB616E7017BC38b0a",
    "REPUTATION_SBT_ADDRESS=0x68Db90db715Be59E5800Bea08c058E4CFd88e27c"
  ].join("\n") + "\n";
  const NEW = "0xb8fd8A932F69bD5E39700b7cf6D2920aF84d1B27";
  const result = rewriteEscrowAddressInTemplate(before, NEW);
  assert.equal(result.changed, true);
  assert.equal(result.previousValue, "0x7BB8fea44bDeE9870cF27c1dB616E7017BC38b0a");
  assert.ok(result.text.includes(`ESCROW_CORE_ADDRESS=${NEW}`));
  // Other lines must be untouched.
  assert.ok(result.text.includes("TREASURY_POLICY_ADDRESS=0x648Cc5fdE94435992296C4e5ac642d18bB64c12B"));
  assert.ok(result.text.includes("REPUTATION_SBT_ADDRESS=0x68Db90db715Be59E5800Bea08c058E4CFd88e27c"));
});

test("rewriteEscrowAddressInTemplate is a no-op when value already matches", () => {
  const NEW = "0xb8fd8A932F69bD5E39700b7cf6D2920aF84d1B27";
  const text = `ESCROW_CORE_ADDRESS=${NEW}\n`;
  const result = rewriteEscrowAddressInTemplate(text, NEW);
  assert.equal(result.changed, false);
  assert.equal(result.reason, "already up to date");
});

test("rewriteEscrowAddressInTemplate reports missing ESCROW_CORE_ADDRESS line", () => {
  const result = rewriteEscrowAddressInTemplate("FOO=bar\n", "0xb8fd8A932F69bD5E39700b7cf6D2920aF84d1B27");
  assert.equal(result.changed, false);
  assert.equal(result.reason, "no ESCROW_CORE_ADDRESS line");
});

function syntheticPreflightReport(findings) {
  return {
    oldEscrow: "0x7BB8fea44bDeE9870cF27c1dB616E7017BC38b0a",
    agentAccountCore: "0x71B111d8c9DF84Be26cb9067D27dAd7A2d5E7e08",
    scan: {
      fromBlock: 8_800_000,
      toBlock: 9_300_000,
      chunkSize: 25_000,
      scannedLogCount: 58,
      scannedJobCount: 9
    },
    findings
  };
}

function syntheticFinding(overrides = {}) {
  const emptyPosition = {
    liquid: "0",
    reserved: "0",
    strategyAllocated: "0",
    collateralLocked: "0",
    jobStakeLocked: "0",
    debtOutstanding: "0",
    formatted: {
      liquid: "0.0",
      reserved: "0.0",
      jobStakeLocked: "0.0",
      debtOutstanding: "0.0"
    }
  };
  return {
    jobId: "0x" + "42".repeat(32),
    poster: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
    worker: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
    asset: "0x0000053900000000000000000000000001200000",
    reward: "100000",
    opsReserve: "0",
    contingencyReserve: "0",
    released: "0",
    claimExpiry: "1778878728",
    claimStake: "10000",
    claimFee: "50000",
    rejectedAt: "0",
    disputedAt: "0",
    payoutMode: "Single",
    state: "Submitted",
    stateIndex: 3,
    posterPosition: {
      ...emptyPosition,
      reserved: "200001",
      jobStakeLocked: "60000",
      formatted: {
        ...emptyPosition.formatted,
        reserved: "0.200001",
        jobStakeLocked: "0.06"
      }
    },
    workerPosition: emptyPosition,
    nonZeroTails: {
      poster: true,
      worker: false
    },
    ...overrides
  };
}

test("evaluateOrphanedBalancePreflight passes clean synthetic escrow state", () => {
  const decision = evaluateOrphanedBalancePreflight(syntheticPreflightReport([]));
  assert.equal(decision.ok, true);
  assert.equal(decision.acknowledged, false);
  assert.match(decision.message, /No unsettled old EscrowCore jobs/u);
});

test("evaluateOrphanedBalancePreflight aborts on synthetic stuck balances", () => {
  assert.throws(
    () => evaluateOrphanedBalancePreflight(syntheticPreflightReport([syntheticFinding()])),
    /Abort: settle or finalize these jobs first/u
  );
});

test("evaluateOrphanedBalancePreflight bypasses stuck balances with explicit acknowledgement", () => {
  const decision = evaluateOrphanedBalancePreflight(
    syntheticPreflightReport([syntheticFinding()]),
    { acknowledge: true }
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.acknowledged, true);
  assert.match(decision.message, /Acknowledged via --acknowledge-orphaned-balances/u);
  assert.match(decision.message, /state=Submitted claimExpiry=1778878728/u);
});

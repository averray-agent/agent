import test from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  assertArtifactHasAgentAccountSelectors,
  rewriteSettlementAddressesInTemplate
} from "./redeploy-agent-account-escrow-stack.mjs";

const NEW_AAC = "0xbd9c2d9336a91415287bb032ec34e8b80a1f38a0";
const NEW_ESCROW = "0xb8fd8A932F69bD5E39700b7cf6D2920aF84d1B27";

function abiWith(names) {
  return { abi: names.map((name) => ({ type: "function", name })) };
}

test("parseArgs defaults to testnet all dry-run", () => {
  const args = parseArgs([]);
  assert.equal(args.profile, "testnet");
  assert.equal(args.phase, "all");
  assert.equal(args.dryRun, true);
});

test("parseArgs reads deploy key and old-balance guard flags", () => {
  const args = parseArgs([
    "--phase", "deploy",
    "--commit",
    "--signer-secret-ref", "op://prod-critical/admin-eoa-testnet/private key",
    "--acknowledge-orphaned-balances",
    "--orphan-scan-from-block", "8800000",
    "--orphan-scan-chunk-size", "5000"
  ]);
  assert.equal(args.phase, "deploy");
  assert.equal(args.dryRun, false);
  assert.equal(args.signerSecretRef, "op://prod-critical/admin-eoa-testnet/private key");
  assert.equal(args.acknowledgeOrphanedBalances, true);
  assert.equal(args.orphanScanFromBlock, 8_800_000);
  assert.equal(args.orphanScanChunkSize, 5_000);
});

test("parseArgs reads finalize addresses and tx hashes", () => {
  const args = parseArgs([
    "--phase", "finalize",
    "--new-agent-account", NEW_AAC,
    "--new-escrow", NEW_ESCROW,
    "--agent-account-deploy-tx", "0x" + "11".repeat(32),
    "--escrow-deploy-tx", "0x" + "22".repeat(32),
    "--multisig-exec-tx", "0x" + "33".repeat(32),
    "--skip-revoke",
    "--skip-audit-rerun"
  ]);
  assert.equal(args.phase, "finalize");
  assert.equal(args.newAgentAccount, NEW_AAC);
  assert.equal(args.newEscrow, NEW_ESCROW);
  assert.equal(args.agentAccountDeployTx, "0x" + "11".repeat(32));
  assert.equal(args.escrowDeployTx, "0x" + "22".repeat(32));
  assert.equal(args.multisigExecTx, "0x" + "33".repeat(32));
  assert.equal(args.skipRevoke, true);
  assert.equal(args.skipAuditRerun, true);
});

test("assertArtifactHasAgentAccountSelectors accepts the current AAC surface", () => {
  assert.doesNotThrow(() =>
    assertArtifactHasAgentAccountSelectors(
      abiWith([
        "escrowOperators",
        "setEscrowOperator",
        "domainSeparator",
        "sendToAgentFor",
        "hashSendToAgentAuthorization",
        "sendToAgentAuthorizationUsed",
        "cancelRecurringTemplateReserve"
      ])
    )
  );
});

test("assertArtifactHasAgentAccountSelectors rejects stale May-era AAC artifacts", () => {
  assert.throws(
    () => assertArtifactHasAgentAccountSelectors(abiWith(["deposit", "withdraw", "reserveForJob"])),
    /missing selector\(s\): escrowOperators, setEscrowOperator, domainSeparator/u
  );
});

test("rewriteSettlementAddressesInTemplate updates both backend settlement addresses", () => {
  const before = [
    "TREASURY_POLICY_ADDRESS=0x648Cc5fdE94435992296C4e5ac642d18bB64c12B",
    "AGENT_ACCOUNT_ADDRESS=0x71B111d8c9DF84Be26cb9067D27dAd7A2d5E7e08",
    "ESCROW_CORE_ADDRESS=0x70d661C3A5DdE64bB8cbFa0A5336470c1662eFCa",
    "REPUTATION_SBT_ADDRESS=0x68Db90db715Be59E5800Bea08c058E4CFd88e27c"
  ].join("\n") + "\n";

  const result = rewriteSettlementAddressesInTemplate(before, {
    newAgentAccount: NEW_AAC,
    newEscrow: NEW_ESCROW
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.previousValues.AGENT_ACCOUNT_ADDRESS, "0x71B111d8c9DF84Be26cb9067D27dAd7A2d5E7e08");
  assert.equal(result.previousValues.ESCROW_CORE_ADDRESS, "0x70d661C3A5DdE64bB8cbFa0A5336470c1662eFCa");
  assert.ok(result.text.includes(`AGENT_ACCOUNT_ADDRESS=${NEW_AAC}`));
  assert.ok(result.text.includes(`ESCROW_CORE_ADDRESS=${NEW_ESCROW}`));
  assert.ok(result.text.includes("TREASURY_POLICY_ADDRESS=0x648Cc5fdE94435992296C4e5ac642d18bB64c12B"));
});

test("rewriteSettlementAddressesInTemplate reports missing required env lines", () => {
  const result = rewriteSettlementAddressesInTemplate("AGENT_ACCOUNT_ADDRESS=0xold\n", {
    newAgentAccount: NEW_AAC,
    newEscrow: NEW_ESCROW
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.missing, ["ESCROW_CORE_ADDRESS"]);
});

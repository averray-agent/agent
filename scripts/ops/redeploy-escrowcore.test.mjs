import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { parseArgs, loadKeyFromOp, rewriteEscrowAddressInTemplate } from "./redeploy-escrowcore.mjs";

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

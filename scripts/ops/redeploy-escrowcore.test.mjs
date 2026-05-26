import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { parseArgs, loadKeyFromOp } from "./redeploy-escrowcore.mjs";

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

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBindings,
  assertPinnedCreationCode,
  buildDeploymentPlan,
  parseArgs,
  sha256Hex
} from "./deploy-creditbook-mainnet.mjs";

const DEPLOYER = "0x9Ab8531FBb0948C542a31298FD61335f30064239";
const POLICY = "0x226F14252A98BD2eA140271647De20132F09AF20";
const ACCOUNTS = "0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57";
const ASSET = "0x0000053900000000000000000000000001200000";
const OPERATOR = "0x5a6836c6D4d293F6E5377E6c28054F4171915813";

test("commit parsing retains every explicit CreditBook ceremony guard", () => {
  const args = parseArgs([
    "--profile", "mainnet",
    "--commit",
    "--expected-deployer", DEPLOYER,
    "--expected-start-nonce", "21",
    "--expected-creation-code-hash", `sha256:${"11".repeat(32)}`,
    "--confirmation", "DEPLOY CREDITBOOK 0x1111111111111111111111111111111111111111",
    "--evidence-out", "docs/evidence/example.json"
  ]);
  assert.equal(args.commit, true);
  assert.equal(args.expectedStartNonce, 21);
  assert.equal(args.expectedDeployer, DEPLOYER);
});

test("commit cannot proceed without an exact reviewed creation-code hash", () => {
  assert.throws(() => assertPinnedCreationCode(`sha256:${"11".repeat(32)}`, undefined, true), /required/u);
  assert.throws(
    () => assertPinnedCreationCode(`sha256:${"11".repeat(32)}`, `sha256:${"22".repeat(32)}`, true),
    /does not match pinned/u
  );
});

test("creation hash is SHA-256 over exact artifact bytes", () => {
  assert.equal(sha256Hex("0x00ff"), "sha256:06eb7d6a69ee19e5fbdf749018d3d2abfa04bcbd1365db312eb86dc7169389b8");
});

test("deployment plan decodes the exact constructor bindings", async () => {
  const artifact = {
    abi: [{
      type: "constructor",
      inputs: ["policy", "accounts", "asset", "operator", "poster"].map((name) => ({ name, type: "address" }))
    }],
    bytecode: { object: "0x60006000f3" }
  };
  const bindings = { policy: POLICY, accounts: ACCOUNTS, asset: ASSET, operator: OPERATOR };
  const plan = await buildDeploymentPlan({ artifact, bindings, deployer: DEPLOYER, startNonce: 20 });
  assert.deepEqual(plan.decodedBindings, { ...bindings, initialL3PosterWallet: "0x0000000000000000000000000000000000000000" });
  assert.equal(plan.predictedAddress, "0xdB7bF8caB8160d33b3B0943F9d671C207DD46d60");
});

test("post-deploy verification rejects any schedule or binding drift", () => {
  const good = {
    policy: POLICY,
    accounts: ACCOUNTS,
    asset: ASSET,
    operator: OPERATOR,
    cashPerWalletCapRaw: 25_000_000n,
    postingPerWalletCapRaw: 25_000_000n,
    bookCapRaw: 50_000_000n,
    interestBps: 0n,
    repayBps: 5_000n,
    accountedLiquidityRaw: 0n,
    totalOutstandingRaw: 0n,
    l3Enabled: false,
    l3PosterWallet: "0x0000000000000000000000000000000000000000"
  };
  assert.doesNotThrow(() => assertBindings(good, good));
  assert.throws(() => assertBindings({ ...good, l3Enabled: true }, good), /l3Enabled must be false/u);
  assert.throws(() => assertBindings({ ...good, bookCapRaw: 50_000_001n }, good), /bookCapRaw/u);
});

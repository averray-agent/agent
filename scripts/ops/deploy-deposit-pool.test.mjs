import test from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  resolveCeremonyDeployer,
  predictDeploymentAddresses,
} from "./deploy-deposit-pool.mjs";

const ADMIN_DEPLOYER = "0x9Ab8531FBb0948C542a31298FD61335f30064239";
const HISTORICAL_DEPLOYER = "0x08406B2bCE5592A534141767ffe4e5B9DC6c22D1";
const SIGNER_REF = "op://mainnet-critical/admin-eoa-mainnet/credential";

test("parseArgs accepts the 1Password signer reference and explicit expected deployer", () => {
  const args = parseArgs([
    "--commit",
    "--expected-deployer", ADMIN_DEPLOYER,
    "--signer-secret-ref", SIGNER_REF,
  ]);

  assert.equal(args.commit, true);
  assert.equal(args.expectedDeployer, ADMIN_DEPLOYER);
  assert.equal(args.signerSecretRef, SIGNER_REF);
});

test("the historical manifest deployer can never authorize a ceremony preview", () => {
  assert.throws(
    () => resolveCeremonyDeployer({
      expectedDeployer: undefined,
      historicalDeployer: HISTORICAL_DEPLOYER,
      signerSecretRef: undefined,
      commit: false,
    }),
    /--expected-deployer is required/u,
  );
});

test("commit refuses before planning when the 1Password signer differs from expected", () => {
  let secretLoads = 0;
  assert.throws(
    () => resolveCeremonyDeployer({
      expectedDeployer: ADMIN_DEPLOYER,
      historicalDeployer: HISTORICAL_DEPLOYER,
      signerSecretRef: SIGNER_REF,
      commit: true,
      loadSecret() {
        secretLoads += 1;
        return "concealed-test-handle";
      },
      walletFromSecret() {
        return { address: HISTORICAL_DEPLOYER };
      },
    }),
    /derived signer .* does not match --expected-deployer/u,
  );
  assert.equal(secretLoads, 1);
});

test("matching 1Password signer becomes the sole nonce-prediction identity", () => {
  const fakeWallet = { address: ADMIN_DEPLOYER };
  const result = resolveCeremonyDeployer({
    expectedDeployer: ADMIN_DEPLOYER.toLowerCase(),
    signerSecretRef: SIGNER_REF,
    commit: true,
    loadSecret(secretRef) {
      assert.equal(secretRef, SIGNER_REF);
      return "concealed-test-handle";
    },
    walletFromSecret(secretHandle) {
      assert.equal(secretHandle, "concealed-test-handle");
      return fakeWallet;
    },
  });

  assert.equal(result.address, ADMIN_DEPLOYER);
  assert.equal(result.wallet, fakeWallet);
  assert.equal(result.signerVerified, true);
  assert.equal(result.source, "derived from --signer-secret-ref");
});

test("commit refuses without a 1Password signer reference", () => {
  assert.throws(
    () => resolveCeremonyDeployer({
      expectedDeployer: ADMIN_DEPLOYER,
      historicalDeployer: HISTORICAL_DEPLOYER,
      signerSecretRef: undefined,
      commit: true,
    }),
    /--signer-secret-ref is required for --commit/u,
  );
});

test("CREATE predictions use the verified deployer pending nonce", async () => {
  const calls = [];
  const result = await predictDeploymentAddresses({
    provider: {
      async getTransactionCount(address, blockTag) {
        calls.push([address, blockTag]);
        return 11;
      },
    },
    deployer: ADMIN_DEPLOYER,
  });

  assert.deepEqual(calls, [[ADMIN_DEPLOYER, "pending"]]);
  assert.deepEqual(result, {
    startNonce: 11,
    lane: "0xAbDca8AAca9308C7DA26c5B7E5E2380CDDD37f34",
    venueAdapter: "0x50d279818948fbfe10B03b74e6b8aB44428b51ab",
    pool: "0xCCF5FDF3108AF8e693F28bb9326A573d9dA0F476",
  });
});

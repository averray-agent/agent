import test from "node:test";
import assert from "node:assert/strict";

import { loadBlockchainConfig } from "./config.js";

const baseEnv = {
  SIGNER_PRIVATE_KEY: "0xabc",
  TREASURY_POLICY_ADDRESS: "0x1111111111111111111111111111111111111111",
  AGENT_ACCOUNT_ADDRESS: "0x2222222222222222222222222222222222222222",
  ESCROW_CORE_ADDRESS: "0x3333333333333333333333333333333333333333",
  REPUTATION_SBT_ADDRESS: "0x4444444444444444444444444444444444444444",
  SUPPORTED_ASSETS: "DOT:0x5555555555555555555555555555555555555555"
};

test("loadBlockchainConfig prefers DWELLER_RPC_URL", () => {
  const config = loadBlockchainConfig({
    ...baseEnv,
    DWELLER_RPC_URL: "https://dweller.example",
    POLKADOT_RPC_URL: "https://polkadot.example",
    RPC_URL: "https://legacy.example"
  });

  assert.equal(config.enabled, true);
  assert.equal(config.rpcUrl, "https://dweller.example");
});

test("loadBlockchainConfig falls back from POLKADOT_RPC_URL to RPC_URL", () => {
  const direct = loadBlockchainConfig({
    ...baseEnv,
    POLKADOT_RPC_URL: "https://polkadot.example"
  });
  assert.equal(direct.rpcUrl, "https://polkadot.example");

  const legacy = loadBlockchainConfig({
    ...baseEnv,
    RPC_URL: "https://legacy.example"
  });
  assert.equal(legacy.rpcUrl, "https://legacy.example");
});

test("loadBlockchainConfig treats missing RPC across all aliases as incomplete config", () => {
  assert.throws(
    () => loadBlockchainConfig(baseEnv),
    /RPC_URL \(or DWELLER_RPC_URL \/ POLKADOT_RPC_URL\)/
  );
});

test("loadBlockchainConfig accepts explicit SUPPORTED_ASSETS_JSON metadata", () => {
  const config = loadBlockchainConfig({
    ...baseEnv,
    RPC_URL: "https://legacy.example",
    SUPPORTED_ASSETS: "",
    SUPPORTED_ASSETS_JSON: JSON.stringify([
      {
        symbol: "USDt",
        assetClass: "trust_backed",
        assetId: 1984,
        decimals: 6,
        minBalanceRaw: "123"
      },
      {
        symbol: "vDOT",
        assetClass: "foreign",
        foreignAssetIndex: 5,
        decimals: 10,
        xcmLocation: "{ parents: 1, interior: X1(Parachain(2030)) }"
      }
    ])
  });

  assert.equal(config.enabled, true);
  assert.deepEqual(config.supportedAssets, [
    {
      symbol: "USDt",
      assetClass: "trust_backed",
      assetId: 1984,
      decimals: 6,
      minBalanceRaw: "123",
      address: "0x000007c000000000000000000000000001200000"
    },
    {
      symbol: "vDOT",
      assetClass: "foreign",
      foreignAssetIndex: 5,
      decimals: 10,
      xcmLocation: "{ parents: 1, interior: X1(Parachain(2030)) }",
      address: "0x0000000500000000000000000000000002200000"
    }
  ]);
});

test("loadBlockchainConfig prefers SUPPORTED_ASSETS_JSON when both config formats are present", () => {
  const config = loadBlockchainConfig({
    ...baseEnv,
    RPC_URL: "https://legacy.example",
    SUPPORTED_ASSETS: "DOT:0x5555555555555555555555555555555555555555",
    SUPPORTED_ASSETS_JSON: JSON.stringify([
      {
        symbol: "USDC",
        assetClass: "trust_backed",
        assetId: 1337,
        decimals: 6
      }
    ])
  });

  assert.deepEqual(config.supportedAssets, [
    {
      symbol: "USDC",
      assetClass: "trust_backed",
      assetId: 1337,
      decimals: 6,
      minBalanceRaw: "70000",
      address: "0x0000053900000000000000000000000001200000"
    }
  ]);
});

test("loadBlockchainConfig rejects invalid minBalanceRaw metadata", () => {
  assert.throws(
    () =>
      loadBlockchainConfig({
        ...baseEnv,
        RPC_URL: "https://legacy.example",
        SUPPORTED_ASSETS: "",
        SUPPORTED_ASSETS_JSON: JSON.stringify([
          {
            symbol: "USDC",
            assetClass: "trust_backed",
            assetId: 1337,
            decimals: 6,
            minBalanceRaw: "0.07"
          }
        ])
      }),
    /SUPPORTED_ASSETS_JSON\[0\]\.minBalanceRaw must be a non-negative integer string in base units/u
  );
});

test("loadBlockchainConfig rejects mismatched derived addresses in SUPPORTED_ASSETS_JSON", () => {
  assert.throws(
    () =>
      loadBlockchainConfig({
        ...baseEnv,
        RPC_URL: "https://legacy.example",
        SUPPORTED_ASSETS: "",
        SUPPORTED_ASSETS_JSON: JSON.stringify([
          {
            symbol: "USDt",
            assetClass: "trust_backed",
            assetId: 1984,
            address: "0x1111111111111111111111111111111111111111"
          }
        ])
      }),
    /does not match derived trust_backed precompile address/
  );
});

test("loadBlockchainConfig accepts optional XCM_WRAPPER_ADDRESS", () => {
  const config = loadBlockchainConfig({
    ...baseEnv,
    RPC_URL: "https://legacy.example",
    XCM_WRAPPER_ADDRESS: "0x7777777777777777777777777777777777777777"
  });

  assert.equal(config.xcmWrapperAddress, "0x7777777777777777777777777777777777777777");
});

test("loadBlockchainConfig rejects malformed optional XCM_WRAPPER_ADDRESS", () => {
  assert.throws(
    () =>
      loadBlockchainConfig({
        ...baseEnv,
        RPC_URL: "https://legacy.example",
        XCM_WRAPPER_ADDRESS: "not-an-address"
      }),
    /XCM_WRAPPER_ADDRESS must be a 0x \+ 20-byte EVM address/
  );
});

// ─── Phase 3 SIGNER_BACKEND tests ────────────────────────────────────

test("loadBlockchainConfig defaults SIGNER_BACKEND to 'local'", () => {
  const config = loadBlockchainConfig({
    ...baseEnv,
    RPC_URL: "https://legacy.example"
  });
  assert.equal(config.signerBackend, "local");
  assert.equal(config.signerPrivateKey, "0xabc");
  assert.equal(config.arbitratorSignerPrivateKey, "");
  assert.equal(config.kmsKeyId, "");
  assert.equal(config.awsRegion, "");
});

test("loadBlockchainConfig accepts a separate dispute arbitrator signer", () => {
  const config = loadBlockchainConfig({
    ...baseEnv,
    RPC_URL: "https://legacy.example",
    ARBITRATOR_SIGNER_PRIVATE_KEY: "0xdef"
  });

  assert.equal(config.signerPrivateKey, "0xabc");
  assert.equal(config.arbitratorSignerPrivateKey, "0xdef");
});

test("loadBlockchainConfig accepts SIGNER_BACKEND=kms with KMS_KEY_ID + AWS_REGION", () => {
  const config = loadBlockchainConfig({
    ...baseEnv,
    SIGNER_PRIVATE_KEY: "",   // unset; Phase 3 forbids both
    RPC_URL: "https://legacy.example",
    SIGNER_BACKEND: "kms",
    KMS_KEY_ID: "arn:aws:kms:eu-central-1:123:key/abcd",
    AWS_REGION: "eu-central-1"
  });
  assert.equal(config.enabled, true);
  assert.equal(config.signerBackend, "kms");
  assert.equal(config.kmsKeyId, "arn:aws:kms:eu-central-1:123:key/abcd");
  assert.equal(config.awsRegion, "eu-central-1");
});

test("loadBlockchainConfig rejects unknown SIGNER_BACKEND values", () => {
  assert.throws(
    () =>
      loadBlockchainConfig({
        ...baseEnv,
        RPC_URL: "https://legacy.example",
        SIGNER_BACKEND: "vault"
      }),
    /SIGNER_BACKEND must be "local" or "kms".*got "vault"/
  );
});

test("loadBlockchainConfig refuses both SIGNER_PRIVATE_KEY and SIGNER_BACKEND=kms (anti-pattern)", () => {
  assert.throws(
    () =>
      loadBlockchainConfig({
        ...baseEnv,
        RPC_URL: "https://legacy.example",
        SIGNER_BACKEND: "kms",
        SIGNER_PRIVATE_KEY: "0xabc",
        KMS_KEY_ID: "abcd",
        AWS_REGION: "eu-central-1"
      }),
    /mutually exclusive/
  );
});

test("loadBlockchainConfig requires AWS_REGION when SIGNER_BACKEND=kms", () => {
  assert.throws(
    () =>
      loadBlockchainConfig({
        ...baseEnv,
        SIGNER_PRIVATE_KEY: "",
        RPC_URL: "https://legacy.example",
        SIGNER_BACKEND: "kms",
        KMS_KEY_ID: "abcd"
      }),
    /Missing.*KMS_KEY_ID \+ AWS_REGION/
  );
});

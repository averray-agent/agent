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

#!/usr/bin/env node
import { readFileSync } from "node:fs";

const manifestPath = process.argv[2];
if (!manifestPath) {
  throw new Error("usage: derive-settlement-env.mjs <deployments/testnet.json>");
}

const deployment = JSON.parse(readFileSync(manifestPath, "utf8"));

function requireAddress(value, label) {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error(`${label} must be a 0x + 20-byte EVM address.`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be present.`);
  }
  return value.trim();
}

const rpcUrl = requireString(deployment.rpcUrl, "rpcUrl");
const contracts = deployment.contracts ?? {};
const treasuryPolicy = requireAddress(contracts.treasuryPolicy, "contracts.treasuryPolicy");
const agentAccountCore = requireAddress(contracts.agentAccountCore, "contracts.agentAccountCore");
const escrowCore = requireAddress(contracts.escrowCore, "contracts.escrowCore");
const reputationSbt = requireAddress(contracts.reputationSbt, "contracts.reputationSbt");
const discoveryRegistry = contracts.discoveryRegistry
  ? requireAddress(contracts.discoveryRegistry, "contracts.discoveryRegistry")
  : "";
const xcmWrapper = contracts.xcmWrapper
  ? requireAddress(contracts.xcmWrapper, "contracts.xcmWrapper")
  : "";
const usdc = requireAddress(contracts.token, "contracts.token");
const canonicalUsdc = "0x0000053900000000000000000000000001200000";

if (usdc.toLowerCase() !== canonicalUsdc) {
  throw new Error(`contracts.token must be canonical Hub USDC (${canonicalUsdc}), got ${usdc}.`);
}

const supportedAssets = JSON.stringify([{
  symbol: "USDC",
  assetClass: "trust_backed",
  assetId: 1337,
  address: usdc,
  decimals: 6,
  minBalanceRaw: "70000"
}]);

const entries = {
  DWELLER_RPC_URL: rpcUrl,
  POLKADOT_RPC_URL: rpcUrl,
  RPC_URL: rpcUrl,
  TREASURY_POLICY_ADDRESS: treasuryPolicy,
  AGENT_ACCOUNT_ADDRESS: agentAccountCore,
  ESCROW_CORE_ADDRESS: escrowCore,
  REPUTATION_SBT_ADDRESS: reputationSbt,
  DISCOVERY_REGISTRY_ADDRESS: discoveryRegistry,
  XCM_WRAPPER_ADDRESS: xcmWrapper,
  SUPPORTED_ASSETS_JSON: supportedAssets,
  SUPPORTED_ASSETS: ""
};

for (const [key, value] of Object.entries(entries)) {
  console.log(`${key}=${value}`);
}

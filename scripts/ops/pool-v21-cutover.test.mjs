import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CONTRACT_ARTIFACTS, validateProvenanceManifest } from "./check-contract-provenance.mjs";
import { validateKnownUnshippedContractChanges } from "./check-contract-source-drift.mjs";

const V21 = "0x9B35A102d656Fb86d798aF81959e09961DEc28E0";
const LEGACY_V2 = "0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30";

function deploymentManifest() {
  return JSON.parse(readFileSync(new URL("../../deployments/mainnet.json", import.meta.url), "utf8"));
}

function envValue(source, name) {
  const match = source.match(new RegExp(`^${name}=(.+)$`, "mu"));
  assert.ok(match, `${name} must be explicit in the env template`);
  return match[1];
}

test("A6 manifest makes v2.1 canonical and preserves legacy v2 provenance", () => {
  const manifest = deploymentManifest();
  const contracts = validateProvenanceManifest(manifest);
  const waivers = validateKnownUnshippedContractChanges(manifest, contracts);

  assert.equal(manifest.contracts.depositPool, V21);
  assert.equal(manifest.contracts.depositPoolV2, V21);
  assert.equal(manifest.contracts.depositPoolV21, V21);
  assert.equal(manifest.contracts.legacyDepositPoolV2, LEGACY_V2);
  assert.equal(manifest.deploymentBlocks.depositPool, 19_913_549);
  assert.equal(manifest.deploymentBlocks.depositPoolV2, 19_913_549);
  assert.equal(manifest.deploymentBlocks.legacyDepositPoolV2, 19_421_397);
  assert.equal(contracts.length, 20);
  assert.deepEqual(CONTRACT_ARTIFACTS.legacyDepositPoolV2, ["DepositPoolV2.sol", "DepositPoolV2"]);
  assert.equal(waivers.has("depositPool"), false);
  assert.equal(waivers.has("depositPoolV2"), false);
  assert.equal(waivers.has("legacyDepositPoolV2"), true);
});

test("A6 exposes consent but leaves allocation movement dark at the ratified parameters", () => {
  const mainnet = readFileSync(
    new URL("../../deploy/backend.mainnet.env.template", import.meta.url),
    "utf8"
  );
  const defaults = readFileSync(
    new URL("../../deploy/backend.env.template", import.meta.url),
    "utf8"
  );

  assert.equal(envValue(mainnet, "IDLE_BALANCE_ALLOCATION_ROUTE_LIVE"), "1");
  assert.equal(envValue(mainnet, "IDLE_BALANCE_ALLOCATION_KEEPER_ENABLED"), "false");
  assert.equal(envValue(defaults, "IDLE_BALANCE_ALLOCATION_ROUTE_LIVE"), "false");
  assert.equal(envValue(defaults, "IDLE_BALANCE_ALLOCATION_KEEPER_ENABLED"), "false");
  assert.equal(envValue(mainnet, "IDLE_BALANCE_ALLOCATION_WORKING_HEADROOM_RAW"), "2000000");
  assert.equal(envValue(mainnet, "IDLE_BALANCE_ALLOCATION_MIN_TICK_RAW"), "500000");
});

test("allocation reads retain the five-field registry and account-asset position shapes", () => {
  const registry = readFileSync(
    new URL("../../contracts/StrategyAdapterRegistry.sol", import.meta.url),
    "utf8"
  );
  const chain = readFileSync(
    new URL("../../mcp-server/src/services/idle-balance-allocation-chain.js", import.meta.url),
    "utf8"
  );

  assert.match(
    registry,
    /struct StrategyMetadata \{\s*bytes32 strategyId;\s*address adapter;\s*address asset;\s*string riskLabel;\s*bool active;\s*\}/u
  );
  assert.match(
    chain,
    /function positions\(address account, address asset\) view returns/u
  );
  assert.match(
    chain,
    /positions\(getAddress\(wallet\), this\.assetAddress\)/u
  );
});

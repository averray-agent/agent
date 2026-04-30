import test from "node:test";
import assert from "node:assert/strict";

import { loadStrategiesConfig } from "./bootstrap.js";
import { derivePolkadotHubAssetAddress } from "./strategy-asset-config.js";

function silentLogger() {
  return { warn() {}, error() {}, info() {}, log() {} };
}

test("loadStrategiesConfig returns empty array when env is unset", () => {
  const result = loadStrategiesConfig({}, { logger: silentLogger() });
  assert.deepEqual(result, []);
});

test("loadStrategiesConfig parses a valid STRATEGIES_JSON array", () => {
  const env = {
    STRATEGIES_JSON: JSON.stringify([
      {
        strategyId: "0x56444f545f56315f4d4f434b0000000000000000000000000000000000000000",
        adapter: "0x1234567890123456789012345678901234567890",
        kind: "mock_vdot",
        riskLabel: "Mock vDOT",
        asset: "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD"
      }
    ])
  };
  const result = loadStrategiesConfig(env, { logger: silentLogger() });
  assert.equal(result.length, 1);
  assert.equal(result[0].strategyId, "0x56444f545f56315f4d4f434b0000000000000000000000000000000000000000");
  // adapter + asset are lowercased for consistency with the profile
  // endpoint's wallet normalisation.
  assert.equal(result[0].adapter, "0x1234567890123456789012345678901234567890");
  assert.equal(result[0].asset, "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
  assert.deepEqual(result[0].assetConfig, {
    assetClass: "custom",
    address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
  });
  assert.equal(result[0].kind, "mock_vdot");
  assert.equal(result[0].executionMode, "sync");
});

test("loadStrategiesConfig parses explicit trust-backed asset metadata and derives the precompile address", () => {
  const env = {
    STRATEGIES_JSON: JSON.stringify([
      {
        strategyId: "0x56444f545f56315f4d4f434b0000000000000000000000000000000000000000",
        adapter: "0x1234567890123456789012345678901234567890",
        kind: "polkadot_vdot",
        riskLabel: "Bifrost vDOT",
        asset: {
          assetClass: "trust_backed",
          assetId: 1984,
          symbol: "USDt",
          decimals: 6
        }
      }
    ])
  };
  const result = loadStrategiesConfig(env, { logger: silentLogger() });
  assert.equal(result[0].asset, "0x000007c000000000000000000000000001200000");
  assert.equal(result[0].executionMode, "async_xcm");
  assert.deepEqual(result[0].assetConfig, {
    assetClass: "trust_backed",
    assetId: 1984,
    symbol: "USDt",
    decimals: 6,
    address: "0x000007c000000000000000000000000001200000"
  });
});

test("loadStrategiesConfig honours explicit executionMode overrides", () => {
  const env = {
    STRATEGIES_JSON: JSON.stringify([
      {
        strategyId: "0x56444f545f56315f4d4f434b0000000000000000000000000000000000000000",
        adapter: "0x1234567890123456789012345678901234567890",
        kind: "mock_vdot",
        executionMode: "async_xcm"
      }
    ])
  };
  const result = loadStrategiesConfig(env, { logger: silentLogger() });
  assert.equal(result[0].executionMode, "async_xcm");
});

test("loadStrategiesConfig preserves server-controlled XCM builder policy", () => {
  const env = {
    STRATEGIES_JSON: JSON.stringify([
      {
        strategyId: "0x56444f545f56315f4d4f434b0000000000000000000000000000000000000000",
        adapter: "0x1234567890123456789012345678901234567890",
        kind: "polkadot_vdot",
        executionMode: "async_xcm",
        xcm: {
          destinationParachain: "2030",
          originChain: "AssetHubPolkadot",
          destinationChain: "BifrostPolkadot",
          feeAmount: "1000000000",
          beneficiary: "0x1234567890123456789012345678901234567890"
        }
      }
    ])
  };
  const result = loadStrategiesConfig(env, { logger: silentLogger() });
  assert.deepEqual(result[0].xcm, {
    destinationParachain: 2030,
    originChain: "AssetHubPolkadot",
    destinationChain: "BifrostPolkadot",
    feeAmount: "1000000000",
    beneficiary: "0x1234567890123456789012345678901234567890"
  });
});

test("loadStrategiesConfig rejects stale raw XCM message prefixes", () => {
  const env = {
    STRATEGIES_JSON: JSON.stringify([
      {
        strategyId: "0x56444f545f56315f4d4f434b0000000000000000000000000000000000000000",
        adapter: "0x1234567890123456789012345678901234567890",
        kind: "polkadot_vdot",
        executionMode: "async_xcm",
        xcm: {
          destinationParachain: "2030",
          messagePrefixes: {
            deposit: "0x050c00",
            withdraw: "0x050800"
          }
        }
      }
    ])
  };
  const result = loadStrategiesConfig(env, { logger: silentLogger() });
  assert.deepEqual(result, []);
});

test("loadStrategiesConfig parses foreign asset metadata when the runtime index is known", () => {
  const env = {
    STRATEGIES_JSON: JSON.stringify([
      {
        strategyId: "0x56444f545f56315f4d4f434b0000000000000000000000000000000000000000",
        adapter: "0x1234567890123456789012345678901234567890",
        asset: {
          assetClass: "foreign",
          foreignAssetIndex: 5,
          symbol: "vDOT",
          xcmLocation: "{ parents: 1, interior: X1(Parachain(2030)) }"
        }
      }
    ])
  };
  const result = loadStrategiesConfig(env, { logger: silentLogger() });
  assert.deepEqual(result[0].assetConfig, {
    assetClass: "foreign",
    foreignAssetIndex: 5,
    symbol: "vDOT",
    xcmLocation: "{ parents: 1, interior: X1(Parachain(2030)) }",
    address: "0x0000000500000000000000000000000002200000"
  });
});

test("loadStrategiesConfig falls back to empty on invalid JSON", () => {
  const result = loadStrategiesConfig({ STRATEGIES_JSON: "not-json" }, { logger: silentLogger() });
  assert.deepEqual(result, []);
});

test("loadStrategiesConfig rejects non-array payloads and returns empty", () => {
  const result = loadStrategiesConfig(
    { STRATEGIES_JSON: JSON.stringify({ foo: "bar" }) },
    { logger: silentLogger() }
  );
  assert.deepEqual(result, []);
});

test("loadStrategiesConfig rejects malformed addresses entry and returns empty", () => {
  const result = loadStrategiesConfig(
    { STRATEGIES_JSON: JSON.stringify([{ strategyId: "0x00", adapter: "nope" }]) },
    { logger: silentLogger() }
  );
  assert.deepEqual(result, []);
});

test("loadStrategiesConfig defaults missing kind/riskLabel cleanly", () => {
  const env = {
    STRATEGIES_JSON: JSON.stringify([
      {
        strategyId: "0x56444f545f56315f4d4f434b0000000000000000000000000000000000000000",
        adapter: "0x1234567890123456789012345678901234567890"
      }
    ])
  };
  const result = loadStrategiesConfig(env, { logger: silentLogger() });
  assert.equal(result[0].kind, "unknown");
  assert.equal(result[0].executionMode, "sync");
  assert.equal(result[0].riskLabel, "");
  assert.equal(result[0].asset, undefined);
  assert.equal(result[0].assetConfig, undefined);
});

test("loadStrategiesConfig rejects mismatched derived and explicit asset addresses", () => {
  const result = loadStrategiesConfig(
    {
      STRATEGIES_JSON: JSON.stringify([
        {
          strategyId: "0x56444f545f56315f4d4f434b0000000000000000000000000000000000000000",
          adapter: "0x1234567890123456789012345678901234567890",
          asset: {
            assetClass: "trust_backed",
            assetId: 1984,
            address: "0x1111111111111111111111111111111111111111"
          }
        }
      ])
    },
    { logger: silentLogger() }
  );
  assert.deepEqual(result, []);
});

test("derivePolkadotHubAssetAddress handles all supported deterministic asset classes", () => {
  assert.equal(
    derivePolkadotHubAssetAddress({ assetClass: "trust_backed", assetId: 1984 }),
    "0x000007c000000000000000000000000001200000"
  );
  assert.equal(
    derivePolkadotHubAssetAddress({ assetClass: "foreign", foreignAssetIndex: 0 }),
    "0x0000000000000000000000000000000002200000"
  );
  assert.equal(
    derivePolkadotHubAssetAddress({ assetClass: "pool", assetId: 0 }),
    "0x0000000000000000000000000000000003200000"
  );
});

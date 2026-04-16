import test from "node:test";
import assert from "node:assert/strict";

import { loadStrategiesConfig } from "./bootstrap.js";

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
  assert.equal(result[0].kind, "mock_vdot");
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
  assert.equal(result[0].riskLabel, "");
  assert.equal(result[0].asset, undefined);
});

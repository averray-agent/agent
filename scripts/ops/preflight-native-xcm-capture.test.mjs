import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkBuilderOutputs,
  checkRuntimeEnv,
  loadPreflightStrategy,
  parseArgs
} from "./preflight-native-xcm-capture.mjs";

function vdotStrategy(overrides = {}) {
  return {
    strategyId: `0x${"22".repeat(32)}`,
    kind: "polkadot_vdot",
    assetConfig: {
      assetClass: "foreign",
      foreignAssetIndex: 5,
      symbol: "vDOT",
      xcmLocation: "{ parents: 1, interior: X1(Parachain(2030)) }"
    },
    xcm: {
      destinationParachain: 2030
    },
    ...overrides
  };
}

async function writeStrategyFile(payload) {
  const dir = await mkdtemp(join(tmpdir(), "native-xcm-preflight-"));
  const strategyFile = join(dir, "strategies.json");
  await writeFile(strategyFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return strategyFile;
}

test("parseArgs captures strict env and strategy file options", () => {
  assert.deepEqual(
    parseArgs(["--strict-env", "--strategy-file", "strategies.json"]),
    {
      strictEnv: true,
      strategyFile: "strategies.json"
    }
  );
});

test("parseArgs rejects missing strategy file value", () => {
  assert.throws(
    () => parseArgs(["--strategy-file"]),
    /--strategy-file requires a value/u
  );
});

test("loadPreflightStrategy reads a deployment-style strategies object", async () => {
  const strategyFile = await writeStrategyFile({
    strategies: [
      { kind: "mock_vdot" },
      vdotStrategy()
    ]
  });

  const strategy = await loadPreflightStrategy({ strategyFile });

  assert.equal(strategy.kind, "polkadot_vdot");
  assert.equal(strategy.xcm.destinationParachain, 2030);
});

test("checkBuilderOutputs passes for capture-ready vDOT strategy config", async () => {
  const strategyFile = await writeStrategyFile([vdotStrategy()]);

  const check = await checkBuilderOutputs({ strategyFile });

  assert.equal(check.ok, true);
  assert.match(check.details.join("\n"), /destination parachain resolves to 2030/u);
  assert.match(check.details.join("\n"), /deposit message ends with SetTopic\(requestId\)/u);
  assert.match(check.details.join("\n"), /withdraw message ends with SetTopic\(requestId\)/u);
  assert.match(check.details.join("\n"), /withdraw message does not contain the known scaffold byte sequence/u);
  assert.match(check.details.join("\n"), /deposit and withdraw messages are distinct/u);
});

test("checkBuilderOutputs fails closed without a polkadot_vdot strategy", async () => {
  const strategyFile = await writeStrategyFile([{ kind: "mock_vdot" }]);

  const check = await checkBuilderOutputs({ strategyFile });

  assert.equal(check.ok, false);
  assert.deepEqual(check.details, [
    "no polkadot_vdot strategy was found in --strategy-file or STRATEGIES_JSON",
    "capture preflight requires a server-controlled vDOT XCM strategy config"
  ]);
});

test("checkBuilderOutputs surfaces malformed strategy config", async () => {
  const strategyFile = await writeStrategyFile([
    vdotStrategy({
      assetConfig: {},
      xcm: {}
    })
  ]);

  const check = await checkBuilderOutputs({ strategyFile });

  assert.equal(check.ok, false);
  assert.match(check.details.join("\n"), /requires a destination parachain/u);
  assert.match(check.details.join("\n"), /fix the server-owned vDOT XCM builder config before capture/u);
});

test("checkRuntimeEnv reports missing live capture env vars", () => {
  const check = checkRuntimeEnv({
    API_URL: "https://api.example.test",
    ADMIN_JWT: "admin",
    WALLET_JWT: "wallet"
  });

  assert.equal(check.ok, false);
  assert.deepEqual(check.details, ["missing: XCM_NATIVE_HUB_WS, XCM_NATIVE_BIFROST_WS"]);
});

test("checkRuntimeEnv accepts complete live capture env vars", () => {
  const check = checkRuntimeEnv({
    API_URL: "https://api.example.test",
    ADMIN_JWT: "admin",
    WALLET_JWT: "wallet",
    XCM_NATIVE_HUB_WS: "ws://127.0.0.1:8000",
    XCM_NATIVE_BIFROST_WS: "ws://127.0.0.1:8001"
  });

  assert.equal(check.ok, true);
  assert.deepEqual(check.details, ["required live capture env vars are set"]);
});

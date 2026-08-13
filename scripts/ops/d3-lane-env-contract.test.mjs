import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const TEMPLATES = [
  new URL("../../deploy/backend.env.template", import.meta.url),
  new URL("../../deploy/backend.mainnet.env.template", import.meta.url)
];

test("both backend env templates carry the same complete 23-USDC D3 lane registry", async () => {
  let expected;
  for (const templateUrl of TEMPLATES) {
    const source = await readFile(templateUrl, "utf8");
    const match = source.match(/^CATALOGUE_LANE_REGISTRY_JSON='(.+)'$/mu);
    assert.ok(match, templateUrl.pathname);
    const registry = JSON.parse(match[1]);
    assert.deepEqual(Object.keys(registry), ["liveness", "oss-anchored", "benchmark-showcase"]);
    for (const [lane, config] of Object.entries(registry)) {
      assert.ok(config.hypothesis, `${lane} hypothesis`);
      assert.ok(config.stopCondition, `${lane} stop condition`);
      assert.match(config.dailyCapRaw, /^[0-9]+$/u, `${lane} cap`);
      assert.equal(typeof config.paused, "boolean", `${lane} paused`);
    }
    assert.equal(
      Object.values(registry).reduce((sum, config) => sum + BigInt(config.dailyCapRaw), 0n),
      23_000_000n
    );
    if (expected) assert.deepEqual(registry, expected);
    expected = registry;
  }
});

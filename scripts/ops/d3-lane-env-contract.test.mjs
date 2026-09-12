import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { CatalogueLaneDiscipline, loadCatalogueLaneRegistry } from "../../mcp-server/src/core/catalogue-lane-discipline.js";
import { MemoryStateStore } from "../../mcp-server/src/core/state-store.js";

const TEMPLATES = [
  new URL("../../deploy/backend.env.template", import.meta.url),
  new URL("../../deploy/backend.mainnet.env.template", import.meta.url)
];

test("both backend env templates carry the same complete 23-USDC D3 lane registry", async () => {
  let expected;
  for (const templateUrl of TEMPLATES) {
    const source = await readFile(templateUrl, "utf8");
    const match = source.match(/^CATALOGUE_LANE_REGISTRY_JSON=(\{.+\})$/mu);
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

test("waiver pin 5: defaults and both shipped registries hold two scheduler jobs per lane without changing daily caps", async () => {
  const registries = [loadCatalogueLaneRegistry({})];
  for (const templateUrl of TEMPLATES) {
    const source = await readFile(templateUrl, "utf8");
    registries.push(loadCatalogueLaneRegistry({
      CATALOGUE_LANE_REGISTRY_JSON: source.match(/^CATALOGUE_LANE_REGISTRY_JSON=(\{.+\})$/mu)[1]
    }));
  }
  for (const registry of registries) {
    const discipline = new CatalogueLaneDiscipline({
      registry, stateStore: new MemoryStateStore(), gasEstimateUsdc: 0,
      now: () => new Date("2026-09-11T12:00:00Z")
    });
    for (const [lane, cap, reserve, daily, reward] of [
      ["oss-anchored", 5, 2, 15_000_000n, 1], ["liveness", 4, 1, 3_000_000n, 0.1]
    ]) {
      const config = registry.get(lane);
      assert.equal(config.maxUnclaimedBacklog, cap);
      assert.equal(config.operatorReserve, reserve);
      assert.equal(config.dailyCapRaw, daily);
      const posted = [];
      for (const id of ["one", "two"]) {
        await discipline.post({ id: `${lane}-${id}`, lane, rewardAmount: reward, rewardAsset: "USDC" },
          async () => posted.push(id), { origin: "scheduler" });
      }
      assert.deepEqual(posted, ["one", "two"]);
    }
    assert.equal(registry.get("benchmark-showcase").consumer, "none");
    assert.equal(registry.get("benchmark-showcase").maxUnclaimedBacklog, 2);
    assert.equal(registry.get("benchmark-showcase").operatorReserve, 1);
    assert.equal(registry.get("benchmark-showcase").dailyCapRaw, 5_000_000n);
  }
});

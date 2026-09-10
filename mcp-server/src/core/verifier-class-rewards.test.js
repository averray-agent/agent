import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { MemoryStateStore } from "./state-store.js";
import {
  DEFAULT_VERIFIER_CLASS_REWARDS, loadVerifierClassRewards, verifierClassReward
} from "./verifier-class-rewards.js";
import {
  DEFAULT_CATALOGUE_LANE_REGISTRY, validateCatalogueLaneRegistry, CatalogueLaneDiscipline
} from "./catalogue-lane-discipline.js";
import { upsertScheduledIngestedJob, recordLanePostingRefusal } from "../services/ingested-job-upsert.js";

test("pricing pin: ingestion files contain no literal rewards and use the class table", async () => {
  const directory = new URL("../jobs/", import.meta.url);
  const files = (await readdir(directory)).filter((file) => /^ingest-.*\.js$/u.test(file) && !file.endsWith(".test.js"));
  assert.equal(files.length, 6);
  for (const file of files) {
    const source = await readFile(new URL(file, directory), "utf8");
    assert.doesNotMatch(source, /rewardAmount\s*:\s*\d/u, file);
    assert.match(source, /rewardAmount:\s*verifierClassReward\(/u, file);
  }
});

test("pricing pin: class ceiling and floors refuse ingestion with a named summary reason, never clamp", async () => {
  for (const dryRun of [false, true]) {
    for (const [verifierMode, rewardAmount] of [["benchmark", 0.4], ["github_pr", 0.2], ["deterministic", 0.5], ["witness", 0.5]]) {
      const candidate = { id: "bad-price", lane: "liveness", source: { type: "open_data_dataset" }, verifierMode, rewardAmount };
      const summary = { skipped: [] };
      let writes = 0;
      await assert.rejects(upsertScheduledIngestedJob({ createJob() { writes++; } }, candidate, { dryRun }), (error) => {
        assert.equal(recordLanePostingRefusal(summary, candidate, error), true);
        return true;
      });
      assert.equal(summary.skipped[0].reason, "verifier_class_reward_out_of_bounds");
      assert.equal(summary.skipped[0].rewardAmount, rewardAmount);
      assert.equal(summary.skipped[0].direction, verifierMode === "benchmark" ? "ceiling" : "floor");
      assert.equal(candidate.rewardAmount, rewardAmount);
      assert.equal(writes, 0);
    }
    for (const [verifierMode, rewardAmount] of Object.entries(DEFAULT_VERIFIER_CLASS_REWARDS)) {
      const candidate = { id: "valid-price", lane: "liveness", source: { type: "open_data_dataset" }, verifierMode, rewardAmount };
      assert.equal(await upsertScheduledIngestedJob({ createJob: (job) => job }, candidate, { dryRun }), candidate);
    }
  }
});

test("consumer pin: every default lane declares a consumer; missing and none refuse ingestion", async () => {
  for (const lane of Object.keys(DEFAULT_CATALOGUE_LANE_REGISTRY)) {
    const entries = structuredClone(DEFAULT_CATALOGUE_LANE_REGISTRY);
    assert.equal(typeof entries[lane].consumer, "string");
    delete entries[lane].consumer;
    assert.throws(() => validateCatalogueLaneRegistry(entries), /missing consumer/u);
    // Also test ingestion against a malformed prebuilt registry, not only the validator.
    const registry = new Map(Object.entries(entries));
    const job = { id: "no-consumer", lane, source: { type: "github_issue" }, verifierMode: "github_pr", rewardAmount: 1 };
    const platform = { catalogueLaneDiscipline: { registry }, createJob() { assert.fail("must not write"); } };
    for (const dryRun of [false, true]) {
      await assert.rejects(upsertScheduledIngestedJob(platform, job, { dryRun }), { code: "lane_consumer_missing" });
      registry.get(lane).consumer = "none";
      await assert.rejects(upsertScheduledIngestedJob(platform, job, { dryRun }), { code: "lane_consumer_none" });
      delete registry.get(lane).consumer;
    }
  }
  assert.equal(DEFAULT_CATALOGUE_LANE_REGISTRY["benchmark-showcase"].consumer, "none");
});

test("class prices are operator tunable, validated and complete", () => {
  const values = { benchmark: 0.05, github_pr: 2, deterministic: 1.5, witness: 3 };
  const table = loadVerifierClassRewards({ VERIFIER_CLASS_REWARD_USDC_JSON: JSON.stringify(values) });
  for (const [mode, value] of Object.entries(values)) assert.equal(verifierClassReward(mode, table), value);
  for (const bad of ["invalid", "[]", '{"benchmark":0.1}', JSON.stringify({ ...values, witness: -1 })]) {
    assert.throws(() => loadVerifierClassRewards({ VERIFIER_CLASS_REWARD_USDC_JSON: bad }));
  }
});

test("github class pricing preserves the oss lane cap at fifteen USDC", async () => {
  const registry = validateCatalogueLaneRegistry(DEFAULT_CATALOGUE_LANE_REGISTRY);
  assert.equal(registry.get("oss-anchored").dailyCapRaw, 15000000n);
  const discipline = new CatalogueLaneDiscipline({ registry, stateStore: new MemoryStateStore(), gasEstimateUsdc: 0, listCatalogJobs: () => [] });
  let count = 0;
  for (let i = 0; i < 15; i++) {
    await discipline.post({ id: "pr-" + i, lane: "oss-anchored", rewardAmount: verifierClassReward("github_pr"), rewardAsset: "USDC" }, () => { count++; });
  }
  await assert.rejects(discipline.post({ id: "pr-16", lane: "oss-anchored", rewardAmount: 1, rewardAsset: "USDC" }, () => { count++; }), { code: "lane_budget_exhausted" });
  assert.equal(count, 15);
});

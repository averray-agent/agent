import test from "node:test";
import assert from "node:assert/strict";
import { buildInventorySnapshot } from "./inventory-replenishment.js";

test("shared completed-source cooldown preserves active-source behavior for GitHub OSV and OpenData", async () => {
  for (const sourceType of ["github_issue", "osv_advisory", "open_data_resource"]) {
    const jobs = [
      { id: "done", source: { type: sourceType, key: "done" }, effectiveState: "exhausted",
        completedAt: "2026-09-09T12:00:00Z" },
      { id: "old", source: { type: sourceType, key: "old" }, effectiveState: "completed",
        completedAt: "2026-08-01T12:00:00Z" },
      { id: "open", source: { type: sourceType, key: "open" }, effectiveState: "claimable" },
      { id: "leased", source: { type: sourceType, key: "leased" }, effectiveState: "claimed" },
      { id: "expired", source: { type: sourceType, key: "expired" }, effectiveState: "expired" }
    ];
    const snapshot = await buildInventorySnapshot({
      listJobs: () => jobs, listJobsWithSessions: async () => jobs
    }, { sourceType, sourceKeyForJob: (job) => job.source.key, now: new Date("2026-09-10T12:00:00Z") });
    assert.deepEqual([...snapshot.activeSourceKeys], ["open", "leased", "expired"]);
    assert.deepEqual([...snapshot.completedSourceKeys], ["done"]);
    assert.equal(snapshot.claimableCount, 1);
    assert.equal(snapshot.seenSourceKeys.has("done"), true);
    assert.equal(snapshot.seenSourceKeys.has("old"), false);
  }
});

test("a missing completion time stays blocked and incomplete inventory history fails closed", async () => {
  const job = { id: "done", effectiveState: "exhausted", source: { type: "example", key: "done" } };
  const platform = { listJobs: () => [job], listJobsWithSessions: async () => [job] };
  const options = { sourceType: "example", sourceKeyForJob: (entry) => entry.source.key };
  const snapshot = await buildInventorySnapshot(platform, options);
  assert.equal(snapshot.completedSourceKeys.has("done"), true);
  platform.stateStore = { listRecentSessions: async () => Array(200).fill({ jobId: "done" }) };
  await assert.rejects(buildInventorySnapshot(platform, options), /inventory_history_incomplete/u);
});

test("session terminal times replace unknown projections and the most recent completion controls cooldown", async () => {
  const jobs = [1, 2].map((index) => ({ id: `done-${index}`, effectiveState: "exhausted",
    source: { type: "example", key: "same" } }));
  const platform = {
    listJobs: () => jobs, listJobsWithSessions: async () => jobs,
    stateStore: { listRecentSessions: async () => [
      { jobId: "done-2", status: "resolved", resolvedAt: "2026-09-09T12:00:00Z" },
      { jobId: "done-1", status: "resolved", resolvedAt: "2026-07-01T12:00:00Z" }
    ] }
  };
  const options = { sourceType: "example", sourceKeyForJob: (job) => job.source.key };
  const recent = await buildInventorySnapshot(platform, { ...options, now: new Date("2026-09-10T12:00:00Z") });
  assert.equal(recent.completedSources.get("same").completedAt, "2026-09-09T12:00:00.000Z");
  assert.equal(recent.completedSourceKeys.has("same"), true);
  const old = await buildInventorySnapshot(platform, { ...options, now: new Date("2026-10-10T12:00:00Z") });
  assert.equal(old.completedSourceKeys.has("same"), false);
});

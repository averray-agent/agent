import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStateStore } from "./state-store.js";
import { SelfIdentityRegistry } from "./self-identity-registry.js";
import { CatalogueLaneDiscipline, DEFAULT_CATALOGUE_LANE_REGISTRY } from "./catalogue-lane-discipline.js";
import { buildRetainedWorkerMetrics, retainedCostStopCondition, retentionSourceKey } from "./retained-workers.js";
import { TransparencyService } from "../services/transparency-service.js";

const NOW = new Date("2026-09-10T12:00:00Z");
const A = `0x${"a".repeat(40)}`;
const B = `0x${"b".repeat(40)}`;
const SELF = `0x${"c".repeat(40)}`;
function settled(id, wallet, source, amount = "10000000") {
  return { sessionId: id, jobId: id, wallet, status: "resolved", claimedAt: "2026-09-10T10:00:00Z",
    resolvedAt: "2026-09-10T11:00:00Z", verificationSummary: { outcome: "approved" },
    jobSnapshot: { definition: { id, lane: "oss-anchored", source: {
      type: "wikipedia_article", language: "en", pageId: source, revisionId: "123"
    } } }, payoutTx: { status: 1, settlement: { assetSymbol: "USDC", workerAmountRaw: amount } } };
}
const registry = new SelfIdentityRegistry({ operatorWallets: new Set([SELF]) });
const metrics = (sessions) => buildRetainedWorkerMetrics(sessions, { now: NOW, selfIdentityRegistry: registry });

test("retention pin: three reissues of one source and two distinct sources retain only one external claimant", () => {
  const sessions = [settled("a1", A, 1), settled("a2", A, 1), settled("a3", A, 1),
    settled("b1", B, 1), settled("b2", B, 2), settled("self1", SELF, 1), settled("self2", SELF, 2)];
  const result = metrics(sessions);
  assert.equal(result.retainedExternalWorkers30d, 1);
  assert.equal(result.externalRewardOutlay30d.usdc, "50");
  assert.equal(result.costPerRetainedExternalWorker30d.usdc, "50");
  assert.deepEqual(metrics([...sessions, sessions[0]]), result, "duplicate session rows cannot add spend");
  sessions[4].resolvedAt = "2026-08-11T12:00:00Z";
  assert.equal(metrics(sessions).retainedExternalWorkers30d, 0, "left boundary is outside trailing window");
  sessions[4].resolvedAt = "2026-09-11T12:00:00Z";
  assert.equal(metrics(sessions).retainedExternalWorkers30d, 0, "future settlement excluded");
});

test("retention pin: outlay sixty divided by two retained is thirty and the OSS stop condition is met", async () => {
  const sessions = [settled("a1", A, 1, "15000000"), settled("a2", A, 2, "15000000"),
    settled("b1", B, 1, "15000000"), settled("b2", B, 2, "15000000")];
  const stateStore = new MemoryStateStore();
  for (const session of sessions) await stateStore.upsertSession(session);
  const board = await new CatalogueLaneDiscipline({ stateStore, registry: DEFAULT_CATALOGUE_LANE_REGISTRY,
    now: () => NOW, selfIdentityRegistry: registry }).getBoardSnapshot();
  const lane = board.lanes.find((entry) => entry.id === "oss-anchored");
  assert.equal(lane.retainedExternalWorkers30d, 2);
  assert.equal(lane.externalRewardOutlay30d.usdc, "60");
  assert.equal(lane.costPerRetainedExternalWorker30d.usdc, "30");
  assert.equal(lane.stopConditionMet, true);
  assert.match(lane.stopCondition, /25 USDC/u);
  assert.equal(board.retained.retainedExternalWorkers30d, 2);
  const transparency = new TransparencyService({ stateStore, selfIdentityRegistry: registry, gateway: { async getJob() { return {}; } },
    platformService: { getJobDefinition() { return {}; } }, now: () => NOW.getTime() });
  const read = await transparency.readFlow();
  assert.ok(read.retained);
  const flow = transparency.buildFlow(read, NOW.getTime());
  assert.equal(flow.retainedExternalWorkers30d.value, 2);
  assert.equal(flow.externalRewardOutlay30d.value, "60");
  assert.equal(flow.costPerRetainedExternalWorker30d.value, "30");
  for (const name of ["retainedExternalWorkers30d", "externalRewardOutlay30d", "costPerRetainedExternalWorker30d"]) {
    assert.equal(flow[name].status, "fresh");
    assert.match(flow[name].source, /claimant/u);
    assert.match(flow[name].proof, /distinct source/u);
  }
});

test("retention never labels incomplete evidence or a zero denominator as a computed safe cost", () => {
  const one = settled("a1", A, 1);
  assert.equal(retainedCostStopCondition(metrics([one])), null);
  const missing = settled("a2", A, 2);
  delete missing.jobSnapshot;
  assert.equal(metrics([one, missing]).retainedExternalWorkers30d, null);
  assert.equal(metrics([one, missing]).costPerRetainedExternalWorker30d.missingSourceCount, 1);
  delete missing.payoutTx;
  assert.equal(metrics([one, missing]).externalRewardOutlay30d.raw, null);
  assert.equal(retainedCostStopCondition(metrics([one, missing])), null);
  const rejected = { ...settled("rejected", A, 2), status: "rejected", verificationSummary: { outcome: "rejected" } };
  assert.equal(metrics([one, rejected]).retainedExternalWorkers30d, 0);
});

test("retention source identity ignores reissue metadata and pins each supported ingestion family", () => {
  for (const source of [
    { type: "github_issue", repo: "org/repo", issueNumber: 1 },
    { type: "osv_advisory", ecosystem: "npm", packageName: "pkg", vulnerableVersion: "1", advisoryId: "OSV-1" },
    { type: "open_data_dataset", provider: "data.gov", datasetId: "dataset", resourceId: "resource" },
    { type: "openapi_spec", provider: "provider", specId: "spec" },
    { type: "standards_spec", provider: "provider", specId: "spec" }
  ]) {
    const key = retentionSourceKey({ id: "first", source });
    assert.ok(key);
    assert.equal(retentionSourceKey({ id: "first-r2", source: { ...source, reissueOf: "first", reissueNumber: 2 } }), key);
  }
  assert.equal(retentionSourceKey({ source: { type: "wikipedia_article", title: "not a revision pin" } }), undefined);
});

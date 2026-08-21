import test from "node:test";
import assert from "node:assert/strict";

import {
  inspectClaimJobDefinitionIntegrity,
  JOB_DEFINITION_CHAIN_MISMATCH_REASON,
  JOB_DEFINITION_CHAIN_READ_UNAVAILABLE_REASON
} from "./claim-job-integrity.js";
import { buildJobSnapshot } from "./job-snapshot.js";
import { MemoryStateStore } from "./state-store.js";

function job(overrides = {}) {
  return {
    id: "integrity-candidate",
    rewardAsset: "USDC",
    rewardAmount: 0.25,
    verifierMode: "benchmark",
    verifierConfig: { handler: "benchmark", requiredKeywords: ["complete"] },
    ...overrides
  };
}

function gateway(getJob) {
  return {
    isEnabled: () => true,
    toJobId: (jobId) => `chain:${jobId}`,
    getJob
  };
}

test("claim integrity accepts a served definition that reproduces the commitment", async () => {
  const candidate = job();
  const committed = buildJobSnapshot(candidate).specHash;
  const inspected = await inspectClaimJobDefinitionIntegrity({
    job: candidate,
    stateStore: new MemoryStateStore(),
    blockchainGateway: gateway(async () => ({ state: 1, specHash: committed }))
  });

  assert.equal(inspected.decision.eligible, true);
  assert.equal(inspected.decision.status, "matching");
  assert.equal(inspected.decision.specHash, committed);
});

test("claim integrity translates committed definition drift to a claim-scope refusal", async () => {
  const candidate = job();
  const inspected = await inspectClaimJobDefinitionIntegrity({
    job: candidate,
    stateStore: new MemoryStateStore(),
    blockchainGateway: gateway(async () => ({ state: 1, specHash: `0x${"f".repeat(64)}` }))
  });

  assert.equal(inspected.decision.eligible, false);
  assert.equal(inspected.decision.status, "mismatch");
  assert.equal(inspected.decision.reason, JOB_DEFINITION_CHAIN_MISMATCH_REASON);
  assert.equal(inspected.decision.sourceCode, "job_snapshot_on_chain_spec_hash_mismatch");
  assert.equal(Object.hasOwn(inspected.decision, "sessionId"), false);
});

test("claim integrity fails open when the chain commitment read is unavailable", async () => {
  const inspected = await inspectClaimJobDefinitionIntegrity({
    job: job(),
    stateStore: new MemoryStateStore(),
    blockchainGateway: gateway(async () => { throw new Error("temporary RPC outage"); })
  });

  assert.equal(inspected.decision.eligible, true);
  assert.equal(inspected.decision.status, "unavailable");
  assert.equal(inspected.decision.reason, JOB_DEFINITION_CHAIN_READ_UNAVAILABLE_REASON);
  assert.equal(inspected.decision.failOpen, true);
  assert.equal(inspected.decision.sourceCode, "job_snapshot_chain_read_failed");
});

test("claim integrity permits creation only when the chain job does not exist", async () => {
  const inspected = await inspectClaimJobDefinitionIntegrity({
    job: job(),
    stateStore: new MemoryStateStore(),
    blockchainGateway: gateway(async () => ({ state: 0 }))
  });

  assert.equal(inspected.decision.eligible, true);
  assert.equal(inspected.decision.status, "uncommitted");
  assert.equal(
    inspected.decision.message,
    "This job is served fail-open pending its chain commitment. If claimed now, the resulting receipt will carry chain_unavailable_fail_open."
  );
  assert.equal(inspected.liveJob.state, 0);
});

test("claim integrity does not disguise an existing job with no commitment as an outage", async () => {
  const inspected = await inspectClaimJobDefinitionIntegrity({
    job: job(),
    stateStore: new MemoryStateStore(),
    blockchainGateway: gateway(async () => ({ state: 1 }))
  });

  assert.equal(inspected.decision.eligible, false);
  assert.equal(inspected.decision.status, "invalid");
  assert.equal(inspected.decision.sourceCode, "job_snapshot_chain_spec_hash_missing");
});

test("claim integrity pins the poster preimage for an external listing", async () => {
  const stateStore = new MemoryStateStore();
  const definition = {
    category: "coding",
    rewardAsset: "USDC",
    rewardAmount: 1,
    verifierMode: "human_fallback"
  };
  const candidate = job({
    id: `0x${"a".repeat(64)}`,
    ...definition,
    source: { type: "external", poster: { wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } }
  });
  await stateStore.materializeExternalJobDraft({
    draftId: "integrity-external-draft",
    jobId: candidate.id,
    wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    definition,
    status: "live"
  });
  const committed = buildJobSnapshot(definition).specHash;

  const inspected = await inspectClaimJobDefinitionIntegrity({
    job: candidate,
    stateStore,
    blockchainGateway: gateway(async () => ({ state: 1, specHash: committed }))
  });

  assert.equal(inspected.decision.eligible, true);
  assert.deepEqual(inspected.snapshot.specDefinition, definition);
  assert.equal(inspected.snapshot.specHash, committed);
});

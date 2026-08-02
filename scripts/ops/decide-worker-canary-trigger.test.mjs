import assert from "node:assert/strict";
import test from "node:test";

import { decideWorkerCanaryTrigger } from "./decide-worker-canary-trigger.mjs";

const SHA = "1".repeat(40);

test("post-deploy canary skips when Deploy Production changed no running component", () => {
  assert.deepEqual(
    decideWorkerCanaryTrigger({
      eventName: "workflow_run",
      workflowConclusion: "success",
      deployChanged: false,
      deployedSha: SHA,
      greenCanaryExists: false,
    }),
    {
      shouldRun: false,
      reason: "no_running_system_change",
      deployedSha: SHA,
      summary: "Deploy Production reported no running-system change; skipping the paid lifecycle walk.",
    },
  );
});

test("post-deploy canary debounces a deployed SHA with an existing green marker", () => {
  const result = decideWorkerCanaryTrigger({
    eventName: "workflow_run",
    workflowConclusion: "success",
    deployChanged: true,
    deployedSha: SHA,
    greenCanaryExists: true,
  });

  assert.equal(result.shouldRun, false);
  assert.equal(result.reason, "green_sha_already_proven");
  assert.match(result.summary, new RegExp(SHA, "u"));
});

test("post-deploy canary runs once for a changed SHA without a green marker", () => {
  const result = decideWorkerCanaryTrigger({
    eventName: "workflow_run",
    workflowConclusion: "success",
    deployChanged: true,
    deployedSha: SHA,
    greenCanaryExists: false,
  });

  assert.equal(result.shouldRun, true);
  assert.equal(result.reason, "new_deployed_sha");
});

test("daily 06:37 heartbeat runs even when the deployed SHA is already green", () => {
  const result = decideWorkerCanaryTrigger({
    eventName: "schedule",
    deployedSha: SHA,
    greenCanaryExists: true,
  });

  assert.equal(result.shouldRun, true);
  assert.equal(result.reason, "daily_heartbeat");
});

test("failed deploy produces an explicit skip reason", () => {
  const result = decideWorkerCanaryTrigger({
    eventName: "workflow_run",
    workflowConclusion: "failure",
    deployedSha: SHA,
  });

  assert.equal(result.shouldRun, false);
  assert.equal(result.reason, "deploy_not_successful");
  assert.match(result.summary, /concluded failure/u);
});

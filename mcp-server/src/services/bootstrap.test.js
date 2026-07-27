import assert from "node:assert/strict";
import test from "node:test";

import { getJobSchema, validateAgainstSchema } from "../core/job-schema-registry.js";
import { BOOTSTRAP_JOBS } from "./bootstrap-jobs.js";

test("bootstrap rotates the closed starter job id and seeds an honest low-value task instance", () => {
  const publicJobs = BOOTSTRAP_JOBS.filter((job) => job.lifecycle?.status !== "archived");
  const starter = publicJobs.find((job) => job.id === "starter-coding-002");

  assert.equal(publicJobs.some((job) => job.id === "starter-coding-001"), false);
  assert.ok(starter);
  assert.equal(starter.rewardAmount, 0.2);
  assert.equal(starter.onboardingWaiverEligible, true);
  assert.equal(typeof starter.input?.task, "string");
  assert.ok(starter.input.task.length > 0);
  assert.ok(Array.isArray(starter.input.acceptanceCriteria));
  assert.ok(starter.input.acceptanceCriteria.length > 0);
  assert.doesNotThrow(() => validateAgainstSchema(
    starter.input,
    getJobSchema(starter.inputSchemaRef)
  ));

  const retired = BOOTSTRAP_JOBS.find((job) => job.id === "starter-coding-001");
  assert.equal(retired.lifecycle?.status, "archived");
});

import assert from "node:assert/strict";
import test from "node:test";

import { BOOTSTRAP_JOBS } from "./bootstrap-jobs.js";

test("bootstrap retains closed starter ids only as archived history", () => {
  const publicJobs = BOOTSTRAP_JOBS.filter((job) => job.lifecycle?.status !== "archived");

  assert.equal(publicJobs.some((job) => job.id === "starter-coding-001"), false);
  assert.equal(publicJobs.some((job) => job.id === "starter-coding-002"), false);

  for (const jobId of ["starter-coding-001", "starter-coding-002"]) {
    const retired = BOOTSTRAP_JOBS.find((job) => job.id === jobId);
    assert.equal(retired.lifecycle?.status, "archived");
    assert.match(retired.lifecycle?.reason ?? "", /job ids are never reused/iu);
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import yaml from "js-yaml";

test("Operator app CI runs app unit tests on Node 22 without bypassing failures", () => {
  const workflow = yaml.load(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const job = workflow.jobs.frontend;
  const step = job.steps.find((entry) => entry.run === "npm run test:app");
  assert.ok(step);
  assert.equal(step.if, undefined);
  assert.equal(step["continue-on-error"], undefined);
  assert.ok(workflow.jobs["ci-complete"].needs.includes("frontend"));
  assert.notEqual(job["continue-on-error"], true);
  assert.ok(job.steps.some((entry) => entry.with?.["node-version"] === "22"));
  assert.ok(job.steps.indexOf(step) < job.steps.findIndex((entry) => entry.run === "npm run build:frontend"));
});

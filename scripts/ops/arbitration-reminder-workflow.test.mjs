import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import test from "node:test";

const source = readFileSync(new URL("../../.github/workflows/arbitration-deadline-reminders.yml", import.meta.url), "utf8");
const workflow = yaml.load(source);
test("arbitration reminder workflow schedules serialized public reads", () => {
  assert.equal(workflow.on.schedule[0].cron, "7 */2 * * *");
  assert.deepEqual(workflow.permissions, { contents: "read", actions: "read" });
  assert.deepEqual(workflow.concurrency, { group: "arbitration-deadline-reminders", "cancel-in-progress": false });
  assert.equal(workflow.jobs.remind["timeout-minutes"], 15);
  assert.doesNotMatch(source, /gh issue|environment:|op:\/\/|ADMIN|REFRESH/);
  assert.deepEqual([...source.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]), ["PHONE_PUSH_URL"]);
});
test("arbitration reminder workflow keeps drills separate from artifact restore and upload", () => {
  const steps = workflow.jobs.remind.steps;
  assert.equal(steps.find((step) => step.name === "Restore delivery observations").if, "inputs.drill != true");
  const save = steps.find((step) => step.name === "Save delivery observations");
  assert.equal(save.if, "always() && inputs.drill != true");
  assert.equal(save.with["retention-days"], 90);
  assert.equal(save.with.name, "arbitration-reminder-state");
  assert.match(steps.find((step) => step.name === "Restore delivery observations").run, /gh run download/);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["drill", "simulate_now"]);
});
test("arbitration reminder workflow requires configured phone delivery", () => {
  const step = workflow.jobs.remind.steps.find((step) => step.name === "Read chain and deliver reminders");
  const result = spawnSync("bash", ["-c", step.run], { encoding: "utf8", env: { ...process.env, PHONE_PUSH_URL: "" } });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /phone push not configured or undeliverable/);
  assert.doesNotMatch(result.stdout + result.stderr, /https:\/\/ntfy/);
});
test("arbitration reminder phone text stays in its dedicated formatter", () => {
  for (const path of ["./arbitration-deadlines.mjs", "./escrow-chain-lib.mjs", "../../.github/workflows/arbitration-deadline-reminders.yml"]) {
    assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), "utf8"), /half pay|anyone can close/);
  }
});

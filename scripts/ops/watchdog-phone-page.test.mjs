import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import test from "node:test";
import { selectWatchdogPage } from "./watchdog-phone-page.mjs";

const workflow = readFileSync(new URL("../../.github/workflows/external-uptime-watchdog.yml", import.meta.url), "utf8");
const start = Date.parse("2026-01-05T10:00:00Z");
const makeIssue = () => ({ number: 42, url: "https://example.test/issues/42", state: "OPEN",
  createdAt: new Date(start).toISOString(), comments: [] });

test("watchdog pages twice across eight quarter-hour observations", () => {
  const issue = makeIssue();
  const pages = [];
  for (let run = 0; run < 8; run++) {
    const page = selectWatchdogPage({ issue, failing: true, now: start + run * 900_000 });
    if (page) {
      pages.push(page);
      issue.comments.push({ author: { login: "github-actions[bot]" }, body: page.marker });
    }
  }
  assert.deepEqual(pages.map(({ page, priority }) => [page, priority]), [[0, 5], [1, 4]]);
});
test("watchdog catches up at four and twelve hours and every twelve hours after", () => {
  const issue = makeIssue();
  for (const [hour, expected] of [[0, 0], [1, 1], [4, 2], [12, 3], [24, 4], [36, 5]]) {
    const page = selectWatchdogPage({ issue, failing: true, now: start + hour * 3_600_000 });
    assert.equal(page.page, expected);
    issue.comments.push({ author: { login: "github-actions[bot]" }, body: page.marker });
    assert.equal(selectWatchdogPage({ issue, failing: true, now: start + hour * 3_600_000 }), null);
  }
});
test("watchdog uses only its own delivery markers", () => {
  const issue = makeIssue();
  issue.comments.push({ author: { login: "synthetic-user" }, body: "<!-- page:99 -->" });
  assert.equal(selectWatchdogPage({ issue, failing: true, now: start }).page, 0);
});
test("watchdog recovery is limited to the current observation", () => {
  const issue = { ...makeIssue(), state: "CLOSED", closedAt: new Date(start).toISOString() };
  assert.equal(selectWatchdogPage({ issue, failing: false, now: start, since: start }).priority, 3);
  assert.equal(selectWatchdogPage({ issue, failing: false, now: start + 1, since: start + 1 }), null);
});
test("watchdog keeps issue handling separate from always-run phone delivery", () => {
  const page = workflow.slice(workflow.indexOf("      - name: Phone page"), workflow.indexOf("      - name: Phone push (config)"));
  assert.match(page, /if: always\(\) &&/);
  assert.match(page, /if \[ -z "\$PHONE_PUSH_URL" \]; then exit 0; fi/);
  const open = workflow.slice(workflow.indexOf("      - name: Open or update"), workflow.indexOf("      - name: Close the incident"));
  const close = workflow.slice(workflow.indexOf("      - name: Close the incident"), workflow.indexOf("      - name: Assign the incident"));
  assert.doesNotMatch(open + close, /phone-push|PHONE_PUSH/);
  assert.match(open + close, /inputs\.drill != true/g);
  assert.match(page, /\[DRILL\] page/);
  assert.match(page, /\[DRILL\] all-clear/);
  const drill = page.slice(page.indexOf('if [ "$DRILL" = "true" ]'), page.indexOf('number="'));
  assert.match(drill, /\[DRILL\] page/);
  assert.doesNotMatch(drill, /gh issue/);
  assert.match(workflow, /workflow_dispatch:\n    inputs:\n      drill:/);
  assert.match(workflow, /best-effort/);
});
test("watchdog configuration failures do not edit issues", () => {
  const config = workflow.slice(workflow.indexOf("      - name: Phone push (config)"), workflow.indexOf("      - name: Fail the run"));
  assert.match(config, /phone push not configured or undeliverable/);
  assert.match(config, /-z "\$PHONE_PUSH_URL"/);
  assert.match(config, /steps\.page\.outcome/);
  assert.doesNotMatch(config, /gh issue/);
  const steps = yaml.load(workflow).jobs.probe.steps;
  const env = { ...process.env, PHONE_PUSH_URL: "", DRILL: "true", PAGE_OUTCOME: "success" };
  assert.equal(spawnSync("bash", ["-c", steps.find((step) => step.name === "Phone page").run], { env }).status, 0);
  const result = spawnSync("bash", ["-c", steps.find((step) => step.name === "Phone push (config)").run], { env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /phone push not configured or undeliverable/);
});
test("watchdog phone workflow uses the repository phone secret", () => {
  assert.deepEqual([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]), ["PHONE_PUSH_URL", "PHONE_PUSH_URL"]);
  assert.doesNotMatch(workflow, /environment:|op:\/\/|ADMIN|REFRESH/);
});

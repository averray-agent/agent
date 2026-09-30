import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

test("watchdog forwards the observed issue number to assignment and paging", () => {
  const steps = yaml.load(workflow).jobs.probe.steps;
  const open = steps.find((step) => step.name === "Open or update the incident issue");
  const close = steps.find((step) => step.name === "Close the incident issue on recovery");
  const assign = steps.find((step) => step.name === "Assign the incident");
  const page = steps.find((step) => step.name === "Phone page");
  assert.equal(open.id, "incident_open");
  assert.equal(close.id, "incident_close");
  assert.match(open.run, /number=\$existing.*GITHUB_OUTPUT/);
  assert.match(close.run, /number=\$existing.*GITHUB_OUTPUT/);
  assert.equal(assign.env.INCIDENT_NUMBER, "${{ steps.incident_open.outputs.number }}");
  assert.equal(page.env.INCIDENT_NUMBER, "${{ steps.incident_open.outputs.number || steps.incident_close.outputs.number }}");
  assert.match(assign.run, /existing="\$INCIDENT_NUMBER"\n\s*if \[ -z "\$existing" \]/);
  assert.match(page.run, /number="\$INCIDENT_NUMBER"\n\s*if \[ -z "\$number" \]/);
});

test("watchdog first observation pages and assigns the newly created issue", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "watchdog-observation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = join(dir, "calls.log"), pushes = join(dir, "pushes.log"), output = join(dir, "output");
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$GH_CALL_LOG"
case "$1 $2" in
  "issue list") if [[ "$*" == *"--state all"* ]]; then echo 42; fi ;;
  "issue create") echo https://example.test/issues/43 ;;
  "issue view") if [ "$3" = "43" ]; then printf '%s' "$CURRENT_ISSUE"; else printf '%s' "$EARLIER_ISSUE"; fi ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(dir, "curl"), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$PUSH_CALL_LOG"\ncat >/dev/null\n', { mode: 0o755 });
  const now = Date.now();
  const current = { ...makeIssue(), number: 43, url: "https://example.test/issues/43", createdAt: new Date(now).toISOString() };
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: output,
    GITHUB_REPOSITORY: "synthetic/repository", ISSUE_TITLE: "Synthetic observation", DETAIL: "Synthetic checks",
    RUN_URL: "https://example.test/run", GH_CALL_LOG: calls, PUSH_CALL_LOG: pushes, RUNNER_TEMP: dir,
    CURRENT_ISSUE: JSON.stringify(current), EARLIER_ISSUE: JSON.stringify({ ...makeIssue(), state: "CLOSED" }),
    PHONE_PUSH_URL: "https://push.example.test/topic", DRILL: "false", FAILING: "yes", SINCE: new Date(now).toISOString() };
  const steps = yaml.load(workflow).jobs.probe.steps;
  const run = (name, extra = {}) => {
    const result = spawnSync("bash", ["-c", steps.find((step) => step.name === name).run], {
      env: { ...env, ...extra }, encoding: "utf8", cwd: fileURLToPath(new URL("../../", import.meta.url))
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  run("Open or update the incident issue");
  assert.match(readFileSync(output, "utf8"), /number=43/);
  run("Assign the incident", { INCIDENT_NUMBER: "43" });
  run("Phone page", { INCIDENT_NUMBER: "43" });
  const trace = readFileSync(calls, "utf8");
  assert.match(trace, /issue edit 43 .*--add-assignee/);
  assert.match(trace, /issue view 43 /);
  assert.doesNotMatch(trace, /--state all/);
  assert.match(readFileSync(pushes, "utf8"), /Priority: 5/);
});

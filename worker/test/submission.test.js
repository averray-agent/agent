import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assembleGithubPrSubmission,
  filesChangedFromPatch,
} from "../src/submission.js";

const jobUrl = new URL("../examples/github-issue-job.json", import.meta.url);
const reportUrl = new URL("./fixtures/verification-report.json", import.meta.url);
const patchUrl = new URL("./fixtures/workspace.patch", import.meta.url);

async function jsonFixture(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

test("filesChangedFromPatch parses and deduplicates git diff headers", async () => {
  const patch = await readFile(patchUrl, "utf8");
  assert.deepEqual(filesChangedFromPatch(`${patch}\n${patch}`), [
    "src/adapter.js",
    "test/adapter.test.js",
  ]);
});

test("assembleGithubPrSubmission creates truthful verified evidence", async () => {
  const [job, verificationReport, patchText] = await Promise.all([
    jsonFixture(jobUrl),
    jsonFixture(reportUrl),
    readFile(patchUrl, "utf8"),
  ]);
  const submission = assembleGithubPrSubmission({
    job,
    prUrl: "https://github.com/averray-agent/agent/pull/812",
    verificationReport,
    changeSummary: "Preserve verification evidence across retries.",
    patchText,
    notes: "Focused change only.",
    ciStatus: "passing",
  });

  assert.deepEqual(submission, {
    prUrl: "https://github.com/averray-agent/agent/pull/812",
    summary: "Preserve verification evidence across retries.",
    tests:
      "Harness deterministic checks passed: job-checks (command): passed — command_passed; no-regressions (baseline_comparison): passed — no_new_failures",
    filesChanged: ["src/adapter.js", "test/adapter.test.js"],
    referencesIssue: true,
    checksPassing: true,
    issueNumber: 741,
    issueUrl: "https://github.com/averray-agent/agent/issues/741",
    notes: "Focused change only.",
    ciStatus: "passing",
  });
});

test("assembler refuses absent PR evidence or failed verification", async () => {
  const job = await jsonFixture(jobUrl);
  const verificationReport = await jsonFixture(reportUrl);
  assert.throws(
    () => assembleGithubPrSubmission({ job, verificationReport, prUrl: "" }),
    /prUrl is required/,
  );
  assert.throws(
    () => assembleGithubPrSubmission({ job, verificationReport: { passed: false }, prUrl: "https://example.test/pr/1" }),
    /did not pass verification/,
  );
});

test("assembler remains truthful when a passing report contains no deterministic checks", async () => {
  const job = await jsonFixture(jobUrl);
  const submission = assembleGithubPrSubmission({
    job,
    prUrl: "https://github.com/averray-agent/agent/pull/813",
    verificationReport: { passed: true, check_results: [] },
    patchText: "",
  });
  assert.equal(submission.summary, "Resolve averray-agent/agent issue #741");
  assert.equal(submission.tests, "Harness verification passed; no deterministic checks were reported.");
  assert.deepEqual(submission.filesChanged, []);
});

test("assembler rejects an unknown CI status", async () => {
  const job = await jsonFixture(jobUrl);
  assert.throws(
    () => assembleGithubPrSubmission({
      job,
      prUrl: "https://github.com/averray-agent/agent/pull/814",
      verificationReport: { passed: true },
      ciStatus: "green",
    }),
    /Invalid ciStatus/,
  );
});

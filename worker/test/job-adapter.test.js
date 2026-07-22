import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  mapJobToTaskIntent,
  serializeIntent,
  slugifyJobId,
  supportsBaselineComparison,
} from "../src/job-adapter.js";

const sampleUrl = new URL("../examples/github-issue-job.json", import.meta.url);
const unverifiableUrl = new URL("./fixtures/unverifiable-job.json", import.meta.url);

async function fixture(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

test("slugifyJobId produces a bounded harness id", () => {
  const slug = slugifyJobId(`  Héllo / WORLD #${"x".repeat(160)}  `);
  assert.match(slug, /^[a-z0-9-]+$/);
  assert.ok(slug.length <= 120);
  assert.equal(slugifyJobId("💸"), "job");
});

test("mapJobToTaskIntent produces the verified deterministic structure", async () => {
  const job = await fixture(sampleUrl);
  const { intent, warnings } = mapJobToTaskIntent(job, { workspacePath: "/tmp/workspace" });

  assert.deepEqual(warnings, []);
  assert.equal(intent.apiVersion, "harness/v1alpha1");
  assert.equal(intent.kind, "TaskIntent");
  assert.equal(intent.metadata.id, "github-averray-agent-agent-741");
  assert.deepEqual(intent.metadata.labels, {
    averray_job_id: "github:averray-agent/agent#741",
    source_type: "github_issue",
    repo: "averray-agent/agent",
    issue_number: "741",
  });
  assert.equal(intent.spec.profile, "averray-worker");
  assert.deepEqual(intent.spec.deliverables, [
    { type: "workspace_patch" },
    { type: "verification_report" },
    { type: "change_summary" },
  ]);
  assert.deepEqual(intent.spec.context.workspace, { path: "/tmp/workspace", revision: "HEAD" });
  assert.deepEqual(intent.spec.constraints, {
    allowed_paths: [],
    forbidden_paths: [],
    network: "deny",
  });
  // `npm test` is not baseline-capable (the kernel only baselines pytest), so
  // the command check must be the one and only deterministic gate.
  assert.deepEqual(intent.spec.acceptance, [
    {
      id: "job-checks",
      type: "command",
      command: "npm test",
      required: true,
    },
  ]);
  assert.deepEqual(intent.spec.approvals, []);
  assert.deepEqual(intent.spec.budgets, {
    elapsed: "PT30M",
    model_tokens: 2_000_000,
    tool_calls: 400,
    max_children: 1,
    max_concurrent_children: 1,
  });
  assert.deepEqual(intent.spec.learning, {
    episode_capture: true,
    memory_write: "none",
    skill_generation: "ineligible",
  });
  assert.match(intent.spec.objective, /Preserve evidence when a verifier retries/);
  assert.match(intent.spec.objective, /The sandbox has no network access/);
  assert.match(intent.spec.objective, /Do not open a PR, fetch URLs, or submit work/);
});

test("explicit mapping options override suggested defaults", async () => {
  const job = await fixture(sampleUrl);
  const { intent } = mapJobToTaskIntent(job, {
    workspacePath: "/tmp/repo",
    verifyCommand: "node --test test/focused.test.js",
    workingDirectory: "worker",
    profile: "custom-worker",
    revision: "abc123",
    allowedPaths: ["src/**"],
    forbiddenPaths: ["secrets/**"],
    budgets: { tool_calls: 25 },
  });

  assert.equal(intent.spec.profile, "custom-worker");
  assert.deepEqual(intent.spec.context.workspace, { path: "/tmp/repo", revision: "abc123" });
  assert.deepEqual(intent.spec.constraints.allowed_paths, ["src/**"]);
  assert.deepEqual(intent.spec.constraints.forbidden_paths, ["secrets/**"]);
  assert.equal(intent.spec.acceptance[0].command, "node --test test/focused.test.js");
  assert.equal(intent.spec.acceptance[0].working_directory, "worker");
  assert.equal(intent.spec.acceptance.length, 1);
  assert.equal(intent.spec.budgets.tool_calls, 25);
  assert.equal(intent.spec.budgets.model_tokens, 2_000_000);
});

test("baseline comparison is emitted only for pytest-invoking verify commands", async () => {
  const job = await fixture(sampleUrl);

  for (const command of ["pytest -q", "pytest-xdist -n 2", "python -m pytest tests/", "python3.12 -m pytest"]) {
    const { intent } = mapJobToTaskIntent(job, { workspacePath: "/tmp/w", verifyCommand: command });
    assert.deepEqual(
      intent.spec.acceptance.map((check) => check.id),
      ["job-checks", "no-regressions"],
      command,
    );
    assert.equal(intent.spec.acceptance[1].baseline_command, command);
  }

  for (const command of [
    "npm test",
    "node test.js",
    "make check",
    "python -m unittest",
    "python3 -c 'import pytest'",
    "pytest -q --junitxml=out.xml",
  ]) {
    const { intent } = mapJobToTaskIntent(job, { workspacePath: "/tmp/w", verifyCommand: command });
    assert.deepEqual(intent.spec.acceptance.map((check) => check.id), ["job-checks"], command);
  }

  assert.equal(supportsBaselineComparison(""), false);
});

test("unverifiable jobs have empty acceptance and an eligibility warning", async () => {
  const job = await fixture(unverifiableUrl);
  const { intent, warnings } = mapJobToTaskIntent(job, { workspacePath: "/tmp/workspace" });

  assert.deepEqual(intent.spec.acceptance, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not eligible for automated submission/);
  assert.doesNotMatch(serializeIntent(intent), /"type": "rubric"/);
});

test("serializeIntent returns round-trippable JSON", async () => {
  const job = await fixture(sampleUrl);
  const { intent } = mapJobToTaskIntent(job, { workspacePath: "/tmp/workspace" });
  assert.deepEqual(JSON.parse(serializeIntent(intent)), intent);
});

test("workspacePath is mandatory", async () => {
  const job = await fixture(sampleUrl);
  assert.throws(() => mapJobToTaskIntent(job), /workspacePath is required/);
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import yaml from "js-yaml";

const workflow = async (name) => yaml.load(await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"));

test("main CI cannot be cancelled by a superseding run; PR and merge-group refs still can", async () => {
  const ci = await workflow("ci");
  assert.equal(ci.concurrency.group, "ci-${{ github.ref }}");
  assert.equal(ci.concurrency["cancel-in-progress"], "${{ github.ref != 'refs/heads/main' }}");
  assert.deepEqual(ci.on.push.branches, ["main"]);
  assert.ok(Object.hasOwn(ci.on, "pull_request"));
  assert.ok(Object.hasOwn(ci.on, "merge_group"));
});

test("unsuccessful main CI has a separate unprivileged report job without enabling deployment", async () => {
  const deploy = await workflow("deploy-production");
  const job = deploy.jobs["report-ci-blocked-deploy"];
  assert.equal(job.if, "github.event_name == 'workflow_run' && github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.conclusion != 'success'");
  assert.equal(job.needs, undefined, "report must run even when the deployment job is skipped");
  assert.deepEqual(job.permissions, {});
  assert.equal(job.environment, undefined, "report must not wait for production environment approval");
  assert.equal(job.steps.length, 1, "no checkout, credentials or production access needed");
  assert.equal(deploy.jobs.deploy.if, "github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'");
});

test("blocked-deploy report emits an error and summary and fails for each unsuccessful conclusion", async () => {
  const deploy = await workflow("deploy-production");
  const step = deploy.jobs["report-ci-blocked-deploy"].steps[0];
  assert.deepEqual(step.env, {
    CI_CONCLUSION: "${{ github.event.workflow_run.conclusion }}",
    CI_SHA: "${{ github.event.workflow_run.head_sha }}",
    CI_RUN_URL: "${{ github.event.workflow_run.html_url }}"
  });
  const dir = await mkdtemp(join(tmpdir(), "ci-blocked-report-"));
  try {
    for (const conclusion of ["cancelled", "failure", "timed_out", "skipped", "neutral", "action_required", "stale"]) {
      const summary = join(dir, conclusion);
      const result = spawnSync("bash", ["-e", "-c", step.run], { encoding: "utf8", env: {
        ...process.env, CI_CONCLUSION: conclusion, CI_SHA: "fixture-sha", CI_RUN_URL: "https://github.com/example/actions/runs/123", GITHUB_STEP_SUMMARY: summary
      } });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /::error::Production deployment skipped/u);
      assert.ok(result.stdout.includes(conclusion));
      const text = await readFile(summary, "utf8");
      assert.ok(text.includes(conclusion));
      assert.match(text, /fixture-sha.*CI run.*runs\/123/u);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

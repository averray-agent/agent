import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PlatformService } from "./platform-service.js";
import { MemoryStateStore } from "./state-store.js";
import { buildJobSnapshot } from "./job-snapshot.js";
import { buildAverrayDisclosureRequirement } from "./maintainer-surface-policy.js";
import { toPlatformJob } from "../jobs/ingest-github-issues.js";
import { JobStaleSweeperService } from "../services/job-stale-sweeper.js";
import { sweepServedJobSpecHashes } from "../services/job-spec-hash-sweeper.js";
import { githubPrWorkerDefinition } from "./github-pr-worker-contract.js";

const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const issue = { title: "Add parser validation tests", body: "Add regression tests for the parser", number: 1,
  html_url: "https://github.com/owner/repo/issues/1", repository_url: "https://api.github.com/repos/owner/repo",
  labels: [{ name: "good first issue" }], state: "open", created_at: "2026-09-12T00:00:00Z" };
async function fixture(status = "submitted") {
  const store = new MemoryStateStore();
  const platform = new PlatformService([], new Map(), new Map(), new Map(), undefined, store);
  const input = toPlatformJob(issue);
  await platform.upsertIngestedJob(input);
  const job = platform.getJobDefinition(input.id);
  const session = await store.upsertSession({ sessionId: `${job.id}:${wallet}`, jobId: job.id, wallet, status,
    jobSnapshot: buildJobSnapshot(job), claimedAt: "2026-09-14T00:00:00Z", submittedAt: "2026-09-14T00:00:01Z" });
  return { store, platform, input, job, session };
}

test("claimed/submitted definitions survive ingest, stale sweeps, drift hiding and catalogue removal without enabling new claims", async () => {
  for (const status of ["claimed", "submitted"]) {
    const f = await fixture(status);
    const assertReadable = async () => {
      const definition = await f.platform.getPublicJobDefinition(f.job.id, { now: new Date("2026-09-14T00:00:02Z") });
      assert.equal(definition.definitionSource, "claim_snapshot");
      assert.equal(definition.claimState, status);
      assert.equal(definition.claimable, false);
      assert.equal(definition.title, f.job.title);
    };
    await f.platform.upsertIngestedJob(f.input);
    await assertReadable();
    // The spec-hash sweeper marks rows invisible; this is not upstream-closed
    // retirement. A claimed definition must remain readable even on drift.
    f.platform.blockchainGateway = { isEnabled: () => true, getJob: async () => ({ state: 2, specHash: `0x${"ab".repeat(32)}` }) };
    await sweepServedJobSpecHashes(f.platform, { guardMajority: false });
    assert.throws(() => f.platform.jobCatalogService.getPublicJobDefinition(f.job.id), { code: "job_not_found" });
    await assertReadable();
    assert.throws(() => f.platform.getClaimableJobDefinition(f.job.id), { code: "job_definition_chain_mismatch" });
    f.platform.blockchainGateway = undefined;
    for (const action of ["mark_stale", "pause", "archive"]) {
      await f.platform.updateJobLifecycle(f.job.id, { action });
      const sweeper = new JobStaleSweeperService(f.platform, f.store, undefined, { enabled: true, dryRun: false, action });
      await sweeper.runOnce();
      await assertReadable();
    }
    f.platform.jobCatalogService.removeJob(f.job.id);
    await assertReadable();
  }
});

test("definition, claim and validation hand the worker a bound footer; unlabelled or mismatched bodies are not submit-safe", async () => {
  const f = await fixture();
  const definition = await f.platform.getPublicJobDefinition(f.job.id);
  assert.equal(definition.disclosure.required, true);
  assert.match(definition.disclosure.canonicalFooter, /Claim session:/);
  f.platform.jobExecutionService.claimJob = async () => f.session;
  const claim = await f.platform.claimJob(wallet, f.job.id, "http", "key");
  assert.ok(claim.disclosureFooter.includes(`Agent identity: ${wallet}`));
  assert.ok(claim.disclosureFooter.includes(`Claim session:  ${f.session.sessionId}`));
  const submission = { prUrl: "https://github.com/owner/repo/pull/2", summary: "Added regression tests", tests: "npm test passed" };
  for (const prBody of [`Averray contribution by ${wallet}`, "Averray Wallet: 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]) {
    const result = await f.platform.validateJobSubmission(f.job.id, submission, { wallet, prBody });
    assert.equal(result.submitSafe, false);
    assert.equal(result.code, "disclosure_binding_missing");
    assert.ok(["missing", "mismatched"].includes(result.disclosure.status));
    assert.match(result.disclosure.hint, /This contribution was prepared by an autonomous agent operating on the/);
  }
  const good = await f.platform.validateJobSubmission(f.job.id, submission, { wallet, prBody: claim.disclosureFooter });
  assert.equal(good.submitSafe, true);
  assert.equal(good.disclosure.status, "matched");
  const unchecked = await f.platform.validateJobSubmission(f.job.id, submission);
  assert.equal(unchecked.disclosure.status, "not_checked");
  await f.store.upsertSession({ ...f.session, status: "rejected" });
  assert.equal((await f.platform.getPublicJobDefinition(f.job.id)).claimState, "rejected");
});

test("worker playbook contains the exact canonical footer, binding law and all review settlement facts", () => {
  const skill = readFileSync(new URL("../../../skills/averray-worker/SKILL.md", import.meta.url), "utf8");
  assert.ok(skill.includes(buildAverrayDisclosureRequirement().canonicalFooter));
  for (const pattern of [/exact labelled claimant wallet or claim session match/, /unlabelled address in prose does not bind/,
    /Submitting stops the claim clock/, /stake is never lost while a verdict is\s+pending/,
    /initially run by the operator/, /re-run automatically\s+when the PR merges or its checks change/,
    /SLA is 48 hours/, /status=blocked/, /external dependency/, /scored like any other submission/,
    /ambiguous results go to human review/, /github.com\/averray-agent\/agent\/issues/, /session id/]) assert.match(skill, pattern);
  const text = githubPrWorkerDefinition({ verifierMode: "github_pr" }).settlement.description;
  for (const phrase of ["Submitting stops the claim clock", "stake is never lost while a verdict is pending", "operator", "re-run", "48 hours", "status=blocked", "external dependency", "human review", "session id"]) assert.ok(text.includes(phrase), phrase);
});

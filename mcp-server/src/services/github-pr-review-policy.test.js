import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VerifierRegistry, summarizeGithubChecks } from "./verifier-handlers.js";
import { VerifierService } from "./verifier-service.js";
import { MemoryStateStore } from "../core/state-store.js";
import { buildJobSnapshot } from "../core/job-snapshot.js";
import { normalizeSubmission } from "../core/submission.js";

test("CI excludes deployment authorization, preserves real failures, and marks action_required unknown", () => {
  const summarize = (statuses, runs = []) => summarizeGithubChecks({ state: "failure", statuses }, { check_runs: runs });
  const deployment = { context: "Vercel", state: "failure", description: "Authorization required to deploy." };
  const excluded = summarize([deployment, { ...deployment, context: "Vercel – web" }]);
  assert.equal(excluded.ciStatus, "unknown");
  assert.equal(excluded.ciExclusions.length, 2);
  assert.deepEqual(excluded.ciExclusions[0], { context: "Vercel", description: deployment.description, reason: "deployment_authorization_required" });
  assert.equal(summarize([deployment], [{ name: "test", status: "completed", conclusion: "failure" }]).ciStatus, "failing");
  assert.equal(summarize([{ context: "unit-tests", state: "failure" }], [{ name: "lint", status: "completed", conclusion: "success" }]).ciStatus, "failing");
  const approval = summarize([], [{ name: "test", status: "completed", conclusion: "action_required" }]);
  assert.equal(approval.ciStatus, "unknown");
  assert.equal(approval.pendingMaintainerApproval, true);
  assert.equal(approval.ciExclusions[0].reason, "pending_maintainer_approval");
  for (const context of ["Vercel", "Netlify", "Render", "Cloudflare Pages"]) {
    assert.equal(summarize([{ context, state: "failure", description: "Deployment blocked" }]).ciStatus, "unknown");
  }
  for (const name of ["cla", "DCO", "license check"]) {
    const policy = summarize([], [{ name, status: "completed", conclusion: "failure" }]);
    assert.equal(policy.ciStatus, "unknown");
    assert.deepEqual(policy.policyGates, [{ name, conclusion: "failure" }]);
  }
});

test("five real queued disclosures bind; a failing CLA goes to human review, never rejection or automatic payout", async () => {
  const { fixtures } = JSON.parse(readFileSync(new URL("../core/__fixtures__/github-pr-disclosures.json", import.meta.url), "utf8"));
  for (const fixture of fixtures.slice(0, 5)) {
    const repo = new URL(fixture.source).pathname.split("/").slice(1, 3).join("/");
    const issueNumber = Number(fixture.jobId.match(/-(\d+)$/u)[1]);
    const isCla = fixture.jobId.includes("anythingmcp");
    const isVercel = fixture.jobId.includes("paygate") || fixture.jobId.includes("guallet");
    const job = { id: fixture.jobId, category: "coding", verifierMode: "github_pr",
      source: { type: "github_issue", repo, issueNumber, maintainerPolicy: { disclosureRequired: true } },
      verifierConfig: { handler: "github_pr", version: 1, minimumScore: 80, requireClaimantBinding: true } };
    const registry = new VerifierRegistry({ githubToken: "fixture-token", fetchImpl: async (url) => {
      let result;
      if (url.endsWith("/status")) result = { state: isVercel ? "failure" : "pending", statuses: isVercel
        ? ["Vercel", "Vercel – app"].map((context) => ({ context, description: "Authorization required to deploy.", state: "failure" })) : [] };
      else if (url.endsWith("/check-runs")) result = { check_runs: isCla ? [
        { name: "cla", status: "completed", conclusion: "failure" },
        { name: "welcome", status: "completed", conclusion: "success" },
        { name: "triage", status: "completed", conclusion: "skipped" }
      ] : [] };
      else if (url.endsWith("/reviews")) result = [];
      else result = { title: "Fix #" + issueNumber, body: "Closes #" + issueNumber + "\n\n" + fixture.body,
        state: "open", merged: false, head: { sha: fixture.headSha }, html_url: fixture.source };
      return Response.json(result);
    } });
    const verdict = await registry.evaluate(job, normalizeSubmission({
      prUrl: fixture.source, summary: "Addresses the issue.", tests: "Local tests passed."
    }), fixture);
    assert.equal(verdict.githubLookup.claimantBinding.status, "matched", fixture.source);
    assert.equal(verdict.outcome, isCla ? "disputed" : "approved", fixture.source);
    assert.ok(!verdict.blockers.some((blocker) => /disclosure|claimant/iu.test(blocker)));
    assert.ok(verdict.disclosure.matchedBy.length > 0);
    if (isCla) {
      assert.equal(verdict.handler, "human_fallback");
      assert.match(verdict.detail, /cla/u);
      assert.deepEqual(verdict.policyGates, [{ name: "cla", conclusion: "failure" }]);
    }
    if (isVercel) assert.equal(verdict.ciExclusions.length, 2);
  }
});

test("preview evaluates the same handler from a rejected session snapshot without any persistence, gateway call or event", async () => {
  const store = new MemoryStateStore();
  const job = { id: "preview-job", verifierMode: "deterministic",
    verifierConfig: { handler: "deterministic", version: 1, expectedOutputs: ["evidence"], matchMode: "contains_all" } };
  const session = { sessionId: "preview-session", jobId: job.id, wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    status: "rejected", submission: "evidence", jobSnapshot: buildJobSnapshot(job) };
  const original = { outcome: "rejected", reasonCode: "OLD_VERDICT" };
  await store.upsertSession(session);
  await store.upsertVerificationResult(session.sessionId, original);
  const before = await store.getSession(session.sessionId);
  const writes = [];
  for (const name of ["upsertSession", "upsertVerificationResult", "upsertMutationReceipt"]) {
    store[name] = async () => { writes.push(name); throw new Error("preview wrote state"); };
  }
  const calls = [];
  const gateway = new Proxy({}, { get: (_target, name) => () => { calls.push(name); throw new Error("preview touched gateway"); } });
  const registry = new VerifierRegistry();
  const service = new VerifierService({ eventBus: { publish: () => { throw new Error("preview published"); } },
    resumeSession: () => { throw new Error("preview resumed/progressed"); },
    getJobDefinition: () => { throw new Error("catalogue row is absent"); },
    ingestVerification: () => { throw new Error("preview ingested"); }
  }, store, gateway, registry);
  const expected = await registry.evaluate(job, session.submission, { claimantWallet: session.wallet, claimSessionId: session.sessionId });
  assert.deepEqual(await service.verifySubmission({ sessionId: session.sessionId, preview: true }), {
    ...expected, sessionId: session.sessionId, preview: true
  });
  assert.deepEqual(await service.getResult(session.sessionId), original);
  assert.deepEqual(await store.getSession(session.sessionId), before);
  assert.deepEqual(writes, []);
  assert.deepEqual(calls, []);
});

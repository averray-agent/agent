import test from "node:test";
import assert from "node:assert/strict";

import { VerifierService } from "./verifier-service.js";
import { VerifierRegistry } from "./verifier-handlers.js";
import { MemoryStateStore } from "../core/state-store.js";
import { transitionSession } from "../core/session-state-machine.js";
import { normalizeSubmission } from "../core/submission.js";
import { buildAverrayDisclosureFooter } from "../core/maintainer-surface-policy.js";

const SESSION_ID = "release-readiness-check-001:0xabc";

test("verifySubmission persists verification input and supports replay", async () => {
  const stateStore = new MemoryStateStore();
  const session = transitionSession({
    sessionId: SESSION_ID,
    wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    jobId: "release-readiness-check-001",
    submission: normalizeSubmission({
      release_id: "release-2026-04-19",
      checks_passed: ["api-health", "indexer-health"],
      checks_failed: [],
      blockers: [],
      go_no_go: "go"
    })
  }, "claimed", { reason: "job_claimed" });

  const submitted = transitionSession(session, "submitted", { reason: "work_submitted" });
  await stateStore.upsertSession(submitted);

  const job = {
    id: "release-readiness-check-001",
    verifierMode: "deterministic",
    verifierConfig: {
      version: 1,
      handler: "deterministic",
      expectedOutputs: ["release_id", "checks_passed", "go_no_go"],
      matchMode: "contains_all"
    }
  };

  const platformService = {
    resumeSession: (sessionId) => stateStore.getSession(sessionId),
    getJobDefinition: () => job,
    ingestVerification: async (sessionId, verdict) => {
      const current = await stateStore.getSession(sessionId);
      const updated = transitionSession(current, verdict.outcome === "approved" ? "resolved" : "rejected", {
        reason: "verification_resolved"
      });
      await stateStore.upsertSession(updated);
      return updated;
    }
  };

  const service = new VerifierService(platformService, stateStore);
  const result = await service.verifySubmission({ sessionId: SESSION_ID });

  assert.equal(result.outcome, "approved");
  assert.equal(result.handlerVersion, 1);
  assert.equal(result.verifierConfigVersion, 1);
  assert.deepEqual(result.verifierConfigSnapshot, job.verifierConfig);
  assert.equal(result.verificationContract.version, "verification-contract-v1");
  assert.equal(result.verificationContract.handler, "deterministic");
  assert.equal(result.verificationContract.handlerVersion, 1);
  assert.equal(typeof result.verifierConfigHash, "string");
  assert.equal(typeof result.verificationInputHash, "string");
  assert.equal(result.verificationInput.kind, "structured");

  job.verifierConfig = {
    ...job.verifierConfig,
    expectedOutputs: ["this live config would fail the original submission"]
  };

  const replay = await service.replayVerification(SESSION_ID);
  assert.equal(replay.replay, true);
  assert.equal(replay.outcome, "approved");
  assert.equal(replay.originalOutcome, "approved");
  assert.equal(replay.verifierConfigHash, result.verifierConfigHash);
  assert.deepEqual(replay.verifierConfigSnapshot.expectedOutputs, ["release_id", "checks_passed", "go_no_go"]);
});

test("verifySubmission rejects non-verifiable sessions before handler or chain side effects", async () => {
  const stateStore = new MemoryStateStore();
  const claimed = transitionSession({
    sessionId: SESSION_ID,
    wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    jobId: "release-readiness-check-001"
  }, "claimed", { reason: "job_claimed" });
  await stateStore.upsertSession(claimed);

  let evaluated = false;
  let resolvedOnChain = false;
  const service = new VerifierService(
    {
      resumeSession: (sessionId) => stateStore.getSession(sessionId),
      getJobDefinition: () => {
        throw new Error("job definition should not be needed before transition guard");
      },
      ingestVerification: () => {
        throw new Error("verification should not ingest before transition guard");
      }
    },
    stateStore,
    {
      isEnabled: () => true,
      resolveSinglePayout: async () => {
        resolvedOnChain = true;
      }
    },
    {
      evaluate: async () => {
        evaluated = true;
        return { outcome: "approved" };
      },
      listHandlers: () => []
    }
  );

  await assert.rejects(
    () => service.verifySubmission({ sessionId: SESSION_ID }),
    (error) => {
      assert.equal(error.code, "invalid_session_transition");
      assert.equal(error.details.currentStatus, "claimed");
      assert.equal(error.details.nextStatus, "resolved|rejected|disputed");
      return true;
    }
  );
  assert.equal(evaluated, false);
  assert.equal(resolvedOnChain, false);
});

test("github_pr verifier scores structured PR evidence and exposes reputation signals", async () => {
  const registry = new VerifierRegistry();
  const job = {
    id: "oss-example-project-42-add-tests",
    category: "testing",
    source: {
      type: "github_issue",
      repo: "example/project",
      issueNumber: 42,
      issueUrl: "https://github.com/example/project/issues/42"
    },
    verifierConfig: {
      version: 1,
      handler: "github_pr",
      minimumScore: 60,
      requireIssueReference: true,
      requireTestEvidence: true
    }
  };

  const verdict = await registry.evaluate(job, normalizeSubmission({
    prUrl: "https://github.com/example/project/pull/77",
    summary: "Adds regression coverage and fixes parser validation for #42.",
    tests: "npm test passed",
    issueNumber: 42,
    checksPassing: true
  }));

  assert.equal(verdict.outcome, "approved");
  assert.equal(verdict.handler, "github_pr");
  assert.equal(verdict.evidence.repo, "example/project");
  assert.equal(verdict.evidence.pullNumber, 77);
  assert.equal(verdict.checks.repoMatches, true);
  assert.equal(verdict.signals.prOpened, true);
  assert.equal(verdict.reputationSignals.checksPassed, 1);
});

test("github_pr verifier rejects PR evidence for the wrong repo", async () => {
  const registry = new VerifierRegistry();
  const job = {
    id: "oss-example-project-42-add-tests",
    category: "testing",
    source: {
      type: "github_issue",
      repo: "example/project",
      issueNumber: 42
    },
    verifierConfig: {
      version: 1,
      handler: "github_pr",
      minimumScore: 60,
      requireIssueReference: true,
      requireTestEvidence: true
    }
  };

  const verdict = await registry.evaluate(job, normalizeSubmission({
    prUrl: "https://github.com/other/project/pull/77",
    summary: "Fixes #42.",
    tests: "npm test passed",
    issueNumber: 42
  }));

  assert.equal(verdict.outcome, "rejected");
  assert.equal(verdict.checks.repoMatches, false);
  assert.equal(verdict.signals.prOpened, false);
});

test("github_pr verifier enriches PR evidence from GitHub when token is configured", async () => {
  const calls = [];
  const registry = new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith("/pulls/77")) {
        return jsonResponse({
          html_url: "https://github.com/example/project/pull/77",
          title: "Fix parser validation",
          body: "Closes #42",
          state: "open",
          merged: false,
          head: { sha: "abc123" }
        });
      }
      if (url.endsWith("/commits/abc123/status")) {
        return jsonResponse({ state: "success" });
      }
      if (url.endsWith("/commits/abc123/check-runs")) {
        return jsonResponse({
          check_runs: [
            { status: "completed", conclusion: "success" }
          ]
        });
      }
      if (url.endsWith("/pulls/77/reviews")) {
        return jsonResponse([
          { state: "APPROVED", user: { login: "maintainer" } }
        ]);
      }
      return { ok: false, status: 404, async json() { return {}; } };
    }
  });
  const job = {
    id: "oss-example-project-42-add-tests",
    category: "testing",
    source: {
      type: "github_issue",
      repo: "example/project",
      issueNumber: 42
    },
    verifierConfig: {
      version: 1,
      handler: "github_pr",
      minimumScore: 60,
      requireIssueReference: true,
      requireTestEvidence: true
    }
  };

  const verdict = await registry.evaluate(job, normalizeSubmission({
    prUrl: "https://github.com/example/project/pull/77",
    summary: "Opened the PR."
  }));

  assert.equal(verdict.outcome, "approved");
  assert.equal(verdict.githubLookup.status, "verified");
  assert.equal(verdict.checks.issueReferenced, true);
  assert.equal(verdict.checks.checksPassing, true);
  assert.equal(verdict.checks.reviewApproved, true);
  assert.equal(verdict.reputationSignals.maintainerApproved, 1);
  assert.ok(calls.some((url) => url.endsWith("/commits/abc123/check-runs")));
});

test("github_pr verifier rejects observable PR bodies missing required disclosure footer", async () => {
  const registry = new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: async (url) => {
      if (url.endsWith("/pulls/77")) {
        return jsonResponse({
          html_url: "https://github.com/example/project/pull/77",
          title: "Fix parser validation",
          body: "Closes #42",
          state: "open",
          merged: false,
          head: { sha: "abc123" }
        });
      }
      if (url.endsWith("/commits/abc123/status")) return jsonResponse({ state: "success" });
      if (url.endsWith("/commits/abc123/check-runs")) return jsonResponse({ check_runs: [] });
      if (url.endsWith("/pulls/77/reviews")) return jsonResponse([]);
      return { ok: false, status: 404, async json() { return {}; } };
    }
  });
  const job = {
    id: "oss-example-project-42-add-tests",
    category: "testing",
    source: {
      type: "github_issue",
      repo: "example/project",
      issueNumber: 42,
      maintainerPolicy: { disclosureRequired: true }
    },
    verifierConfig: {
      version: 1,
      handler: "github_pr",
      minimumScore: 60,
      requireIssueReference: true,
      requireTestEvidence: false
    }
  };

  const verdict = await registry.evaluate(job, normalizeSubmission({
    prUrl: "https://github.com/example/project/pull/77",
    summary: "Opened the PR."
  }));

  assert.equal(verdict.outcome, "rejected");
  assert.equal(verdict.checks.disclosureFooterPresent, false);
});

test("github_pr verifier accepts required disclosure footer when observed", async () => {
  const registry = new VerifierRegistry();
  const job = {
    id: "oss-example-project-42-add-tests",
    category: "testing",
    source: {
      type: "github_issue",
      repo: "example/project",
      issueNumber: 42,
      maintainerPolicy: { disclosureRequired: true }
    },
    verifierConfig: {
      version: 1,
      handler: "github_pr",
      minimumScore: 60,
      requireIssueReference: true,
      requireTestEvidence: true
    }
  };

  const verdict = await registry.evaluate(job, normalizeSubmission({
    prUrl: "https://github.com/example/project/pull/77",
    summary: "Adds regression coverage for #42.",
    tests: "npm test passed",
    issueNumber: 42,
    prBody: `Closes #42\n\n${buildAverrayDisclosureFooter()}`
  }));

  assert.equal(verdict.outcome, "approved");
  assert.equal(verdict.checks.disclosureFooterPresent, true);
});

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload;
    }
  };
}

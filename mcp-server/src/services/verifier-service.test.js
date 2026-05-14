import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VerifierService } from "./verifier-service.js";
import { VerifierRegistry } from "./verifier-handlers.js";
import { MemoryStateStore } from "../core/state-store.js";
import { transitionSession } from "../core/session-state-machine.js";
import { normalizeSubmission } from "../core/submission.js";
import { buildAverrayDisclosureFooter } from "../core/maintainer-surface-policy.js";
import { buildVerificationContract } from "../core/verifier-contract.js";

const FIXTURE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "verifier-replay"
);

function loadFixturesForHandler(handlerId) {
  const handlerDir = path.join(FIXTURE_ROOT, handlerId);
  const versions = readdirSync(handlerDir).filter((entry) => /^v\d+$/u.test(entry));
  const fixtures = [];
  for (const version of versions) {
    const versionDir = path.join(handlerDir, version);
    for (const file of readdirSync(versionDir).filter((name) => name.endsWith(".json"))) {
      const fixture = JSON.parse(readFileSync(path.join(versionDir, file), "utf8"));
      fixtures.push({ name: `${handlerId}/${version}/${file}`, version, fixture });
    }
  }
  return fixtures;
}

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
    outputSchemaRef: "schema://jobs/release-readiness-output",
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

test("verifySubmission validates built-in schema-native input before handler or chain side effects", async () => {
  const stateStore = new MemoryStateStore();
  const session = transitionSession({
    sessionId: SESSION_ID,
    wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    jobId: "release-readiness-check-001",
    submission: normalizeSubmission("complete")
  }, "claimed", { reason: "job_claimed" });
  await stateStore.upsertSession(transitionSession(session, "submitted", { reason: "work_submitted" }));

  let evaluated = false;
  let resolvedOnChain = false;
  const service = new VerifierService(
    {
      resumeSession: (sessionId) => stateStore.getSession(sessionId),
      getJobDefinition: () => ({
        id: "release-readiness-check-001",
        outputSchemaRef: "schema://jobs/release-readiness-output",
        verifierConfig: {
          version: 1,
          handler: "deterministic",
          expectedOutputs: ["release_id"],
          matchMode: "contains_all"
        }
      }),
      ingestVerification: () => {
        throw new Error("verification should not ingest before schema validation passes");
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
      assert.equal(error.code, "invalid_request");
      assert.match(error.message, /Schema-native jobs require/u);
      assert.equal(error.details.schemaValidates, "payload.submission");
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

test("verification contract carries evidenceSchemaRef and lists it in snapshot fields", () => {
  const job = {
    id: "release-readiness-check-001",
    outputSchemaRef: "schema://jobs/release-readiness-output",
    verifierMode: "deterministic",
    verifierConfig: {
      version: 1,
      handler: "deterministic",
      expectedOutputs: ["release_id"],
      matchMode: "contains_all"
    }
  };

  const contract = buildVerificationContract(job, { verdict: { handlerVersion: 1 } });
  assert.equal(contract.evidenceSchemaRef, "schema://jobs/release-readiness-output");
  assert.ok(contract.snapshotFields.includes("evidenceSchemaRef"));
});

test("verification contract prefers job.verification.evidenceSchemaRef when both are set", () => {
  const job = {
    outputSchemaRef: "schema://jobs/release-readiness-output",
    verification: { evidenceSchemaRef: "schema://jobs/github-pr-evidence-output" },
    verifierConfig: { version: 1, handler: "benchmark", requiredKeywords: [], minimumMatches: 0 }
  };
  const contract = buildVerificationContract(job, {});
  assert.equal(contract.evidenceSchemaRef, "schema://jobs/github-pr-evidence-output");
});

for (const handlerId of ["benchmark", "deterministic", "github_pr"]) {
  for (const { name, version, fixture } of loadFixturesForHandler(handlerId)) {
    test(`handler-versioned replay fixture remains stable under current handler: ${name}`, async () => {
      // Force the github_pr handler down its tokenless path so replay does not depend on a live GitHub fetch.
      const registry = new VerifierRegistry({ githubToken: "" });
      const verdict = await registry.evaluate(fixture.job, fixture.verificationInput);
      assert.equal(verdict.handler, fixture.handler);
      assert.equal(
        verdict.handlerVersion,
        fixture.handlerVersion,
        `live handler version drifted from fixture ${name} (captured under ${version}); update fixture or surface a drift signal`
      );
      assert.equal(verdict.outcome, fixture.expected.outcome);
      assert.equal(verdict.reasonCode, fixture.expected.reasonCode);
      if (typeof fixture.expected.score === "number") {
        assert.equal(verdict.score, fixture.expected.score);
      }
      if (typeof fixture.expected.minimumScore === "number") {
        assert.ok(
          verdict.score >= fixture.expected.minimumScore,
          `expected score ${verdict.score} >= ${fixture.expected.minimumScore}`
        );
      }
      if (fixture.expected.checks) {
        for (const [check, expected] of Object.entries(fixture.expected.checks)) {
          assert.equal(verdict.checks?.[check], expected, `check ${check}`);
        }
      }
    });
  }
}

test("replayVerification reads stored verifier config snapshot when live job config drifts (benchmark)", async () => {
  const sessionId = "benchmark-narrative-001:0xaaa";
  const { fixture } = loadFixturesForHandler("benchmark")[0];
  const stateStore = new MemoryStateStore();

  const claimed = transitionSession(
    {
      sessionId,
      wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      jobId: fixture.job.id,
      submission: normalizeSubmission(fixture.verificationInput)
    },
    "claimed",
    { reason: "job_claimed" }
  );
  await stateStore.upsertSession(transitionSession(claimed, "submitted", { reason: "work_submitted" }));

  const liveJob = {
    ...fixture.job,
    verifierConfig: {
      ...fixture.job.verifierConfig,
      requiredKeywords: ["zeta", "omega", "delta", "epsilon"],
      minimumMatches: 4
    }
  };

  const platformService = {
    resumeSession: (id) => stateStore.getSession(id),
    getJobDefinition: () => liveJob,
    ingestVerification: async (id, verdict) => {
      const current = await stateStore.getSession(id);
      const updated = transitionSession(current, verdict.outcome === "approved" ? "resolved" : "rejected", {
        reason: "verification_resolved"
      });
      return stateStore.upsertSession(updated);
    }
  };

  const service = new VerifierService(platformService, stateStore);
  // Persist the original verification under the fixture's snapshot so replay has a snapshot to read.
  const original = await service.verifySubmission({ sessionId });
  assert.equal(original.outcome, "rejected"); // live config rejects; snapshot will approve.

  // Now seed the persisted result with the fixture snapshot, simulating an earlier
  // verification captured before the live config drift.
  await stateStore.upsertVerificationResult(sessionId, {
    ...original,
    outcome: fixture.expected.outcome,
    reasonCode: fixture.expected.reasonCode,
    handler: fixture.handler,
    handlerVersion: fixture.handlerVersion,
    verifierConfigSnapshot: fixture.job.verifierConfig,
    verifierConfigHash: original.verifierConfigHash,
    verificationInput: original.verificationInput,
    evidenceSchemaRef: fixture.evidenceSchemaRef
  });
  // Force the stored snapshot to be the fixture's snapshot, which differs from live.
  const stored = await stateStore.getVerificationResult(sessionId);
  stored.verifierConfigSnapshot = fixture.job.verifierConfig;
  await stateStore.upsertVerificationResult(sessionId, stored);

  const replay = await service.replayVerification(sessionId);
  assert.equal(replay.replay, true);
  assert.equal(replay.outcome, fixture.expected.outcome);
  assert.deepEqual(replay.verifierConfigSnapshot, fixture.job.verifierConfig);
  assert.equal(replay.handler, fixture.handler);
  assert.equal(replay.handlerVersion, fixture.handlerVersion);
  assert.equal(replay.evidenceSchemaRef, fixture.evidenceSchemaRef);
});

test("replayVerification surfaces handler version drift instead of silently re-running", async () => {
  const sessionId = "deterministic-drift-001:0xbbb";
  const { fixture } = loadFixturesForHandler("deterministic")[0];
  const stateStore = new MemoryStateStore();

  await stateStore.upsertSession(
    transitionSession(
      transitionSession(
        {
          sessionId,
          wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          jobId: fixture.job.id,
          submission: normalizeSubmission(fixture.verificationInput.structured)
        },
        "claimed",
        { reason: "job_claimed" }
      ),
      "submitted",
      { reason: "work_submitted" }
    )
  );

  const platformService = {
    resumeSession: (id) => stateStore.getSession(id),
    getJobDefinition: () => fixture.job
  };

  // Persist a verification result captured at a stale handler version. Replay
  // re-runs the live handler (v1) and must surface the version mismatch so a
  // future v2 doesn't silently overwrite the v1 reasoning of record.
  await stateStore.upsertVerificationResult(sessionId, {
    sessionId,
    outcome: fixture.expected.outcome,
    reasonCode: fixture.expected.reasonCode,
    handler: fixture.handler,
    handlerVersion: 99,
    verifierConfigSnapshot: fixture.job.verifierConfig,
    verifierConfigHash: "stale-hash-from-prior-snapshot",
    verificationInput: normalizeSubmission(fixture.verificationInput.structured),
    evidenceSchemaRef: fixture.evidenceSchemaRef
  });

  const service = new VerifierService(platformService, stateStore);
  const replay = await service.replayVerification(sessionId);

  assert.ok(replay.replayDrift, "expected replayDrift to be set when captured handler version differs from live");
  assert.deepEqual(replay.replayDrift.handlerVersion, { captured: 99, live: 1 });
  // Snapshot-hash drift exposes snapshot tampering; here it is forced by the stale stored hash.
  assert.equal(replay.replayDrift.verifierConfigHash.captured, "stale-hash-from-prior-snapshot");
});

test("replayVerification does not flag drift when captured handler version matches live", async () => {
  const sessionId = "deterministic-stable-001:0xccc";
  const { fixture } = loadFixturesForHandler("deterministic")[0];
  const stateStore = new MemoryStateStore();

  const submitted = transitionSession(
    transitionSession(
      {
        sessionId,
        wallet: "0xcccccccccccccccccccccccccccccccccccccccc",
        jobId: fixture.job.id,
        submission: normalizeSubmission(fixture.verificationInput.structured)
      },
      "claimed",
      { reason: "job_claimed" }
    ),
    "submitted",
    { reason: "work_submitted" }
  );
  await stateStore.upsertSession(submitted);

  const platformService = {
    resumeSession: (id) => stateStore.getSession(id),
    getJobDefinition: () => fixture.job,
    ingestVerification: async (id, verdict) => {
      const current = await stateStore.getSession(id);
      const updated = transitionSession(current, verdict.outcome === "approved" ? "resolved" : "rejected", {
        reason: "verification_resolved"
      });
      return stateStore.upsertSession(updated);
    }
  };

  const service = new VerifierService(platformService, stateStore);
  await service.verifySubmission({ sessionId });
  const replay = await service.replayVerification(sessionId);

  assert.equal(replay.replayDrift, undefined);
  assert.equal(replay.handlerVersion, fixture.handlerVersion);
});

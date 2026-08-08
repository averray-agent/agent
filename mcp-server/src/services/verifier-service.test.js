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

function listFixtureHandlerIds() {
  return readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function fixtureVersionsForHandler(handlerId) {
  const handlerDir = path.join(FIXTURE_ROOT, handlerId);
  return readdirSync(handlerDir)
    .filter((entry) => /^v\d+$/u.test(entry))
    .sort();
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
    ingestVerification: async (sessionId, verdict, { payoutTx } = {}) => {
      const current = await stateStore.getSession(sessionId);
      const updated = transitionSession({
        ...current,
        ...(payoutTx ? { payoutTx } : {})
      }, verdict.outcome === "approved" ? "resolved" : "rejected", {
        reason: "verification_resolved"
      });
      await stateStore.upsertSession(updated);
      await stateStore.upsertVerificationResult(sessionId, { ...verdict, session: updated });
      return updated;
    }
  };

  const service = new VerifierService(platformService, stateStore);
  const result = await service.verifySubmission({ sessionId: SESSION_ID });

  assert.equal(result.outcome, "approved");
  assert.equal(result.handlerVersion, 1);
  assert.equal(result.verifierPolicyVersion, 1);
  assert.equal(result.verifierConfigVersion, 1);
  assert.deepEqual(result.verifierConfigSnapshot, job.verifierConfig);
  assert.equal(result.verificationContract.version, "verification-contract-v1");
  assert.equal(result.verificationContract.handler, "deterministic");
  assert.equal(result.verificationContract.handlerVersion, 1);
  assert.equal(result.verificationContract.verifierPolicyVersion, 1);
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

test("verifySubmission passes the actual claimant wallet and claim session to the verifier", async () => {
  const stateStore = new MemoryStateStore();
  const claimantWallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const submitted = transitionSession({
    sessionId: "external-pr-session-1",
    wallet: claimantWallet,
    jobId: "external-pr-job-1",
    submission: normalizeSubmission({
      prUrl: "https://github.com/example/project/pull/77",
      summary: "Fixes #42.",
      tests: "npm test passed"
    })
  }, "claimed", { reason: "job_claimed" });
  await stateStore.upsertSession(transitionSession(submitted, "submitted", { reason: "work_submitted" }));

  let receivedContext;
  const platformService = {
    resumeSession: (sessionId) => stateStore.getSession(sessionId),
    getJobDefinition: () => ({
      id: "external-pr-job-1",
      verifierMode: "github_pr",
      verifierConfig: { version: 1, handler: "github_pr", requireClaimantBinding: true }
    }),
    ingestVerification: async (sessionId) => stateStore.getSession(sessionId)
  };
  const service = new VerifierService(platformService, stateStore, undefined, {
    async evaluate(_job, _evidence, context) {
      receivedContext = context;
      return {
        handler: "github_pr",
        handlerVersion: 1,
        outcome: "rejected",
        reasonCode: "GITHUB_PR_EVIDENCE_INCOMPLETE"
      };
    },
    listHandlers: () => ["github_pr"]
  });

  await service.verifySubmission({ sessionId: "external-pr-session-1" });

  assert.deepEqual(receivedContext, {
    claimantWallet,
    claimSessionId: "external-pr-session-1"
  });
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
  const registry = new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: liveGithubPrFetch()
  });
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

test("github_pr lookup failures escalate to human review rather than approving submitted claims", async () => {
  const job = {
    id: "external-example-project-42",
    category: "coding",
    source: {
      type: "external",
      declared: {
        type: "github_issue",
        repo: "example/project",
        issueNumber: 42,
        issueUrl: "https://github.com/example/project/issues/42"
      }
    },
    verifierConfig: {
      version: 1,
      handler: "github_pr",
      minimumScore: 60,
      requireIssueReference: true,
      requireTestEvidence: true
    }
  };

  const evidence = normalizeSubmission({
    prUrl: "https://github.com/example/project/pull/77",
    summary: "Claims to fix #42.",
    tests: "npm test passed",
    issueNumber: 42,
    checksPassing: true,
    merged: true
  });
  const cases = [
    {
      name: "credentials unavailable",
      githubToken: "",
      fetchImpl: liveGithubPrFetch()
    },
    {
      name: "rate limited",
      fetchImpl: async () => ({ ok: false, status: 429, async json() { return {}; } })
    },
    {
      name: "private or inaccessible repository",
      fetchImpl: async () => ({ ok: false, status: 404, async json() { return {}; } })
    },
    {
      name: "network unavailable",
      fetchImpl: async () => { throw new Error("network_down"); }
    },
    {
      name: "partially unreadable",
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
        throw new Error("secondary_lookup_failed");
      }
    }
  ];

  for (const scenario of cases) {
    const verdict = await new VerifierRegistry({
      githubToken: scenario.githubToken ?? "github_pat_test",
      fetchImpl: scenario.fetchImpl
    }).evaluate(job, evidence);

    assert.equal(verdict.outcome, "disputed", scenario.name);
    assert.equal(verdict.handler, "human_fallback", scenario.name);
    assert.equal(verdict.escalatedFrom, "github_pr", scenario.name);
    assert.equal(verdict.reasonCode, "HUMAN_REVIEW_REQUIRED", scenario.name);
    assert.match(verdict.detail, /not auto-approved/iu, scenario.name);
  }
});

test("github_pr ambiguous live score escalates to human review", async () => {
  const registry = new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: liveGithubPrFetch()
  });
  const verdict = await registry.evaluate({
    id: "external-example-project-42",
    category: "coding",
    source: {
      type: "external",
      declared: {
        type: "github_issue",
        repo: "example/project",
        issueNumber: 42,
        issueUrl: "https://github.com/example/project/issues/42"
      }
    },
    verifierConfig: {
      version: 1,
      handler: "github_pr",
      minimumScore: 100,
      requireIssueReference: true,
      requireTestEvidence: true
    }
  }, normalizeSubmission({
    prUrl: "https://github.com/example/project/pull/77",
    summary: "Fixes #42.",
    tests: "npm test passed"
  }));

  assert.equal(verdict.githubLookup.status, "verified");
  assert.equal(verdict.outcome, "disputed");
  assert.equal(verdict.handler, "human_fallback");
  assert.match(verdict.detail, /github_score_ambiguous/u);
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
  const registry = new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: liveGithubPrFetch({
      body: `Closes #42\n\n${buildAverrayDisclosureFooter()}`
    })
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

test("github_pr wizard gate accepts a live PR body bound to the actual claimant", async () => {
  const claimantWallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const registry = new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: liveGithubPrFetch({
      body: `Closes #42\n\n${buildAverrayDisclosureFooter({ agentWallet: claimantWallet })}`
    })
  });
  const verdict = await registry.evaluate(githubPrWizardJob(), normalizeSubmission({
    prUrl: "https://github.com/example/project/pull/77",
    summary: "Adds regression coverage for #42.",
    tests: "npm test passed"
  }), { claimantWallet, claimSessionId: "external-pr-session-1" });

  assert.equal(verdict.outcome, "approved");
  assert.equal(verdict.checks.claimantBinding, true);
  assert.equal(verdict.githubLookup.claimantBinding.status, "matched");
});

test("github_pr wizard gate rejects a claimant submitting someone else's merged PR", async () => {
  const claimantWallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const otherWorker = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const registry = new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: liveGithubPrFetch({
      body: `Closes #42\n\n${buildAverrayDisclosureFooter({ agentWallet: otherWorker })}`,
      merged: true
    })
  });
  const verdict = await registry.evaluate(githubPrWizardJob(), normalizeSubmission({
    prUrl: "https://github.com/example/project/pull/77",
    summary: "Submits an already merged PR for #42.",
    tests: "npm test passed"
  }), { claimantWallet, claimSessionId: "external-pr-session-claimant" });

  assert.equal(verdict.githubLookup.merged, true);
  assert.equal(verdict.githubLookup.claimantBinding.status, "mismatched");
  assert.equal(verdict.checks.claimantBinding, false);
  assert.equal(verdict.outcome, "rejected");
  assert.match(verdict.detail, /claimant must match the actual claimant/iu);
});

test("github_pr wizard gate rejects a claimant line outside the Averray disclosure footer", async () => {
  const claimantWallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const registry = new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: liveGithubPrFetch({
      body: `Closes #42\n\nAgent identity: ${claimantWallet}`,
      merged: true
    })
  });
  const verdict = await registry.evaluate(githubPrWizardJob(), normalizeSubmission({
    prUrl: "https://github.com/example/project/pull/77",
    summary: "Submits a merged PR for #42.",
    tests: "npm test passed"
  }), { claimantWallet, claimSessionId: "external-pr-session-claimant" });

  assert.equal(verdict.githubLookup.claimantBinding.status, "missing");
  assert.equal(verdict.githubLookup.claimantBinding.footerPresent, false);
  assert.equal(verdict.outcome, "rejected");
  assert.match(verdict.detail, /disclosure must identify the actual claimant/iu);
});

test("github_pr wizard gate escalates an unreadable live PR body to human review", async () => {
  const claimantWallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const registry = new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: liveGithubPrFetch({ bodyReadable: false })
  });
  const verdict = await registry.evaluate(githubPrWizardJob(), normalizeSubmission({
    prUrl: "https://github.com/example/project/pull/77",
    summary: "Adds regression coverage for #42.",
    tests: "npm test passed"
  }), { claimantWallet, claimSessionId: "external-pr-session-1" });

  assert.equal(verdict.outcome, "disputed");
  assert.equal(verdict.handler, "human_fallback");
  assert.equal(verdict.escalatedFrom, "github_pr");
  assert.equal(verdict.githubLookup.prBodyReadable, false);
  assert.equal(verdict.githubLookup.claimantBinding.status, "unavailable");
});

function githubPrWizardJob() {
  return {
    id: "external-example-project-42",
    category: "coding",
    source: {
      type: "external",
      declared: {
        type: "github_issue",
        repo: "example/project",
        issueNumber: 42,
        issueUrl: "https://github.com/example/project/issues/42"
      }
    },
    verifierConfig: {
      version: 1,
      handler: "github_pr",
      minimumScore: 60,
      requireIssueReference: true,
      requireTestEvidence: true,
      acceptMergedAsApproved: true,
      requireClaimantBinding: true
    }
  };
}

function liveGithubPrFetch({ body = "Closes #42", bodyReadable = true, merged = false } = {}) {
  return async (url) => {
    if (url.endsWith("/pulls/77")) {
      const pullRequest = {
        html_url: "https://github.com/example/project/pull/77",
        title: "Fix parser validation for #42",
        state: "open",
        merged,
        head: { sha: "abc123" }
      };
      if (bodyReadable) pullRequest.body = body;
      return jsonResponse(pullRequest);
    }
    if (url.endsWith("/commits/abc123/status")) {
      return jsonResponse({ state: "success" });
    }
    if (url.endsWith("/commits/abc123/check-runs")) {
      return jsonResponse({
        check_runs: [{ status: "completed", conclusion: "success" }]
      });
    }
    if (url.endsWith("/pulls/77/reviews")) {
      return jsonResponse([{ state: "APPROVED", user: { login: "maintainer" } }]);
    }
    return { ok: false, status: 404, async json() { return {}; } };
  };
}

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

test("verification contract separates verifier policy version from config version", () => {
  const job = {
    id: "policy-versioned-job",
    outputSchemaRef: "schema://jobs/release-readiness-output",
    verifierMode: "deterministic",
    verification: {
      policyVersion: 3
    },
    verifierConfig: {
      version: 7,
      handler: "deterministic",
      expectedOutputs: ["release_id"],
      matchMode: "contains_all"
    }
  };

  const contract = buildVerificationContract(job, { verdict: { handlerVersion: 1 } });
  assert.equal(contract.verifierPolicyVersion, 3);
  assert.equal(contract.verifierConfigVersion, 7);
  assert.ok(contract.snapshotFields.includes("verifierPolicyVersion"));
  assert.ok(contract.snapshotFields.includes("verifierConfigVersion"));
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

test("every registered verifier handler has replay fixtures for its current handler version", () => {
  const registry = new VerifierRegistry({ githubToken: "" });
  const fixtureHandlers = new Set(listFixtureHandlerIds());

  for (const { id, version } of registry.listHandlerMetadata()) {
    assert.ok(fixtureHandlers.has(id), `missing replay fixture directory for handler ${id}`);
    const versions = fixtureVersionsForHandler(id);
    assert.ok(versions.includes(`v${version}`), `missing replay fixtures for ${id} current handler version v${version}`);
    assert.ok(
      loadFixturesForHandler(id).some((entry) => entry.version === `v${version}`),
      `no replay fixture JSON files for ${id} current handler version v${version}`
    );
  }
});

for (const handlerId of listFixtureHandlerIds()) {
  for (const { name, version, fixture } of loadFixturesForHandler(handlerId)) {
    test(`handler-versioned replay fixture remains stable under current handler: ${name}`, async () => {
      // A github_pr result is reproducible only with a live-derived snapshot;
      // submitted claims alone are deliberately insufficient for approval.
      const registry = fixture.handler === "github_pr"
        ? new VerifierRegistry({ githubToken: "github_pat_test", fetchImpl: liveGithubPrFetch() })
        : new VerifierRegistry({ githubToken: "" });
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
    verifierPolicyVersion: 99,
    verifierConfigSnapshot: fixture.job.verifierConfig,
    verifierConfigHash: "stale-hash-from-prior-snapshot",
    verificationInput: normalizeSubmission(fixture.verificationInput.structured),
    evidenceSchemaRef: fixture.evidenceSchemaRef
  });

  const service = new VerifierService(platformService, stateStore);
  const replay = await service.replayVerification(sessionId);

  assert.ok(replay.replayDrift, "expected replayDrift to be set when captured handler version differs from live");
  assert.deepEqual(replay.replayDrift.handlerVersion, { captured: 99, live: 1 });
  assert.deepEqual(replay.replayDrift.verifierPolicyVersion, { captured: 99, live: 1 });
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

test("getResult returns the persisted verification result when one exists", async () => {
  const stateStore = new MemoryStateStore();
  const verdict = { status: "approved", outcome: "approved", score: 100 };
  await stateStore.upsertVerificationResult("sid:0xabc", verdict);

  const service = new VerifierService({}, stateStore);
  const result = await service.getResult("sid:0xabc");

  assert.deepEqual(result, verdict);
});

test("getResult reports 'verifying' with awaitingSince for a submitted session without a verdict", async () => {
  const stateStore = new MemoryStateStore();
  const claimed = transitionSession(
    { sessionId: "sid:0xdef", wallet: "0xdddddddddddddddddddddddddddddddddddddddd", jobId: "job-1" },
    "claimed",
    { reason: "job_claimed" }
  );
  const submitted = transitionSession(claimed, "submitted", { reason: "work_submitted" });
  await stateStore.upsertSession(submitted);

  const service = new VerifierService({}, stateStore);
  const result = await service.getResult("sid:0xdef");

  assert.equal(result.status, "verifying");
  assert.equal(result.sessionStatus, "submitted");
  assert.equal(result.awaitingSince, submitted.submittedAt);
  assert.ok(submitted.submittedAt, "submittedAt should be set by the transition");
});

test("getResult returns null (→ not_found) when the session does not exist", async () => {
  const stateStore = new MemoryStateStore();
  const service = new VerifierService({}, stateStore);

  const result = await service.getResult("sid:missing");

  assert.equal(result, null);
});

test("getResult does not report 'verifying' for a merely claimed (not-yet-submitted) session", async () => {
  const stateStore = new MemoryStateStore();
  const claimed = transitionSession(
    { sessionId: "sid:0x111", wallet: "0x1111111111111111111111111111111111111111", jobId: "job-2" },
    "claimed",
    { reason: "job_claimed" }
  );
  await stateStore.upsertSession(claimed);

  const service = new VerifierService({}, stateStore);
  const result = await service.getResult("sid:0x111");

  assert.equal(result, null);
});

test("listPendingVerifications returns only submitted, unverified sessions tagged with verifier mode", async () => {
  const sessions = [
    { sessionId: "s-sub", jobId: "job-a", wallet: "0xworker1", status: "submitted", submittedAt: "2026-06-13T10:00:00.000Z" },
    { sessionId: "s-claim", jobId: "job-b", wallet: "0xworker2", status: "claimed" },
    { sessionId: "s-done", jobId: "job-c", wallet: "0xworker3", status: "submitted", submittedAt: "t", verification: { status: "approved" } },
    { sessionId: "s-resolved", jobId: "job-d", wallet: "0xworker4", status: "resolved" }
  ];
  const platformService = {
    listRecentSessions: async () => sessions,
    getJobDefinition: (jobId) => ({ jobId, verifierConfig: { handler: jobId === "job-a" ? "benchmark" : "human_fallback" } })
  };
  const service = new VerifierService(platformService, new MemoryStateStore());

  const result = await service.listPendingVerifications({ limit: 10 });

  assert.equal(result.count, 1);
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].sessionId, "s-sub");
  assert.equal(result.pending[0].wallet, "0xworker1");
  assert.equal(result.pending[0].verifierMode, "benchmark");
  assert.equal(result.pending[0].awaitingSince, "2026-06-13T10:00:00.000Z");
});

test("listPendingVerifications respects the limit and tolerates a missing job definition", async () => {
  const sessions = Array.from({ length: 5 }, (_, i) => ({
    sessionId: `s${i}`,
    jobId: "job",
    wallet: "0xw",
    status: "submitted",
    submittedAt: "2026-06-13T10:00:00.000Z"
  }));
  const platformService = {
    listRecentSessions: async () => sessions,
    getJobDefinition: () => {
      throw new Error("job not found");
    }
  };
  const service = new VerifierService(platformService, new MemoryStateStore());

  const result = await service.listPendingVerifications({ limit: 2 });

  assert.equal(result.count, 2);
  assert.equal(result.pending.length, 2);
  assert.equal(result.pending[0].verifierMode, null);
});

test("verifySubmission surfaces the on-chain payout tx on the result and the session", async () => {
  const stateStore = new MemoryStateStore();
  const session = transitionSession({
    sessionId: "payout-check-001:0xabc",
    wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    jobId: "payout-check-001",
    submission: normalizeSubmission({
      release_id: "release-2026-06-13",
      checks_passed: ["api-health"],
      checks_failed: [],
      blockers: [],
      go_no_go: "go"
    })
  }, "claimed", { reason: "job_claimed" });
  const submitted = transitionSession(session, "submitted", { reason: "work_submitted" });
  await stateStore.upsertSession(submitted);

  const job = {
    id: "payout-check-001",
    outputSchemaRef: "schema://jobs/release-readiness-output",
    verifierMode: "deterministic",
    verifierConfig: {
      version: 1,
      handler: "deterministic",
      expectedOutputs: ["release_id", "checks_passed", "go_no_go"],
      matchMode: "contains_all"
    }
  };

  const terminalWrites = [];
  const platformService = {
    resumeSession: (sessionId) => stateStore.getSession(sessionId),
    getJobDefinition: () => job,
    ingestVerification: async (sessionId, verdict, { payoutTx } = {}) => {
      const current = await stateStore.getSession(sessionId);
      const updated = transitionSession({
        ...current,
        ...(payoutTx ? { payoutTx } : {})
      }, verdict.outcome === "approved" ? "resolved" : "rejected", {
        reason: "verification_resolved"
      });
      terminalWrites.push(updated);
      await stateStore.upsertSession(updated);
      await stateStore.upsertVerificationResult(sessionId, { ...verdict, session: updated });
      return updated;
    }
  };

  const settlement = {
    worker: submitted.wallet,
    treasuryAccount: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    asset: "0xcccccccccccccccccccccccccccccccccccccccc",
    assetSymbol: "USDC",
    workerAmount: 1,
    workerAmountRaw: "1000000",
    protocolFeeAmount: 0.025,
    protocolFeeAmountRaw: "25000",
    protocolFeeBps: 250
  };
  const payoutReceipt = { txHash: "0xpayouttx", blockNumber: 4242, status: 1, settlement };
  const blockchainGateway = {
    isEnabled: () => true,
    resolveSinglePayout: async () => payoutReceipt
  };

  const service = new VerifierService(platformService, stateStore, blockchainGateway);
  const result = await service.verifySubmission({ sessionId: submitted.sessionId });

  assert.equal(result.outcome, "approved");
  // payout tx surfaced on the verification result (where the worker polls /verifier/result)...
  assert.deepEqual(result.payoutTx, payoutReceipt);
  assert.deepEqual(result.session.payoutTx, payoutReceipt);
  // ...and persisted on the session record (so /session shows it too).
  const stored = await stateStore.getSession(submitted.sessionId);
  assert.deepEqual(stored.payoutTx, payoutReceipt);
  assert.equal(terminalWrites.length, 1);
  assert.deepEqual(terminalWrites[0].payoutTx, payoutReceipt, "the first terminal write carries payoutTx");
  const verification = await stateStore.getVerificationResult(submitted.sessionId);
  assert.deepEqual(verification.settlement, settlement);
  assert.deepEqual(verification.payoutTx, payoutReceipt);
});

function makeIdempotencyHarness(onChainState) {
  const stateStore = new MemoryStateStore();
  const job = {
    id: "idem-001",
    outputSchemaRef: "schema://jobs/release-readiness-output",
    verifierMode: "deterministic",
    verifierConfig: {
      version: 1,
      handler: "deterministic",
      expectedOutputs: ["release_id", "checks_passed", "go_no_go"],
      matchMode: "contains_all"
    }
  };
  const claimed = transitionSession({
    sessionId: "idem-001:0xabc",
    wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    jobId: "idem-001",
    submission: normalizeSubmission({
      release_id: "release-2026-06-15",
      checks_passed: ["api-health"],
      checks_failed: [],
      blockers: [],
      go_no_go: "go"
    })
  }, "claimed", { reason: "job_claimed" });
  const platformService = {
    resumeSession: (id) => stateStore.getSession(id),
    getJobDefinition: () => job,
    ingestVerification: async (id, verdict, { payoutTx } = {}) => {
      const current = await stateStore.getSession(id);
      const updated = transitionSession({
        ...current,
        ...(payoutTx ? { payoutTx } : {})
      }, verdict.outcome === "approved" ? "resolved" : "rejected", {
        reason: "verification_resolved"
      });
      await stateStore.upsertSession(updated);
      await stateStore.upsertVerificationResult(id, { ...verdict, session: updated });
      return updated;
    }
  };
  const settlement = {
    worker: claimed.wallet,
    treasuryAccount: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    asset: "0xcccccccccccccccccccccccccccccccccccccccc",
    assetSymbol: "USDC",
    workerAmount: 1,
    workerAmountRaw: "1000000",
    protocolFeeAmount: 0,
    protocolFeeAmountRaw: "0",
    protocolFeeBps: 0
  };
  const payoutReceipt = { txHash: "0xpayout", blockNumber: 1, status: 1, settlement };
  const calls = { settle: 0, recover: 0 };
  const blockchainGateway = {
    isEnabled: () => true,
    getJob: async () => ({ state: onChainState }),
    resolveSinglePayout: async () => {
      calls.settle += 1;
      return payoutReceipt;
    },
    recoverSinglePayoutReceipt: async () => {
      calls.recover += 1;
      return payoutReceipt;
    }
  };
  return { stateStore, claimed, platformService, blockchainGateway, calls, payoutReceipt };
}

test("verifySubmission is idempotent: skips re-settling an already-resolved (Closed) on-chain job and still converges the session", async () => {
  const h = makeIdempotencyHarness(6); // EscrowCore JobState.Closed — a prior attempt already settled
  const submitted = transitionSession(h.claimed, "submitted", { reason: "work_submitted" });
  await h.stateStore.upsertSession(submitted);

  const service = new VerifierService(h.platformService, h.stateStore, h.blockchainGateway);
  const result = await service.verifySubmission({ sessionId: submitted.sessionId });

  assert.equal(h.calls.settle, 0, "must NOT re-settle a job the chain already resolved (would revert InvalidState)");
  assert.equal(h.calls.recover, 1, "must reconstruct the mined receipt before the terminal write");
  assert.equal(result.outcome, "approved");
  const stored = await h.stateStore.getSession(submitted.sessionId);
  assert.equal(stored.status, "resolved", "session converges to resolved despite the earlier persistence failure");
  assert.deepEqual(stored.payoutTx, h.payoutReceipt);
});

test("verifySubmission refuses an already-settled retry when chain evidence cannot be reconstructed", async () => {
  const h = makeIdempotencyHarness(6);
  const submitted = transitionSession(h.claimed, "submitted", { reason: "work_submitted" });
  await h.stateStore.upsertSession(submitted);
  h.blockchainGateway.recoverSinglePayoutReceipt = async () => {
    throw new Error("terminal receipt unavailable");
  };
  const service = new VerifierService(h.platformService, h.stateStore, h.blockchainGateway);

  await assert.rejects(
    () => service.verifySubmission({ sessionId: submitted.sessionId }),
    /terminal receipt unavailable/u
  );
  assert.equal((await h.stateStore.getSession(submitted.sessionId)).status, "submitted");
  assert.equal(await h.stateStore.getVerificationResult(submitted.sessionId), undefined);
});

test("verifySubmission reconstructs after chain settlement outlives a failed first terminal write", async () => {
  const h = makeIdempotencyHarness(3);
  const submitted = transitionSession(h.claimed, "submitted", { reason: "work_submitted" });
  await h.stateStore.upsertSession(submitted);
  let chainState = 3;
  h.blockchainGateway.getJob = async () => ({ state: chainState });
  h.blockchainGateway.resolveSinglePayout = async () => {
    h.calls.settle += 1;
    chainState = 6;
    return h.payoutReceipt;
  };
  const originalUpsert = h.stateStore.upsertSession.bind(h.stateStore);
  let failFirstTerminalWrite = true;
  h.stateStore.upsertSession = async (session) => {
    if (session.status === "resolved" && failFirstTerminalWrite) {
      failFirstTerminalWrite = false;
      throw new Error("simulated terminal session write failure");
    }
    return originalUpsert(session);
  };
  const service = new VerifierService(h.platformService, h.stateStore, h.blockchainGateway);

  await assert.rejects(
    () => service.verifySubmission({ sessionId: submitted.sessionId }),
    /simulated terminal session write failure/u
  );
  assert.equal((await h.stateStore.getSession(submitted.sessionId)).status, "submitted");
  assert.equal(await h.stateStore.getVerificationResult(submitted.sessionId), undefined);

  const recovered = await service.verifySubmission({ sessionId: submitted.sessionId });
  assert.equal(h.calls.settle, 1, "the retry must not submit a second settlement transaction");
  assert.equal(h.calls.recover, 1, "the retry reconstructs the first transaction's receipt");
  assert.equal(recovered.outcome, "approved");
  assert.deepEqual((await h.stateStore.getSession(submitted.sessionId)).payoutTx, h.payoutReceipt);
});

test("verifySubmission still settles when the on-chain job is genuinely unsettled (Submitted)", async () => {
  const h = makeIdempotencyHarness(3); // EscrowCore JobState.Submitted — not yet settled
  const submitted = transitionSession(h.claimed, "submitted", { reason: "work_submitted" });
  await h.stateStore.upsertSession(submitted);

  const service = new VerifierService(h.platformService, h.stateStore, h.blockchainGateway);
  const result = await service.verifySubmission({ sessionId: submitted.sessionId });

  assert.equal(h.calls.settle, 1, "an unsettled job must still be settled exactly once");
  assert.equal(h.calls.recover, 0);
  assert.equal(result.outcome, "approved");
  assert.deepEqual(result.payoutTx, h.payoutReceipt);
});

test("ingestBrokeredDecision sends poster approval through canonical verification persistence", async () => {
  const h = makeIdempotencyHarness(6);
  const submitted = transitionSession(h.claimed, "submitted", { reason: "work_submitted" });
  await h.stateStore.upsertSession(submitted);
  const service = new VerifierService(h.platformService, h.stateStore, h.blockchainGateway);
  const payoutTx = {
    txHash: "0xposterreview",
    blockNumber: 55,
    status: 1,
    settlement: {
      worker: submitted.wallet,
      workerAmountRaw: "1000000",
      protocolFeeAmountRaw: "50000"
    }
  };

  const result = await service.ingestBrokeredDecision({
    sessionId: submitted.sessionId,
    outcome: "approved",
    reasonCode: "POSTER_APPROVED",
    metadataURI: "urn:averray:poster-review:0xabc",
    reasoningHash: `0x${"a".repeat(64)}`,
    payoutTx,
    details: { authority: "external_poster_review" }
  });

  assert.equal(result.handler, "poster_review");
  assert.equal(result.outcome, "approved");
  assert.equal(result.reasonCode, "POSTER_APPROVED");
  assert.deepEqual(result.payoutTx, payoutTx);
  assert.deepEqual(result.settlement, payoutTx.settlement);
  assert.equal((await h.stateStore.getSession(submitted.sessionId)).status, "resolved");
});

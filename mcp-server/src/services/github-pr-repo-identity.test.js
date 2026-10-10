import test from "node:test";
import assert from "node:assert/strict";
import { VerifierRegistry } from "./verifier-handlers.js";
import { VerifierService } from "./verifier-service.js";
import { GithubPrReviewService } from "./github-pr-review-service.js";
import { MemoryStateStore } from "../core/state-store.js";
import { buildJobSnapshot } from "../core/job-snapshot.js";
import { normalizeSubmission } from "../core/submission.js";
import { createVerifierRoutes } from "../protocols/http/verifier-routes.js";
import { buildAverrayDisclosureFooter } from "../core/maintainer-surface-policy.js";

const wallet = "0x218A18d81E90d39557ff9E1E21B14E17ec2592A4";
const sessionId = "pr-jyotishankar04-saveforlatter-52:0x218A18d81E90d39557ff9E1E21B14E17ec2592A4";
const sourceId = 1344638682;
const repositoryCreatedAt = "2026-08-24T00:00:00Z";
const jobCreatedAt = "2026-10-06T00:00:00Z";
const body = `Closes #52\n\n${buildAverrayDisclosureFooter({ agentWallet: wallet })}`;

test("renamed repository matches by GitHub id and a merged preview is approved", async () => {
  // Mutation: comparing owner/repo strings fails here. saveforlatter and
  // savedly differ, and both names belong to repository 1344638682.
  const { service, store } = await sessionFor({
    job: githubJob({ repo: "jyotishankar04/saveforlatter" }),
    prUrl: "https://github.com/jyotishankar04/savedly/pull/91",
    fetchImpl: routeGithub({
      "/repos/jyotishankar04/saveforlatter": { id: sourceId, full_name: "jyotishankar04/savedly", created_at: repositoryCreatedAt },
      "/repos/jyotishankar04/savedly/pulls/91": pull({
        baseId: sourceId,
        baseName: "jyotishankar04/savedly",
        headId: 999,
        headName: "contributor/savedly",
        merged: true
      })
    })
  });
  const responded = [];
  const route = createVerifierRoutes({
    verifierService: service,
    authMiddleware: async () => ({ wallet }),
    enforceLimit: async () => {},
    rateLimitConfig: {},
    readJsonBody: async () => ({ sessionId, preview: true }),
    respond: (_response, status, payload) => responded.push({ status, payload })
  });
  await route({
    request: { method: "POST" },
    response: {},
    pathname: "/admin/verifier/run",
    url: new URL("http://localhost/admin/verifier/run")
  });
  const preview = responded[0]?.payload;
  assert.equal(responded[0]?.status, 200);
  assert.equal(preview.preview, true);
  assert.equal(preview.outcome, "approved", JSON.stringify({ blockers: preview.blockers, checks: preview.checks }));
  assert.equal(preview.checks.repoMatches, true);
  assert.equal(preview.score, 95); // This fixture has no approving review.
  assert.deepEqual(preview.checks.sourceRepoIdentity, {
    id: sourceId, origin: "resolved_by_name", createdAt: repositoryCreatedAt,
    jobCreatedAt, predatesJob: true
  });
  assert.deepEqual(preview.evidence.sourceRepoIdentity, preview.checks.sourceRepoIdentity);
  assert.equal(preview.checks.repoMatchMethod, "repository_id");
  assert.equal(preview.checks.repoMatchFallbackReason, undefined);
  assert.equal(preview.githubLookup.baseRepo.id, sourceId);
  assert.equal(preview.githubLookup.merged, true);
  assert.equal(preview.checks.issueReferenced, true);
  assert.equal(preview.checks.claimantBinding, true);
  assert.deepEqual(preview.evidence.sourceRepoRenamed, {
    from: "jyotishankar04/saveforlatter",
    to: "jyotishankar04/savedly"
  });
  assert.equal((await store.getSession(sessionId)).status, "submitted");
});

test("renamed repository that was closed without merge stays rejected", async () => {
  const verdict = await new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: routeGithub({
      "/repos/jyotishankar04/saveforlatter": { id: sourceId, full_name: "jyotishankar04/savedly", created_at: repositoryCreatedAt },
      "/repos/jyotishankar04/savedly/pulls/91": pull({
        baseId: sourceId,
        baseName: "jyotishankar04/savedly",
        headId: 999,
        headName: "contributor/savedly",
        merged: false,
        state: "closed"
      })
    })
  }).evaluate(githubJob({ repo: "jyotishankar04/saveforlatter" }), submission("https://github.com/jyotishankar04/savedly/pull/91"), {
    claimantWallet: wallet,
    claimSessionId: sessionId
  });
  assert.equal(verdict.checks.repoMatches, true);
  assert.equal(verdict.outcome, "rejected");
  assert.equal(verdict.blockers.includes("pull request was closed without merge"), true);
});

test("fork pull request does not match when only its head repository is the source", async () => {
  // Mutation: comparing head.repo.id instead of base.repo.id passes this
  // fixture. The head is the source repository; the pull request is opened
  // against a different base.
  const verdict = await new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: routeGithub({
      "/repos/owner/upstream": { id: sourceId, full_name: "owner/upstream", created_at: repositoryCreatedAt },
      "/repos/forker/upstream/pulls/91": pull({
        baseId: 200,
        baseName: "forker/upstream",
        headId: sourceId,
        headName: "owner/upstream",
        merged: true
      })
    })
  }).evaluate(githubJob({ repo: "owner/upstream" }), submission("https://github.com/forker/upstream/pull/91"), {
    claimantWallet: wallet,
    claimSessionId: sessionId
  });
  assert.equal(verdict.githubLookup.baseRepo.id, 200);
  assert.equal(verdict.checks.repoMatches, false);
  assert.equal(verdict.checks.repoMatchMethod, "repository_id");
  assert.equal(verdict.evidence.sourceRepoRenamed, undefined);
  assert.equal(verdict.outcome, "rejected");
  assert.match(verdict.blockers.join("\n"), /PR repo must match owner\/upstream/u);
});

test("source repository lookup failure requires PR base age evidence even with the same name", async () => {
  const sameName = await new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: routeGithub({
      "/repos/example/project/pulls/91": pull({
        baseId: sourceId,
        baseName: "example/project",
        headId: 999,
        headName: "contributor/project",
        merged: true
      })
    })
  }).evaluate(githubJob({ repo: "example/project" }), submission("https://github.com/example/project/pull/91"), {
    claimantWallet: wallet,
    claimSessionId: sessionId
  });
  assert.equal(sameName.checks.repoMatches, null);
  assert.equal(sameName.checks.repoMatchMethod, "unknown");
  assert.equal(sameName.checks.repoMatchFallbackReason, "pr_base_repo_creation_time_unavailable");
  assert.equal(sameName.evidence.sourceRepoIdentity.lookupFailureReason, "github_api_404");
  assert.equal(sameName.evidence.sourceRepoRenamed, undefined);
  assert.equal(sameName.outcome, "disputed");

  const differentName = await new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: async () => {
      throw new Error("network_down");
    }
  }).evaluate(githubJob({ repo: "jyotishankar04/saveforlatter" }), submission("https://github.com/jyotishankar04/savedly/pull/91"), {
    claimantWallet: wallet,
    claimSessionId: sessionId
  });
  assert.equal(differentName.checks.repoMatches, null);
  assert.equal(differentName.checks.repoMatchMethod, "unknown");
  assert.equal(differentName.checks.repoMatchFallbackReason, "network_down");
  assert.equal(differentName.evidence.sourceRepoRenamed, undefined);
  assert.equal(differentName.outcome, "disputed");
  assert.match(differentName.blockers.join("\n"), /repository identity requires human review/u);
});

test("transferred repository matches when the owner changes and the id does not", async () => {
  const verdict = await new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: routeGithub({
      "/repos/oldowner/widget": { id: 42, full_name: "newowner/widget", created_at: repositoryCreatedAt },
      "/repos/newowner/widget/pulls/91": pull({
        baseId: 42,
        baseName: "newowner/widget",
        headId: 43,
        headName: "contributor/widget",
        merged: true
      })
    })
  }).evaluate(githubJob({ repo: "oldowner/widget" }), submission("https://github.com/newowner/widget/pull/91"), {
    claimantWallet: wallet,
    claimSessionId: sessionId
  });
  assert.equal(verdict.checks.repoMatches, true);
  assert.equal(verdict.checks.repoMatchMethod, "repository_id");
  assert.deepEqual(verdict.evidence.sourceRepoRenamed, { from: "oldowner/widget", to: "newowner/widget" });
  assert.equal(verdict.outcome, "approved");
});

test("ingested repository id is reused, and a poster-supplied id is not", async () => {
  const calls = [];
  const cached = await new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: async (url) => {
      calls.push(new URL(url).pathname);
      if (new URL(url).pathname === "/repos/jyotishankar04/saveforlatter") {
        throw new Error("cached repository id must be used");
      }
      return routeGithub({
        "/repos/jyotishankar04/savedly/pulls/91": pull({
          baseId: sourceId,
          baseName: "jyotishankar04/savedly",
          headId: 999,
          headName: "contributor/savedly",
          merged: true
        })
      })(url);
    }
  }).evaluate(
    githubJob({ repo: "jyotishankar04/saveforlatter", githubRepoId: sourceId }),
    submission("https://github.com/jyotishankar04/savedly/pull/91"),
    { claimantWallet: wallet, claimSessionId: sessionId }
  );
  assert.equal(cached.checks.repoMatches, true);
  assert.equal(cached.outcome, "approved");
  assert.equal(cached.score, 95); // This fixture has no approving review.
  assert.equal(cached.checks.sourceRepoIdentity.id, sourceId);
  assert.equal(cached.checks.sourceRepoIdentity.origin, "ingested");
  assert.deepEqual(cached.evidence.sourceRepoIdentity, cached.checks.sourceRepoIdentity);
  assert.deepEqual(cached.evidence.sourceRepoRenamed, {
    from: "jyotishankar04/saveforlatter",
    to: "jyotishankar04/savedly"
  });
  assert.equal(calls.includes("/repos/jyotishankar04/saveforlatter"), false);

  const reusedName = await new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: routeGithub({
      "/repos/example/project/pulls/91": pull({
        baseId: 200,
        baseName: "example/project",
        headId: 100,
        headName: "example/project",
        merged: true
      })
    })
  }).evaluate(
    githubJob({ repo: "example/project", githubRepoId: 100 }),
    submission("https://github.com/example/project/pull/91"),
    { claimantWallet: wallet, claimSessionId: sessionId }
  );
  assert.equal(reusedName.checks.repoMatches, false);
  assert.equal(reusedName.checks.repoMatchMethod, "repository_id");
  assert.equal(reusedName.outcome, "rejected");

  const forged = await new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: routeGithub({
      "/repos/owner/upstream": { id: sourceId, full_name: "owner/upstream", created_at: repositoryCreatedAt },
      "/repos/attacker/copy/pulls/91": pull({
        baseId: 200,
        baseName: "attacker/copy",
        headId: 201,
        headName: "attacker/copy",
        merged: true
      })
    })
  }).evaluate(
    githubJob({ repo: "owner/upstream", sourceType: "external", declaredRepoId: 200 }),
    submission("https://github.com/attacker/copy/pull/91"),
    { claimantWallet: wallet, claimSessionId: sessionId }
  );
  assert.equal(forged.checks.repoMatches, false);
  assert.equal(forged.outcome, "rejected");
});

test("the review poller settles a renamed merged repository through the normal preview", async () => {
  const store = new MemoryStateStore();
  const job = githubJob({ repo: "jyotishankar04/saveforlatter" });
  await store.upsertSession({
    sessionId,
    jobId: job.id,
    wallet,
    status: "submitted",
    submittedAt: "2026-10-09T09:17:00.000Z",
    jobSnapshot: buildJobSnapshot(job),
    submission: submission("https://github.com/jyotishankar04/savedly/pull/91")
  });
  const writes = [];
  const registry = new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: routeGithub({
      "/repos/jyotishankar04/saveforlatter": { id: sourceId, full_name: "jyotishankar04/savedly", created_at: repositoryCreatedAt },
      "/repos/jyotishankar04/savedly/pulls/91": pull({
        baseId: sourceId,
        baseName: "jyotishankar04/savedly",
        headId: 999,
        headName: "contributor/savedly",
        merged: true
      })
    })
  });
  const platform = {
    resumeSession: (id) => store.getSession(id),
    ingestVerification: async (id, verdict) => {
      writes.push(verdict);
      const session = { ...(await store.getSession(id)), status: "resolved" };
      await store.upsertSession(session);
      await store.upsertVerificationResult(id, verdict);
      return session;
    }
  };
  const review = new GithubPrReviewService({
    stateStore: store,
    verifierService: new VerifierService(platform, store, undefined, registry),
    githubToken: "github_pat_test",
    logger: { info() {} }
  });
  const run = await review.runOnce(new Date("2026-10-10T00:00:00.000Z"));
  assert.deepEqual(run.errors, []);
  assert.deepEqual(run.reviewed, [{ sessionId, outcome: "approved" }]);
  assert.equal((await store.getSession(sessionId)).status, "resolved");
  assert.deepEqual(writes[0].evidence.sourceRepoRenamed, {
    from: "jyotishankar04/saveforlatter",
    to: "jyotishankar04/savedly"
  });
  assert.deepEqual((await store.getVerificationResult(sessionId)).evidence.sourceRepoRenamed, {
    from: "jyotishankar04/saveforlatter",
    to: "jyotishankar04/savedly"
  });
  assert.deepEqual((await store.getVerificationResult(sessionId)).evidence.sourceRepoIdentity, {
    id: sourceId, origin: "resolved_by_name", createdAt: repositoryCreatedAt,
    jobCreatedAt, predatesJob: true
  });
});

test("cached id with a verified PR missing base.repo requires human review, never name fallback", async () => {
  const snapshot = pull({ baseId: sourceId, baseName: "example/project", merged: true });
  delete snapshot.base.repo;
  const calls = [];
  const verdict = await new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: async (url) => {
      calls.push(new URL(url).pathname);
      return routeGithub({ "/repos/example/project/pulls/91": snapshot })(url);
    }
  }).evaluate(githubJob({ repo: "example/project", githubRepoId: sourceId }),
    submission("https://github.com/example/project/pull/91"),
    { claimantWallet: wallet, claimSessionId: sessionId });
  assert.equal(verdict.githubLookup.status, "verified");
  assert.equal(verdict.checks.repoMatches, null);
  assert.equal(verdict.checks.repoMatchMethod, "unknown");
  assert.equal(verdict.checks.repoMatchFallbackReason, "pr_base_repo_id_unavailable");
  assert.equal(verdict.outcome, "disputed");
  assert.equal(verdict.handler, "human_fallback");
  assert.equal(verdict.evidence.sourceRepoIdentity.origin, "ingested");
  assert.equal(calls.includes("/repos/example/project"), false);
});

test("cached id with a renamed PR lookup 500 requires human review, not rejection", async () => {
  const calls = [];
  const verdict = await new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: async (url) => {
      calls.push(new URL(url).pathname);
      return new Response("{}", { status: 500 });
    }
  }).evaluate(githubJob({ repo: "jyotishankar04/saveforlatter", githubRepoId: sourceId }),
    submission("https://github.com/jyotishankar04/savedly/pull/91"),
    { claimantWallet: wallet, claimSessionId: sessionId });
  assert.equal(verdict.checks.repoMatches, null);
  assert.equal(verdict.checks.repoMatchMethod, "unknown");
  assert.equal(verdict.checks.repoMatchFallbackReason, "github_api_500");
  assert.equal(verdict.outcome, "disputed");
  assert.equal(verdict.handler, "human_fallback");
  assert.deepEqual(calls, ["/repos/jyotishankar04/savedly/pulls/91"]);
});

for (const [name, createdAt, expectedAge, reason] of [
  ["recreated after the job", "2026-10-07T00:00:00Z", false, "source_repo_not_older_than_job"],
  ["created at the job time", jobCreatedAt, false, "source_repo_not_older_than_job"],
  ["missing creation time", undefined, null, "source_repo_creation_time_unavailable"],
  ["invalid creation time", "not-a-date", null, "source_repo_creation_time_unavailable"]
]) test(`uncached repository ${name} requires human review`, async () => {
  const verdict = await new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: routeGithub({
      "/repos/example/project": { id: 200, full_name: "example/project", created_at: createdAt },
      "/repos/example/project/pulls/91": pull({ baseId: 200, baseName: "example/project", merged: true })
    })
  }).evaluate(githubJob({ repo: "example/project" }),
    submission("https://github.com/example/project/pull/91"),
    { claimantWallet: wallet, claimSessionId: sessionId });
  assert.equal(verdict.outcome, "disputed");
  assert.equal(verdict.checks.repoMatches, null);
  assert.equal(verdict.checks.repoMatchFallbackReason, reason);
  assert.deepEqual(verdict.checks.sourceRepoIdentity, {
    id: 200, origin: "resolved_by_name", createdAt: createdAt ?? null,
    jobCreatedAt, predatesJob: expectedAge
  });
  assert.deepEqual(verdict.evidence.sourceRepoIdentity, verdict.checks.sourceRepoIdentity);
});

test("uncached repository with missing pinned job creation time requires human review", async () => {
  const job = githubJob({ repo: "example/project" });
  delete job.lifecycle;
  const verdict = await new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: routeGithub({
      "/repos/example/project": { id: sourceId, full_name: "example/project", created_at: repositoryCreatedAt },
      "/repos/example/project/pulls/91": pull({ baseId: sourceId, baseName: "example/project", merged: true })
    })
  }).evaluate(job, submission("https://github.com/example/project/pull/91"),
    { claimantWallet: wallet, claimSessionId: sessionId });
  assert.equal(verdict.outcome, "disputed");
  assert.equal(verdict.checks.sourceRepoIdentity.jobCreatedAt, null);
  assert.equal(verdict.checks.sourceRepoIdentity.predatesJob, null);
});

for (const sourceStatus of [500, 403, 429]) {
  for (const [age, createdAt, outcome] of [
    ["older", repositoryCreatedAt, "approved"],
    ["recreated", "2026-10-07T00:00:00Z", "disputed"],
    ["same-time", jobCreatedAt, "disputed"],
    ["missing", undefined, "disputed"],
    ["invalid", "not-a-date", "disputed"]
  ]) test(`failed source lookup ${sourceStatus}: same-name ${age} PR base repository age`, async () => {
    const snapshot = pull({ baseId: sourceId, baseName: "example/project", merged: true });
    snapshot.base.repo.created_at = createdAt;
    const verdict = await new VerifierRegistry({
      githubToken: "github_pat_test",
      fetchImpl: async (url) => new URL(url).pathname === "/repos/example/project"
        ? new Response("{}", { status: sourceStatus })
        : routeGithub({ "/repos/example/project/pulls/91": snapshot })(url)
    }).evaluate(githubJob({ repo: "example/project" }),
      submission("https://github.com/example/project/pull/91"),
      { claimantWallet: wallet, claimSessionId: sessionId });
    assert.equal(verdict.githubLookup.status, "verified");
    assert.equal(verdict.githubLookup.baseRepo.createdAt, createdAt ?? null);
    assert.equal(verdict.outcome, outcome);
    assert.equal(verdict.checks.repoMatches, outcome === "approved" ? true : null);
    assert.equal(verdict.checks.repoMatchMethod, outcome === "approved" ? "exact_name" : "unknown");
    assert.equal(verdict.evidence.sourceRepoIdentity.lookupFailureReason, `github_api_${sourceStatus}`);
    if (outcome === "approved") assert.equal(verdict.checks.repoMatchFallbackReason, `github_api_${sourceStatus}`);
    else assert.match(verdict.checks.repoMatchFallbackReason, /^pr_base_repo_/u);
  });
}

for (const [name, snapshotMode] of [["renamed", "500"], ["same-name", "missing-base"]]) {
  test(`resolved-by-name id with ${name} PR base id unavailable requires human review`, async () => {
    const repo = "jyotishankar04/saveforlatter";
    const prRepo = name === "renamed" ? "jyotishankar04/savedly" : repo;
    const snapshot = pull({ baseId: sourceId, baseName: prRepo, merged: true });
    delete snapshot.base.repo;
    const verdict = await new VerifierRegistry({
      githubToken: "github_pat_test",
      fetchImpl: async (url) => {
        const path = new URL(url).pathname;
        if (path === `/repos/${repo}`) return Response.json({
          id: sourceId, full_name: prRepo, created_at: repositoryCreatedAt
        });
        if (snapshotMode === "500") return new Response("{}", { status: 500 });
        return routeGithub({ [`/repos/${prRepo}/pulls/91`]: snapshot })(url);
      }
    }).evaluate(githubJob({ repo }), submission(`https://github.com/${prRepo}/pull/91`),
      { claimantWallet: wallet, claimSessionId: sessionId });
    assert.equal(verdict.checks.sourceRepoIdentity.origin, "resolved_by_name");
    assert.equal(verdict.checks.sourceRepoIdentity.predatesJob, true);
    assert.equal(verdict.checks.repoMatches, null);
    assert.equal(verdict.checks.repoMatchMethod, "unknown");
    assert.equal(verdict.outcome, "disputed");
    assert.equal(verdict.handler, "human_fallback");
  });
}

test("uncached failed source lookup and verified PR without base.repo requires human review", async () => {
  const snapshot = pull({ baseId: sourceId, baseName: "example/project", merged: true });
  delete snapshot.base.repo;
  const verdict = await new VerifierRegistry({ githubToken: "github_pat_test",
    fetchImpl: routeGithub({ "/repos/example/project/pulls/91": snapshot })
  }).evaluate(githubJob({ repo: "example/project" }), submission("https://github.com/example/project/pull/91"),
    { claimantWallet: wallet, claimSessionId: sessionId });
  assert.equal(verdict.githubLookup.status, "verified");
  assert.equal(verdict.checks.repoMatches, null);
  assert.equal(verdict.outcome, "disputed");
  assert.equal(verdict.handler, "human_fallback");
  assert.equal(verdict.checks.repoMatchFallbackReason, "pr_base_repo_creation_time_unavailable");
});

for (const failure of ["github_api_500", "github_token_not_configured"]) {
  test(`both GitHub reads unavailable preserve ${failure} in the human-review diagnostic`, async () => {
    const verdict = await new VerifierRegistry({
      githubToken: failure === "github_token_not_configured" ? "" : "github_pat_test",
      fetchImpl: async () => new Response("{}", { status: 500 })
    }).evaluate(githubJob({ repo: "example/project" }), submission("https://github.com/example/project/pull/91"),
      { claimantWallet: wallet, claimSessionId: sessionId });
    assert.equal(verdict.outcome, "disputed");
    assert.equal(verdict.checks.repoMatchFallbackReason, failure);
    assert.ok(verdict.detail.includes(failure), verdict.detail);
  });
}

test("backfilled identity reaches preview, settle and replay without rewriting claim snapshot", async () => {
  const { backfillGithubRepositoryIds } = await import("./github-repository-identity-backfill.js");
  const job = githubJob({ repo: "example/project" });
  job.lifecycle.state = "open";
  const { store, service } = await sessionFor({ job, prUrl: "https://github.com/example/project/pull/91",
    fetchImpl: routeGithub({ "/repos/example/project/pulls/91": pull({ baseId: 9999, baseName: "example/project", merged: true }) }) });
  const before = JSON.stringify(await store.getSession(sessionId));
  const rawBefore = JSON.stringify(job);
  const result = await backfillGithubRepositoryIds({ stateStore: store, getJobDefinition: () => structuredClone(job) },
    { jobIds: [job.id], apply: true }, { githubToken: "github_pat_test",
      fetchImpl: async () => Response.json({ id: sourceId, full_name: "example/project", created_at: repositoryCreatedAt }) });
  assert.equal(result.pinned, 1);
  const preview = await service.previewSubmission({ sessionId });
  assert.equal(preview.checks.sourceRepoIdentity.id, sourceId);
  assert.equal(preview.checks.repoMatches, false);
  assert.equal(preview.outcome, "rejected");
  await assert.rejects(service.verifySubmission({ sessionId, expectOutcome: "approved" }), { code: "verdict_outcome_mismatch" });
  service.platformService.resumeSession = () => store.getSession(sessionId);
  const replay = await service.replayVerification(sessionId);
  assert.equal(replay.checks.sourceRepoIdentity.id, sourceId);
  assert.equal(replay.outcome, "rejected");
  assert.equal(JSON.stringify(await store.getSession(sessionId)), before);
  assert.equal(JSON.stringify(job), rawBefore);
});

function githubJob({ repo, githubRepoId, sourceType = "github_issue", declaredRepoId } = {}) {
  const declared = {
    type: "github_issue",
    repo,
    issueNumber: 52,
    ...(declaredRepoId ? { githubRepoId: declaredRepoId } : {})
  };
  return {
    id: "pr-jyotishankar04-saveforlatter-52",
    lifecycle: { createdAt: jobCreatedAt },
    category: "coding",
    verifierMode: "github_pr",
    source: sourceType === "github_issue"
      ? {
          type: "github_issue",
          repo,
          issueNumber: 52,
          ...(githubRepoId ? { githubRepoId } : {}),
          maintainerPolicy: { disclosureRequired: true }
        }
      : {
          type: "external",
          ...(declaredRepoId ? { githubRepoId: declaredRepoId } : {}),
          declared
        },
    verifierConfig: {
      handler: "github_pr",
      version: 1,
      minimumScore: 80,
      requireIssueReference: true,
      requireTestEvidence: true,
      acceptMergedAsApproved: true,
      requireClaimantBinding: true
    }
  };
}

function submission(prUrl) {
  return normalizeSubmission({
    prUrl,
    summary: "Closes #52",
    tests: "npm test passed"
  });
}

async function sessionFor({ job, prUrl, fetchImpl }) {
  const store = new MemoryStateStore();
  await store.upsertSession({
    sessionId,
    jobId: job.id,
    wallet,
    status: "submitted",
    submittedAt: "2026-10-09T09:17:00.000Z",
    jobSnapshot: buildJobSnapshot(job),
    submission: submission(prUrl)
  });
  const service = new VerifierService(
    {},
    store,
    undefined,
    new VerifierRegistry({ githubToken: "github_pat_test", fetchImpl })
  );
  return { store, service };
}

function pull({ baseId, baseName, headId, headName, merged, state }) {
  return {
    id: 555,
    html_url: `https://github.com/${baseName}/pull/91`,
    title: "Fix #52",
    body,
    state: state ?? (merged ? "closed" : "open"),
    merged: Boolean(merged),
    ...(merged ? { merged_at: "2026-10-09T21:31:00Z" } : {}),
    user: { login: "jyotishankar04" },
    head: { sha: "abc123", repo: { id: headId, full_name: headName } },
    base: { repo: { id: baseId, full_name: baseName } }
  };
}

function routeGithub(routes) {
  return async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/status")) return Response.json({ state: "success", statuses: [] });
    if (path.endsWith("/check-runs")) {
      return Response.json({ check_runs: [{ name: "tests", status: "completed", conclusion: "success" }] });
    }
    if (path.endsWith("/reviews")) return Response.json([]);
    if (Object.hasOwn(routes, path)) return Response.json(routes[path]);
    return new Response("{}", { status: 404 });
  };
}

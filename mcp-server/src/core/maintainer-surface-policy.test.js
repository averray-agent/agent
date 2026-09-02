import test from "node:test";
import assert from "node:assert/strict";

import {
  appendAverrayDisclosureFooter,
  buildAverrayDisclosureFooter,
  countOpenGithubPullRequestsForRepo,
  evaluateMaintainerSurfaceForIssue,
  hasAverrayDisclosureFooter,
  isRepoDenied,
  scanPolicyText
} from "./maintainer-surface-policy.js";
import { MemoryStateStore } from "./state-store.js";

test("denylist blocks seeded security and standards repositories", () => {
  assert.equal(isRepoDenied("openssl/openssl"), true);
  assert.equal(isRepoDenied("w3c/csswg-drafts"), true);
  assert.equal(isRepoDenied("example/project"), false);
});

test("policy scanner distinguishes AI bans from disclosure requirements", () => {
  assert.deepEqual(scanPolicyText("AI generated pull requests are not accepted.").allowed, false);
  assert.equal(scanPolicyText("Please stop submitting Averray pull requests.").reason, "maintainer_stop_signal");
  assert.deepEqual(scanPolicyText("AI-assisted work must be disclosed in the pull request body.").allowed, true);
});

test("repository policy scan blocks issues from repos that disallow AI contributions", async () => {
  const issue = {
    title: "Add parser tests",
    body: "Small regression test.",
    number: 3,
    repository_url: "https://api.github.com/repos/example/project"
  };
  const result = await evaluateMaintainerSurfaceForIssue(issue, {
    scanRepoPolicies: true,
    fetchImpl: async (url) => ({
      status: String(url).endsWith("/contents/CONTRIBUTING.md") ? 200 : 404,
      ok: String(url).endsWith("/contents/CONTRIBUTING.md"),
      async text() {
        return "AI generated contributions are not accepted.";
      }
    })
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "repo_ai_policy_denies_agent_contributions");
  assert.deepEqual(result.policyScan.scannedPaths, ["CONTRIBUTING.md"]);
});

test("Averray disclosure footer helper is idempotent", () => {
  const footer = buildAverrayDisclosureFooter({
    agentWallet: "0xabc",
    jobSpecUrl: "https://api.averray.com/jobs/1",
    submissionHash: "0x123"
  });
  assert.equal(hasAverrayDisclosureFooter(footer), true);
  assert.equal(appendAverrayDisclosureFooter(footer, { agentWallet: "0xdef" }), footer);
});

test("counts active GitHub pull requests for a repo from funded jobs", async () => {
  const store = new MemoryStateStore();
  await store.upsertFundedJob({
    jobId: "a",
    finalStatus: "open",
    upstream: { kind: "github_pull_request", repo: "example/project", pullNumber: 1 }
  });
  await store.upsertFundedJob({
    jobId: "b",
    finalStatus: "merged",
    upstream: { kind: "github_pull_request", repo: "example/project", pullNumber: 2 }
  });
  await store.upsertFundedJob({
    jobId: "c",
    finalStatus: "open",
    upstream: { kind: "github_pull_request", repo: "other/project", pullNumber: 3 }
  });

  assert.equal(await countOpenGithubPullRequestsForRepo(store, "example/project"), 1);
});

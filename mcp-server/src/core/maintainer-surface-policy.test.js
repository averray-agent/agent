import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  appendAverrayDisclosureFooter,
  buildAverrayDisclosureFooter,
  countOpenGithubPullRequestsForRepo,
  evaluateMaintainerSurfaceForIssue,
  hasAverrayDisclosureFooter,
  inspectAverrayClaimantBinding,
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

test("Averray disclosure claimant binding matches only the labelled claimant wallet or claim session", () => {
  const claimantWallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const footer = buildAverrayDisclosureFooter({
    agentWallet: claimantWallet,
    claimSessionId: "session-claimant-1"
  });

  assert.equal(inspectAverrayClaimantBinding(footer, { claimantWallet }).status, "matched");
  assert.equal(
    inspectAverrayClaimantBinding(footer, { claimSessionId: "session-claimant-1" }).status,
    "matched"
  );
  assert.equal(
    inspectAverrayClaimantBinding(
      `Unrelated mention ${claimantWallet}\n\n${buildAverrayDisclosureFooter({
        agentWallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      })}`,
      { claimantWallet }
    ).status,
    "mismatched"
  );
  assert.equal(
    inspectAverrayClaimantBinding(`Agent identity: ${claimantWallet}`, { claimantWallet }).status,
    "matched"
  );
  assert.equal(inspectAverrayClaimantBinding(buildAverrayDisclosureFooter(), { claimantWallet }).status, "mismatched");
});

test("the five queued disclosures and playsouthwales bind verbatim without a magic sentence", () => {
  const { fixtures } = JSON.parse(readFileSync(new URL("./__fixtures__/github-pr-disclosures.json", import.meta.url), "utf8"));
  assert.equal(fixtures.length, 6);
  for (const fixture of fixtures) {
    const binding = inspectAverrayClaimantBinding(fixture.body, fixture);
    assert.equal(binding.status, "matched", fixture.source);
    assert.equal(hasAverrayDisclosureFooter(fixture.body), true, fixture.source);
    assert.ok(binding.disclosure.labelledLines.length > 0);
    assert.ok(binding.disclosure.matchedBy.length > 0);
  }
});

test("TricklePay-shaped exact session binds without the canonical header; unlabelled wallets never bind", () => {
  const claimantWallet = "0xCdC6ADd097B5a46935965BbE3612B8130EefC74F";
  const claimSessionId = "real-patch-tricklepay-withdraw-disabled-test-149:" + claimantWallet;
  const context = { claimantWallet, claimSessionId };
  const matched = inspectAverrayClaimantBinding("AI-assisted work through Averray.\nClaim session: " + claimSessionId, context);
  assert.equal(matched.status, "matched");
  assert.equal(matched.disclosure.canonicalHeader, false);
  assert.deepEqual(matched.disclosure.matchedBy, ["session"]);
  assert.equal(inspectAverrayClaimantBinding("Averray contribution by " + claimantWallet, context).status, "missing");
  assert.equal(inspectAverrayClaimantBinding("Claim session: " + claimSessionId + "-someone-else", context).status, "mismatched");
  assert.equal(inspectAverrayClaimantBinding("Claimant wallet: " + claimantWallet + "1", context).status, "mismatched");
});

test("claimant labels accept case, Markdown and whitespace separators but preserve exact session values", () => {
  const claimantWallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const claimSessionId = "job_with_underscores:" + claimantWallet;
  for (const label of ["Agent identity", "Claimant wallet", "Operator wallet", "Agent wallet", "Wallet"]) {
    for (const separator of [": ", " "]) {
      const body = "> - **AVERRAY " + label.toUpperCase() + "**" + separator + "(\x60" + claimantWallet + "\x60)";
      assert.equal(inspectAverrayClaimantBinding(body, { claimantWallet }).status, "matched", body);
    }
  }
  for (const label of ["Claim session", "Session"]) {
    assert.equal(inspectAverrayClaimantBinding("_" + label + "_: \x60" + claimSessionId + "\x60", { claimSessionId }).status, "matched");
  }
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

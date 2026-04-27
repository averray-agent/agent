import test from "node:test";
import assert from "node:assert/strict";

import { MemoryStateStore } from "../core/state-store.js";
import {
  UpstreamStatusPollerService,
  pollGithubPullRequest,
  pollMediaWikiRevision
} from "./upstream-status-poller.js";

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    }
  };
}

const githubRecord = {
  jobId: "oss-example-42",
  sessionId: "oss-example-42:0xabc",
  wallet: "0xabc",
  sourceType: "github_issue",
  rewardAmount: 5,
  fundedAt: "2026-01-01T00:00:00.000Z",
  submittedAt: "2026-01-02T00:00:00.000Z",
  deadlineAt: "2026-02-01T00:00:00.000Z",
  finalStatus: "open",
  upstream: {
    kind: "github_pull_request",
    owner: "example",
    name: "project",
    repo: "example/project",
    pullNumber: 77,
    url: "https://github.com/example/project/pull/77"
  }
};

test("pollGithubPullRequest marks merged pull requests as merged", async () => {
  const result = await pollGithubPullRequest(githubRecord, {
    now: new Date("2026-01-05T00:00:00.000Z"),
    fetchImpl: async (url, options) => {
      assert.equal(String(url), "https://api.github.com/repos/example/project/pulls/77");
      assert.equal(options.headers["user-agent"], "averray-upstream-status-poller");
      return jsonResponse({ state: "closed", merged: true, merged_at: "2026-01-04T00:00:00Z" });
    }
  });

  assert.equal(result.finalStatus, "merged");
  assert.equal(result.upstreamStatus, "merged");
  assert.equal(result.upstream.mergedAt, "2026-01-04T00:00:00Z");
});

test("pollGithubPullRequest marks closed unmerged pull requests", async () => {
  const result = await pollGithubPullRequest(githubRecord, {
    now: new Date("2026-01-05T00:00:00.000Z"),
    fetchImpl: async () => jsonResponse({ state: "closed", merged: false, closed_at: "2026-01-04T00:00:00Z" })
  });

  assert.equal(result.finalStatus, "closed_unmerged");
  assert.equal(result.closeReason, "closed_unmerged");
});

test("pollGithubPullRequest marks open pull requests stale after deadline", async () => {
  const result = await pollGithubPullRequest(githubRecord, {
    now: new Date("2026-02-02T00:00:00.000Z"),
    fetchImpl: async () => jsonResponse({ state: "open", merged: false })
  });

  assert.equal(result.finalStatus, "open_stale");
  assert.equal(result.closeReason, "deadline_elapsed");
});

test("pollMediaWikiRevision skips proposal-only records", async () => {
  const result = await pollMediaWikiRevision({
    upstream: {
      kind: "mediawiki_revision",
      proposalOnly: true,
      language: "en",
      reviewRevisionId: "123"
    }
  });

  assert.equal(result, undefined);
});

test("pollMediaWikiRevision marks direct edits after survival window", async () => {
  const result = await pollMediaWikiRevision({
    upstream: {
      kind: "mediawiki_revision",
      proposalOnly: false,
      language: "en",
      editRevisionId: "456"
    }
  }, {
    now: new Date("2026-01-10T00:00:00.000Z"),
    fetchImpl: async (url) => {
      if (String(url).includes("revids=456")) {
        return jsonResponse({
          query: {
            pages: {
              1: {
                pageid: 1,
                revisions: [{ revid: 456, timestamp: "2026-01-01T00:00:00Z", tags: [] }]
              }
            }
          }
        });
      }
      assert.match(String(url), /pageids=1/u);
      return jsonResponse({
        query: {
          pages: {
            1: {
              revisions: [{ revid: 789, timestamp: "2026-01-02T00:00:00Z", tags: [] }]
            }
          }
        }
      });
    }
  });

  assert.equal(result.finalStatus, "merged");
  assert.equal(result.upstreamStatus, "survived_7_days");
});

test("pollMediaWikiRevision marks direct edits reverted when later revision signals undo", async () => {
  const result = await pollMediaWikiRevision({
    upstream: {
      kind: "mediawiki_revision",
      proposalOnly: false,
      language: "en",
      editRevisionId: "456"
    }
  }, {
    now: new Date("2026-01-10T00:00:00.000Z"),
    fetchImpl: async (url) => {
      if (String(url).includes("revids=456")) {
        return jsonResponse({
          query: {
            pages: {
              1: {
                pageid: 1,
                revisions: [{ revid: 456, timestamp: "2026-01-01T00:00:00Z", tags: [] }]
              }
            }
          }
        });
      }
      return jsonResponse({
        query: {
          pages: {
            1: {
              revisions: [{
                revid: 790,
                timestamp: "2026-01-02T00:00:00Z",
                tags: ["mw-undo"],
                comment: "Undid revision 456 by Example"
              }]
            }
          }
        }
      });
    }
  });

  assert.equal(result.finalStatus, "reverted");
  assert.equal(result.closeReason, "later_revert_detected");
});

test("UpstreamStatusPollerService updates records and generates report", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertFundedJob(githubRecord);
  const poller = new UpstreamStatusPollerService(stateStore, undefined, {
    enabled: true,
    fetchImpl: async () => jsonResponse({ state: "closed", merged: true, merged_at: "2026-01-03T00:00:00Z" })
  });

  const run = await poller.runOnce(new Date("2026-01-04T00:00:00.000Z"));
  assert.equal(run.checked, 1);
  assert.equal(run.updated, 1);

  const updated = await stateStore.getFundedJob(githubRecord.jobId);
  assert.equal(updated.finalStatus, "merged");

  const report = await poller.generateWeeklyReport({
    now: new Date("2026-01-08T00:00:00.000Z"),
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-08T00:00:00.000Z"
  });
  assert.equal(report.mergeRate, 1);
  assert.equal(report.confirmedPayout, 5);
});

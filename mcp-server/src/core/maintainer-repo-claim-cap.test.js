import test from "node:test";
import assert from "node:assert/strict";

import { JobExecutionService } from "./job-execution-service.js";
import { MemoryStateStore } from "./state-store.js";
import {
  loadMaintainerRepoClaimCapConfig,
  measureMaintainerRepoClaimUsage,
  normalizeMaintainerRepoClaimCapConfig,
  verificationShowsMerged
} from "./maintainer-repo-claim-cap.js";
import { repositoryPinKey } from "../services/github-repository-identity-backfill.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REPO_ID = 424242;
const OTHER_REPO_ID = 989898;

function makeJob(overrides = {}) {
  return {
    id: "pr-review-job-001",
    category: "review",
    tier: "starter",
    rewardAsset: "DOT",
    rewardAmount: 6,
    verifierMode: "benchmark",
    verifierConfig: {
      version: 1,
      handler: "benchmark",
      requiredKeywords: ["summary", "findings", "risk_level"],
      minimumMatches: 2
    },
    outputSchemaRef: "schema://jobs/pr-review-findings-output",
    claimTtlSeconds: 3600,
    ...overrides
  };
}

function githubJob({
  id,
  repo = "example/project",
  repoId = REPO_ID,
  issueNumber = 1,
  optedIn = false,
  createdAt
} = {}) {
  return makeJob({
    id,
    source: {
      type: "github_issue",
      repo,
      issueNumber,
      ...(repoId == null ? {} : { githubRepoId: repoId }),
      ...(optedIn ? { maintainerPolicy: { optedIn: true } } : {})
    },
    ...(createdAt ? { lifecycle: { createdAt, state: "open" } } : {})
  });
}

function openPullRequest({ jobId, repo = "example/project", repoId = REPO_ID, pullNumber = 1, includeRepoId = true }) {
  return {
    jobId,
    finalStatus: "open",
    source: {
      type: "github_issue",
      repo,
      ...(includeRepoId ? { githubRepoId: repoId } : {})
    },
    upstream: {
      kind: "github_pull_request",
      repo,
      pullNumber
    }
  };
}

function claimedSession({
  sessionId,
  jobId,
  wallet = WALLET_2,
  repo = "example/project",
  repoId = REPO_ID,
  status = "claimed",
  chainClaimExpiresAt = "2099-01-01T00:00:00.000Z"
}) {
  return {
    sessionId,
    jobId,
    wallet,
    status,
    claimedAt: "2026-01-01T00:00:00.000Z",
    chainClaimExpiresAt,
    protocolHistory: ["http"],
    jobSnapshot: {
      version: "job-snapshot-v1",
      definition: githubJob({ id: jobId, repo, repoId, issueNumber: 50 })
    }
  };
}

function executionService(jobs, stateStore, { repoClaimCap, logs } = {}) {
  const map = new Map(jobs.map((job) => [job.id, job]));
  const config = {};
  if (repoClaimCap !== undefined) config.repoClaimCap = repoClaimCap;
  if (logs) {
    config.logger = {
      info(payload, message) {
        logs.push({ payload, message });
      }
    };
  }
  return new JobExecutionService(
    stateStore,
    undefined,
    (jobId) => map.get(jobId),
    undefined,
    undefined,
    undefined,
    (jobId) => map.get(jobId),
    undefined,
    config
  );
}

test("loadMaintainerRepoClaimCapConfig defaults to log and the 2/3/5 tiers", () => {
  const config = loadMaintainerRepoClaimCapConfig({});
  assert.equal(config.mode, "log");
  assert.equal(config.capNoMerge, 2);
  assert.equal(config.capMerged, 3);
  assert.equal(config.capOptedIn, 5);
  assert.equal(loadMaintainerRepoClaimCapConfig({
    MAINTAINER_REPO_CLAIM_CAP_MODE: "enforce",
    MAINTAINER_REPO_CAP_NO_MERGE: "4",
    MAINTAINER_REPO_CAP_MERGED: "0",
    MAINTAINER_REPO_CAP_OPTED_IN: "nope"
  }).mode, "enforce");
  assert.equal(loadMaintainerRepoClaimCapConfig({ MAINTAINER_REPO_CLAIM_CAP_MODE: "sometimes" }).mode, "log");
});

test("enforce mode refuses a third item on a no-merge repo and keeps a rejected open PR in the count", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertFundedJob(openPullRequest({ jobId: "rejected-open", pullNumber: 3 }));
  await stateStore.upsertSession({
    sessionId: "rejected-open-session",
    jobId: "rejected-open",
    wallet: WALLET,
    status: "submitted",
    jobSnapshot: {
      version: "job-snapshot-v1",
      definition: githubJob({ id: "rejected-open", issueNumber: 3 })
    }
  });
  await stateStore.upsertVerificationResult("rejected-open-session", {
    outcome: "rejected",
    signals: { merged: false },
    checks: { merged: false }
  });
  await stateStore.upsertSession(claimedSession({ sessionId: "active-claim", jobId: "active-job" }));
  for (let index = 0; index < 8; index += 1) {
    await stateStore.upsertFundedJob(openPullRequest({
      jobId: `other-${index}`,
      repo: "other/project",
      repoId: OTHER_REPO_ID,
      pullNumber: index + 1
    }));
  }
  const job = githubJob({ id: "third-claim", issueNumber: 9 });
  const service = executionService([job], stateStore, { repoClaimCap: { mode: "enforce" } });

  await assert.rejects(
    () => service.claimJob(WALLET, job.id, "http", "third-claim"),
    (error) => {
      assert.equal(error.code, "maintainer_repo_claim_cap_reached");
      assert.deepEqual(error.details, {
        repoId: REPO_ID,
        repo: "example/project",
        openPrs: 1,
        activeClaims: 1,
        cap: 2
      });
      return true;
    }
  );
  assert.equal(await stateStore.findSessionByJobId(job.id), undefined);
});

test("a merged Averray PR raises the cap so the third item is allowed and the fourth is refused", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertSession({
    sessionId: "merged-session",
    jobId: "merged-job",
    wallet: WALLET,
    status: "resolved",
    jobSnapshot: {
      version: "job-snapshot-v1",
      definition: githubJob({ id: "merged-job", issueNumber: 1 })
    }
  });
  await stateStore.upsertVerificationResult("merged-session", {
    outcome: "approved",
    signals: { merged: true }
  });
  await stateStore.upsertFundedJob(openPullRequest({ jobId: "open-a", pullNumber: 2 }));
  await stateStore.upsertFundedJob(openPullRequest({ jobId: "open-b", pullNumber: 3 }));
  const third = githubJob({ id: "third-item", issueNumber: 4 });
  const fourth = githubJob({ id: "fourth-item", issueNumber: 5 });
  const service = executionService([third, fourth], stateStore, { repoClaimCap: { mode: "enforce" } });

  const claimed = await service.claimJob(WALLET, third.id, "http", "third-item");
  assert.equal(claimed.jobId, third.id);

  await assert.rejects(
    () => service.claimJob(WALLET_2, fourth.id, "http", "fourth-item"),
    (error) => {
      assert.equal(error.code, "maintainer_repo_claim_cap_reached");
      assert.equal(error.details.cap, 3);
      assert.equal(error.details.openPrs, 2);
      assert.equal(error.details.activeClaims, 1);
      assert.equal(error.details.repoId, REPO_ID);
      return true;
    }
  );
});

test("an opted-in repo uses the higher cap", async () => {
  const stateStore = new MemoryStateStore();
  for (let index = 0; index < 4; index += 1) {
    await stateStore.upsertFundedJob(openPullRequest({ jobId: `open-${index}`, pullNumber: index + 1 }));
  }
  const fifth = githubJob({ id: "fifth-item", issueNumber: 11, optedIn: true });
  const sixth = githubJob({ id: "sixth-item", issueNumber: 12, optedIn: true });
  const service = executionService([fifth, sixth], stateStore, { repoClaimCap: { mode: "enforce" } });

  const claimed = await service.claimJob(WALLET, fifth.id, "http", "fifth-item");
  assert.equal(claimed.jobId, fifth.id);
  await assert.rejects(
    () => service.claimJob(WALLET_2, sixth.id, "http", "sixth-item"),
    (error) => error.code === "maintainer_repo_claim_cap_reached" && error.details.cap === 5
  );
});

test("two concurrent claims when one slot is free: exactly one succeeds", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertFundedJob(openPullRequest({ jobId: "open-1", pullNumber: 1 }));
  const firstJob = githubJob({ id: "race-1", issueNumber: 2 });
  const secondJob = githubJob({ id: "race-2", issueNumber: 3 });
  const service = executionService([firstJob, secondJob], stateStore, { repoClaimCap: { mode: "enforce" } });
  const original = stateStore.upsertSession.bind(stateStore);
  let releaseWrite;
  const writeGate = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  let signalEntered;
  const entered = new Promise((resolve) => {
    signalEntered = resolve;
  });
  let writes = 0;
  stateStore.upsertSession = async (session) => {
    writes += 1;
    if (writes === 1) {
      signalEntered();
      await writeGate;
    }
    return original(session);
  };

  const first = service.claimJob(WALLET, firstJob.id, "http", "race-1");
  await entered;
  await assert.rejects(
    () => service.claimJob(WALLET_2, secondJob.id, "http", "race-2"),
    (error) => error.code === "maintainer_repo_claim_cap_in_progress"
  );
  releaseWrite();
  const claimed = await first;
  assert.equal(claimed.jobId, firstJob.id);
  assert.equal(await stateStore.findSessionByJobId(secondJob.id), undefined);
});

test("log mode concurrent claims in one under-cap repo both succeed", async () => {
  const stateStore = new MemoryStateStore();
  const originalAcquire = stateStore.acquireClaimLock.bind(stateStore);
  stateStore.acquireClaimLock = async (lockId, owner, ttl) => {
    if (String(lockId).startsWith("maintainer-repo-claim:")) {
      throw new Error("log mode must not take the repo lock");
    }
    return originalAcquire(lockId, owner, ttl);
  };
  const firstJob = githubJob({ id: "log-race-1", issueNumber: 2 });
  const secondJob = githubJob({ id: "log-race-2", issueNumber: 3 });
  const service = executionService([firstJob, secondJob], stateStore, { repoClaimCap: { mode: "log" } });

  const results = await Promise.allSettled([
    service.claimJob(WALLET, firstJob.id, "http", "log-race-1"),
    service.claimJob(WALLET_2, secondJob.id, "http", "log-race-2")
  ]);

  assert.deepEqual(results.map((result) => result.status === "fulfilled" ? "ok" : result.reason?.code), ["ok", "ok"]);
  assert.equal(await stateStore.findSessionByJobId(firstJob.id) ? 1 : 0, 1);
  assert.equal(await stateStore.findSessionByJobId(secondJob.id) ? 1 : 0, 1);
});

test("an expired claim frees its slot without a sweep", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertFundedJob(openPullRequest({ jobId: "open-1", pullNumber: 1 }));
  await stateStore.upsertSession(claimedSession({
    sessionId: "expired-claim",
    jobId: "expired-job",
    chainClaimExpiresAt: "2020-01-01T01:00:00.000Z"
  }));
  const job = githubJob({ id: "after-expiry", issueNumber: 8 });
  const service = executionService([job], stateStore, { repoClaimCap: { mode: "enforce" } });

  const claimed = await service.claimJob(WALLET, job.id, "http", "after-expiry");
  assert.equal(claimed.jobId, job.id);
  assert.equal((await service.getMaintainerRepoClaimCapStatus()).wouldRefuse, 0);
});

test("a renamed repo keeps its count by repository id, including a name-only pin", async () => {
  const stateStore = new MemoryStateStore();
  const oldJob = githubJob({
    id: "old-issue",
    repo: "old/name",
    repoId: null,
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  await stateStore.putGithubRepositoryPin({
    key: repositoryPinKey(oldJob),
    source: { githubRepoId: REPO_ID },
    pinnedAt: "2026-02-01T00:00:00.000Z"
  });
  await stateStore.upsertFundedJob(openPullRequest({
    jobId: oldJob.id,
    repo: "old/name",
    includeRepoId: false,
    pullNumber: 4
  }));
  await stateStore.upsertSession(claimedSession({
    sessionId: "renamed-active",
    jobId: "renamed-active-job",
    repo: "new/name"
  }));
  const job = githubJob({ id: "renamed-third", repo: "new/name", issueNumber: 12 });
  const service = executionService([oldJob, job], stateStore, { repoClaimCap: { mode: "enforce" } });

  await assert.rejects(
    () => service.claimJob(WALLET, job.id, "http", "renamed-third"),
    (error) => {
      assert.equal(error.code, "maintainer_repo_claim_cap_reached");
      assert.equal(error.details.repoId, REPO_ID);
      assert.equal(error.details.repo, "new/name");
      assert.equal(error.details.openPrs, 1);
      assert.equal(error.details.activeClaims, 1);
      assert.equal(error.details.cap, 2);
      return true;
    }
  );
});

test("a name-only open PR that cannot be pinned is not counted toward the repo id", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertFundedJob(openPullRequest({
    jobId: "name-only",
    includeRepoId: false,
    pullNumber: 1
  }));
  await stateStore.upsertFundedJob(openPullRequest({ jobId: "known-open", pullNumber: 2 }));
  const job = githubJob({ id: "known-claim", issueNumber: 3 });
  const service = executionService([job], stateStore, { repoClaimCap: { mode: "enforce" } });

  const claimed = await service.claimJob(WALLET, job.id, "http", "known-claim");
  assert.equal(claimed.jobId, job.id);
});

test("items on a different repository id do not consume this repo's cap", async () => {
  const stateStore = new MemoryStateStore();
  for (let index = 0; index < 6; index += 1) {
    await stateStore.upsertFundedJob(openPullRequest({
      jobId: `other-${index}`,
      repo: "other/project",
      repoId: OTHER_REPO_ID,
      pullNumber: index + 1
    }));
  }
  const job = githubJob({ id: "this-repo", issueNumber: 1 });
  const service = executionService([job], stateStore, { repoClaimCap: { mode: "enforce" } });
  const claimed = await service.claimJob(WALLET, job.id, "http", "this-repo");
  assert.equal(claimed.jobId, job.id);
});

test("log mode never refuses and increments the would_refuse counter", async () => {
  const stateStore = new MemoryStateStore();
  const logs = [];
  await stateStore.upsertFundedJob(openPullRequest({ jobId: "open-1", pullNumber: 1 }));
  await stateStore.upsertSession(claimedSession({ sessionId: "active-claim", jobId: "active-job" }));
  const job = githubJob({ id: "logged-claim", issueNumber: 9 });
  const service = executionService([job], stateStore, { logs });

  const claimed = await service.claimJob(WALLET, job.id, "http", "logged-claim");
  assert.equal(claimed.status, "claimed");
  const status = await service.getMaintainerRepoClaimCapStatus();
  assert.equal(status.mode, "log");
  assert.equal(status.wouldRefuse, 1);
  assert.equal(logs.filter((entry) => entry.payload.event === "maintainer_repo_claim_cap_would_refuse").length, 1);
  assert.equal(logs.some((entry) => JSON.stringify(entry).includes(WALLET)), false);
  const persisted = await stateStore.getServiceState("maintainer-repo-claim-cap");
  assert.equal(persisted.wouldRefuse, 1);
});

test("the same wallet's active claim is returned when the repo is already at cap", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertFundedJob(openPullRequest({ jobId: "open-1", pullNumber: 1 }));
  const job = githubJob({ id: "held-claim", issueNumber: 2 });
  const service = executionService([job], stateStore, { repoClaimCap: { mode: "enforce" } });
  const first = await service.claimJob(WALLET, job.id, "http", "held-claim");
  const retry = await service.claimJob(WALLET, job.id, "http", "held-claim-retry");
  assert.equal(retry.sessionId, first.sessionId);
  assert.equal((await service.getMaintainerRepoClaimCapStatus()).wouldRefuse, 0);
});

test("non-GitHub jobs are unaffected by the repo cap", async () => {
  const stateStore = new MemoryStateStore();
  const logs = [];
  await stateStore.upsertFundedJob(openPullRequest({ jobId: "open-1", pullNumber: 1 }));
  await stateStore.upsertFundedJob(openPullRequest({ jobId: "open-2", pullNumber: 2 }));
  const job = makeJob({
    id: "wiki-job",
    source: { type: "wikipedia", repo: "example/project", githubRepoId: REPO_ID }
  });
  const service = executionService([job], stateStore, { repoClaimCap: { mode: "enforce" }, logs });
  const claimed = await service.claimJob(WALLET, job.id, "http", "wiki-job");
  assert.equal(claimed.jobId, job.id);
  assert.equal((await service.getMaintainerRepoClaimCapStatus()).wouldRefuse, 0);
  assert.equal(logs.some((entry) => String(entry.payload?.event ?? "").startsWith("maintainer_repo_claim_cap")), false);
});

test("a rejected verification with signals.merged does not raise the cap", () => {
  assert.equal(verificationShowsMerged({
    outcome: "rejected",
    signals: { merged: true },
    checks: { merged: true },
    reputationSignals: { merged: 1 },
    githubLookup: { merged: true }
  }), false);
});

test("a rejected merged signal still leaves a no-merge repo on cap 2", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertSession({
    sessionId: "rejected-merged",
    jobId: "rejected-merged-job",
    wallet: WALLET,
    status: "resolved",
    jobSnapshot: {
      version: "job-snapshot-v1",
      definition: githubJob({ id: "rejected-merged-job", issueNumber: 1 })
    }
  });
  await stateStore.upsertVerificationResult("rejected-merged", {
    outcome: "rejected",
    signals: { merged: true }
  });
  await stateStore.upsertFundedJob(openPullRequest({ jobId: "open-a", pullNumber: 2 }));
  await stateStore.upsertFundedJob(openPullRequest({ jobId: "open-b", pullNumber: 3 }));
  const job = githubJob({ id: "third-after-rejection", issueNumber: 4 });
  const service = executionService([job], stateStore, { repoClaimCap: { mode: "enforce" } });

  await assert.rejects(
    () => service.claimJob(WALLET, job.id, "http", "third-after-rejection"),
    (error) => error.code === "maintainer_repo_claim_cap_reached" && error.details.cap === 2
  );
});

test("wouldRefuse increments only after the claim is dispatched", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertFundedJob(openPullRequest({ jobId: "open-1", pullNumber: 1 }));
  await stateStore.upsertSession(claimedSession({ sessionId: "active-claim", jobId: "active-job" }));
  const job = githubJob({ id: "dispatch-fails", issueNumber: 9 });
  const service = executionService([job], stateStore, { repoClaimCap: { mode: "log" } });
  const original = stateStore.upsertSession.bind(stateStore);
  stateStore.upsertSession = async (session) => {
    if (session.jobId === job.id) throw new Error("dispatch failed");
    return original(session);
  };

  await assert.rejects(() => service.claimJob(WALLET, job.id, "http", "dispatch-fails"), /dispatch failed/);
  assert.equal((await service.getMaintainerRepoClaimCapStatus()).wouldRefuse, 0);
});

test("a claim without a repository id increments the ambiguous counter", async () => {
  const stateStore = new MemoryStateStore();
  const logs = [];
  const job = githubJob({ id: "no-repo-id", repoId: null, issueNumber: 1 });
  const service = executionService([job], stateStore, { repoClaimCap: { mode: "log" }, logs });

  const claimed = await service.claimJob(WALLET, job.id, "http", "no-repo-id");
  assert.equal(claimed.jobId, job.id);
  const status = await service.getMaintainerRepoClaimCapStatus();
  assert.equal(status.ambiguous, 1);
  assert.equal(status.wouldRefuse, 0);
  assert.equal(logs.filter((entry) => entry.payload.event === "maintainer_repo_claim_cap_ambiguous").length, 1);
});

test("a truncated scan is unmeasured so an unseen merge cannot lower the tier", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertFundedJob(openPullRequest({ jobId: "visible", pullNumber: 1 }));
  await stateStore.upsertFundedJob({
    jobId: "older-merge",
    finalStatus: "merged",
    source: { type: "github_issue", repo: "example/project", githubRepoId: REPO_ID },
    upstream: { kind: "github_pull_request", repo: "example/project", pullNumber: 2 }
  });
  const usage = await measureMaintainerRepoClaimUsage({
    stateStore,
    repoId: REPO_ID,
    caps: normalizeMaintainerRepoClaimCapConfig({}),
    maxRows: 1
  });
  assert.equal(usage.measured, false);
  assert.equal(usage.hasMerged, "not reported");
  assert.equal(usage.cap, "not reported");
  assert.equal(usage.openPrs, "not reported");
});

test("pin lookups are memoized and expired claims are not pinned", async () => {
  const stateStore = new MemoryStateStore();
  const pinnedJob = githubJob({
    id: "pinned-issue",
    repo: "old/name",
    repoId: null,
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  await stateStore.putGithubRepositoryPin({
    key: repositoryPinKey(pinnedJob),
    source: { githubRepoId: REPO_ID },
    pinnedAt: "2026-02-01T00:00:00.000Z"
  });
  await stateStore.upsertFundedJob(openPullRequest({
    jobId: pinnedJob.id,
    repo: "old/name",
    includeRepoId: false,
    pullNumber: 4
  }));
  await stateStore.upsertSession({
    sessionId: "pinned-resolved",
    jobId: pinnedJob.id,
    wallet: WALLET,
    status: "resolved",
    jobSnapshot: { version: "job-snapshot-v1", definition: pinnedJob }
  });
  await stateStore.upsertSession(claimedSession({
    sessionId: "expired-unpinned",
    jobId: "expired-unpinned-job",
    repo: "old/name",
    repoId: null,
    chainClaimExpiresAt: "2020-01-01T01:00:00.000Z"
  }));
  let pins = 0;
  const original = stateStore.getGithubRepositoryPin.bind(stateStore);
  stateStore.getGithubRepositoryPin = async (key) => {
    pins += 1;
    return original(key);
  };
  const usage = await measureMaintainerRepoClaimUsage({
    stateStore,
    repoId: REPO_ID,
    getJobDefinition: (jobId) => jobId === pinnedJob.id ? pinnedJob : undefined,
    caps: normalizeMaintainerRepoClaimCapConfig({})
  });
  assert.equal(pins, 1);
  assert.equal(usage.openPrs, 1);
  assert.equal(usage.activeClaims, 0);
  assert.equal(usage.measured, true);
});

test("a merged funded job raises the cap without reading verifications", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertFundedJob({
    jobId: "merged-funded",
    finalStatus: "merged",
    source: { type: "github_issue", repo: "example/project", githubRepoId: REPO_ID },
    upstream: { kind: "github_pull_request", repo: "example/project", pullNumber: 1 }
  });
  await stateStore.upsertFundedJob(openPullRequest({ jobId: "open-a", pullNumber: 2 }));
  await stateStore.upsertFundedJob(openPullRequest({ jobId: "open-b", pullNumber: 3 }));
  await stateStore.upsertSession({
    sessionId: "resolved-session",
    jobId: "resolved-job",
    wallet: WALLET,
    status: "resolved",
    jobSnapshot: {
      version: "job-snapshot-v1",
      definition: githubJob({ id: "resolved-job", issueNumber: 8 })
    }
  });
  let verificationReads = 0;
  const original = stateStore.getVerificationResult.bind(stateStore);
  stateStore.getVerificationResult = async (sessionId) => {
    verificationReads += 1;
    return original(sessionId);
  };
  const caps = normalizeMaintainerRepoClaimCapConfig({});
  const usage = await measureMaintainerRepoClaimUsage({
    stateStore,
    repoId: REPO_ID,
    caps
  });
  assert.equal(verificationReads, 0);
  assert.equal(usage.hasMerged, true);
  assert.equal(usage.cap, 3);
  stateStore.getVerificationResult = original;
  const third = githubJob({ id: "third-from-funded-merge", issueNumber: 9 });
  const service = executionService([third], stateStore, { repoClaimCap: { mode: "enforce" } });
  const claimed = await service.claimJob(WALLET, third.id, "http", "third-from-funded-merge");
  assert.equal(claimed.jobId, third.id);
});

test("submitWork still enforces the open-PR backstop", async () => {
  const stateStore = new MemoryStateStore();
  for (let index = 0; index < 3; index += 1) {
    await stateStore.upsertFundedJob({
      jobId: `existing-${index}`,
      finalStatus: "open",
      upstream: {
        kind: "github_pull_request",
        repo: "example/project",
        pullNumber: index + 1
      }
    });
  }
  const job = githubJob({ id: "submit-backstop", repoId: null, issueNumber: 42 });
  job.outputSchemaRef = "schema://jobs/github-pr-evidence-output";
  const service = executionService([job], stateStore, { repoClaimCap: { mode: "enforce" } });
  const claimed = await service.claimJob(WALLET, job.id, "http", "submit-backstop");
  await assert.rejects(
    () => service.submitWork(claimed.sessionId, "http", {
      prUrl: "https://github.com/example/project/pull/4",
      summary: "Adds the requested parser regression test.",
      tests: "npm test"
    }),
    (error) => error.code === "maintainer_open_pr_cap_reached"
  );
});

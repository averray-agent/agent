import test from "node:test";
import assert from "node:assert/strict";

import { JobExecutionService } from "./job-execution-service.js";
import { MemoryStateStore } from "./state-store.js";
import { measureMaintainerRepoClaimUsage } from "./maintainer-repo-claim-cap.js";
import { buildJobSnapshot } from "./job-snapshot.js";
import { normalizeSubmission } from "./submission.js";
import { VerifierService } from "../services/verifier-service.js";
import { VerifierRegistry } from "../services/verifier-handlers.js";
import {
  classifyMaintainerClose,
  clearMaintainerRepoCooldown,
  getMaintainerRepoCooldown,
  loadMaintainerRepoCooldownConfig,
  maintainerRepoCooldownScope,
  observeMaintainerPullRequest,
  readCooldownDecision,
  readMaintainerRepoCooldownCounters,
  recordMaintainerClose,
  recordMaintainerStopSignal
} from "./maintainer-repo-cooldown.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_WALLET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REPO_ID = 424242;
const NOW = new Date("2026-10-14T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const CLAIMED_AT = "2026-10-01T00:00:00.000Z";
const CLOSED_AT = "2026-10-10T00:00:00.000Z";

function closedLookup({
  pullNumber = 9,
  repoId = REPO_ID,
  fullName = "new/name",
  merged = false,
  state = "closed",
  closedAt = CLOSED_AT,
  author = "worker",
  closedBy = "maintainer",
  binding = "matched"
} = {}) {
  return {
    status: "verified",
    state,
    merged,
    pullNumber,
    closedAt,
    author: author ? { login: author } : null,
    closedBy: closedBy ? { login: closedBy } : null,
    claimantBinding: binding ? { status: binding } : null,
    baseRepo: { id: repoId, fullName }
  };
}

function executionService(jobs, stateStore, { repoCooldown, logs } = {}) {
  const map = new Map(jobs.map((job) => [job.id, job]));
  const config = {};
  if (repoCooldown !== undefined) config.repoCooldown = repoCooldown;
  if (logs) {
    config.logger = {
      info(payload, message) { logs.push({ payload, message }); },
      warn(payload, message) { logs.push({ payload, message }); }
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

function githubJob({ id, repo = "old/name", repoId = REPO_ID, issueNumber = 1 } = {}) {
  return {
    id,
    category: "review",
    tier: "starter",
    rewardAsset: "DOT",
    rewardAmount: 6,
    verifierMode: "benchmark",
    verifierConfig: { version: 1, handler: "benchmark", requiredKeywords: ["summary"], minimumMatches: 1 },
    claimTtlSeconds: 3600,
    source: {
      type: "github_issue",
      repo,
      issueNumber,
      ...(repoId == null ? {} : { githubRepoId: repoId })
    }
  };
}

test("loadMaintainerRepoCooldownConfig defaults to log, 7 days, and 30 days", () => {
  const config = loadMaintainerRepoCooldownConfig({});
  assert.equal(config.mode, "log");
  assert.equal(config.days, 7);
  assert.equal(config.repeatDays, 30);
  assert.deepEqual(loadMaintainerRepoCooldownConfig({
    MAINTAINER_REPO_COOLDOWN_MODE: "enforce",
    MAINTAINER_REPO_COOLDOWN_DAYS: "9",
    MAINTAINER_REPO_COOLDOWN_REPEAT_DAYS: "11"
  }), { mode: "enforce", days: 9, repeatDays: 11 });
  assert.equal(loadMaintainerRepoCooldownConfig({
    MAINTAINER_REPO_COOLDOWN_MODE: "sometimes",
    MAINTAINER_REPO_COOLDOWN_DAYS: "0",
    MAINTAINER_REPO_COOLDOWN_REPEAT_DAYS: "nope"
  }).mode, "log");
  assert.equal(loadMaintainerRepoCooldownConfig({ MAINTAINER_REPO_COOLDOWN_DAYS: "0" }).days, 7);
});

test("a first maintainer close sets 7 days and a second within 30 days sets 30", async () => {
  const stateStore = new MemoryStateStore();
  const config = { mode: "log", days: 7, repeatDays: 30 };
  const first = await recordMaintainerClose({
    stateStore, repoId: REPO_ID, fullName: "old/name", pullNumber: 1, now: NOW, config
  });
  assert.equal(first.record.cooldownUntil, new Date(NOW.getTime() + 7 * DAY).toISOString());
  assert.equal(first.record.cooldownReason, "maintainer_close");
  assert.equal(first.record.closeCount30d, 1);
  assert.equal(first.record.lastMaintainerCloseAt, NOW.toISOString());

  const repeatRead = await recordMaintainerClose({
    stateStore, repoId: REPO_ID, fullName: "new/name", pullNumber: 1, now: new Date(NOW.getTime() + DAY), config
  });
  assert.equal(repeatRead.record.cooldownUntil, first.record.cooldownUntil);
  assert.equal(repeatRead.record.fullName, "new/name");
  assert.equal(repeatRead.record.closeCount30d, 1);

  const secondAt = new Date(NOW.getTime() + 6 * DAY);
  const second = await recordMaintainerClose({
    stateStore, repoId: REPO_ID, fullName: "new/name", pullNumber: 2, now: secondAt, config
  });
  assert.equal(second.record.cooldownUntil, new Date(secondAt.getTime() + 30 * DAY).toISOString());
  assert.equal(second.record.cooldownReason, "maintainer_close_repeat");
  assert.equal(second.record.closeCount30d, 2);

  const outside = await recordMaintainerClose({
    stateStore,
    repoId: REPO_ID,
    pullNumber: 3,
    now: new Date(secondAt.getTime() + 31 * DAY),
    config
  });
  assert.equal(outside.record.cooldownReason, "maintainer_close");
  assert.equal(outside.record.closeCount30d, 1);
});

test("a stop signal sets indefinite and only the operator clear removes it", async () => {
  const stateStore = new MemoryStateStore();
  const logs = [];
  const logger = { info(payload, message) { logs.push({ payload, message }); } };
  const stopped = await recordMaintainerStopSignal({
    stateStore, repoId: REPO_ID, fullName: "old/name", source: "policy:CONTRIBUTING.md", now: NOW
  });
  assert.equal(stopped.record.cooldownUntil, "indefinite");
  assert.equal(stopped.record.cooldownReason, "maintainer_stop_signal");
  assert.equal(readCooldownDecision(stopped.record, new Date(NOW.getTime() + 100 * DAY)).active, true);

  const closed = await recordMaintainerClose({
    stateStore, repoId: REPO_ID, pullNumber: 4, now: new Date(NOW.getTime() + DAY), config: { days: 7, repeatDays: 30 }
  });
  assert.equal(closed.record.cooldownUntil, "indefinite");
  assert.equal(closed.record.cooldownReason, "maintainer_stop_signal");

  await assert.rejects(
    () => clearMaintainerRepoCooldown({ stateStore, repoId: REPO_ID, actor: WALLET, reason: "" }),
    (error) => error.name === "ValidationError"
  );
  assert.equal((await getMaintainerRepoCooldown(stateStore, REPO_ID)).cooldownUntil, "indefinite");

  const cleared = await clearMaintainerRepoCooldown({
    stateStore,
    repoId: REPO_ID,
    actor: WALLET,
    reason: "maintainer asked us to resume",
    now: new Date(NOW.getTime() + 2 * DAY),
    logger
  });
  assert.deepEqual(cleared, {
    repoId: REPO_ID,
    cleared: true,
    cooldownUntil: null,
    cooldownReason: null,
    closeCount30d: 1
  });
  assert.equal(JSON.stringify(cleared).includes(WALLET), false);
  assert.equal(JSON.stringify(cleared).includes("old/name"), false);
  assert.equal(logs[0].payload.event, "maintainer_repo_cooldown_cleared");
  assert.equal(logs[0].payload.actor, WALLET);
  assert.equal(logs[0].payload.reason, "maintainer asked us to resume");
  assert.equal(readCooldownDecision(await getMaintainerRepoCooldown(stateStore, REPO_ID), NOW).active, false);
  const again = await clearMaintainerRepoCooldown({
    stateStore, repoId: REPO_ID, actor: WALLET, reason: "clear again", now: new Date(NOW.getTime() + 3 * DAY)
  });
  assert.equal(again.cleared, true);
  assert.equal(again.cooldownUntil, null);

  const rearmed = await recordMaintainerStopSignal({
    stateStore, repoId: REPO_ID, source: "policy:CONTRIBUTING.md", now: new Date(NOW.getTime() + 4 * DAY)
  });
  assert.equal(rearmed.status, "ignored");
  assert.equal(rearmed.reason, "stop_source_acknowledged");
  assert.equal((await getMaintainerRepoCooldown(stateStore, REPO_ID)).cooldownUntil, null);

  const fresh = await recordMaintainerStopSignal({
    stateStore, repoId: REPO_ID, source: "policy:CODE_OF_CONDUCT.md", now: new Date(NOW.getTime() + 5 * DAY)
  });
  assert.equal(fresh.record.cooldownUntil, "indefinite");
  assert.equal(readCooldownDecision(await getMaintainerRepoCooldown(stateStore, REPO_ID)).active, true);

  await assert.rejects(
    () => clearMaintainerRepoCooldown({
      stateStore, repoId: 999, actor: WALLET, reason: "missing"
    }),
    (error) => error.code === "maintainer_repo_cooldown_not_found"
  );
});

test("our own rejection of an open pull request sets no cooldown and still counts toward the cap", async () => {
  const stateStore = new MemoryStateStore();
  const observed = await observeMaintainerPullRequest({
    stateStore,
    lookup: closedLookup({ state: "open", merged: false }),
    job: githubJob({ id: "open-pr" }),
    now: NOW
  });
  assert.equal(observed.status, "ignored");
  assert.equal(observed.reason, "pull_request_open");
  assert.equal(await getMaintainerRepoCooldown(stateStore, REPO_ID), null);

  await stateStore.upsertFundedJob({
    jobId: "rejected-open",
    finalStatus: "open",
    source: { type: "github_issue", repo: "old/name", githubRepoId: REPO_ID },
    upstream: { kind: "github_pull_request", repo: "old/name", pullNumber: 3 }
  });
  await stateStore.upsertVerificationResult("rejected-open-session", {
    outcome: "rejected",
    githubLookup: { state: "open", merged: false }
  });
  const usage = await measureMaintainerRepoClaimUsage({
    stateStore,
    repoId: REPO_ID,
    claimingJob: githubJob({ id: "next" }),
    caps: { capNoMerge: 2, capMerged: 3, capOptedIn: 5 }
  });
  assert.equal(usage.openPrs, 1);
  assert.equal(await getMaintainerRepoCooldown(stateStore, REPO_ID), null);
});

test("an expired claim and a close without a pull request set no cooldown", async () => {
  const stateStore = new MemoryStateStore();
  const expired = await observeMaintainerPullRequest({
    stateStore,
    lookup: closedLookup(),
    claimExpired: true,
    sessionStatus: "expired",
    now: NOW
  });
  assert.equal(expired.reason, "expired_claim");
  assert.equal(await getMaintainerRepoCooldown(stateStore, REPO_ID), null);

  const job = githubJob({ id: "expired-job" });
  const service = executionService([job], stateStore, { repoCooldown: { mode: "enforce" } });
  const claimed = await service.claimJob(WALLET, job.id, "http", "expire-me");
  const expiredSession = await service.materializeExpiredClaim({
    ...claimed,
    chainClaimExpiresAt: "2020-01-01T00:00:00.000Z"
  }, job, NOW);
  assert.equal(expiredSession.status, "expired");
  assert.equal(await getMaintainerRepoCooldown(stateStore, REPO_ID), null);

  const noPull = await observeMaintainerPullRequest({
    stateStore,
    lookup: { status: "verified", state: "closed", merged: false, baseRepo: { id: REPO_ID } },
    now: NOW
  });
  assert.equal(noPull.status, "ambiguous");
  assert.equal(noPull.reason, "pull_number_missing");
  assert.equal(await getMaintainerRepoCooldown(stateStore, REPO_ID), null);
  assert.equal((await readMaintainerRepoCooldownCounters(stateStore)).ambiguous, 1);

  const unknownMerge = await observeMaintainerPullRequest({
    stateStore,
    lookup: { status: "verified", state: "closed", pullNumber: 8, baseRepo: { id: REPO_ID } },
    now: NOW
  });
  assert.equal(unknownMerge.reason, "merge_unreported");
  assert.equal(await getMaintainerRepoCooldown(stateStore, REPO_ID), null);
  assert.equal((await readMaintainerRepoCooldownCounters(stateStore)).wouldRefuse, 0);
});

test("a renamed repository keeps the cooldown stored for its id", async () => {
  const stateStore = new MemoryStateStore();
  await recordMaintainerClose({
    stateStore, repoId: REPO_ID, fullName: "old/name", pullNumber: 5, now: NOW, config: { days: 7, repeatDays: 30 }
  });
  const logs = [];
  const job = githubJob({ id: "renamed-claim", repo: "new/name", repoId: REPO_ID });
  const service = executionService([job], stateStore, { repoCooldown: { mode: "enforce" }, logs });
  await assert.rejects(
    () => service.claimJob(WALLET, job.id, "http", "renamed-claim"),
    (error) => {
      assert.equal(error.code, "maintainer_repo_cooldown");
      assert.deepEqual(error.details, {
        repoId: REPO_ID,
        cooldownUntil: new Date(NOW.getTime() + 7 * DAY).toISOString(),
        reason: "maintainer_close"
      });
      assert.equal(JSON.stringify(error.details).includes("new/name"), false);
      assert.equal(JSON.stringify(error.details).includes(WALLET), false);
      return true;
    }
  );
  assert.equal(logs.length, 0);
  assert.equal((await service.getMaintainerRepoCooldownStatus()).wouldRefuse, 0);
  const stored = await getMaintainerRepoCooldown(stateStore, REPO_ID);
  assert.equal(stored.repoId, REPO_ID);
  assert.equal(stored.cooldownReason, "maintainer_close");
});

test("log mode never refuses a cooled-down repository and increments wouldRefuse", async () => {
  const stateStore = new MemoryStateStore();
  const logs = [];
  await recordMaintainerClose({
    stateStore, repoId: REPO_ID, fullName: "old/name", pullNumber: 5, now: NOW, config: { days: 7, repeatDays: 30 }
  });
  const job = githubJob({ id: "logged-claim", repo: "new/name" });
  const service = executionService([job], stateStore, { logs });
  const claimed = await service.claimJob(WALLET, job.id, "http", "logged-claim");
  assert.equal(claimed.status, "claimed");
  const status = await service.getMaintainerRepoCooldownStatus();
  assert.equal(status.mode, "log");
  assert.equal(status.wouldRefuse, 1);
  assert.equal(status.ambiguous, 0);
  assert.equal(status.wouldRefuseClaim, 1);
  assert.equal(status.wouldRefuseIngest, 0);
  assert.deepEqual(Object.keys(status).sort(), [
    "ambiguous", "days", "mode", "repeatDays", "wouldRefuse", "wouldRefuseClaim", "wouldRefuseIngest"
  ]);
  assert.equal(logs.filter((entry) => entry.payload.event === "maintainer_repo_cooldown_would_refuse").length, 1);
  assert.equal(logs.some((entry) => JSON.stringify(entry).includes(WALLET)), false);
  assert.equal(logs.some((entry) => JSON.stringify(entry).includes("old/name")), false);
});

test("an unattributed GitHub repository stays ambiguous and a non-GitHub job is unaffected", async () => {
  const stateStore = new MemoryStateStore();
  await recordMaintainerClose({
    stateStore, repoId: REPO_ID, pullNumber: 1, now: NOW, config: { days: 7, repeatDays: 30 }
  });
  const unnamed = githubJob({ id: "unnamed", repo: "old/name", repoId: null });
  const other = {
    id: "benchmark-job",
    category: "review",
    tier: "starter",
    rewardAsset: "DOT",
    rewardAmount: 6,
    verifierMode: "benchmark",
    verifierConfig: { version: 1, handler: "benchmark", requiredKeywords: ["summary"], minimumMatches: 1 },
    claimTtlSeconds: 3600
  };
  const service = executionService([unnamed, other], stateStore, { repoCooldown: { mode: "enforce" } });
  const claimed = await service.claimJob(WALLET, unnamed.id, "http", "unnamed");
  assert.equal(claimed.status, "claimed");
  assert.equal((await service.getMaintainerRepoCooldownStatus()).ambiguous, 1);
  const benchmark = await service.claimJob(OTHER_WALLET, other.id, "http", "benchmark");
  assert.equal(benchmark.status, "claimed");
  assert.equal(classifyMaintainerClose(
    { status: "verified", state: "closed", merged: false, pullNumber: 2 },
    { source: { type: "github_issue", repo: "old/name" } }
  ).reason, "repo_unattributed");
});

test("a failed counter read is not reported as zero", async () => {
  const status = await readMaintainerRepoCooldownCounters({
    getServiceState: async () => { throw new Error("store down"); }
  });
  assert.equal(status.wouldRefuse, "not reported");
  assert.equal(status.wouldRefuseClaim, "not reported");
  assert.equal(status.wouldRefuseIngest, "not reported");
  assert.equal(status.ambiguous, "not reported");
});

test("verifier preview does not start a cooldown, and a maintainer close observed at verification does", async () => {
  const stateStore = new MemoryStateStore();
  const job = {
    id: "pr",
    title: "pr",
    rewardAmount: 1,
    rewardAsset: "USDC",
    verifierMode: "github_pr",
    source: { type: "github_issue", repo: "old/name", issueNumber: 1, githubRepoId: REPO_ID },
    verifierConfig: { handler: "github_pr", version: 1, minimumScore: 80 }
  };
  await stateStore.upsertSession({
    sessionId: "pr",
    jobId: "pr",
    status: "submitted",
    wallet: WALLET,
    claimedAt: CLAIMED_AT,
    submittedAt: CLAIMED_AT,
    jobSnapshot: buildJobSnapshot(job),
    submission: normalizeSubmission({
      prUrl: "https://github.com/old/name/pull/9",
      summary: "Fix issue #1",
      tests: "Local test passed"
    })
  });
  const closed = closedLookup();
  const registry = { evaluate: async () => ({ outcome: "rejected", handler: "github_pr", githubLookup: closed }) };
  const verifier = new VerifierService({ resumeSession: (id) => stateStore.getSession(id) }, stateStore, undefined, registry);
  const preview = await verifier.previewSubmission({ sessionId: "pr" });
  assert.equal(preview.preview, true);
  assert.equal(await getMaintainerRepoCooldown(stateStore, REPO_ID), null);

  await assert.rejects(() => verifier.verifySubmission({ sessionId: "pr" }));
  const record = await getMaintainerRepoCooldown(stateStore, REPO_ID);
  assert.equal(record.cooldownReason, "maintainer_close");
  assert.equal(record.repoId, REPO_ID);
  assert.equal(record.cooldownUntil, new Date(Date.parse(CLOSED_AT) + 7 * DAY).toISOString());
  assert.equal(record.fullName, "new/name");
  assert.equal(record.author, undefined);
  assert.equal(record.closedBy, undefined);
  assert.equal(JSON.stringify(record).includes("worker"), false);
  assert.equal(await stateStore.getServiceState(maintainerRepoCooldownScope(REPO_ID)).then((row) => row.cooldownReason), "maintainer_close");

  const openStore = new MemoryStateStore();
  await openStore.upsertSession(await stateStore.getSession("pr"));
  const openRegistry = {
    evaluate: async () => ({
      outcome: "rejected",
      handler: "github_pr",
      githubLookup: closedLookup({ state: "open" })
    })
  };
  const openVerifier = new VerifierService(
    { resumeSession: (id) => openStore.getSession(id) },
    openStore,
    undefined,
    openRegistry
  );
  await assert.rejects(() => openVerifier.verifySubmission({ sessionId: "pr" }));
  assert.equal(await getMaintainerRepoCooldown(openStore, REPO_ID), null);
});

test("a close counts only for a matched footer, a later maintainer close, and the pull request's own repository", async () => {
  const stateStore = new MemoryStateStore();
  const job = githubJob({ id: "bound", repo: "old/name" });
  const observedAt = new Date("2026-10-20T00:00:00.000Z");
  const cases = [
    ["claimant_unbound", closedLookup({ binding: "missing" })],
    ["closed_at_unreported", closedLookup({ closedAt: null })],
    ["closed_before_claim", closedLookup({ closedAt: "2026-09-01T00:00:00.000Z" })],
    ["closed_by_unreported", closedLookup({ closedBy: null })],
    ["closed_by_author", closedLookup({ author: "worker", closedBy: "worker" })],
    ["pull_request_merged", closedLookup({ merged: true })],
    ["repo_id_conflict", closedLookup({ repoId: 999 })]
  ];
  for (const [reason, lookup] of cases) {
    const result = await observeMaintainerPullRequest({
      stateStore,
      lookup,
      job,
      claimedAt: CLAIMED_AT,
      now: observedAt
    });
    assert.equal(result.reason, reason, reason);
    assert.notEqual(result.status, "recorded", reason);
  }
  assert.equal(await getMaintainerRepoCooldown(stateStore, REPO_ID), null);
  assert.equal(await getMaintainerRepoCooldown(stateStore, 999), null);

  const recorded = await observeMaintainerPullRequest({
    stateStore,
    lookup: closedLookup(),
    job,
    claimedAt: CLAIMED_AT,
    now: observedAt
  });
  assert.equal(recorded.status, "recorded");
  assert.equal(recorded.record.cooldownUntil, new Date(Date.parse(CLOSED_AT) + 7 * DAY).toISOString());
  assert.equal(recorded.record.fullName, "new/name");
  assert.notEqual(recorded.record.cooldownUntil, new Date(observedAt.getTime() + 7 * DAY).toISOString());
});

test("the same pull request re-observed on days 0, 31 and 62 counts once and never extends", async () => {
  const stateStore = new MemoryStateStore();
  const config = { days: 7, repeatDays: 30 };
  const first = await recordMaintainerClose({
    stateStore, repoId: REPO_ID, pullNumber: 9, closedAt: NOW, now: NOW, config
  });
  const until = first.record.cooldownUntil;
  assert.equal(until, new Date(NOW.getTime() + 7 * DAY).toISOString());
  for (const day of [31, 62]) {
    const again = await recordMaintainerClose({
      stateStore,
      repoId: REPO_ID,
      pullNumber: 9,
      closedAt: NOW,
      now: new Date(NOW.getTime() + day * DAY),
      config
    });
    assert.equal(again.record.cooldownUntil, until);
    assert.equal(again.record.closeCount30d, 1);
  }
  const stored = await getMaintainerRepoCooldown(stateStore, REPO_ID);
  assert.deepEqual(stored.countedPullKeys, [`${REPO_ID}#9`]);
});

test("cooldown expiry is inactive at the exact end and the 30 day window excludes an exact boundary", async () => {
  const until = new Date(NOW.getTime() + 7 * DAY).toISOString();
  assert.equal(readCooldownDecision({ cooldownUntil: until, cooldownReason: "maintainer_close" }, new Date(until)).active, false);
  assert.equal(readCooldownDecision({
    cooldownUntil: until,
    cooldownReason: "maintainer_close"
  }, new Date(Date.parse(until) - 1)).active, true);

  const stateStore = new MemoryStateStore();
  const config = { days: 7, repeatDays: 30 };
  await recordMaintainerClose({ stateStore, repoId: REPO_ID, pullNumber: 1, closedAt: NOW, now: NOW, config });
  const exact = await recordMaintainerClose({
    stateStore,
    repoId: REPO_ID,
    pullNumber: 2,
    closedAt: new Date(NOW.getTime() + 30 * DAY),
    now: new Date(NOW.getTime() + 30 * DAY),
    config
  });
  assert.equal(exact.record.closeCount30d, 1);
  assert.equal(exact.record.cooldownReason, "maintainer_close");
  const inside = await recordMaintainerClose({
    stateStore,
    repoId: REPO_ID,
    pullNumber: 3,
    closedAt: new Date(NOW.getTime() + 30 * DAY - 1),
    now: new Date(NOW.getTime() + 30 * DAY - 1),
    config
  });
  assert.equal(inside.record.closeCount30d, 2);
  assert.equal(inside.record.cooldownReason, "maintainer_close_repeat");
});

test("a contended cooldown lock is retried and then logged instead of dropping the close silently", async () => {
  const logs = [];
  const logger = { warn(payload, message) { logs.push({ payload, message }); } };
  let attempts = 0;
  const blocking = {
    async acquireClaimLock() {
      attempts += 1;
      return false;
    },
    async releaseClaimLock() {},
    async getServiceState() { throw new Error("should not read"); },
    async upsertServiceState() { throw new Error("should not write"); }
  };
  const blocked = await recordMaintainerClose({
    stateStore: blocking, repoId: REPO_ID, pullNumber: 4, now: NOW, logger
  });
  assert.equal(blocked.status, "contended");
  assert.ok(attempts > 1);
  assert.equal(logs.at(-1).payload.event, "maintainer_repo_cooldown_lock_contended");
  assert.equal(logs.at(-1).payload.repoId, REPO_ID);

  const stateStore = new MemoryStateStore();
  let claims = 0;
  const original = stateStore.acquireClaimLock.bind(stateStore);
  stateStore.acquireClaimLock = async (...args) => {
    claims += 1;
    if (claims < 3) return false;
    return original(...args);
  };
  const recorded = await recordMaintainerClose({
    stateStore, repoId: REPO_ID, pullNumber: 4, now: NOW, config: { days: 7, repeatDays: 30 }
  });
  assert.equal(recorded.status, "recorded");
  assert.equal(recorded.record.cooldownReason, "maintainer_close");
});

test("a failed cooldown read allows the claim and a failed counter write does not undo it", async () => {
  const logs = [];
  const stateStore = new MemoryStateStore();
  await recordMaintainerClose({
    stateStore, repoId: REPO_ID, pullNumber: 5, now: NOW, config: { days: 7, repeatDays: 30 }
  });
  const originalGet = stateStore.getServiceState.bind(stateStore);
  const originalUpsert = stateStore.upsertServiceState.bind(stateStore);
  stateStore.getServiceState = async (scope) => {
    if (scope === `maintainer-repo-cooldown:${REPO_ID}`) throw new Error("cooldown read down");
    return originalGet(scope);
  };
  const job = githubJob({ id: "read-fails" });
  const reading = executionService([job], stateStore, {
    repoCooldown: { mode: "enforce" },
    logs
  });
  const allowed = await reading.claimJob(WALLET, job.id, "http", "read-fails");
  assert.equal(allowed.status, "claimed");
  assert.equal(logs.some((entry) => entry.payload.event === "maintainer_repo_cooldown_read_failed"), true);

  stateStore.getServiceState = originalGet;
  stateStore.upsertServiceState = async (scope, value) => {
    if (scope === "maintainer-repo-cooldown-counters") throw new Error("counter down");
    return originalUpsert(scope, value);
  };
  const unnamed = githubJob({ id: "ambiguous-counter", repoId: null });
  const logging = executionService([unnamed], stateStore, { logs });
  const claimed = await logging.claimJob(OTHER_WALLET, unnamed.id, "http", "ambiguous-counter");
  assert.equal(claimed.status, "claimed");
  assert.equal(logs.some((entry) => entry.payload.event === "maintainer_repo_cooldown_counter_persist_failed"), true);
});

test("the pull request lookup exposes closed_at, closed_by, and baseRepo.fullName", async () => {
  const calls = [];
  const verdict = await new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path.endsWith("/status")) return Response.json({ statuses: [] });
      if (path.endsWith("/check-runs")) return Response.json({ check_runs: [] });
      if (path.endsWith("/reviews")) return Response.json([]);
      if (path === "/repos/new/name/issues/9") return Response.json({ closed_by: { login: "maintainer" } });
      if (path === "/repos/new/name/pulls/9") {
        return Response.json({
          state: "closed",
          merged: false,
          closed_at: CLOSED_AT,
          user: { login: "worker" },
          title: "Fix #1",
          body: "Closes #1",
          html_url: "https://github.com/new/name/pull/9",
          head: { sha: "abc" },
          base: { repo: { id: REPO_ID, full_name: "new/name", created_at: "2020-01-01T00:00:00Z" } }
        });
      }
      return new Response("{}", { status: 404 });
    }
  }).evaluate({
    id: "lookup-job",
    lifecycle: { createdAt: "2026-01-01T00:00:00.000Z" },
    category: "coding",
    verifierMode: "github_pr",
    source: { type: "github_issue", repo: "old/name", issueNumber: 1, githubRepoId: REPO_ID },
    verifierConfig: { handler: "github_pr", version: 1, minimumScore: 80, requireIssueReference: false, requireTestEvidence: false }
  }, normalizeSubmission({
    prUrl: "https://github.com/new/name/pull/9",
    summary: "Fix issue #1",
    tests: "ok"
  }));
  assert.equal(calls.includes("/repos/new/name/issues/9"), true);
  assert.equal(verdict.githubLookup.closedAt, CLOSED_AT);
  assert.equal(verdict.githubLookup.closedBy.login, "maintainer");
  assert.equal(verdict.githubLookup.author.login, "worker");
  assert.equal(verdict.githubLookup.baseRepo.fullName, "new/name");
});

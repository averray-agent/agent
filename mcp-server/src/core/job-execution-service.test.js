import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";

import { BlockchainRevertError, ValidationError } from "./errors.js";
import { JobExecutionService } from "./job-execution-service.js";
import { MemoryStateStore } from "./state-store.js";
import { computeClaimEconomics } from "./claim-economics.js";
import { claimExpiresAt, countClaimAttempts } from "./claim-state.js";
import { transitionSession } from "./session-state-machine.js";
import { buildAverrayDisclosureFooter } from "./maintainer-surface-policy.js";
import {
  buildExternalSchemaRegistrationMessage,
  normalizeExternalSchemaRegistrations
} from "./job-schema-registry.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EXTERNAL_SCHEMA_SIGNER = new Wallet("0x0f4f07793b1c0fcd93c573bd21f40074441c202d8b0cd64bc9453fbd89f3ed1f");

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

async function makeExternalSchemaRegistrations(schemaRef = "schema://jobs/external-review-output") {
  const base = {
    schemaRef,
    schemaUrl: "https://schemas.example.com/jobs/external-review-output.json",
    schema: {
      $id: schemaRef,
      type: "object",
      additionalProperties: false,
      required: ["summary", "result"],
      properties: {
        summary: { type: "string", minLength: 1 },
        result: { type: "string", enum: ["pass", "fail"] }
      }
    },
    issuer: EXTERNAL_SCHEMA_SIGNER.address,
    signedAt: "2026-05-23T00:00:00.000Z"
  };
  return normalizeExternalSchemaRegistrations([
    {
      ...base,
      signature: await EXTERNAL_SCHEMA_SIGNER.signMessage(buildExternalSchemaRegistrationMessage(base))
    }
  ], {
    allowedSchemaRefs: [schemaRef],
    trustedIssuers: [EXTERNAL_SCHEMA_SIGNER.address]
  });
}

test("submitWork accepts structured output for built-in schemas", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob();
  const service = new JobExecutionService(stateStore, undefined, () => job);

  const claimed = await service.claimJob(WALLET, job.id, "http", "idemp-1");
  const submitted = await service.submitWork(claimed.sessionId, "http", {
    summary: "Auth flow has one blocker.",
    findings: [
      {
        severity: "high",
        file: "frontend/auth.js",
        issue: "Session refresh is hidden behind retry logic.",
        recommendation: "Show a visible sign-in refresh path."
      }
    ],
    risk_level: "high",
    files_touched: ["frontend/auth.js"],
    recommended_next_step: "request_changes"
  });

  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.submission.kind, "structured");
  assert.equal(submitted.statusHistory.length, 2);
  assert.equal(submitted.statusHistory[1].metadata.schemaRef, "schema://jobs/pr-review-findings-output");
});

test("submitWork rejects plain evidence for schema-native built-in jobs", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob();
  const service = new JobExecutionService(stateStore, undefined, () => job);

  const claimed = await service.claimJob(WALLET, job.id, "http", "idemp-plain-evidence");

  await assert.rejects(
    () => service.submitWork(claimed.sessionId, "http", "complete"),
    (error) => {
      assert.equal(error.code, "invalid_request");
      assert.match(error.message, /Schema-native jobs require/u);
      assert.equal(error.details.schemaValidates, "payload.submission");
      return true;
    }
  );
});

test("submitWork unwraps submission.output compatibility alias before storing structured output", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob();
  const service = new JobExecutionService(stateStore, undefined, () => job);

  const output = {
    summary: "Auth flow has one blocker.",
    findings: [
      {
        severity: "high",
        file: "frontend/auth.js",
        issue: "Session refresh is hidden behind retry logic.",
        recommendation: "Show a visible sign-in refresh path."
      }
    ],
    risk_level: "high",
    files_touched: ["frontend/auth.js"],
    recommended_next_step: "request_changes"
  };

  const claimed = await service.claimJob(WALLET, job.id, "http", "idemp-output-alias");
  const submitted = await service.submitWork(claimed.sessionId, "http", {
    jobId: job.id,
    output
  });

  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.submission.kind, "structured");
  assert.deepEqual(submitted.submission.structured, output);
});

test("submitWork keeps direct structured submissions that legitimately include an output field", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob({ outputSchemaRef: "schema://jobs/coding-output" });
  const service = new JobExecutionService(stateStore, undefined, () => job);

  const output = {
    summary: "Parser fixed.",
    output: "Added regression coverage.",
    status: "complete",
    filesChanged: ["src/parser.js"]
  };

  const claimed = await service.claimJob(WALLET, job.id, "http", "idemp-direct-output");
  const submitted = await service.submitWork(claimed.sessionId, "http", output);

  assert.equal(submitted.submission.kind, "structured");
  assert.deepEqual(submitted.submission.structured, output);
});

test("submitWork explains wrapped output shape when the alias payload is still invalid", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob({ outputSchemaRef: "schema://jobs/wikipedia-citation-repair-output" });
  const service = new JobExecutionService(stateStore, undefined, () => job);

  const claimed = await service.claimJob(WALLET, job.id, "http", "idemp-bad-output-alias");

  await assert.rejects(
    () => service.submitWork(claimed.sessionId, "http", {
      jobId: job.id,
      output: {
        page_title: "Example article",
        revision_id: "123456789"
      }
    }),
    (error) => {
      assert.equal(error.code, "invalid_submission_shape");
      assert.equal(error.details.expected, "payload.submission.page_title");
      assert.match(error.details.hint, /Do not wrap/u);
      return true;
    }
  );
});

test("submitWork rejects structured output when the schema ref is unknown", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob({ outputSchemaRef: "schema://jobs/custom-output" });
  const service = new JobExecutionService(stateStore, undefined, () => job);

  const claimed = await service.claimJob(WALLET, job.id, "http", "idemp-2");

  await assert.rejects(
    () => service.submitWork(claimed.sessionId, "http", { anything: "goes" }),
    (error) => error instanceof ValidationError && /known built-in or registered schema/.test(error.message)
  );
});

test("submitWork validates structured output against registered external schemas", async () => {
  const stateStore = new MemoryStateStore();
  const outputSchemaRef = "schema://jobs/external-review-output";
  const schemaRegistrations = await makeExternalSchemaRegistrations(outputSchemaRef);
  const job = makeJob({ outputSchemaRef, schemaRegistrations });
  const service = new JobExecutionService(stateStore, undefined, () => job);

  const claimed = await service.claimJob(WALLET, job.id, "http", "idemp-external-schema");
  const submitted = await service.submitWork(claimed.sessionId, "http", {
    summary: "External schema output is valid.",
    result: "pass"
  });

  assert.equal(submitted.outputSchemaBuiltin, false);
  assert.equal(submitted.outputSchemaRegistered, true);
  assert.equal(submitted.submission.structured.result, "pass");
});

test("submitWork rejects invalid registered external schema output", async () => {
  const stateStore = new MemoryStateStore();
  const outputSchemaRef = "schema://jobs/external-review-output";
  const schemaRegistrations = await makeExternalSchemaRegistrations(outputSchemaRef);
  const job = makeJob({ outputSchemaRef, schemaRegistrations });
  const service = new JobExecutionService(stateStore, undefined, () => job);

  const claimed = await service.claimJob(WALLET, job.id, "http", "idemp-external-schema-invalid");

  await assert.rejects(
    () => service.submitWork(claimed.sessionId, "http", {
      summary: "External schema output is invalid.",
      result: "maybe"
    }),
    /submission.result must be one of pass, fail/u
  );
});

test("submitWork rejects duplicate submissions before replacing stored output", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob({ outputSchemaRef: "schema://jobs/coding-output" });
  const service = new JobExecutionService(stateStore, undefined, () => job);

  const claimed = await service.claimJob(WALLET, job.id, "http", "idemp-duplicate-submit");
  const original = {
    summary: "Parser fixed.",
    output: "Added regression coverage.",
    status: "complete"
  };
  await service.submitWork(claimed.sessionId, "http", original);

  await assert.rejects(
    () => service.submitWork(claimed.sessionId, "http", {
      summary: "Overwrite attempt.",
      output: "This should never replace the stored submission.",
      status: "complete"
    }),
    (error) => {
      assert.equal(error.code, "invalid_session_transition");
      assert.equal(error.details.currentStatus, "submitted");
      assert.equal(error.details.nextStatus, "submitted");
      return true;
    }
  );

  const stored = await stateStore.getSession(claimed.sessionId);
  assert.deepEqual(stored.submission.structured, original);
  assert.equal(stored.statusHistory.length, 2);
});

test("submitWork rejects and materializes expired claims before mutation", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob({
    outputSchemaRef: "schema://jobs/coding-output",
    claimTtlSeconds: 60
  });
  const service = new JobExecutionService(stateStore, undefined, () => job);

  const claimed = await service.claimJob(WALLET, job.id, "http", "idemp-expired-submit");
  await stateStore.upsertSession({
    ...claimed,
    claimedAt: "2026-05-01T10:00:00.000Z",
    statusHistory: [
      {
        from: null,
        to: "claimed",
        reason: "job_claimed",
        at: "2026-05-01T10:00:00.000Z"
      }
    ]
  });

  await assert.rejects(
    () => service.submitWork(claimed.sessionId, "http", {
      summary: "Parser fixed.",
      output: "Added regression coverage.",
      status: "complete"
    }),
    (error) => {
      assert.equal(error.code, "claim_expired");
      assert.equal(error.details.claimExpiresAt, "2026-05-01T10:01:00.000Z");
      return true;
    }
  );

  const stored = await stateStore.getSession(claimed.sessionId);
  assert.equal(stored.status, "expired");
  assert.equal(stored.expiredAt, "2026-05-01T10:01:00.000Z");
});

test("claimJob reopens an expired claim when retry budget remains", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob({
    claimTtlSeconds: 60,
    retryLimit: 2
  });
  const service = new JobExecutionService(stateStore, undefined, () => job);

  const first = await service.claimJob(WALLET, job.id, "http", "idemp-expired-retry-1");
  await stateStore.upsertSession({
    ...first,
    claimedAt: "2026-05-01T10:00:00.000Z",
    statusHistory: [
      {
        from: null,
        to: "claimed",
        reason: "job_claimed",
        at: "2026-05-01T10:00:00.000Z"
      }
    ]
  });

  const second = await service.claimJob(WALLET_2, job.id, "http", "idemp-expired-retry-2");

  assert.equal(second.status, "claimed");
  assert.equal(second.wallet, WALLET_2);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal((await stateStore.getSession(first.sessionId)).status, "expired");
  assert.equal((await stateStore.findSessionByJobId(job.id)).sessionId, second.sessionId);
});

test("claimJob stores on-chain claim expiry when blockchain is enabled", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob({ claimTtlSeconds: 60 });
  let getJobCalls = 0;
  const blockchainGateway = {
    isEnabled: () => true,
    toJobId: (jobId) => `chain:${jobId}`,
    async getJob() {
      getJobCalls += 1;
      return getJobCalls === 1
        ? { state: 0 }
        : { state: 1, claimExpiry: Date.parse("2026-05-01T10:01:00.000Z") / 1000 };
    },
    async ensureJob() {},
    async ensureClaimStakeLiquidity(wallet) {
      assert.equal(wallet, WALLET);
    },
    async claimJob(jobId, wallet) {
      assert.equal(jobId, job.id);
      assert.equal(wallet, WALLET);
    }
  };
  const service = new JobExecutionService(stateStore, blockchainGateway, () => job);

  const claimed = await service.claimJob(WALLET, job.id, "http", "idemp-chain-expiry");

  assert.equal(claimed.chainClaimExpiresAt, "2026-05-01T10:01:00.000Z");
  assert.equal(claimExpiresAt(claimed, job), "2026-05-01T10:01:00.000Z");
});

test("claimJob uses chain worker claim count before ensuring a chain job", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob({ rewardAmount: 5 });
  let ensuredClaimLock;
  let checkedClaimLock;
  const blockchainGateway = {
    isEnabled: () => true,
    toJobId: (jobId) => `chain:${jobId}`,
    async getWorkerClaimCount(wallet) {
      assert.equal(wallet, WALLET);
      return 3;
    },
    async getJob() {
      return { state: 0 };
    },
    async ensureJob(jobInput, instanceJobId, claimLock) {
      assert.equal(jobInput.id, job.id);
      assert.equal(instanceJobId, job.id);
      ensuredClaimLock = claimLock;
    },
    async ensureClaimStakeLiquidity(wallet, asset, claimLock) {
      assert.equal(wallet, WALLET);
      assert.equal(asset, "DOT");
      checkedClaimLock = claimLock;
    },
    async claimJob(jobId, wallet) {
      assert.equal(jobId, job.id);
      assert.equal(wallet, WALLET);
    }
  };
  const service = new JobExecutionService(
    stateStore,
    blockchainGateway,
    () => job,
    undefined,
    undefined,
    async () => 1000,
    () => job,
    async () => ({ minClaimFeeByAsset: { DOT: 0.05 } })
  );

  const claimed = await service.claimJob(WALLET, job.id, "http", "idemp-chain-count");

  assert.equal(ensuredClaimLock, 0.6);
  assert.equal(checkedClaimLock, 0.6);
  assert.equal(claimed.claimNumber, 4);
  assert.equal(claimed.claimEconomicsWaived, false);
  assert.equal(claimed.totalClaimLock, 0.6);
});

test("claimJob reports exhausted retry budget after an expired single-attempt job", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob({
    claimTtlSeconds: 60,
    retryLimit: 1
  });
  const service = new JobExecutionService(stateStore, undefined, () => job);

  const first = await service.claimJob(WALLET, job.id, "http", "idemp-expired-exhausted-1");
  await stateStore.upsertSession({
    ...first,
    claimedAt: "2026-05-01T10:00:00.000Z",
    statusHistory: [
      {
        from: null,
        to: "claimed",
        reason: "job_claimed",
        at: "2026-05-01T10:00:00.000Z"
      }
    ]
  });

  await assert.rejects(
    () => service.claimJob(WALLET_2, job.id, "http", "idemp-expired-exhausted-2"),
    (error) => {
      assert.equal(error.code, "retry_limit_exhausted");
      assert.equal(error.details.claimAttemptCount, 1);
      return true;
    }
  );
  assert.equal((await stateStore.getSession(first.sessionId)).status, "expired");
});

test("computeClaimEconomics waives first three claims and then applies stake plus fee", () => {
  const waived = computeClaimEconomics({
    rewardAmount: 5,
    rewardAsset: "DOT",
    priorClaimCount: 2,
    claimStakeBps: 1000,
    minClaimFeeByAsset: { DOT: 0.05 }
  });
  assert.equal(waived.claimEconomicsWaived, true);
  assert.equal(waived.totalClaimLock, 0);

  const paid = computeClaimEconomics({
    rewardAmount: 5,
    rewardAsset: "DOT",
    priorClaimCount: 3,
    claimStakeBps: 1000,
    minClaimFeeByAsset: { DOT: 0.05 }
  });
  assert.equal(paid.claimEconomicsWaived, false);
  assert.equal(paid.claimStake, 0.5);
  assert.equal(paid.claimFee, 0.1);
  assert.equal(paid.totalClaimLock, 0.6);

  const floorBound = computeClaimEconomics({
    rewardAmount: 1,
    rewardAsset: "DOT",
    priorClaimCount: 3,
    claimStakeBps: 1000,
    minClaimFeeByAsset: { DOT: 0.05 }
  });
  assert.equal(floorBound.claimFee, 0.05);
});

test("claimJob records onboarding waiver and claim fee economics on sessions", async () => {
  const stateStore = new MemoryStateStore();
  const jobs = new Map(
    Array.from({ length: 4 }, (_, index) => {
      const job = makeJob({ id: `job-${index + 1}`, rewardAmount: 5 });
      return [job.id, job];
    })
  );
  const service = new JobExecutionService(
    stateStore,
    undefined,
    (jobId) => jobs.get(jobId),
    undefined,
    undefined,
    async () => 1000,
    (jobId) => jobs.get(jobId),
    async () => ({ minClaimFeeByAsset: { DOT: 0.05 } })
  );

  for (let index = 0; index < 3; index++) {
    const session = await service.claimJob(WALLET, `job-${index + 1}`, "http", `idemp-waived-${index}`);
    assert.equal(session.claimEconomicsWaived, true);
    assert.equal(session.totalClaimLock, 0);
    assert.equal(session.claimNumber, index + 1);
  }

  const paid = await service.claimJob(WALLET, "job-4", "http", "idemp-paid");
  assert.equal(paid.claimEconomicsWaived, false);
  assert.equal(paid.claimNumber, 4);
  assert.equal(paid.claimStake, 0.5);
  assert.equal(paid.claimFee, 0.1);
  assert.equal(paid.totalClaimLock, 0.6);
});

test("submitWork enforces per-repo open PR cap for GitHub issue jobs", async () => {
  const stateStore = new MemoryStateStore();
  for (let index = 0; index < 3; index++) {
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
  const job = makeJob({
    id: "github-issue-job-001",
    outputSchemaRef: "schema://jobs/github-pr-evidence-output",
    source: {
      type: "github_issue",
      repo: "example/project",
      issueNumber: 42
    }
  });
  const service = new JobExecutionService(stateStore, undefined, () => job);
  const claimed = await service.claimJob(WALLET, job.id, "http", "idemp-cap");

  await assert.rejects(
    () => service.submitWork(claimed.sessionId, "http", {
      prUrl: "https://github.com/example/project/pull/4",
      summary: "Adds the requested parser regression test.",
      tests: "npm test"
    }),
    (error) => error.code === "maintainer_open_pr_cap_reached"
  );
});

test("submitWork injects Averray disclosure footer into GitHub PR evidence", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob({
    id: "github-issue-job-disclosure",
    outputSchemaRef: "schema://jobs/github-pr-evidence-output",
    source: {
      type: "github_issue",
      repo: "example/project",
      issueNumber: 42,
      maintainerPolicy: {
        disclosureRequired: true,
        openPrCap: 3
      }
    }
  });
  const service = new JobExecutionService(stateStore, undefined, () => job);
  const claimed = await service.claimJob(WALLET, job.id, "http", "idemp-disclosure");

  const submitted = await service.submitWork(claimed.sessionId, "http", {
    prUrl: "https://github.com/example/project/pull/7",
    summary: "Adds the requested parser regression test.",
    tests: "npm test"
  });

  assert.match(submitted.submission.structured.prBody, /This contribution was prepared by an autonomous agent/u);
  assert.match(submitted.submission.structured.prBody, /Averray platform/u);
  assert.match(submitted.submission.structured.prBody, new RegExp(WALLET, "u"));
  assert.match(submitted.submission.structured.prBody, /https:\/\/api\.averray\.com\/jobs\/github-issue-job-disclosure/u);
});

test("submitWork does not duplicate an existing Averray disclosure footer", async () => {
  const stateStore = new MemoryStateStore();
  const footer = buildAverrayDisclosureFooter({
    agentWallet: WALLET,
    jobSpecUrl: "https://api.averray.com/jobs/github-issue-job-disclosure-once"
  });
  const prBody = `Fixes #42\n\n${footer}`;
  const job = makeJob({
    id: "github-issue-job-disclosure-once",
    outputSchemaRef: "schema://jobs/github-pr-evidence-output",
    source: {
      type: "github_issue",
      repo: "example/project",
      issueNumber: 42
    }
  });
  const service = new JobExecutionService(stateStore, undefined, () => job);
  const claimed = await service.claimJob(WALLET, job.id, "http", "idemp-disclosure-once");

  const submitted = await service.submitWork(claimed.sessionId, "http", {
    prUrl: "https://github.com/example/project/pull/8",
    summary: "Adds the requested parser regression test.",
    tests: "npm test",
    prBody
  });

  assert.equal(submitted.submission.structured.prBody, prBody);
});

test("submitWork stamps submitFailedAt and re-throws on a chain-revert, preserving the claim's retry budget", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob();
  const revertingGateway = {
    isEnabled: () => true,
    submitWork: async () => {
      throw new BlockchainRevertError("submit reverted", { reason: "ClaimNotActive" });
    }
  };
  const service = new JobExecutionService(stateStore, revertingGateway, () => job);

  // Seed a claimed session directly so the reverting gateway is only exercised
  // on the submit path (claimJob has its own on-chain dependencies, irrelevant here).
  const claimed = transitionSession(
    {
      sessionId: `${job.id}:0xaaa`,
      wallet: WALLET,
      jobId: job.id,
      chainJobId: `${job.id}:0xaaa`,
      protocolHistory: []
    },
    "claimed",
    { reason: "job_claimed" }
  );
  await stateStore.upsertSession(claimed);

  await assert.rejects(
    () =>
      service.submitWork(claimed.sessionId, "http", {
        summary: "Auth flow has one blocker.",
        findings: [
          {
            severity: "high",
            file: "frontend/auth.js",
            issue: "Session refresh is hidden behind retry logic.",
            recommendation: "Show a visible sign-in refresh path."
          }
        ],
        risk_level: "high",
        files_touched: ["frontend/auth.js"],
        recommended_next_step: "request_changes"
      }),
    (error) => error.code === "blockchain_revert"
  );

  const after = await stateStore.getSession(claimed.sessionId);
  assert.ok(after.submitFailedAt, "submitFailedAt should be stamped on a chain-reverted submit");
  assert.equal(after.submittedAt, undefined, "the session never reached submitted");
  assert.equal(after.status, "claimed", "the claim is preserved, not consumed");
  // The infra-failed attempt must NOT burn the job's retry budget.
  assert.equal(countClaimAttempts([after]), 0);
});

test("submitWork self-heals a mined-but-receipt-lost submit (on-chain already Submitted) instead of stranding it", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob();
  // submitWork throws (lost receipt) but the tx actually mined → on-chain job is Submitted (3).
  const gateway = {
    isEnabled: () => true,
    submitWork: async () => {
      throw new Error("RPC connection dropped before tx.wait() returned");
    },
    getJob: async () => ({ state: 3 })
  };
  const service = new JobExecutionService(stateStore, gateway, () => job);

  const claimed = transitionSession(
    { sessionId: `${job.id}:0xa1`, wallet: WALLET, jobId: job.id, chainJobId: `${job.id}:0xa1`, protocolHistory: [] },
    "claimed",
    { reason: "job_claimed" }
  );
  await stateStore.upsertSession(claimed);

  const submitted = await service.submitWork(claimed.sessionId, "http", {
    summary: "Auth flow has one blocker.",
    findings: [{ severity: "high", file: "frontend/auth.js", issue: "x", recommendation: "y" }],
    risk_level: "high",
    files_touched: ["frontend/auth.js"],
    recommended_next_step: "request_changes"
  });

  assert.equal(submitted.status, "submitted", "session advanced to submitted, not stranded");
  assert.equal(submitted.submitFailedAt, undefined, "not marked as an infra failure");
  const stored = await stateStore.getSession(claimed.sessionId);
  assert.equal(stored.status, "submitted");
});

test("submitWork still stamps submitFailedAt + rethrows on a true revert (on-chain not Submitted)", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob();
  // submitWork reverts AND the on-chain job is still Claimed (2) → genuine failure.
  const gateway = {
    isEnabled: () => true,
    submitWork: async () => {
      throw new BlockchainRevertError("submit reverted", { reason: "InvalidState" });
    },
    getJob: async () => ({ state: 2 })
  };
  const service = new JobExecutionService(stateStore, gateway, () => job);

  const claimed = transitionSession(
    { sessionId: `${job.id}:0xb2`, wallet: WALLET, jobId: job.id, chainJobId: `${job.id}:0xb2`, protocolHistory: [] },
    "claimed",
    { reason: "job_claimed" }
  );
  await stateStore.upsertSession(claimed);

  await assert.rejects(
    () =>
      service.submitWork(claimed.sessionId, "http", {
        summary: "Auth flow has one blocker.",
        findings: [{ severity: "high", file: "frontend/auth.js", issue: "x", recommendation: "y" }],
        risk_level: "high",
        files_touched: ["frontend/auth.js"],
        recommended_next_step: "request_changes"
      }),
    (error) => error.code === "blockchain_revert"
  );

  const after = await stateStore.getSession(claimed.sessionId);
  assert.ok(after.submitFailedAt, "true revert is still stamped as an infra failure");
  assert.equal(after.status, "claimed");
});

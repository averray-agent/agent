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
import { hashCanonicalContent } from "./canonical-content.js";
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

function makeTestOnboardingSubsidyBudget({
  dailyBudgetUsdc = 1,
  estimatedClaimSubsidyUsdc = 1,
  now = () => new Date("2026-08-11T12:00:00.000Z")
} = {}) {
  const reservationsByDay = new Map();
  let reserveCalls = 0;

  function snapshot() {
    const current = now();
    const day = current.toISOString().slice(0, 10);
    const reservations = reservationsByDay.get(day) ?? new Set();
    const allocatedUsdc = reservations.size * estimatedClaimSubsidyUsdc;
    const headroomUsdc = Math.max(dailyBudgetUsdc - allocatedUsdc, 0);
    const reset = new Date(current);
    reset.setUTCHours(24, 0, 0, 0);
    return {
      applies: true,
      available: headroomUsdc >= estimatedClaimSubsidyUsdc,
      dailyBudgetUsdc,
      allocatedUsdc,
      headroomUsdc,
      estimatedClaimSubsidyUsdc,
      resetAt: reset.toISOString(),
      clock: "UTC"
    };
  }

  return {
    get reserveCalls() {
      return reserveCalls;
    },
    async inspect() {
      return snapshot();
    },
    async reserve({ reservationId }) {
      reserveCalls += 1;
      const current = now();
      const day = current.toISOString().slice(0, 10);
      const reservations = reservationsByDay.get(day) ?? new Set();
      if (reservations.has(reservationId)) {
        return { ...snapshot(), accepted: true, alreadyReserved: true };
      }
      const currentSnapshot = snapshot();
      if (!currentSnapshot.available) {
        return { ...currentSnapshot, accepted: false, alreadyReserved: false };
      }
      reservations.add(reservationId);
      reservationsByDay.set(day, reservations);
      return { ...snapshot(), accepted: true, alreadyReserved: false };
    },
    async getStatus() {
      const { estimatedClaimSubsidyUsdc: _estimate, applies: _applies, available: _available, ...status } = snapshot();
      return status;
    }
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

test("claimJob pins an immutable complete job snapshot to the session", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob();
  const service = new JobExecutionService(stateStore, undefined, () => job);

  const claimed = await service.claimJob(WALLET, job.id, "http", "idemp-snapshot");

  assert.equal(claimed.jobSnapshot.version, "job-snapshot-v1");
  assert.equal(claimed.jobSnapshot.jobId, job.id);
  assert.equal(claimed.jobSnapshot.definition.id, job.id);
  assert.equal(claimed.jobSnapshot.definitionHash, claimed.jobSnapshot.specHash);
  assert.match(claimed.jobSnapshot.specHash, /^0x[0-9a-f]{64}$/u);
  assert.equal(claimed.jobSnapshot.outputSchema.ref, job.outputSchemaRef);
  assert.equal(claimed.jobSnapshot.outputSchema.schema.$id, job.outputSchemaRef);
  assert.match(claimed.jobSnapshot.outputSchema.schemaHash, /^0x[0-9a-f]{64}$/u);
  assert.equal(claimed.jobSnapshot.claimEconomics.totalClaimLock, claimed.totalClaimLock);

  job.verifierConfig.requiredKeywords = ["mutated-live-catalogue"];
  assert.deepEqual(
    claimed.jobSnapshot.definition.verifierConfig.requiredKeywords,
    ["summary", "findings", "risk_level"]
  );
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

test("claimJob returns the same wallet's active claim when the response was lost", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob({ retryLimit: 1 });
  let claimLockCalls = 0;
  const service = new JobExecutionService(
    stateStore,
    undefined,
    () => job,
    undefined,
    {
      async lockJobStake() {
        claimLockCalls += 1;
      }
    }
  );

  const first = await service.claimJob(WALLET, job.id, "mcp", "first-request-id");
  const recovered = await service.claimJob(WALLET.toUpperCase(), job.id, "mcp", "retry-request-id");

  assert.deepEqual(recovered, first);
  assert.equal(claimLockCalls, 1);
  assert.equal((await stateStore.listSessionsByJob(job.id, 10)).length, 1);
  assert.equal(countClaimAttempts([recovered]), 0);
});

test("claimJob stores on-chain claim expiry when blockchain is enabled", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob({ claimTtlSeconds: 60 });
  let getJobCalls = 0;
  const blockchainGateway = {
    isEnabled: () => true,
    toJobId: (jobId) => `chain:${jobId}`,
    async getWorkerClaimCount() {
      return 0;
    },
    async getClaimEconomicsDecisionState() {
      return {
        state: 0,
        exists: false,
        contractLayout: "current",
        onboardingWaiverEligible: false
      };
    },
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

test("external claims return a direct worker transaction and never call the operator broker", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob({
    source: { type: "external", poster: { wallet: WALLET_2 } },
    requiresSponsoredGas: false
  });
  let brokerCalls = 0;
  const transaction = { to: "0x1111111111111111111111111111111111111111", value: "0", data: "0x1234" };
  const gateway = {
    isEnabled: () => true,
    toJobId: (value) => value,
    async getWorkerClaimCount() { return 0; },
    async getClaimEconomicsDecisionState() {
      return { state: 1, exists: true, contractLayout: "current", onboardingWaiverEligible: false };
    },
    async previewClaimEconomics() {
      return {
        claimStake: 0,
        claimStakeBps: 0,
        claimFee: 0,
        claimFeeBps: 0,
        claimEconomicsWaived: false,
        claimNumber: 1,
        totalClaimLock: 0
      };
    },
    async getJob() { return { state: 1 }; },
    async prepareDirectClaimJob(jobId) {
      assert.equal(jobId, job.id);
      return transaction;
    },
    async claimJob() { brokerCalls += 1; }
  };
  const service = new JobExecutionService(stateStore, gateway, () => job);

  await assert.rejects(
    service.claimJob(WALLET, job.id, "mcp", "external-direct-claim"),
    (error) => {
      assert.equal(error.code, "external_self_paid_claim_required");
      assert.equal(error.details.requiresSponsoredGas, false);
      assert.deepEqual(error.details.transaction, transaction);
      return true;
    }
  );
  assert.equal(brokerCalls, 0);
  assert.equal(await stateStore.findSessionByJobId(job.id), undefined);
});

test("external claim convergence pins the poster definition that reproduces the chain specHash", async () => {
  const stateStore = new MemoryStateStore();
  const posterDefinition = {
    category: "coding",
    rewardAsset: "USDC",
    rewardAmount: "1",
    verifierMode: "human_fallback",
    outputSchemaRef: "schema://jobs/coding-output",
    claimTtlSeconds: 86_400
  };
  const job = makeJob({
    ...posterDefinition,
    id: `0x${"a".repeat(64)}`,
    source: { type: "external", poster: { wallet: WALLET_2 } },
    poster: { wallet: WALLET_2 },
    funding: { status: "funded" },
    requiresSponsoredGas: false
  });
  await stateStore.materializeExternalJobDraft({
    draftId: "external-snapshot-draft",
    jobId: job.id,
    wallet: WALLET_2,
    definition: posterDefinition,
    status: "live",
    createdAt: "2026-08-11T10:00:00.000Z",
    expiresAt: "2026-08-14T10:00:00.000Z"
  });
  const gateway = {
    isEnabled: () => true,
    toJobId: (value) => value,
    async getWorkerClaimCount() { return 0; },
    async getClaimEconomicsDecisionState() {
      return { state: 2, exists: true, contractLayout: "current", onboardingWaiverEligible: false };
    },
    async previewClaimEconomics() {
      return {
        claimStake: 0.05,
        claimStakeBps: 500,
        claimFee: 0.01,
        claimFeeBps: 100,
        claimEconomicsWaived: false,
        claimNumber: 1,
        totalClaimLock: 0.06
      };
    },
    async getJob() {
      return {
        state: 2,
        worker: WALLET,
        claimExpiry: Date.parse("2026-08-12T10:00:00.000Z") / 1000
      };
    }
  };
  const service = new JobExecutionService(stateStore, gateway, () => job);

  const claimed = await service.claimJob(WALLET, job.id, "http", "external-snapshot-converge");

  assert.equal(claimed.jobSnapshot.jobId, job.id);
  assert.deepEqual(claimed.jobSnapshot.specDefinition, posterDefinition);
  assert.equal(claimed.jobSnapshot.specHash, hashCanonicalContent(posterDefinition));
  assert.notEqual(
    claimed.jobSnapshot.definitionHash,
    claimed.jobSnapshot.specHash,
    "the enriched catalogue projection is deliberately distinct from the poster's committed terms"
  );
});

test("claimJob converges a stranded claim: chain claim mined but local session write failed (MAIN-002)", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob({ claimTtlSeconds: 60 });
  let claimJobCalls = 0;
  let onChainClaimed = false;
  const blockchainGateway = {
    isEnabled: () => true,
    toJobId: (jobId) => `chain:${jobId}`,
    async getWorkerClaimCount() { return 0; },
    async getClaimEconomicsDecisionState() {
      return {
        state: onChainClaimed ? 2 : 0,
        exists: onChainClaimed,
        contractLayout: "current",
        onboardingWaiverEligible: false
      };
    },
    async previewClaimEconomics() {
      return {
        claimStake: 0.3,
        claimStakeBps: 500,
        claimFee: 0.12,
        claimFeeBps: 200,
        claimEconomicsWaived: false,
        claimNumber: 1,
        totalClaimLock: 0.42
      };
    },
    async getJob() {
      // Open until the on-chain claim lands, then CLAIMED (state 2) by WALLET.
      return onChainClaimed
        ? { state: 2, worker: WALLET, claimExpiry: Date.parse("2026-05-01T10:01:00.000Z") / 1000 }
        : { state: 0 };
    },
    async ensureJob() {},
    async ensureClaimStakeLiquidity() {},
    async claimJob() {
      claimJobCalls += 1;
      onChainClaimed = true; // the tx mines
    }
  };
  const service = new JobExecutionService(stateStore, blockchainGateway, () => job);

  // First attempt: the on-chain claim mines, but the local session write fails once.
  const realUpsert = stateStore.upsertSession.bind(stateStore);
  let upsertFailed = false;
  stateStore.upsertSession = async (session) => {
    if (!upsertFailed) {
      upsertFailed = true;
      throw new Error("redis blip");
    }
    return realUpsert(session);
  };

  await assert.rejects(() => service.claimJob(WALLET, job.id, "http", "idemp-strand"), /redis blip/);
  assert.equal(claimJobCalls, 1, "the on-chain claim mined exactly once");

  // Retry: the chain job is now CLAIMED by this wallet, but there is no local
  // session. claimJob must CONVERGE (rebuild the session) without re-claiming.
  const recovered = await service.claimJob(WALLET, job.id, "http", "idemp-strand");
  assert.equal(claimJobCalls, 1, "retry must NOT call claimJob again");
  assert.equal(recovered.status, "claimed");
  assert.equal(recovered.wallet, WALLET);
  assert.equal(recovered.jobId, job.id);
});

test("claimJob does NOT converge when the chain job is claimed by a different worker (MAIN-002 guard)", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob({ claimTtlSeconds: 60 });
  const blockchainGateway = {
    isEnabled: () => true,
    toJobId: (jobId) => `chain:${jobId}`,
    async getWorkerClaimCount() { return 0; },
    async getClaimEconomicsDecisionState() {
      return {
        state: 2,
        exists: true,
        contractLayout: "current",
        onboardingWaiverEligible: false
      };
    },
    async previewClaimEconomics() {
      return {
        claimStake: 0.3,
        claimStakeBps: 500,
        claimFee: 0.12,
        claimFeeBps: 200,
        claimEconomicsWaived: false,
        claimNumber: 1,
        totalClaimLock: 0.42
      };
    },
    async getJob() {
      // Already claimed on-chain by someone else.
      return { state: 2, worker: WALLET_2 };
    },
    async ensureJob() {},
    async ensureClaimStakeLiquidity() {},
    async claimJob() { throw new Error("should not claim"); }
  };
  const service = new JobExecutionService(stateStore, blockchainGateway, () => job);

  await assert.rejects(
    () => service.claimJob(WALLET, job.id, "http", "idemp-other"),
    (error) => error.code === "job_not_claimable"
  );
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
    async getClaimEconomicsDecisionState() {
      return {
        state: 0,
        exists: false,
        contractLayout: "current",
        onboardingWaiverEligible: false
      };
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

test("claimJob keeps the reserved subsidy evidence after the authoritative chain preview", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob({
    rewardAsset: "USDC",
    rewardAmount: 1,
    requiresSponsoredGas: true,
    onboardingWaiverEligible: true
  });
  const budget = makeTestOnboardingSubsidyBudget();
  const blockchainGateway = {
    isEnabled: () => true,
    toJobId: (jobId) => `chain:${jobId}`,
    async getClaimEconomicsDecisionState() {
      return {
        state: 1,
        exists: true,
        contractLayout: "current",
        onboardingWaiverEligible: true
      };
    },
    async previewClaimEconomics() {
      return {
        claimStake: 0,
        claimStakeBps: 0,
        claimFee: 0,
        claimFeeBps: 0,
        claimEconomicsWaived: true,
        claimNumber: 1,
        totalClaimLock: 0
      };
    },
    async getJob() {
      return { state: 1 };
    },
    async ensureJob() {},
    async ensureClaimStakeLiquidity() {},
    async claimJob() {}
  };
  const service = new JobExecutionService(
    stateStore,
    blockchainGateway,
    () => job,
    undefined,
    undefined,
    async () => 500,
    () => job,
    async () => ({ minClaimFeeByAsset: { USDC: 0.05 } }),
    { onboardingSubsidyBudget: budget }
  );

  const claimed = await service.claimJob(WALLET, job.id, "http", "idemp-chain-subsidy");

  assert.equal(budget.reserveCalls, 1);
  assert.equal(claimed.onboardingSubsidy.reserved, true);
  assert.equal(claimed.onboardingSubsidy.allocatedUsdc, 1);
});

test("claimJob logs an invariant error when the shared prediction differs from contract authority", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob({ rewardAmount: 5 });
  const errors = [];
  let state = 1;
  let previewCalls = 0;
  const blockchainGateway = {
    isEnabled: () => true,
    toJobId: (jobId) => `chain:${jobId}`,
    async getClaimEconomicsDecisionState() {
      return {
        state,
        exists: true,
        contractLayout: "current",
        onboardingWaiverEligible: false
      };
    },
    async previewClaimEconomics() {
      previewCalls += 1;
      const claimStake = previewCalls === 1 ? 0.25 : 0.5;
      return {
        claimStake,
        claimStakeBps: previewCalls === 1 ? 500 : 1000,
        claimFee: 0.1,
        claimFeeBps: 200,
        claimEconomicsWaived: false,
        claimNumber: 1,
        totalClaimLock: claimStake + 0.1
      };
    },
    async getJob() {
      return { state };
    },
    async ensureJob() {},
    async ensureClaimStakeLiquidity() {},
    async claimJob() {
      state = 2;
    }
  };
  const service = new JobExecutionService(
    stateStore,
    blockchainGateway,
    () => job,
    undefined,
    undefined,
    async () => 500,
    () => job,
    async () => ({}),
    {
      logger: {
        error(...args) {
          errors.push(args);
        }
      }
    }
  );

  const claimed = await service.claimJob(WALLET, job.id, "http", "idemp-invariant-probe");

  assert.equal(claimed.claimStake, 0.5);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0].event, "claim_economics_prediction_mismatch");
  assert.equal(errors[0][0].jobId, job.id);
  assert.deepEqual(errors[0][0].differences.claimStake, {
    prediction: 0.25,
    authoritative: 0.5
  });
  assert.equal(errors[0][1], "claim_economics_prediction_mismatch");
});

test("claimJob reopens an expired unsubmitted claim without consuming a single-attempt budget", async () => {
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

  const second = await service.claimJob(WALLET_2, job.id, "http", "idemp-expired-exhausted-2");

  assert.equal(second.status, "claimed");
  assert.equal(second.wallet, WALLET_2);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal((await stateStore.getSession(first.sessionId)).status, "expired");
  assert.equal(countClaimAttempts(await stateStore.listSessionsByJob(job.id, 10)), 0);
});

test("claimJob finalizes the chain timeout before reclaiming an unsubmitted single-attempt job", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob({ claimTtlSeconds: 60, retryLimit: 1 });
  let chainState = 2;
  let timeoutCalls = 0;
  let claimCalls = 0;
  const blockchainGateway = {
    isEnabled: () => true,
    toJobId: (jobId) => `chain:${jobId}`,
    async getWorkerClaimCount() { return 0; },
    async getClaimEconomicsDecisionState() {
      return {
        state: chainState,
        exists: true,
        contractLayout: "current",
        onboardingWaiverEligible: false
      };
    },
    async previewClaimEconomics() {
      return {
        claimStake: 0.3,
        claimStakeBps: 500,
        claimFee: 0.12,
        claimFeeBps: 200,
        claimEconomicsWaived: false,
        claimNumber: 1,
        totalClaimLock: 0.42
      };
    },
    async getJob() {
      return {
        state: chainState,
        worker: chainState === 2 ? WALLET_2 : undefined,
        claimExpiry: Date.parse("2030-05-01T12:00:00.000Z") / 1000
      };
    },
    async handleClaimTimeout(jobId) {
      assert.equal(jobId, job.id);
      assert.equal(chainState, 2);
      timeoutCalls += 1;
      chainState = 1;
    },
    async ensureJob() {},
    async ensureClaimStakeLiquidity() {},
    async claimJob(jobId, wallet) {
      assert.equal(jobId, job.id);
      assert.equal(wallet, WALLET_2);
      assert.equal(chainState, 1);
      claimCalls += 1;
      chainState = 2;
    }
  };
  const service = new JobExecutionService(stateStore, blockchainGateway, () => job);
  const first = transitionSession({
    sessionId: `${job.id}:${WALLET}`,
    wallet: WALLET,
    jobId: job.id,
    chainJobId: `chain:${job.id}`,
    chainClaimExpiresAt: "2026-05-01T10:01:00.000Z",
    protocolHistory: ["mcp"],
    idempotencyKey: "expired-chain-claim"
  }, "claimed", {
    reason: "job_claimed",
    timestamp: "2026-05-01T10:00:00.000Z"
  });
  await stateStore.upsertSession(first);

  const recovered = await service.claimJob(WALLET_2, job.id, "mcp", "replacement-chain-claim");

  assert.equal(timeoutCalls, 1);
  assert.equal(claimCalls, 1);
  assert.equal((await stateStore.getSession(first.sessionId)).status, "expired");
  assert.equal(recovered.status, "claimed");
  assert.equal(recovered.wallet, WALLET_2);
});

test("computeClaimEconomics waives only explicitly eligible first claims", () => {
  const waived = computeClaimEconomics({
    rewardAmount: 5,
    rewardAsset: "DOT",
    priorClaimCount: 2,
    onboardingWaiverEligible: true,
    claimStakeBps: 1000,
    minClaimFeeByAsset: { DOT: 0.05 }
  });
  assert.equal(waived.claimEconomicsWaived, true);
  assert.equal(waived.totalClaimLock, 0);

  const notEligible = computeClaimEconomics({
    rewardAmount: 5,
    rewardAsset: "DOT",
    priorClaimCount: 2,
    claimStakeBps: 1000,
    minClaimFeeByAsset: { DOT: 0.05 }
  });
  assert.equal(notEligible.claimEconomicsWaived, false);
  assert.equal(notEligible.claimStake, 0.5);
  assert.equal(notEligible.claimFee, 0.1);
  assert.equal(notEligible.totalClaimLock, 0.6);

  const paid = computeClaimEconomics({
    rewardAmount: 5,
    rewardAsset: "DOT",
    priorClaimCount: 3,
    onboardingWaiverEligible: true,
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
    onboardingWaiverEligible: true,
    claimStakeBps: 1000,
    minClaimFeeByAsset: { DOT: 0.05 }
  });
  assert.equal(floorBound.claimFee, 0.05);
});

test("claimJob records onboarding waiver and claim fee economics on sessions", async () => {
  const stateStore = new MemoryStateStore();
  const jobs = new Map(
    Array.from({ length: 4 }, (_, index) => {
      const job = makeJob({ id: `job-${index + 1}`, rewardAmount: 5, onboardingWaiverEligible: true });
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
    assert.equal(session.claimEconomicsWaivedAtClaim, true);
    assert.equal(session.claimEconomicsWaiverScope, "claim_time");
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

test("tier-0 budget rejects a rotated fresh wallet globally with the self-funded path", async () => {
  const stateStore = new MemoryStateStore();
  const budget = makeTestOnboardingSubsidyBudget();
  const jobs = new Map([1, 2].map((index) => {
    const job = makeJob({
      id: `global-subsidy-${index}`,
      rewardAsset: "USDC",
      rewardAmount: 1,
      requiresSponsoredGas: true,
      onboardingWaiverEligible: true
    });
    return [job.id, job];
  }));
  const service = new JobExecutionService(
    stateStore,
    undefined,
    (jobId) => jobs.get(jobId),
    undefined,
    undefined,
    async () => 500,
    (jobId) => jobs.get(jobId),
    async () => ({ minClaimFeeByAsset: { USDC: 0.05 } }),
    { onboardingSubsidyBudget: budget }
  );

  const first = await service.claimJob(WALLET, "global-subsidy-1", "http", "global-first");
  assert.equal(first.claimEconomicsWaived, true);

  await assert.rejects(
    () => service.claimJob(WALLET_2, "global-subsidy-2", "http", "global-rotated"),
    (error) => {
      assert.equal(error.code, "onboarding_subsidy_exhausted");
      assert.match(error.message, /self-funded claim path/u);
      assert.equal(error.details.headroomUsdc, 0);
      assert.equal(error.details.clock, "UTC");
      assert.equal(error.details.resetAt, "2026-08-12T00:00:00.000Z");
      return true;
    }
  );
  assert.equal(budget.reserveCalls, 2);
});

test("non-waived curated claims still consume the unconditional brokered gas budget", async () => {
  const stateStore = new MemoryStateStore();
  const budget = makeTestOnboardingSubsidyBudget();
  const jobs = new Map([1, 2].map((index) => {
    const job = makeJob({
      id: `brokered-gas-${index}`,
      rewardAsset: "USDC",
      rewardAmount: 1,
      // The current curated claim path is operator-brokered regardless of this
      // advisory catalog flag. External lifecycle routing is the self-funded
      // boundary that matters.
      requiresSponsoredGas: false,
      onboardingWaiverEligible: false
    });
    return [job.id, job];
  }));
  const service = new JobExecutionService(
    stateStore,
    undefined,
    (jobId) => jobs.get(jobId),
    undefined,
    undefined,
    async () => 500,
    (jobId) => jobs.get(jobId),
    async () => ({ minClaimFeeByAsset: { USDC: 0.05 } }),
    { onboardingSubsidyBudget: budget }
  );

  const first = await service.claimJob(WALLET, "brokered-gas-1", "http", "brokered-first");
  assert.equal(first.claimEconomicsWaived, false);
  assert.equal(first.onboardingSubsidy.reserved, true);

  await assert.rejects(
    () => service.claimJob(WALLET_2, "brokered-gas-2", "http", "brokered-rotated"),
    (error) => error.code === "onboarding_subsidy_exhausted"
  );
  assert.equal(budget.reserveCalls, 2);
});

test("exhausting tier-0 subsidy does not gate a non-subsidised claim", async () => {
  const stateStore = new MemoryStateStore();
  const budget = makeTestOnboardingSubsidyBudget();
  const selfFundedJob = makeJob({
    id: "self-funded",
    rewardAsset: "USDC",
    rewardAmount: 1,
    requiresSponsoredGas: false,
    onboardingWaiverEligible: false,
    source: "external"
  });
  const { id: _jobId, source: _source, ...selfFundedDefinition } = selfFundedJob;
  await stateStore.materializeExternalJobDraft({
    draftId: "self-funded-draft",
    jobId: selfFundedJob.id,
    wallet: WALLET,
    definition: selfFundedDefinition,
    status: "live",
    createdAt: "2026-08-11T10:00:00.000Z",
    expiresAt: "2026-08-14T10:00:00.000Z"
  });
  const jobs = new Map([
    makeJob({
      id: "subsidised",
      rewardAsset: "USDC",
      rewardAmount: 1,
      requiresSponsoredGas: true,
      onboardingWaiverEligible: true
    }),
    selfFundedJob
  ].map((job) => [job.id, job]));
  const service = new JobExecutionService(
    stateStore,
    undefined,
    (jobId) => jobs.get(jobId),
    undefined,
    undefined,
    async () => 500,
    (jobId) => jobs.get(jobId),
    async () => ({ minClaimFeeByAsset: { USDC: 0.05 } }),
    { onboardingSubsidyBudget: budget }
  );

  await service.claimJob(WALLET, "subsidised", "http", "consume-subsidy");
  const paid = await service.claimJob(WALLET_2, "self-funded", "http", "paid-after-exhaustion");

  assert.equal(paid.claimEconomicsWaived, false);
  assert.equal(paid.totalClaimLock, 0.1);
  assert.equal(budget.reserveCalls, 1);
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

test("external submits require the worker transaction then converge its exact evidence without broker gas", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob({
    source: { type: "external", poster: { wallet: WALLET_2 } },
    requiresSponsoredGas: false
  });
  let liveState = 2;
  let evidenceHash;
  let brokerCalls = 0;
  const gateway = {
    isEnabled: () => true,
    async getJob() { return { state: liveState, worker: WALLET }; },
    async prepareDirectSubmitWork(jobId, evidence) {
      assert.equal(jobId, job.id);
      evidenceHash = evidence;
      return { to: "0x1111111111111111111111111111111111111111", value: "0", data: "0x5678" };
    },
    async getLatestEvidence() { return evidenceHash; },
    async submitWork() { brokerCalls += 1; }
  };
  const service = new JobExecutionService(stateStore, gateway, () => job);
  const claimed = transitionSession(
    { sessionId: `${job.id}:external`, wallet: WALLET, jobId: job.id, chainJobId: job.id, protocolHistory: [] },
    "claimed",
    { reason: "job_claimed" }
  );
  await stateStore.upsertSession(claimed);
  const submission = {
    summary: "Auth flow has one blocker.",
    findings: [{ severity: "high", file: "frontend/auth.js", issue: "x", recommendation: "y" }],
    risk_level: "high",
    files_touched: ["frontend/auth.js"],
    recommended_next_step: "request_changes"
  };

  await assert.rejects(
    service.submitWork(claimed.sessionId, "mcp", submission),
    (error) => {
      assert.equal(error.code, "external_self_paid_submit_required");
      assert.equal(error.details.evidenceHash, evidenceHash);
      assert.equal(error.details.requiresSponsoredGas, false);
      return true;
    }
  );
  liveState = 3;
  const converged = await service.submitWork(claimed.sessionId, "mcp", submission);

  assert.equal(converged.status, "submitted");
  assert.equal(brokerCalls, 0);
  assert.equal((await stateStore.getSession(claimed.sessionId)).status, "submitted");
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

test("submitWork refuses to start a second submit while the session lock is held (pre-audit #6)", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob();
  const service = new JobExecutionService(stateStore, undefined, () => job);
  const claimed = transitionSession(
    { sessionId: `${job.id}:0xc6`, wallet: WALLET, jobId: job.id, chainJobId: `${job.id}:0xc6`, protocolHistory: [] },
    "claimed",
    { reason: "job_claimed" }
  );
  await stateStore.upsertSession(claimed);
  // A concurrent submit/claim holds the per-session lock.
  await stateStore.acquireClaimLock(claimed.sessionId, "other-owner", 30);

  await assert.rejects(
    () =>
      service.submitWork(claimed.sessionId, "http", {
        summary: "Auth flow has one blocker.",
        findings: [{ severity: "high", file: "frontend/auth.js", issue: "x", recommendation: "y" }],
        risk_level: "high",
        files_touched: ["frontend/auth.js"],
        recommended_next_step: "request_changes"
      }),
    (error) => error.code === "submit_in_progress"
  );
  // The contender did not advance the session.
  const stored = await stateStore.getSession(claimed.sessionId);
  assert.equal(stored.status, "claimed");
});

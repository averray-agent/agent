import assert from "node:assert/strict";
import test from "node:test";

import { id, parseUnits } from "ethers";

import { buildDiscoveryManifest } from "./discovery-manifest.js";
import {
  ExternalPostingService,
  rebuildExternalDraftArtifacts,
  resolveExternalPostingConfig
} from "./external-posting-service.js";
import { AuthorizationError, ValidationError } from "./errors.js";
import { JobExecutionService } from "./job-execution-service.js";
import { MemoryStateStore } from "./state-store.js";
import { createJobRoutes } from "../protocols/http/job-routes.js";

const POSTER = "0x1111111111111111111111111111111111111111";
const OTHER_POSTER = "0x2222222222222222222222222222222222222222";
const ESCROW = "0x3333333333333333333333333333333333333333";
const USDC = "0x0000053900000000000000000000000001200000";
const EXTERNAL_JOB_ID = `0x${"a".repeat(64)}`;

function definition(overrides = {}) {
  return {
    category: "coding",
    tier: "starter",
    rewardAsset: "USDC",
    rewardAmount: "1.0",
    verifierMode: "benchmark",
    verifierTerms: ["complete", "verified"],
    verifierMinimumMatches: 1,
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: "schema://jobs/coding-output",
    input: {
      task: "Implement the requested change.",
      acceptanceCriteria: ["The focused tests pass."]
    },
    claimTtlSeconds: 3600,
    retryLimit: 1,
    ...overrides
  };
}

function config(overrides = {}) {
  return resolveExternalPostingConfig({
    EXTERNAL_POSTING_MODE: "open",
    EXTERNAL_POSTING_MIN_REWARD_USDC: "1",
    EXTERNAL_POSTING_MAX_REWARD_USDC: "10000",
    EXTERNAL_POSTING_DRAFT_TTL_HOURS: "72",
    ESCROW_CORE_ADDRESS: ESCROW,
    SUPPORTED_ASSETS_JSON: JSON.stringify([
      { symbol: "USDC", address: USDC, decimals: 6 }
    ]),
    ...overrides
  });
}

function makeService({
  env = {},
  now = () => new Date("2026-07-28T12:00:00.000Z"),
  store = new MemoryStateStore(),
  gateway = feeQuoteGateway()
} = {}) {
  return {
    store,
    service: new ExternalPostingService({
      stateStore: store,
      gateway,
      config: config(env),
      now
    })
  };
}

function feeQuoteGateway(overrides = {}) {
  return {
    async previewProtocolFeeForAsset(_asset, rewardAmount) {
      const rewardRaw = parseUnits(String(rewardAmount), 6);
      return {
        rewardAmountRaw: rewardRaw.toString(),
        protocolFeeAmountRaw: (rewardRaw * 500n / 10_000n).toString(),
        protocolFeeBps: 500,
        ...overrides
      };
    }
  };
}

test("external posting mode defaults closed and open mode admits every SIWE wallet", async () => {
  const closedStore = new MemoryStateStore();
  const closed = new ExternalPostingService({
    stateStore: closedStore,
    gateway: feeQuoteGateway(),
    config: resolveExternalPostingConfig({
      ESCROW_CORE_ADDRESS: ESCROW,
      SUPPORTED_ASSETS_JSON: JSON.stringify([{ symbol: "USDC", address: USDC, decimals: 6 }])
    })
  });

  await assert.rejects(
    closed.createDraft(POSTER, { definition: definition() }),
    (error) => error instanceof AuthorizationError && error.code === "external_posting_closed"
  );
  await assert.rejects(
    closed.createDraft(OTHER_POSTER, { definition: definition() }),
    (error) => error instanceof AuthorizationError && error.code === "external_posting_closed"
  );

  const closedSignals = await closedStore.listExternalPostingDemandSignals();
  assert.deepEqual(closedSignals.map((entry) => entry.decision), ["mode_closed", "mode_closed"]);

  const { service } = makeService();
  assert.equal((await service.createDraft(POSTER, { definition: definition() })).status, "quoted");
  assert.equal((await service.createDraft(OTHER_POSTER, { definition: definition() })).status, "quoted");
});

test("escrow-first quote persists only demand, prices the additive fee, and preserves the full worker reward", async () => {
  const { service, store } = makeService();
  const quote = await service.createDraft(POSTER, { definition: definition() });

  assert.equal(quote.status, "quoted");
  assert.equal(quote.persisted, false);
  assert.equal(await store.getExternalJobDraft(quote.draftId), undefined);
  assert.deepEqual(quote.fundingRequirement, {
    asset: "USDC",
    assetAddress: USDC,
    decimals: 6,
    rewardRaw: "1000000",
    workerReceivesRaw: "1000000",
    opsReserveRaw: "0",
    contingencyReserveRaw: "0",
    protocolFeeRaw: "50000",
    protocolFeeBps: 500,
    posterReservedRaw: "1050000",
    feeSemantics: "poster_additive",
    source: "live EscrowCore.previewProtocolFee at quote time",
    expiresWithQuote: true
  });
  const signal = await store.getExternalPostingDemandSignal(quote.draftId);
  assert.equal(signal.decision, "quoted");
  assert.equal(signal.fundingStatus, "unfunded");
  assert.equal(signal.quote.jobId, quote.jobId);
});

test("external definitions cannot opt into the curated operator gas subsidy or onboarding waiver", async () => {
  const { service, store } = makeService();

  await assert.rejects(
    service.createDraft(POSTER, { definition: definition({ requiresSponsoredGas: true }) }),
    (error) => error.code === "external_sponsored_gas_forbidden"
  );
  await assert.rejects(
    service.createDraft(POSTER, { definition: definition({ onboardingWaiverEligible: true }) }),
    (error) => error.code === "external_onboarding_waiver_forbidden"
  );
  assert.deepEqual(
    (await store.listExternalPostingDemandSignals()).map((entry) => entry.decision),
    ["validation_rejected", "validation_rejected"]
  );
});

test("an unreconciled live fee quote fails closed but still records the demand attempt", async () => {
  const store = new MemoryStateStore();
  const { service } = makeService({
    store,
    gateway: feeQuoteGateway({ protocolFeeAmountRaw: "1" })
  });

  await assert.rejects(
    service.createDraft(POSTER, { definition: definition() }),
    (error) => error.code === "external_fee_quote_mismatch"
  );
  const [signal] = await store.listExternalPostingDemandSignals();
  assert.equal(signal.decision, "quote_failed");
  assert.equal(signal.reason, "external_fee_quote_mismatch");
});

test("external posting config exposes a live poster-review window with a seven-day default", () => {
  assert.equal(config().reviewWindowHours, 168);
  assert.equal(config({ EXTERNAL_POSTING_REVIEW_WINDOW_HOURS: "48" }).reviewWindowHours, 48);
});

test("external posting config exposes and validates its explicit reward ceiling", () => {
  assert.equal(config().maxRewardUsdc, "10000");
  assert.equal(config().maxRewardRaw, 10_000_000_000n);
  assert.equal(
    config({ EXTERNAL_POSTING_MAX_REWARD_USDC: "25000" }).maxRewardUsdc,
    "25000"
  );
  assert.throws(
    () => config({
      EXTERNAL_POSTING_MIN_REWARD_USDC: "2",
      EXTERNAL_POSTING_MAX_REWARD_USDC: "1"
    }),
    /must be greater than or equal to EXTERNAL_POSTING_MIN_REWARD_USDC/u
  );
});

test("optional allowlist mode admits only configured wallets without changing the closed default", async () => {
  const store = new MemoryStateStore();
  const service = new ExternalPostingService({
    stateStore: store,
    gateway: feeQuoteGateway(),
    config: config({
      EXTERNAL_POSTING_MODE: "allowlist",
      EXTERNAL_POSTING_ALLOWLIST: POSTER
    })
  });

  assert.equal((await service.createDraft(POSTER, { definition: definition() })).status, "quoted");
  await assert.rejects(
    service.createDraft(OTHER_POSTER, { definition: definition() }),
    (error) => error instanceof AuthorizationError && error.code === "external_poster_not_allowed"
  );
  assert.deepEqual(
    (await store.listExternalPostingDemandSignals()).map((entry) => entry.decision),
    ["quoted", "allowlist_rejected"]
  );
});

test("stored definition deterministically rebuilds jobId, specHash, and calldata byte-for-byte", async () => {
  const { service, store } = makeService();
  const created = await service.createDraft(POSTER, {
    definition: definition({
      description: "Unicode and numeric canonicalization: € \r\n",
      source: { z: 1e30, a: 0.000001 }
    })
  });
  const stored = (await store.getExternalPostingDemandSignal(created.draftId)).quote;
  const rebuilt = rebuildExternalDraftArtifacts(stored, config());

  assert.equal(
    created.jobId,
    "0x2252ac6a094fb1885bf61f1d83dc269e871a0ed87b93ca03b4e59fbd4bab8932",
    "the wallet + content hash canonical string is a versioned compatibility contract"
  );
  assert.equal(
    created.specHash,
    "0xde4abc02a2612f6daebff34858cc81710601036d63a8bac09d25c926fe179a7b",
    "RFC 8785 canonicalization drift must fail this compatibility vector"
  );
  assert.equal(rebuilt.jobId, created.jobId);
  assert.equal(rebuilt.specHash, created.specHash);
  assert.deepEqual(rebuilt.calldata, created.calldata);
  assert.equal(created.calldata.args[0], created.jobId);
  assert.equal(created.calldata.args[8], created.specHash);
  assert.equal(created.calldata.args[2], "1000000");
  assert.equal(created.calldata.args[6], id("benchmark"));
  assert.equal(created.calldata.args[7], id("coding"));

  const drifted = {
    ...stored,
    definition: {
      ...stored.definition,
      description: `${stored.definition.description}drift`
    }
  };
  assert.notEqual(rebuildExternalDraftArtifacts(drifted, config()).specHash, created.specHash);
});

test("reward floor rejects 0.99, accepts 1.0, and persists both demand signals", async () => {
  const { service, store } = makeService();

  await assert.rejects(
    service.createDraft(POSTER, { definition: definition({ rewardAmount: "0.99" }) }),
    (error) => error instanceof ValidationError && error.code === "external_reward_below_floor"
  );
  const accepted = await service.createDraft(POSTER, {
    definition: definition({ rewardAmount: "1.0" })
  });

  assert.equal(accepted.status, "quoted");
  assert.deepEqual(
    (await store.listExternalPostingDemandSignals()).map((entry) => ({
      decision: entry.decision,
      requestedReward: entry.requestedReward,
      schema: entry.schema
    })),
    [
      {
        decision: "floor_rejected",
        requestedReward: "0.99",
        schema: "schema://jobs/coding-output"
      },
      {
        decision: "quoted",
        requestedReward: "1.0",
        schema: "schema://jobs/coding-output"
      }
    ]
  );
});

test("reward ceiling rejects the adversarial impossible quote with the named rule and value", async () => {
  const { service, store } = makeService();

  await assert.rejects(
    service.createDraft(POSTER, {
      definition: definition({ rewardAmount: "1000000000" })
    }),
    (error) => error instanceof ValidationError
      && error.code === "external_reward_above_ceiling"
      && error.details?.maximumRewardUsdc === "10000"
      && error.details?.requestedReward === "1000000000"
  );
  const [signal] = await store.listExternalPostingDemandSignals();
  assert.equal(signal.decision, "ceiling_rejected");
  assert.equal(signal.requestedReward, "1000000000");
});

test("invalid reward shape names the rule and echoes the rejected value", async () => {
  const { service, store } = makeService();

  await assert.rejects(
    service.createDraft(POSTER, {
      definition: definition({ rewardAmount: "-1" })
    }),
    (error) => error instanceof ValidationError
      && error.code === "external_reward_invalid_shape"
      && error.details?.rule === "unsigned_decimal_with_asset_precision"
      && error.details?.asset === "USDC"
      && error.details?.maximumDecimalPlaces === 6
      && error.details?.requestedReward === "-1"
  );
  const [signal] = await store.listExternalPostingDemandSignals();
  assert.equal(signal.decision, "validation_rejected");
  assert.equal(signal.requestedReward, "-1");
});

test("draft creation rejects a zero claim TTL with a named external-door error", async () => {
  const { service } = makeService();

  await assert.rejects(
    service.createDraft(POSTER, {
      definition: definition({ claimTtlSeconds: 0 })
    }),
    (error) => error instanceof ValidationError
      && error.code === "external_claim_ttl_invalid"
      && error.details?.minimumClaimTtlSeconds === 60
      && error.details?.requestedClaimTtlSeconds === 0
  );
});

test("unknown or poster-supplied schemas are rejected and logged", async () => {
  const { service, store } = makeService();

  await assert.rejects(
    service.createDraft(POSTER, {
      definition: definition({
        outputSchemaRef: "schema://jobs/poster-output",
        schemaRegistrations: [{ schemaRef: "schema://jobs/poster-output" }]
      })
    }),
    (error) => error instanceof ValidationError && error.code === "external_schema_not_supported"
  );

  const [signal] = await store.listExternalPostingDemandSignals();
  assert.equal(signal.decision, "schema_rejected");
  assert.equal(signal.schema, "schema://jobs/poster-output");
});

test("a 73-hour-old draft stays expired even if a later reader has a longer configured TTL", async () => {
  let current = new Date("2026-07-20T00:00:00.000Z");
  const store = new MemoryStateStore();
  const creator = new ExternalPostingService({
    stateStore: store,
    gateway: feeQuoteGateway(),
    config: config(),
    now: () => current
  });
  const created = await creator.createDraft(POSTER, { definition: definition() });

  current = new Date("2026-07-23T01:00:00.000Z");
  const reader = new ExternalPostingService({
    stateStore: store,
    gateway: feeQuoteGateway(),
    config: config({ EXTERNAL_POSTING_DRAFT_TTL_HOURS: "720" }),
    now: () => current
  });
  const expired = await reader.getDraft(POSTER, created.draftId);

  assert.equal(expired.status, "expired");
  assert.equal(expired.expiresAt, "2026-07-23T00:00:00.000Z");
  assert.equal(expired.note, undefined);
});

test("poster draft status reports a live job as delisted after the catalog backstop", async () => {
  const { service } = makeService();
  const created = await service.createDraft(POSTER, { definition: definition() });
  await service.reconcileFinalizedCreation({
    jobId: created.jobId,
    specHash: created.specHash,
    poster: POSTER,
    asset: USDC,
    reward: "1000000",
    opsReserve: "0",
    contingencyReserve: "0",
    fundedAt: "2026-07-28T12:01:00.000Z",
    txHash: `0x${"f".repeat(64)}`,
    blockNumber: "123",
    finalized: true
  });
  await service.delistExternalJob(created.jobId, {
    adminWallet: OTHER_POSTER,
    reason: "operator rescue requested"
  });

  const draft = await service.getDraft(POSTER, created.draftId);
  assert.equal(draft.status, "delisted");
  assert.equal(draft.delisted, true);
  assert.equal(draft.previousStatus, "live");
  assert.equal(draft.delistReason, "operator rescue requested");
  assert.equal(draft.delistedAt, "2026-07-28T12:00:00.000Z");
  assert.equal(draft.txHash, `0x${"f".repeat(64)}`);
});

test("poster-content quotes are idempotent and persist no pre-funding draft", async () => {
  const { service, store } = makeService({
    now: () => new Date("2026-07-20T00:00:00.000Z")
  });

  const first = await service.createDraft(POSTER, { definition: definition() });
  const replay = await service.createDraft(POSTER, { definition: definition() });
  const distinct = await service.createDraft(POSTER, {
    definition: definition({ input: { task: "A distinct funded task.", acceptanceCriteria: ["It passes."] } })
  });

  assert.equal(replay.draftId, first.draftId);
  assert.equal(replay.jobId, first.jobId);
  assert.notEqual(distinct.jobId, first.jobId);
  assert.equal(await store.getExternalJobDraft(first.draftId), undefined);
  assert.equal(await store.getExternalJobDraft(distinct.draftId), undefined);
  const signals = await store.listExternalPostingDemandSignals();
  assert.equal(signals.length, 2);
  assert.equal(signals.find((entry) => entry.id === first.draftId).attemptCount, 2);
  assert.equal(signals.find((entry) => entry.id === first.draftId).fundingStatus, "unfunded");
});

test("draft persistence cannot change GET /jobs or the discovery manifest", async () => {
  const jobs = [{ id: "curated-1", category: "coding", title: "Curated", lifecycle: { state: "open" } }];
  const invokeJobs = async () => {
    const response = {};
    const route = createJobRoutes({
      authMiddleware: async () => ({ wallet: POSTER, claims: { roles: [] } }),
      enforceLimit: async () => {},
      ensureSessionOwnership: async () => {},
      rateLimitConfig: { adminJobs: { limit: 1, windowSeconds: 60 } },
      readJsonBody: async () => ({}),
      respond: (target, statusCode, body) => Object.assign(target, { statusCode, body }),
      service: {
        listJobsWithSessions: async () => jobs
      }
    });
    await route({
      request: { method: "GET" },
      response,
      url: new URL("http://localhost/jobs"),
      pathname: "/jobs"
    });
    return JSON.stringify(response.body);
  };

  const { service } = makeService();
  const jobsBefore = await invokeJobs();
  const manifestBefore = JSON.stringify(buildDiscoveryManifest());
  await service.createDraft(POSTER, { definition: definition() });
  const jobsAfter = await invokeJobs();
  const manifestAfter = JSON.stringify(buildDiscoveryManifest());

  assert.equal(jobsAfter, jobsBefore);
  assert.equal(manifestAfter, manifestBefore);
  assert.doesNotMatch(manifestAfter, /jobs\/draft|external posting/iu);
});

test("admin delist only removes future catalog projection and leaves on-chain state untouched", async () => {
  const { service, store } = makeService();
  const onChainJob = Object.freeze({
    jobId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    poster: POSTER,
    state: "Open",
    reward: "1000000"
  });
  const catalogProjection = [
    { id: onChainJob.jobId, source: "external" },
    { id: `${onChainJob.jobId.slice(0, -1)}b`, source: { type: "external" } },
    { id: "curated-1", source: "ingested" }
  ];

  await service.delistExternalJob(onChainJob.jobId, {
    adminWallet: OTHER_POSTER,
    reason: "operator safety backstop"
  });
  await service.delistExternalJob(`${onChainJob.jobId.slice(0, -1)}b`, {
    adminWallet: OTHER_POSTER,
    reason: "operator safety backstop"
  });

  assert.deepEqual(onChainJob, {
    jobId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    poster: POSTER,
    state: "Open",
    reward: "1000000"
  });
  assert.deepEqual(
    await service.filterExternalCatalogProjection(catalogProjection),
    [{ id: "curated-1", source: "ingested" }]
  );
  assert.equal((await store.getExternalJobDelisting(onChainJob.jobId)).reason, "operator safety backstop");
});

test("delist cannot slip through while an external direct-claim recipe holds the shared lifecycle lane", async () => {
  const store = new MemoryStateStore();
  const externalPosting = new ExternalPostingService({ stateStore: store, config: config() });
  const job = {
    ...definition(),
    id: EXTERNAL_JOB_ID,
    source: { type: "external", poster: { wallet: POSTER } },
    onboardingWaiverEligible: false
  };
  let liveState = 1;
  let enterClaim;
  let releaseClaim;
  const claimEntered = new Promise((resolve) => { enterClaim = resolve; });
  const claimGate = new Promise((resolve) => { releaseClaim = resolve; });
  const gateway = {
    isEnabled: () => true,
    toJobId: (value) => value,
    getJob: async () => ({ state: liveState }),
    getDefaultClaimStakeBps: async () => 1_000,
    getClaimEconomicsConfig: async () => ({ onboardingWaiverClaimCount: 0 }),
    getWorkerClaimCount: async () => 0,
    getClaimEconomicsDecisionState: async () => ({
      state: liveState,
      exists: true,
      contractLayout: "current",
      onboardingWaiverEligible: false
    }),
    previewClaimEconomics: async () => ({
      claimStake: 0,
      claimStakeBps: 0,
      claimFee: 0,
      claimFeeBps: 0,
      claimEconomicsWaived: false,
      claimNumber: 1,
      totalClaimLock: 0
    }),
    ensureClaimStakeLiquidity: async () => {},
    prepareDirectClaimJob: async () => {
      enterClaim();
      await claimGate;
      return { to: ESCROW, data: "0x1234", value: "0" };
    }
  };
  const execution = new JobExecutionService(store, gateway, () => job);
  const claimPromise = execution.claimJob(OTHER_POSTER, job.id, "http", "claim-wins-race");
  await claimEntered;

  const delistAttempt = await externalPosting.delistExternalJob(job.id, {
    adminWallet: POSTER,
    reason: "race probe"
  }).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  releaseClaim();
  const claimResult = await claimPromise.then(
    (value) => ({ value }),
    (error) => ({ error })
  );

  assert.equal(delistAttempt.value, undefined);
  assert.equal(delistAttempt.error?.code, "external_job_transition_in_progress");
  assert.equal(await store.isExternalJobDelisted(job.id), false);
  assert.equal(claimResult.value, undefined);
  assert.equal(claimResult.error?.code, "external_self_paid_claim_required");
});

test("claim cannot slip through while delist holds the shared lifecycle lane", async () => {
  let enterDelist;
  let releaseDelist;
  const delistEntered = new Promise((resolve) => { enterDelist = resolve; });
  const delistGate = new Promise((resolve) => { releaseDelist = resolve; });
  class BlockingDelistStore extends MemoryStateStore {
    async upsertExternalJobDelisting(record) {
      enterDelist();
      await delistGate;
      return super.upsertExternalJobDelisting(record);
    }
  }
  const store = new BlockingDelistStore();
  const externalPosting = new ExternalPostingService({ stateStore: store, config: config() });
  const job = {
    ...definition(),
    id: EXTERNAL_JOB_ID,
    source: { type: "external", poster: { wallet: POSTER } },
    onboardingWaiverEligible: true
  };
  const execution = new JobExecutionService(store, undefined, () => job);
  const delistPromise = externalPosting.delistExternalJob(job.id, {
    adminWallet: OTHER_POSTER,
    reason: "operator rescue requested"
  });
  await delistEntered;

  const racedClaim = await execution.claimJob(
    OTHER_POSTER,
    job.id,
    "http",
    "delist-wins-race"
  ).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  releaseDelist();
  await delistPromise;

  assert.equal(racedClaim.value, undefined);
  assert.equal(racedClaim.error?.code, "external_job_transition_in_progress");
  await assert.rejects(
    execution.claimJob(OTHER_POSTER, job.id, "http", "delisted-after-race"),
    (error) => error.code === "external_job_delisted"
      && error.details?.jobId === job.id
      && error.details?.delistReason === "operator rescue requested"
  );
});

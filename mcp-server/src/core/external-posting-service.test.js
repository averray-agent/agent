import assert from "node:assert/strict";
import test from "node:test";

import { id } from "ethers";

import { buildDiscoveryManifest } from "./discovery-manifest.js";
import {
  ExternalPostingService,
  rebuildExternalDraftArtifacts,
  resolveExternalPostingConfig
} from "./external-posting-service.js";
import { AuthorizationError, ValidationError } from "./errors.js";
import { MemoryStateStore } from "./state-store.js";
import { createJobRoutes } from "../protocols/http/job-routes.js";

const POSTER = "0x1111111111111111111111111111111111111111";
const OTHER_POSTER = "0x2222222222222222222222222222222222222222";
const ESCROW = "0x3333333333333333333333333333333333333333";
const USDC = "0x0000053900000000000000000000000001200000";

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
    EXTERNAL_POSTING_DRAFT_TTL_HOURS: "72",
    EXTERNAL_POSTING_MAX_OPEN_DRAFTS: "10",
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
  store = new MemoryStateStore()
} = {}) {
  return {
    store,
    service: new ExternalPostingService({
      stateStore: store,
      config: config(env),
      now
    })
  };
}

test("external posting mode defaults closed and open mode admits every SIWE wallet", async () => {
  const closedStore = new MemoryStateStore();
  const closed = new ExternalPostingService({
    stateStore: closedStore,
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
  assert.equal((await service.createDraft(POSTER, { definition: definition() })).status, "awaiting_funding");
  assert.equal((await service.createDraft(OTHER_POSTER, { definition: definition() })).status, "awaiting_funding");
});

test("optional allowlist mode admits only configured wallets without changing the closed default", async () => {
  const store = new MemoryStateStore();
  const service = new ExternalPostingService({
    stateStore: store,
    config: config({
      EXTERNAL_POSTING_MODE: "allowlist",
      EXTERNAL_POSTING_ALLOWLIST: POSTER
    })
  });

  assert.equal((await service.createDraft(POSTER, { definition: definition() })).status, "awaiting_funding");
  await assert.rejects(
    service.createDraft(OTHER_POSTER, { definition: definition() }),
    (error) => error instanceof AuthorizationError && error.code === "external_poster_not_allowed"
  );
  assert.deepEqual(
    (await store.listExternalPostingDemandSignals()).map((entry) => entry.decision),
    ["accepted", "allowlist_rejected"]
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
  const stored = await store.getExternalJobDraft(created.draftId);
  const rebuilt = rebuildExternalDraftArtifacts(stored, config());

  assert.equal(
    created.jobId,
    "0xef162a2581b2c288d39230945c5a32ee1d1da49ef73f9d0451347e3ab4b36065",
    "the wallet + nonce canonical string is a versioned compatibility contract"
  );
  assert.equal(
    created.specHash,
    "0x50d1eec9719d1fd1cb474121d6d2dfad1aee53167f2980c950b8d5cb5a5835d3",
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

  assert.equal(accepted.status, "awaiting_funding");
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
        decision: "accepted",
        requestedReward: "1.0",
        schema: "schema://jobs/coding-output"
      }
    ]
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
    config: config(),
    now: () => current
  });
  const created = await creator.createDraft(POSTER, { definition: definition() });

  current = new Date("2026-07-23T01:00:00.000Z");
  const reader = new ExternalPostingService({
    stateStore: store,
    config: config({ EXTERNAL_POSTING_DRAFT_TTL_HOURS: "720" }),
    now: () => current
  });
  const expired = await reader.getDraft(POSTER, created.draftId);

  assert.equal(expired.status, "expired");
  assert.equal(expired.expiresAt, "2026-07-23T00:00:00.000Z");
  assert.equal(expired.note, undefined);
});

test("open drafts are capped per wallet while expired drafts no longer count", async () => {
  let current = new Date("2026-07-20T00:00:00.000Z");
  const { service } = makeService({
    env: { EXTERNAL_POSTING_MAX_OPEN_DRAFTS: "2" },
    now: () => current
  });

  await service.createDraft(POSTER, { definition: definition() });
  await service.createDraft(POSTER, { definition: definition() });
  await assert.rejects(
    service.createDraft(POSTER, { definition: definition() }),
    (error) => error.code === "external_draft_cap_reached"
  );

  current = new Date("2026-07-24T00:00:00.000Z");
  assert.equal((await service.createDraft(POSTER, { definition: definition() })).status, "awaiting_funding");
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

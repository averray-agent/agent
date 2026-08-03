import assert from "node:assert/strict";
import test from "node:test";

import { Interface, Transaction, Wallet } from "ethers";

import {
  CREATE_SINGLE_PAYOUT_SIGNATURE,
  ExternalPostingService,
  resolveExternalPostingConfig
} from "../core/external-posting-service.js";
import { MemoryStateStore } from "../core/state-store.js";
import { PlatformService } from "../core/platform-service.js";
import { EventBus } from "../core/event-bus.js";
import { VerifierService } from "./verifier-service.js";
import {
  ExternalPostingWatcherService,
  resolveExternalPostingWatcherConfig
} from "./external-posting-watcher.js";

const POSTER_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const POSTER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const WORKER = "0x2222222222222222222222222222222222222222";
const ESCROW = "0x3333333333333333333333333333333333333333";
const USDC = "0x0000053900000000000000000000000001200000";
const TX_HASH = `0x${"ab".repeat(32)}`;
const CREATED_AT = "2026-07-20T00:00:00.000Z";

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

function postingConfig(mode = "open") {
  return resolveExternalPostingConfig({
    EXTERNAL_POSTING_MODE: mode,
    EXTERNAL_POSTING_MIN_REWARD_USDC: "1",
    EXTERNAL_POSTING_DRAFT_TTL_HOURS: "72",
    EXTERNAL_POSTING_MAX_OPEN_DRAFTS: "10",
    ESCROW_CORE_ADDRESS: ESCROW,
    SUPPORTED_ASSETS_JSON: JSON.stringify([
      { symbol: "USDC", address: USDC, decimals: 6 }
    ])
  });
}

function makeProjectionPlatform() {
  const jobs = new Map();
  return {
    jobs,
    createExternalJobProjection(draft, confirmation) {
      if (!jobs.has(draft.jobId)) {
        jobs.set(draft.jobId, {
          ...draft.definition,
          id: draft.jobId,
          source: {
            type: "external",
            poster: {
              wallet: draft.wallet,
              fundedAt: confirmation.fundedAt,
              txHash: confirmation.txHash,
              blockNumber: confirmation.blockNumber
            }
          }
        });
      }
      return jobs.get(draft.jobId);
    }
  };
}

async function createHarness({
  mode = "open",
  now = CREATED_AT,
  store = new MemoryStateStore(),
  platformService = makeProjectionPlatform(),
  logger = { info() {}, warn() {}, error() {} }
} = {}) {
  const service = new ExternalPostingService({
    stateStore: store,
    platformService,
    config: postingConfig(mode),
    now: () => new Date(now),
    logger
  });
  return { service, store, platformService };
}

function matchingCreation(draft, overrides = {}) {
  return {
    jobId: draft.jobId,
    specHash: draft.specHash,
    poster: POSTER,
    asset: USDC,
    reward: draft.calldata.args[2],
    opsReserve: draft.calldata.args[3],
    contingencyReserve: draft.calldata.args[4],
    fundedAt: "2026-07-20T01:00:00.000Z",
    txHash: TX_HASH,
    blockNumber: "1234",
    finalized: true,
    ...overrides
  };
}

test("a byte-exact finalized creation flips the draft live and projects poster provenance", async () => {
  const { service, platformService } = await createHarness();
  const draft = await service.createDraft(POSTER, { definition: definition() });
  const optimistic = {
    id: draft.jobId,
    source: { type: "external" }
  };

  assert.deepEqual(
    await service.filterExternalCatalogProjection([optimistic]),
    [],
    "an external-looking row without watcher confirmation must stay hidden"
  );

  const result = await service.reconcileFinalizedCreation(matchingCreation(draft));

  assert.equal(result.outcome, "live");
  assert.equal((await service.getDraft(POSTER, draft.draftId)).status, "live");
  assert.deepEqual(
    await service.filterExternalCatalogProjection([optimistic]),
    [optimistic]
  );
  assert.deepEqual(platformService.jobs.get(draft.jobId).source.poster, {
    wallet: POSTER,
    fundedAt: "2026-07-20T01:00:00.000Z",
    txHash: TX_HASH,
    blockNumber: "1234"
  });
});

test("one-unit reward divergence is permanently mismatch(reward) and can never become live", async () => {
  const { service, platformService } = await createHarness();
  const draft = await service.createDraft(POSTER, { definition: definition() });
  const divergent = matchingCreation(draft, {
    reward: (BigInt(draft.calldata.args[2]) + 1n).toString()
  });

  const mismatch = await service.reconcileFinalizedCreation(divergent);
  const replay = await service.reconcileFinalizedCreation(matchingCreation(draft));

  assert.equal(mismatch.outcome, "mismatch");
  assert.equal(mismatch.field, "reward");
  assert.equal(replay.outcome, "mismatch");
  assert.equal(replay.field, "reward");
  assert.equal((await service.getDraft(POSTER, draft.draftId)).status, "mismatch(reward)");
  assert.equal(platformService.jobs.has(draft.jobId), false);
});

test("an unknown finalized on-chain job is logged and never projected", async () => {
  const warnings = [];
  const { service, platformService } = await createHarness({
    logger: {
      info() {},
      error() {},
      warn(fields, message) {
        warnings.push({ fields, message });
      }
    }
  });
  const unknownJobId = `0x${"cd".repeat(32)}`;

  const result = await service.reconcileFinalizedCreation({
    jobId: unknownJobId,
    specHash: `0x${"ef".repeat(32)}`,
    poster: POSTER,
    asset: USDC,
    reward: "1000000",
    opsReserve: "0",
    contingencyReserve: "0",
    fundedAt: "2026-07-20T01:00:00.000Z",
    txHash: TX_HASH,
    blockNumber: "1234",
    finalized: true
  });

  assert.equal(result.outcome, "unknown");
  assert.equal(platformService.jobs.size, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].fields.jobId, unknownJobId);
});

test("funded at hour 71 and first observed at hour 73 still becomes live", async () => {
  const { service, platformService } = await createHarness({
    now: "2026-07-23T01:00:00.000Z"
  });
  const creator = new ExternalPostingService({
    stateStore: service.stateStore,
    platformService,
    config: postingConfig("open"),
    now: () => new Date(CREATED_AT)
  });
  const draft = await creator.createDraft(POSTER, { definition: definition() });

  const result = await service.reconcileFinalizedCreation(matchingCreation(draft, {
    fundedAt: "2026-07-22T23:00:00.000Z"
  }));

  assert.equal(result.outcome, "live");
  assert.equal((await service.getDraft(POSTER, draft.draftId)).status, "live");
  assert.equal(platformService.jobs.has(draft.jobId), true);
});

test("a delisted matched escrow stays unprojected and the observation remains untouched", async () => {
  const { service, platformService } = await createHarness();
  const draft = await service.createDraft(POSTER, { definition: definition() });
  const observation = Object.freeze(matchingCreation(draft));
  await service.delistExternalJob(draft.jobId, {
    adminWallet: WORKER,
    reason: "abuse backstop"
  });

  const result = await service.reconcileFinalizedCreation(observation);

  assert.equal(result.outcome, "live");
  assert.equal(result.projected, false);
  assert.equal(result.reason, "delisted");
  assert.equal(platformService.jobs.has(draft.jobId), false);
  assert.deepEqual(observation, matchingCreation(draft));
});

test("mode closed after funding does not stop reconciliation or projection", async () => {
  const store = new MemoryStateStore();
  const platformService = makeProjectionPlatform();
  const open = (await createHarness({ store, platformService })).service;
  const draft = await open.createDraft(POSTER, { definition: definition() });
  const closed = (await createHarness({
    mode: "closed",
    now: "2026-07-20T02:00:00.000Z",
    store,
    platformService
  })).service;

  const result = await closed.reconcileFinalizedCreation(matchingCreation(draft));

  assert.equal(result.outcome, "live");
  assert.equal(platformService.jobs.has(draft.jobId), true);
});

test("a stalled indexer keeps drafts awaiting_funding and exposes staged capability lag", async () => {
  const { service } = await createHarness({ now: "2026-07-20T02:00:00.000Z" });
  const draft = await service.createDraft(POSTER, { definition: definition() });
  const watcher = new ExternalPostingWatcherService(service, service.stateStore, undefined, {
    ...resolveExternalPostingWatcherConfig({
      INDEXER_STATUS_URL: "http://indexer:42069/status",
      EXTERNAL_POSTING_WATCHER_LAG_BUDGET_SECONDS: "600"
    }),
    now: () => new Date("2026-07-20T02:00:00.000Z"),
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          items: [],
          meta: {
            finalizedBlockNumber: "1200",
            finalizedBlockTimestamp: "2026-07-20T01:00:00.000Z",
            caughtUp: true
          }
        };
      }
    })
  });

  await watcher.pollOnce();
  const status = await watcher.getStatus();

  assert.equal(status.current, false);
  assert.equal(status.lagSeconds, 3600);
  assert.equal((await service.getDraft(POSTER, draft.draftId)).status, "awaiting_funding");
});

test("a fresh finalized head remains staged while watcher event pages are backlogged", async () => {
  const { service } = await createHarness({ now: "2026-07-20T02:00:00.000Z" });
  const watcher = new ExternalPostingWatcherService(service, service.stateStore, undefined, {
    ...resolveExternalPostingWatcherConfig({
      INDEXER_STATUS_URL: "http://indexer:42069/status",
      EXTERNAL_POSTING_WATCHER_LAG_BUDGET_SECONDS: "600"
    }),
    now: () => new Date("2026-07-20T02:00:00.000Z"),
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          items: [],
          meta: {
            finalizedBlockNumber: "1200",
            finalizedBlockTimestamp: "2026-07-20T01:59:30.000Z",
            caughtUp: false
          }
        };
      }
    })
  });

  await watcher.pollOnce();
  const status = await watcher.getStatus();

  assert.equal(status.lagSeconds, 30);
  assert.equal(status.caughtUp, false);
  assert.equal(status.current, false);
});

test("local external-posting e2e signs issued calldata, watches funding, and reaches settlement", async () => {
  // Keep the full lifecycle close to the test clock. A fixed 2026-07-20
  // fixture crossed the catalog's 14-day stale boundary on 2026-08-03 and
  // made this otherwise local e2e fail solely as wall-clock time advanced.
  const createdAtMs = Date.now() - (2 * 60 * 60 * 1000);
  const createdAt = new Date(createdAtMs).toISOString();
  const fundedAt = new Date(createdAtMs + (60 * 60 * 1000)).toISOString();
  const observedAt = new Date(createdAtMs + (90 * 60 * 1000)).toISOString();
  const finalizedAt = new Date(Date.parse(observedAt) - 30_000).toISOString();
  const stateStore = new MemoryStateStore();
  const eventBus = new EventBus({ eventStore: stateStore });
  const profiles = new Map([[WORKER, {
    wallet: WORKER,
    capabilities: ["claim_job", "submit_work"],
    supportedProtocols: ["http"],
    preferredCategories: ["coding"],
    preferredRiskLevel: "low",
    verifierCompatibility: ["benchmark"],
    minLiquidReserve: 0,
    autoUnwindStrategies: false
  }]]);
  const accounts = new Map([[WORKER, {
    wallet: WORKER,
    liquid: { USDC: 10 },
    reserved: {},
    strategyAllocated: {},
    collateralLocked: {},
    jobStakeLocked: {},
    debtOutstanding: {}
  }]]);
  const reputations = new Map([[WORKER, {
    skill: 50,
    reliability: 50,
    economic: 50,
    tier: "starter"
  }]]);
  const platformService = new PlatformService(
    [],
    profiles,
    accounts,
    reputations,
    undefined,
    stateStore,
    eventBus
  );
  const externalPosting = new ExternalPostingService({
    stateStore,
    platformService,
    config: postingConfig("open"),
    now: () => new Date(createdAt)
  });
  const verifier = new VerifierService(platformService, stateStore);

  const draft = await externalPosting.createDraft(POSTER, { definition: definition() });
  assert.equal(draft.calldata.to, ESCROW);
  const posterSigner = new Wallet(POSTER_PRIVATE_KEY);
  assert.equal(posterSigner.address.toLowerCase(), POSTER);
  const escrowInterface = new Interface([
    `function ${CREATE_SINGLE_PAYOUT_SIGNATURE}`
  ]);
  const transactionData = escrowInterface.encodeFunctionData(
    CREATE_SINGLE_PAYOUT_SIGNATURE,
    draft.calldata.args
  );
  const signedTransaction = await posterSigner.signTransaction({
    to: draft.calldata.to,
    data: transactionData,
    value: 0,
    nonce: 0,
    chainId: 31337,
    gasLimit: 1_000_000,
    gasPrice: 1
  });
  const decodedTransaction = Transaction.from(signedTransaction);
  assert.equal(decodedTransaction.from?.toLowerCase(), POSTER);
  assert.equal(decodedTransaction.to?.toLowerCase(), ESCROW);
  assert.equal(decodedTransaction.data, transactionData);
  assert.deepEqual(
    [...escrowInterface.decodeFunctionData(
      CREATE_SINGLE_PAYOUT_SIGNATURE,
      decodedTransaction.data
    )].map(String),
    draft.calldata.args
  );

  const watcher = new ExternalPostingWatcherService(
    externalPosting,
    stateStore,
    eventBus,
    {
      feedUrl: "http://indexer.local/escrow/job-creations",
      now: () => new Date(observedAt),
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            items: [matchingCreation(draft, { fundedAt })],
            nextCursor: "finalized-event-1234",
            meta: {
              finalizedBlockNumber: "1234",
              finalizedBlockTimestamp: finalizedAt,
              caughtUp: true
            }
          };
        }
      })
    }
  );
  await watcher.pollOnce();
  assert.equal((await watcher.getStatus()).current, true);
  assert.equal((await platformService.listJobsWithSessions()).some((job) => job.id === draft.jobId), true);

  const claimed = await platformService.claimJob(WORKER, draft.jobId, "http", "external-e2e-claim");
  const submitted = await platformService.submitWork(claimed.sessionId, "http", {
    summary: "Watcher integration implemented.",
    output: "complete verified output",
    status: "complete"
  });
  const settled = await verifier.verifySubmission({ sessionId: submitted.sessionId });

  assert.equal(settled.outcome, "approved");
  assert.equal((await platformService.resumeSession(claimed.sessionId)).status, "resolved");
});

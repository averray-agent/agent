import assert from "node:assert/strict";
import test from "node:test";

import {
  PRIORITY_WINDOW_ACTIVE_REASON,
  createDepositClaimPriorityPolicy
} from "./deposit-claim-priority.js";
import { PlatformService } from "./platform-service.js";
import { MemoryStateStore } from "./state-store.js";
import { writeDirectoryConsent } from "./directory-consent.js";
import { createJobRoutes } from "../protocols/http/job-routes.js";
import { readJsonBody, respond } from "../protocols/http/http-helpers.js";
import { createMcpToolExecutor } from "../protocols/mcp/tools.js";
import { invokeHttpRoute } from "../protocols/mcp/route-adapter.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LISTED_AT = "2026-08-22T12:00:00.000Z";

function job(overrides = {}) {
  return {
    id: "priority-integration-job",
    category: "coding",
    tier: "starter",
    jobType: "work",
    requiredRole: "worker",
    rewardAsset: "USDC",
    rewardAmount: 1,
    verifierMode: "benchmark",
    verifierConfig: {
      version: 1,
      handler: "benchmark",
      requiredKeywords: ["done"],
      minimumMatches: 1
    },
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: "schema://jobs/coding-output",
    claimTtlSeconds: 3_600,
    retryLimit: 1,
    requiresSponsoredGas: false,
    onboardingWaiverEligible: false,
    lifecycle: {
      status: "open",
      createdAt: LISTED_AT,
      updatedAt: LISTED_AT
    },
    ...overrides
  };
}

function harness({ vestedRaw = "0", outstandingCreditRaw = "0" } = {}) {
  const stateStore = new MemoryStateStore();
  let now = new Date("2026-08-22T12:02:00.000Z");
  const priorityPolicy = createDepositClaimPriorityPolicy({
    stateStore,
    config: {
      enabled: true,
      windowSeconds: 1800,
      thresholdRaw: 1_000_000n,
      thresholdUsdc: "1"
    },
    workerExposurePolicy: {
      capacityForWallet: async () => ({
        vestedAssetsRaw: vestedRaw,
        vestingAvailable: true,
        credit: { available: true, outstandingDebtRaw: outstandingCreditRaw }
      })
    },
    now: () => now
  });
  const profiles = new Map([[WALLET, {
    wallet: WALLET,
    preferredCategories: ["coding"],
    verifierCompatibility: ["benchmark"],
    preferredRiskLevel: "low",
    capabilities: ["claim_job", "submit_work"],
    supportedProtocols: ["http"],
    minLiquidReserve: 0,
    autoUnwindStrategies: false
  }]]);
  const accounts = new Map([[WALLET, {
    wallet: WALLET,
    liquid: { USDC: 10 },
    reserved: {},
    strategyAllocated: {},
    collateralLocked: {},
    jobStakeLocked: {},
    debtOutstanding: {}
  }]]);
  const reputations = new Map([[WALLET, {
    skill: 50,
    reliability: 50,
    economic: 50,
    tier: "starter"
  }]]);
  const service = new PlatformService(
    [job()],
    profiles,
    accounts,
    reputations,
    undefined,
    stateStore,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    priorityPolicy
  );
  return {
    service, stateStore,
    setNow(value) { now = new Date(value); }
  };
}

test("qualifying wallet claims curated work inside the priority window", async () => {
  const { service } = harness({ vestedRaw: "1000000" });
  const [listing] = await service.listJobsWithSessions({ wallet: WALLET });
  assert.equal(listing.listedAt, LISTED_AT);
  assert.deepEqual(listing.priorityWindow, {
    openAt: "2026-08-22T12:30:00.000Z",
    qualifiesWith: "listed in the agent directory, or ≥ 1 USDC vested deposit with no outstanding credit draw"
  });
  const [recommendation] = await service.recommendJobs(WALLET);
  assert.equal(recommendation.listedAt, LISTED_AT);
  assert.deepEqual(recommendation.priorityWindow, listing.priorityWindow);
  const preflight = await service.preflightJob(WALLET, job().id);
  assert.equal(preflight.eligible, true);
  assert.equal(preflight.priorityQualification.qualifies, true);

  const claimed = await service.claimJob(WALLET, job().id, "http", "priority-qualified");
  assert.equal(claimed.status, "claimed");
});

test("priority pin: preflight and claim gate share priority_window_active, then openAt admits the wallet", async () => {
  const { service, setNow } = harness({ vestedRaw: "999999" });
  const preflight = await service.preflightJob(WALLET, job().id);
  assert.equal(preflight.eligible, false);
  assert.equal(preflight.reason, PRIORITY_WINDOW_ACTIVE_REASON);
  assert.equal(preflight.openAt, "2026-08-22T12:30:00.000Z");

  await assert.rejects(
    () => service.claimJob(WALLET, job().id, "http", "priority-refused"),
    (error) => {
      assert.equal(error.code, preflight.reason);
      assert.equal(error.details.openAt, preflight.openAt);
      return true;
    }
  );

  setNow("2026-08-22T12:30:00.000Z");
  const after = await service.preflightJob(WALLET, job().id);
  assert.equal(after.eligible, true);
  const claimed = await service.claimJob(WALLET, job().id, "http", "priority-open");
  assert.equal(claimed.status, "claimed");
});

test("priority pin: listed zero-deposit and deposited unlisted wallets have preflight and claim parity", async () => {
  for (const listed of [true, false]) {
    const { service, stateStore } = harness({ vestedRaw: listed ? "0" : "1000000" });
    if (listed) await writeDirectoryConsent(stateStore, WALLET, { publicProfileOptIn: true, currentActivityOptIn: false });
    const preflight = await service.preflightJob(WALLET, job().id);
    assert.equal(preflight.eligible, true);
    assert.equal(preflight.priorityQualification.directoryQualified, listed);
    assert.equal(preflight.priorityQualification.depositQualified, !listed);
    assert.equal((await service.claimJob(WALLET, job().id, "http", "either-qualifier")).status, "claimed");
  }
});

test("directory consent is re-read between preflight and claim; unavailable consent grants nothing", async () => {
  const { service, stateStore } = harness();
  await writeDirectoryConsent(stateStore, WALLET, { publicProfileOptIn: true, currentActivityOptIn: false });
  assert.equal((await service.preflightJob(WALLET, job().id)).eligible, true);
  await writeDirectoryConsent(stateStore, WALLET, { publicProfileOptIn: false, currentActivityOptIn: false });
  await assert.rejects(service.claimJob(WALLET, job().id, "http", "revoked"), { code: PRIORITY_WINDOW_ACTIVE_REASON });
  stateStore.getServiceState = async () => { throw new Error("consent store down"); };
  assert.equal((await service.preflightJob(WALLET, job().id)).eligible, false);
});

test("real HTTP listings, detail, preflight and both MCP eligibility tools carry both qualifiers and openAt", async () => {
  const { service } = harness();
  const route = createJobRoutes({
    service, authMiddleware: async () => ({ wallet: WALLET }), enforceLimit: async () => {},
    ensureSessionOwnership: async () => {}, rateLimitConfig: {}, readJsonBody, respond
  });
  const request = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
  const expected = { openAt: "2026-08-22T12:30:00.000Z",
    qualifiesWith: "listed in the agent directory, or ≥ 1 USDC vested deposit with no outstanding credit draw" };
  for (const path of ["/jobs", "/jobs/" + job().id, "/jobs/definition?jobId=" + job().id, "/jobs/preflight?jobId=" + job().id]) {
    const response = await invokeHttpRoute(route, { method: "GET", path, sourceRequest: request });
    assert.equal(response.statusCode, 200, path);
    const body = Array.isArray(response.body) ? response.body[0] : response.body;
    assert.deepEqual(body.priorityWindow, expected, path);
    assert.doesNotMatch(JSON.stringify(body.priorityWindow), /reserved/iu);
  }
  const execute = createMcpToolExecutor({ handleJobRoute: route, handleAuthRoute: async () => false, handlePublicMetadataRoute: async () => false });
  for (const name of ["explainEligibility", "preflightJob"]) {
    const result = await execute(name, { jobId: job().id }, { request });
    assert.deepEqual(result.priorityWindow, expected, name);
    assert.equal(result.openAt, expected.openAt, name);
  }
});

test("credit-draw wallet is refused by the same preflight and claim derivation", async () => {
  const { service } = harness({ vestedRaw: "5000000", outstandingCreditRaw: "1" });
  const preflight = await service.preflightJob(WALLET, job().id);
  assert.equal(preflight.reason, PRIORITY_WINDOW_ACTIVE_REASON);
  assert.equal(preflight.priorityQualification.depositQualified, true);
  assert.equal(preflight.priorityQualification.noOutstandingCreditDraw, false);
  await assert.rejects(
    () => service.claimJob(WALLET, job().id, "http", "priority-credit-draw"),
    (error) => error.code === PRIORITY_WINDOW_ACTIVE_REASON
  );
});

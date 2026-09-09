import assert from "node:assert/strict";
import test from "node:test";

import { ValidationError } from "../../core/errors.js";
import { createHostedCanaryClaimantAttribution } from "../../core/claimant-attribution.js";
import { SelfIdentityRegistry } from "../../core/self-identity-registry.js";
import { createProfileRoutes } from "./profile-routes.js";
import { MemoryStateStore } from "../../core/state-store.js";
import { buildPlatformCapabilities } from "../../core/discovery-manifest.js";
import { readDirectoryConsent, writeDirectoryConsent, directoryParticipationCounts } from "../../core/directory-consent.js";
import { createPublicMetadataRoutes } from "./public-metadata-routes.js";
import { TransparencyService } from "../../services/transparency-service.js";

const WALLET = "0x1234567890123456789012345678901234567890";
const OTHER_WALLET = "0x2222222222222222222222222222222222222222";
const ACCEPTANCE_WALLET = "0x60385dD643f10934E8F384aC7A04c0D798dFc936";
const BLIND_TESTER_WALLET = "0x97450BF69Cb4aEB0b33db3aE51AC2D18224d4b5c";
const ROOT_LOGGER = { name: "root" };
const REQUEST_LOGGER = { name: "request" };

function sessionFixture(overrides = {}) {
  return {
    sessionId: "session-1",
    wallet: WALLET,
    jobId: "starter-coding-001",
    chainJobId: "0xa57b4a1f00000000000000000000000000000000000000000000000000000000",
    claimStake: 0.25,
    claimStakeBps: 500,
    status: "resolved",
    verification: { outcome: "approved", reasonCode: "OK" },
    protocolHistory: ["http"],
    updatedAt: "2026-04-16T14:30:00.000Z",
    ...overrides
  };
}

function jobFixture(overrides = {}) {
  return {
    id: "starter-coding-001",
    category: "coding",
    tier: "starter",
    rewardAsset: "DOT",
    rewardAmount: 5,
    verifierMode: "benchmark",
    ...overrides
  };
}

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const sessions = overrides.sessions ?? [sessionFixture()];
  const history = overrides.history ?? sessions;
  const job = overrides.job ?? jobFixture();
  const route = createProfileRoutes({
    authMiddleware: async (_request, _url) => {
      calls.push(["auth"]);
      return overrides.auth ?? { wallet: WALLET, roles: ["agent"] };
    },
    env: {
      PUBLIC_BASE_URL: "https://api.averray.test",
      ...overrides.env
    },
    logger: ROOT_LOGGER,
    parseLimit: (url, fallback, max) => {
      const raw = Number(url.searchParams.get("limit") ?? fallback);
      const limit = !Number.isFinite(raw) || raw <= 0 ? fallback : Math.min(Math.trunc(raw), max);
      calls.push(["parseLimit", { fallback, max, limit }]);
      return limit;
    },
    respond: (res, statusCode, body, headers = {}) => {
      calls.push(["respond", { statusCode, body, headers }]);
      res.statusCode = statusCode;
      res.body = body;
      res.headers = headers;
    },
    readJsonBody: async (request) => request.body,
    service: {
      listRecentSessionRecords: async (limit) => {
        calls.push(["listRecentSessionRecords", limit]);
        return sessions;
      },
      getReputation: async (wallet) => {
        calls.push(["getReputation", wallet]);
        return overrides.reputation ?? { skill: 220, reliability: 30, economic: 10, tier: "pro" };
      },
      collectSessionHistory: async (wallet, options = {}) => {
        calls.push(["collectSessionHistory", { wallet, logger: options.logger }]);
        return history;
      },
      getJobDefinition: (jobId) => {
        calls.push(["getJobDefinition", jobId]);
        if (overrides.jobError) {
          throw overrides.jobError;
        }
        return job;
      },
      listChildJobsByParentSession: (sessionId) => {
        calls.push(["listChildJobsByParentSession", sessionId]);
        return overrides.childJobs ?? [];
      },
    },
    stateStore: overrides.stateStore ?? {
      // Existing rendering tests now exercise explicitly opted-in profiles.
      getServiceState: async () => ({ publicProfileOptIn: true, currentActivityOptIn: true }),
      getMutationReceipt: async (bucket, id) => {
        calls.push(["getMutationReceipt", { bucket, id }]);
        return undefined;
      }
    },
    lockedTierService: overrides.lockedTierService,
    selfIdentityRegistry: overrides.selfIdentityRegistry ?? new SelfIdentityRegistry(),
  });
  return { calls, response, route };
}

async function profileRequest(harness, path = "/agents", method = "GET", body) {
  const response = {};
  await harness.route({ request: { method, body }, response, url: new URL(path, "http://localhost"), pathname: path });
  return response;
}

test("unconsented wallets are unidentifiable in the directory while transparency external totals stay unchanged", async () => {
  const store = new MemoryStateStore();
  const sessions = [sessionFixture({ status: "claimed", claimedAt: "2026-09-07T06:00:00Z" }),
    sessionFixture({ wallet: OTHER_WALLET, sessionId: "other-session", status: "claimed" })];
  for (const session of sessions) await store.upsertSession(session);
  const registry = new SelfIdentityRegistry();
  const harness = makeHarness({ sessions, stateStore: store, lockedTierService: {
    getPublicCommitment: async () => ({ committedDepositor: true, tier: "t90" })
  } });
  const now = Date.now();
  const transparency = new TransparencyService({ stateStore: store, selfIdentityRegistry: registry, now: () => now });
  const before = transparency.buildFlow(await transparency.readFlow(), Date.now());
  assert.equal(before.directoryParticipants.total.value, 2);
  assert.equal(before.directoryParticipants.external.value, 2);
  assert.equal(before.directoryParticipants.listedByConsent.value, 0);
  const response = await profileRequest(harness);
  assert.deepEqual(response.body, []);
  for (const forbidden of [WALLET, OTHER_WALLET, "agent-1234-7890", "currentActivity"]) {
    assert.equal(JSON.stringify(response.body).includes(forbidden), false);
  }
  await assert.rejects(profileRequest(harness, `/agents/${WALLET}`), { code: "agent_not_found" });
  await writeDirectoryConsent(store, WALLET, { publicProfileOptIn: true, currentActivityOptIn: false });
  const after = transparency.buildFlow(await transparency.readFlow(), Date.now());
  assert.equal(after.directoryParticipants.total.value, 2);
  assert.equal(after.directoryParticipants.external.value, 2);
  assert.equal(after.directoryParticipants.listedByConsent.value, 1);
  assert.equal(after.directoryParticipants.externalListedByConsent.value, 1);
  assert.deepEqual(after.workers24h, before.workers24h);
  assert.match(after.directoryParticipants.label, /listed-by-consent is a subset/);
});

test("directory privacy disclosure at capabilities and onboarding matches the actual private default", async () => {
  const store = new MemoryStateStore();
  const actual = await readDirectoryConsent(store, WALLET);
  const capabilities = buildPlatformCapabilities();
  const disclosure = capabilities.onboarding.directoryPrivacy;
  assert.equal(actual.publicProfileOptIn, false, "directory code default must remain explicit opt-in");
  assert.equal(actual.currentActivityOptIn, false);
  assert.equal(disclosure.default, "private");
  assert.equal(disclosure.statement, "Claiming a job does not publish your wallet or profile in the public agent directory. Listing requires explicit publicProfileOptIn; live currentActivity requires a separate opt-in. Aggregate participation counts include private wallets.");
  const response = {};
  const route = createPublicMetadataRoutes({
    service: { getPlatformCapabilities: () => capabilities },
    posterOnboardingService: { getWorkerDoorOnboarding: async () => ({}), getExternalBountiesOnboarding: async () => ({}) },
    respond: (_response, status, body) => Object.assign(response, { status, body })
  });
  await route({ request: { method: "GET" }, response, pathname: "/onboarding", url: new URL("http://localhost/onboarding") });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.onboarding.directoryPrivacy, disclosure);
});

test("directory activity requires separate consent and revocation immediately removes the listing", async () => {
  const store = new MemoryStateStore();
  const sessions = [sessionFixture(), sessionFixture({ sessionId: "live-session", jobId: "private-live-work",
    status: "claimed", claimedAt: "2026-09-07T07:00:00Z" })];
  const harness = makeHarness({ sessions, stateStore: store });
  await profileRequest(harness, "/agents/consent", "POST", { publicProfileOptIn: true, currentActivityOptIn: false });
  const listed = await profileRequest(harness);
  assert.equal(listed.body.length, 1);
  assert.equal(Object.hasOwn(listed.body[0], "currentActivity"), false);
  const detail = await profileRequest(harness, `/agents/${WALLET}`);
  assert.equal(Object.hasOwn(detail.body, "currentActivity"), false);
  assert.equal(JSON.stringify(detail.body).includes("private-live-work"), false);
  await profileRequest(harness, "/agents/consent", "POST", { publicProfileOptIn: true, currentActivityOptIn: true });
  assert.equal((await profileRequest(harness)).body[0].currentActivity.jobId, "private-live-work");
  await profileRequest(harness, "/agents/consent", "POST", { publicProfileOptIn: false, currentActivityOptIn: false });
  assert.deepEqual((await profileRequest(harness)).body, []);
  await assert.rejects(profileRequest(harness, `/agents/${WALLET}`), { code: "agent_not_found" });
  assert.equal(listed.headers["cache-control"], "no-store");
  assert.ok(harness.calls.some(([name]) => name === "auth"));
});

test("directory consent binds only to the authenticated wallet and never accepts rider fields", async () => {
  const store = new MemoryStateStore();
  const harness = makeHarness({ stateStore: store });
  await assert.rejects(profileRequest(harness, "/agents/consent", "POST", {
    wallet: OTHER_WALLET, publicProfileOptIn: true, currentActivityOptIn: false
  }), ValidationError);
  await assert.rejects(profileRequest(harness, "/agents/consent", "POST", {
    publicProfileOptIn: "true", currentActivityOptIn: false
  }), ValidationError);
  await profileRequest(harness, "/agents/consent", "POST", { publicProfileOptIn: true, currentActivityOptIn: false });
  assert.equal((await readDirectoryConsent(store, WALLET)).publicProfileOptIn, true);
  assert.equal((await readDirectoryConsent(store, OTHER_WALLET)).publicProfileOptIn, false);
  const restarted = makeHarness({ stateStore: store });
  assert.equal((await profileRequest(restarted, "/agents/consent")).body.publicProfileOptIn, true);
});

test("unreadable directory consent makes only listed counts unknown and publishes no profiles", async () => {
  const stateStore = { async getServiceState() { throw new Error("store unavailable"); } };
  const sessions = [sessionFixture()];
  const counts = await directoryParticipationCounts(sessions, stateStore, new SelfIdentityRegistry());
  assert.equal(counts.total, 1);
  assert.equal(counts.external, 1);
  assert.equal(counts.listedByConsent, null);
  await assert.rejects(profileRequest(makeHarness({ stateStore, sessions })), /store unavailable/);
});

test("profile routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/not-profile"),
    pathname: "/not-profile",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("profile routes leave badge paths to the badge route module", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/badges/session-1"),
    pathname: "/badges/session-1",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET /reputation authenticates and returns wallet reputation", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/reputation"),
    pathname: "/reputation",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    skill: 220,
    reliability: 30,
    economic: 10,
    tier: "expert",
    jobEligibilityTier: "pro"
  });
  assert.deepEqual(calls.slice(0, 2), [
    ["auth"],
    ["getReputation", WALLET]
  ]);
});

test("GET /agents returns an opted-in directory without caching revoked consent", async () => {
  const { response, route } = makeHarness({
    sessions: [sessionFixture({ wallet: WALLET }), sessionFixture({ wallet: WALLET, sessionId: "session-2" })],
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/agents?limit=5"),
    pathname: "/agents",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.headers, { "cache-control": "no-store" });
  assert.equal(response.body.length, 1);
  assert.equal(response.body[0].wallet, WALLET);
  assert.equal(response.body[0].handle, "agent-1234-7890");
  assert.equal(response.body[0].tier, "expert");
  assert.equal(response.body[0].synthetic, false);
  assert.equal(response.body[0].identity.classification, "external");
  assert.equal(response.body[0].identity.authority, "shared_self_identity_registry");
});

test("GET /agents excludes canary-only wallets unless explicitly included", async () => {
  const canary = sessionFixture({
    jobId: "worker-canary-1785151678417",
    claimantAttribution: createHostedCanaryClaimantAttribution(),
  });
  const { response, route } = makeHarness({
    sessions: [canary],
    history: [canary],
  });

  await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/agents"),
    pathname: "/agents",
  });
  assert.deepEqual(response.body, []);

  const operatorResponse = {};
  await route({
    request: { method: "GET" },
    response: operatorResponse,
    url: new URL("http://localhost/agents?includeSynthetic=true"),
    pathname: "/agents",
  });
  assert.equal(operatorResponse.body.length, 1);
  assert.equal(operatorResponse.body[0].wallet, WALLET);
  assert.equal(operatorResponse.body[0].synthetic, true);
});

test("GET /agents keeps a wallet public after any non-canary session", async () => {
  const canary = sessionFixture({
    jobId: "worker-canary-1785151678417",
  });
  const external = sessionFixture({
    sessionId: "external-session",
    jobId: "external-job-1",
  });
  const { response, route } = makeHarness({
    sessions: [canary, external],
    history: [canary, external],
  });

  await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/agents"),
    pathname: "/agents",
  });

  assert.equal(response.body.length, 1);
  assert.equal(response.body[0].synthetic, false);
});

test("GET /agents/:wallet validates wallet path", async () => {
  const { route } = makeHarness();

  await assert.rejects(
    route({
      request: { method: "GET" },
      response: {},
      url: new URL("http://localhost/agents/not-a-wallet"),
      pathname: "/agents/not-a-wallet",
    }),
    (error) => error instanceof ValidationError && /wallet path segment/.test(error.message)
  );
});

test("GET /agents/:wallet builds a public profile with request logger context", async () => {
  const { calls, response, route } = makeHarness({
    history: [sessionFixture({ wallet: OTHER_WALLET, sessionId: "session-2" })],
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL(`http://localhost/agents/${OTHER_WALLET}`),
    pathname: `/agents/${OTHER_WALLET}`,
    requestLogger: REQUEST_LOGGER,
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.wallet, OTHER_WALLET);
  assert.equal(response.body.synthetic, false);
  assert.equal(response.body.identity.classification, "external");
  assert.deepEqual(response.headers, { "cache-control": "no-store" });
  assert(calls.some((call) => (
    call[0] === "collectSessionHistory" &&
    call[1].wallet === OTHER_WALLET &&
    call[1].logger === REQUEST_LOGGER
  )));
});

test("GET /agents/:wallet classifies operator acceptance and blind-tester wallets through the shared registry", async () => {
  const selfIdentityRegistry = new SelfIdentityRegistry({ acceptanceWallets: [ACCEPTANCE_WALLET] });
  const acceptance = makeHarness({
    history: [sessionFixture({ wallet: ACCEPTANCE_WALLET })],
    selfIdentityRegistry,
  });
  await acceptance.route({
    request: { method: "GET" },
    response: acceptance.response,
    url: new URL(`http://localhost/agents/${ACCEPTANCE_WALLET}`),
    pathname: `/agents/${ACCEPTANCE_WALLET}`,
  });
  assert.equal(acceptance.response.body.identity.classification, "operator-run");
  assert.equal(acceptance.response.body.identity.kind, "acceptance");

  const external = makeHarness({
    history: [sessionFixture({ wallet: BLIND_TESTER_WALLET })],
    selfIdentityRegistry,
  });
  await external.route({
    request: { method: "GET" },
    response: external.response,
    url: new URL(`http://localhost/agents/${BLIND_TESTER_WALLET}`),
    pathname: `/agents/${BLIND_TESTER_WALLET}`,
  });
  assert.equal(external.response.body.identity.classification, "external");
});

test("GET /agents and GET /agents/:wallet return the same operator tier", async () => {
  const reputation = {
    skill: 100,
    reliability: 100_000,
    economic: 100,
    tier: "pro",
  };
  const { response: listResponse, route } = makeHarness({ reputation });

  await route({
    request: { method: "GET" },
    response: listResponse,
    url: new URL("http://localhost/agents"),
    pathname: "/agents",
  });

  const detailResponse = {};
  await route({
    request: { method: "GET" },
    response: detailResponse,
    url: new URL(`http://localhost/agents/${WALLET}`),
    pathname: `/agents/${WALLET}`,
    requestLogger: REQUEST_LOGGER,
  });

  assert.equal(listResponse.body[0].reputationScore, 100_200);
  assert.equal(listResponse.body[0].tier, "journeyman");
  assert.equal(detailResponse.body.tier, listResponse.body[0].tier);
  assert.equal(detailResponse.body.reputation.tier, "pro");
});

test("public profiles expose the committed-depositor marker only from an explicit opt-in", async () => {
  const commitment = { committedDepositor: true, tier: "t90" };
  const optedIn = makeHarness({
    lockedTierService: { getPublicCommitment: async () => commitment }
  });
  await optedIn.route({
    request: { method: "GET" },
    response: optedIn.response,
    url: new URL(`http://localhost/agents/${WALLET}`),
    pathname: `/agents/${WALLET}`,
  });
  assert.deepEqual(optedIn.response.body.lockedDeposit, commitment);

  const privateProfile = makeHarness({
    lockedTierService: { getPublicCommitment: async () => undefined }
  });
  await privateProfile.route({
    request: { method: "GET" },
    response: privateProfile.response,
    url: new URL(`http://localhost/agents/${WALLET}`),
    pathname: `/agents/${WALLET}`,
  });
  assert.equal(Object.hasOwn(privateProfile.response.body, "lockedDeposit"), false);
});

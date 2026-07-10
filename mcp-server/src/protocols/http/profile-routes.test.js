import assert from "node:assert/strict";
import test from "node:test";

import { ValidationError } from "../../core/errors.js";
import { createProfileRoutes } from "./profile-routes.js";

const WALLET = "0x1234567890123456789012345678901234567890";
const OTHER_WALLET = "0x2222222222222222222222222222222222222222";
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
    service: {
      listRecentSessions: async (limit) => {
        calls.push(["listRecentSessions", limit]);
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
    stateStore: {
      getMutationReceipt: async (bucket, id) => {
        calls.push(["getMutationReceipt", { bucket, id }]);
        return undefined;
      }
    },
  });
  return { calls, response, route };
}

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
  assert.deepEqual(response.body, { skill: 220, reliability: 30, economic: 10, tier: "pro" });
  assert.deepEqual(calls.slice(0, 2), [
    ["auth"],
    ["getReputation", WALLET]
  ]);
});

test("GET /agents returns a cached public directory", async () => {
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
  assert.deepEqual(response.headers, { "cache-control": "public, max-age=30" });
  assert.equal(response.body.length, 1);
  assert.equal(response.body[0].wallet, WALLET);
  assert.equal(response.body[0].handle, "agent-1234-7890");
  assert.equal(response.body[0].tier, "expert");
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
  assert.deepEqual(response.headers, { "cache-control": "public, max-age=30" });
  assert(calls.some((call) => (
    call[0] === "collectSessionHistory" &&
    call[1].wallet === OTHER_WALLET &&
    call[1].logger === REQUEST_LOGGER
  )));
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

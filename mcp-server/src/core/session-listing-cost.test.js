import assert from "node:assert/strict";
import test from "node:test";
import { PlatformService } from "./platform-service.js";
import { MemoryStateStore, RedisStateStore } from "./state-store.js";
import { WorkerProgressionService } from "./worker-progression.js";
import { createProfileRoutes } from "../protocols/http/profile-routes.js";
import { createSessionRoutes } from "../protocols/http/session-routes.js";
import { createListBadgeReceipts } from "../protocols/http/badge-routes.js";
import { createOperatorActivityFeed } from "../protocols/http/operator-activity-feed.js";
import { createDisputeRoutes } from "../protocols/http/dispute-routes.js";

const WALLETS = [1, 2, 3].map((n) => `0x${String(n).repeat(40)}`);
const makeSessions = (wallets = WALLETS) => Array.from({ length: 250 }, (_, index) => ({
  sessionId: `session-${index}`, jobId: `job-${index}`, wallet: wallets[index % wallets.length],
  status: "resolved", verificationSummary: { outcome: "approved" },
  resolvedAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
  badgeSnapshot: { rewardAmount: 0.2, rewardAsset: "USDC", tier: "starter", category: "coding" }
}));

function platform(store) {
  const service = new PlatformService([], new Map(), new Map(), new Map(), undefined, store);
  service.setWorkerProgressionService(new WorkerProgressionService({
    stateStore: store,
    getReputation: async () => ({ tier: "starter", skill: 0 }),
    workerExposurePolicy: { capacityForWallet: async () => ({}) },
    workerDailyExposurePolicy: { progressionConfig: () => ({
      graduationSettledJobs: 10, rolling24hRaw: "1500000", rolling24hUsdc: 1.5
    }) }
  }));
  return service;
}

async function directoryFixture() {
  const sessions = makeSessions([WALLETS[0]]);
  const store = new RedisStateStore("redis://unused", "directory-cost");
  store.connect = async () => {};
  const reads = [];
  store.client = {
    async zRange(key, start, stop) {
      reads.push(["range", key]);
      return sessions.slice(start, stop + 1).map((s) => s.sessionId);
    },
    async get(key) {
      reads.push(["get", key]);
      const session = sessions.find((s) => key === `directory-cost:session:${s.sessionId}`);
      return session ? JSON.stringify(session) : null;
    }
  };
  let progressionReads = 0;
  store.listSessionsByWallet = async () => { progressionReads += 1; return []; };
  const route = createProfileRoutes({ service: platform(store), stateStore: store,
    parseLimit: (_url, fallback) => fallback,
    respond: (response, status, body, headers) => Object.assign(response, { status, body, headers })
  });
  const response = {};
  await route({ request: { method: "GET" }, response, pathname: "/agents", url: new URL("https://api.test/agents") });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, []);
  assert.equal(response.headers["cache-control"], "no-store");
  return { reads, progressionReads };
}

test("agents directory performs zero progression reads for 250 resolved sessions of one wallet", async () => {
  assert.equal((await directoryFixture()).progressionReads, 0);
});

test("agents directory store cost is one range plus 250 session reads plus one consent read", async () => {
  const { reads } = await directoryFixture();
  assert.equal(reads.filter(([kind]) => kind === "range").length, 1);
  assert.equal(reads.filter(([, key]) => key.includes(":session:")).length, 250);
  assert.equal(reads.filter(([, key]) => key.includes(":service-state:directory-consent:")).length, 1);
  assert.equal(reads.length, 252, "no verification or per-session enrichment reads");
});

function decoratedFixture() {
  const store = new MemoryStateStore();
  const sessions = makeSessions();
  const pages = [];
  store.listRecentSessions = async () => sessions;
  store.listSessionsByWallet = async (wallet, limit, offset = 0) => {
    pages.push({ wallet, offset });
    return sessions.filter((s) => s.wallet === wallet).slice(offset, offset + limit);
  };
  return { service: platform(store), store, sessions, pages };
}

test("sessions route retains progression and each settlement's own justChanged result", async () => {
  const { service, sessions } = decoratedFixture();
  const route = createSessionRoutes({ service,
    authMiddleware: async () => ({ wallet: WALLETS[0] }),
    respond: (response, status, body) => Object.assign(response, { status, body })
  });
  const response = {};
  await route({ request: { method: "GET" }, response, pathname: "/sessions", url: new URL("https://api.test/sessions?limit=250") });
  assert.equal(response.status, 200);
  assert.ok(response.body.every((s) => s.progression?.tier === "starter"));
  const own = sessions.filter((s) => s.wallet === WALLETS[0]);
  assert.equal(response.body.find((s) => s.sessionId === own[1].sessionId).progression.justChanged, null);
  assert.deepEqual(response.body.find((s) => s.sessionId === own[2].sessionId).progression.justChanged,
    { field: "creditInterest.eligible", from: false, to: true });
});

test("decorated listing collects wallet history three times for 250 sessions of three wallets", async () => {
  const { service, pages } = decoratedFixture();
  const result = await service.listRecentSessions(250);
  assert.equal(result.length, 250);
  assert.ok(result.every((s) => s.progression));
  assert.equal(pages.filter(({ offset }) => offset === 0).length, 3, "one collection per wallet");
  assert.equal(pages.length, 6, "each wallet history has two 64-row pages");
  await service.listRecentSessions(250);
  assert.equal(pages.filter(({ offset }) => offset === 0).length, 6, "the next request must re-read");
});

test("badges and activity feeds skip progression but retain verification enrichment", async () => {
  const { service, store } = decoratedFixture();
  const options = [];
  const original = service.listRecentSessions.bind(service);
  service.listRecentSessions = async (limit, opts) => {
    options.push(opts);
    const rows = await original(limit, opts);
    assert.ok(rows.every((s) => !s.progression));
    assert.ok(rows.every((s) => Object.hasOwn(s, "verification")));
    return rows;
  };
  // Follow the real alerts dependency too: its dispute listing also scans sessions.
  const { listDisputes } = createDisputeRoutes({ service, stateStore: store });
  const feed = createOperatorActivityFeed({ service, stateStore: store, listPolicies: () => [], listDisputes });
  await feed.listAuditEvents();
  await feed.listAlerts();
  const badges = createListBadgeReceipts({ service, stateStore: store,
    verifierService: { getResult: async () => undefined }, buildBadgeFromSession: () => { throw new Error("no badge fixture"); }
  });
  await badges(250);
  assert.deepEqual(options, Array.from({ length: 4 }, () => ({ progression: false })));
});

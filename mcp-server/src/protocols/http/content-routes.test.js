import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AuthenticationError, AuthorizationError } from "../../core/errors.js";
import { buildContentRecord } from "../../core/content-addressed-store.js";
import { MemoryStateStore, RedisStateStore } from "../../core/state-store.js";
import { MetricRegistry } from "../../core/metrics.js";
import { createRateLimiter } from "../../auth/rate-limit.js";
import { createContentRoutes } from "./content-routes.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const CONTRACT = "0x3333333333333333333333333333333333333333";
const HASH = `0x${"aa".repeat(32)}`;

function redisStore() {
  const store = new RedisStateStore("redis://unused", "content-test");
  const values = new Map();
  const expirations = new Map();
  const operations = [];
  store.connect = async () => {};
  function evict(key) {
    if (expirations.has(key) && expirations.get(key) <= Date.now()) {
      values.delete(key);
      expirations.delete(key);
    }
  }
  store.client = {
    async get(key) { evict(key); return values.get(key) ?? null; },
    async set(key, value, options) {
      evict(key);
      operations.push(["set", options]);
      if (options?.NX && values.has(key)) return null;
      values.set(key, value);
      return "OK";
    },
    async eval(script, { keys: [key], arguments: args }) {
      evict(key);
      if (script.includes('redis.call("incrby"')) {
        assert.match(script, /redis\.call\("expire", KEYS\[1\], ARGV\[2\], "NX"\)/u);
        const used = Number(values.get(key) ?? 0) + Number(args[0]);
        values.set(key, String(used));
        if (!expirations.has(key)) expirations.set(key, Date.now() + Number(args[1]) * 1000);
        return [used, Math.ceil((expirations.get(key) - Date.now()) / 1000)];
      }
      assert.match(script, /redis\.call\("incr", KEYS\[1\]\)/u);
      const count = Number(values.get(key) ?? 0) + 1;
      values.set(key, String(count));
      if (count === 1) expirations.set(key, Date.now() + Number(args[0]));
      return [count, expirations.get(key) - Date.now()];
    }
  };
  return { store, operations };
}

async function makeHarness({
  auth = { wallet: OWNER, claims: { roles: [] } },
  authError,
  payload,
  records = [],
  store = new MemoryStateStore(),
  contentWrites = { limit: 30, windowSeconds: 3600 },
} = {}) {
  const calls = [];
  const response = {};
  const metrics = new MetricRegistry();
  for (const record of records) await store.upsertContent(record);
  const gateway = {
    isEnabled: () => true,
    discloseContent: async (...args) => calls.push(["discloseContent", args]),
    autoDiscloseContent: async (...args) => calls.push(["autoDiscloseContent", args]),
  };
  const route = createContentRoutes({
    appendContentRecord: async (record) => calls.push(["appendContentRecord", record.hash]),
    authMiddleware: async (_request, _url, options = {}) => {
      calls.push(["authMiddleware", options]);
      if (authError) throw authError;
      return auth;
    },
    enforceLimit: createRateLimiter({ stateStore: store, logger: { warn() {} } }),
    escrowAddress: CONTRACT,
    gateway,
    hasRole: (claims, role) => Array.isArray(claims?.roles) && claims.roles.includes(role),
    metrics,
    persistContentRecord: async (record) => {
      calls.push(["persistContentRecord", record.hash]);
      return store.upsertContent(record);
    },
    publicBaseUrl: "https://api.example.test",
    rateLimitConfig: { contentWrites },
    readJsonBody: async (request) => request.payload ?? payload,
    respond: (res, statusCode, body, headers = {}) => Object.assign(res, { statusCode, body, headers }),
    stateStore: store,
    walletsMatch: (left, right) => String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase(),
  });
  async function call({ method = "GET", path = "/content", body } = {}) {
    return route({ request: { method, payload: body }, response, url: new URL(`http://localhost${path}`), pathname: path });
  }
  return { auth, calls, response, metrics, store, call };
}

test("content routes ignore unrelated paths and methods", async () => {
  const { call, calls, response } = await makeHarness();
  assert.equal(await call(), false);
  assert.equal(await call({ method: "POST", path: `/content/${HASH}` }), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("content route source has no gateway reference", async () => {
  const source = await readFile(new URL("./content-routes.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /gateway/u);
});

test("POST /content creates a record and returns a content URI", async () => {
  const { call, calls, store, response, metrics } = await makeHarness({ payload: { payload: { answer: 42 }, verdict: "pass" } });
  assert.equal(await call({ method: "POST" }), true);
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.ownerWallet, OWNER);
  assert.equal(response.body.visibility, "public");
  assert.equal(response.body.contentURI, `https://api.example.test/content/${response.body.hash}`);
  assert.equal((await store.getContent(response.body.hash)).payload.answer, 42);
  assert.equal(calls.filter(([name]) => name === "appendContentRecord").length, 1);
  assert.equal(calls.some(([name]) => name === "persistContentRecord"), false);
  assert.match(metrics.serialize(), /content_writes_total\{outcome="created"\} 1/u);
});

test("POST /content rejects non-admin writes for another owner", async () => {
  const { call } = await makeHarness({ payload: { ownerWallet: OTHER, payload: { private: true } } });
  await assert.rejects(call({ method: "POST" }), (error) => error instanceof AuthorizationError && error.code === "content_owner_forbidden");
});

test("POST /content/:hash/publish returns not_found for missing content", async () => {
  const { call, response } = await makeHarness();
  assert.equal(await call({ method: "POST", path: `/content/${HASH}/publish` }), true);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { status: "not_found", hash: HASH });
});

test("owner publication changes access and returns self-disclosure instructions", async () => {
  const record = buildContentRecord({ ownerWallet: OWNER, payload: { status: "draft" }, autoPublicAt: "2099-01-01T00:00:00.000Z" });
  const { call, store, calls, response } = await makeHarness({ records: [record] });
  await call({ method: "POST", path: `/content/${record.hash}/publish` });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.visibility, "public");
  assert.deepEqual(response.body.disclosureEvent, { emitted: false, reason: "self_disclosure", contract: CONTRACT, method: "disclose(bytes32)" });
  assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.ok((await store.getContent(record.hash)).publishedAt);
  const stored = JSON.stringify(await store.getContent(record.hash));
  await call({ method: "POST", path: `/content/${record.hash}/publish` });
  assert.equal(JSON.stringify(await store.getContent(record.hash)), stored);
  assert.equal(calls.some(([name]) => name === "discloseContent" || name === "autoDiscloseContent"), false);
});

test("auto-public reads never send a transaction", async () => {
  const record = buildContentRecord({ ownerWallet: OWNER, payload: { old: true }, autoPublicAt: "2000-01-01T00:00:00.000Z" });
  const { call, calls, response } = await makeHarness({ authError: new AuthenticationError("No token."), records: [record] });
  await call({ path: `/content/${record.hash}` });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.visibility, "public");
  assert.deepEqual(response.body.autoDisclosureEvent, { emitted: false, reason: "reads_never_write" });
  assert.equal(calls.some(([name]) => name === "discloseContent" || name === "autoDiscloseContent" || name === "persistContentRecord"), false);
});

test("GET /content/:hash rejects private content without auth", async () => {
  const record = buildContentRecord({ ownerWallet: OWNER, payload: { private: true }, autoPublicAt: "2099-01-01T00:00:00.000Z" });
  const { call } = await makeHarness({ authError: new AuthenticationError("No token."), records: [record] });
  await assert.rejects(call({ path: `/content/${record.hash}` }), (error) => error instanceof AuthorizationError && error.code === "content_private");
});

for (const mode of ["memory", "Redis"]) {
  function makeStore() { return mode === "memory" ? new MemoryStateStore() : redisStore().store; }

  test(`${mode}: content creation preserves an existing owner's published record`, async () => {
    const record = buildContentRecord({ ownerWallet: OWNER, payload: { answer: 42 }, publishedAt: "2026-01-01T00:00:00.000Z" });
    for (const roles of [[], ["admin"]]) {
      const { call, response, store, metrics } = await makeHarness({ store: makeStore(), records: [record], auth: { wallet: OTHER, claims: { roles } }, payload: { payload: record.payload } });
      await assert.rejects(call({ method: "POST" }), (error) => error.code === "content_exists" && error.statusCode === 409 && error.details === undefined);
      assert.deepEqual(await store.getContent(record.hash), record);
      assert.equal(response.body, undefined);
      assert.match(metrics.serialize(), /content_writes_total\{outcome="exists"\} 1/u);
    }
  });

  test(`${mode}: same-owner creation returns the existing record unchanged`, async () => {
    const record = buildContentRecord({ ownerWallet: OWNER, payload: { answer: 42 }, publishedAt: "2026-01-01T00:00:00.000Z" });
    const { call, response, store, calls } = await makeHarness({ store: makeStore(), records: [record], payload: { payload: record.payload, contentType: "different", autoPublicAt: "2099-01-01T00:00:00.000Z" } });
    const before = JSON.stringify(await store.getContent(record.hash));
    await call({ method: "POST" });
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.stringify(await store.getContent(record.hash)), before);
    assert.equal(response.body.publishedAt, record.publishedAt);
    assert.equal(response.body.contentType, record.contentType);
    assert.equal(calls.some(([name]) => name === "appendContentRecord" || name === "persistContentRecord"), false);
  });

  test(`${mode}: the thirty-first content write is rate-limited`, async () => {
    const { call, response, metrics } = await makeHarness({ store: makeStore() });
    for (let index = 0; index < 30; index += 1) {
      await call({ method: "POST", body: { payload: { index } } });
      assert.equal(response.statusCode, 201);
    }
    await assert.rejects(call({ method: "POST", body: { payload: { index: 30 } } }), (error) => error.code === "rate_limited" && error.statusCode === 429);
    assert.match(metrics.serialize(), /content_writes_total\{outcome="rate_limited"\} 1/u);
  });

  test(`${mode}: content writes stop at the daily byte quota`, async () => {
    const { call, response, store, metrics } = await makeHarness({ store: makeStore() });
    let rejectedPayload;
    for (let index = 0; index < 20; index += 1) {
      const body = { payload: { index, text: "a".repeat(60 * 1024) } };
      try {
        await call({ method: "POST", body });
        assert.equal(response.statusCode, 201);
      } catch (error) {
        assert.equal(error.code, "content_quota_exceeded");
        assert.equal(error.statusCode, 429);
        assert.equal(error.details.limitBytes, 1024 * 1024);
        assert.ok(error.details.retryAfterSeconds > 0);
        rejectedPayload = body.payload;
        break;
      }
    }
    assert.ok(rejectedPayload);
    assert.equal(await store.getContent(buildContentRecord({ ownerWallet: OWNER, payload: rejectedPayload }).hash), undefined);
    assert.match(metrics.serialize(), /content_writes_total\{outcome="quota_exceeded"\} 1/u);
  });

  test(`${mode}: admin content writes retain the request rate limit`, async () => {
    const { call, response } = await makeHarness({ store: makeStore(), auth: { wallet: OWNER, claims: { roles: ["admin"] } } });
    for (let index = 0; index < 30; index += 1) {
      await call({ method: "POST", body: { ownerWallet: OTHER, payload: { index, text: "a".repeat(60 * 1024) } } });
      assert.equal(response.statusCode, 201);
    }
    await assert.rejects(call({ method: "POST", body: { payload: { index: 30 } } }), { code: "rate_limited" });
  });

  test(`${mode}: atomic content creation keeps the first record and internal persistence can update it`, async () => {
    const store = makeStore();
    const record = buildContentRecord({ ownerWallet: OWNER, payload: { answer: 42 } });
    const otherRecord = { ...record, ownerWallet: OTHER };
    const results = await Promise.all([store.createContentIfAbsent(record), store.createContentIfAbsent(otherRecord)]);
    assert.deepEqual(results.map(({ created }) => created), [true, false]);
    assert.deepEqual(results[1].record, JSON.parse(JSON.stringify(record)));
    const published = { ...record, publishedAt: "2026-01-01T00:00:00.000Z" };
    await store.upsertContent(published);
    await store.upsertContent(published);
    assert.deepEqual(await store.getContent(record.hash), mode === "memory" ? published : JSON.parse(JSON.stringify(published)));
  });

  test(`${mode}: concurrent request creation keeps the first owner`, async () => {
    const store = makeStore();
    const originalGet = store.getContent.bind(store);
    let readers = 0;
    let release;
    const bothReading = new Promise((resolve) => { release = resolve; });
    store.getContent = async (hash) => {
      if (readers < 2) {
        readers += 1;
        if (readers === 2) release();
        await bothReading;
        return undefined;
      }
      return originalGet(hash);
    };
    const payload = { payload: { answer: 42 } };
    const first = await makeHarness({ store, payload });
    const second = await makeHarness({ store, payload, auth: { wallet: OTHER, claims: { roles: [] } } });
    const results = await Promise.allSettled([first.call({ method: "POST" }), second.call({ method: "POST" })]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.equal(results[1].reason.code, "content_exists");
    assert.equal((await originalGet(first.response.body.hash)).ownerWallet, OWNER);
  });

  test(`${mode}: wallet byte quotas isolate wallets and retain their original window`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    const store = makeStore();
    assert.deepEqual(await store.consumeWalletQuota("content_bytes", OWNER, 10, 86400), { usedBytes: 10, resetAt: Date.now() + 86400000 });
    assert.equal((await store.consumeWalletQuota("content_bytes", OTHER, 20, 86400)).usedBytes, 20);
    t.mock.timers.tick(1000);
    assert.deepEqual(await store.consumeWalletQuota("content_bytes", OWNER.toUpperCase(), 30, 86400), { usedBytes: 40, resetAt: Date.now() + 86399000 });
    t.mock.timers.tick(86400000);
    assert.equal((await store.consumeWalletQuota("content_bytes", OWNER, 5, 86400)).usedBytes, 5);
    await assert.rejects(store.consumeWalletQuota("content_bytes", OWNER, -1, 86400), { code: "invalid_request" });
  });
}

test("Redis content creation uses conditional SET", async () => {
  const { store, operations } = redisStore();
  const record = buildContentRecord({ ownerWallet: OWNER, payload: { answer: 42 } });
  await store.createContentIfAbsent(record);
  await store.createContentIfAbsent({ ...record, ownerWallet: OTHER });
  assert.deepEqual(operations, [["set", { NX: true }], ["set", { NX: true }]]);
});

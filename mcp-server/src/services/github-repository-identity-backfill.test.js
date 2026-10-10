import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { MemoryStateStore, RedisStateStore } from "../core/state-store.js";
import { buildJobSnapshot, requireJobSnapshot } from "../core/job-snapshot.js";
import { backfillGithubRepositoryIds, repositoryPinKey, withPinnedRepositoryIdentity } from "./github-repository-identity-backfill.js";

const job = () => ({ id: "legacy-pr", source: { type: "github_issue", repo: "owner/repo", issueNumber: 1 },
  lifecycle: { state: "open", status: "open", createdAt: "2026-10-01T00:00:00Z" }, verifierConfig: { handler: "github_pr" } });
const repository = { id: 42, full_name: "owner/repo", created_at: "2026-08-01T00:00:00Z" };
function harness({ store = new MemoryStateStore(), definition = job(), response = repository, status = 200 } = {}) {
  const calls = [];
  return { store, definition, calls, service: { stateStore: store, getJobDefinition: () => structuredClone(definition) },
    options: { githubToken: "synthetic-token", fetchImpl: async (url, options) => {
      calls.push({ url, options }); return Response.json(response, { status });
    } } };
}

test("repository backfill defaults to dry-run without any write", async (t) => {
  const h = harness();
  const deadlines = [];
  t.mock.method(AbortSignal, "timeout", (ms) => { deadlines.push(ms); return new AbortController().signal; });
  h.store.putGithubRepositoryPin = () => assert.fail("dry-run wrote a pin");
  const result = await backfillGithubRepositoryIds(h.service, { jobIds: ["legacy-pr"] }, h.options);
  assert.deepEqual(result, { dryRun: true, pinned: 0, wouldPin: 1, skipped: 0,
    rows: [{ jobId: "legacy-pr", status: "would_pin", githubRepoId: 42 }] });
  assert.equal(h.calls[0].url, "https://api.github.com/repos/owner/repo");
  assert.equal(h.calls[0].options.redirect, "error");
  assert.ok(h.calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(deadlines, [5_000]);
});

for (const [name, createStore] of [
  ["Memory", () => new MemoryStateStore()],
  ["Redis NX contract", () => {
    const store = new RedisStateStore("redis://unused", "backfill-test");
    const values = new Map();
    store.connect = async () => {};
    store.findSessionByJobId = async () => undefined;
    store.client = {
      get: async (key) => values.get(key) ?? null,
      set: async (key, value, options) => {
        assert.deepEqual(options, { NX: true });
        if (values.has(key)) return null;
        values.set(key, value); return "OK";
      }
    };
    return store;
  }]
]) {
  test(`${name}: concurrent backfill is idempotent and leaves definitions and spec hashes unchanged`, async () => {
    const h = harness({ store: createStore() });
    const before = JSON.stringify(h.definition);
    const session = { jobId: h.definition.id, jobSnapshot: buildJobSnapshot(h.definition) };
    const snapshotBefore = JSON.stringify(session);
    const results = await Promise.all([1, 2].map(() => backfillGithubRepositoryIds(h.service,
      { jobIds: [h.definition.id], apply: true }, h.options)));
    assert.equal(results.reduce((n, r) => n + r.pinned, 0), 1);
    assert.equal((await backfillGithubRepositoryIds(h.service, { jobIds: [h.definition.id], apply: true }, h.options)).rows[0].reason, "already_pinned");
    const pinned = await withPinnedRepositoryIdentity(requireJobSnapshot(session).job, h.store);
    assert.equal(pinned.source.githubRepoId, 42);
    assert.equal(JSON.stringify(h.definition), before);
    assert.equal(JSON.stringify(session), snapshotBefore);
    assert.equal(buildJobSnapshot(h.definition).specHash, session.jobSnapshot.specHash);
    assert.equal(h.service.getJobDefinition(h.definition.id).source.githubRepoId, undefined);
    const differentIncarnation = job(); differentIncarnation.lifecycle.createdAt = "2026-10-02T00:00:00Z";
    assert.equal((await withPinnedRepositoryIdentity(differentIncarnation, h.store)).source.githubRepoId, undefined);
  });
}

test("real Redis repository pin NX preserves the first identity", { skip: !process.env.VERIFY_RESERVATION_TEST_REDIS_URL, timeout: 10_000 }, async () => {
  const store = new RedisStateStore(process.env.VERIFY_RESERVATION_TEST_REDIS_URL, `repository-pin-test:${randomUUID()}`);
  const record = { key: repositoryPinKey(job()), source: { githubRepoId: 42 } };
  try {
    // Production connects at boot before accepting concurrent requests.
    await store.connect();
    assert.deepEqual(await Promise.all([store.putGithubRepositoryPin(record), store.putGithubRepositoryPin({ ...record, source: { githubRepoId: 99 } })]), [true, false]);
    assert.equal((await store.getGithubRepositoryPin(record.key)).source.githubRepoId, 42);
  } finally {
    if (store.client.isReady) {
      await store.client.del(store.key("github-repository-pin", record.key));
      await store.client.quit();
    } else if (store.client.isOpen) store.client.destroy();
  }
});

for (const [name, response, reason] of [
  ["renamed", { ...repository, full_name: "owner/renamed" }, "repository_name_mismatch"],
  ["transferred", { ...repository, full_name: "other/repo" }, "repository_name_mismatch"],
  ["newer", { ...repository, created_at: "2026-10-02T00:00:00Z" }, "repository_not_older_than_job"],
  ["equal", { ...repository, created_at: job().lifecycle.createdAt }, "repository_not_older_than_job"],
  ["undated", { ...repository, created_at: undefined }, "repository_creation_time_unavailable"],
  ["invalid date", { ...repository, created_at: "invalid" }, "repository_creation_time_unavailable"],
  ["no id", { ...repository, id: undefined }, "repository_id_unavailable"]
]) test(`backfill skips ${name} repository for operator review`, async () => {
  const h = harness({ response });
  const result = await backfillGithubRepositoryIds(h.service, { jobIds: ["legacy-pr"], apply: true }, h.options);
  assert.equal(result.pinned, 0); assert.equal(result.skipped, 1); assert.equal(result.rows[0].reason, reason);
  assert.equal(await h.store.getGithubRepositoryPin(repositoryPinKey(h.definition)), undefined);
});

for (const state of ["closed", "paused", "archived", "stale", "cancelled"]) test(`backfill skips ${state} jobs before GitHub`, async () => {
  const definition = job(); definition.lifecycle.state = state;
  const h = harness({ definition });
  const result = await backfillGithubRepositoryIds(h.service, { jobIds: [definition.id], apply: true }, h.options);
  assert.equal(result.rows[0].reason, "job_not_open"); assert.equal(h.calls.length, 0);
});

test("backfill skips resolved sessions and non-GitHub or already pinned jobs", async () => {
  for (const variant of ["resolved", "external", "ingested"]) {
    const h = harness();
    if (variant === "resolved") await h.store.upsertSession({ sessionId: "s", jobId: h.definition.id, wallet: "0xaa", status: "resolved" });
    if (variant === "external") h.definition.source.type = "external";
    if (variant === "ingested") h.definition.source.githubRepoId = 9;
    const result = await backfillGithubRepositoryIds(h.service, { jobIds: [h.definition.id], apply: true }, h.options);
    assert.equal(result.pinned, 0); assert.equal(result.skipped, 1); assert.equal(h.calls.length, 0);
  }
});

test("backfill bounds batches, requires explicit boolean apply, and refuses changed jobs", async () => {
  const h = harness();
  for (const payload of [{ jobIds: [] }, { jobIds: Array(11).fill("a") }, { jobIds: ["a"], apply: "true" }]) {
    await assert.rejects(backfillGithubRepositoryIds(h.service, payload, h.options), { code: "invalid_request" });
  }
  const fetchImpl = h.options.fetchImpl;
  h.options.fetchImpl = async (...args) => { h.definition.source.repo = "owner/changed"; return fetchImpl(...args); };
  assert.equal((await backfillGithubRepositoryIds(h.service, { jobIds: [h.definition.id], apply: true }, h.options)).rows[0].reason, "job_changed");
});

test("backfill records lookup failures without writing or exposing response bodies", async () => {
  for (const status of [403, 429, 500]) {
    const h = harness({ status });
    const result = await backfillGithubRepositoryIds(h.service, { jobIds: ["legacy-pr"], apply: true }, h.options);
    assert.equal(result.rows[0].reason, `github_api_${status}`); assert.equal(result.pinned, 0);
  }
  const h = harness();
  h.options.fetchImpl = async () => { throw new Error("secret-body"); };
  const result = await backfillGithubRepositoryIds(h.service, { jobIds: ["legacy-pr"], apply: true }, h.options);
  assert.equal(result.rows[0].reason, "github_read_unavailable"); assert.equal(JSON.stringify(result).includes("secret-body"), false);
});

test("pin overlay preserves ingested IDs, refuses corrupt pins, and never swallows store errors", async () => {
  const h = harness();
  const ingested = job(); ingested.source.githubRepoId = 99;
  assert.equal(await withPinnedRepositoryIdentity(ingested, { getGithubRepositoryPin: () => assert.fail("ingested ID should win") }), ingested);
  await h.store.putGithubRepositoryPin({ key: repositoryPinKey(h.definition), source: { githubRepoId: -1 } });
  await assert.rejects(withPinnedRepositoryIdentity(h.definition, h.store), { code: "github_repository_pin_invalid" });
  await assert.rejects(withPinnedRepositoryIdentity(job(), { getGithubRepositoryPin: async () => { throw new Error("store unavailable"); } }), /store unavailable/);
});

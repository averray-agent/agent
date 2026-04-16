import test from "node:test";
import assert from "node:assert/strict";

import { createStateStore, MemoryStateStore } from "./state-store.js";
import { ExternalServiceError } from "./errors.js";

function silentLogger() {
  return { warn() {}, error() {}, info() {}, log() {} };
}

test("createStateStore returns MemoryStateStore in dev without REDIS_URL", () => {
  const store = createStateStore({ NODE_ENV: "development", AUTH_MODE: "permissive" }, { logger: silentLogger() });
  assert.ok(store instanceof MemoryStateStore);
});

test("createStateStore throws in production when REDIS_URL is missing", () => {
  assert.throws(
    () => createStateStore({ NODE_ENV: "production" }, { logger: silentLogger() }),
    ExternalServiceError
  );
});

test("createStateStore throws when AUTH_MODE=strict without REDIS_URL", () => {
  assert.throws(
    () => createStateStore({ AUTH_MODE: "strict" }, { logger: silentLogger() }),
    ExternalServiceError
  );
});

test("createStateStore allows memory fallback with explicit opt-in", () => {
  const store = createStateStore(
    { NODE_ENV: "production", STATE_STORE_ALLOW_MEMORY: "1" },
    { logger: silentLogger() }
  );
  assert.ok(store instanceof MemoryStateStore);
});

test("MemoryStateStore rate limit window isolates across keys", async () => {
  const store = new MemoryStateStore();
  const a = await store.consumeRateLimit("bucket", "key-a", { limit: 1, windowSeconds: 60 });
  const b = await store.consumeRateLimit("bucket", "key-b", { limit: 1, windowSeconds: 60 });
  assert.equal(a.allowed, true);
  assert.equal(b.allowed, true);
  assert.equal(a.remaining, 0);
});

test("MemoryStateStore rate limit returns allowed=false past the limit", async () => {
  const store = new MemoryStateStore();
  await store.consumeRateLimit("bucket", "key", { limit: 2, windowSeconds: 60 });
  await store.consumeRateLimit("bucket", "key", { limit: 2, windowSeconds: 60 });
  const third = await store.consumeRateLimit("bucket", "key", { limit: 2, windowSeconds: 60 });
  assert.equal(third.allowed, false);
  assert.equal(third.count, 3);
  assert.equal(third.remaining, 0);
});

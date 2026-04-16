import test from "node:test";
import assert from "node:assert/strict";

import { createRateLimiter, extractClientKey } from "./rate-limit.js";
import { MemoryStateStore } from "../core/state-store.js";
import { RateLimitError } from "../core/errors.js";

function silentLogger() {
  return { warn() {}, error() {}, info() {}, log() {} };
}

test("rate limiter allows requests under the limit", async () => {
  const store = new MemoryStateStore();
  const enforce = createRateLimiter({ stateStore: store, logger: silentLogger() });
  const first = await enforce("auth_nonce", "1.2.3.4", { limit: 3, windowSeconds: 60 });
  const second = await enforce("auth_nonce", "1.2.3.4", { limit: 3, windowSeconds: 60 });
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(second.remaining, 1);
});

test("rate limiter throws RateLimitError on the Nth+1 request", async () => {
  const store = new MemoryStateStore();
  const enforce = createRateLimiter({ stateStore: store, logger: silentLogger() });
  for (let i = 0; i < 3; i += 1) {
    await enforce("auth_nonce", "1.2.3.4", { limit: 3, windowSeconds: 60 });
  }
  await assert.rejects(
    () => enforce("auth_nonce", "1.2.3.4", { limit: 3, windowSeconds: 60 }),
    (error) => {
      if (!(error instanceof RateLimitError)) {
        return false;
      }
      assert.equal(error.statusCode, 429);
      assert.equal(error.details.bucket, "auth_nonce");
      assert.equal(error.details.remaining, 0);
      assert.ok(typeof error.details.retryAfterSeconds === "number" && error.details.retryAfterSeconds > 0);
      return true;
    }
  );
});

test("rate limiter isolates buckets and client keys", async () => {
  const store = new MemoryStateStore();
  const enforce = createRateLimiter({ stateStore: store, logger: silentLogger() });
  await enforce("auth_nonce", "1.2.3.4", { limit: 1, windowSeconds: 60 });
  // Different bucket — should still be allowed.
  const other = await enforce("auth_verify", "1.2.3.4", { limit: 1, windowSeconds: 60 });
  // Different client — should still be allowed.
  const otherClient = await enforce("auth_nonce", "5.6.7.8", { limit: 1, windowSeconds: 60 });
  assert.equal(other.allowed, true);
  assert.equal(otherClient.allowed, true);
});

test("rate limiter resets after the window expires", async () => {
  const store = new MemoryStateStore();
  const enforce = createRateLimiter({ stateStore: store, logger: silentLogger() });
  await enforce("auth_nonce", "1.2.3.4", { limit: 1, windowSeconds: 0.01 });
  await assert.rejects(
    () => enforce("auth_nonce", "1.2.3.4", { limit: 1, windowSeconds: 0.01 }),
    RateLimitError
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  const afterReset = await enforce("auth_nonce", "1.2.3.4", { limit: 1, windowSeconds: 0.01 });
  assert.equal(afterReset.allowed, true);
  assert.equal(afterReset.count, 1);
});

test("rate limiter with throwOnLimit=false returns soft result", async () => {
  const store = new MemoryStateStore();
  const enforce = createRateLimiter({ stateStore: store, logger: silentLogger() });
  await enforce("auth_nonce", "1.2.3.4", { limit: 1, windowSeconds: 60 });
  const soft = await enforce(
    "auth_nonce",
    "1.2.3.4",
    { limit: 1, windowSeconds: 60, throwOnLimit: false }
  );
  assert.equal(soft.allowed, false);
  assert.equal(soft.remaining, 0);
});

test("createRateLimiter rejects state stores without consumeRateLimit", () => {
  assert.throws(() => createRateLimiter({ stateStore: {} }), /consumeRateLimit/);
});

test("extractClientKey prefers X-Forwarded-For when trustProxy=true", () => {
  const request = {
    headers: { "x-forwarded-for": "9.9.9.9, 10.10.10.10" },
    socket: { remoteAddress: "127.0.0.1" }
  };
  assert.equal(extractClientKey(request, { trustProxy: true }), "9.9.9.9");
  assert.equal(extractClientKey(request, { trustProxy: false }), "127.0.0.1");
});

test("extractClientKey falls back to remoteAddress when header missing", () => {
  const request = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(extractClientKey(request, { trustProxy: true }), "127.0.0.1");
});

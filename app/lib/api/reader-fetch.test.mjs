import test from "node:test";
import assert from "node:assert/strict";

import {
  APP_READER_ATTEMPTS,
  APP_READER_TIMEOUT_MS,
  fetchAppPublicReadWithRetry,
  fetchAppReadWithRetry
} from "./reader-fetch.js";

test("app first-paint reads cap each attempt at 3s and keep exactly one retry", () => {
  assert.equal(APP_READER_TIMEOUT_MS, 3_000);
  assert.equal(APP_READER_ATTEMPTS, 2);
});

test("app first-paint read retries once after a timed-out attempt", async () => {
  let calls = 0;
  const response = { ok: true };
  const fetchImpl = (_url, init) => {
    calls += 1;
    if (calls === 2) return Promise.resolve(response);
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
    });
  };

  const result = await fetchAppReadWithRetry("https://api.example/jobs", {}, {
    fetchImpl,
    timeoutMs: 5
  });
  assert.equal(result, response);
  assert.equal(calls, 2);
});

test("caller abort is terminal and never spends the retry", async () => {
  let calls = 0;
  const external = new AbortController();
  const pending = fetchAppReadWithRetry("https://api.example/badges", { signal: external.signal }, {
    fetchImpl: (_url, init) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("caller abort")), { once: true });
      });
    },
    timeoutMs: 100
  });
  external.abort();
  await assert.rejects(pending, /caller abort/u);
  assert.equal(calls, 1);
});

test("expired SIWE public work falls back on the logged-out one-request path", async () => {
  let calls = 0;
  const response = { ok: true };

  const result = await fetchAppPublicReadWithRetry("https://api.example/jobs", {
    headers: {
      authorization: "Bearer rejected-session",
      accept: "application/json"
    }
  }, {
    fetchImpl: async (_url, init) => {
      calls += 1;
      const headers = new Headers(init.headers);
      assert.equal(headers.has("authorization"), false);
      assert.equal(headers.get("accept"), "application/json");
      return response;
    }
  });

  assert.equal(result, response);
  assert.equal(calls, 1, "expired-session fallback must match the logged-out request count");
});

test("expired SIWE public work never starts an auth retry storm", async () => {
  let calls = 0;
  await assert.rejects(
    fetchAppPublicReadWithRetry("https://api.example/jobs", {
      headers: { authorization: "Bearer rejected-session" }
    }, {
      attempts: APP_READER_ATTEMPTS,
      fetchImpl: async (_url, init) => {
        calls += 1;
        assert.equal(new Headers(init.headers).has("authorization"), false);
        throw new Error("offline");
      }
    }),
    /offline/u
  );
  assert.equal(calls, APP_READER_ATTEMPTS);
});

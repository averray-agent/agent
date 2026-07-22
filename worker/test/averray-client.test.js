import assert from "node:assert/strict";
import test from "node:test";

import { fetchJobDefinition } from "../src/averray-client.js";

test("fetchJobDefinition performs one public read-only request", async () => {
  const calls = [];
  const expected = { id: "job-123" };
  const result = await fetchJobDefinition("job-123", {
    baseUrl: "https://api.example.test/v1/",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => expected };
    },
  });

  assert.equal(result, expected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, "https://api.example.test/v1/jobs/definition?jobId=job-123");
  assert.equal(calls[0].init.method, "GET");
  assert.deepEqual(calls[0].init.headers, { accept: "application/json" });
  assert.equal("authorization" in calls[0].init.headers, false);
});

test("fetchJobDefinition rejects HTTP failures", async () => {
  await assert.rejects(
    fetchJobDefinition("job-404", {
      baseUrl: "https://api.example.test",
      fetchImpl: async () => ({ ok: false, status: 404 }),
    }),
    /HTTP 404/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { runJobSpecHashSweepCli } from "./sweep-job-spec-hashes.js";

function sink() {
  return {
    value: "",
    write(chunk) {
      this.value += String(chunk);
    }
  };
}

test("one-off sweep prints the acceptance counts and exits cleanly below half", async () => {
  const stdout = sink();
  const stderr = sink();
  const calls = [];
  const result = await runJobSpecHashSweepCli({
    argv: ["--base-url", "https://agent.example"],
    env: { AGENT_ADMIN_TOKEN: "admin-token" },
    stdout,
    stderr,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ total: 9, matching: 7, drifted: 2, guardTriggered: false })
      };
    }
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(stdout.value), {
    total: 9,
    matching: 7,
    drifted: 2,
    guardTriggered: false
  });
  assert.equal(stderr.value, "");
  assert.equal(calls[0].url, "https://agent.example/admin/jobs/spec-hash-sweep");
  assert.equal(calls[0].options.headers.authorization, "Bearer admin-token");
});

test("one-off sweep exits 2 and says no rows changed when strict majority drifts", async () => {
  const stdout = sink();
  const stderr = sink();
  const result = await runJobSpecHashSweepCli({
    env: { AGENT_ADMIN_TOKEN: "admin-token" },
    stdout,
    stderr,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        total: 9,
        matching: 4,
        drifted: 5,
        guardTriggered: true,
        markedUnclaimable: 0
      })
    })
  });

  assert.equal(result.exitCode, 2);
  assert.match(stderr.value, /5 of 9/u);
  assert.match(stderr.value, /no jobs were changed/u);
});

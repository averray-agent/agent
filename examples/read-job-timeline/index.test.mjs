import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTimelineSummary,
  parseArgs,
  runTimelineLookup
} from "./index.mjs";

test("parseArgs accepts job and session timeline flags", () => {
  assert.deepEqual(parseArgs([
    "--api",
    "https://api.example",
    "--token",
    "token",
    "--job-id",
    "job-1",
    "--limit",
    "25"
  ]), {
    apiUrl: "https://api.example",
    token: "token",
    jobId: "job-1",
    limit: 25
  });
});

test("runTimelineLookup reads admin job timeline when jobId is provided", async () => {
  const calls = [];
  const summary = await runTimelineLookup({
    apiUrl: "https://api.example",
    token: "token",
    jobId: "job-1",
    limit: 20,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), auth: options.headers.get("authorization") });
      return jsonResponse({
        timelineVersion: "v2",
        job: { id: "job-1" },
        summary: { eventCount: 2 },
        lineage: { sessionIds: ["session-1"] },
        timeline: [{ type: "job_state" }, { type: "session_transition" }]
      });
    }
  });

  assert.deepEqual(calls, [{
    url: "https://api.example/admin/jobs/timeline?jobId=job-1&limit=20",
    auth: "Bearer token"
  }]);
  assert.equal(summary.kind, "job");
  assert.deepEqual(summary.eventTypes, ["job_state", "session_transition"]);
});

test("runTimelineLookup reads session timeline when sessionId is provided", async () => {
  const calls = [];
  const summary = await runTimelineLookup({
    apiUrl: "https://api.example",
    token: "token",
    sessionId: "session-1",
    fetchImpl: async (url) => {
      calls.push(String(url));
      return jsonResponse({
        timelineVersion: "v2",
        session: { sessionId: "session-1", jobId: "job-1" },
        timeline: [{ type: "session_transition" }]
      });
    }
  });

  assert.deepEqual(calls, ["https://api.example/session/timeline?sessionId=session-1"]);
  assert.equal(summary.kind, "session");
  assert.equal(summary.jobId, "job-1");
});

test("buildTimelineSummary keeps latest event visible", () => {
  const summary = buildTimelineSummary({
    apiUrl: "https://api.example",
    jobId: "job-1",
    timeline: {
      timelineVersion: "v2",
      job: { id: "job-1" },
      timeline: [{ type: "job_state" }, { type: "verification", data: { outcome: "approved" } }]
    }
  });

  assert.equal(summary.eventCount, 2);
  assert.equal(summary.latestEvent.type, "verification");
});

function jsonResponse(payload, { status = 200 } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

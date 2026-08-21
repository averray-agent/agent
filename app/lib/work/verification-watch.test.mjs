import test from "node:test";
import assert from "node:assert/strict";

import { watchSessionToTerminal } from "./verification-watch.js";

test("verification watch reaches a terminal session and exposes its receipt id", async () => {
  let clock = 0;
  const statuses = [
    { sessionId: "session-1", status: "submitted" },
    { sessionId: "session-1", status: "resolved", workReceiptId: `0x${"a".repeat(64)}` }
  ];
  const result = await watchSessionToTerminal({
    sessionId: "session-1",
    fetcher: async () => statuses.shift(),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    pollMs: 10,
    timeoutMs: 100
  });
  assert.equal(result.status, "terminal");
  assert.equal(result.session.status, "resolved");
  assert.match(result.session.workReceiptId, /^0x[a-f0-9]{64}$/u);
});

test("verification watch times out with honest stall copy and can be retried", async () => {
  let clock = 0;
  let calls = 0;
  const result = await watchSessionToTerminal({
    sessionId: "session-1",
    fetcher: async () => {
      calls += 1;
      return { status: "submitted" };
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    pollMs: 10,
    timeoutMs: 30
  });
  assert.equal(result.status, "stalled");
  assert.equal(calls, 3);
  assert.match(result.message, /Nothing has been marked complete/u);
  assert.match(result.message, /Retry/u);
});

test("CI walkthrough: mock wallet claim, schema-valid submit, status, and receipt stay on canonical paths", async () => {
  let clock = 0;
  const calls = [];
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["summary"],
    properties: { summary: { type: "string", minLength: 1 } }
  };
  const receiptId = `0x${"b".repeat(64)}`;
  const { validateSubmissionAgainstSchema } = await import("./schema-editor.js");
  const { filterHumanWorkListings, publicReceiptUrl } = await import("./human-work.js");
  const { runClaimJob } = await import("../api/claim-job.js");
  const { runGuardedSubmit } = await import("../api/guarded-submit.js");
  const fetcher = async (key) => {
    const [path] = Array.isArray(key) ? key : [key];
    calls.push(path);
    if (path === "/jobs?state=claimable&limit=100") {
      return { jobs: [{ id: "starter-real", verifierMode: "deterministic" }] };
    }
    if (path === "/jobs/definition?jobId=starter-real") {
      return { id: "starter-real", outputSchemaRef: "schema://jobs/example" };
    }
    if (path === "/jobs/claim") return { sessionId: "session-1", status: "claimed" };
    if (path === "/jobs/validate-submission") return { valid: true };
    if (path === "/jobs/submit") return { sessionId: "session-1", status: "submitted" };
    return { sessionId: "session-1", status: "resolved", workReceiptId: receiptId };
  };

  const listing = await fetcher("/jobs?state=claimable&limit=100");
  assert.deepEqual(filterHumanWorkListings(listing).map((job) => job.id), ["starter-real"]);
  await fetcher("/jobs/definition?jobId=starter-real");
  const mockWallet = async () => ({ wallet: `0x${"1".repeat(40)}`, roles: [] });
  const auth = await mockWallet();
  assert.deepEqual(auth.roles, []);
  const claim = await runClaimJob({ jobId: "starter-real", fetcher });
  const submission = { summary: "Complete" };
  assert.equal(validateSubmissionAgainstSchema(schema, submission).valid, true);
  const submitted = await runGuardedSubmit({
    jobId: "starter-real",
    sessionId: claim.session.sessionId,
    submission,
    structuredSubmissionRequired: true,
    fetcher
  });
  assert.equal(submitted.status, "submitted");
  const watched = await watchSessionToTerminal({
    sessionId: "session-1",
    fetcher,
    now: () => clock,
    sleep: async (ms) => { clock += ms; }
  });
  assert.equal(watched.status, "terminal");
  assert.equal(publicReceiptUrl(watched.session.workReceiptId), `https://averray.com/receipts/${receiptId}`);
  assert.deepEqual(calls, [
    "/jobs?state=claimable&limit=100",
    "/jobs/definition?jobId=starter-real",
    "/jobs/claim",
    "/jobs/validate-submission",
    "/jobs/submit",
    "/session?sessionId=session-1"
  ]);
});

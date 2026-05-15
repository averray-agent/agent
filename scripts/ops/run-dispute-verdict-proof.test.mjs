import assert from "node:assert/strict";
import test from "node:test";

import { runDisputeVerdictProof } from "./run-dispute-verdict-proof.mjs";

const DISPUTE_ID = "dispute-abc123def4";
const SESSION_ID = "session-product-proof";
const REASONING_HASH = "0x" + "a".repeat(64);

function openDispute(overrides = {}) {
  return {
    id: DISPUTE_ID,
    status: "open",
    sessionId: SESSION_ID,
    chainJobId: "job-1",
    claimant: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    openedAt: "2026-05-10T00:00:00.000Z",
    windowEndsAt: "2026-05-24T00:00:00.000Z",
    slaSeconds: 14 * 24 * 60 * 60,
    stakedAmount: 0.5,
    verdict: null,
    timeline: [],
    ...overrides
  };
}

function verdictResponse(overrides = {}) {
  return {
    id: DISPUTE_ID,
    status: "resolved",
    verdict: "dismissed",
    reasonCode: "DISPUTE_OVERTURNED",
    reasoningHash: REASONING_HASH,
    metadataURI: `urn:averray:content:${REASONING_HASH}`,
    workerPayout: 0.5,
    remainingPayout: 0.5,
    txHash: undefined,
    blockNumber: undefined,
    chainStatus: "local_only",
    timeline: [
      {
        id: `${DISPUTE_ID}:verdict`,
        at: "2026-05-15T12:00:00.000Z",
        actor: "0x9999999999999999999999999999999999999999",
        action: "verdict_submitted",
        data: { reasoningHash: REASONING_HASH, chainStatus: "local_only" }
      }
    ],
    ...overrides
  };
}

function persistedDispute(overrides = {}) {
  return {
    ...openDispute(),
    status: "resolved",
    verdict: "dismissed",
    reasonCode: "DISPUTE_OVERTURNED",
    reasoningHash: REASONING_HASH,
    metadataURI: `urn:averray:content:${REASONING_HASH}`,
    chainStatus: "local_only",
    ...overrides
  };
}

function baseEnv(overrides = {}) {
  return {
    ADMIN_JWT: "test-token",
    DISPUTE_PROOF_ID: DISPUTE_ID,
    DISPUTE_PROOF_VERDICT: "dismissed",
    DISPUTE_PROOF_RATIONALE: "Upstream PR merged after the verifier's initial rejection.",
    API_BASE_URL: "https://api.example.test",
    ...overrides
  };
}

function recordingClient({ disputeBeforeVerdict, disputeAfterVerdict, response }) {
  const calls = [];
  return {
    calls,
    async getDispute(id) {
      calls.push(["getDispute", id]);
      // First call returns the pre-verdict dispute; second call (after
      // submission) returns the persisted record.
      return calls.filter(([name]) => name === "getDispute").length === 1
        ? disputeBeforeVerdict
        : disputeAfterVerdict;
    },
    async submitDisputeVerdict(id, payload) {
      calls.push(["submitDisputeVerdict", id, payload]);
      return response;
    }
  };
}

test("dry-run default never submits and prints the exact payload it would send", async () => {
  const client = recordingClient({
    disputeBeforeVerdict: openDispute(),
    disputeAfterVerdict: persistedDispute(),
    response: verdictResponse()
  });

  const result = await runDisputeVerdictProof({ env: baseEnv(), client, log: () => {} });

  assert.equal(result.mode, "dry_run");
  assert.deepEqual(client.calls.map(([name]) => name), ["getDispute"]);
  assert.deepEqual(result.payload, {
    verdict: "dismissed",
    rationale: "Upstream PR merged after the verifier's initial rejection.",
    idempotencyKey: `dispute-proof-${DISPUTE_ID}`
  });
  assert.equal(result.dispute.status, "open");
  assert.equal(result.disputeId, DISPUTE_ID);
});

test("dry-run for a split verdict includes the worker payout in the proposed payload", async () => {
  const client = recordingClient({
    disputeBeforeVerdict: openDispute(),
    disputeAfterVerdict: persistedDispute(),
    response: verdictResponse()
  });

  const result = await runDisputeVerdictProof({
    env: baseEnv({
      DISPUTE_PROOF_VERDICT: "split",
      DISPUTE_PROOF_WORKER_PAYOUT: "0.25"
    }),
    client,
    log: () => {}
  });

  assert.equal(result.mode, "dry_run");
  assert.equal(result.payload.workerPayout, 0.25);
});

test("live mode submits and verifies the response carries verdict + reasoning + chain status evidence", async () => {
  const client = recordingClient({
    disputeBeforeVerdict: openDispute(),
    disputeAfterVerdict: persistedDispute(),
    response: verdictResponse()
  });

  const result = await runDisputeVerdictProof({
    env: baseEnv({ DISPUTE_PROOF_LIVE: "1" }),
    client,
    log: () => {}
  });

  assert.equal(result.mode, "live");
  assert.deepEqual(client.calls.map(([name]) => name), [
    "getDispute",
    "submitDisputeVerdict",
    "getDispute"
  ]);
  const submitCall = client.calls.find(([name]) => name === "submitDisputeVerdict");
  assert.equal(submitCall[1], DISPUTE_ID);
  assert.equal(submitCall[2].verdict, "dismissed");
  assert.equal(submitCall[2].idempotencyKey, `dispute-proof-${DISPUTE_ID}`);
  assert.equal(result.response.reasoningHash, REASONING_HASH);
  assert.equal(result.response.chainStatus, "local_only");
  assert.equal(result.persisted.status, "resolved");
});

test("live mode refuses to mutate a dispute that is not in open status", async () => {
  const client = recordingClient({
    disputeBeforeVerdict: openDispute({ status: "resolved", verdict: "upheld" }),
    disputeAfterVerdict: openDispute({ status: "resolved" }),
    response: verdictResponse()
  });

  await assert.rejects(
    () => runDisputeVerdictProof({
      env: baseEnv({ DISPUTE_PROOF_LIVE: "1" }),
      client,
      log: () => {}
    }),
    /not in 'open' status/u
  );

  assert.deepEqual(client.calls.map(([name]) => name), ["getDispute"]);
});

test("live mode refuses if the dispute already carries a verdict, even when status is somehow 'open'", async () => {
  const client = recordingClient({
    disputeBeforeVerdict: openDispute({ verdict: "dismissed" }),
    disputeAfterVerdict: persistedDispute(),
    response: verdictResponse()
  });

  await assert.rejects(
    () => runDisputeVerdictProof({
      env: baseEnv({ DISPUTE_PROOF_LIVE: "1" }),
      client,
      log: () => {}
    }),
    /already carries a verdict/u
  );

  assert.deepEqual(client.calls.map(([name]) => name), ["getDispute"]);
});

test("live mode rejects a verdict response missing required evidence fields", async () => {
  const client = recordingClient({
    disputeBeforeVerdict: openDispute(),
    disputeAfterVerdict: persistedDispute(),
    response: verdictResponse({ reasoningHash: undefined })
  });

  await assert.rejects(
    () => runDisputeVerdictProof({
      env: baseEnv({ DISPUTE_PROOF_LIVE: "1" }),
      client,
      log: () => {}
    }),
    /missing required evidence fields.*reasoningHash/u
  );
});

test("live mode rejects an unknown chainStatus value to catch wiring drift", async () => {
  const client = recordingClient({
    disputeBeforeVerdict: openDispute(),
    disputeAfterVerdict: persistedDispute(),
    response: verdictResponse({ chainStatus: "fictional_state" })
  });

  await assert.rejects(
    () => runDisputeVerdictProof({
      env: baseEnv({ DISPUTE_PROOF_LIVE: "1" }),
      client,
      log: () => {}
    }),
    /Unknown chainStatus 'fictional_state'/u
  );
});

test("live mode fails closed when the persisted dispute re-fetch disagrees with the response", async () => {
  const client = recordingClient({
    disputeBeforeVerdict: openDispute(),
    // Server returned a verdict response but the persisted record still
    // shows the dispute as open — receipt did not actually land.
    disputeAfterVerdict: openDispute({ status: "open" }),
    response: verdictResponse()
  });

  await assert.rejects(
    () => runDisputeVerdictProof({
      env: baseEnv({ DISPUTE_PROOF_LIVE: "1" }),
      client,
      log: () => {}
    }),
    /Receipt did not persist/u
  );
});

test("missing DISPUTE_PROOF_ID is rejected before any HTTP call", async () => {
  let calls = 0;
  const client = {
    async getDispute() {
      calls += 1;
      throw new Error("must not be reached");
    }
  };

  await assert.rejects(
    () => runDisputeVerdictProof({
      env: baseEnv({ DISPUTE_PROOF_ID: "" }),
      client,
      log: () => {}
    }),
    /DISPUTE_PROOF_ID is required/u
  );
  assert.equal(calls, 0);
});

test("missing ADMIN_JWT and AVERRAY_TOKEN is rejected before any HTTP call", async () => {
  await assert.rejects(
    () => runDisputeVerdictProof({
      env: { DISPUTE_PROOF_ID: DISPUTE_ID, DISPUTE_PROOF_VERDICT: "dismissed", DISPUTE_PROOF_RATIONALE: "x" },
      log: () => {}
    }),
    /ADMIN_JWT \(or AVERRAY_TOKEN\) is required/u
  );
});

test("invalid verdict value is rejected before any HTTP call", async () => {
  await assert.rejects(
    () => runDisputeVerdictProof({
      env: baseEnv({ DISPUTE_PROOF_VERDICT: "maybe" }),
      log: () => {}
    }),
    /DISPUTE_PROOF_VERDICT must be one of/u
  );
});

test("split verdict without DISPUTE_PROOF_WORKER_PAYOUT is rejected before any HTTP call", async () => {
  await assert.rejects(
    () => runDisputeVerdictProof({
      env: baseEnv({ DISPUTE_PROOF_VERDICT: "split" }),
      log: () => {}
    }),
    /DISPUTE_PROOF_WORKER_PAYOUT is required for split verdicts/u
  );
});

test("a non-'1' DISPUTE_PROOF_LIVE value stays in dry-run (defense against truthy strings)", async () => {
  const client = recordingClient({
    disputeBeforeVerdict: openDispute(),
    disputeAfterVerdict: persistedDispute(),
    response: verdictResponse()
  });

  const result = await runDisputeVerdictProof({
    env: baseEnv({ DISPUTE_PROOF_LIVE: "true" }),
    client,
    log: () => {}
  });

  assert.equal(result.mode, "dry_run");
  assert.deepEqual(client.calls.map(([name]) => name), ["getDispute"]);
});

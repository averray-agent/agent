import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { runHostedWorkerLoop } from "./run-hosted-worker-loop.mjs";

test("runHostedWorkerLoop creates, claims, submits, verifies, and writes evidence", async () => {
  const calls = [];
  const wallet = "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519";
  const sessionId = "session-product-proof";
  const jobId = "product-proof-worker-loop-1700000000000";
  const tmp = await mkdtemp(join(tmpdir(), "product-proof-"));
  const evidenceFile = join(tmp, "evidence.json");
  const client = {
    async getAuthSession() {
      calls.push(["getAuthSession"]);
      return { wallet };
    },
    async createJob(payload) {
      calls.push(["createJob", payload]);
      return { id: payload.id };
    },
    async claimJob(id, idempotencyKey) {
      calls.push(["claimJob", id, idempotencyKey]);
      return { status: "claimed", sessionId };
    },
    async submitWork(id, evidence) {
      calls.push(["submitWork", id, evidence]);
      return { status: "submitted", sessionId: id };
    },
    async runVerifier(id, evidence) {
      calls.push(["runVerifier", id, evidence]);
      return { outcome: "approved", reasonCode: "BENCHMARK_THRESHOLD_MET" };
    },
    async getSession(id) {
      calls.push(["getSession", id]);
      return { status: "resolved", sessionId: id };
    },
    async getAgentBadge(id) {
      calls.push(["getAgentBadge", id]);
      return { averray: { sessionId: id, jobId } };
    },
    async getAgentProfile(profileWallet) {
      calls.push(["getAgentProfile", profileWallet]);
      return { wallet: profileWallet.toLowerCase(), badges: [{ sessionId, jobId }] };
    }
  };

  const result = await runHostedWorkerLoop({
    client,
    now: () => 1700000000000,
    log: () => {},
    env: {
      API_BASE_URL: "https://api.example.test/",
      ADMIN_JWT: "token",
      PRODUCT_PROOF_EVIDENCE_FILE: evidenceFile
    }
  });

  assert.equal(result.jobId, jobId);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.wallet, wallet);
  assert.equal(result.badgeUrl, `https://api.example.test/badges/${sessionId}`);
  assert.equal(result.profileUrl, `https://api.example.test/agents/${wallet}`);
  assert.deepEqual(calls.map(([name]) => name), [
    "getAuthSession",
    "createJob",
    "claimJob",
    "submitWork",
    "runVerifier",
    "getSession",
    "getAgentBadge",
    "getAgentProfile"
  ]);
  assert.equal(calls[1][1].verifierMode, "benchmark");
  assert.equal(calls[2][2], `product-proof:${jobId}`);

  const written = JSON.parse(await readFile(evidenceFile, "utf8"));
  assert.equal(written.jobId, jobId);
  assert.equal(written.sessionId, sessionId);
  assert.equal(written.verificationOutcome, "approved");
});

test("runHostedWorkerLoop fails closed without a token", async () => {
  await assert.rejects(
    runHostedWorkerLoop({ env: {}, log: () => {} }),
    /PRODUCT_PROOF_WORKER_TOKEN, AVERRAY_TOKEN, or ADMIN_JWT is required/u
  );
});

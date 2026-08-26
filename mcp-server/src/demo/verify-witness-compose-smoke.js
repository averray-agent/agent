import assert from "node:assert/strict";

import { RedisStateStore } from "../core/state-store.js";
import { VerificationProfileRegistry } from "../services/verification-profile-registry.js";
import { VerificationRunService } from "../services/verification-run-service.js";

const FIXTURE = Object.freeze({
  profile: "git-patch-tests-v1",
  profileVersion: 1,
  target: {
    repository: "github.com/averray-agent/verify-smoke-fixture",
    commit: "593bc822c12ae138f174590e41e4aaafbc749d31"
  },
  inputs: {
    gitBundle: {
      sha256: "f33bf850cd600c9911da19cdb82e31795c93a11f4f5bace560d7170e9014d372",
      bytes: 827,
      locator: {
        kind: "https",
        url: "https://github.com/averray-agent/agent/releases/download/verify-smoke-fixtures-v1/smoke-verify.bundle"
      },
      format: "git-bundle"
    },
    patch: {
      sha256: "a3b85b3dea8422e5e54c6410be6b3d5d5575f4a70d43423cec180ec2bf85eabb",
      bytes: 481,
      locator: {
        kind: "https",
        url: "https://github.com/averray-agent/agent/releases/download/verify-smoke-fixtures-v1/fix-retention.patch"
      },
      format: "file"
    },
    testCommand: ["npm", "test"]
  },
  paymentProof: "compose-smoke-proof"
});

const calls = { authorize: 0, capture: 0, release: 0 };
const paymentGate = {
  async authorize() {
    calls.authorize += 1;
    return {
      id: "compose-smoke-authorization",
      customer: "0x1111111111111111111111111111111111111111",
      amountRaw: "5000000",
      asset: "USDC",
      network: "eip155:8453"
    };
  },
  async capture() {
    calls.capture += 1;
    return { transactionHash: `0x${"4".repeat(64)}` };
  },
  async release() {
    calls.release += 1;
  }
};

const stateStore = new RedisStateStore(
  required("REDIS_URL"),
  required("REDIS_NAMESPACE")
);

try {
  const service = new VerificationRunService({
    stateStore,
    profileRegistry: new VerificationProfileRegistry(),
    paymentGate,
    publicReceiptBaseUrl: "https://averray.com",
    runnerTimeoutMarginMs: 30_000,
    finalizerId: "compose-smoke-finalizer"
  });
  const created = await service.createRun(FIXTURE);
  // createRun re-reads the run after its atomic reserve, and the runner
  // container (100ms poll) can claim it between those two round trips, so
  // either lifecycle state proves the enqueue; completion is asserted below.
  assert.ok(
    ["queued", "running"].includes(created.status),
    `expected the enqueued run to be queued or claimed, got: ${JSON.stringify(created)}`
  );
  assert.deepEqual(calls, { authorize: 1, capture: 0, release: 0 });

  const deadline = Date.now() + 180_000;
  let run = created;
  while (run.status !== "complete" && Date.now() < deadline) {
    await service.finalizeAvailableRuns();
    run = await service.getRun(created.runId);
    if (run.status !== "complete") await delay(250);
  }

  assert.equal(run.status, "complete", `verification did not complete: ${JSON.stringify(run)}`);
  assert.equal(run.verdict.outcome, "approved", JSON.stringify(run.verdict));
  assert.equal(run.execution?.report?.verdict, "PASS");
  assert.equal(run.execution?.sourceBinding?.verified, true);
  assert.equal(run.execution?.sourceBinding?.ref, FIXTURE.target.commit);
  assert.equal(run.billing.status, "captured");
  assert.match(run.receiptId, /^0x[a-f0-9]{64}$/u);
  assert.deepEqual(calls, { authorize: 1, capture: 1, release: 0 });
  console.log(JSON.stringify({
    ok: true,
    runId: run.runId,
    verdict: run.verdict.outcome,
    witnessVerdict: run.execution.report.verdict,
    billing: run.billing.status,
    receiptId: run.receiptId
  }));
} finally {
  if (stateStore.client?.isOpen) await stateStore.client.quit();
}

function required(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

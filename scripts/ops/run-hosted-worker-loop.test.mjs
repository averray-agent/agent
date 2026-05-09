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
    async getAdminStatus() {
      calls.push(["getAdminStatus"]);
      return settlementReadyStatus();
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
    "getAdminStatus",
    "createJob",
    "claimJob",
    "submitWork",
    "runVerifier",
    "getSession",
    "getAgentBadge",
    "getAgentProfile"
  ]);
  assert.equal(calls[2][1].verifierMode, "benchmark");
  assert.equal(calls[2][1].rewardAsset, "USDC");
  assert.equal(calls[2][1].rewardAmount, 0.000001);
  assert.equal(calls[3][2], `product-proof:${jobId}`);

  const written = JSON.parse(await readFile(evidenceFile, "utf8"));
  assert.equal(written.jobId, jobId);
  assert.equal(written.sessionId, sessionId);
  assert.equal(written.verificationOutcome, "approved");
  assert.equal(written.settlementReadiness.settlementReady, true);
});

test("runHostedWorkerLoop fails closed without a token", async () => {
  await assert.rejects(
    runHostedWorkerLoop({ env: {}, log: () => {} }),
    /PRODUCT_PROOF_WORKER_TOKEN, AVERRAY_TOKEN, or ADMIN_JWT is required/u
  );
});

test("runHostedWorkerLoop accepts an explicit positive reward amount", async () => {
  const calls = [];
  const client = {
    async getAuthSession() {
      return { wallet: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519" };
    },
    async getAdminStatus() {
      return settlementReadyStatus();
    },
    async createJob(payload) {
      calls.push(["createJob", payload]);
      return { id: payload.id };
    },
    async claimJob(id) {
      return { status: "claimed", sessionId: `${id}:wallet` };
    },
    async submitWork(id) {
      return { status: "submitted", sessionId: id };
    },
    async runVerifier() {
      return { outcome: "approved" };
    },
    async getSession(id) {
      return { status: "resolved", sessionId: id };
    },
    async getAgentBadge(id) {
      return { averray: { sessionId: id, jobId: "product-proof-worker-loop-1700000000000" } };
    },
    async getAgentProfile() {
      return { badges: [{ sessionId: "product-proof-worker-loop-1700000000000:wallet", jobId: "product-proof-worker-loop-1700000000000" }] };
    }
  };

  await runHostedWorkerLoop({
    client,
    now: () => 1700000000000,
    log: () => {},
    env: {
      ADMIN_JWT: "token",
      PRODUCT_PROOF_REWARD_AMOUNT: "0.01"
    }
  });

  assert.equal(calls[0][1].rewardAmount, 0.01);
});

test("runHostedWorkerLoop fails closed before mutation when settlement is not ready", async () => {
  const calls = [];
  await assert.rejects(
    runHostedWorkerLoop({
      client: {
        async getAuthSession() {
          calls.push(["getAuthSession"]);
          return { wallet: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519" };
        },
        async getAdminStatus() {
          calls.push(["getAdminStatus"]);
          return settlementReadyStatus({
            settlementReady: false,
            readErrors: [{ field: "serviceOperators(escrowCore)", message: "execution reverted" }],
            roles: {
              signerAddress: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
              signerIsVerifier: false,
              escrowIsServiceOperator: true,
              agentAccountIsServiceOperator: true
            }
          });
        },
        async createJob() {
          calls.push(["createJob"]);
          throw new Error("should not mutate when settlement is not ready");
        }
      },
      now: () => 1700000000000,
      log: () => {},
      env: { ADMIN_JWT: "token" }
    }),
    /signerIsVerifier=false, policyReadErrors=serviceOperators\(escrowCore\)/u
  );

  assert.deepEqual(calls.map(([name]) => name), ["getAuthSession", "getAdminStatus"]);
});

test("runHostedWorkerLoop rejects non-USDC product-proof reward assets before mutation", async () => {
  const calls = [];
  await assert.rejects(
    runHostedWorkerLoop({
      client: {
        async getAuthSession() {
          calls.push(["getAuthSession"]);
          return { wallet: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519" };
        },
        async createJob() {
          calls.push(["createJob"]);
          throw new Error("should not mutate with non-USDC reward asset");
        }
      },
      now: () => 1700000000000,
      log: () => {},
      env: { ADMIN_JWT: "token", PRODUCT_PROOF_REWARD_ASSET: "DOT" }
    }),
    /requires USDC settlement; got PRODUCT_PROOF_REWARD_ASSET=DOT/u
  );

  assert.deepEqual(calls, []);
});

test("runHostedWorkerLoop rejects USDC symbol with non-canonical asset metadata", async () => {
  const calls = [];
  await assert.rejects(
    runHostedWorkerLoop({
      client: {
        async getAuthSession() {
          calls.push(["getAuthSession"]);
          return { wallet: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519" };
        },
        async getAdminStatus() {
          calls.push(["getAdminStatus"]);
          return settlementReadyStatus({
            contracts: {
              supportedAssets: [{
                symbol: "USDC",
                address: "0x5555555555555555555555555555555555555555",
                assetClass: "custom",
                assetId: 999,
                decimals: 18,
                approved: true
              }]
            }
          });
        },
        async createJob() {
          calls.push(["createJob"]);
          throw new Error("should not mutate with non-canonical USDC asset metadata");
        }
      },
      now: () => 1700000000000,
      log: () => {},
      env: { ADMIN_JWT: "token" }
    }),
    /requires canonical v1 USDC settlement asset; address=0x5555555555555555555555555555555555555555, assetClass=custom, assetId=999, decimals=18/u
  );

  assert.deepEqual(calls.map(([name]) => name), ["getAuthSession", "getAdminStatus"]);
});

test("runHostedWorkerLoop rejects missing matching USDC settlement asset", async () => {
  const calls = [];
  await assert.rejects(
    runHostedWorkerLoop({
      client: {
        async getAuthSession() {
          calls.push(["getAuthSession"]);
          return { wallet: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519" };
        },
        async getAdminStatus() {
          calls.push(["getAdminStatus"]);
          return settlementReadyStatus({
            contracts: {
              supportedAssets: [{
                symbol: "DOT",
                address: "0x5555555555555555555555555555555555555555",
                assetClass: "custom",
                decimals: 18,
                approved: true
              }]
            }
          });
        },
        async createJob() {
          calls.push(["createJob"]);
          throw new Error("should not mutate without USDC");
        }
      },
      now: () => 1700000000000,
      log: () => {},
      env: { ADMIN_JWT: "token" }
    }),
    /requires USDC as the configured settlement asset/u
  );

  assert.deepEqual(calls.map(([name]) => name), ["getAuthSession", "getAdminStatus"]);
});

test("runHostedWorkerLoop rejects unapproved canonical USDC settlement asset", async () => {
  const calls = [];
  await assert.rejects(
    runHostedWorkerLoop({
      client: {
        async getAuthSession() {
          calls.push(["getAuthSession"]);
          return { wallet: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519" };
        },
        async getAdminStatus() {
          calls.push(["getAdminStatus"]);
          return settlementReadyStatus({
            contracts: {
              supportedAssets: [{
                symbol: "USDC",
                address: "0x0000053900000000000000000000000001200000",
                assetClass: "trust_backed",
                assetId: 1337,
                decimals: 6,
                approved: false
              }]
            }
          });
        },
        async createJob() {
          calls.push(["createJob"]);
          throw new Error("should not mutate with unapproved USDC");
        }
      },
      now: () => 1700000000000,
      log: () => {},
      env: { ADMIN_JWT: "token" }
    }),
    /requires approved USDC settlement asset/u
  );

  assert.deepEqual(calls.map(([name]) => name), ["getAuthSession", "getAdminStatus"]);
});

test("runHostedWorkerLoop rejects invalid reward amounts", async () => {
  await assert.rejects(
    runHostedWorkerLoop({
      client: {
        async getAuthSession() {
          throw new Error("should not authenticate after invalid reward amount");
        }
      },
      env: { ADMIN_JWT: "token", PRODUCT_PROOF_REWARD_AMOUNT: "0" },
      log: () => {}
    }),
    /PRODUCT_PROOF_REWARD_AMOUNT must be greater than zero/u
  );
});

function settlementReadyStatus(overrides = {}) {
  const base = {
    maintenance: {
      policy: {
        enabled: true,
        policyAddress: "0x1111111111111111111111111111111111111111",
        paused: false,
        settlementReady: true,
        roles: {
          signerAddress: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
            signerIsVerifier: true,
            escrowIsServiceOperator: true,
            agentAccountIsServiceOperator: true
          },
        contracts: {
          escrowCoreAddress: "0x2222222222222222222222222222222222222222",
          agentAccountAddress: "0x3333333333333333333333333333333333333333",
          reputationSbtAddress: "0x4444444444444444444444444444444444444444",
          supportedAssets: [{
            symbol: "USDC",
            address: "0x0000053900000000000000000000000001200000",
            assetClass: "trust_backed",
            assetId: 1337,
            decimals: 6,
            approved: true
          }]
        }
      }
    }
  };

  return {
    ...base,
    maintenance: {
      ...base.maintenance,
      ...(overrides.maintenance ?? {}),
      policy: {
        ...base.maintenance.policy,
        ...(overrides.maintenance?.policy ?? overrides),
        roles: {
          ...base.maintenance.policy.roles,
          ...((overrides.maintenance?.policy ?? overrides).roles ?? {})
        },
        contracts: {
          ...base.maintenance.policy.contracts,
          ...((overrides.maintenance?.policy ?? overrides).contracts ?? {})
        }
      }
    }
  };
}

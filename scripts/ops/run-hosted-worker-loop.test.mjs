import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  formatHostedWorkerLoopError,
  resolveHostedWorkerLoopAuth,
  runHostedWorkerLoop,
  selectHostedWorkerLoopAuthPath
} from "./run-hosted-worker-loop.mjs";

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
      return authSession({ wallet });
    },
    async getAdminStatus() {
      calls.push(["getAdminStatus"]);
      return settlementReadyStatus();
    },
    async getAccountSummary() {
      calls.push(["getAccountSummary"]);
      return accountSummary({ liquidUsdcRaw: 100_000 });
    },
    async createJob(payload) {
      calls.push(["createJob", payload]);
      return { id: payload.id };
    },
    async preflightJob(id) {
      calls.push(["preflightJob", id]);
      return preflightReady({ jobId: id, wallet });
    },
    async validateJobSubmission(id, submission) {
      calls.push(["validateJobSubmission", id, submission]);
      return validationForSubmission({ jobId: id, submission });
    },
    async claimJob(id, idempotencyKey) {
      calls.push(["claimJob", id, idempotencyKey]);
      return { status: "claimed", sessionId, claimExpiresAt: "2026-01-01T01:00:00.000Z" };
    },
    async submitWork(id, submission) {
      calls.push(["submitWork", id, submission]);
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
      return {
        averray: { sessionId: id, jobId },
        signers: [
          { role: "operator", wallet, at: "2026-01-01T00:00:00.000Z" },
          { role: "verifier", wallet, at: "2026-01-01T00:05:00.000Z" },
          { role: "worker", wallet, at: "2026-01-01T00:04:00.000Z" }
        ]
      };
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
      PRODUCT_PROOF_RECEIPT_POLICY_TAG: "receipt/operator-verifier-cosign@v1",
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
    "getAccountSummary",
    "createJob",
    "preflightJob",
    "getAccountSummary",
    "validateJobSubmission",
    "validateJobSubmission",
    "claimJob",
    "submitWork",
    "runVerifier",
    "getSession",
    "getAgentBadge",
    "getAgentProfile"
  ]);
  assert.equal(calls[3][1].verifierMode, "benchmark");
  assert.equal(calls[3][1].rewardAsset, "USDC");
  assert.equal(calls[3][1].rewardAmount, 0.1);
  assert.deepEqual(calls[3][1].verification, {
    receiptPolicyTag: "receipt/operator-verifier-cosign@v1"
  });
  assert.equal(calls[6][2].summary, `complete verified output for ${jobId}`);
  assert.deepEqual(calls[7][2], { output: { wrapped_under_submission_output: true } });
  assert.equal(calls[8][2], `product-proof:${jobId}`);
  assert.equal(calls[9][2].status, "complete");
  assert.equal(calls[10][1], sessionId);
  assert.equal(calls[10][2], undefined);

  const written = JSON.parse(await readFile(evidenceFile, "utf8"));
  assert.equal(written.jobId, jobId);
  assert.equal(written.sessionId, sessionId);
  assert.equal(written.verificationOutcome, "approved");
  assert.equal(written.receiptPolicyTag, "receipt/operator-verifier-cosign@v1");
  assert.deepEqual(written.receiptSigners.map((entry) => entry.role), ["operator", "verifier", "worker"]);
  assert.equal(written.settlementReadiness.settlementReady, true);
  assert.equal(written.rewardReadiness.minBalanceRaw, "70000");
  assert.equal(written.rewardReadiness.rewardRaw, "100000");
  assert.equal(written.signerFundingReadiness.signer, wallet);
  assert.equal(written.signerFundingReadiness.requiredRaw, "100000");
  assert.equal(written.signerFundingReadiness.availableRaw, "200000");
  assert.equal(written.liquidityReadiness.requiredRaw, "100000");
  assert.equal(written.liquidityReadiness.availableRaw, "100000");
  assert.equal(written.claimLiquidityReadiness.rewardRaw, "100000");
  assert.equal(written.claimLiquidityReadiness.totalClaimLockRaw, "0");
  assert.equal(written.claimLiquidityReadiness.requiredRaw, "100000");
  assert.equal(written.claimLiquidityReadiness.availableRaw, "100000");
  assert.equal(written.claimSignerFundingReadiness.rewardRaw, "100000");
  assert.equal(written.claimSignerFundingReadiness.totalClaimLockRaw, "0");
  assert.equal(written.claimSignerFundingReadiness.requiredRaw, "100000");
  assert.equal(written.claimSignerFundingReadiness.availableRaw, "200000");
  assert.deepEqual(written.authReadiness.roles, ["admin", "verifier"]);
  assert.ok(written.authReadiness.capabilitiesPresent.includes("verifier:run"));
  assert.equal(written.preflightReadiness.eligible, true);
  assert.equal(written.preflightReadiness.requiredOutputSchema, "schema://jobs/product-proof-worker-loop");
  assert.equal(written.validationReadiness.valid, true);
  assert.equal(written.validationReadiness.schemaRef, "schema://jobs/product-proof-worker-loop");
  assert.equal(written.validationReadiness.schemaValidates, "payload.submission");
  assert.equal(written.validationReadiness.submissionKind, "structured");
  assert.equal(written.validationReadiness.validatedBeforeClaim, true);
  assert.equal(written.invalidValidationReadiness.valid, false);
  assert.equal(written.invalidValidationReadiness.submitSafe, false);
  assert.equal(written.invalidValidationReadiness.schemaRef, "schema://jobs/product-proof-worker-loop");
  assert.equal(written.invalidValidationReadiness.schemaValidates, "payload.submission");
  assert.equal(written.invalidValidationReadiness.code, "invalid_submission_shape");
  assert.equal(written.invalidValidationReadiness.received, "payload.submission.output");
  assert.equal(written.invalidValidationReadiness.checkedBeforeClaim, true);
  assert.equal(written.invalidValidationReadiness.submitAttempted, false);
  assert.equal(written.verificationReadiness.schemaRef, "schema://jobs/product-proof-worker-loop");
  assert.equal(written.verificationReadiness.usesStoredSessionSubmission, true);
  assert.equal(written.verificationReadiness.evidenceOverrideProvided, false);
  assert.equal(written.claimReadiness.status, "claimed");
  assert.equal(written.claimReadiness.claimExpiresAt, "2026-01-01T01:00:00.000Z");
  assert.equal(written.submitStatus, "submitted");
});

test("runHostedWorkerLoop fails closed without a token", async () => {
  await assert.rejects(
    runHostedWorkerLoop({
      env: {},
      log: () => {},
      async readSecretImpl() {
        throw new Error("op read failed for admin-refresh-token");
      }
    }),
    /op read failed for admin-refresh-token/u
  );
});

test("selectHostedWorkerLoopAuthPath chooses explicit refresh and legacy branches", () => {
  assert.deepEqual(selectHostedWorkerLoopAuthPath({ PRODUCT_PROOF_WORKER_TOKEN: "worker-token" }), {
    mode: "direct_token",
    source: "PRODUCT_PROOF_WORKER_TOKEN",
    token: "worker-token"
  });
  assert.deepEqual(selectHostedWorkerLoopAuthPath({ AVERRAY_TOKEN: "averray-token" }), {
    mode: "direct_token",
    source: "AVERRAY_TOKEN",
    token: "averray-token"
  });
  assert.deepEqual(selectHostedWorkerLoopAuthPath({
    ADMIN_JWT_OP: "legacy-token",
    ADMIN_REFRESH_TOKEN_OP: "op://prod-smoke/admin-refresh-token/password"
  }), {
    mode: "legacy_admin_jwt",
    source: "ADMIN_JWT_OP",
    token: "legacy-token"
  });
  assert.deepEqual(selectHostedWorkerLoopAuthPath({
    ADMIN_JWT: "legacy-token",
    ADMIN_REFRESH_TOKEN_OP: "op://prod-smoke/admin-refresh-token/password"
  }), {
    mode: "admin_refresh",
    source: "ADMIN_REFRESH_TOKEN_OP"
  });
  assert.deepEqual(selectHostedWorkerLoopAuthPath({ ADMIN_JWT: "legacy-token" }), {
    mode: "legacy_admin_jwt",
    source: "ADMIN_JWT",
    token: "legacy-token"
  });
  assert.deepEqual(selectHostedWorkerLoopAuthPath({}), {
    mode: "admin_refresh",
    source: "op://prod-smoke/admin-refresh-token/password"
  });
});

test("resolveHostedWorkerLoopAuth exchanges refresh token without running the loop", async () => {
  const calls = [];
  const auth = await resolveHostedWorkerLoopAuth({
    apiBaseUrl: "https://api.example.test",
    env: { ADMIN_REFRESH_TOKEN_OP: "op://prod-smoke/admin-refresh-token/password" },
    async readSecretImpl(ref) {
      calls.push(["read", ref]);
      return "refresh-old";
    },
    async writeSecretImpl(ref, value) {
      calls.push(["write", ref, value]);
    },
    async fetchImpl(url, options) {
      calls.push(["fetch", url, options.headers.cookie]);
      return new Response(JSON.stringify({
        token: "short-lived-access-token",
        roles: ["admin", "verifier"],
        wallet: "0x1111111111111111111111111111111111111111",
        expiresAt: "2026-05-26T12:15:00.000Z"
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "refresh_token=refresh-new; HttpOnly; Secure; SameSite=Strict; Path=/auth/refresh"
        }
      });
    }
  });

  assert.deepEqual(auth, {
    mode: "admin_refresh",
    source: "op://prod-smoke/admin-refresh-token/password",
    token: "short-lived-access-token"
  });
  assert.deepEqual(calls, [
    ["read", "op://prod-smoke/admin-refresh-token/password"],
    ["fetch", "https://api.example.test/auth/refresh", "refresh_token=refresh-old"],
    ["write", "op://prod-smoke/admin-refresh-token/password", "refresh-new"]
  ]);
});

test("runHostedWorkerLoop fails closed before mutation when token lacks verifier capability", async () => {
  const calls = [];
  await assert.rejects(
    runHostedWorkerLoop({
      client: {
        async getAuthSession() {
          calls.push(["getAuthSession"]);
          return authSession({
            roles: ["admin"],
            capabilities: [
              "account:read",
              "admin:status",
              "jobs:create",
              "jobs:preflight",
              "jobs:claim",
              "jobs:submit",
              "session:read"
            ]
          });
        },
        async getAdminStatus() {
          calls.push(["getAdminStatus"]);
          throw new Error("should not inspect settlement after token capability preflight fails");
        },
        async createJob() {
          calls.push(["createJob"]);
          throw new Error("should not mutate without verifier capability");
        }
      },
      now: () => 1700000000000,
      log: () => {},
      env: { ADMIN_JWT: "token" }
    }),
    /requires a token with all mutation-loop capabilities before mutation; missing=verifier:run; roles=admin/u
  );

  assert.deepEqual(calls.map(([name]) => name), ["getAuthSession"]);
});

test("runHostedWorkerLoop accepts an explicit positive reward amount", async () => {
  const calls = [];
  const client = {
    async getAuthSession() {
      return authSession();
    },
    async getAdminStatus() {
      return settlementReadyStatus();
    },
    async getAccountSummary() {
      return accountSummary({ liquidUsdcRaw: 70_000 });
    },
    async createJob(payload) {
      calls.push(["createJob", payload]);
      return { id: payload.id };
    },
    async preflightJob(id) {
      calls.push(["preflightJob", id]);
      return preflightReady({ jobId: id });
    },
    async validateJobSubmission(id, submission) {
      return validationForSubmission({ jobId: id, submission });
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
      PRODUCT_PROOF_REWARD_AMOUNT: "0.07"
    }
  });

  assert.equal(calls[0][1].rewardAmount, 0.07);
});

test("runHostedWorkerLoop accepts display-unit account liquidity when raw balance is unavailable", async () => {
  const calls = [];
  const client = {
    async getAuthSession() {
      return authSession();
    },
    async getAdminStatus() {
      return settlementReadyStatus();
    },
    async getAccountSummary() {
      return accountSummary({ liquidUsdc: 0.1, includeRaw: false });
    },
    async createJob(payload) {
      calls.push(["createJob", payload]);
      return { id: payload.id };
    },
    async preflightJob(id) {
      return preflightReady({ jobId: id });
    },
    async validateJobSubmission(id, submission) {
      return validationForSubmission({ jobId: id, submission });
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

  const result = await runHostedWorkerLoop({
    client,
    now: () => 1700000000000,
    log: () => {},
    env: { ADMIN_JWT: "token" }
  });

  assert.equal(calls[0][1].rewardAmount, 0.1);
  assert.equal(result.liquidityReadiness.availableRaw, "100000");
});

test("runHostedWorkerLoop normalizes floating preflight claim lock display values", async () => {
  const client = {
    async getAuthSession() {
      return authSession();
    },
    async getAdminStatus() {
      return settlementReadyStatus();
    },
    async getAccountSummary() {
      return accountSummary({ liquidUsdcRaw: 160_000 });
    },
    async createJob(payload) {
      return { id: payload.id };
    },
    async preflightJob(id) {
      return preflightReady({ jobId: id, totalClaimLock: 0.060000000000000005 });
    },
    async validateJobSubmission(id, submission) {
      return validationForSubmission({ jobId: id, submission });
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

  const result = await runHostedWorkerLoop({
    client,
    now: () => 1700000000000,
    log: () => {},
    env: { ADMIN_JWT: "token" }
  });

  assert.equal(result.claimLiquidityReadiness.rewardRaw, "100000");
  assert.equal(result.claimLiquidityReadiness.totalClaimLockRaw, "60000");
  assert.equal(result.claimLiquidityReadiness.requiredRaw, "160000");
});

test("runHostedWorkerLoop fails closed before mutation when AgentAccountCore USDC liquidity is missing", async () => {
  const calls = [];
  const wallet = "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519";
  await assert.rejects(
    runHostedWorkerLoop({
      client: {
        async getAuthSession() {
          calls.push(["getAuthSession"]);
          return authSession({ wallet });
        },
        async getAdminStatus() {
          calls.push(["getAdminStatus"]);
          return settlementReadyStatus();
        },
        async getAccountSummary() {
          calls.push(["getAccountSummary"]);
          return accountSummary({ liquidUsdcRaw: 0 });
        },
        async createJob() {
          calls.push(["createJob"]);
          throw new Error("should not create a catalog job without funded USDC liquidity");
        }
      },
      now: () => 1700000000000,
      log: () => {},
      env: { ADMIN_JWT: "token" }
    }),
    /requires funded USDC liquidity before mutation; wallet=0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519; account=0x3333333333333333333333333333333333333333; required=0\.1 USDC \(raw 100000\); available=0 USDC \(raw 0\)/u
  );

  assert.deepEqual(calls.map(([name]) => name), ["getAuthSession", "getAdminStatus", "getAccountSummary"]);
});

test("runHostedWorkerLoop prefers direct AgentAccountCore position over stale account summary liquidity", async () => {
  const calls = [];
  const wallet = "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519";
  await assert.rejects(
    runHostedWorkerLoop({
      client: {
        async getAuthSession() {
          calls.push(["getAuthSession"]);
          return authSession({ wallet });
        },
        async getAdminStatus() {
          calls.push(["getAdminStatus"]);
          return settlementReadyStatus();
        },
        async getAccountPosition(asset) {
          calls.push(["getAccountPosition", asset]);
          return accountPosition({ wallet, liquidUsdcRaw: 0 });
        },
        async getAccountSummary() {
          calls.push(["getAccountSummary"]);
          return accountSummary({ wallet, liquidUsdcRaw: 1_000_000 });
        },
        async createJob() {
          calls.push(["createJob"]);
          throw new Error("should not create a catalog job when direct chain position is empty");
        }
      },
      now: () => 1700000000000,
      log: () => {},
      env: { ADMIN_JWT: "token" }
    }),
    /requires funded USDC liquidity before mutation; wallet=0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519; account=0x3333333333333333333333333333333333333333; required=0\.1 USDC \(raw 100000\); available=0 USDC \(raw 0\)/u
  );

  assert.deepEqual(calls.map(([name]) => name), ["getAuthSession", "getAdminStatus", "getAccountPosition"]);
});

test("runHostedWorkerLoop fails closed before mutation when signer funding telemetry is missing", async () => {
  const calls = [];
  await assert.rejects(
    runHostedWorkerLoop({
      client: {
        async getAuthSession() {
          calls.push(["getAuthSession"]);
          return authSession();
        },
        async getAdminStatus() {
          calls.push(["getAdminStatus"]);
          return settlementReadyStatus({ signerFunding: null });
        },
        async getAccountSummary() {
          calls.push(["getAccountSummary"]);
          throw new Error("should not inspect worker liquidity without signer funding telemetry");
        },
        async createJob() {
          calls.push(["createJob"]);
          throw new Error("should not create a catalog job without signer funding telemetry");
        }
      },
      now: () => 1700000000000,
      log: () => {},
      env: { ADMIN_JWT: "token" }
    }),
    /requires signer AgentAccountCore funding telemetry before mutation; signer=0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519; account=0x3333333333333333333333333333333333333333/u
  );

  assert.deepEqual(calls.map(([name]) => name), ["getAuthSession", "getAdminStatus"]);
});

test("runHostedWorkerLoop fails closed before mutation when signer USDC funding is missing", async () => {
  const calls = [];
  await assert.rejects(
    runHostedWorkerLoop({
      client: {
        async getAuthSession() {
          calls.push(["getAuthSession"]);
          return authSession();
        },
        async getAdminStatus() {
          calls.push(["getAdminStatus"]);
          return settlementReadyStatus({
            signerFunding: signerFundingReady({
              account: "0x31ad432dFe083B998c69B6dB88A984ec5207ab7F",
              liquidUsdcRaw: "0"
            }),
            roles: {
              signerAddress: "0x31ad432dFe083B998c69B6dB88A984ec5207ab7F"
            }
          });
        },
        async getAccountSummary() {
          calls.push(["getAccountSummary"]);
          throw new Error("should not inspect worker liquidity before signer funding is ready");
        },
        async createJob() {
          calls.push(["createJob"]);
          throw new Error("should not create a catalog job without signer USDC liquidity");
        }
      },
      now: () => 1700000000000,
      log: () => {},
      env: { ADMIN_JWT: "token" }
    }),
    /requires funded signer USDC liquidity before mutation; signer=0x31ad432dFe083B998c69B6dB88A984ec5207ab7F; account=0x3333333333333333333333333333333333333333; reward=0\.1 USDC \(raw 100000\); totalClaimLock=0 USDC \(raw 0\); required=0\.1 USDC \(raw 100000\); available=0 USDC \(raw 0\)/u
  );

  assert.deepEqual(calls.map(([name]) => name), ["getAuthSession", "getAdminStatus"]);
});

test("runHostedWorkerLoop fails closed before mutation when account summary wallet mismatches auth session", async () => {
  const calls = [];
  await assert.rejects(
    runHostedWorkerLoop({
      client: {
        async getAuthSession() {
          calls.push(["getAuthSession"]);
          return authSession();
        },
        async getAdminStatus() {
          calls.push(["getAdminStatus"]);
          return settlementReadyStatus();
        },
        async getAccountSummary() {
          calls.push(["getAccountSummary"]);
          return accountSummary({
            wallet: "0x1111111111111111111111111111111111111111",
            liquidUsdcRaw: 1
          });
        },
        async createJob() {
          calls.push(["createJob"]);
          throw new Error("should not create a catalog job for mismatched account liquidity");
        }
      },
      now: () => 1700000000000,
      log: () => {},
      env: { ADMIN_JWT: "token" }
    }),
    /requires \/account to match \/auth\/session; authWallet=0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519; accountWallet=0x1111111111111111111111111111111111111111/u
  );

  assert.deepEqual(calls.map(([name]) => name), ["getAuthSession", "getAdminStatus", "getAccountSummary"]);
});

test("runHostedWorkerLoop fails closed after job creation when preflight blocks claim", async () => {
  const calls = [];
  const jobId = "product-proof-worker-loop-1700000000000";
  await assert.rejects(
    runHostedWorkerLoop({
      client: {
        async getAuthSession() {
          calls.push(["getAuthSession"]);
          return authSession();
        },
        async getAdminStatus() {
          calls.push(["getAdminStatus"]);
          return settlementReadyStatus();
        },
        async getAccountSummary() {
          calls.push(["getAccountSummary"]);
          return accountSummary({ liquidUsdcRaw: 100_000 });
        },
        async createJob(payload) {
          calls.push(["createJob", payload]);
          return { id: payload.id };
        },
        async preflightJob(id) {
          calls.push(["preflightJob", id]);
          return {
            ...preflightReady({ jobId: id }),
            eligible: false,
            claimable: false,
            currentWalletCanClaim: false,
            reason: "tier_gate"
          };
        },
        async claimJob() {
          calls.push(["claimJob"]);
          throw new Error("should not claim when preflight blocks claim");
        }
      },
      now: () => 1700000000000,
      log: () => {},
      env: { ADMIN_JWT: "token" }
    }),
    /preflight failed: eligible=false; claimable=false; currentWalletCanClaim=false; reason=tier_gate/u
  );

  assert.deepEqual(calls.map(([name]) => name), [
    "getAuthSession",
    "getAdminStatus",
    "getAccountSummary",
    "createJob",
    "preflightJob"
  ]);
  assert.equal(calls[4][1], jobId);
});

test("runHostedWorkerLoop refreshes liquidity after job creation before claim", async () => {
  const calls = [];
  const balances = [200_000, 100_000];
  await assert.rejects(
    runHostedWorkerLoop({
      client: {
        async getAuthSession() {
          calls.push(["getAuthSession"]);
          return authSession();
        },
        async getAdminStatus() {
          calls.push(["getAdminStatus"]);
          return settlementReadyStatus();
        },
        async getAccountSummary() {
          calls.push(["getAccountSummary"]);
          return accountSummary({ liquidUsdcRaw: balances.shift() ?? 100_000 });
        },
        async createJob(payload) {
          calls.push(["createJob", payload]);
          return { id: payload.id };
        },
        async preflightJob(id) {
          calls.push(["preflightJob", id]);
          return preflightReady({ jobId: id, totalClaimLock: 0.055 });
        },
        async validateJobSubmission() {
          calls.push(["validateJobSubmission"]);
          throw new Error("should not validate after refreshed claim-liquidity preflight fails");
        },
        async claimJob() {
          calls.push(["claimJob"]);
          throw new Error("should not claim with stale liquidity");
        }
      },
      now: () => 1700000000000,
      log: () => {},
      env: { ADMIN_JWT: "token" }
    }),
    /requires funded USDC liquidity before claim; .* required=0\.155 USDC \(raw 155000\); available=0\.1 USDC \(raw 100000\)/u
  );

  assert.deepEqual(calls.map(([name]) => name), [
    "getAuthSession",
    "getAdminStatus",
    "getAccountSummary",
    "createJob",
    "preflightJob",
    "getAccountSummary"
  ]);
});

test("runHostedWorkerLoop fails closed after preflight when reward plus claim lock is underfunded", async () => {
  const calls = [];
  const jobId = "product-proof-worker-loop-1700000000000";
  await assert.rejects(
    runHostedWorkerLoop({
      client: {
        async getAuthSession() {
          calls.push(["getAuthSession"]);
          return authSession();
        },
        async getAdminStatus() {
          calls.push(["getAdminStatus"]);
          return settlementReadyStatus();
        },
        async getAccountSummary() {
          calls.push(["getAccountSummary"]);
          return accountSummary({ liquidUsdcRaw: 100_000 });
        },
        async createJob(payload) {
          calls.push(["createJob", payload]);
          return { id: payload.id };
        },
        async preflightJob(id) {
          calls.push(["preflightJob", id]);
          return preflightReady({ jobId: id, totalClaimLock: 0.055 });
        },
        async validateJobSubmission() {
          calls.push(["validateJobSubmission"]);
          throw new Error("should not validate after claim-liquidity preflight fails");
        },
        async claimJob() {
          calls.push(["claimJob"]);
          throw new Error("should not claim without reward plus claim-lock liquidity");
        }
      },
      now: () => 1700000000000,
      log: () => {},
      env: { ADMIN_JWT: "token" }
    }),
    /requires funded USDC liquidity before claim; wallet=0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519; account=0x3333333333333333333333333333333333333333; reward=0\.1 USDC \(raw 100000\); totalClaimLock=0\.055 USDC \(raw 55000\); required=0\.155 USDC \(raw 155000\); available=0\.1 USDC \(raw 100000\)/u
  );

  assert.deepEqual(calls.map(([name]) => name), [
    "getAuthSession",
    "getAdminStatus",
    "getAccountSummary",
    "createJob",
    "preflightJob",
    "getAccountSummary"
  ]);
  assert.equal(calls[4][1], jobId);
});

test("runHostedWorkerLoop fails closed after preflight when signer reward plus claim lock is underfunded", async () => {
  const calls = [];
  const jobId = "product-proof-worker-loop-1700000000000";
  await assert.rejects(
    runHostedWorkerLoop({
      client: {
        async getAuthSession() {
          calls.push(["getAuthSession"]);
          return authSession();
        },
        async getAdminStatus() {
          calls.push(["getAdminStatus"]);
          return settlementReadyStatus({
            signerFunding: signerFundingReady({ liquidUsdcRaw: "100000" })
          });
        },
        async getAccountSummary() {
          calls.push(["getAccountSummary"]);
          return accountSummary({ liquidUsdcRaw: 200_000 });
        },
        async createJob(payload) {
          calls.push(["createJob", payload]);
          return { id: payload.id };
        },
        async preflightJob(id) {
          calls.push(["preflightJob", id]);
          return preflightReady({ jobId: id, totalClaimLock: 0.055 });
        },
        async validateJobSubmission() {
          calls.push(["validateJobSubmission"]);
          throw new Error("should not validate after signer claim-funding preflight fails");
        },
        async claimJob() {
          calls.push(["claimJob"]);
          throw new Error("should not claim without signer reward plus claim-lock liquidity");
        }
      },
      now: () => 1700000000000,
      log: () => {},
      env: { ADMIN_JWT: "token" }
    }),
    /requires funded signer USDC liquidity before claim; signer=0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519; account=0x3333333333333333333333333333333333333333; reward=0\.1 USDC \(raw 100000\); totalClaimLock=0\.055 USDC \(raw 55000\); required=0\.155 USDC \(raw 155000\); available=0\.1 USDC \(raw 100000\)/u
  );

  assert.deepEqual(calls.map(([name]) => name), [
    "getAuthSession",
    "getAdminStatus",
    "getAccountSummary",
    "createJob",
    "preflightJob",
    "getAccountSummary"
  ]);
  assert.equal(calls[4][1], jobId);
});

test("runHostedWorkerLoop fails closed after preflight when schema validation blocks submit", async () => {
  const calls = [];
  const jobId = "product-proof-worker-loop-1700000000000";
  await assert.rejects(
    runHostedWorkerLoop({
      client: {
        async getAuthSession() {
          calls.push(["getAuthSession"]);
          return authSession();
        },
        async getAdminStatus() {
          calls.push(["getAdminStatus"]);
          return settlementReadyStatus();
        },
        async getAccountSummary() {
          calls.push(["getAccountSummary"]);
          return accountSummary({ liquidUsdcRaw: 100_000 });
        },
        async createJob(payload) {
          calls.push(["createJob", payload]);
          return { id: payload.id };
        },
        async preflightJob(id) {
          calls.push(["preflightJob", id]);
          return preflightReady({ jobId: id });
        },
        async validateJobSubmission(id, submission) {
          calls.push(["validateJobSubmission", id, submission]);
          return {
            jobId: id,
            valid: false,
            schemaRef: "schema://jobs/product-proof-worker-loop",
            code: "invalid_request",
            message: "submission.output is required"
          };
        },
        async claimJob() {
          calls.push(["claimJob"]);
          throw new Error("should not claim after validation fails");
        }
      },
      now: () => 1700000000000,
      log: () => {},
      env: { ADMIN_JWT: "token" }
    }),
    /submission validation failed before claim: code=invalid_request; message=submission\.output is required/u
  );

  assert.deepEqual(calls.map(([name]) => name), [
    "getAuthSession",
    "getAdminStatus",
    "getAccountSummary",
    "createJob",
    "preflightJob",
    "getAccountSummary",
    "validateJobSubmission"
  ]);
  assert.equal(calls[6][1], jobId);
  assert.equal(calls[6][2].status, "complete");
});

test("runHostedWorkerLoop fails closed before mutation when settlement is not ready", async () => {
  const calls = [];
  await assert.rejects(
    runHostedWorkerLoop({
      client: {
        async getAuthSession() {
          calls.push(["getAuthSession"]);
          return authSession();
        },
        async getAdminStatus() {
          calls.push(["getAdminStatus"]);
          return settlementReadyStatus({
            settlementReady: false,
            readErrors: [{ field: "settlementBroker(signer)", message: "execution reverted" }],
            roles: {
              signerAddress: "0x31ad432dFe083B998c69B6dB88A984ec5207ab7F",
              signerIsVerifier: false,
              signerIsSettlementBroker: true,
              escrowIsAgentAccountEscrowOperator: true,
              agentAccountIsOutflowRecorder: true
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
    /signerIsVerifier=false, policyReadErrors=settlementBroker\(signer\)/u
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
          return authSession();
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
          return authSession();
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
          return authSession();
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
          return authSession();
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
                minBalanceRaw: "70000",
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

test("runHostedWorkerLoop rejects rewards below the USDC minBalance before mutation", async () => {
  const calls = [];
  await assert.rejects(
    runHostedWorkerLoop({
      client: {
        async getAuthSession() {
          calls.push(["getAuthSession"]);
          return authSession();
        },
        async getAdminStatus() {
          calls.push(["getAdminStatus"]);
          return settlementReadyStatus();
        },
        async getAccountSummary() {
          calls.push(["getAccountSummary"]);
          throw new Error("should not read liquidity after minBalance preflight fails");
        },
        async createJob() {
          calls.push(["createJob"]);
          throw new Error("should not mutate below asset minBalance");
        }
      },
      env: { ADMIN_JWT: "token", PRODUCT_PROOF_REWARD_AMOUNT: "0.069999" },
      log: () => {}
    }),
    /reward below asset minBalance: asset=USDC \(id=1337\) minBalance=70000 base units \(0\.07 USDC\); reward=0\.069999 USDC = 69999 base units/u
  );

  assert.deepEqual(calls.map(([name]) => name), ["getAuthSession", "getAdminStatus"]);
});

test("formatHostedWorkerLoopError includes sanitized API diagnostics", () => {
  const error = new Error("Insufficient liquid balance for USDC");
  error.status = 409;
  error.path = "/jobs/claim";
  error.code = "insufficient_liquidity";
  error.payload = { requestId: "req-123" };
  error.details = {
    operation: "ensureJob",
    account: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
    required: "0.16",
    available: "0.04",
    authorization: "Bearer should-not-print",
    nested: {
      serviceToken: "also-secret"
    }
  };

  const output = formatHostedWorkerLoopError(error);

  assert.match(output, /Insufficient liquid balance for USDC/u);
  assert.match(output, /status=409/u);
  assert.match(output, /path=\/jobs\/claim/u);
  assert.match(output, /code=insufficient_liquidity/u);
  assert.match(output, /requestId=req-123/u);
  assert.match(output, /"operation":"ensureJob"/u);
  assert.match(output, /"required":"0.16"/u);
  assert.doesNotMatch(output, /should-not-print/u);
  assert.doesNotMatch(output, /also-secret/u);
  assert.match(output, /"authorization":"\[redacted\]"/u);
  assert.match(output, /"serviceToken":"\[redacted\]"/u);
});

function accountSummary({
  wallet = "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
  liquidUsdcRaw,
  liquidUsdc = liquidUsdcRaw,
  includeRaw = true
}) {
  const summary = {
    wallet,
    liquid: { USDC: liquidUsdc },
    reserved: { USDC: 0 },
    strategyAllocated: {},
    collateralLocked: {},
    jobStakeLocked: {},
    debtOutstanding: {}
  };
  if (includeRaw) {
    summary.raw = {
      liquid: { USDC: String(liquidUsdcRaw) }
    };
  }
  return summary;
}

function accountPosition({
  wallet = "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
  liquidUsdcRaw,
  liquidUsdc = Number(liquidUsdcRaw) / 1_000_000,
  source = {}
}) {
  return {
    wallet,
    asset: {
      symbol: "USDC",
      address: "0x0000053900000000000000000000000001200000",
      assetClass: "trust_backed",
      assetId: 1337,
      decimals: 6,
      minBalanceRaw: "70000"
    },
    source: {
      contract: "AgentAccountCore",
      address: "0x3333333333333333333333333333333333333333",
      method: "positions",
      field: "liquid",
      ...source
    },
    position: {
      liquid: liquidUsdc,
      liquidRaw: String(liquidUsdcRaw),
      reserved: 0,
      reservedRaw: "0",
      jobStakeLocked: 0,
      jobStakeLockedRaw: "0"
    }
  };
}

function preflightReady({
  jobId,
  wallet = "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
  totalClaimLock = 0
}) {
  return {
    jobId,
    wallet,
    eligible: true,
    claimable: true,
    currentWalletCanClaim: true,
    reason: "claimable",
    requiredOutputSchema: "schema://jobs/product-proof-worker-loop",
    verifierMode: "benchmark",
    totalClaimLock,
    claimEconomicsWaived: true
  };
}

function validationReady({
  jobId,
  schemaRef = "schema://jobs/product-proof-worker-loop"
}) {
  return {
    jobId,
    valid: true,
    schemaRef,
    schemaValidates: "payload.submission",
    submissionKind: "structured"
  };
}

function invalidValidationBlocked({
  jobId,
  schemaRef = "schema://jobs/product-proof-worker-loop"
}) {
  return {
    jobId,
    valid: false,
    submitSafe: false,
    schemaRef,
    schemaValidates: "payload.submission",
    code: "invalid_submission_shape",
    message: "Send the structured proposal object directly as submission, not under submission.output.",
    path: "payload.submission.output",
    details: {
      received: "payload.submission.output",
      hint: "Move the object currently under submission.output up to submission."
    }
  };
}

function validationForSubmission({ jobId, submission }) {
  if (submission?.output?.wrapped_under_submission_output === true) {
    return invalidValidationBlocked({ jobId });
  }
  return validationReady({ jobId });
}

function settlementReadyStatus(overrides = {}) {
  const policyOverrides = overrides.maintenance?.policy ?? overrides;
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
          signerIsSettlementBroker: true,
          escrowIsAgentAccountEscrowOperator: true,
          agentAccountIsOutflowRecorder: true
        },
        signerFunding: signerFundingReady(),
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
            minBalanceRaw: "70000",
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
          ...(policyOverrides.roles ?? {})
        },
        signerFunding: Object.prototype.hasOwnProperty.call(policyOverrides, "signerFunding")
          ? policyOverrides.signerFunding
          : base.maintenance.policy.signerFunding,
        contracts: {
          ...base.maintenance.policy.contracts,
          ...(policyOverrides.contracts ?? {})
        }
      }
    }
  };
}

function signerFundingReady({
  account = "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
  liquidUsdcRaw = "200000",
  liquidUsdc = Number(liquidUsdcRaw) / 1_000_000
} = {}) {
  return {
    account,
    agentAccountAddress: "0x3333333333333333333333333333333333333333",
    assets: [{
      symbol: "USDC",
      address: "0x0000053900000000000000000000000001200000",
      assetClass: "trust_backed",
      assetId: 1337,
      decimals: 6,
      minBalanceRaw: "70000",
      readable: true,
      liquid: liquidUsdc,
      liquidRaw: String(liquidUsdcRaw),
      reserved: 0,
      reservedRaw: "0"
    }]
  };
}

function authSession({
  wallet = "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
  roles = ["admin", "verifier"],
  capabilities = [
    "account:read",
    "admin:status",
    "jobs:create",
    "jobs:preflight",
    "jobs:claim",
    "jobs:submit",
    "verifier:run",
    "session:read"
  ]
} = {}) {
  return { wallet, roles, capabilities };
}

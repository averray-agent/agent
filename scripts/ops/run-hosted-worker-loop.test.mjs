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
    "getAccountSummary",
    "createJob",
    "preflightJob",
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
  assert.equal(calls[5][2].summary, `complete verified output for ${jobId}`);
  assert.deepEqual(calls[6][2], { output: { wrapped_under_submission_output: true } });
  assert.equal(calls[7][2], `product-proof:${jobId}`);
  assert.equal(calls[8][2].status, "complete");

  const written = JSON.parse(await readFile(evidenceFile, "utf8"));
  assert.equal(written.jobId, jobId);
  assert.equal(written.sessionId, sessionId);
  assert.equal(written.verificationOutcome, "approved");
  assert.equal(written.settlementReadiness.settlementReady, true);
  assert.equal(written.rewardReadiness.minBalanceRaw, "70000");
  assert.equal(written.rewardReadiness.rewardRaw, "100000");
  assert.equal(written.liquidityReadiness.requiredRaw, "100000");
  assert.equal(written.liquidityReadiness.availableRaw, "100000");
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
  assert.equal(written.claimReadiness.status, "claimed");
  assert.equal(written.claimReadiness.claimExpiresAt, "2026-01-01T01:00:00.000Z");
  assert.equal(written.submitStatus, "submitted");
});

test("runHostedWorkerLoop fails closed without a token", async () => {
  await assert.rejects(
    runHostedWorkerLoop({ env: {}, log: () => {} }),
    /PRODUCT_PROOF_WORKER_TOKEN, AVERRAY_TOKEN, or ADMIN_JWT is required/u
  );
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
    "validateJobSubmission"
  ]);
  assert.equal(calls[5][1], jobId);
  assert.equal(calls[5][2].status, "complete");
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

function accountSummary({
  wallet = "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
  liquidUsdcRaw
}) {
  return {
    wallet,
    liquid: { USDC: liquidUsdcRaw },
    reserved: { USDC: 0 },
    strategyAllocated: {},
    collateralLocked: {},
    jobStakeLocked: {},
    debtOutstanding: {}
  };
}

function preflightReady({
  jobId,
  wallet = "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519"
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
    totalClaimLock: 0,
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

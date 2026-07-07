import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  runWorkerCanary,
  runSiweStage,
  runAccountStage,
  runClaimStage,
  runSubmitStage,
  runVerifyStage,
  runSettleStage,
  assertOperatorTokenFreshness,
  assertOperatorReady
} from "./run-worker-canary.mjs";

// ── fixtures ──────────────────────────────────────────────────────────────
const WORKER = "0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05";
const CHAIN_JOB_ID = "0xa4b8e4ab00000000000000000000000000000000000000000000000000cb4db0";
const JOB_ID = "worker-canary-test-1";
const FIXED_MS = 1_900_000_000_000;
const REWARD_RAW = 100_000n; // 0.1 USDC, 6 decimals

class FakeApiError extends Error {
  constructor(status, payload) {
    super(payload?.message ?? `api error ${status}`);
    this.status = status;
    this.payload = payload;
  }
}

function makeJwt(expSeconds) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${enc({ alg: "ES256", typ: "JWT" })}.${enc({ sub: WORKER.toLowerCase(), exp: expSeconds })}.sig`;
}

function farFutureOperatorAuth() {
  return { mode: "legacy_admin_jwt", source: "ADMIN_JWT", token: makeJwt(Math.floor(FIXED_MS / 1000) + 30 * 86_400) };
}

function okOperatorClient(overrides = {}) {
  const calls = [];
  return {
    calls,
    async getAuthSession() {
      calls.push(["getAuthSession"]);
      return { roles: ["admin", "verifier"], capabilities: ["jobs:create", "jobs:lifecycle", "verifier:run", "admin:status"] };
    },
    async getAdminStatus() {
      calls.push(["getAdminStatus"]);
      return {
        maintenance: {
          policy: {
            enabled: true,
            settlementReady: true,
            roles: {
              signerIsSettlementBroker: true,
              escrowIsAgentAccountEscrowOperator: true,
              escrowAgentAccountMatchesConfig: true
            },
            contracts: {
              escrowCoreAddress: "0x2222222222222222222222222222222222222222",
              agentAccountAddress: "0x3333333333333333333333333333333333333333",
              escrowCoreAgentAccountAddress: "0x3333333333333333333333333333333333333333"
            },
            signerFunding: {
              agentAccountAddress: "0x3333333333333333333333333333333333333333",
              assets: [{
                symbol: "USDC",
                readable: true,
                liquid: 1,
                liquidRaw: "1000000"
              }]
            }
          }
        }
      };
    },
    async createJob(payload) {
      calls.push(["createJob", payload]);
      return { id: payload.id };
    },
    async runVerifier(sessionId) {
      calls.push(["runVerifier", sessionId]);
      return { outcome: "approved", reasonCode: "benchmark_pass" };
    },
    async request(path, opts) {
      calls.push(["request", path, opts?.body]);
      return { ok: true };
    },
    ...overrides
  };
}

function okWorkerClient(overrides = {}) {
  const calls = [];
  return {
    calls,
    async getAccountSummary() {
      calls.push(["getAccountSummary"]);
      return { wallet: WORKER };
    },
    async preflightJob(jobId) {
      calls.push(["preflightJob", jobId]);
      return { jobId, eligible: true, claimable: true, currentWalletCanClaim: true, claimEconomicsWaived: true, totalClaimLock: 0 };
    },
    async claimJob(jobId, idem) {
      calls.push(["claimJob", jobId, idem]);
      return { sessionId: "sess-1", status: "claimed", chainJobId: CHAIN_JOB_ID };
    },
    async submitWork(sessionId, submission) {
      calls.push(["submitWork", sessionId, submission]);
      return { status: "submitted" };
    },
    async getSession(sessionId) {
      calls.push(["getSession", sessionId]);
      return { status: "resolved", chainJobId: CHAIN_JOB_ID };
    },
    ...overrides
  };
}

function okChainReader(overrides = {}) {
  let snapshots = 0;
  return {
    async getChainId() {
      return 420420417n;
    },
    async snapshotWorker() {
      // First snapshot (before) is empty; later snapshots show the EOA payout.
      snapshots += 1;
      return snapshots === 1 ? { usdcRaw: 0n, aacLiquidRaw: 0n } : { usdcRaw: REWARD_RAW, aacLiquidRaw: 0n };
    },
    async readEscrowJob() {
      return { state: 6, releasedRaw: REWARD_RAW, rewardRaw: REWARD_RAW, worker: WORKER };
    },
    ...overrides
  };
}

function okEnv(overrides = {}) {
  return {
    API_BASE_URL: "https://api.example.test/",
    WORKER_CANARY_PROFILE: "testnet",
    WORKER_CANARY_JOB_ID: JOB_ID,
    WORKER_CANARY_REWARD_AMOUNT: "0.1",
    WORKER_CANARY_SETTLE_TIMEOUT_MS: "1000",
    WORKER_CANARY_SETTLE_POLL_MS: "10",
    ...overrides
  };
}

function runFull(overrides = {}) {
  return runWorkerCanary({
    env: okEnv(overrides.env),
    wallet: { address: WORKER },
    operatorClient: overrides.operatorClient ?? okOperatorClient(),
    operatorAuth: overrides.operatorAuth ?? farFutureOperatorAuth(),
    workerClient: overrides.workerClient ?? okWorkerClient(),
    chainReader: overrides.chainReader ?? okChainReader(),
    now: () => FIXED_MS,
    log: () => {}
  });
}

// ── full-flow integration ───────────────────────────────────────────────────
test("full canary loop walks SIWE→claim→submit→verify→settle and asserts every stage", async () => {
  const operatorClient = okOperatorClient();
  const workerClient = okWorkerClient();
  const evidence = await runFull({ operatorClient, workerClient });

  assert.equal(evidence.proof, "worker-canary");
  assert.equal(evidence.workerWallet, WORKER);
  assert.equal(evidence.jobId, JOB_ID);
  assert.equal(evidence.sessionId, "sess-1");
  assert.equal(evidence.chainJobId, CHAIN_JOB_ID);
  assert.equal(evidence.stages.siwe.mode, "injected");
  assert.equal(evidence.stages.account.status, 200);
  assert.equal(evidence.stages.claim.mechanism, "onboarding_waiver");
  assert.equal(evidence.stages.submit.status, "submitted");
  assert.equal(evidence.stages.verify.outcome, "approved");
  assert.equal(evidence.stages.settle.jobState, "Closed");
  assert.equal(evidence.stages.settle.released, "0.1");
  assert.equal(evidence.stages.settle.creditedRaw, REWARD_RAW.toString());
  assert.equal(evidence.stages.settle.creditedTo, "worker_eoa");
  assert.equal(evidence.stages.tokenFreshness.enforced, true);
  assert.ok(evidence.stages.tokenFreshness.daysToExpiry >= 29);
  assert.equal(evidence.cleanup.jobArchived, true);

  // Identity separation: worker stages NEVER use the operator client and vice versa.
  const workerCalled = workerClient.calls.map(([n]) => n);
  const operatorCalled = operatorClient.calls.map(([n]) => n);
  assert.ok(workerCalled.includes("claimJob") && workerCalled.includes("submitWork"));
  assert.ok(!workerCalled.includes("createJob") && !workerCalled.includes("runVerifier"));
  assert.ok(operatorCalled.includes("createJob") && operatorCalled.includes("runVerifier"));
  assert.ok(!operatorCalled.includes("claimJob") && !operatorCalled.includes("submitWork"));

  // Cleanup archives the disposable job so canary jobs never accumulate.
  const archive = operatorClient.calls.find(([n, path]) => n === "request" && path === "/admin/jobs/lifecycle");
  assert.ok(archive, "expected an /admin/jobs/lifecycle archive call");
  assert.equal(archive[2].action, "archive");
  assert.equal(archive[2].jobId, JOB_ID);
});

test("evidence file is written and sanitized (no tokens or keys)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "worker-canary-"));
  const evidenceFile = join(dir, "evidence.json");
  await runFull({ env: { WORKER_CANARY_EVIDENCE_FILE: evidenceFile } });
  const doc = JSON.parse(await readFile(evidenceFile, "utf8"));
  assert.equal(doc.jobId, JOB_ID);
  const serialized = JSON.stringify(doc);
  assert.ok(!/eyJ|private|signature|Bearer/u.test(serialized), "evidence must not leak tokens/keys");
});

test("a mid-loop failure still archives the disposable job (cleanup finally)", async () => {
  const operatorClient = okOperatorClient();
  const workerClient = okWorkerClient({
    async submitWork() {
      throw new Error("boom mid-loop");
    }
  });
  await assert.rejects(() => runFull({ operatorClient, workerClient }), /boom mid-loop/u);
  const archive = operatorClient.calls.find(([n, path]) => n === "request" && path === "/admin/jobs/lifecycle");
  assert.ok(archive, "stranded canary job must still be archived on failure");
});

test("WORKER_CANARY_KEEP_JOB leaves the job live (no archive)", async () => {
  const operatorClient = okOperatorClient();
  await runFull({ operatorClient, env: { WORKER_CANARY_KEEP_JOB: "1" } });
  const archive = operatorClient.calls.find(([n, path]) => n === "request" && path === "/admin/jobs/lifecycle");
  assert.ok(!archive, "KEEP_JOB must skip archive");
});

// ── chain-env gate (testnet only) ────────────────────────────────────────────
test("chain-env gate: refuses a non-testnet chainId", async () => {
  await assert.rejects(
    () => runFull({ chainReader: okChainReader({ async getChainId() { return 1n; } }) }),
    /not Polkadot Hub TestNet|chain-env gate/u
  );
});

test("chain-env gate: refuses a non-testnet profile before any chain read", async () => {
  await assert.rejects(() => runFull({ env: { WORKER_CANARY_PROFILE: "mainnet" } }), /testnet-only/u);
});

// ── operator readiness ───────────────────────────────────────────────────────
test("operator readiness fails loud if the operator token lacks a required capability", async () => {
  const operatorClient = okOperatorClient({
    async getAuthSession() {
      return { roles: ["admin"], capabilities: ["jobs:create", "jobs:lifecycle", "admin:status"] }; // missing verifier:run
    }
  });
  await assert.rejects(() => runFull({ operatorClient }), /missing capabilities.*verifier:run/u);
});

test("operator readiness fails loud if the escrow service-operator broker is disabled (#627 regressed)", async () => {
  const operatorClient = okOperatorClient({
    async getAdminStatus() {
      return { maintenance: { policy: { enabled: true, settlementReady: true, roles: { signerIsSettlementBroker: false } } } };
    }
  });
  await assert.rejects(() => runFull({ operatorClient }), /settlement broker/u);
});

test("operator readiness accepts the post-#724 signer settlement broker role", async () => {
  const readiness = await assertOperatorReady(okOperatorClient(), {
    rewardRaw: REWARD_RAW,
    rewardAssetSymbol: "USDC"
  });
  assert.equal(readiness.signerIsSettlementBroker, true);
});

test("operator readiness fails before job creation when EscrowCore points at a different AgentAccountCore", async () => {
  const operatorClient = okOperatorClient({
    async getAdminStatus() {
      return {
        maintenance: {
          policy: {
            enabled: true,
            settlementReady: false,
            roles: {
              signerIsSettlementBroker: true,
              escrowIsAgentAccountEscrowOperator: true,
              escrowAgentAccountMatchesConfig: false
            },
            contracts: {
              escrowCoreAddress: "0x2222222222222222222222222222222222222222",
              agentAccountAddress: "0x3333333333333333333333333333333333333333",
              escrowCoreAgentAccountAddress: "0x9999999999999999999999999999999999999999"
            }
          }
        }
      };
    }
  });
  await assert.rejects(() => runFull({ operatorClient }), /EscrowCore\.accounts\(\) does not match/u);
});

test("operator readiness fails before job creation when signer reward bank is short", async () => {
  const operatorPlatform = {
    async getAuthSession() {
      return { roles: ["admin", "verifier"], capabilities: ["jobs:create", "jobs:lifecycle", "verifier:run", "admin:status"] };
    },
    async getAdminStatus() {
      return {
        maintenance: {
          policy: {
            enabled: true,
            settlementReady: true,
            roles: {
              signerIsSettlementBroker: true,
              escrowIsAgentAccountEscrowOperator: true,
              escrowAgentAccountMatchesConfig: true
            },
            signerFunding: {
              agentAccountAddress: "0x3333333333333333333333333333333333333333",
              assets: [{ symbol: "USDC", readable: true, liquid: 0, liquidRaw: "0" }]
            }
          }
        }
      };
    }
  };
  await assert.rejects(
    () => assertOperatorReady(operatorPlatform, { rewardRaw: REWARD_RAW, rewardAssetSymbol: "USDC" }),
    /reward bank is underfunded/u
  );
});

// ── STAGE 1: SIWE (guards #625) ──────────────────────────────────────────────
test("stage 1 SIWE: HTTP 500 on /auth/verify names the #625 roleless-mint regression", async () => {
  const anonClient = {
    async issueNonce() {
      return { message: "siwe-message" };
    },
    async verifySignature() {
      throw new FakeApiError(500, { error: "invalid_configuration" });
    }
  };
  await assert.rejects(
    () => runSiweStage({ wallet: signingWallet(), anonClient }),
    /#625|roleless-wallet SIWE/u
  );
});

test("stage 1 SIWE: a non-empty roles array fails the roleless assertion", async () => {
  const anonClient = {
    async issueNonce() {
      return { message: "siwe-message" };
    },
    async verifySignature() {
      return { token: "a.b.c", roles: ["verifier"] };
    }
  };
  await assert.rejects(() => runSiweStage({ wallet: signingWallet(), anonClient }), /ROLELESS/u);
});

test("stage 1 SIWE: happy path returns a roleless token", async () => {
  const anonClient = {
    async issueNonce() {
      return { message: "siwe-message" };
    },
    async verifySignature() {
      return { token: "a.b.c", roles: [], expiresAt: "2026-06-14T00:00:00.000Z" };
    }
  };
  const result = await runSiweStage({ wallet: signingWallet(), anonClient });
  assert.equal(result.token, "a.b.c");
  assert.equal(result.summary.roleless, true);
});

// ── STAGE 2: account (guards #626) ───────────────────────────────────────────
test("stage 2 account: HTTP 401 claims_mismatch names the #626 sub-casing regression", async () => {
  const authedWorker = {
    async getAccountSummary() {
      throw new FakeApiError(401, { error: "claims_mismatch" });
    }
  };
  await assert.rejects(() => runAccountStage({ authedWorker, workerAddress: WORKER }), /#626|sub-casing/u);
});

test("stage 2 account: happy path returns 200", async () => {
  const authedWorker = { async getAccountSummary() { return { wallet: WORKER }; } };
  const out = await runAccountStage({ authedWorker, workerAddress: WORKER });
  assert.equal(out.status, 200);
});

// ── STAGE 3: claim (guards claim 409 + claimJobFor) ──────────────────────────
test("stage 3 claim: a 409 from /jobs/claim names the claim-funding class", async () => {
  const authedWorker = {
    async preflightJob(jobId) {
      return { jobId, eligible: true, claimable: true, currentWalletCanClaim: true, claimEconomicsWaived: true, totalClaimLock: 0 };
    },
    async claimJob() {
      throw new FakeApiError(409, { error: "insufficient_liquidity" });
    }
  };
  await assert.rejects(
    () => runClaimStage({ authedWorker, jobId: JOB_ID, workerAddress: WORKER, idempotencyKey: "k", before: { aacLiquidRaw: 0n } }),
    /409 class|claim-funding/u
  );
});

test("stage 3 claim: ensureJob blockchain_revert names canary job funding/setup diagnostics", async () => {
  const authedWorker = {
    async preflightJob(jobId) {
      return { jobId, eligible: true, claimable: true, currentWalletCanClaim: true, claimEconomicsWaived: true, totalClaimLock: 0 };
    },
    async claimJob() {
      throw new FakeApiError(409, { error: "blockchain_revert", message: "ensureJob failed: require(false)" });
    }
  };
  await assert.rejects(
    () => runClaimStage({ authedWorker, jobId: JOB_ID, workerAddress: WORKER, idempotencyKey: "k", before: { aacLiquidRaw: 0n } }),
    /funding\/setup|EscrowCore\.accounts\(\)|ensureJob/u
  );
});

test("stage 3 claim: waiver exhausted AND worker underfunded fails before claiming (would-409)", async () => {
  const authedWorker = {
    async preflightJob(jobId) {
      return { jobId, eligible: true, claimable: true, currentWalletCanClaim: true, claimEconomicsWaived: false, totalClaimLock: "0.05" };
    },
    async claimJob() {
      throw new Error("should not reach claim");
    }
  };
  await assert.rejects(
    () => runClaimStage({ authedWorker, jobId: JOB_ID, workerAddress: WORKER, idempotencyKey: "k", before: { aacLiquidRaw: 0n } }),
    /WOULD 409|insufficient_liquidity/u
  );
});

test("stage 3 claim: prefunded path is accepted when the worker covers the lock", async () => {
  const authedWorker = {
    async preflightJob(jobId) {
      return { jobId, eligible: true, claimable: true, currentWalletCanClaim: true, claimEconomicsWaived: false, totalClaimLock: "0.05" };
    },
    async claimJob() {
      return { sessionId: "sess-1", status: "claimed" };
    }
  };
  const out = await runClaimStage({
    authedWorker,
    jobId: JOB_ID,
    workerAddress: WORKER,
    idempotencyKey: "k",
    before: { aacLiquidRaw: 100_000n }
  });
  assert.equal(out.summary.mechanism, "prefunded");
});

test("stage 3 claim: non-claimable preflight fails loud", async () => {
  const authedWorker = {
    async preflightJob(jobId) {
      return { jobId, eligible: false, claimable: false, currentWalletCanClaim: false, reason: "unfunded" };
    }
  };
  await assert.rejects(
    () => runClaimStage({ authedWorker, jobId: JOB_ID, workerAddress: WORKER, idempotencyKey: "k", before: { aacLiquidRaw: 0n } }),
    /cannot claim/u
  );
});

// ── STAGE 4: submit (guards #627) ────────────────────────────────────────────
test("stage 4 submit: an on-chain revert names the #627 submitWorkFor regression", async () => {
  const authedWorker = {
    async submitWork() {
      throw new FakeApiError(500, { error: "blockchain_revert", message: "execution reverted" });
    }
  };
  await assert.rejects(
    () => runSubmitStage({ authedWorker, sessionId: "s", jobId: JOB_ID, timestamp: FIXED_MS }),
    /#627|submitWorkFor/u
  );
});

test("stage 4 submit: a non-submitted status fails", async () => {
  const authedWorker = { async submitWork() { return { status: "rejected" }; } };
  await assert.rejects(
    () => runSubmitStage({ authedWorker, sessionId: "s", jobId: JOB_ID, timestamp: FIXED_MS }),
    /expected status "submitted"/u
  );
});

test("stage 4 submit: status submitted but reverted chainStatus still fails", async () => {
  const authedWorker = { async submitWork() { return { status: "submitted", chainStatus: "reverted" }; } };
  await assert.rejects(
    () => runSubmitStage({ authedWorker, sessionId: "s", jobId: JOB_ID, timestamp: FIXED_MS }),
    /did not land on-chain|#627/u
  );
});

// ── STAGE 5: verify ──────────────────────────────────────────────────────────
test("stage 5 verify: a non-approved operator verdict fails loud", async () => {
  const operatorPlatform = { async runVerifier() { return { outcome: "rejected", reasonCode: "keyword_miss" }; } };
  await assert.rejects(
    () => runVerifyStage({ operatorPlatform, authedWorker: {}, sessionId: "s", mode: "operator" }),
    /expected "approved"/u
  );
});

test("stage 5 verify: auto mode passes when the public result is approved (no-op once auto-verify lands)", async () => {
  const authedWorker = { async getVerifierResult() { return { outcome: "approved" }; } };
  const out = await runVerifyStage({ operatorPlatform: {}, authedWorker, sessionId: "s", mode: "auto" });
  assert.equal(out.summary.mode, "auto");
  assert.equal(out.summary.outcome, "approved");
});

// ── STAGE 6: settle ──────────────────────────────────────────────────────────
const settleArgs = (overrides = {}) => ({
  authedWorker: { async getSession() { return { status: "resolved" }; } },
  sessionId: "s",
  chainJobId: CHAIN_JOB_ID,
  workerAddress: WORKER,
  before: { usdcRaw: 0n, aacLiquidRaw: 0n },
  rewardRaw: REWARD_RAW,
  settleTimeoutMs: 40,
  settlePollMs: 10,
  now: () => Date.now(),
  log: () => {},
  ...overrides
});

test("stage 6 settle: a job that never closes fails loud", async () => {
  const reader = {
    async readEscrowJob() { return { state: 3, releasedRaw: 0n, rewardRaw: REWARD_RAW, worker: WORKER }; },
    async snapshotWorker() { return { usdcRaw: 0n, aacLiquidRaw: 0n }; }
  };
  await assert.rejects(() => runSettleStage(settleArgs({ reader })), /not "Closed"|settlement-stall/u);
});

test("stage 6 settle: released != reward fails", async () => {
  const reader = {
    async readEscrowJob() { return { state: 6, releasedRaw: 50_000n, rewardRaw: REWARD_RAW, worker: WORKER }; },
    async snapshotWorker() { return { usdcRaw: REWARD_RAW, aacLiquidRaw: 0n }; }
  };
  await assert.rejects(() => runSettleStage(settleArgs({ reader })), /released .* but reward was/u);
});

test("stage 6 settle: the worker balance not rising by the reward fails (checks EOA AND AAC)", async () => {
  const reader = {
    async readEscrowJob() { return { state: 6, releasedRaw: REWARD_RAW, rewardRaw: REWARD_RAW, worker: WORKER }; },
    async snapshotWorker() { return { usdcRaw: 0n, aacLiquidRaw: 0n }; } // never credited
  };
  await assert.rejects(() => runSettleStage(settleArgs({ reader })), /did not rise|never reached the worker/u);
});

test("stage 6 settle: payout credited into the AAC liquid position passes", async () => {
  // `before` is supplied via settleArgs (zeros); runSettleStage takes only the
  // "after" snapshot — here the reward landed in AAC.liquid rather than the EOA.
  const reader = {
    async readEscrowJob() { return { state: 6, releasedRaw: REWARD_RAW, rewardRaw: REWARD_RAW, worker: WORKER }; },
    async snapshotWorker() { return { usdcRaw: 0n, aacLiquidRaw: REWARD_RAW }; }
  };
  const out = await runSettleStage(settleArgs({ reader }));
  assert.equal(out.summary.creditedTo, "aac_liquid");
});

// ── STAGE 7: operator token freshness (guards #628) ──────────────────────────
test("stage 7 freshness: a legacy ADMIN_JWT within N days of expiry fails loud (#628)", () => {
  const expSoon = Math.floor(FIXED_MS / 1000) + 3 * 86_400; // 3 days
  assert.throws(
    () => assertOperatorTokenFreshness({ operatorAuth: { mode: "legacy_admin_jwt", token: makeJwt(expSoon) }, minDays: 7, now: () => FIXED_MS }),
    /#628|expires in/u
  );
});

test("stage 7 freshness: a legacy ADMIN_JWT with no exp claim fails loud", () => {
  const noExp = `${Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: WORKER })).toString("base64url")}.sig`;
  assert.throws(
    () => assertOperatorTokenFreshness({ operatorAuth: { mode: "legacy_admin_jwt", token: noExp }, minDays: 7, now: () => FIXED_MS }),
    /no `exp` claim|#628/u
  );
});

test("stage 7 freshness: a far-future legacy ADMIN_JWT is enforced and passes", () => {
  const out = assertOperatorTokenFreshness({ operatorAuth: farFutureOperatorAuth(), minDays: 7, now: () => FIXED_MS });
  assert.equal(out.enforced, true);
  assert.ok(out.daysToExpiry >= 29);
});

test("stage 7 freshness: a short-lived refresh-minted operator token is a no-op (self-rotating)", () => {
  const shortExp = Math.floor(FIXED_MS / 1000) + 600; // 10 minutes
  const out = assertOperatorTokenFreshness({ operatorAuth: { mode: "admin_refresh", token: makeJwt(shortExp) }, minDays: 7, now: () => FIXED_MS });
  assert.equal(out.enforced, false);
});

// ── helpers ──────────────────────────────────────────────────────────────────
function signingWallet() {
  return { address: WORKER, async signMessage() { return "0xsignature"; } };
}

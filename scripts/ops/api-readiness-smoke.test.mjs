import assert from "node:assert/strict";
import test from "node:test";

import {
  runApiReadinessSmoke,
  runPreflightStage,
  runFundingStage
} from "./api-readiness-smoke.mjs";

const WORKER = "0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05";

class FakeApiError extends Error {
  constructor(status, payload) {
    super(payload?.message ?? `api error ${status}`);
    this.status = status;
    this.payload = payload;
  }
}

// A fresh roleless wallet stand-in: address + EIP-191 signMessage.
function fakeWallet(address = WORKER) {
  return {
    address,
    async signMessage(message) {
      return `0xsig:${Buffer.from(String(message)).toString("hex").slice(0, 8)}`;
    }
  };
}

function fakeAnonClient({ verifyImpl } = {}) {
  return {
    async issueNonce(wallet) {
      return { message: `siwe-message-for-${wallet}` };
    },
    async verifySignature(message, signature) {
      if (verifyImpl) return verifyImpl(message, signature);
      return { token: "h.e.s", roles: [], expiresAt: "2027-01-01T00:00:00Z" };
    }
  };
}

function fakeWorker({ account = { wallet: WORKER }, claimable, preflight } = {}) {
  return {
    calls: [],
    async getAccountSummary() {
      return account;
    },
    async listClaimableJobs() {
      return claimable ?? { jobs: [{ id: "job-ready-1" }] };
    },
    async preflightJob(jobId) {
      // The real endpoint always echoes the requested jobId; force it so a
      // custom fixture only overrides the readiness fields, never the id.
      const base = {
        jobId,
        eligible: true,
        claimable: true,
        currentWalletCanClaim: true,
        fundingState: "funded",
        claimEconomicsWaived: true,
        totalClaimLock: "0.05"
      };
      return preflight ? { ...base, ...preflight, jobId } : base;
    }
  };
}

function silent() {}

test("worker-tier happy path: SIWE → account → preflight, funding skipped (no admin creds)", async () => {
  const result = await runApiReadinessSmoke({
    env: {},
    workerWallet: fakeWallet(),
    anonClient: fakeAnonClient(),
    authedWorker: fakeWorker(),
    log: silent
  });
  assert.equal(result.ok, true);
  assert.equal(result.stages.siwe.ok, true);
  assert.equal(result.stages.siwe.roleless, true);
  assert.equal(result.stages.account.ok, true);
  assert.equal(result.stages.preflight.ok, true);
  assert.equal(result.stages.preflight.jobId, "job-ready-1");
  assert.equal(result.stages.funding.skipped, true, "funding tier is skipped without an admin credential");
});

test("operator tier: /admin/status settlement-ready makes funding pass", async () => {
  const result = await runApiReadinessSmoke({
    env: {},
    workerWallet: fakeWallet(),
    anonClient: fakeAnonClient(),
    authedWorker: fakeWorker(),
    operatorAuth: { token: "admin.jwt.sig" },
    operatorClient: {
      async getAdminStatus() {
        return {
          maintenance: {
            policy: {
              enabled: true,
              settlementReady: true,
              roles: { escrowIsServiceOperator: true },
              signerFunding: { usdcRaw: "3300000" }
            }
          }
        };
      }
    },
    log: silent
  });
  assert.equal(result.ok, true);
  assert.equal(result.stages.funding.ok, true);
  assert.equal(result.stages.funding.escrowIsServiceOperator, true);
});

test("preflight surfaces a funding-pending job as not-ready (the claim-409 class)", async () => {
  const result = await runApiReadinessSmoke({
    env: {},
    workerWallet: fakeWallet(),
    anonClient: fakeAnonClient(),
    authedWorker: fakeWorker({
      claimable: { jobs: [{ id: "job-pending-1" }] },
      preflight: {
        eligible: true,
        claimable: false,
        currentWalletCanClaim: null,
        fundingState: "pending",
        reason: "reward_funding_pending"
      }
    }),
    log: silent
  });
  assert.equal(result.ok, false);
  assert.equal(result.stages.preflight.ok, false);
  assert.equal(result.stages.preflight.reason, "reward_funding_pending");
});

test("operator tier flags settlementReady=false (today's signer-liquidity failure mode)", async () => {
  const funding = await runFundingStage({
    operatorClient: {
      async getAdminStatus() {
        return { maintenance: { policy: { enabled: true, settlementReady: false, signerFunding: { usdcRaw: "0" } } } };
      }
    }
  });
  assert.equal(funding.ok, false);
  assert.equal(funding.reason, "settlement_not_ready");
});

test("SIWE 500 surfaces the #625 roleless-mint regression and fails the probe", async () => {
  await assert.rejects(
    () =>
      runApiReadinessSmoke({
        env: {},
        workerWallet: fakeWallet(),
        anonClient: fakeAnonClient({
          verifyImpl: () => {
            throw new FakeApiError(500, { message: "boom" });
          }
        }),
        authedWorker: fakeWorker(),
        log: silent
      }),
    /625/
  );
});

test("an empty board reports no_claimable_job rather than passing blind", async () => {
  const preflight = await runPreflightStage({
    authedWorker: { async listClaimableJobs() { return { jobs: [] }; } },
    explicitJobId: undefined,
    log: silent
  });
  assert.equal(preflight.ok, false);
  assert.equal(preflight.reason, "no_claimable_job");
});

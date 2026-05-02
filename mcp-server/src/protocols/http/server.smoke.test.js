import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Wallet } from "ethers";

import { signToken } from "../../auth/jwt.js";

// Smoke-level integration tests for the HTTP adapter. These start the real
// server in a child process with a deterministic env, then exercise the
// auth/authorization/rate-limit boundaries we rely on in production. They
// complement the unit tests in src/auth/*.test.js which cover the underlying
// primitives in isolation.
//
// Skipped by default because subprocess boot is slower than the pure-unit
// tests. Run with `RUN_HTTP_SMOKE=1 npm test` when you want the full loop.

const RUN = process.env.RUN_HTTP_SMOKE === "1";
const moduleDir = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(moduleDir, "server.js");
const LONG_SECRET = "x".repeat(40);
const ADMIN_WALLET = "0x1111111111111111111111111111111111111111";
const VERIFIER_WALLET = "0x2222222222222222222222222222222222222222";
const STRANGER_WALLET = "0x3333333333333333333333333333333333333333";

async function startServer(port, envOverrides = {}) {
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      AUTH_MODE: "strict",
      AUTH_JWT_SECRETS: LONG_SECRET,
      AUTH_DOMAIN: "smoke.test",
      AUTH_CHAIN_ID: "1",
      AUTH_ADMIN_WALLETS: ADMIN_WALLET,
      AUTH_VERIFIER_WALLETS: VERIFIER_WALLET,
      STATE_STORE_ALLOW_MEMORY: "1",
      LOG_LEVEL: "silent",
      RATE_LIMIT_AUTH_NONCE_LIMIT: "3",
      RATE_LIMIT_AUTH_NONCE_WINDOW_SECONDS: "60",
      ...envOverrides
    },
    stdio: "ignore",
    detached: false
  });

  // Poll the health endpoint until it responds or we time out. More robust
  // than parsing child stdout, which may buffer in unpredictable ways across
  // Node versions.
  const deadline = Date.now() + 10_000;
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error("server exited before listening");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500)
      });
      if (response.status === 200 || response.status === 503) {
        return child;
      }
    } catch {
      // Not yet ready — retry after a short sleep.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  child.kill("SIGKILL");
  throw new Error("server boot timeout");
}

function stop(child) {
  return new Promise((resolveStopped) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveStopped(undefined);
      return;
    }
    child.once("exit", () => resolveStopped(undefined));
    // SIGTERM first, SIGKILL as a safety net in case the server swallows it.
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 1_000).unref();
  });
}

function issueToken(wallet, { roles = [] } = {}) {
  return signToken({ sub: wallet, roles }, { secret: LONG_SECRET, expiresInSeconds: 60 }).token;
}

async function runWithServer(fn) {
  const port = 19_000 + Math.floor(Math.random() * 1_000);
  const child = await startServer(port);
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await stop(child);
  }
}

async function runWithServerEnv(envOverrides, fn) {
  const port = 19_000 + Math.floor(Math.random() * 1_000);
  const child = await startServer(port, envOverrides);
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await stop(child);
  }
}

test("http smoke: /admin/jobs rejects unauthenticated requests", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const response = await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "x", category: "coding", tier: "starter", rewardAmount: 1, verifierMode: "benchmark" })
    });
    assert.equal(response.status, 401);
  });
});

test("http smoke: /admin/jobs rejects non-admin token", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const token = issueToken(STRANGER_WALLET, { roles: [] });
    const response = await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: "x", category: "coding", tier: "starter", rewardAmount: 1, verifierMode: "benchmark" })
    });
    assert.equal(response.status, 403);
    const payload = await response.json();
    assert.equal(payload.error, "missing_role");
  });
});

test("http smoke: /admin/jobs accepts admin-scoped token", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const token = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const response = await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: "smoke-admin-1",
        category: "coding",
        tier: "starter",
        rewardAmount: 1,
        verifierMode: "benchmark",
        verifierTerms: ["complete"],
        verifierMinimumMatches: 1,
        outputSchemaRef: "schema://jobs/smoke-output"
      })
    });
    assert.equal(response.status, 201);
  });
});

test("http smoke: /admin/sessions exposes operator-wide session activity", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const workerToken = issueToken(STRANGER_WALLET);

    await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: "operator-session-smoke-001",
        category: "coding",
        tier: "starter",
        rewardAmount: 1,
        claimTtlSeconds: 3600,
        verifierMode: "benchmark",
        verifierTerms: ["complete"],
        verifierMinimumMatches: 1,
        outputSchemaRef: "schema://jobs/operator-session-smoke-output"
      })
    });

    await fetch(`${base}/account/fund?asset=DOT&amount=10`, {
      method: "POST",
      headers: { authorization: `Bearer ${workerToken}` }
    });

    const claim = await fetch(
      `${base}/jobs/claim?jobId=operator-session-smoke-001&idempotencyKey=operator-session-smoke-claim`,
      { method: "POST", headers: { authorization: `Bearer ${workerToken}` } }
    );
    assert.equal(claim.status, 200);
    const claimed = await claim.json();

    const walletScoped = await fetch(`${base}/sessions`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    assert.equal(walletScoped.status, 200);
    assert.deepEqual(await walletScoped.json(), []);

    const forbidden = await fetch(`${base}/admin/sessions`, {
      headers: { authorization: `Bearer ${workerToken}` }
    });
    assert.equal(forbidden.status, 403);

    const response = await fetch(`${base}/admin/sessions?limit=20`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.scope, "operator");
    assert.equal(payload.count, 1);
    assert.equal(payload.sessions[0].sessionId, claimed.sessionId);
    assert.equal(payload.sessions[0].wallet, STRANGER_WALLET);
    assert.equal(payload.sessions[0].jobId, "operator-session-smoke-001");
  });
});

test("http smoke: /admin/status returns recurring + maintenance data for admin tokens", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const token = issueToken(ADMIN_WALLET, { roles: ["admin"] });

    await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: "weekly-digest",
        category: "coding",
        tier: "starter",
        rewardAmount: 2,
        verifierMode: "benchmark",
        verifierTerms: ["complete"],
        verifierMinimumMatches: 1,
        recurring: true,
        schedule: { cron: "0 9 * * 1" }
      })
    });

    const response = await fetch(`${base}/admin/status`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.recurring.count, 1);
    assert.equal(payload.recurring.templates[0].templateId, "weekly-digest");
    assert.equal(typeof payload.maintenance.release.checklistDoc, "string");
  });
});

test("http smoke: async XCM allocation requires admin role until assembler ships", { skip: !RUN }, async () => {
  const asyncStrategyId = "0x56444f545f56315f4d4f434b0000000000000000000000000000000000000000";
  await runWithServerEnv(
    {
      STRATEGIES_JSON: JSON.stringify([
        {
          strategyId: asyncStrategyId,
          adapter: "0x1234567890123456789012345678901234567890",
          kind: "polkadot_vdot",
          executionMode: "async_xcm",
          asset: "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD"
        }
      ])
    },
    async (base) => {
      const token = issueToken(STRANGER_WALLET, { roles: [] });
      const response = await fetch(`${base}/account/allocate`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ strategyId: asyncStrategyId, amount: 1 })
      });
      assert.equal(response.status, 403);
      const payload = await response.json();
      assert.equal(payload.error, "async_xcm_admin_required");
    }
  );
});

test("http smoke: async XCM deallocation requires admin role until assembler ships", { skip: !RUN }, async () => {
  const asyncStrategyId = "0x56444f545f56315f4d4f434b0000000000000000000000000000000000000000";
  await runWithServerEnv(
    {
      STRATEGIES_JSON: JSON.stringify([
        {
          strategyId: asyncStrategyId,
          adapter: "0x1234567890123456789012345678901234567890",
          kind: "polkadot_vdot",
          executionMode: "async_xcm",
          asset: "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD"
        }
      ])
    },
    async (base) => {
      const token = issueToken(STRANGER_WALLET, { roles: [] });
      const response = await fetch(`${base}/account/deallocate`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ strategyId: asyncStrategyId, amount: 1 })
      });
      assert.equal(response.status, 403);
      const payload = await response.json();
      assert.equal(payload.error, "async_xcm_admin_required");
    }
  );
});

test("http smoke: async XCM routes reject caller-supplied raw message bytes", { skip: !RUN }, async () => {
  const asyncStrategyId = "0x56444f545f56315f4d4f434b0000000000000000000000000000000000000000";
  await runWithServerEnv(
    {
      STRATEGIES_JSON: JSON.stringify([
        {
          strategyId: asyncStrategyId,
          adapter: "0x1234567890123456789012345678901234567890",
          kind: "polkadot_vdot",
          executionMode: "async_xcm",
          asset: "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD"
        }
      ])
    },
    async (base) => {
      const token = issueToken(ADMIN_WALLET, { roles: ["admin"] });
      const response = await fetch(`${base}/account/allocate`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ strategyId: asyncStrategyId, amount: 1, message: "0xdeadbeef" })
      });
      assert.equal(response.status, 400);
      const payload = await response.json();
      assert.equal(payload.error, "invalid_request");
      assert.match(payload.message, /message is assembled by the server/u);
    }
  );
});

test("http smoke: /auth/nonce returns 429 once the window limit is crossed", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const body = JSON.stringify({ wallet: Wallet.createRandom().address });
    const headers = { "content-type": "application/json" };
    const first = await fetch(`${base}/auth/nonce`, { method: "POST", headers, body });
    assert.equal(first.status, 200);
    // Bucket limit was set to 3 in startServer; confirm the 4th call is rejected.
    await fetch(`${base}/auth/nonce`, { method: "POST", headers, body });
    await fetch(`${base}/auth/nonce`, { method: "POST", headers, body });
    const rateLimited = await fetch(`${base}/auth/nonce`, { method: "POST", headers, body });
    assert.equal(rateLimited.status, 429);
    assert.ok(rateLimited.headers.get("retry-after"));
  });
});

test("http smoke: OPTIONS preflight returns CORS headers only for allowed origins", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const response = await fetch(`${base}/jobs`, {
      method: "OPTIONS",
      headers: { origin: "https://not-allowed.example" }
    });
    // With CORS_ALLOWED_ORIGINS unset, no origin is echoed back.
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });
});

test("http smoke: /auth/logout revokes the current token", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const token = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const authHeader = { authorization: `Bearer ${token}` };

    // Token works before logout.
    const preLogout = await fetch(`${base}/account`, { headers: authHeader });
    assert.equal(preLogout.status, 200);

    const logout = await fetch(`${base}/auth/logout`, { method: "POST", headers: authHeader });
    assert.equal(logout.status, 200);
    const payload = await logout.json();
    assert.equal(payload.status, "logged_out");

    // Same token now rejected with token_revoked.
    const postLogout = await fetch(`${base}/account`, { headers: authHeader });
    assert.equal(postLogout.status, 401);
    const errBody = await postLogout.json();
    assert.equal(errBody.error, "token_revoked");
  });
});

test("http smoke: /account/borrow-capacity returns the signed-in wallet headroom", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const token = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const response = await fetch(`${base}/account/borrow-capacity?asset=DOT`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.wallet, ADMIN_WALLET.toLowerCase());
    assert.equal(payload.asset, "DOT");
    assert.equal(payload.borrowCapacity, 0);
  });
});

test("http smoke: /badges/:sessionId returns 404 for unknown sessions", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const response = await fetch(`${base}/badges/unknown-session-id`);
    assert.equal(response.status, 404);
    const payload = await response.json();
    assert.equal(payload.status, "not_found");
  });
});

test("http smoke: /badges/:sessionId returns schema-compliant JSON for approved sessions", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const verifierToken = issueToken(VERIFIER_WALLET, { roles: ["verifier"] });

    // 1. Create a job so the worker has something to claim.
    const createJob = await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: "badge-smoke-job-001",
        category: "coding",
        tier: "starter",
        rewardAmount: 3,
        verifierMode: "benchmark",
        verifierTerms: ["complete", "verified", "output"],
        verifierMinimumMatches: 2,
        outputSchemaRef: "schema://jobs/badge-smoke"
      })
    });
    assert.equal(createJob.status, 201);

    // 2. Fund the admin wallet so there's enough liquid balance to cover
    //    the claim stake (5% of 3 DOT = 0.15 DOT).
    const fund = await fetch(
      `${base}/account/fund?asset=DOT&amount=10`,
      { method: "POST", headers: { authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(fund.status, 200);

    // 3. Claim with the admin wallet (acts as worker here for simplicity).
    const claim = await fetch(
      `${base}/jobs/claim?jobId=badge-smoke-job-001&idempotencyKey=badge-smoke-claim`,
      { method: "POST", headers: { authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(claim.status, 200);
    const { sessionId } = await claim.json();

    // 3. Submit evidence that matches the benchmark terms.
    const submit = await fetch(
      `${base}/jobs/submit?sessionId=${encodeURIComponent(sessionId)}&evidence=${encodeURIComponent("complete verified output bundle")}`,
      { method: "POST", headers: { authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(submit.status, 200);

    // 4. Run verification — approves the session.
    const verify = await fetch(
      `${base}/verifier/run?sessionId=${encodeURIComponent(sessionId)}&evidence=${encodeURIComponent("complete verified output bundle")}`,
      { method: "POST", headers: { authorization: `Bearer ${verifierToken}` } }
    );
    assert.equal(verify.status, 200);

    // 5. Fetch the badge. Public — no auth header required.
    const badgeResponse = await fetch(`${base}/badges/${encodeURIComponent(sessionId)}`);
    assert.equal(badgeResponse.status, 200);
    const badge = await badgeResponse.json();
    assert.equal(badge.averray.schemaVersion, "v1");
    assert.equal(badge.averray.sessionId, sessionId);
    assert.equal(badge.averray.category, "coding");
    assert.equal(badge.averray.verifierMode, "benchmark");
    assert.match(badge.averray.chainJobId, /^0x[a-fA-F0-9]{64}$/);
    assert.match(badge.averray.evidenceHash, /^0x[a-fA-F0-9]{64}$/);
    assert.ok(Array.isArray(badge.attributes) && badge.attributes.length >= 3);

    const listResponse = await fetch(`${base}/badges`);
    assert.equal(listResponse.status, 200);
    const receipts = await listResponse.json();
    assert.ok(receipts.some((receipt) => receipt.sessionId === sessionId));
  });
});

test("http smoke: /agents/:wallet returns a v1 profile for a fresh wallet", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    // A never-seen wallet still gets a zero-state profile rather than 404.
    const freshWallet = "0xCa11Cafe00000000000000000000000000000001";
    const response = await fetch(`${base}/agents/${freshWallet}`);
    assert.equal(response.status, 200);
    const profile = await response.json();
    assert.equal(profile.schemaVersion, "v1");
    assert.equal(profile.wallet, freshWallet.toLowerCase());
    assert.equal(profile.stats.totalBadges, 0);
    assert.equal(profile.stats.completionRate, null);
    assert.deepEqual(profile.badges, []);
  });
});

test("http smoke: /agents/:wallet aggregates approved sessions into badges", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const verifierToken = issueToken(VERIFIER_WALLET, { roles: ["verifier"] });

    // Seed a job + full claim→submit→verify cycle so the profile has data.
    await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: "profile-smoke-job-001",
        category: "coding",
        tier: "starter",
        rewardAmount: 4,
        verifierMode: "benchmark",
        verifierTerms: ["complete", "verified", "output"],
        verifierMinimumMatches: 2,
        outputSchemaRef: "schema://jobs/profile-smoke"
      })
    });

    await fetch(`${base}/account/fund?asset=DOT&amount=10`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` }
    });

    const claim = await fetch(
      `${base}/jobs/claim?jobId=profile-smoke-job-001&idempotencyKey=profile-smoke-claim`,
      { method: "POST", headers: { authorization: `Bearer ${adminToken}` } }
    );
    const { sessionId } = await claim.json();

    await fetch(
      `${base}/jobs/submit?sessionId=${encodeURIComponent(sessionId)}&evidence=${encodeURIComponent("complete verified output bundle")}`,
      { method: "POST", headers: { authorization: `Bearer ${adminToken}` } }
    );

    await fetch(
      `${base}/verifier/run?sessionId=${encodeURIComponent(sessionId)}&evidence=${encodeURIComponent("complete verified output bundle")}`,
      { method: "POST", headers: { authorization: `Bearer ${verifierToken}` } }
    );

    const response = await fetch(`${base}/agents/${ADMIN_WALLET}`);
    assert.equal(response.status, 200);
    const profile = await response.json();
    assert.equal(profile.wallet, ADMIN_WALLET.toLowerCase());
    assert.equal(profile.stats.totalBadges, 1);
    assert.equal(profile.stats.approvedCount, 1);
    assert.equal(profile.stats.rejectedCount, 0);
    assert.equal(profile.stats.completionRate, 1);
    // 4 DOT at 18 decimals = 4 * 10^18 base units
    assert.equal(profile.stats.totalEarned.amount, "4000000000000000000");
    assert.equal(profile.badges[0].sessionId, sessionId);
    assert.equal(profile.badges[0].category, "coding");
    assert.equal(profile.badges[0].level, 1);
    assert.deepEqual(profile.categoryLevels, { coding: 1 });

    const listResponse = await fetch(`${base}/agents`);
    assert.equal(listResponse.status, 200);
    const agents = await listResponse.json();
    const row = agents.find((agent) => agent.wallet === ADMIN_WALLET.toLowerCase());
    assert.ok(row);
    assert.equal(row.tier, "apprentice");
    assert.equal(row.totalJobs, 1);
  });
});

test("http smoke: /agents exposes a claimed session as current activity", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });

    const createJob = await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: "profile-active-smoke-job-001",
        category: "coding",
        tier: "starter",
        rewardAmount: 4,
        claimTtlSeconds: 3600,
        verifierMode: "benchmark",
        verifierTerms: ["complete", "verified", "output"],
        verifierMinimumMatches: 2,
        outputSchemaRef: "schema://jobs/profile-active-smoke"
      })
    });
    assert.equal(createJob.status, 201);

    await fetch(`${base}/account/fund?asset=DOT&amount=10`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` }
    });

    const claim = await fetch(
      `${base}/jobs/claim?jobId=profile-active-smoke-job-001&idempotencyKey=profile-active-smoke-claim`,
      { method: "POST", headers: { authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(claim.status, 200);
    const { sessionId } = await claim.json();

    const response = await fetch(`${base}/agents/${ADMIN_WALLET}`);
    assert.equal(response.status, 200);
    const profile = await response.json();
    assert.equal(profile.stats.totalBadges, 0);
    assert.equal(profile.stats.completionRate, null);
    assert.deepEqual(profile.badges, []);
    assert.equal(profile.currentActivity.sessionId, sessionId);
    assert.equal(profile.currentActivity.jobId, "profile-active-smoke-job-001");
    assert.equal(profile.currentActivity.status, "claimed");
    assert.equal(profile.currentActivity.phase, "work");
    assert.equal(profile.currentActivity.canSubmit, true);
    assert.equal(profile.currentActivity.awaitingVerification, false);
    assert.match(profile.currentActivity.deadlineAt, /^\d{4}-\d{2}-\d{2}T/u);

    const listResponse = await fetch(`${base}/agents`);
    assert.equal(listResponse.status, 200);
    const agents = await listResponse.json();
    const row = agents.find((agent) => agent.wallet === ADMIN_WALLET.toLowerCase());
    assert.ok(row);
    assert.equal(row.totalJobs, 0);
    assert.equal(row.currentActivity.sessionId, sessionId);
    assert.equal(row.currentActivity.status, "claimed");
  });
});

test("http smoke: /disputes exposes human-review sessions and records verdict/release receipts", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const verifierToken = issueToken(VERIFIER_WALLET, { roles: ["verifier"] });

    await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: "dispute-smoke-job-001",
        category: "coding",
        tier: "starter",
        rewardAmount: 3,
        verifierMode: "human_fallback",
        escalationMessage: "Needs operator review",
        autoApprove: false,
        outputSchemaRef: "schema://jobs/dispute-smoke"
      })
    });

    await fetch(`${base}/account/fund?asset=DOT&amount=10`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` }
    });

    const claim = await fetch(
      `${base}/jobs/claim?jobId=dispute-smoke-job-001&idempotencyKey=dispute-smoke-claim`,
      { method: "POST", headers: { authorization: `Bearer ${adminToken}` } }
    );
    const { sessionId } = await claim.json();

    await fetch(
      `${base}/jobs/submit?sessionId=${encodeURIComponent(sessionId)}&evidence=${encodeURIComponent("needs review")}`,
      { method: "POST", headers: { authorization: `Bearer ${adminToken}` } }
    );

    await fetch(`${base}/verifier/run?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${verifierToken}` }
    });

    const list = await fetch(`${base}/disputes`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    assert.equal(list.status, 200);
    const disputes = await list.json();
    const dispute = disputes.find((entry) => entry.sessionId === sessionId);
    assert.ok(dispute);
    assert.equal(dispute.status, "open");
    assert.equal(dispute.verdict, null);

    const detail = await fetch(`${base}/disputes/${encodeURIComponent(dispute.id)}`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).sessionId, sessionId);

    const verdict = await fetch(`${base}/disputes/${encodeURIComponent(dispute.id)}/verdict`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${verifierToken}` },
      body: JSON.stringify({ verdict: "upheld", rationale: "Submission needs correction." })
    });
    assert.equal(verdict.status, 200);
    const verdictBody = await verdict.json();
    assert.equal(verdictBody.status, "resolved");
    assert.equal(verdictBody.verdict, "upheld");
    assert.match(verdictBody.reasoningHash, /^0x[a-f0-9]{64}$/u);
    assert.equal(verdictBody.metadataURI, `urn:averray:content:${verdictBody.reasoningHash}`);

    const privateContent = await fetch(`${base}/content/${encodeURIComponent(verdictBody.reasoningHash)}`);
    assert.equal(privateContent.status, 403);

    const ownedContent = await fetch(`${base}/content/${encodeURIComponent(verdictBody.reasoningHash)}`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    assert.equal(ownedContent.status, 200);
    const contentBody = await ownedContent.json();
    assert.equal(contentBody.hash, verdictBody.reasoningHash);
    assert.equal(contentBody.contentType, "arbitrator_reasoning");
    assert.equal(contentBody.visibility, "owner_only");
    assert.equal(contentBody.payload.rationale, "Submission needs correction.");

    const strangerToken = issueToken("0x3333333333333333333333333333333333333333");
    const forbiddenPublish = await fetch(`${base}/content/${encodeURIComponent(verdictBody.reasoningHash)}/publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${strangerToken}` }
    });
    assert.equal(forbiddenPublish.status, 403);

    const published = await fetch(`${base}/content/${encodeURIComponent(verdictBody.reasoningHash)}/publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` }
    });
    assert.equal(published.status, 200);
    const publishedBody = await published.json();
    assert.equal(publishedBody.visibility, "public");
    assert.deepEqual(publishedBody.disclosureEvent, { emitted: false, reason: "blockchain_disabled" });
    assert.match(publishedBody.publishedAt, /^\d{4}-\d{2}-\d{2}T/u);

    const publicContent = await fetch(`${base}/content/${encodeURIComponent(verdictBody.reasoningHash)}`);
    assert.equal(publicContent.status, 200);
    const publicContentBody = await publicContent.json();
    assert.equal(publicContentBody.visibility, "public");
    assert.deepEqual(publicContentBody.autoDisclosureEvent, { emitted: false, reason: "not_auto_public" });

    const release = await fetch(`${base}/disputes/${encodeURIComponent(dispute.id)}/release`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ action: "release", amount: 0.15 })
    });
    assert.equal(release.status, 200);
    const releaseBody = await release.json();
    assert.equal(releaseBody.release.action, "release");
    assert.equal(releaseBody.release.amount, 0.15);
  });
});

test("http smoke: operator policy, alert, and audit endpoints are available", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const authHeader = { authorization: `Bearer ${adminToken}` };

    const policiesResponse = await fetch(`${base}/policies`, { headers: authHeader });
    assert.equal(policiesResponse.status, 200);
    const policies = await policiesResponse.json();
    assert.ok(Array.isArray(policies));
    assert.ok(policies.length >= 1);
    assert.ok(policies[0].tag);
    assert.ok(Array.isArray(policies[0].approvals));

    const policyResponse = await fetch(`${base}/policies/${encodeURIComponent(policies[0].tag)}`, {
      headers: authHeader
    });
    assert.equal(policyResponse.status, 200);
    const policy = await policyResponse.json();
    assert.equal(policy.tag, policies[0].tag);

    const proposalResponse = await fetch(`${base}/policies`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader },
      body: JSON.stringify({
        tag: "claim/test-policy@v1",
        title: "Test policy",
        currentBody: "{ \"kind\": \"claim.test\" }"
      })
    });
    assert.equal(proposalResponse.status, 201);
    const proposal = await proposalResponse.json();
    assert.equal(proposal.tag, "claim/test-policy@v1");
    assert.equal(proposal.state, "Pending");

    const auditResponse = await fetch(`${base}/audit`, { headers: authHeader });
    assert.equal(auditResponse.status, 200);
    const audit = await auditResponse.json();
    assert.ok(Array.isArray(audit));
    assert.ok(audit.some((event) => event.category === "policy"));

    const alertsResponse = await fetch(`${base}/alerts`, { headers: authHeader });
    assert.equal(alertsResponse.status, 200);
    const alerts = await alertsResponse.json();
    assert.ok(Array.isArray(alerts));
    assert.ok(alerts.some((alert) => alert.ctaHref === "/policies"));
  });
});

test("http smoke: /agents/:wallet rejects non-address path segments", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const response = await fetch(`${base}/agents/not-a-wallet`);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "invalid_request");
  });
});

test("http smoke: /payments/send moves liquid balance between agent accounts", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const senderToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });

    // Fund the sender wallet so there's something to send.
    const fund = await fetch(`${base}/account/fund?asset=DOT&amount=20`, {
      method: "POST",
      headers: { authorization: `Bearer ${senderToken}` }
    });
    assert.equal(fund.status, 200);

    const response = await fetch(`${base}/payments/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${senderToken}`
      },
      body: JSON.stringify({ recipient: VERIFIER_WALLET, asset: "DOT", amount: 5 })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "sent");
    assert.equal(body.asset, "DOT");
    assert.equal(body.amount, 5);
    assert.equal(body.balances.from.liquid.DOT, 15);
    assert.equal(body.balances.to.liquid.DOT, 5);
  });
});

test("http smoke: /payments/send rejects self-transfer", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const token = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const response = await fetch(`${base}/payments/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ recipient: ADMIN_WALLET, asset: "DOT", amount: 1 })
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "invalid_request");
  });
});

test("http smoke: /strategies defaults to empty when STRATEGIES_JSON is unset", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const response = await fetch(`${base}/strategies`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.strategies, []);
    assert.ok(typeof body.docs === "string" && body.docs.includes("vdot"));
  });
});

test("http smoke: /jobs/tiers returns the public tier ladder without auth", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const response = await fetch(`${base}/jobs/tiers`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.tiers));
    const byTier = Object.fromEntries(body.tiers.map((entry) => [entry.tier, entry.requires]));
    assert.deepEqual(byTier.starter, { skill: 0 });
    assert.deepEqual(byTier.pro, { skill: 100 });
    assert.deepEqual(byTier.elite, { skill: 200 });
  });
});

test("http smoke: /jobs/recommendations includes per-job tierGate with missing-skill gap", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });

    // Post a pro-tier job. A fresh wallet (skill=0) should see it locked.
    await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: "tier-smoke-pro-001",
        category: "coding",
        tier: "pro",
        rewardAmount: 8,
        verifierMode: "benchmark",
        verifierTerms: ["complete", "verified"],
        verifierMinimumMatches: 1,
        outputSchemaRef: "schema://jobs/tier-smoke"
      })
    });

    const response = await fetch(`${base}/jobs/recommendations`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    assert.equal(response.status, 200);
    const recs = await response.json();
    const proJob = recs.find((entry) => entry.jobId === "tier-smoke-pro-001");
    assert.ok(proJob, "expected the pro job in recommendations");
    assert.equal(proJob.tier, "pro");
    assert.equal(proJob.tierGate.tier, "pro");
    assert.equal(proJob.tierGate.unlocked, false);
    assert.deepEqual(proJob.tierGate.missing, { skill: 100 });
    assert.match(proJob.explanation, /tier locked — earn 100 more skill/);
  });
});

test("http smoke: /admin/jobs/fire produces a derivative from a recurring template", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });

    // 1. Post a recurring template.
    const template = await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: "recurring-smoke-digest",
        category: "coding",
        tier: "starter",
        rewardAmount: 2,
        verifierMode: "benchmark",
        verifierTerms: ["complete"],
        verifierMinimumMatches: 1,
        recurring: true,
        schedule: { cron: "0 9 * * 1", timezone: "Europe/Zurich" }
      })
    });
    assert.equal(template.status, 201);

    // 2. Fire one instance.
    const fireResponse = await fetch(`${base}/admin/jobs/fire`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        templateId: "recurring-smoke-digest",
        firedAt: "2026-04-20T09:00:00.000Z"
      })
    });
    assert.equal(fireResponse.status, 201);
    const derivative = await fireResponse.json();
    assert.equal(derivative.templateId, "recurring-smoke-digest");
    assert.equal(derivative.recurring, false);
    assert.match(derivative.id, /^recurring-smoke-digest-run-/);
  });
});

test("http smoke: /admin/jobs rejects recurring template with missing schedule", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const response = await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: "bad-recurring-job",
        category: "coding",
        tier: "starter",
        rewardAmount: 1,
        verifierMode: "benchmark",
        verifierTerms: ["complete"],
        verifierMinimumMatches: 1,
        recurring: true
      })
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "invalid_request");
    assert.match(body.message, /schedule/);
  });
});

test("http smoke: /metrics emits Prometheus text format with baseline series", { skip: !RUN }, async () => {
  await runWithServer(async (base) => {
    // Warm the metrics: one unauthenticated admin call to populate counters.
    await fetch(`${base}/admin/jobs`, { method: "POST" }).catch(() => undefined);

    const response = await fetch(`${base}/metrics`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
    const body = await response.text();
    assert.match(body, /# HELP http_requests_total/);
    assert.match(body, /# TYPE http_requests_total counter/);
    assert.match(body, /http_requests_total\{method="POST",path="\/admin\/jobs",status="401"\}/);
    assert.match(body, /state_store_backend\{backend="MemoryStateStore"\} 1/);
  });
});

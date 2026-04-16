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

async function startServer(port) {
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
      RATE_LIMIT_AUTH_NONCE_WINDOW_SECONDS: "60"
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

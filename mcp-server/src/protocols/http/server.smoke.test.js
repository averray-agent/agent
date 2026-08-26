import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Wallet } from "ethers";

import { signToken } from "../../auth/jwt.js";
import {
  LEGACY_MCP_VERSION,
  MODERN_MCP_VERSION,
  SUPPORTED_MCP_VERSIONS
} from "../mcp/handler.js";

// Smoke-level integration tests for the HTTP adapter. These start the real
// server in a child process with a deterministic env, then exercise the
// auth/authorization/rate-limit boundaries we rely on in production. They
// complement the unit tests in src/auth/*.test.js which cover the underlying
// primitives in isolation.
//
// Skipped inside the pure-unit phase because subprocess boot is slower. The
// package's standard `npm test` runs a second CI-parity phase with this flag on.

const RUN = process.env.RUN_HTTP_SMOKE === "1";

// Shared options for every test below. The timeout is set here, per test,
// rather than as a CLI --test-timeout: on Node 22 that flag also bounds the
// synthetic whole-file test, whose duration is the SUM of all subtests — each
// one boots its own server child (~1s, boot-dominated), so the file-level
// bound trips as the suite grows even with every subtest green. 15s bounds a
// single test: startServer's boot poll gives up at 10s and a healthy test
// finishes in ~1s, so only a genuine hang can cross it.
const SMOKE_TEST_OPTIONS = { skip: !RUN, timeout: 15_000 };
const moduleDir = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(moduleDir, "server.js");
const LONG_SECRET = "x".repeat(40);
const ADMIN_WALLET = "0x1111111111111111111111111111111111111111";
const VERIFIER_WALLET = "0x2222222222222222222222222222222222222222";
const STRANGER_WALLET = "0x3333333333333333333333333333333333333333";
const VIEWER_WALLET = "0x4444444444444444444444444444444444444444";
const TRANSFER_AUTHORIZATION = {
  nonce: "42",
  deadline: "2000000000",
  signature: `0x${"1".repeat(130)}`
};
const OPEN_DATA_INGEST_TARGET = {
  portal: "data.gov",
  datasetId: "provider-idempotency-dataset",
  datasetTitle: "Provider idempotency smoke dataset",
  datasetUrl: "https://catalog.data.gov/dataset/provider-idempotency-smoke",
  resourceId: "provider-idempotency-resource",
  resourceTitle: "Provider idempotency CSV",
  resourceUrl: "https://example.gov/provider-idempotency.csv",
  resourceFormat: "CSV",
  agency: "General Services Administration",
  license: "CC0",
  modified: "2026-01-01T00:00:00Z",
  metadataModified: "2026-05-01T00:00:00Z"
};

// Every server child that is still alive. A test that hits its per-test
// timeout never reaches the finally that stops its server, and the leaked
// child's stderr pipe would keep this process alive long after the run —
// the sweep below reaps whatever the tests themselves did not.
const liveChildren = new Set();

after(() => {
  for (const child of liveChildren) child.kill("SIGKILL");
});

async function startServer(port, envOverrides = {}) {
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      AUTH_MODE: "strict",
      // The harness signs its own HS256 tokens from AUTH_JWT_SECRETS, so it names
      // the HMAC backend rather than inheriting a default. Strict mode defaults to
      // kms, which would (correctly) refuse to boot without any KMS configuration.
      JWT_BACKEND: "hmac",
      AUTH_JWT_SECRETS: LONG_SECRET,
      AUTH_DOMAIN: "smoke.test",
      AUTH_CHAIN_ID: "1",
      AUTH_ADMIN_WALLETS: ADMIN_WALLET,
      AUTH_VERIFIER_WALLETS: VERIFIER_WALLET,
      OPERATOR_VIEWER_WALLETS: VIEWER_WALLET,
      STATE_STORE_ALLOW_MEMORY: "1",
      LOG_LEVEL: "silent",
      RATE_LIMIT_AUTH_NONCE_LIMIT: "3",
      RATE_LIMIT_AUTH_NONCE_WINDOW_SECONDS: "60",
      // Route smoke fixtures intentionally use synthetic 3–8 USDC jobs. Keep
      // this suite focused on HTTP/auth behavior; worker-exposure tests pin the
      // production open-cap and rolling 1.50-USDC defaults plus their refusal
      // and serialization boundaries.
      WORKER_OPEN_EXPOSURE_CAP_USDC: "100",
      WORKER_DAILY_EXPOSURE_BUDGET_RAW: "1000000000",
      WORKER_LIFETIME_CATALOGUE_CREDIT_RAW: "1000000000",
      WORKER_CATALOGUE_GLOBAL_DAILY_BUDGET_RAW: "1000000000",
      ...envOverrides
    },
    // stderr is piped purely so a boot failure can say WHY. A bad env used to
    // surface as 51 identical "server exited before listening" lines with the
    // actual ConfigError discarded, which is a long way to walk to find a typo.
    // stdout stays ignored — the health poll below is the readiness signal.
    stdio: ["ignore", "ignore", "pipe"],
    detached: false
  });
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    // Bounded: a crash loop must not accumulate output without limit.
    if (stderr.length < 4000) stderr += chunk;
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
      const detail = stderr.trim();
      throw new Error(
        detail ? `server exited before listening: ${detail}` : "server exited before listening"
      );
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

function issueToken(wallet, { roles = [], ...claims } = {}) {
  return signToken({ sub: wallet, roles, ...claims }, { secret: LONG_SECRET, expiresInSeconds: 60 }).token;
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

test("http smoke: Verify returns every named request violation in one response", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const response = await fetch(`${base}/verify/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profile: "git-patch-tests-v1",
        profileVersion: 1,
        target: {},
        inputs: { testCommand: ["npm", "test"] }
      })
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error, "invalid_request");
    assert.deepEqual(
      payload.details.violations.map(({ path }) => path),
      [
        "verifyRequest.target.repository",
        "verifyRequest.target.commit",
        "verifyRequest.inputs.gitBundle",
        "verifyRequest.inputs.patch"
      ]
    );
  });
});

test("http smoke: production active money-like routes require a chain backend", SMOKE_TEST_OPTIONS, async () => {
  await runWithServerEnv({
    NODE_ENV: "production",
    BADGE_RECEIPT_SIGNING: "disabled",
    MUTATION_BACKEND: "required"
  }, async (base) => {
    const token = issueToken(ADMIN_WALLET);
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    };
    const routes = [
      ["/account/fund", { asset: "DOT", amount: 1 }],
      ["/account/borrow", { asset: "DOT", amount: 1 }],
      ["/account/repay", { asset: "DOT", amount: 1 }]
    ];

    for (const [path, body] of routes) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 503, path);
      const payload = await response.json();
      assert.equal(payload.error, "chain_backend_required", path);
      assert.equal(payload.reason, "blockchain gateway is disabled", path);
      assert.equal(payload.details.mode, "required", path);
      assert.equal(payload.details.route, path);
    }

    const paymentResponse = await fetch(`${base}/payments/send`, {
      method: "POST",
      headers,
      body: JSON.stringify({ recipient: VERIFIER_WALLET, asset: "DOT", amount: 1, transferAuthorization: TRANSFER_AUTHORIZATION })
    });
    assert.equal(paymentResponse.status, 503);
    const payment = await paymentResponse.json();
    assert.equal(payment.reason, "payments_send_disabled");
    assert.equal(payment.see.withdrawal.http.path, "/account/withdraw/transactions");
    assert.equal(payment.see.withdrawal.mcp.tool, "buildWithdrawTransactions");
  });
});

test("http smoke: /health separates service liveness from treasury capability", SMOKE_TEST_OPTIONS, async () => {
  await runWithServerEnv({
    NODE_ENV: "production",
    BADGE_RECEIPT_SIGNING: "disabled",
    MUTATION_BACKEND: "required"
  }, async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.status, "ok");
    assert.equal(payload.serviceHealth.ok, true);
    assert.equal(payload.capabilityHealth.blockchain, "disabled");
    assert.equal(payload.capabilityHealth.treasuryMutations, "unavailable");
    assert.equal(payload.capabilityHealth.xcmObserver, "unavailable");
    assert.equal(payload.capabilityHealth.indexer, "unavailable");
    assert.equal(payload.components.blockchain.enabled, false);
    // Structured warnings: operator dashboards / smoke checks match on
    // `code` rather than parsing prose. Treasury unavailable on a
    // production / chain-required posture must be `critical`.
    assert.ok(Array.isArray(payload.warnings), "warnings must be an array");
    const treasury = payload.warnings.find((w) => w.code === "treasury_mutations_unavailable");
    assert.ok(treasury, "treasury_mutations_unavailable warning must be present");
    assert.equal(treasury.severity, "critical");
    const blockchain = payload.warnings.find((w) => w.code === "blockchain_disabled");
    assert.ok(blockchain);
    assert.equal(blockchain.severity, "warning");
  });
});

test("http smoke: active sync money-like routes replay idempotent receipts", SMOKE_TEST_OPTIONS, async () => {
  await runWithServerEnv({ PAYMENTS_SEND_ENABLED: "1" }, async (base) => {
    const token = issueToken(ADMIN_WALLET);
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    };
    const postJson = async (path, body) => {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      });
      const payload = await response.json();
      return { response, payload };
    };

    const fundBody = { asset: "DOT", amount: 10, idempotencyKey: "money-fund-1" };
    const firstFund = await postJson("/account/fund", fundBody);
    assert.equal(firstFund.response.status, 200);
    assert.equal(firstFund.payload.liquid.DOT, 10);
    const replayFund = await postJson("/account/fund", fundBody);
    assert.equal(replayFund.response.status, 200);
    assert.deepEqual(replayFund.payload, firstFund.payload);
    const fundConflict = await postJson("/account/fund", { ...fundBody, amount: 11 });
    assert.equal(fundConflict.response.status, 409);
    assert.equal(fundConflict.payload.error, "idempotency_key_payload_mismatch");

    const transferBody = {
      recipient: VERIFIER_WALLET,
      asset: "DOT",
      amount: 2,
      transferAuthorization: TRANSFER_AUTHORIZATION,
      idempotencyKey: "money-transfer-1"
    };
    const firstTransfer = await postJson("/payments/send", transferBody);
    assert.equal(firstTransfer.response.status, 200);
    assert.equal(firstTransfer.payload.status, "sent");
    assert.equal(firstTransfer.payload.balances.from.liquid.DOT, 8);
    assert.equal(firstTransfer.payload.balances.to.liquid.DOT, 2);
    const replayTransfer = await postJson("/payments/send", transferBody);
    assert.equal(replayTransfer.response.status, 200);
    assert.deepEqual(replayTransfer.payload, firstTransfer.payload);

    const account = await fetch(`${base}/account`, { headers });
    assert.equal(account.status, 200);
    const finalAccount = await account.json();
    assert.equal(finalAccount.liquid.DOT, 8);
  });
});

test("http smoke: /admin/jobs rejects unauthenticated requests", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const response = await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "x", category: "coding", tier: "starter", rewardAmount: 1, verifierMode: "benchmark" })
    });
    assert.equal(response.status, 401);
  });
});

test("http smoke: /admin/jobs rejects non-admin token", SMOKE_TEST_OPTIONS, async () => {
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

test("http smoke: /admin/jobs accepts admin-scoped token", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const token = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const response = await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: "smoke-admin-1",
        lane: "benchmark-showcase",
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

test("http smoke: /jobs/validate-submission validates draft output before claim", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const token = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const jobId = "smoke-schema-validation-001";
    const create = await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: jobId,
        lane: "benchmark-showcase",
        category: "coding",
        tier: "starter",
        rewardAmount: 1,
        verifierMode: "benchmark",
        verifierTerms: ["complete"],
        verifierMinimumMatches: 1,
        outputSchemaRef: "schema://jobs/coding-output"
      })
    });
    assert.equal(create.status, 201);

    const valid = await fetch(`${base}/jobs/validate-submission`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobId,
        submission: {
          summary: "Complete.",
          output: "complete verified output",
          status: "complete"
        }
      })
    });
    assert.equal(valid.status, 200);
    const validPayload = await valid.json();
    assert.equal(validPayload.valid, true);
    assert.equal(validPayload.submitSafe, true);
    assert.equal(validPayload.validationEndpoint, "POST /jobs/validate-submission");

    const invalid = await fetch(`${base}/jobs/validate-submission`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId, submission: "complete" })
    });
    assert.equal(invalid.status, 200);
    const payload = await invalid.json();
    assert.equal(payload.valid, false);
    assert.equal(payload.submitSafe, false);
    assert.equal(payload.schemaValidates, "payload.submission");
    assert.equal(payload.path, "payload.submission.summary");
  });
});

test("http smoke: /admin/jobs/timeline exposes job lineage", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const token = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const jobId = "smoke-job-timeline-001";
    const create = await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: jobId,
        lane: "benchmark-showcase",
        category: "coding",
        tier: "starter",
        rewardAmount: 1,
        verifierMode: "benchmark",
        verifierTerms: ["complete"],
        verifierMinimumMatches: 1,
        outputSchemaRef: "schema://jobs/smoke-output"
      })
    });
    assert.equal(create.status, 201);

    const response = await fetch(`${base}/admin/jobs/timeline?jobId=${jobId}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.timelineVersion, "v2");
    assert.equal(payload.job.id, jobId);
    assert.deepEqual(payload.lineage.sessionIds, []);
    assert.ok(payload.timeline.some((entry) => entry.type === "job_state"));
  });
});

test("http smoke: /admin/sessions exposes operator-wide session activity", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const workerToken = issueToken(STRANGER_WALLET);

    await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: "operator-session-smoke-001",
        lane: "benchmark-showcase",
        category: "coding",
        tier: "starter",
        rewardAmount: 1,
        claimTtlSeconds: 3600,
        onboardingWaiverEligible: true,
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

test("http smoke: viewer JWT reads every operator surface without mutation authority", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const token = issueToken(VIEWER_WALLET, { roles: ["viewer"] });
    const headers = { authorization: `Bearer ${token}` };
    const readPaths = [
      "/admin/status",
      "/admin/jobs",
      "/admin/sessions?limit=20",
      "/badges",
      "/agents?includeSynthetic=true",
      "/admin/treasury/summary",
      "/alerts",
      "/audit",
      "/policies",
      "/admin/capability-grants?limit=20"
    ];

    for (const path of readPaths) {
      const response = await fetch(`${base}${path}`, { headers });
      assert.equal(response.status, 200, `${path} must be viewer-readable`);
    }

    const session = await fetch(`${base}/auth/session`, { headers });
    assert.equal(session.status, 200);
    const issued = await session.json();
    assert.deepEqual(issued.roles, ["viewer"]);
    assert.ok(issued.capabilities.includes("ops:view"));
    assert.equal(issued.capabilities.includes("jobs:claim"), false);
    assert.equal(issued.capabilities.includes("jobs:lifecycle"), false);
  });
});

test("http smoke: viewer JWT denies POST-shaped operator mutations with the standard capability envelope", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const token = issueToken(VIEWER_WALLET, { roles: ["viewer"] });
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    };
    const mutations = [
      ["/admin/jobs/pause", { templateId: "viewer-must-not-pause" }],
      ["/policies", { tag: "VIEWER-MUST-NOT-PROPOSE" }],
      ["/disputes/missing/verdict", { verdict: "upheld" }],
      ["/admin/arrivals/canary-marker", { wallet: VIEWER_WALLET }],
      ["/account/fund", { asset: "DOT", amount: 1 }]
    ];

    for (const [path, body] of mutations) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 403, `${path} must remain denied`);
      const payload = await response.json();
      assert.equal(payload.error, "missing_capability");
      assert.equal(payload.details.denialReason, "viewer_read_only");
    }
  });
});

test("http smoke: admin arrival and journey reads are operator-only and expose cutover guardrails", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    for (const path of ["/admin/arrivals/timeline", "/admin/worker-journeys"]) {
      const unauthenticated = await fetch(`${base}${path}`);
      assert.equal(unauthenticated.status, 401);
    }

    const timelineResponse = await fetch(`${base}/admin/arrivals/timeline?window=48h`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    assert.equal(timelineResponse.status, 200);
    const timeline = await timelineResponse.json();
    assert.equal(timeline.window.bucket, "hour");
    assert.equal(timeline.window.backfilled, false);
    assert.ok(Number.isFinite(Date.parse(timeline.collectionSince)));
    assert.equal(timeline.privacy.containsWallets, false);

    const journeysResponse = await fetch(`${base}/admin/worker-journeys?limit=5`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    assert.equal(journeysResponse.status, 200);
    const journeys = await journeysResponse.json();
    assert.equal(journeys.scope, "operator");
    assert.equal(journeys.window.backfilled, false);
    assert.ok(Number.isFinite(Date.parse(journeys.collectionSince)));
  });
});

test("http smoke: /jobs/sub lets active workers create funded child jobs", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const workerToken = issueToken(STRANGER_WALLET);

    await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: "subjob-parent-smoke-001",
        lane: "oss-anchored",
        category: "coding",
        tier: "starter",
        rewardAmount: 5,
        claimTtlSeconds: 3600,
        verifierMode: "benchmark",
        verifierTerms: ["complete"],
        verifierMinimumMatches: 1,
        outputSchemaRef: "schema://jobs/subjob-parent-smoke-output",
        delegationPolicy: { budgetAmount: 3, budgetAsset: "USDC", maxSubJobs: 2, maxDepth: 1 }
      })
    });

    await fetch(`${base}/account/fund?asset=USDC&amount=10`, {
      method: "POST",
      headers: { authorization: `Bearer ${workerToken}` }
    });

    const claim = await fetch(
      `${base}/jobs/claim?jobId=subjob-parent-smoke-001&idempotencyKey=subjob-parent-smoke-claim`,
      { method: "POST", headers: { authorization: `Bearer ${workerToken}` } }
    );
    assert.equal(claim.status, 200);
    const parentSession = await claim.json();

    const create = await fetch(`${base}/jobs/sub`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${workerToken}` },
      body: JSON.stringify({
        parentSessionId: parentSession.sessionId,
        id: "subjob-child-smoke-001",
        category: "review",
        tier: "starter",
        rewardAmount: 2,
        verifierMode: "benchmark",
        verifierTerms: ["summary"],
        verifierMinimumMatches: 1,
        inputSchemaRef: "schema://jobs/review-input",
        outputSchemaRef: "schema://jobs/pr-review-findings-output",
        claimTtlSeconds: 1800,
        retryLimit: 1,
        requiresSponsoredGas: true
      })
    });
    assert.equal(create.status, 201);
    const child = await create.json();
    assert.equal(child.parentSessionId, parentSession.sessionId);
    assert.equal(child.lineage.kind, "sub_job");
    assert.equal(child.lineage.budget.remainingAfterAmount, 1);

    const listing = await fetch(`${base}/jobs/sub?parentSessionId=${encodeURIComponent(parentSession.sessionId)}`, {
      headers: { authorization: `Bearer ${workerToken}` }
    });
    assert.equal(listing.status, 200);
    const subJobs = await listing.json();
    assert.equal(subJobs.length, 1);
    assert.equal(subJobs[0].id, "subjob-child-smoke-001");

    const account = await fetch(`${base}/account`, {
      headers: { authorization: `Bearer ${workerToken}` }
    });
    const balances = await account.json();
    assert.equal(balances.reserved.USDC, 2);
  });
});

test("http smoke: /admin/status returns recurring + maintenance data for admin tokens", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const token = issueToken(ADMIN_WALLET, { roles: ["admin"] });

    await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: "weekly-digest",
        lane: "benchmark-showcase",
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

test("http smoke: /admin/treasury/summary stays available when live feeds warn", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const token = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const response = await fetch(`${base}/admin/treasury/summary`, {
      headers: { authorization: `Bearer ${token}` }
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.wallet, ADMIN_WALLET.toLowerCase());
    assert.equal(typeof payload.asOf, "string");
    assert.equal(Array.isArray(payload.warnings), true);
    assert.equal(typeof payload.creditLine.available, "boolean");
    assert.equal(typeof payload.strategyLanes.available, "boolean");
    assert.equal(typeof payload.xcmObserver.available, "boolean");
    assert.equal(typeof payload.policyGate.available, "boolean");
  });
});

test("http smoke: static retired notice needs no auth, leaks nothing, and is outside money-like classification", SMOKE_TEST_OPTIONS, async () => {
  const asyncStrategyId = "0x56444f545f56315f4d4f434b0000000000000000000000000000000000000000";
  await runWithServerEnv(
    {
      NODE_ENV: "production",
      BADGE_RECEIPT_SIGNING: "disabled",
      MUTATION_BACKEND: "required",
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
      const retiredRoutes = [
        { method: "POST", path: "/account/allocate" },
        { method: "POST", path: "/account/deallocate" },
        { method: "GET", path: "/account/strategies" }
      ];
      for (const { method, path } of retiredRoutes) {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(method === "POST"
            ? { body: JSON.stringify({ strategyId: asyncStrategyId, amount: 1, message: "0xdeadbeef" }) }
            : {})
        });
        assert.equal(response.status, 410, path);
        const payload = await response.json();
        assert.equal(payload.status, "retired", path);
        assert.equal(payload.retired, true, path);
        assert.deepEqual(payload.strategies, [], path);
        assert.equal(payload.see.pool, "/pool", path);
        assert.equal(payload.see.onboarding, "/onboarding#buildVestedCapacity", path);
      }
    }
  );
});

test("http smoke: admin XCM observation idempotency guards payload drift", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const token = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const requestId = `0x${"ab".repeat(32)}`;
    const payload = {
      requestId,
      wrapperAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status: "succeeded",
      settledAssets: 5,
      settledShares: 5,
      remoteRef: `0x${"12".repeat(32)}`,
      observedAt: "2026-05-14T12:00:00.000Z",
      idempotencyKey: "observe-same-key"
    };

    const observe = await fetch(`${base}/admin/xcm/observe`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    assert.equal(observe.status, 200);
    const observed = await observe.json();
    assert.equal(observed.requestId, requestId);

    const replay = await fetch(`${base}/admin/xcm/observe`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        status: "succeeded",
        wrapperAddress: payload.wrapperAddress,
        settledAssets: 5,
        settledShares: 5,
        remoteRef: `0x${"12".repeat(32)}`,
        observedAt: "2026-05-14T12:00:00.000Z",
        requestId,
        idempotencyKey: "observe-same-key"
      })
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), observed);

    const drift = await fetch(`${base}/admin/xcm/observe`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...payload,
        settledAssets: 6
      })
    });
    assert.equal(drift.status, 409);
    const body = await drift.json();
    assert.equal(body.error, "idempotency_key_payload_mismatch");
    assert.equal(body.details.bucket, "admin_xcm_observe");
    assert.ok(body.details.originalRequestHash);
    assert.ok(body.details.requestHash);
  });
});

test("http smoke: /auth/nonce returns 429 once the window limit is crossed", SMOKE_TEST_OPTIONS, async () => {
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

test("http smoke: OPTIONS preflight returns CORS headers only for allowed origins", SMOKE_TEST_OPTIONS, async () => {
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

test("http smoke: public MCP supports HEAD and wildcard credential-free CORS", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const [get, head, preflight] = await Promise.all([
      fetch(`${base}/mcp`),
      fetch(`${base}/mcp`, { method: "HEAD" }),
      fetch(`${base}/mcp`, {
        method: "OPTIONS",
        headers: {
          origin: "https://unlisted-client.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "Authorization, Content-Type, Mcp-Method, Mcp-Session-Id"
        }
      })
    ]);

    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    for (const header of ["content-type", "cache-control", "access-control-allow-origin"]) {
      assert.equal(head.headers.get(header), get.headers.get(header), `${header} must match GET /mcp`);
    }

    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
    for (const method of ["POST", "GET", "OPTIONS"]) {
      assert.match(preflight.headers.get("access-control-allow-methods"), new RegExp(method, "u"));
    }
    for (const header of ["Mcp-Session-Id", "Mcp-Method", "Content-Type", "Authorization"]) {
      assert.match(preflight.headers.get("access-control-allow-headers"), new RegExp(header, "iu"));
    }
    assert.equal(preflight.headers.get("access-control-expose-headers"), "Mcp-Session-Id");
  });
});

test("http smoke: /auth/logout revokes the current token", SMOKE_TEST_OPTIONS, async () => {
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

test("http smoke: /auth/refresh rotates the wallet token and revokes the old jti", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const oldToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const oldHeader = { authorization: `Bearer ${oldToken}` };

    // Old token works before refresh.
    const preRefresh = await fetch(`${base}/account`, { headers: oldHeader });
    assert.equal(preRefresh.status, 200);

    const refresh = await fetch(`${base}/auth/refresh`, { method: "POST", headers: oldHeader });
    assert.equal(refresh.status, 200);
    const payload = await refresh.json();
    assert.equal(payload.tokenType, "Bearer");
    assert.equal(String(payload.wallet).toLowerCase(), ADMIN_WALLET.toLowerCase());
    assert.deepEqual(payload.roles, ["admin"]);
    assert.ok(typeof payload.token === "string" && payload.token.length > 0);
    assert.notEqual(payload.token, oldToken, "refresh must mint a new token, not echo the old one");
    assert.ok(typeof payload.rotatedFromJti === "string" && payload.rotatedFromJti.length > 0);
    assert.ok(typeof payload.expiresAt === "string" && !Number.isNaN(Date.parse(payload.expiresAt)));

    // Old token rejected with token_revoked.
    const postRefreshOld = await fetch(`${base}/account`, { headers: oldHeader });
    assert.equal(postRefreshOld.status, 401);
    const oldErr = await postRefreshOld.json();
    assert.equal(oldErr.error, "token_revoked");

    // New token works on the same protected route.
    const newHeader = { authorization: `Bearer ${payload.token}` };
    const postRefreshNew = await fetch(`${base}/account`, { headers: newHeader });
    assert.equal(postRefreshNew.status, 200);
  });
});

test("http smoke: /auth/refresh rejects service tokens with service_token_refresh_unsupported", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    // Mint a service-style token directly (mirrors what /admin/service-tokens issues).
    const serviceToken = issueToken(ADMIN_WALLET, {
      roles: ["admin"],
      tokenKind: "service",
      serviceToken: true,
      capabilityGrantId: "test-grant"
    });

    const refresh = await fetch(`${base}/auth/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${serviceToken}` }
    });
    assert.equal(refresh.status, 401);
    const err = await refresh.json();
    assert.equal(err.error, "service_token_refresh_unsupported");
  });
});

test("http smoke: /auth/refresh rejects an unauthenticated caller", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const refresh = await fetch(`${base}/auth/refresh`, { method: "POST" });
    assert.equal(refresh.status, 401);
  });
});

test("http smoke: /account/borrow-capacity returns the signed-in wallet headroom", SMOKE_TEST_OPTIONS, async () => {
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

test("http smoke: /badges/:sessionId returns 404 for unknown sessions", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const response = await fetch(`${base}/badges/unknown-session-id`);
    assert.equal(response.status, 404);
    const payload = await response.json();
    assert.equal(payload.status, "not_found");
  });
});

test("http smoke: /badges/:sessionId returns schema-compliant JSON for approved sessions", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const verifierToken = issueToken(VERIFIER_WALLET, { roles: ["verifier"] });

    // 1. Create a job so the worker has something to claim.
    const createJob = await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: "badge-smoke-job-001",
        lane: "benchmark-showcase",
        category: "coding",
        tier: "starter",
        rewardAmount: 3,
        onboardingWaiverEligible: true,
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

    const runReceiptResponse = await fetch(`${base}/badges/${encodeURIComponent(sessionId)}/run`);
    assert.equal(runReceiptResponse.status, 200);
    const runReceipt = await runReceiptResponse.json();
    assert.equal(runReceipt.kind, "run");
    assert.equal(runReceipt.verdict.outcome, "approved");
    assert.equal(runReceipt.sessionId, sessionId);

    const listResponse = await fetch(`${base}/badges`);
    assert.equal(listResponse.status, 200);
    const receipts = await listResponse.json();
    assert.deepEqual(
      receipts.filter((receipt) => receipt.sessionId === sessionId).map((receipt) => receipt.kind).sort(),
      ["badge", "run"]
    );
  });
});

test("http smoke: /agents/:wallet returns a v1 profile for a fresh wallet", SMOKE_TEST_OPTIONS, async () => {
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

test("http smoke: /agents/:wallet aggregates approved sessions into badges", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const verifierToken = issueToken(VERIFIER_WALLET, { roles: ["verifier"] });

    // Seed a job + full claim→submit→verify cycle so the profile has data.
    await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: "profile-smoke-job-001",
        lane: "benchmark-showcase",
        category: "coding",
        tier: "starter",
        rewardAmount: 4,
        onboardingWaiverEligible: true,
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
    // Job rewards default to USDC: 4 USDC at 6 decimals = 4 * 10^6 base units.
    assert.equal(profile.stats.totalEarned.amount, "4000000");
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

test("http smoke: /agents exposes a claimed session as current activity", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });

    const createJob = await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: "profile-active-smoke-job-001",
        lane: "benchmark-showcase",
        category: "coding",
        tier: "starter",
        rewardAmount: 4,
        claimTtlSeconds: 3600,
        onboardingWaiverEligible: true,
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

test("http smoke: /disputes exposes human-review sessions and records verdict/release receipts", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const verifierToken = issueToken(VERIFIER_WALLET, { roles: ["verifier"] });

    await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: "dispute-smoke-job-001",
        lane: "benchmark-showcase",
        category: "coding",
        tier: "starter",
        rewardAmount: 3,
        onboardingWaiverEligible: true,
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
    assert.match(dispute.openedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.match(dispute.windowEndsAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(dispute.slaSeconds, 14 * 24 * 60 * 60);

    const detail = await fetch(`${base}/disputes/${encodeURIComponent(dispute.id)}`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.equal(detailBody.sessionId, sessionId);
    assert.equal(detailBody.slaSeconds, dispute.slaSeconds);

    const rejected = await fetch(`${base}/disputes/${encodeURIComponent(dispute.id)}/verdict`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${verifierToken}` },
      body: JSON.stringify({ verdict: "not-a-real-verdict", rationale: "x" })
    });
    assert.equal(rejected.status, 400);

    const verdict = await fetch(`${base}/disputes/${encodeURIComponent(dispute.id)}/verdict`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${verifierToken}` },
      body: JSON.stringify({
        verdict: "upheld",
        rationale: "Submission needs correction.",
        idempotencyKey: "dispute-verdict-same-key"
      })
    });
    assert.equal(verdict.status, 200);
    const verdictBody = await verdict.json();
    assert.equal(verdictBody.status, "resolved");
    assert.equal(verdictBody.verdict, "upheld");
    assert.equal(verdictBody.reasonCode, "DISPUTE_LOST");
    assert.match(verdictBody.reasoningHash, /^0x[a-f0-9]{64}$/u);
    assert.equal(verdictBody.metadataURI, `urn:averray:content:${verdictBody.reasoningHash}`);
    assert.equal(verdictBody.chainStatus, "local_only");
    assert.equal(verdictBody.txHash, undefined);

    const verdictReplay = await fetch(`${base}/disputes/${encodeURIComponent(dispute.id)}/verdict`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${verifierToken}` },
      body: JSON.stringify({
        idempotencyKey: "dispute-verdict-same-key",
        rationale: "Submission needs correction.",
        verdict: "upheld"
      })
    });
    assert.equal(verdictReplay.status, 200);
    assert.deepEqual(await verdictReplay.json(), verdictBody);

    const verdictDrift = await fetch(`${base}/disputes/${encodeURIComponent(dispute.id)}/verdict`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${verifierToken}` },
      body: JSON.stringify({
        verdict: "dismissed",
        rationale: "Submission needs correction.",
        idempotencyKey: "dispute-verdict-same-key"
      })
    });
    assert.equal(verdictDrift.status, 409);
    const verdictDriftBody = await verdictDrift.json();
    assert.equal(verdictDriftBody.error, "idempotency_key_payload_mismatch");
    assert.equal(verdictDriftBody.details.bucket, "dispute_verdict_idempotency");

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
      body: JSON.stringify({ action: "release", amount: 0.15, idempotencyKey: "dispute-release-same-key" })
    });
    assert.equal(release.status, 200);
    const releaseBody = await release.json();
    assert.equal(releaseBody.release.action, "release");
    assert.equal(releaseBody.release.amount, 0.15);
    assert.equal(releaseBody.release.chainStatus, "local_only");

    const releaseReplay = await fetch(`${base}/disputes/${encodeURIComponent(dispute.id)}/release`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ amount: "0.15", action: "release", idempotencyKey: "dispute-release-same-key" })
    });
    assert.equal(releaseReplay.status, 200);
    assert.deepEqual(await releaseReplay.json(), releaseBody);

    const releaseDrift = await fetch(`${base}/disputes/${encodeURIComponent(dispute.id)}/release`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ action: "release", amount: 0.2, idempotencyKey: "dispute-release-same-key" })
    });
    assert.equal(releaseDrift.status, 409);
    const releaseDriftBody = await releaseDrift.json();
    assert.equal(releaseDriftBody.error, "idempotency_key_payload_mismatch");
    assert.equal(releaseDriftBody.details.bucket, "dispute_release_idempotency");
  });
});

test("http smoke: operator policy, alert, and audit endpoints are available", SMOKE_TEST_OPTIONS, async () => {
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

test("http smoke: /agents/:wallet rejects non-address path segments", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const response = await fetch(`${base}/agents/not-a-wallet`);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "invalid_request");
  });
});

test("http smoke: /payments/send moves liquid balance between agent accounts", SMOKE_TEST_OPTIONS, async () => {
  await runWithServerEnv({ PAYMENTS_SEND_ENABLED: "1" }, async (base) => {
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
      body: JSON.stringify({ recipient: VERIFIER_WALLET, asset: "DOT", amount: 5, transferAuthorization: TRANSFER_AUTHORIZATION })
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

test("http smoke: /payments/send rejects self-transfer", SMOKE_TEST_OPTIONS, async () => {
  await runWithServerEnv({ PAYMENTS_SEND_ENABLED: "1" }, async (base) => {
    const token = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const response = await fetch(`${base}/payments/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ recipient: ADMIN_WALLET, asset: "DOT", amount: 1, transferAuthorization: TRANSFER_AUTHORIZATION })
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "invalid_request");
  });
});

test("http smoke: /strategies is a static retirement notice when STRATEGIES_JSON is unset", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const response = await fetch(`${base}/strategies`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "retired");
    assert.equal(body.retired, true);
    assert.deepEqual(body.strategies, []);
    assert.equal(body.see.pool, "/pool");
    assert.equal(body.see.onboarding, "/onboarding#buildVestedCapacity");
  });
});

test("http smoke: /jobs/tiers returns the public tier ladder without auth", SMOKE_TEST_OPTIONS, async () => {
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

test("http smoke: /jobs/explain-eligibility surfaces the explainEligibility tool", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });

    // Post a pro-tier job. A fresh wallet (skill=0) is below the gate.
    await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: "tier-smoke-explain-001",
        lane: "oss-anchored",
        category: "coding",
        tier: "pro",
        rewardAmount: 8,
        verifierMode: "benchmark",
        verifierTerms: ["complete", "verified"],
        verifierMinimumMatches: 1,
        outputSchemaRef: "schema://jobs/tier-smoke"
      })
    });

    // jobId is required.
    const missingJobId = await fetch(`${base}/jobs/explain-eligibility`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    assert.equal(missingJobId.status, 400);

    const response = await fetch(
      `${base}/jobs/explain-eligibility?jobId=tier-smoke-explain-001`,
      { headers: { authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.jobId, "tier-smoke-explain-001");
    assert.ok(typeof body.eligible === "boolean");
  });
});

test("http smoke: /jobs/estimate-reward surfaces the estimateNetReward tool", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });

    await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: "tier-smoke-reward-001",
        lane: "benchmark-showcase",
        category: "coding",
        tier: "starter",
        rewardAmount: 4,
        verifierMode: "benchmark",
        verifierTerms: ["complete"],
        verifierMinimumMatches: 1,
        outputSchemaRef: "schema://jobs/tier-smoke"
      })
    });

    // jobId is required.
    const missingJobId = await fetch(`${base}/jobs/estimate-reward`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    assert.equal(missingJobId.status, 400);

    const response = await fetch(
      `${base}/jobs/estimate-reward?jobId=tier-smoke-reward-001`,
      { headers: { authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    // job-catalog-service.estimateNetReward returns a scalar (the net-
    // reward number after gas + risk penalties). For the smoke pass we
    // assert the shape is a finite non-negative number, matching the
    // implementation contract.
    assert.ok(typeof body === "number" && Number.isFinite(body) && body >= 0, `expected estimate-reward to return a finite non-negative number, got ${JSON.stringify(body)}`);

    const pathResponse = await fetch(
      `${base}/jobs/tier-smoke-reward-001/estimate`,
      { headers: { authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(pathResponse.status, 200);
    assert.deepEqual(await pathResponse.json(), {
      netReward: body,
      assetContext: {
        symbol: "USDC",
        chain: "eip155:420420419",
        chainName: "Polkadot Hub",
        assetId: 1337,
        token: "0x0000053900000000000000000000000001200000"
      }
    });

    const unauthenticated = await fetch(`${base}/jobs/tier-smoke-reward-001/estimate`);
    assert.equal(unauthenticated.status, 401);
  });
});

test("http smoke: /me returns only existing signed-in worker surfaces", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const token = issueToken(STRANGER_WALLET);
    const response = await fetch(`${base}/me`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const rawBody = await response.text();
    assert.equal(response.status, 200, rawBody);
    const body = JSON.parse(rawBody);
    assert.equal(body.wallet, STRANGER_WALLET);
    assert.equal(body.claimTier, "starter");
    assert.equal(body.reputationTier, "apprentice");
    assert.ok(body.progression);
    assert.deepEqual(body.accountPosition.liquid, {});
    assert.deepEqual(body.accountPosition.jobStakeLocked, {});
    assert.deepEqual(body.accountPosition.raw.liquid, {});
    assert.deepEqual(body.accountPosition.raw.jobStakeLocked, {});

    const unauthenticated = await fetch(`${base}/me`);
    assert.equal(unauthenticated.status, 401);
  });
});

test("http smoke: /receipts is authenticated and restricted to the signed-in wallet", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const token = issueToken(STRANGER_WALLET);
    const headers = { authorization: `Bearer ${token}` };

    const response = await fetch(`${base}/receipts?limit=1`, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);

    const unauthenticated = await fetch(`${base}/receipts`);
    assert.equal(unauthenticated.status, 401);

    const crossWallet = await fetch(`${base}/receipts?wallet=${ADMIN_WALLET}`, { headers });
    assert.equal(crossWallet.status, 403);
    assert.equal((await crossWallet.json()).error, "receipt_wallet_mismatch");
  });
});

test("http smoke: /jobs/recommendations includes per-job tierGate with missing-skill gap", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });

    // Post a pro-tier job. A fresh wallet (skill=0) should see it locked.
    await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: "tier-smoke-pro-001",
        lane: "oss-anchored",
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

test("http smoke: /admin/jobs/fire produces a derivative from a recurring template", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });

    // 1. Post a recurring template.
    const template = await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: "recurring-smoke-digest",
        lane: "benchmark-showcase",
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

test("http smoke: admin job creation idempotency replays and rejects payload drift", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const headers = { "content-type": "application/json", authorization: `Bearer ${adminToken}` };
    const payload = {
      id: "admin-idempotency-create-smoke",
      lane: "benchmark-showcase",
      category: "coding",
      tier: "starter",
      rewardAmount: 2,
      verifierMode: "benchmark",
      verifierTerms: ["complete"],
      verifierMinimumMatches: 1,
      idempotencyKey: "admin-create-same-key"
    };

    const create = await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    assert.equal(create.status, 201);
    const created = await create.json();

    const replay = await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ verifierTerms: ["complete"], ...payload })
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), created);

    const drift = await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...payload,
        id: "admin-idempotency-create-smoke-other"
      })
    });
    assert.equal(drift.status, 409);
    const body = await drift.json();
    assert.equal(body.error, "idempotency_key_payload_mismatch");
    assert.equal(body.details.bucket, "admin_jobs");
    assert.ok(body.details.originalRequestHash);
    assert.ok(body.details.requestHash);
  });
});

test("http smoke: provider ingestion idempotency replays and rejects payload drift", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const headers = { "content-type": "application/json", authorization: `Bearer ${adminToken}` };
    const payload = {
      datasets: [OPEN_DATA_INGEST_TARGET],
      dryRun: false,
      limit: 5,
      minScore: 55,
      idempotencyKey: "provider-ingest-open-data-same-key"
    };

    const create = await fetch(`${base}/admin/jobs/ingest/open-data`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    assert.equal(create.status, 201);
    const created = await create.json();
    assert.equal(created.provider, "data.gov");
    assert.equal(created.dryRun, false);
    assert.equal(created.candidateCount, 1);
    assert.equal(created.created.length, 1);
    assert.equal(created.errors.length, 0);

    const replay = await fetch(`${base}/admin/jobs/ingest/open-data`, {
      method: "POST",
      headers,
      body: JSON.stringify({ minScore: 55, ...payload })
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), created);

    const drift = await fetch(`${base}/admin/jobs/ingest/open-data`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...payload,
        limit: 4
      })
    });
    assert.equal(drift.status, 409);
    const body = await drift.json();
    assert.equal(body.error, "idempotency_key_payload_mismatch");
    assert.equal(body.details.bucket, "admin_jobs_ingest_open_data");
    assert.ok(body.details.originalRequestHash);
    assert.ok(body.details.requestHash);
  });
});

test("http smoke: capability grants reject capabilities the issuer token lacks", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const response = await fetch(`${base}/admin/capability-grants`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        subject: STRANGER_WALLET,
        capabilities: ["verifier:run"],
        issuedAt: "2026-05-01T00:00:00.000Z",
        nonce: "issuer-subset-smoke",
        idempotencyKey: "issuer-subset-smoke"
      })
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error, "grant_capability_not_owned");
    assert.deepEqual(body.details.missingCapabilities, ["verifier:run"]);
  });
});

test("http smoke: capability grant idempotency replays and rejects payload drift", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const headers = { "content-type": "application/json", authorization: `Bearer ${adminToken}` };
    const payload = {
      subject: STRANGER_WALLET,
      capabilities: ["jobs:lifecycle"],
      scope: "worker-loop-smoke",
      issuedAt: "2026-05-01T00:00:00.000Z",
      nonce: "grant-idempotency-smoke",
      idempotencyKey: "capability-grant-same-key"
    };

    const create = await fetch(`${base}/admin/capability-grants`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    assert.equal(create.status, 201);
    const grant = await create.json();
    assert.equal(grant.subject, STRANGER_WALLET.toLowerCase());
    assert.deepEqual(grant.capabilities, ["jobs:lifecycle"]);

    const replay = await fetch(`${base}/admin/capability-grants`, {
      method: "POST",
      headers,
      body: JSON.stringify({ capabilities: ["jobs:lifecycle"], ...payload })
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), grant);

    const drift = await fetch(`${base}/admin/capability-grants`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...payload,
        capabilities: ["policies:propose"]
      })
    });
    assert.equal(drift.status, 409);
    const body = await drift.json();
    assert.equal(body.error, "idempotency_key_payload_mismatch");
    assert.equal(body.details.bucket, "capability_grant");
  });
});

test("http smoke: capability revoke idempotency replays and rejects payload drift", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const headers = { "content-type": "application/json", authorization: `Bearer ${adminToken}` };
    const create = await fetch(`${base}/admin/capability-grants`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        subject: STRANGER_WALLET,
        capabilities: ["jobs:lifecycle"],
        scope: "revoke-smoke",
        issuedAt: "2026-05-01T00:00:00.000Z",
        nonce: "revoke-idempotency-smoke"
      })
    });
    assert.equal(create.status, 201);
    const grant = await create.json();

    const revokePayload = {
      note: "rotated service token",
      idempotencyKey: "capability-revoke-same-key"
    };
    const revoke = await fetch(`${base}/admin/capability-grants/${grant.id}/revoke`, {
      method: "POST",
      headers,
      body: JSON.stringify(revokePayload)
    });
    assert.equal(revoke.status, 200);
    const revoked = await revoke.json();
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.revokeNote, "rotated service token");

    const replay = await fetch(`${base}/admin/capability-grants/${grant.id}/revoke`, {
      method: "POST",
      headers,
      body: JSON.stringify(revokePayload)
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), revoked);

    const drift = await fetch(`${base}/admin/capability-grants/${grant.id}/revoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...revokePayload,
        note: "different operator note"
      })
    });
    assert.equal(drift.status, 409);
    const body = await drift.json();
    assert.equal(body.error, "idempotency_key_payload_mismatch");
    assert.equal(body.details.bucket, "capability_revoke");
  });
});

test("http smoke: service token issue/rotate/revoke is grant-backed and one-time-secret", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const adminHeaders = { "content-type": "application/json", authorization: `Bearer ${adminToken}` };
    const issuePayload = {
      subject: STRANGER_WALLET,
      capabilities: ["jobs:lifecycle"],
      scope: "external-agent-smoke",
      issuedAt: "2026-05-01T00:00:00.000Z",
      nonce: "service-token-issue-smoke",
      tokenTtlSeconds: 600,
      idempotencyKey: "service-token-issue-key"
    };

    const issue = await fetch(`${base}/admin/service-tokens`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify(issuePayload)
    });
    assert.equal(issue.status, 201);
    const issued = await issue.json();
    assert.equal(typeof issued.token, "string");
    assert.equal(issued.tokenKind, "service");
    assert.equal(issued.wallet, STRANGER_WALLET.toLowerCase());
    assert.deepEqual(issued.capabilities, ["jobs:lifecycle"]);

    const replay = await fetch(`${base}/admin/service-tokens`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify(issuePayload)
    });
    assert.equal(replay.status, 200);
    const replayed = await replay.json();
    assert.equal(replayed.token, undefined);
    assert.equal(replayed.tokenAvailable, false);
    assert.equal(replayed.tokenOmittedReason, "service_token_secret_is_returned_once");
    assert.equal(replayed.grant.id, issued.grant.id);

    const session = await fetch(`${base}/auth/session`, {
      headers: { authorization: `Bearer ${issued.token}` }
    });
    assert.equal(session.status, 200);
    const serviceSession = await session.json();
    assert.equal(serviceSession.tokenKind, "service");
    assert.equal(serviceSession.serviceToken, true);
    assert.equal(serviceSession.capabilityGrantId, issued.grant.id);
    assert.deepEqual(serviceSession.capabilities, ["jobs:lifecycle"]);

    const noBase = await fetch(`${base}/account`, {
      headers: { authorization: `Bearer ${issued.token}` }
    });
    assert.equal(noBase.status, 403);

    const rotate = await fetch(`${base}/admin/service-tokens/${issued.grant.id}/rotate`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        issuedAt: "2026-05-01T00:01:00.000Z",
        nonce: "service-token-rotate-smoke",
        tokenTtlSeconds: 600,
        idempotencyKey: "service-token-rotate-key"
      })
    });
    assert.equal(rotate.status, 201);
    const rotated = await rotate.json();
    assert.equal(typeof rotated.token, "string");
    assert.notEqual(rotated.grant.id, issued.grant.id);
    assert.equal(rotated.rotatedFrom.id, issued.grant.id);
    assert.equal(rotated.rotatedFrom.status, "revoked");

    const oldToken = await fetch(`${base}/admin/jobs/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ jobId: "missing", action: "pause" })
    });
    assert.equal(oldToken.status, 403);

    const newToken = await fetch(`${base}/auth/session`, {
      headers: { authorization: `Bearer ${rotated.token}` }
    });
    assert.equal(newToken.status, 200);
    assert.deepEqual((await newToken.json()).capabilities, ["jobs:lifecycle"]);

    const revoke = await fetch(`${base}/admin/service-tokens/${rotated.grant.id}/revoke`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        note: "smoke complete",
        idempotencyKey: "service-token-revoke-key"
      })
    });
    assert.equal(revoke.status, 200);
    const revoked = await revoke.json();
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.grant.status, "revoked");

    const revokedToken = await fetch(`${base}/admin/jobs/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${rotated.token}` },
      body: JSON.stringify({ jobId: "missing", action: "pause" })
    });
    assert.equal(revokedToken.status, 403);
  });
});

test("http smoke: admin recurring fire idempotency replays and rejects firedAt drift", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const headers = { "content-type": "application/json", authorization: `Bearer ${adminToken}` };

    const template = await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "recurring-fire-idempotency-smoke",
        lane: "benchmark-showcase",
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

    const firePayload = {
      templateId: "recurring-fire-idempotency-smoke",
      firedAt: "2026-04-20T09:00:00.000Z",
      idempotencyKey: "fire-same-key"
    };
    const fire = await fetch(`${base}/admin/jobs/fire`, {
      method: "POST",
      headers,
      body: JSON.stringify(firePayload)
    });
    assert.equal(fire.status, 201);
    const derivative = await fire.json();

    const replay = await fetch(`${base}/admin/jobs/fire`, {
      method: "POST",
      headers,
      body: JSON.stringify(firePayload)
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), derivative);

    const drift = await fetch(`${base}/admin/jobs/fire`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...firePayload,
        firedAt: "2026-04-27T09:00:00.000Z"
      })
    });
    assert.equal(drift.status, 409);
    const body = await drift.json();
    assert.equal(body.error, "idempotency_key_payload_mismatch");
    assert.equal(body.details.bucket, "admin_jobs_fire");
  });
});

test("http smoke: recurring pause/resume accept idempotency keys", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const headers = { "content-type": "application/json", authorization: `Bearer ${adminToken}` };

    const template = await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "recurring-idempotency-smoke",
        lane: "benchmark-showcase",
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

    const pause = await fetch(`${base}/admin/jobs/pause`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        templateId: "recurring-idempotency-smoke",
        idempotencyKey: "same-client-key"
      })
    });
    assert.equal(pause.status, 200);
    const paused = await pause.json();
    assert.equal(findRecurringTemplate(paused, "recurring-idempotency-smoke").paused, true);

    const pauseReplay = await fetch(`${base}/admin/jobs/pause`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        templateId: "recurring-idempotency-smoke",
        idempotencyKey: "same-client-key"
      })
    });
    assert.equal(pauseReplay.status, 200);
    assert.deepEqual(await pauseReplay.json(), paused);

    const pauseDrift = await fetch(`${base}/admin/jobs/pause`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        templateId: "recurring-idempotency-smoke",
        idempotencyKey: "same-client-key",
        reason: "different operator annotation"
      })
    });
    assert.equal(pauseDrift.status, 409);
    const pauseDriftBody = await pauseDrift.json();
    assert.equal(pauseDriftBody.error, "idempotency_key_payload_mismatch");
    assert.equal(pauseDriftBody.details.bucket, "admin_jobs_pause");

    const resume = await fetch(`${base}/admin/jobs/resume`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        templateId: "recurring-idempotency-smoke",
        idempotencyKey: "same-client-key"
      })
    });
    assert.equal(resume.status, 200);
    const resumed = await resume.json();
    assert.equal(findRecurringTemplate(resumed, "recurring-idempotency-smoke").paused, false);
  });
});

test("http smoke: /admin/jobs rejects recurring template with missing schedule", SMOKE_TEST_OPTIONS, async () => {
  await runWithServer(async (base) => {
    const adminToken = issueToken(ADMIN_WALLET, { roles: ["admin"] });
    const response = await fetch(`${base}/admin/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: "bad-recurring-job",
        lane: "benchmark-showcase",
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

function findRecurringTemplate(status, templateId) {
  const template = status.recurring.templates.find((entry) => entry.templateId === templateId);
  assert.ok(template, `expected recurring template ${templateId}`);
  return template;
}

test("http smoke: /metrics emits Prometheus text format with baseline series", SMOKE_TEST_OPTIONS, async () => {
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

test("http smoke: /metrics is bearer-gated when metrics auth is required", SMOKE_TEST_OPTIONS, async () => {
  await runWithServerEnv(
    {
      METRICS_AUTH_REQUIRED: "1",
      METRICS_BEARER_TOKEN: "metrics-smoke-token-1234567890"
    },
    async (base) => {
      const noBearer = await fetch(`${base}/metrics`);
      assert.equal(noBearer.status, 401);

      const wrongBearer = await fetch(`${base}/metrics`, {
        headers: { authorization: "Bearer wrong-token" }
      });
      assert.equal(wrongBearer.status, 401);

      const response = await fetch(`${base}/metrics`, {
        headers: { authorization: "Bearer metrics-smoke-token-1234567890" }
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
      assert.match(await response.text(), /# HELP http_requests_total/);
    }
  );
});

test("http smoke: production /metrics fails closed when token is missing", SMOKE_TEST_OPTIONS, async () => {
  await runWithServerEnv(
    {
      NODE_ENV: "production",
      BADGE_RECEIPT_SIGNING: "disabled",
      METRICS_BEARER_TOKEN: ""
    },
    async (base) => {
      const response = await fetch(`${base}/metrics`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "metrics_auth_unconfigured" });
    }
  );
});

test("http smoke: discovery manifest is served at both /agent-tools.json and the RFC 8615 .well-known path", SMOKE_TEST_OPTIONS, async () => {
  await runWithServerEnv({ AUTH_CHAIN_ID: "420420419" }, async (base) => {
    const [
      canonical,
      wellKnown,
      healthResponse,
      llmsResponse,
      mcpInfoResponse,
      modernDiscoverResponse,
      legacyInitializeResponse
    ] = await Promise.all([
      fetch(`${base}/agent-tools.json`),
      fetch(`${base}/.well-known/agent-tools.json`),
      fetch(`${base}/health`),
      fetch(`${base}/llms.txt`),
      fetch(`${base}/mcp`),
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "MCP-Protocol-Version": MODERN_MCP_VERSION,
          "Mcp-Method": "server/discover"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "modern-discover",
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": MODERN_MCP_VERSION,
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": {
                name: "manifest-honesty-smoke",
                version: "1.0.0"
              }
            }
          }
        })
      }),
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "legacy-initialize",
          method: "initialize",
          params: {
            protocolVersion: LEGACY_MCP_VERSION,
            capabilities: {},
            clientInfo: { name: "manifest-honesty-smoke", version: "1.0.0" }
          }
        })
      })
    ]);
    assert.equal(canonical.status, 200);
    assert.equal(wellKnown.status, 200);
    assert.equal(healthResponse.status, 200);
    assert.equal(llmsResponse.status, 200);
    assert.equal(mcpInfoResponse.status, 200);
    assert.equal(modernDiscoverResponse.status, 200);
    assert.equal(legacyInitializeResponse.status, 200);
    assert.match(canonical.headers.get("content-type") ?? "", /application\/json/);
    assert.match(wellKnown.headers.get("content-type") ?? "", /application\/json/);
    assert.match(llmsResponse.headers.get("content-type") ?? "", /text\/plain/);
    const [canonicalBody, wellKnownBody, health, mcpInfo, modernDiscover, legacyInitialize] = await Promise.all([
      canonical.json(),
      wellKnown.json(),
      healthResponse.json(),
      mcpInfoResponse.json(),
      modernDiscoverResponse.json(),
      legacyInitializeResponse.json()
    ]);
    const llms = await llmsResponse.text();
    assert.deepEqual(canonicalBody, wellKnownBody, "well-known alias must return the same manifest");
    assert.equal(typeof canonicalBody.name, "string");
    assert.deepEqual(canonicalBody.protocols, ["http", "mcp"]);
    assert.deepEqual(canonicalBody.protocolEndpoints, {
      http: canonicalBody.baseUrl,
      mcp: `${canonicalBody.baseUrl}/mcp`
    });
    assert.equal(mcpInfo.type, "mcp_protocol_endpoint");
    assert.equal(mcpInfo.description, "This is an MCP protocol endpoint, not a browser page.");
    assert.equal(mcpInfo.connect.clientConfig.mcpServers.averray.url, "https://api.averray.com/mcp");
    assert.equal(mcpInfo.install.npm.command, "npx -y @averray/mcp");
    assert.equal(
      mcpInfo.install.cursor.deeplink,
      "cursor://anysphere.cursor-deeplink/mcp/install?name=averray&config=eyJ1cmwiOiJodHRwczovL2FwaS5hdmVycmF5LmNvbS9tY3AifQ%3D%3D"
    );
    assert.equal(
      mcpInfo.install.claudeCode.command,
      "claude mcp add --transport http averray https://api.averray.com/mcp"
    );
    assert.deepEqual(
      mcpInfo.install.claudeDesktop.clientConfig.mcpServers.averray.args,
      ["-y", "@averray/mcp"]
    );
    assert.equal(mcpInfo.plainHttpAlternative.path, "/verify/profiles");
    assert.deepEqual(modernDiscover.result.supportedVersions, [...SUPPORTED_MCP_VERSIONS]);
    assert.equal(modernDiscover.result._meta["io.modelcontextprotocol/serverInfo"].name, "averray-agent-platform");
    assert.equal(legacyInitialize.result.protocolVersion, LEGACY_MCP_VERSION);
    assert.ok(legacyInitializeResponse.headers.get("mcp-session-id"));
    assert.equal(canonicalBody.onboarding.walletlessArrival.limits.waiverClaimsPerWallet, 3);
    assert.match(canonicalBody.onboarding.walletlessArrival.proof.summary, /0\.40 USDC/u);
    assert.match(canonicalBody.onboarding.walletlessArrival.managedWalletInterop, /same key works on any EVM chain/u);
    assert.match(llms, /No funding is required to start/u);
    assert.match(llms, /Already have a managed wallet/u);
    assert.match(llms, /Withdrawal is an on-chain act/u);
    const advertisedChains = canonicalBody.onboarding.walletModes
      .filter((mode) => mode.chain)
      .map((mode) => mode.chain.chainId);
    assert.ok(advertisedChains.length > 0);
    assert.ok(
      advertisedChains.every((chainId) => chainId === health.auth.chainId),
      "served manifest wallet chains must match /health.auth.chainId"
    );
  });
});

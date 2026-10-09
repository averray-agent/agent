import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createOperationalRoutes, resolveMetricsAuthConfig } from "./operational-routes.js";
import { GithubPrReviewService } from "../../services/github-pr-review-service.js";
import { KmsSigner } from "../../blockchain/kms-signer.js";
import { MemoryStateStore } from "../../core/state-store.js";
import { buildJobSnapshot } from "../../core/job-snapshot.js";

const AUTH_CONFIG = {
  mode: "strict",
  jwtBackend: "hmac",
  domain: "averray.test",
  chainId: "1",
  secrets: ["test-secret"]
};

test("GET /health warns about missing Verify backfill receipts without leaking identifiers or failing startup health", async () => {
  for (const missing of [2, 0]) {
    const { route, response } = makeHarness({ service: {
      receiptSignatureBackfill: { verify: { scanned: 1, signed: 1, alreadySigned: 0, missing } }
    } });
    await route({ request: { method: "GET" }, response, pathname: "/health" });
    assert.equal(response.statusCode, 200);
    const warning = response.body.warnings.find((item) => item.code === "verify_receipt_backfill_missing");
    assert.deepEqual(warning, missing ? { code: "verify_receipt_backfill_missing", severity: "warning", count: 2 } : undefined);
  }
});

function makeResponse() {
  return {
    _corsHeaders: { "access-control-allow-origin": "https://app.averray.test" },
    _requestId: "req-test",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    }
  };
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`operation exceeded ${timeoutMs}ms`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function makeHarness(overrides = {}) {
  const calls = [];
  const response = makeResponse();
  const defaultService = {
    submittedJobAutoVerifier: {
      getHealth: async () => {
        calls.push(["submittedJobAutoVerifierHealth"]);
        return { ok: true, enabled: true, running: true, state: "running" };
      }
    },
    xcmSettlementWatcher: {
      getStatus: async () => {
        calls.push(["xcmStatus"]);
        return { enabled: true, running: true, pendingCount: 0 };
      }
    }
  };
  const service = { ...defaultService, ...(overrides.service ?? {}) };
  const route = createOperationalRoutes({
    authConfig: overrides.authConfig ?? AUTH_CONFIG,
    deployedSha: overrides.deployedSha,
    externalPostingMode: overrides.externalPostingMode,
    externalPostingWatcher: overrides.externalPostingWatcher,
    gateway: overrides.gateway ?? {
      isEnabled: () => false,
      healthCheck: async () => {
        calls.push(["chainHealth"]);
        return { ok: true, backend: "blockchain", enabled: false, mode: "disabled" };
      }
    },
    getRewardBankHealth: overrides.getRewardBankHealth,
    indexerHealthProbe: overrides.indexerHealthProbe ?? (async () => {
      calls.push(["indexerHealth"]);
      return { ok: false, reason: "indexer_status_unconfigured" };
    }),
    metrics: overrides.metrics ?? {
      serialize: () => {
        calls.push(["serializeMetrics"]);
        return "# HELP http_requests_total Total requests\n";
      }
    },
    metricsAuthRequired: overrides.metricsAuthRequired ?? false,
    metricsBearerToken: overrides.metricsBearerToken,
    lockedTierService: overrides.lockedTierService,
    mutationBackendConfig: overrides.mutationBackendConfig ?? {
      mode: "required",
      defaulted: false,
      requiresChain: true,
      allowsMemory: false
    },
    pimlicoClient: overrides.pimlicoClient ?? {
      healthCheck: async () => {
        calls.push(["gasHealth"]);
        return { ok: true, backend: "pimlico", enabled: false, mode: "disabled" };
      }
    },
    respond: (res, statusCode, body, headers = undefined) => {
      calls.push(["respond", { statusCode, body, headers }]);
      res.statusCode = statusCode;
      res.body = body;
      res.headers = headers;
    },
    service,
    getCredentialsHealth: overrides.getCredentialsHealth,
    badgeReceiptSigner: overrides.badgeReceiptSigner,
    stateStore: overrides.stateStore ?? {
      constructor: { name: "MemoryStateStore" },
      healthCheck: async () => {
        calls.push(["storeHealth"]);
        return { ok: true, backend: "memory", mode: "memory" };
      }
    }
  });
  return { calls, response, route, service };
}

test("GET /health exposes credential freshness without making an unavailable signer a 503", async () => {
  const credentials = { rolesAnywhere: { ok: false, reason: "certificate_expired_or_not_yet_valid", notAfter: "2026-10-08T00:00:00Z" },
    badgeReceiptSigner: { ok: true, kid: "badge-1" }, kms: { state: "unused", lastSignAt: null } };
  const { route, response } = makeHarness({ getCredentialsHealth: async () => credentials });
  await route({ request: { method: "GET" }, response, pathname: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.serviceHealth.components.credentials, credentials);
});

test("GET /health never signs or calls KMS and unused signers are not failures", async (t) => {
  const send = t.mock.fn(async () => { throw new Error("health must not probe KMS"); });
  const signer = new KmsSigner({ keyId: "fixture-key", kmsClient: { send } });
  const signMessage = t.mock.method(signer, "signMessage");
  const signTransaction = t.mock.method(signer, "signTransaction");
  const signDocument = t.mock.fn(async () => { throw new Error("health must not sign a badge"); });
  const { route, response } = makeHarness({ gateway: { signer, isEnabled: () => false,
    healthCheck: async () => ({ ok: true, enabled: false }) },
    badgeReceiptSigner: { signDocument, getHealth: () => ({ kid: "fixture", state: "unused" }) } });
  for (let n = 0; n < 2; n++) await route({ request: { method: "GET" }, response, pathname: "/health" });
  for (const spy of [send, signMessage, signTransaction, signDocument]) assert.equal(spy.mock.callCount(), 0);
  assert.equal(response.body.serviceHealth.components.credentials.kms.state, "unused");
  assert.notEqual(response.body.serviceHealth.components.credentials.kms.ok, false);
  for (const value of Object.values(response.body.serviceHealth.components.credentials)) if (value.ok === false) assert.ok(value.reason);
});

test("GET /health is not degraded for an old open PR but is degraded for closed-unmerged or stalled merged approval", async () => {
  for (const [upstreamState, merged, previewOutcome, overdue] of [
    ["open", false, "approved", false], ["closed", false, "rejected", true], ["closed", true, "approved", true]
  ]) {
    const store = new MemoryStateStore();
    await store.upsertSession({ sessionId: "pr", jobId: "pr", status: "submitted", submittedAt: "2026-09-01T00:00:00Z",
      jobSnapshot: buildJobSnapshot({ id: "pr", verifierMode: "github_pr" }) });
    await store.upsertMutationReceipt("github_pr_review_observation", "pr", { upstreamState, merged, previewOutcome });
    const review = new GithubPrReviewService({ stateStore: store, githubToken: "fixture" });
    const { route, response } = makeHarness({ stateStore: store, service: { githubPrReview: review } });
    await route({ request: { method: "GET" }, response, pathname: "/health" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, overdue ? "degraded" : "ok");
    assert.equal(response.body.settlement.waitingForMerge, overdue ? 0 : 1);
    assert.equal(response.body.settlement.overdueReview, overdue ? 1 : 0);
  }
});

test("GET /health exposes author concentration without disclosing author-wallet rows", async () => {
  const warning = { code: "github_author_concentration", severity: "warning", openClaims: 14, totalOpenClaims: 16, distinctWallets: 14 };
  const { route, response } = makeHarness({ service: { getGithubAuthors: async () => ({
    authors: [{ author: "private-admin-row" }], warnings: [warning]
  }) } });
  await route({ request: { method: "GET" }, response, pathname: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.warnings.find((item) => item.code === warning.code), warning);
  assert.doesNotMatch(JSON.stringify(response.body), /private-admin-row/u);
});

test("GET /health exposes overdue GitHub review and upstream health without changing API liveness", async () => {
  const githubUpstream = { ok: false, lastSuccessAt: "2026-10-06T12:00:00Z", lastError: "github_api_401" };
  const warning = { code: "github_pr_review_overdue", severity: "warning", oldestAgeMs: 49 * 3_600_000 };
  const { route, response } = makeHarness({ service: { githubPrReview: {
    getStatus: async () => ({ githubUpstream, warnings: [warning] })
  } } });
  await route({ request: { method: "GET" }, response, pathname: "/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "degraded");
  assert.deepEqual(response.body.serviceHealth.components.githubUpstream, githubUpstream);
  assert.deepEqual(response.body.warnings.find((item) => item.code === warning.code), warning);
  assert.equal(response.body.settlement.awaitingHumanReview, 0);
});

test("GET /health caches the GitHub pending walk for 60 seconds, including concurrent calls", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-08T12:00:00Z") });
  const review = new GithubPrReviewService({ stateStore: { listRecentSessions: async () => [] }, githubToken: "token" });
  const walk = t.mock.method(review, "pending");
  const { route } = makeHarness({ service: { githubPrReview: review } });
  const read = () => route({ request: { method: "GET" }, response: makeResponse(), pathname: "/health" });
  await Promise.all([read(), read()]);
  await read();
  assert.equal(walk.mock.callCount(), 1);
  t.mock.timers.tick(59_999);
  await read();
  assert.equal(walk.mock.callCount(), 1);
  t.mock.timers.tick(1);
  await read();
  assert.equal(walk.mock.callCount(), 2);
});

test("GET /health fails closed and redacts a throwing GitHub poller status read", async () => {
  const { route, response } = makeHarness({ service: { githubPrReview: {
    getStatus: () => { throw new Error("private upstream details"); }
  } } });
  await route({ request: { method: "GET" }, response, pathname: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.serviceHealth.components.githubUpstream,
    { ok: false, lastSuccessAt: null, lastError: "github_status_unavailable" });
  assert.doesNotMatch(JSON.stringify(response.body), /private upstream details/u);
});

test("GET /health resolves a late-installed GitHub review service on cache refresh", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-08T12:00:00Z") });
  const { route, response, service } = makeHarness();
  await route({ request: { method: "GET" }, response, pathname: "/health" });
  const githubUpstream = { ok: true, state: "idle", lastError: null, lastSuccessAt: null };
  let reads = 0;
  service.githubPrReview = { getStatus: async () => { reads++; return { githubUpstream }; } };
  t.mock.timers.tick(60_000);
  await route({ request: { method: "GET" }, response, pathname: "/health" });
  assert.equal(reads, 1);
  assert.deepEqual(response.body.serviceHealth.components.githubUpstream, githubUpstream);
});

test("operational routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/not-health"
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, [["chainHealth"]]);
  assert.equal(response.statusCode, undefined);
});

test("GET /health reports service liveness separately from disabled capabilities", async (t) => {
  // Product health selects its manifest from the runtime env, independently of
  // the route's authConfig. Name mainnet explicitly instead of inheriting a
  // developer's shell or asserting addresses from the retired testnet harness.
  const previousChainId = process.env.AUTH_CHAIN_ID;
  process.env.AUTH_CHAIN_ID = "420420419";
  t.after(() => {
    if (previousChainId === undefined) delete process.env.AUTH_CHAIN_ID;
    else process.env.AUTH_CHAIN_ID = previousChainId;
  });
  const deployment = JSON.parse(await readFile(new URL("../../../../deployments/mainnet.json", import.meta.url), "utf8"));
  const { calls, response, route } = makeHarness({
    authConfig: { ...AUTH_CONFIG, chainId: "420420419" },
    deployedSha: "a".repeat(40)
  });

  const handled = await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/health"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.deployedSha, "a".repeat(40));
  assert.equal(response.body.serviceHealth.ok, true);
  assert.equal(response.body.capabilityHealth.blockchain, "disabled");
  assert.equal(response.body.capabilityHealth.treasuryMutations, "unavailable");
  assert.equal(response.body.capabilityHealth.xcmObserver, "staged");
  assert.equal(response.body.capabilityHealth.indexer, "unavailable");
  assert.equal(response.body.capabilityHealth.gasSponsor, "disabled");
  assert.equal(response.body.capabilityHealth.externalPosting, "disabled");
  assert.equal(response.body.capabilityHealth.externalPostingWatcherLagSeconds, null);
  assert.equal(response.body.addresses.token, deployment.contracts.token);
  assert.equal(response.body.addresses.agentAccountCore, deployment.contracts.agentAccountCore);
  assert.equal(response.body.addresses.escrowCore, deployment.contracts.escrowCore);
  assert.equal(response.body.addresses.settlementSigner, deployment.verifier);
  assert.equal(response.body.addresses.treasuryReserve, deployment.treasuryReserve);
  assert.equal(Object.hasOwn(response.body.addresses, "treasuryPolicy"), false);
  assert.equal(response.body.rewardBank.readable, false);
  assert.equal(response.body.rewardBank.decimals, 6);
  assert.equal(response.body.settlement.source, "backend_state_store");
  assert.deepEqual(
    {
      claimed24h: response.body.settlement.claimed24h,
      submitted24h: response.body.settlement.submitted24h,
      settled24h: response.body.settlement.settled24h,
      claimedNotSubmitted: response.body.settlement.claimedNotSubmitted,
      submittedNotSettled: response.body.settlement.submittedNotSettled
    },
    {
      claimed24h: 0,
      submitted24h: 0,
      settled24h: 0,
      claimedNotSubmitted: 0,
      submittedNotSettled: 0
    }
  );
  assert.deepEqual(response.body.components.stateStore, { ok: true, backend: "memory", mode: "memory" });
  assert.deepEqual(response.body.components.indexer, { ok: false, reason: "indexer_status_unconfigured" });
  assert.deepEqual(response.body.components.submittedJobAutoVerifier, {
    ok: true,
    enabled: true,
    running: true,
    state: "running"
  });
  assert.ok(response.body.warnings.some((warning) => warning.code === "treasury_mutations_unavailable"));
  assert.deepEqual(calls.map(([name]) => name).sort(), [
    "chainHealth",
    "gasHealth",
    "indexerHealth",
    "respond",
    "storeHealth",
    "submittedJobAutoVerifierHealth",
    "xcmStatus",
  ].sort());
});

test("GET /health exposes watcher lag and stages open external posting while the indexer is stale", async () => {
  const { response, route } = makeHarness({
    externalPostingMode: "open",
    externalPostingWatcher: {
      async getStatus() {
        return {
          enabled: true,
          running: true,
          current: false,
          lagSeconds: 3_600,
          lagBudgetSeconds: 600,
          finalizedBlockNumber: "1234",
          finalizedBlockTimestamp: "2026-07-28T10:00:00.000Z"
        };
      }
    }
  });

  await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/health"
  });

  assert.equal(response.body.capabilityHealth.externalPosting, "staged");
  assert.equal(response.body.capabilityHealth.externalPostingWatcherLagSeconds, 3_600);
  assert.equal(response.body.components.externalPostingWatcher.current, false);
  assert.ok(response.body.warnings.some((warning) => warning.code === "external_posting_staged"));
});

test("GET /health exposes the synthetic lock-consent mismatch as a critical warning", async () => {
  const { response, route } = makeHarness({
    lockedTierService: {
      async getHealth() {
        return {
          ok: false,
          severity: "critical",
          code: "locked_tier_withdrawal_consent_mismatch",
          message: "Synthetic mismatch fixture tripped the abort trigger."
        };
      }
    }
  });
  await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/health"
  });
  assert.equal(response.body.components.lockedTiers.ok, false);
  assert.deepEqual(
    response.body.warnings.find((warning) => warning.code === "locked_tier_withdrawal_consent_mismatch"),
    {
      code: "locked_tier_withdrawal_consent_mismatch",
      severity: "critical",
      message: "Synthetic mismatch fixture tripped the abort trigger."
    }
  );
});

test("GET /health reuses the injected reward-bank provider", async () => {
  let sharedReads = 0;
  const { response, route } = makeHarness({
    getRewardBankHealth: async () => {
      sharedReads += 1;
      return {
        asset: "USDC",
        decimals: 6,
        liquid: 23.9,
        liquidRaw: "23900000",
        readable: true,
        asOf: "2026-07-27T12:00:00.000Z",
        source: "agent_account_position"
      };
    }
  });

  await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/health"
  });

  assert.equal(sharedReads, 1);
  assert.equal(response.body.rewardBank.liquidRaw, "23900000");
});

test("GET /health p99 stays sub-second when live chain reads are blackholed", async () => {
  const blackhole = new Promise(() => {});
  const { route } = makeHarness({
    gateway: {
      isEnabled: () => true,
      healthCheck: async () => blackhole,
      getTreasuryPolicyStatus: async () => blackhole
    }
  });

  const durations = await Promise.all(
    Array.from({ length: 100 }, async () => {
      const response = makeResponse();
      const startedAt = performance.now();
      await withTimeout(
        route({
          request: { method: "GET", headers: {} },
          response,
          pathname: "/health"
        }),
        1_000
      );
      assert.equal(response.statusCode, 200);
      assert.ok(Number.isFinite(Date.parse(response.body.components.blockchain.asOf)));
      assert.ok(Number.isFinite(Date.parse(response.body.rewardBank.asOf)));
      return performance.now() - startedAt;
    })
  );
  const p99 = durations.sort((left, right) => left - right)[98];

  assert.ok(p99 < 500, `expected /health p99 < 500ms; observed ${p99.toFixed(1)}ms`);
});

test("GET /health exposes and warns on an empty onboarding waiver inventory", async () => {
  const { response, route } = makeHarness({
    service: {
      xcmSettlementWatcher: {
        getStatus: async () => ({ enabled: true, running: true, pendingCount: 0 })
      },
      listJobs: () => [],
      attachClaimState: async (job) => job
    }
  });

  await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/health"
  });

  assert.equal(response.body.onboarding.status, "warning");
  assert.equal(response.body.onboarding.waiverEligibleClaimableJobs, 0);
  assert.equal(response.body.onboarding.minimumWaiverEligibleClaimableJobs, 2);
  assert.ok(response.body.warnings.some((warning) => (
    warning.code === "onboarding_waiver_inventory_empty"
  )));
});

test("GET /health earns synced indexer status only from a fresh checkpoint", async () => {
  const { response, route } = makeHarness({
    indexerHealthProbe: async () => ({
      ok: true,
      network: "polkadotHubTestnet",
      blockNumber: 10_901_852,
      blockTimestamp: Math.floor(Date.now() / 1000),
      lagBudgetSeconds: 600
    })
  });

  await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/health"
  });

  assert.equal(response.body.capabilityHealth.indexer, "synced");
  assert.equal(response.body.components.indexer.blockNumber, 10_901_852);
  assert.equal(
    response.body.warnings.some((warning) => warning.code.startsWith("indexer_")),
    false
  );
});

test("GET /health reports lagging and unavailable indexer probes honestly", async () => {
  const staleHarness = makeHarness({
    indexerHealthProbe: async () => ({
      ok: true,
      blockNumber: 10,
      blockTimestamp: Math.floor(Date.now() / 1000) - 601,
      lagBudgetSeconds: 600
    })
  });
  await staleHarness.route({
    request: { method: "GET", headers: {} },
    response: staleHarness.response,
    pathname: "/health"
  });
  assert.equal(staleHarness.response.body.capabilityHealth.indexer, "lagging");

  const downHarness = makeHarness({
    indexerHealthProbe: async () => ({ ok: false, reason: "indexer_status_http_error" })
  });
  await downHarness.route({
    request: { method: "GET", headers: {} },
    response: downHarness.response,
    pathname: "/health"
  });
  assert.equal(downHarness.response.body.capabilityHealth.indexer, "unavailable");
});

test("GET /health degrades when service liveness is not ok", async () => {
  const { response, route } = makeHarness({
    stateStore: {
      constructor: { name: "MemoryStateStore" },
      healthCheck: async () => ({ ok: false, backend: "memory", mode: "memory" })
    }
  });

  const handled = await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/health"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.status, "degraded");
  assert.equal(response.body.serviceHealth.ok, false);
});

test("GET /health reports verifier degradation as a critical warning without returning 503", async () => {
  const submittedJobAutoVerifierHealth = {
    ok: false,
    enabled: true,
    running: true,
    state: "submitted_session_persistently_skipped",
    persistentSubmittedFailureCount: 2,
    persistentSubmittedFailures: [
      { sessionId: "session-1" },
      { sessionId: "session-2" }
    ]
  };
  const { response, route } = makeHarness({
    service: {
      submittedJobAutoVerifier: {
        getHealth: async () => submittedJobAutoVerifierHealth
      },
      xcmSettlementWatcher: {
        getStatus: async () => ({ enabled: true, running: true, pendingCount: 0 })
      }
    }
  });

  await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/health"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.serviceHealth.ok, true);
  assert.deepEqual(
    response.body.components.submittedJobAutoVerifier,
    submittedJobAutoVerifierHealth
  );
  assert.ok(response.body.warnings.some((warning) => (
    warning.code === "submitted_session_persistently_skipped"
      && warning.severity === "critical"
      && warning.message.includes("persistent submitted session count: 2")
  )));
});

test("GET /metrics emits Prometheus text with CORS and request id headers", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/metrics"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/plain/);
  assert.equal(response.headers["access-control-allow-origin"], "https://app.averray.test");
  assert.equal(response.headers["x-request-id"], "req-test");
  assert.match(response.body, /# HELP http_requests_total/);
  assert.deepEqual(calls, [["serializeMetrics"], ["chainHealth"]]);
});

test("GET /metrics fails closed when auth is required but no token is configured", async () => {
  const { response, route } = makeHarness({ metricsAuthRequired: true });

  const handled = await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/metrics"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { error: "metrics_auth_unconfigured" });
});

test("GET /metrics rejects missing or wrong bearer tokens", async () => {
  const { response, route } = makeHarness({
    metricsAuthRequired: true,
    metricsBearerToken: "metrics-token-1234567890"
  });

  const missing = await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/metrics"
  });
  assert.equal(missing, true);
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { error: "unauthorized" });

  const wrongResponse = makeResponse();
  const wrong = await route({
    request: { method: "GET", headers: { authorization: "Bearer wrong-token" } },
    response: wrongResponse,
    pathname: "/metrics"
  });
  assert.equal(wrong, true);
  assert.equal(wrongResponse.statusCode, 401);
  assert.deepEqual(wrongResponse.body, { error: "unauthorized" });
});

test("GET /metrics accepts the configured bearer token", async () => {
  const { response, route } = makeHarness({
    metricsAuthRequired: true,
    metricsBearerToken: "metrics-token-1234567890"
  });

  const handled = await route({
    request: {
      method: "GET",
      headers: { authorization: "Bearer metrics-token-1234567890" }
    },
    response,
    pathname: "/metrics"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /# HELP http_requests_total/);
});

test("metrics auth config defaults to fail-closed in production", () => {
  assert.deepEqual(
    resolveMetricsAuthConfig({ NODE_ENV: "production", METRICS_BEARER_TOKEN: "  token-value  " }),
    { metricsBearerToken: "token-value", metricsAuthRequired: true }
  );
  assert.deepEqual(
    resolveMetricsAuthConfig({ NODE_ENV: "production", METRICS_AUTH_REQUIRED: "0" }),
    { metricsBearerToken: undefined, metricsAuthRequired: false }
  );
  assert.deepEqual(
    resolveMetricsAuthConfig({ NODE_ENV: "test" }),
    { metricsBearerToken: undefined, metricsAuthRequired: false }
  );
});

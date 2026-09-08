import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MemoryStateStore, RedisStateStore } from "../core/state-store.js";
import { createOperationalRoutes, resolveMetricsAuthConfig } from "../protocols/http/operational-routes.js";
import { summarizeSponsoredHubOutflows } from "./overnight-ledger.js";
import { createVerifyRevenueMetrics, summarizeVerifyCaptures } from "./verify-revenue-metrics.js";
import { VerificationProfileRegistry } from "./verification-profile-registry.js";
import { VerificationRunService } from "./verification-run-service.js";

const tx = (id) => `0x${String(id).padStart(64, "0")}`;
const capture = (id, outcome = "approved") => ({
  runId: `verify-${id}`, status: "complete", verdict: { outcome },
  billing: { status: "captured", amountRaw: "5000000", asset: "USDC", network: "eip155:8453", transactionHash: tx(id) }
});
const total = (rows) => {
  const summary = summarizeVerifyCaptures(rows);
  return summary.approved.amountRaw + summary.rejected.amountRaw;
};

test("inconclusive Verify runs never increase billed volume; approved and rejected both count", () => {
  const decisive = [capture(1), capture(2, "rejected")];
  assert.equal(total(decisive), 10_000_000n);
  for (const outcome of ["inconclusive", "platform_fault"]) {
    // Even a corrupt captured marker must not make a non-decisive verdict revenue.
    assert.equal(total([...decisive, capture(3, outcome)]), 10_000_000n);
  }
  for (const status of ["authorized", "not_billed", "failed"]) {
    const row = capture(4);
    row.billing.status = status;
    assert.equal(total([...decisive, row]), 10_000_000n);
  }
  const unconfirmed = capture(5);
  delete unconfirmed.billing.transactionHash;
  assert.equal(total([...decisive, unconfirmed]), 10_000_000n);
  assert.equal(total([...decisive, ...decisive]), 10_000_000n, "repeated scrapes/SCAN duplicates must not double count");
});

test("poster fees and claim-bond fees never enter Verify GMV", () => {
  const fees = [
    { topic: "poster.fee", data: { feeBps: 500, amountRaw: "9000000" } },
    { sessionId: "bond", status: "resolved", claimEconomics: { feeBps: 200 }, settlement: { protocolFeeAmountRaw: "7000000" } },
    { ...capture(3), runId: "poster-payment" },
    { ...capture(4), billing: { ...capture(4).billing, network: "eip155:420420419" } },
    { rewardBank: { liquidRaw: "42075000" } }
  ];
  assert.equal(total(fees), 0n);
  assert.equal(total([capture(1), ...fees]), 5_000_000n);
});

test("revenue is read from the real finalizer's persisted confirmed billing, not authorizations", async () => {
  const stateStore = new MemoryStateStore();
  const profileRegistry = new VerificationProfileRegistry();
  const profile = profileRegistry.get("git-patch-tests-v1", 1);
  let captures = 0;
  const authorization = { id: "fixture", customer: `0x${"1".repeat(40)}`, amountRaw: "5000000", asset: "USDC", network: "eip155:8453" };
  const service = new VerificationRunService({
    stateStore, profileRegistry,
    paymentGate: {
      async authorize() { return authorization; },
      async capture() { captures += 1; return { transactionHash: tx(1) }; },
      async release() {}
    }
  });
  const run = await service.createRun({ ...profile.workedExample.request, paymentProof: "offline-fixture" });
  assert.equal(total((await stateStore.scanVerificationRuns()).runs), 0n);
  await service.finalizeExecution({
    authorization, profile, run,
    execution: {
      status: "decidable", evidence: "source_binding_verified tests_passed",
      artifactHash: tx(3), report: { verdict: "PASS" }, environment: { kind: "test" },
      sourceBinding: { method: "git-bundle", verified: true, ref: run.target.commit, bundleHash: tx(2) }
    }
  });
  assert.equal(captures, 1);
  const persisted = await stateStore.getVerificationRun(run.runId);
  assert.equal(persisted.verdict.outcome, "approved");
  assert.equal(persisted.billing.status, "captured");
  assert.equal(total((await stateStore.scanVerificationRuns()).runs), 5_000_000n);
});

function operational(store, config) {
  return createOperationalRoutes({
    authConfig: { mode: "strict", jwtBackend: "hmac", domain: "test.invalid", chainId: "1", secrets: ["fixture"] },
    gateway: { isEnabled: () => false, healthCheck: async () => ({ ok: true, enabled: false }) },
    getRewardBankHealth: async () => ({}),
    service: { submittedJobAutoVerifier: { getHealth: async () => ({ ok: true, enabled: true, running: true, state: "running" }) } },
    stateStore: store,
    metrics: { serialize: () => "# process metrics\n" },
    respond(response, code, body) { response.statusCode = code; response.body = body; },
    ...config
  });
}
async function request(route, pathname, authorization) {
  const response = {
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(body) { this.body = body; }
  };
  await route({ request: { method: "GET", headers: { authorization } }, response, pathname });
  return response;
}

test("Verify and sponsorship counters are bearer-only and never public health figures", async () => {
  const store = new MemoryStateStore();
  await store.updateVerificationRun("verify-1", capture(1));
  const config = resolveMetricsAuthConfig({ NODE_ENV: "production", METRICS_BEARER_TOKEN: "test-metrics-only" });
  const route = operational(store, config);
  assert.equal((await request(route, "/metrics")).statusCode, 401);
  assert.equal((await request(route, "/metrics", "Bearer wrong")).statusCode, 401);
  const privateResult = await request(route, "/metrics", "Bearer test-metrics-only");
  assert.equal(privateResult.statusCode, 200);
  assert.match(privateResult.body, /averray_verify_billed_usdc_total\{network="eip155:8453",outcome="approved"\} 5\.0/u);
  assert.match(privateResult.body, /averray_hub_claim_subsidy_estimate_usdc/u);
  assert.equal(privateResult.headers["cache-control"], "private, no-store");
  const health = await request(route, "/health");
  assert.equal(health.statusCode, 200);
  assert.doesNotMatch(JSON.stringify(health.body), /averray_(?:verify_billed|hub_claim_subsidy|hub_first_withdrawal)|financial_metrics/u);
  assert.equal((await request(operational(store, resolveMetricsAuthConfig({ NODE_ENV: "production" })), "/metrics")).statusCode, 503);
  // Even explicitly permissive local process metrics cannot disclose finances,
  // including after an authenticated scrape populated the held reading.
  const local = operational(store, { ...config, metricsAuthRequired: false });
  await request(local, "/metrics", "Bearer test-metrics-only");
  assert.doesNotMatch((await request(local, "/metrics")).body, /averray_/u);
  for (const file of ["public-metadata-routes.js", "transparency-routes.js", "deposit-pool-routes.js"]) {
    const source = readFileSync(new URL(`../protocols/http/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /verify-revenue-metrics|financialMetrics|averray_verify_billed|averray_hub_/u);
  }
});

test("Hub retained outflows reuse subsidy estimates and grants without treating reward-bank capital as spend", () => {
  const session = { sessionId: "one", onboardingSubsidy: { estimatedClaimSubsidyUsdc: "0.084" } };
  const grant = { id: "grant", txHash: tx(20), topic: "operator_gas.first_withdrawal_granted", data: { amount: { raw: "50000000000000000" } } };
  const summary = summarizeSponsoredHubOutflows({
    sessions: [session, session],
    events: [grant, { ...grant, id: "duplicate-event" }, { topic: "account.deposited", data: { amountRaw: "42075000" } }]
  });
  assert.deepEqual(summary, { claimSubsidyEstimateRaw: "84000", firstWithdrawalGrantRaw: "50000000000000000", firstWithdrawalGrantCount: 1 });
});

test("financial metrics reconstruct on restart, single-flight reads and omit unavailable figures", async () => {
  const store = new MemoryStateStore();
  await store.updateVerificationRun("verify-1", capture(1));
  let reads = 0;
  const scan = store.scanVerificationRuns.bind(store);
  store.scanVerificationRuns = async (...args) => { reads += 1; return scan(...args); };
  const collect = createVerifyRevenueMetrics({ stateStore: store, now: () => 1_000 });
  const results = await Promise.all(Array.from({ length: 10 }, () => collect()));
  assert.equal(new Set(results).size, 1);
  assert.equal(reads, 1);
  assert.equal(await createVerifyRevenueMetrics({ stateStore: store, now: () => 1_000 })(), results[0]);
  store.scanVerificationRuns = async () => { throw new Error("unavailable"); };
  const unavailable = await createVerifyRevenueMetrics({ stateStore: store })();
  assert.match(unavailable, /averray_financial_metrics_available\{source="verify"\} 0/u);
  assert.doesNotMatch(unavailable, /averray_verify_billed/u);
  assert.match(unavailable, /averray_hub_operator_transaction_fees_available 0/u);
});

test("verification metrics page existing memory and Redis records without reading authorization keys", async () => {
  const memory = new MemoryStateStore();
  await memory.updateVerificationRun("verify-1", capture(1));
  await memory.updateVerificationRun("verify-2", capture(2));
  const first = await memory.scanVerificationRuns({ limit: 1 });
  assert.equal(first.nextCursor, "1");
  first.runs[0].billing.amountRaw = "999";
  assert.equal((await memory.getVerificationRun("verify-1")).billing.amountRaw, "5000000");
  assert.equal((await memory.scanVerificationRuns({ cursor: first.nextCursor, limit: 1 })).nextCursor, "0");
  const redis = new RedisStateStore("redis://unused", "metrics-test");
  redis.connect = async () => {};
  redis.client = {
    async scan(cursor, options) {
      assert.equal(cursor, "0");
      assert.equal(options.MATCH, "metrics-test:verification-run:*");
      return { cursor: "7", keys: ["metrics-test:verification-run:verify-1"] };
    },
    async mGet(keys) {
      assert.deepEqual(keys, ["metrics-test:verification-run:verify-1"]);
      return [JSON.stringify(capture(1))];
    }
  };
  assert.deepEqual(await redis.scanVerificationRuns(), { runs: [capture(1)], nextCursor: "7" });
});

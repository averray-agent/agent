import test from "node:test";
import assert from "node:assert/strict";

import {
  BLOCKCHAIN_STATUS,
  GAS_SPONSOR_STATUS,
  INDEXER_STATUS,
  TREASURY_MUTATIONS_STATUS,
  XCM_OBSERVER_STATUS,
  buildProductHealthSnapshot,
  buildCapabilityWarnings,
  createProductHealthSnapshotProvider,
  resolveCapabilityHealth,
  resolveHealthAddresses,
  resolveServiceHealth
} from "./health-capability.js";

// ─── resolveServiceHealth ────────────────────────────────────────────

test("resolveServiceHealth — ok when state-store reachable and auth config loaded (strict)", () => {
  const result = resolveServiceHealth({
    stateStoreHealth: { ok: true, backend: "RedisStateStore", mode: "durable" },
    authConfig: { mode: "strict", domain: "api.averray.com", chainId: 420420417, secrets: ["x".repeat(40)] }
  });
  assert.equal(result.ok, true);
  assert.equal(result.components.api.ok, true);
  assert.equal(result.components.stateStore.ok, true);
  assert.equal(result.components.stateStore.backend, "RedisStateStore");
  assert.equal(result.components.auth.ok, true);
  assert.equal(result.components.auth.mode, "strict");
});

test("resolveServiceHealth — ok in permissive mode without secrets (dev posture)", () => {
  const result = resolveServiceHealth({
    stateStoreHealth: { ok: true, backend: "MemoryStateStore", mode: "ephemeral" },
    authConfig: { mode: "permissive", domain: "localhost", chainId: 0, secrets: [] }
  });
  assert.equal(result.ok, true);
  assert.equal(result.components.auth.ok, true);
});

test("resolveServiceHealth — degraded when state-store unreachable", () => {
  const result = resolveServiceHealth({
    stateStoreHealth: { ok: false, backend: "RedisStateStore", error: "ECONNREFUSED" },
    authConfig: { mode: "strict", domain: "api.averray.com", chainId: 420420417, secrets: ["x".repeat(40)] }
  });
  assert.equal(result.ok, false);
  assert.equal(result.components.stateStore.ok, false);
});

test("resolveServiceHealth — degraded when strict-mode auth has no secrets", () => {
  const result = resolveServiceHealth({
    stateStoreHealth: { ok: true },
    authConfig: { mode: "strict", domain: "api.averray.com", chainId: 420420417, secrets: [] }
  });
  assert.equal(result.ok, false);
  assert.equal(result.components.auth.ok, false);
});

// ─── resolveCapabilityHealth ─────────────────────────────────────────

test("resolveCapabilityHealth — config A: full chain enabled + healthy", () => {
  // From the audit board's verification approach. Full chain enabled
  // and the mutation backend ready to mutate. xcmObserver/indexer are
  // independent of chain health; they reflect their own probes.
  const result = resolveCapabilityHealth({
    blockchainHealth: { ok: true, enabled: true, blockNumber: 1234567 },
    mutationBackendStatus: { ok: true, mode: "required", chainAvailable: true },
    xcmWatcherStatus: { enabled: true, running: true, pendingCount: 3 },
    indexerProbe: { ok: true, blockTimestamp: Math.floor(Date.now() / 1000), lagBudgetSeconds: 600 },
    gasSponsorHealth: { ok: true, enabled: true }
  });
  assert.equal(result.blockchain, BLOCKCHAIN_STATUS.ENABLED);
  assert.equal(result.treasuryMutations, TREASURY_MUTATIONS_STATUS.AVAILABLE);
  assert.equal(result.xcmObserver, XCM_OBSERVER_STATUS.LIVE);
  assert.equal(result.indexer, INDEXER_STATUS.SYNCED);
  assert.equal(result.gasSponsor, GAS_SPONSOR_STATUS.ENABLED);
});

test("resolveCapabilityHealth — config B: chain disabled with MUTATION_BACKEND=memory (dev)", () => {
  // Trust-core-only dev posture. Chain is intentionally off; treasury
  // mutations route through the memory backend. The audit board calls
  // this "service ok + treasuryMutations unavailable" — wait, the
  // memory backend IS available (just not chain-backed). The board
  // means: when chain is disabled AND mutation-backend=required, the
  // treasury cap should be unavailable. With memory mode allowed,
  // treasury is available via memory. This test locks the dev shape.
  const result = resolveCapabilityHealth({
    blockchainHealth: { ok: false, enabled: false, mode: "disabled" },
    mutationBackendStatus: { ok: true, mode: "memory", chainRequired: false, chainAvailable: false },
    xcmWatcherStatus: { enabled: false, running: false, pendingCount: 0 },
    indexerProbe: undefined,
    gasSponsorHealth: { ok: true, enabled: false }
  });
  assert.equal(result.blockchain, BLOCKCHAIN_STATUS.DISABLED);
  assert.equal(result.treasuryMutations, TREASURY_MUTATIONS_STATUS.AVAILABLE);
  assert.equal(result.xcmObserver, XCM_OBSERVER_STATUS.UNAVAILABLE);
  assert.equal(result.indexer, INDEXER_STATUS.UNAVAILABLE);
  assert.equal(result.gasSponsor, GAS_SPONSOR_STATUS.DISABLED);
});

test("resolveCapabilityHealth — config C: chain unhealthy + MUTATION_BACKEND=required (production-misconfigured)", () => {
  // The exact failure shape the audit calls "launch-blocking": chain
  // gateway is reporting unhealthy AND the production policy requires
  // chain. treasuryMutations resolves to unavailable; serviceHealth
  // (computed separately) can still be ok because the API itself
  // responds.
  const result = resolveCapabilityHealth({
    blockchainHealth: { ok: false, enabled: true, error: "rpc_unreachable" },
    mutationBackendStatus: { ok: false, mode: "required", chainRequired: true, chainAvailable: false, reason: "blockchain gateway is unhealthy" },
    xcmWatcherStatus: undefined,
    indexerProbe: undefined,
    gasSponsorHealth: { ok: true, enabled: false }
  });
  assert.equal(result.blockchain, BLOCKCHAIN_STATUS.UNHEALTHY);
  assert.equal(result.treasuryMutations, TREASURY_MUTATIONS_STATUS.UNAVAILABLE);
  assert.equal(result.xcmObserver, XCM_OBSERVER_STATUS.UNAVAILABLE);
  assert.equal(result.indexer, INDEXER_STATUS.UNAVAILABLE);
  assert.equal(result.gasSponsor, GAS_SPONSOR_STATUS.DISABLED);
});

test("resolveCapabilityHealth — xcmObserver: live when running with pending observations", () => {
  const result = resolveCapabilityHealth({
    blockchainHealth: { ok: true, enabled: true },
    mutationBackendStatus: { ok: true },
    xcmWatcherStatus: { enabled: true, running: true, pendingCount: 5 }
  });
  assert.equal(result.xcmObserver, XCM_OBSERVER_STATUS.LIVE);
});

test("resolveCapabilityHealth — xcmObserver: staged when running with no pending observations", () => {
  const result = resolveCapabilityHealth({
    blockchainHealth: { ok: true, enabled: true },
    mutationBackendStatus: { ok: true },
    xcmWatcherStatus: { enabled: true, running: true, pendingCount: 0 }
  });
  assert.equal(result.xcmObserver, XCM_OBSERVER_STATUS.STAGED);
});

test("resolveCapabilityHealth — xcmObserver: unavailable when watcher not running", () => {
  const result = resolveCapabilityHealth({
    blockchainHealth: { ok: true, enabled: true },
    mutationBackendStatus: { ok: true },
    xcmWatcherStatus: { enabled: true, running: false, pendingCount: 0 }
  });
  assert.equal(result.xcmObserver, XCM_OBSERVER_STATUS.UNAVAILABLE);
});

test("resolveCapabilityHealth — indexer: lagging when head block timestamp exceeds lag budget", () => {
  const tenMinutesAgo = Math.floor(Date.now() / 1000) - 700; // beyond default 600s budget
  const result = resolveCapabilityHealth({
    blockchainHealth: { ok: true, enabled: true },
    mutationBackendStatus: { ok: true },
    indexerProbe: { ok: true, blockTimestamp: tenMinutesAgo, lagBudgetSeconds: 600 }
  });
  assert.equal(result.indexer, INDEXER_STATUS.LAGGING);
});

test("resolveCapabilityHealth — indexer: unavailable when probe is missing or unhealthy", () => {
  assert.equal(
    resolveCapabilityHealth({ indexerProbe: undefined }).indexer,
    INDEXER_STATUS.UNAVAILABLE
  );
  assert.equal(
    resolveCapabilityHealth({ indexerProbe: { ok: false } }).indexer,
    INDEXER_STATUS.UNAVAILABLE
  );
});

test("resolveCapabilityHealth — blockchain: disabled when health probe omitted entirely", () => {
  const result = resolveCapabilityHealth({});
  assert.equal(result.blockchain, BLOCKCHAIN_STATUS.DISABLED);
  assert.equal(result.treasuryMutations, TREASURY_MUTATIONS_STATUS.UNAVAILABLE);
  assert.equal(result.gasSponsor, GAS_SPONSOR_STATUS.DISABLED);
});

// ─── buildCapabilityWarnings ─────────────────────────────────────────

test("buildCapabilityWarnings — empty array when every capability is in its happy state", () => {
  const warnings = buildCapabilityWarnings({
    blockchain: BLOCKCHAIN_STATUS.ENABLED,
    treasuryMutations: TREASURY_MUTATIONS_STATUS.AVAILABLE,
    xcmObserver: XCM_OBSERVER_STATUS.LIVE,
    indexer: INDEXER_STATUS.SYNCED,
    gasSponsor: GAS_SPONSOR_STATUS.ENABLED
  });
  assert.deepEqual(warnings, []);
});

test("buildCapabilityWarnings — chain-disabled posture: treasury critical, blockchain/xcm/indexer warning", () => {
  const warnings = buildCapabilityWarnings({
    blockchain: BLOCKCHAIN_STATUS.DISABLED,
    treasuryMutations: TREASURY_MUTATIONS_STATUS.UNAVAILABLE,
    xcmObserver: XCM_OBSERVER_STATUS.UNAVAILABLE,
    indexer: INDEXER_STATUS.UNAVAILABLE,
    gasSponsor: GAS_SPONSOR_STATUS.DISABLED
  });
  const treasury = warnings.find((w) => w.code === "treasury_mutations_unavailable");
  assert.ok(treasury);
  assert.equal(treasury.severity, "critical");
  const blockchain = warnings.find((w) => w.code === "blockchain_disabled");
  assert.ok(blockchain);
  assert.equal(blockchain.severity, "warning");
  assert.ok(warnings.some((w) => w.code === "xcm_observer_unavailable"));
  assert.ok(warnings.some((w) => w.code === "indexer_unavailable"));
  assert.ok(warnings.some((w) => w.code === "gas_sponsor_disabled"));
});

test("buildCapabilityWarnings — unhealthy chain is critical at the blockchain layer too", () => {
  const warnings = buildCapabilityWarnings({
    blockchain: BLOCKCHAIN_STATUS.UNHEALTHY,
    treasuryMutations: TREASURY_MUTATIONS_STATUS.UNAVAILABLE,
    xcmObserver: XCM_OBSERVER_STATUS.UNAVAILABLE,
    indexer: INDEXER_STATUS.UNAVAILABLE,
    gasSponsor: GAS_SPONSOR_STATUS.ENABLED
  });
  const blockchain = warnings.find((w) => w.code === "blockchain_unhealthy");
  assert.ok(blockchain);
  assert.equal(blockchain.severity, "critical");
});

test("buildCapabilityWarnings — degraded treasury (memory-mode dev) is warning, not critical", () => {
  const warnings = buildCapabilityWarnings({
    blockchain: BLOCKCHAIN_STATUS.DISABLED,
    treasuryMutations: TREASURY_MUTATIONS_STATUS.DEGRADED,
    xcmObserver: XCM_OBSERVER_STATUS.UNAVAILABLE,
    indexer: INDEXER_STATUS.UNAVAILABLE,
    gasSponsor: GAS_SPONSOR_STATUS.DISABLED
  });
  const treasury = warnings.find((w) => w.code === "treasury_mutations_degraded");
  assert.ok(treasury);
  assert.equal(treasury.severity, "warning");
});

test("buildCapabilityWarnings — null input resolves to empty array (no crash)", () => {
  assert.deepEqual(buildCapabilityWarnings(undefined), []);
  assert.deepEqual(buildCapabilityWarnings(null), []);
});

// ─── product-health monitor blocks ───────────────────────────────────

const TEST_DEPLOYMENT = Object.freeze({
  verifier: "0x31ad432dFe083B998c69B6dB88A984ec5207ab7F",
  treasuryReserve: "0x6778F050eAc8313e4dbB176d7BAB44510E833ac8",
  contracts: {
    treasuryPolicy: "0x9999999999999999999999999999999999999999",
    token: "0x0000053900000000000000000000000001200000",
    agentAccountCore: "0x71B111d8c9DF84Be26cb9067D27dAd7A2d5E7e08",
    escrowCore: "0x70d661C3A5DdE64bB8cbFa0A5336470c1662eFCa"
  }
});

test("resolveHealthAddresses exposes monitor addresses without logic-only TreasuryPolicy", () => {
  const addresses = resolveHealthAddresses({ deploymentManifest: TEST_DEPLOYMENT, env: {} });
  assert.deepEqual(addresses, {
    token: "0x0000053900000000000000000000000001200000",
    agentAccountCore: "0x71B111d8c9DF84Be26cb9067D27dAd7A2d5E7e08",
    escrowCore: "0x70d661C3A5DdE64bB8cbFa0A5336470c1662eFCa",
    settlementSigner: "0x31ad432dFe083B998c69B6dB88A984ec5207ab7F",
    treasuryReserve: "0x6778F050eAc8313e4dbB176d7BAB44510E833ac8"
  });
  assert.equal(Object.hasOwn(addresses, "treasuryPolicy"), false);
});

test("buildProductHealthSnapshot reports reward bank and Redis settlement counters", async () => {
  const now = new Date("2026-07-05T12:00:00.000Z");
  const receiptStore = new Map([
    ["dispute_verdict:dispute-revert", {
      statusCode: 409,
      response: { code: "blockchain_revert" },
      createdAt: "2026-07-05T11:50:00.000Z"
    }]
  ]);
  const stateStore = {
    async listRecentSessions(limit) {
      assert.equal(limit, 1000);
      return [
        { sessionId: "settled-approved", status: "resolved", resolvedAt: "2026-07-05T11:00:00.000Z" },
        { sessionId: "settled-rejected", status: "rejected", rejectedAt: "2026-07-05T10:30:00.000Z" },
        { sessionId: "stuck-submitted", status: "submitted", submittedAt: "2026-07-05T11:20:00.000Z" },
        { sessionId: "submit-failed", status: "claimed", submitFailedAt: "2026-07-05T11:55:00.000Z" },
        { sessionId: "receipt-failed", disputeId: "dispute-revert", status: "disputed", updatedAt: "2026-07-05T11:45:00.000Z" },
        { sessionId: "old-failed", status: "claimed", submitFailedAt: "2026-07-03T11:55:00.000Z" }
      ];
    },
    async getMutationReceipt(bucket, key) {
      return receiptStore.get(`${bucket}:${key}`);
    }
  };
  const gateway = {
    isEnabled: () => true,
    async getTreasuryPolicyStatus() {
      return {
        signerFunding: {
          account: "0x31ad432dFe083B998c69B6dB88A984ec5207ab7F",
          assets: [{
            symbol: "USDC",
            address: "0x0000053900000000000000000000000001200000",
            decimals: 6,
            readable: true,
            liquid: 42.3,
            liquidRaw: "42300000"
          }]
        }
      };
    }
  };

  const snapshot = await buildProductHealthSnapshot({
    gateway,
    stateStore,
    deploymentManifest: TEST_DEPLOYMENT,
    now
  });

  assert.deepEqual(snapshot.rewardBank, {
    liquid: 42.3,
    liquidRaw: "42300000",
    decimals: 6,
    asOf: "2026-07-05T12:00:00.000Z",
    readable: true,
    account: "0x31ad432dFe083B998c69B6dB88A984ec5207ab7F",
    asset: "USDC",
    source: "agent_account_position"
  });
  assert.deepEqual(snapshot.settlement, {
    settled24h: 2,
    stuck: 1,
    failed24h: 2,
    asOf: "2026-07-05T12:00:00.000Z",
    source: "backend_state_store",
    readable: true
  });
});

test("createProductHealthSnapshotProvider caches public health recompute", async () => {
  let current = new Date("2026-07-05T12:00:00.000Z");
  let scans = 0;
  const provider = createProductHealthSnapshotProvider({
    gateway: { isEnabled: () => false },
    stateStore: {
      async listRecentSessions() {
        scans += 1;
        return [];
      }
    },
    deploymentManifest: TEST_DEPLOYMENT,
    now: () => current,
    cacheMs: 60_000
  });

  await provider();
  await provider();
  assert.equal(scans, 1);

  current = new Date("2026-07-05T12:01:01.000Z");
  await provider();
  assert.equal(scans, 2);
});

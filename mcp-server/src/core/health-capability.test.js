import test from "node:test";
import assert from "node:assert/strict";

import {
  BLOCKCHAIN_STATUS,
  GAS_SPONSOR_STATUS,
  INDEXER_STATUS,
  TREASURY_MUTATIONS_STATUS,
  XCM_OBSERVER_STATUS,
  buildCapabilityWarnings,
  resolveCapabilityHealth,
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

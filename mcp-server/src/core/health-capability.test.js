import test from "node:test";
import assert from "node:assert/strict";

import {
  BLOCKCHAIN_STATUS,
  EXTERNAL_POSTING_STATUS,
  GAS_SPONSOR_STATUS,
  INDEXER_STATUS,
  TREASURY_MUTATIONS_STATUS,
  XCM_OBSERVER_STATUS,
  buildProductHealthSnapshot,
  buildCapabilityWarnings,
  createNonBlockingBlockchainHealthProvider,
  createProductHealthSnapshotProvider,
  createRewardBankHealthProvider,
  loadDeploymentManifestFromUrl,
  resolveCapabilityHealth,
  resolveHealthAddresses,
  resolveServiceHealth
} from "./health-capability.js";
import {
  buildOnboardingInventoryWarnings,
  resolveOnboardingInventoryHealth
} from "./onboarding-inventory.js";

// ─── resolveServiceHealth ────────────────────────────────────────────

test("resolveServiceHealth — ok when state-store reachable and auth config loaded (strict)", () => {
  const result = resolveServiceHealth({
    stateStoreHealth: { ok: true, backend: "RedisStateStore", mode: "durable" },
    // The fixture describes an HMAC deployment, so it names the backend rather than
    // relying on a default — the default is kms, and a config that never said which
    // backend it runs is exactly the one health should report as unhealthy.
    authConfig: {
      mode: "strict",
      jwtBackend: "hmac",
      domain: "api.averray.com",
      chainId: 420420417,
      secrets: ["x".repeat(40)]
    }
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

test("resolveServiceHealth — ok in strict KMS-only mode without HMAC secrets", () => {
  const result = resolveServiceHealth({
    stateStoreHealth: { ok: true, backend: "RedisStateStore", mode: "durable" },
    authConfig: {
      mode: "strict",
      domain: "api.averray.com",
      chainId: 420420419,
      jwtBackend: "kms",
      kmsJwt: { keyId: "arn:aws:kms:eu-central-2:123456789012:key/mrk-test" },
      secrets: []
    }
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

test("resolveServiceHealth — degraded when strict HMAC auth has no secret", () => {
  const result = resolveServiceHealth({
    stateStoreHealth: { ok: true },
    authConfig: {
      mode: "strict",
      domain: "api.averray.com",
      chainId: 420420417,
      jwtBackend: "hmac",
      secrets: []
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.components.auth.ok, false);
});

test("resolveServiceHealth — degraded when strict KMS auth has no KMS config", () => {
  const result = resolveServiceHealth({
    stateStoreHealth: { ok: true },
    authConfig: {
      mode: "strict",
      domain: "api.averray.com",
      chainId: 420420419,
      jwtBackend: "kms",
      kmsJwt: null,
      secrets: []
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.components.auth.ok, false);
});

test("resolveServiceHealth — keeps verifier faults visible without degrading API liveness", () => {
  const submittedJobAutoVerifierHealth = {
    ok: false,
    state: "submitted_session_persistently_skipped",
    persistentSubmittedFailureCount: 2
  };
  const result = resolveServiceHealth({
    stateStoreHealth: { ok: true, backend: "RedisStateStore", mode: "durable" },
    authConfig: {
      mode: "strict",
      jwtBackend: "hmac",
      domain: "api.averray.test",
      chainId: 420420419,
      secrets: ["health-contract-test-secret"]
    },
    submittedJobAutoVerifierHealth
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.components.submittedJobAutoVerifier,
    submittedJobAutoVerifierHealth
  );
});

test("resolveServiceHealth — state-store failure still degrades API liveness", () => {
  const result = resolveServiceHealth({
    stateStoreHealth: { ok: false, backend: "RedisStateStore", mode: "durable" },
    authConfig: {
      mode: "strict",
      jwtBackend: "hmac",
      domain: "api.averray.test",
      chainId: 420420419,
      secrets: ["health-contract-test-secret"]
    },
    submittedJobAutoVerifierHealth: {
      ok: false,
      state: "submitted_session_persistently_skipped",
      persistentSubmittedFailureCount: 2
    }
  });

  assert.equal(result.ok, false);
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

test("resolveCapabilityHealth — external posting is disabled closed, staged when stale, and enabled only when current", () => {
  const closed = resolveCapabilityHealth({
    externalPostingMode: "closed",
    externalPostingWatcherStatus: { current: true, lagSeconds: 5 }
  });
  assert.equal(closed.externalPosting, EXTERNAL_POSTING_STATUS.DISABLED);
  assert.equal(closed.externalPostingWatcherLagSeconds, 5);

  const staged = resolveCapabilityHealth({
    externalPostingMode: "open",
    externalPostingWatcherStatus: { current: false, lagSeconds: 3_600 }
  });
  assert.equal(staged.externalPosting, EXTERNAL_POSTING_STATUS.STAGED);
  assert.equal(staged.externalPostingWatcherLagSeconds, 3_600);

  const enabled = resolveCapabilityHealth({
    externalPostingMode: "allowlist",
    externalPostingWatcherStatus: { current: true, lagSeconds: 30 }
  });
  assert.equal(enabled.externalPosting, EXTERNAL_POSTING_STATUS.ENABLED);
  assert.equal(enabled.externalPostingWatcherLagSeconds, 30);
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
    escrowCore: "0x70d661C3A5DdE64bB8cbFa0A5336470c1662eFCa",
    xcmWrapper: "0xEceE778e11B238D2fc096E56460e7B98DC7B26b8",
    hydrationUsdcAdapter: "0x631A09913B2403B18b2B659a1397916621b29b4c"
  }
});

test("resolveHealthAddresses exposes monitor addresses without logic-only TreasuryPolicy", () => {
  const addresses = resolveHealthAddresses({ deploymentManifest: TEST_DEPLOYMENT, env: {} });
  assert.deepEqual(addresses, {
    token: "0x0000053900000000000000000000000001200000",
    agentAccountCore: "0x71B111d8c9DF84Be26cb9067D27dAd7A2d5E7e08",
    escrowCore: "0x70d661C3A5DdE64bB8cbFa0A5336470c1662eFCa",
    xcmWrapper: "0xEceE778e11B238D2fc096E56460e7B98DC7B26b8",
    hydrationUsdcAdapter: "0x631A09913B2403B18b2B659a1397916621b29b4c",
    settlementSigner: "0x31ad432dFe083B998c69B6dB88A984ec5207ab7F",
    treasuryReserve: "0x6778F050eAc8313e4dbB176d7BAB44510E833ac8"
  });
  assert.equal(Object.hasOwn(addresses, "treasuryPolicy"), false);
});

test("resolveHealthAddresses falls back to runtime env when manifest is absent", () => {
  const addresses = resolveHealthAddresses({
    deploymentManifest: null,
    env: {
      AGENT_ACCOUNT_ADDRESS: "0x510918E24DEbcA163F306923CA234319e72b22d5",
      ESCROW_CORE_ADDRESS: "0xfE841c2dc58E4389b1AB59E3e42F9EB12A694Bea",
      XCM_WRAPPER_ADDRESS: "0xEceE778e11B238D2fc096E56460e7B98DC7B26b8",
      HYDRATION_USDC_ADAPTER_ADDRESS: "0x631A09913B2403B18b2B659a1397916621b29b4c",
      SIGNER_ADDRESS: "0x31ad432dFe083B998c69B6dB88A984ec5207ab7F",
      SUPPORTED_ASSETS_JSON: JSON.stringify([{
        symbol: "USDC",
        address: "0x0000053900000000000000000000000001200000"
      }]),
      USDC_LIQUIDITY_TREASURY_RESERVE_ACCOUNT: "0x1f8c4da4aaac79916350f1fabf1221309591b6f9"
    }
  });

  assert.deepEqual(addresses, {
    token: "0x0000053900000000000000000000000001200000",
    agentAccountCore: "0x510918E24DEbcA163F306923CA234319e72b22d5",
    escrowCore: "0xfE841c2dc58E4389b1AB59E3e42F9EB12A694Bea",
    xcmWrapper: "0xEceE778e11B238D2fc096E56460e7B98DC7B26b8",
    hydrationUsdcAdapter: "0x631A09913B2403B18b2B659a1397916621b29b4c",
    settlementSigner: "0x31ad432dFe083B998c69B6dB88A984ec5207ab7F",
    treasuryReserve: "0x1f8c4da4aaac79916350f1fabf1221309591b6f9"
  });
});

test("loadDeploymentManifestFromUrl treats a missing manifest as optional", () => {
  const manifest = loadDeploymentManifestFromUrl(new URL("./fixtures/missing-testnet-manifest.json", import.meta.url));
  assert.equal(manifest, null);
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
        {
          sessionId: "settled-approved",
          status: "resolved",
          claimedAt: "2026-07-05T10:45:00.000Z",
          submittedAt: "2026-07-05T10:50:00.000Z",
          resolvedAt: "2026-07-05T11:00:00.000Z"
        },
        {
          sessionId: "settled-rejected",
          status: "rejected",
          claimedAt: "2026-07-05T10:00:00.000Z",
          submittedAt: "2026-07-05T10:15:00.000Z",
          rejectedAt: "2026-07-05T10:30:00.000Z"
        },
        {
          sessionId: "stuck-submitted",
          status: "submitted",
          claimedAt: "2026-07-05T11:00:00.000Z",
          submittedAt: "2026-07-05T11:20:00.000Z"
        },
        {
          sessionId: "submit-failed",
          status: "claimed",
          claimedAt: "2026-07-05T11:40:00.000Z",
          submitFailedAt: "2026-07-05T11:55:00.000Z"
        },
        {
          sessionId: "receipt-failed",
          disputeId: "dispute-revert",
          status: "disputed",
          claimedAt: "2026-07-05T11:10:00.000Z",
          submittedAt: "2026-07-05T11:15:00.000Z",
          updatedAt: "2026-07-05T11:45:00.000Z"
        },
        {
          sessionId: "old-failed",
          status: "claimed",
          claimedAt: "2026-07-03T11:40:00.000Z",
          submitFailedAt: "2026-07-03T11:55:00.000Z"
        }
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
    claimed24h: 5,
    submitted24h: 4,
    settled24h: 2,
    paidSettled24h: 1,
    zeroPaySettled24h: 1,
    claimedNotSubmitted: 2,
    submittedNotSettled: 2,
    stuck: 1,
    failed24h: 2,
    asOf: "2026-07-05T12:00:00.000Z",
    source: "backend_state_store",
    readable: true
  });
});

test("settlement health partitions resolved, rejected, and closed terminals by payout expectation", async () => {
  const now = new Date("2026-07-05T12:00:00.000Z");
  const snapshot = await buildProductHealthSnapshot({
    gateway: { isEnabled: () => false },
    stateStore: {
      async listRecentSessions() {
        return [
          {
            sessionId: "paid-resolved",
            status: "resolved",
            resolvedAt: "2026-07-05T11:00:00.000Z"
          },
          {
            sessionId: "zero-pay-rejected",
            status: "rejected",
            rejectedAt: "2026-07-05T10:30:00.000Z"
          },
          {
            sessionId: "legacy-closed-without-release",
            status: "closed",
            closedAt: "2026-07-05T10:00:00.000Z"
          }
        ];
      }
    },
    deploymentManifest: TEST_DEPLOYMENT,
    now
  });

  assert.equal(snapshot.settlement.settled24h, 3);
  assert.equal(snapshot.settlement.paidSettled24h, 1);
  assert.equal(snapshot.settlement.zeroPaySettled24h, 2);
  assert.equal(
    snapshot.settlement.paidSettled24h + snapshot.settlement.zeroPaySettled24h,
    snapshot.settlement.settled24h
  );
});

test("onboarding inventory health warns when no real waiver-eligible claimable jobs exist", async () => {
  const now = new Date("2026-07-28T08:00:00.000Z");
  const health = await resolveOnboardingInventoryHealth({
    now,
    rewardBank: { readable: true, liquidRaw: "18500000", decimals: 6 },
    service: {
      listJobs: () => [{
        id: "governance-pro-001",
        tier: "pro",
        onboardingWaiverEligible: false
      }],
      attachClaimState: async (job) => ({ ...job, claimable: false })
    }
  });

  assert.deepEqual(health, {
    status: "warning",
    reason: "onboarding_waiver_inventory_empty",
    waiverEligibleClaimableJobs: 0,
    minimumWaiverEligibleClaimableJobs: 2,
    asOf: now.toISOString(),
    source: "job_catalog",
    readable: true
  });
  assert.equal(buildOnboardingInventoryWarnings(health)[0].code, "onboarding_waiver_inventory_empty");
});

test("onboarding inventory health is ready only with two real eligible claimable jobs", async () => {
  const jobs = [1, 2].map((index) => ({
    id: `wiki-real-${index}`,
    tier: "starter",
    source: { type: "wikipedia_article" },
    onboardingWaiverEligible: true
  }));
  const health = await resolveOnboardingInventoryHealth({
    service: {
      listJobs: () => jobs,
      attachClaimState: async (job) => ({ ...job, claimable: true })
    }
  });

  assert.equal(health.status, "ready");
  assert.equal(health.waiverEligibleClaimableJobs, 2);
  assert.deepEqual(buildOnboardingInventoryWarnings(health), []);
});

test("onboarding health warns at 20% subsidy headroom before exhaustion", () => {
  const onboarding = {
    status: "ready",
    reason: "onboarding_waiver_inventory_ready",
    waiverEligibleClaimableJobs: 2,
    minimumWaiverEligibleClaimableJobs: 2,
    subsidy: {
      dailyBudgetUsdc: 8,
      allocatedUsdc: 6.4,
      headroomUsdc: 1.6
    }
  };

  assert.deepEqual(buildOnboardingInventoryWarnings(onboarding), [{
    code: "onboarding_subsidy_headroom_low",
    severity: "warning",
    message: "Only 1.6 USDC of the 8 USDC daily onboarding subsidy remains; consider raising the budget before tier-0 claims are blocked."
  }]);

  onboarding.subsidy = {
    dailyBudgetUsdc: 8,
    allocatedUsdc: 6.39,
    headroomUsdc: 1.61
  };
  assert.deepEqual(buildOnboardingInventoryWarnings(onboarding), []);
});

test("onboarding health reports exhaustion instead of duplicating the low-headroom warning", () => {
  const warnings = buildOnboardingInventoryWarnings({
    status: "ready",
    reason: "onboarding_waiver_inventory_ready",
    waiverEligibleClaimableJobs: 2,
    minimumWaiverEligibleClaimableJobs: 2,
    subsidy: {
      dailyBudgetUsdc: 8,
      allocatedUsdc: 8,
      headroomUsdc: 0
    }
  });

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "onboarding_subsidy_exhausted");
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

test("non-blocking chain health serves last-known-good with asOf, then marks it stale", async () => {
  let current = new Date("2026-07-28T08:00:00.000Z");
  let failReads = false;
  const provider = createNonBlockingBlockchainHealthProvider({
    gateway: {
      isEnabled: () => true,
      async healthCheck() {
        return failReads
          ? { ok: false, enabled: true, error: "rpc_throttled" }
          : { ok: true, enabled: true, blockNumber: 18_750_000 };
      }
    },
    now: () => current,
    refreshMs: 1_000,
    maxAgeMs: 60_000
  });
  await new Promise((resolve) => setImmediate(resolve));

  const live = provider();
  assert.equal(live.ok, true);
  assert.equal(live.blockNumber, 18_750_000);
  assert.equal(live.asOf, "2026-07-28T08:00:00.000Z");

  failReads = true;
  current = new Date("2026-07-28T08:00:02.000Z");
  provider();
  await new Promise((resolve) => setImmediate(resolve));
  const fallback = provider();
  assert.equal(fallback.ok, true);
  assert.equal(fallback.blockNumber, 18_750_000);
  assert.equal(fallback.fallback, "last_known_good");
  assert.equal(fallback.asOf, "2026-07-28T08:00:00.000Z");

  current = new Date("2026-07-28T08:01:01.000Z");
  provider();
  await new Promise((resolve) => setImmediate(resolve));
  const stale = provider();
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.blockNumber, 18_750_000);
  assert.equal(stale.asOf, "2026-07-28T08:00:00.000Z");
});

test("reward-bank provider uses fresh last-known-good evidence, then fails closed when stale", async () => {
  let current = new Date("2026-07-27T12:00:00.000Z");
  let reads = 0;
  let failReads = false;
  const provider = createRewardBankHealthProvider({
    gateway: {
      isEnabled: () => true,
      async getTreasuryPolicyStatus() {
        reads += 1;
        if (failReads) {
          throw new Error("RPC unavailable");
        }
        return {
          signerFunding: {
            account: "0x31ad432dFe083B998c69B6dB88A984ec5207ab7F",
            assets: [{
              symbol: "USDC",
              address: "0x0000053900000000000000000000000001200000",
              decimals: 6,
              readable: true,
              liquid: 23.9,
              liquidRaw: "23900000"
            }]
          }
        };
      }
    },
    deploymentManifest: TEST_DEPLOYMENT,
    now: () => current,
    refreshMs: 1_000,
    maxAgeMs: 60_000
  });

  const live = await provider();
  assert.equal(live.readable, true);
  assert.equal(reads, 1);

  failReads = true;
  current = new Date("2026-07-27T12:00:02.000Z");
  const fallback = await provider();
  assert.equal(fallback.readable, true);
  assert.equal(fallback.fallback, "last_known_good");
  assert.equal(fallback.asOf, "2026-07-27T12:00:00.000Z");
  assert.equal(reads, 2);

  current = new Date("2026-07-27T12:01:01.000Z");
  const stale = await provider();
  assert.equal(stale.readable, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.lastKnownGoodAsOf, "2026-07-27T12:00:00.000Z");
  assert.equal(reads, 3);
});

// Regression: /health served TESTNET contract addresses on mainnet.
//
// The manifest was a single hardcoded deployments/testnet.json. That read as
// harmless while the file was absent from the backend image — the load failed
// to null and env won. Copying the file in (#991) made the read succeed, and
// because manifest contracts beat env, mainnet /health began reporting the
// testnet AgentAccountCore and EscrowCore. The ops board then showed "AGENT
// CORE BELOW FLOOR" (a retired account's balance) and "0 payouts confirmed
// on-chain" (a retired contract's events) while money was entirely fine.
test("health addresses follow the running chain, never a hardcoded network", () => {
  const env = {
    AGENT_ACCOUNT_ADDRESS: "0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57",
    ESCROW_CORE_ADDRESS: "0x590EbE304E0C7672e2abF3161177D2B94a2aC3fC"
  };

  const mainnet = resolveHealthAddresses({ env: { ...env, AUTH_CHAIN_ID: "420420419" } });
  assert.equal(mainnet.agentAccountCore, "0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57");
  assert.equal(mainnet.escrowCore, "0x590EbE304E0C7672e2abF3161177D2B94a2aC3fC");

  const testnet = resolveHealthAddresses({ env: { ...env, AUTH_CHAIN_ID: "420420417" } });
  assert.notEqual(testnet.agentAccountCore, mainnet.agentAccountCore);

  // Unknown or absent chain id must fall back to env — the running truth.
  // No manifest is far better than the wrong network's.
  for (const chain of [{ AUTH_CHAIN_ID: "999" }, {}]) {
    const resolved = resolveHealthAddresses({ env: { ...env, ...chain } });
    assert.equal(resolved.agentAccountCore, env.AGENT_ACCOUNT_ADDRESS);
    assert.equal(resolved.escrowCore, env.ESCROW_CORE_ADDRESS);
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MemoryStateStore } from "./state-store.js";
import { SelfIdentityRegistry } from "./self-identity-registry.js";
import { buildJobSnapshot } from "./job-snapshot.js";
import { VerificationIngestionService } from "../services/verification-ingestion-service.js";
import {
  CREDIT_INTEREST_CANNOT_AUTHORIZE_ORIGINATION,
  WorkerProgressionService,
  assertCreditInterestIsolatedFromOrigination
} from "./worker-progression.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const CANARY = "0x2222222222222222222222222222222222222222";
const BLIND_TESTER_WALLET = "0x97450BF69Cb4aEB0b33db3aE51AC2D18224d4b5c";

function session(index, overrides = {}) {
  return {
    sessionId: `session-${index}`,
    jobId: `job-${index}`,
    wallet: WALLET,
    status: "resolved",
    updatedAt: `2026-08-2${index}T00:00:00.000Z`,
    verificationSummary: { outcome: "approved", handler: "github_pr" },
    badgeSnapshot: {
      category: "coding",
      tier: "starter",
      level: 1,
      rewardAsset: "USDC",
      rewardAmount: 0.25,
      verifierMode: "github_pr"
    },
    ...overrides
  };
}

function makeService({
  sessions = [],
  vestedRaw = "0",
  registration,
  selfIdentityRegistry,
  wallet = WALLET,
  stateStore = undefined
} = {}) {
  const store = stateStore ?? new MemoryStateStore();
  if (!stateStore) {
    const byWallet = new Map([[wallet.toLowerCase(), sessions]]);
    store.listSessionsByWallet = async (wallet, limit, offset) => (
      (byWallet.get(String(wallet).toLowerCase()) ?? []).slice(offset, offset + limit)
    );
  }
  if (registration) store.creditInterestRegistrations.set(wallet.toLowerCase(), registration);

  return {
    store,
    service: new WorkerProgressionService({
      stateStore: store,
      getReputation: async () => ({ skill: sessions.length >= 1 ? 100 : 0, reliability: 100, economic: 0, tier: sessions.length >= 1 ? "pro" : "starter" }),
      workerExposurePolicy: {
        async capacityForWallet() {
          const deposited = BigInt(vestedRaw);
          return {
            vestedAssetsRaw: deposited.toString(),
            vestedAssetsUsdc: Number(deposited) / 1_000_000,
            externalRewardCeilingBaseRaw: "1000000",
            externalRewardCeilingBaseUsdc: 1,
            externalRewardCeilingRaiseRaw: deposited.toString(),
            externalRewardCeilingRaiseUsdc: Number(deposited) / 1_000_000,
            externalRewardCeilingRaw: (1_000_000n + deposited).toString(),
            externalRewardCeilingUsdc: 1 + Number(deposited) / 1_000_000,
            baseOpenExposureCapRaw: "2500000",
            baseOpenExposureCapUsdc: 2.5,
            openExposureRaiseRaw: deposited > 0n ? "500000" : "0",
            openExposureRaiseUsdc: deposited > 0n ? 0.5 : 0,
            openExposureCapRaw: deposited > 0n ? "3000000" : "2500000",
            openExposureCapUsdc: deposited > 0n ? 3 : 2.5,
            nextConcurrentRaiseVestedRaw: deposited > 0n ? "3000000" : "1000000",
            nextConcurrentRaiseAmountRaw: deposited > 0n ? "2000000" : "1000000",
            nextConcurrentOpenExposureCapRaw: deposited > 0n ? "3500000" : "3000000",
            nextConcurrentOpenExposureCapUsdc: deposited > 0n ? 3.5 : 3,
            nextConcurrentExternalRewardCeilingRaw: deposited > 0n ? "4000000" : "2000000",
            nextConcurrentExternalRewardCeilingUsdc: deposited > 0n ? 4 : 2,
            vestingHours: 48,
            vestingAvailable: true
          };
        }
      },
      workerDailyExposurePolicy: {
        progressionConfig() {
          return {
            rolling24hRaw: "1500000",
            rolling24hUsdc: 1.5,
            lifetimeCreditRaw: "10000000",
            lifetimeCreditUsdc: 10,
            graduationSettledJobs: 10
          };
        }
      },
      selfIdentityRegistry: selfIdentityRegistry ?? new SelfIdentityRegistry(),
      creditInterestSettledJobs: 3,
      publicBaseUrl: "https://api.averray.test"
    })
  };
}

test("progression computes the canonical fresh-wallet fixture from live policy inputs", async () => {
  const { service } = makeService();
  const progression = await service.getProgression(WALLET);

  assert.equal(progression.tier, "starter");
  assert.deepEqual(progression.badges, []);
  assert.deepEqual(progression.effectiveCaps.perJobMax, {
    asset: "USDC",
    raw: "1000000",
    amount: 1,
    source: "capital_backed_external_reward_ceiling",
    components: {
      base: { raw: "1000000", amount: 1 },
      deposit: { raw: "0", amount: 0 }
    }
  });
  assert.equal(progression.effectiveCaps.rolling24h.active, false);
  assert.equal(progression.effectiveCaps.concurrent.amount, 2.5);
  assert.equal(progression.justChanged, null);
  assert.deepEqual(progression.creditInterest, { eligible: false, registered: false });
  assert.deepEqual(progression.raises.map((entry) => entry.action), ["keep_completing", "deposit"]);
});

test("third real settlement is self-counted when the wallet-session index still exposes only two approvals", async () => {
  const visibleSessions = [
    session(1, { wallet: BLIND_TESTER_WALLET }),
    session(2, { wallet: BLIND_TESTER_WALLET })
  ];
  const { service, store } = makeService({
    sessions: visibleSessions,
    wallet: BLIND_TESTER_WALLET
  });
  const job = {
    id: "job-3",
    category: "coding",
    tier: "starter",
    rewardAsset: "USDC",
    rewardAmount: 0.25,
    verifierMode: "benchmark",
    verifierConfig: { version: 1, handler: "benchmark" }
  };
  const submitted = session(3, {
    wallet: BLIND_TESTER_WALLET,
    status: "submitted",
    claimedAt: "2026-08-22T08:00:00.000Z",
    submittedAt: "2026-08-22T08:05:00.000Z",
    verificationSummary: undefined,
    jobSnapshot: buildJobSnapshot(job, { capturedAt: "2026-08-22T08:00:00.000Z" })
  });
  await store.upsertSession(submitted);
  // Receipt production is orthogonal to this unit drill. The real ingestion
  // service still performs the submitted -> resolved transition and writes the
  // verification record while the simulated wallet index remains one write behind.
  store.putRunReceiptDocument = undefined;
  const ingestion = new VerificationIngestionService(store, undefined, undefined, {
    info() {},
    warn() {}
  });

  const before = await service.getProgression(BLIND_TESTER_WALLET);
  const settled = await ingestion.ingest(submitted.sessionId, {
    jobId: submitted.jobId,
    handler: "benchmark",
    handlerVersion: 1,
    outcome: "approved",
    reasonCode: "BENCHMARK_THRESHOLD_MET"
  });
  const crossing = await service.getProgression(BLIND_TESTER_WALLET, {
    settlementSessionId: settled.sessionId,
    settlementSession: settled,
    previousProgression: before
  });

  assert.equal(before.creditInterest.eligible, false);
  assert.equal(crossing.badges.length, 3);
  assert.equal(crossing.creditInterest.eligible, true);
  assert.deepEqual(crossing.justChanged, {
    field: "creditInterest.eligible",
    from: false,
    to: true
  });
});

test("QA10 exact wallet counts all four mixed-era approved settlements and becomes credit-interest eligible", async () => {
  const store = new MemoryStateStore();
  const revisions = [21, 22, 23, 24];
  const chainJobIds = [
    "0x277608834c1a35b74ebb51fc56065d424b10fd5738d5761fc5d7c72923ef42ee",
    "0x27e0c4671085235aec97ef3d127db5549cc3d0e9a2803e661c4f59fb6e55e249",
    "0x4d038bf05c297a3ee4b52e2d83fe46270ad0b7d2ca6aeb9b3283adeed6cec4e8",
    "0x7dddba8dc13a7c2616ef87310beb3e39e313cfa2728c6aa9a12959fa2f3bac51"
  ];
  const sessions = revisions.map((revision, index) => ({
    sessionId: `wiki-en-80171159-citation-repair-in-the-suburbs-of-moscow-r${revision}:${BLIND_TESTER_WALLET}`,
    jobId: `wiki-en-80171159-citation-repair-in-the-suburbs-of-moscow-r${revision}`,
    chainJobId: chainJobIds[index],
    wallet: index === 1 ? BLIND_TESTER_WALLET.toLowerCase() : BLIND_TESTER_WALLET,
    status: "resolved",
    resolvedAt: `2026-08-${index < 2 ? "21" : index === 2 ? "22" : "23"}T1${index}:00:00.000Z`,
    updatedAt: `2026-08-${index < 2 ? "21" : index === 2 ? "22" : "23"}T1${index}:00:00.000Z`,
    badgeSnapshot: { category: "wikipedia", tier: "starter", level: 1 },
    ...(index === 0 ? {
      verificationSummary: { outcome: "approved" },
      jobSnapshot: { definition: { source: { type: "wikipedia_article" } } }
    } : index === 1 ? {
      jobSnapshot: { source: "wikipedia", sourceType: "wikipedia_article" }
    } : index === 2 ? {
      verification: { status: "approved" },
      jobSnapshot: { specDefinition: { sourceType: "wikipedia_article" } }
    } : {
      verificationSummary: { status: "approved" },
      jobSnapshot: { definition: { source: "wikipedia", sourceType: "wikipedia_article" } }
    })
  }));
  for (const settled of sessions) store.sessions.set(settled.sessionId, settled);
  store.walletSessions.set(BLIND_TESTER_WALLET, [
    sessions[3].sessionId,
    sessions[2].sessionId,
    sessions[0].sessionId
  ]);
  store.walletSessions.set(BLIND_TESTER_WALLET.toLowerCase(), [sessions[1].sessionId]);
  store.verificationResults.set(sessions[1].sessionId, { outcome: "approved" });
  const repair = await store.reconcileWalletSessionIndex();
  const { service } = makeService({
    sessions,
    wallet: BLIND_TESTER_WALLET,
    stateStore: store
  });

  const progression = await service.getProgression(BLIND_TESTER_WALLET);

  assert.equal(repair.mismatchedWallets, 1);
  assert.equal(repair.missingEntries, 3);
  assert.equal(progression.badges.length, 4);
  assert.equal(progression.effectiveCaps.rolling24h.settledJobs, 4);
  assert.deepEqual(progression.creditInterest, { eligible: true, registered: false });
});

test("progression computes the deposit-holding fixture without confusing capital and reputation", async () => {
  const { service } = makeService({ sessions: [session(1)], vestedRaw: "1000000" });
  const progression = await service.getProgression(WALLET);

  assert.equal(progression.tier, "pro");
  assert.equal(progression.effectiveCaps.perJobMax.amount, 2);
  assert.equal(progression.effectiveCaps.perJobMax.components.base.raw, "1000000");
  assert.equal(progression.effectiveCaps.perJobMax.components.deposit.raw, "1000000");
  assert.equal(progression.effectiveCaps.concurrent.amount, 3);
  assert.match(progression.raises.find((entry) => entry.action === "deposit").effect, /vest/u);
});

test("credit-interest registration is threshold-gated, idempotent, durable, and admin-listable", async () => {
  const sessions = [session(1), session(2), session(3)];
  const { service, store } = makeService({ sessions });

  const first = await service.registerCreditInterest(WALLET);
  const replay = await service.registerCreditInterest(WALLET);
  const listed = await service.listCreditInterestRegistrations();

  assert.deepEqual(replay, first);
  assert.equal((await store.getCreditInterestRegistration(WALLET)).wallet, WALLET.toLowerCase());
  assert.deepEqual(listed, [first]);
  assert.deepEqual((await service.getProgression(WALLET)).creditInterest, {
    eligible: true,
    registered: true
  });
});

test("credit-interest registration refuses below-threshold workers by name", async () => {
  const { service } = makeService({ sessions: [session(1), session(2)] });
  await assert.rejects(
    service.registerCreditInterest(WALLET),
    (error) => error.code === "credit_interest_eligibility_not_met"
  );
});

test("credit interest is structurally incapable of approving or originating credit", () => {
  const originationFiles = [
    new URL("../services/credit-book-door.js", import.meta.url),
    new URL("../services/l3-posting-keeper.js", import.meta.url),
    new URL("../protocols/http/admin-credit-routes.js", import.meta.url)
  ];
  const clean = originationFiles.map((url) => readFileSync(url, "utf8")).join("\n");
  assert.doesNotThrow(() => assertCreditInterestIsolatedFromOrigination(clean));
  assert.throws(
    () => assertCreditInterestIsolatedFromOrigination(`${clean}; creditInterest.registered === true`),
    (error) => error.code === CREDIT_INTEREST_CANNOT_AUTHORIZE_ORIGINATION
  );
});

test("synthetic and canary wallets are excluded from every progression surface by name", async () => {
  const canarySession = session(1, {
    wallet: CANARY,
    jobId: "worker-canary-1787500000000",
    claimantAttribution: { kind: "hosted_worker_canary", evidence: "wallet_bound_marker_v1" }
  });
  const registry = new SelfIdentityRegistry();
  const store = new MemoryStateStore();
  store.listSessionsByWallet = async () => [canarySession];
  const service = new WorkerProgressionService({
    stateStore: store,
    getReputation: async () => ({ skill: 100, tier: "pro" }),
    workerExposurePolicy: { capacityForWallet: async () => { throw new Error("must not read"); } },
    workerDailyExposurePolicy: { progressionConfig: () => ({}) },
    selfIdentityRegistry: registry
  });

  assert.equal(await service.getProgression(CANARY), undefined);
  await assert.rejects(
    service.registerCreditInterest(CANARY),
    (error) => error.code === "credit_interest_synthetic_identity_excluded"
  );
});

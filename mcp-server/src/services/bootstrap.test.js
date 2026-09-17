import assert from "node:assert/strict";
import test from "node:test";

import { loadAuthConfig } from "../auth/config.js";
import { loadBlockchainConfig } from "../blockchain/config.js";
import { BOOTSTRAP_JOBS } from "./bootstrap-jobs.js";
import { createCreditPoolDoor, createDepositPoolDoor, createDepositPoolObservability,
  createIdleBalanceConsentService, createEarningsDoor } from "./bootstrap.js";
import { createIdleBalanceAllocationKeeper } from "./idle-balance-allocation-keeper.js";
import { generateAll } from "../../../scripts/ops/render-mainnet-backend-env.mjs";
import { POOL_V22_MIGRATION_READY, POOL_V22_NAV_DISCLOSURE, poolV22Config } from "./pool-v22-commitments.js";
import { buildDepositPoolSurface } from "../../../app/lib/ui/deposit-pool-surface.js";
import { MemoryStateStore } from "../core/state-store.js";
import { EventBus } from "../core/event-bus.js";

const POOL_ASSET = "0x0000053900000000000000000000000001200000";
const CREDIT_POOL = "0x903B318586A3772c99185000676f4AC356DD6E4B";
const CREDIT_POOL_DEPOSIT_POOL_BINDING = "0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30";
const CANONICAL_DEPOSIT_POOL = "0x9B35A102d656Fb86d798aF81959e09961DEc28E0";

function cutoverEnv() {
  return { ...Object.fromEntries(generateAll()["deploy/backend.mainnet.env.template"].split("\n")
    .filter((line) => /^[A-Z][A-Z0-9_]*=/u.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])),
  AUTH_MODE: "permissive" };
}

test("T4 alias move preserves v2.1 position reads, consent binding and the enabled exit keeper", async () => {
  const env = cutoverEnv();
  const config = { ...loadBlockchainConfig({ AUTH_CHAIN_ID: env.AUTH_CHAIN_ID }),
    agentAccountAddress: env.AGENT_ACCOUNT_ADDRESS, supportedAssets: JSON.parse(env.SUPPORTED_ASSETS_JSON) };
  const gateway = { config, provider: {}, signer: {} };
  const observations = createDepositPoolObservability({ gateway });
  assert.equal(observations.servicesByPool.size, 3);
  assert.equal(observations.defaultPoolAddress.toLowerCase(), config.depositPoolAddress);
  const v21 = observations.servicesByPool.get(config.depositPoolV21Address);
  assert.equal(v21.venueHistoryReader.eventReader.deploymentBlock, 19913549);
  const reads = [];
  v21.chainReader = {
    async getBlockNumber() { return 20747000; },
    async getBlock() { return { timestamp: 1800000000 }; },
    async readState({ poolAddress }) {
      reads.push(poolAddress.toLowerCase());
      return { asset: POOL_ASSET, totalAssets: 3_118_112n, totalShares: 3_034_767n,
        buffer: 3_118_112n, deployed: 0n, totalAssetCap: 100_000_000n, perAgentAssetCap: 10_000_000n,
        venueHistory: { status: "ok", deployments: [] } };
    },
    async readEvents() { return []; }
  };
  const snapshot = await observations.getSnapshot({ poolAddress: config.depositPoolV21Address });
  assert.deepEqual(reads, [config.depositPoolV21Address]);
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.totalShares.raw, "3034767");
  assert.equal(snapshot.totalAssets.raw, "3118112");
  const stateStore = new MemoryStateStore();
  const consent = createIdleBalanceConsentService({ gateway, env, stateStore,
    authConfig: loadAuthConfig({ AUTH_MODE: "permissive", AUTH_CHAIN_ID: env.AUTH_CHAIN_ID }) });
  assert.equal(consent.config.depositPoolAddress.toLowerCase(), config.depositPoolV21Address);
  const keeper = createIdleBalanceAllocationKeeper({ gateway, env, stateStore, consentService: consent });
  assert.equal(keeper.config.enabled, true);
  assert.equal(keeper.config.floatTargetBps, 10000);
  assert.equal(keeper.chainReader.poolAddress.toLowerCase(), config.depositPoolV21Address);
  assert.equal(keeper.chainReader.adapterAddress.toLowerCase(), config.aacPoolAggregatorAdapterAddress);
});

test("T4 rendered env wires the v2.2 door with 7/30/90-day capacities, retired v2.1 copy and R3", async () => {
  const env = cutoverEnv();
  const config = loadBlockchainConfig({ AUTH_CHAIN_ID: env.AUTH_CHAIN_ID });
  assert.equal(poolV22Config(env).enabled, false, "locked keeper must stay off");
  const door = createDepositPoolDoor({ env, gateway: { config },
    authConfig: loadAuthConfig({ AUTH_MODE: "permissive", AUTH_CHAIN_ID: env.AUTH_CHAIN_ID }),
    chainReader: { async readSnapshot() {
      return { asset: POOL_ASSET, blockNumber: 20747000, blockTimestamp: 1800000000,
        totalAssets: 0n, totalSupply: 0n, bufferAssets: 0n, deployedPrincipal: 0n,
        totalAssetCap: 100_000_000n, perAgentAssetCap: 10_000_000n };
    } }
  });
  assert.equal(door.commitmentReader.pool.target.toLowerCase(), config.depositPoolAddress);
  const windows = [];
  door.commitmentReader.pool = {
    async deployableFor(seconds) { windows.push(seconds); return 0n; },
    async committedSharesBeyond() { return 0n; }, async committedSharesByTier() { return [0n, 0n, 0n]; },
    async convertToAssets() { return 0n; }, async bufferFloor() { return 0n; }
  };
  const info = await door.getInfo();
  assert.equal(info.pool.toLowerCase(), config.depositPoolAddress);
  assert.deepEqual(windows, [7, 30, 90].map((days) => days * 86400));
  assert.equal(info.commitments.status, "available");
  assert.equal(info.commitments.tiers.length, 3);
  assert.equal(info.transition.statement, POOL_V22_MIGRATION_READY);
  assert.match(info.transition.statement, /v2\.1 deposit door is retired.*contract has no pause/u);
  assert.match(info.transition.statement, /positions remain visible and withdrawals are unchanged.*7-day notice.*at their leisure/u);
  assert.match(info.commitmentDisclosure, /shared pro-rata by all pool shares, including Flex/u);
  const surface = buildDepositPoolSurface(info, { depositPoolV22: env.POOL_V22_ADDRESS });
  assert.equal(surface.identity.generation, "Live v2.2");
  assert.equal(surface.transition, POOL_V22_MIGRATION_READY);
  assert.equal(surface.commitments.disclosure, POOL_V22_NAV_DISCLOSURE);
});

test("bootstrap retains closed starter ids only as archived history", () => {
  const publicJobs = BOOTSTRAP_JOBS.filter((job) => job.lifecycle?.status !== "archived");

  assert.equal(publicJobs.some((job) => job.id === "starter-coding-001"), false);
  assert.equal(publicJobs.some((job) => job.id === "starter-coding-002"), false);

  for (const jobId of ["starter-coding-001", "starter-coding-002"]) {
    const retired = BOOTSTRAP_JOBS.find((job) => job.id === jobId);
    assert.equal(retired.lifecycle?.status, "archived");
    assert.match(retired.lifecycle?.reason ?? "", /job ids are never reused/iu);
  }
});

test("bootstrap wires string AUTH_CHAIN_ID and public mainnet RPC into the earnings door", async () => {
  const authConfig = loadAuthConfig({ AUTH_MODE: "permissive", AUTH_CHAIN_ID: "420420419" });
  const gateway = {
    config: {
      agentAccountAddress: "0x2222222222222222222222222222222222222222"
    },
    provider: undefined,
    isEnabled: () => true,
    async getAccountPosition(wallet) {
      return {
        wallet,
        asset: { symbol: "USDC", address: POOL_ASSET, decimals: 6 },
        position: { liquidRaw: "1", jobStakeLockedRaw: "0" }
      };
    },
    async getWorkerClaimCount() { return 0; },
    async sendFirstWithdrawalGasGrant() { throw new Error("not requested"); }
  };
  const stateStore = new MemoryStateStore();
  const door = createEarningsDoor({
    authConfig,
    gateway,
    stateStore,
    eventBus: new EventBus({ eventStore: stateStore }),
    workerExposurePolicy: { async capacityForWallet() { return { vestingHours: 48 }; } },
    workerProgressionService: {
      async getProgression() {
        return {
          tier: "starter",
          badges: [],
          creditInterest: { eligible: false, registered: false }
        };
      }
    },
    getReputation: async () => ({ skill: 0, tier: "starter" }),
    chainReader: {
      async gasQuote() {
        return { gas: 10n, unitPrice: 2n, nativeBalance: 100n, blockNumber: 1 };
      }
    }
  });

  const built = await door.buildWithdrawTransactions(
    "0x1111111111111111111111111111111111111111",
    { asset: "USDC", amount: "1" }
  );
  assert.equal(built.chainId, 420420419);
  assert.deepEqual(built.broadcast.rpcUrls, ["https://eth-rpc.polkadot.io"]);
});

test("bootstrap wires the CreditPool door to CreditPool.depositPool() instead of the canonical pool pointer", async () => {
  const deployedCreditPool = {
    address: CREDIT_POOL,
    async depositPool() {
      return CREDIT_POOL_DEPOSIT_POOL_BINDING;
    }
  };
  const gateway = {
    config: {
      creditPoolAddress: deployedCreditPool.address,
      depositPoolAddress: CANONICAL_DEPOSIT_POOL,
      depositPoolV2Address: CANONICAL_DEPOSIT_POOL,
      legacyDepositPoolV2Address: CREDIT_POOL_DEPOSIT_POOL_BINDING
    },
    provider: undefined,
    async signCreditVestingAttestation() {
      throw new Error("not requested");
    }
  };
  const door = createCreditPoolDoor({
    gateway,
    authConfig: loadAuthConfig({ AUTH_MODE: "permissive", AUTH_CHAIN_ID: "420420419" }),
    chainReader: {},
    workerExposurePolicy: { async capacityForWallet() { return {}; } }
  });

  assert.equal(door.depositPoolAddress, await deployedCreditPool.depositPool());
  assert.notEqual(door.depositPoolAddress, gateway.config.depositPoolAddress);
});

test("bootstrap carries the venue-mark tolerance from env into the DepositPool door", async () => {
  const renderedEnv = {
    AUTH_MODE: "permissive",
    AUTH_CHAIN_ID: "420420419",
    DEPOSIT_POOL_VENUE_MARK_TOLERANCE_BPS: "25",
    DEPOSIT_POOL_VENUE_MARK_DUST_FLOOR_RAW: "2500"
  };
  const door = createDepositPoolDoor({
    authConfig: loadAuthConfig(renderedEnv),
    env: renderedEnv,
    gateway: { config: loadBlockchainConfig(renderedEnv), provider: undefined },
    chainReader: { async readSnapshot() { return {}; } }
  });
  assert.deepEqual(door.venueMarkConfig, { toleranceBps: 25, dustFloorRaw: 2_500n });

  const defaults = createDepositPoolDoor({
    authConfig: loadAuthConfig({ AUTH_MODE: "permissive", AUTH_CHAIN_ID: "420420419" }),
    env: { AUTH_MODE: "permissive", AUTH_CHAIN_ID: "420420419" },
    gateway: { config: loadBlockchainConfig({}), provider: undefined },
    chainReader: { async readSnapshot() { return {}; } }
  });
  assert.equal(defaults.venueMarkConfig.toleranceBps, 10);
  assert.equal(defaults.venueMarkConfig.dustFloorRaw, 1_000n);
});

test("bootstrap wires the rendered mainnet AUTH_CHAIN_ID into the configured DepositPool door", async () => {
  const renderedEnv = {
    AUTH_MODE: "permissive",
    AUTH_CHAIN_ID: "420420419"
  };
  const authConfig = loadAuthConfig(renderedEnv);
  const blockchainConfig = loadBlockchainConfig(renderedEnv);
  const door = createDepositPoolDoor({
    authConfig,
    env: renderedEnv,
    gateway: { config: blockchainConfig, provider: undefined },
    chainReader: {
      async readSnapshot() {
        return {
          asset: POOL_ASSET,
          blockNumber: 1,
          blockHash: `0x${"11".repeat(32)}`,
          blockTimestamp: 1_700_000_000,
          totalAssets: 0n,
          totalSupply: 0n,
          bufferAssets: 0n,
          deployedPrincipal: 0n,
          totalAssetCap: 100_000_000n,
          perAgentAssetCap: 10_000_000n
        };
      }
    }
  });

  assert.equal(typeof renderedEnv.AUTH_CHAIN_ID, "string");
  assert.equal(authConfig.chainId, 420420419);
  assert.equal(blockchainConfig.chainId, undefined);
  const info = await door.getInfo();
  assert.equal(info.available, true);
  assert.equal(info.chainId, 420420419);
  assert.equal(info.disclosure.statement, "Technical pilot. Principal at risk. No depositor protection.");
  assert.deepEqual(info.broadcast.rpcUrls, ["https://eth-rpc.polkadot.io"]);
});

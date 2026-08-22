import assert from "node:assert/strict";
import test from "node:test";

import { loadAuthConfig } from "../auth/config.js";
import { loadBlockchainConfig } from "../blockchain/config.js";
import { BOOTSTRAP_JOBS } from "./bootstrap-jobs.js";
import { createDepositPoolDoor, createEarningsDoor } from "./bootstrap.js";
import { MemoryStateStore } from "../core/state-store.js";
import { EventBus } from "../core/event-bus.js";

const POOL_ASSET = "0x0000053900000000000000000000000001200000";

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

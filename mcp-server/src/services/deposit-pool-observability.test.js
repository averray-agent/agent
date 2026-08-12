import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";

import { DEPOSIT_POOL_ABI } from "../blockchain/abis.js";
import { depositPoolYieldStatus } from "./deposit-pool-yield-status.js";
import { DepositPoolObservabilityService, EvmDepositPoolChainReader } from "./deposit-pool-observability.js";

const POOL = "0xCCF5FDF3108AF8e693F28bb9326A573d9dA0F476";
const ASSET = "0x0000053900000000000000000000000001200000";
const HEAD = 19_380_600;

function reader({ state = {}, events = [], eventError = undefined } = {}) {
  const calls = [];
  return {
    calls,
    async getBlockNumber() { return HEAD; },
    async getBlock(blockNumber) {
      assert.equal(blockNumber, HEAD);
      return { number: HEAD, hash: `0x${"ab".repeat(32)}`, timestamp: 1_786_200_000 };
    },
    async readState({ poolAddress, blockTag }) {
      calls.push({ type: "state", poolAddress, blockTag });
      return {
        asset: ASSET,
        totalAssets: 0n,
        totalShares: 0n,
        buffer: 0n,
        deployed: 0n,
        totalAssetCap: 1_000_000_000n,
        perAgentAssetCap: 100_000_000n,
        ...state
      };
    },
    async readEvents({ poolAddress, fromBlock, toBlock }) {
      calls.push({ type: "events", poolAddress, fromBlock, toBlock });
      if (eventError) throw eventError;
      return events;
    }
  };
}

function service(chainReader, options = {}) {
  return new DepositPoolObservabilityService({
    poolAddress: POOL,
    chainReader,
    eventWindowBlocks: 2_000,
    recentFlowLimit: 4,
    ...options
  });
}

test("deposit-pool snapshot distinguishes a chain-read born-empty pool from unavailable", async () => {
  const available = await service(reader()).getSnapshot();
  const unavailable = await new DepositPoolObservabilityService({ poolAddress: "" }).getSnapshot();

  assert.equal(available.available, true);
  assert.deepEqual(available.totalAssets, { raw: "0", decimals: 6 });
  assert.deepEqual(available.totalShares, { raw: "0", decimals: 6 });
  assert.deepEqual(available.sharePrice, { raw: "1000000", decimals: 6 });
  assert.equal(available.pricingModel, "principal-cost-basis");
  assert.equal(available.bornEmpty, true);
  assert.equal(available.reconciled, true);
  assert.equal(available.flows.depositorCount, 0);
  assert.deepEqual(unavailable, {
    schemaVersion: 1,
    available: false,
    reason: "deposit_pool_not_configured"
  });
});

test("deposit-pool reconciliation reports a mismatch without adjusting the live values", async () => {
  const snapshot = await service(reader({
    state: {
      totalAssets: 10_000_000n,
      totalShares: 10_000_000n,
      buffer: 4_000_000n,
      deployed: 5_999_999n
    }
  })).getSnapshot();

  assert.equal(snapshot.reconciled, false);
  assert.equal(snapshot.reconciliation.differenceRaw, "1");
  assert.equal(snapshot.totalAssets.raw, "10000000");
  assert.equal(snapshot.buffer.raw, "4000000");
  assert.equal(snapshot.deployed.raw, "5999999");
});

test("deposit-pool events stay bounded, count distinct depositors, and expose qualifying price events", async () => {
  const chainReader = reader({
    state: { totalAssets: 10_000_000n, totalShares: 10_000_000n, buffer: 10_000_000n },
    events: [
      { type: "Deposit", owner: "0x1111111111111111111111111111111111111111", assetsRaw: "4000000", sharesRaw: "4000000", blockNumber: HEAD - 2, logIndex: 1, txHash: `0x${"11".repeat(32)}` },
      { type: "Deposit", owner: "0x2222222222222222222222222222222222222222", assetsRaw: "6000000", sharesRaw: "6000000", blockNumber: HEAD - 1, logIndex: 2, txHash: `0x${"22".repeat(32)}` },
      { type: "Deposit", owner: "0x1111111111111111111111111111111111111111", assetsRaw: "1", sharesRaw: "1", blockNumber: HEAD, logIndex: 1, txHash: `0x${"33".repeat(32)}` },
      { type: "OperatorPrincipalContributed", assetsRaw: "2", sharesRaw: "2", blockNumber: HEAD, logIndex: 2, txHash: `0x${"44".repeat(32)}` }
    ]
  });
  const snapshot = await service(chainReader).getSnapshot();

  assert.equal(snapshot.flows.depositorCount, 2);
  assert.equal(snapshot.flows.recent.length, 3, "only depositor/redeem flows belong in recent");
  assert.equal(snapshot.flows.sharePriceQualifyingEvents.length, 1);
  assert.equal(snapshot.flows.sharePriceQualifyingEvents[0].type, "OperatorPrincipalContributed");
  assert.deepEqual(snapshot.flows.window, {
    fromBlock: HEAD - 1_999,
    toBlock: HEAD,
    maxBlocks: 2_000,
    recentLimit: 4
  });
  assert.deepEqual(chainReader.calls.at(-1), {
    type: "events",
    poolAddress: POOL,
    fromBlock: HEAD - 1_999,
    toBlock: HEAD
  });
});

test("deposit-pool log failure degrades flows only and preserves named-block live truth", async () => {
  const snapshot = await service(reader({
    state: { totalAssets: 10_000_000n, totalShares: 10_000_000n, buffer: 10_000_000n },
    eventError: new Error("RPC secret https://provider.invalid/key")
  })).getSnapshot();

  assert.equal(snapshot.available, true);
  assert.equal(snapshot.totalAssets.raw, "10000000");
  assert.equal(snapshot.reconciled, true);
  assert.equal(snapshot.flows.status, "unavailable");
  assert.equal(snapshot.flows.depositorCount, null);
  assert.equal(snapshot.flows.recent, null);
  assert.match(snapshot.flows.lastError, /https:\/\/provider\.invalid\/\[redacted\]/u);
  assert.doesNotMatch(snapshot.flows.lastError, /\/key/u);
  assert.equal(snapshot.block.number, HEAD);
});

test("yieldStatus has one byte-identical source and flips the buffer alert with deployed principal", async () => {
  const off = await service(reader()).getSnapshot();
  const on = await service(reader({
    state: { totalAssets: 10_000_000n, totalShares: 10_000_000n, buffer: 3_000_000n, deployed: 7_000_000n }
  })).getSnapshot();

  assert.deepEqual(
    { yieldStatus: off.yieldStatus, yieldStatusText: off.yieldStatusText },
    depositPoolYieldStatus(0n)
  );
  assert.deepEqual(
    { yieldStatus: on.yieldStatus, yieldStatusText: on.yieldStatusText },
    depositPoolYieldStatus(7_000_000n)
  );
  assert.equal(off.bufferFloorAlertEnabled, false);
  assert.equal(on.bufferFloorAlertEnabled, true);
});

test("EVM reader decodes the deployed DepositPool event signatures without exposing depositor identities", async () => {
  const abi = new Interface(DEPOSIT_POOL_ABI);
  const deposit = abi.encodeEventLog(abi.getEvent("Deposit"), [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    1_000_000n,
    1_000_000n
  ]);
  const fulfilled = abi.encodeEventLog(abi.getEvent("RedeemFulfilled"), [7n, 250_000n, 250_001n]);
  const chainReader = new EvmDepositPoolChainReader({
    async getLogs() {
      return [
        { address: POOL, topics: deposit.topics, data: deposit.data, blockNumber: HEAD - 1, index: 2, transactionHash: `0x${"12".repeat(32)}` },
        { address: POOL, topics: fulfilled.topics, data: fulfilled.data, blockNumber: HEAD, index: 3, transactionHash: `0x${"34".repeat(32)}` }
      ];
    }
  });

  const events = await chainReader.readEvents({ poolAddress: POOL, fromBlock: HEAD - 10, toBlock: HEAD });
  assert.deepEqual(events.map((event) => event.type), ["Deposit", "RedeemFulfilled"]);
  assert.equal(events[0].owner, "0x2222222222222222222222222222222222222222");
  assert.equal(events[1].requestId, 7n);
  assert.equal(eventProofHasIdentity(events[0]), true, "reader retains identity only long enough to aggregate it");

  const snapshot = await service(reader({ events })).getSnapshot();
  assert.equal(snapshot.flows.recent.some((event) => "owner" in event), false);
});

function eventProofHasIdentity(event) {
  return Object.hasOwn(event, "owner");
}

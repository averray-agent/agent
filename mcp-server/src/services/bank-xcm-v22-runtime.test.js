import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";

import {
  BankXcmV22Runtime,
  createBankXcmV22RuntimeServices
} from "./bank-xcm-v22-runtime.js";
import { XCM_WRAPPER_ABI } from "../blockchain/abis.js";

const WRAPPER = "0x1111111111111111111111111111111111111111";
const ADAPTER = "0x2222222222222222222222222222222222222222";
const OPERATOR = "0x3333333333333333333333333333333333333333";
const USDC = "0x0000053900000000000000000000000001200000";
const AUSDC = "0x2ec4884088d84e5c2970a034732e5209b0acfa93";
const REQUEST_ID = `0x${"44".repeat(32)}`;
const BLOCK_HASH = `0x${"55".repeat(32)}`;
const TX_HASH = `0x${"66".repeat(32)}`;
const STAGING_BLOCK = 19_064_055;
const STRATEGY_ID = `0x${"77".repeat(32)}`;
const ACCOUNT = "0x8888888888888888888888888888888888888888";
const RECIPIENT = "0x9999999999999999999999999999999999999999";
const wrapperInterface = new Interface(XCM_WRAPPER_ABI);

function makeRuntime({ observer = undefined, records = undefined } = {}) {
  const calls = [];
  const published = [];
  let subscription;
  const blockRecords = records ?? requestQueuedRecords();
  const eventsQuery = async (callback) => {
    subscription = callback;
    return () => {};
  };
  const api = {
    rpc: {
      chain: {
        async getHeader() {
          return { number: { toNumber: () => STAGING_BLOCK }, hash: hexCodec(BLOCK_HASH) };
        },
        async getBlockHash(blockNumber) {
          assert.equal(blockNumber, STAGING_BLOCK);
          return hexCodec(BLOCK_HASH);
        },
        async getBlock(blockHash) {
          assert.equal(blockHash, BLOCK_HASH);
          return {
            block: {
              extrinsics: [hexExtrinsic("11"), hexExtrinsic("22"), hexExtrinsic("66")]
            }
          };
        }
      }
    },
    query: { system: { events: eventsQuery } },
    async at(blockHash) {
      assert.equal(blockHash, BLOCK_HASH);
      return {
        query: {
          timestamp: { async now() { return stringCodec("1785915000000"); } },
          system: { async events() { return blockRecords; } }
        }
      };
    }
  };
  const balanceObserver = observer ?? {
    async getStatus() {
      return {
        enabled: true,
        running: true,
        chainEventWatchEnabled: true,
        chainEventIngestionError: undefined
      };
    },
    async requireArmedWatch() {},
    async registerBackfillFromChainEvent(event, baseline) {
      calls.push({ event, baseline });
      return {
        requestId: event.data.requestId,
        registrationSource: "chain_event_backfill",
        baselineRaw: String(baseline.raw),
        baselineBlockNumber: baseline.blockNumber,
        baselineBlockHash: baseline.blockHash
      };
    }
  };
  const wrapper = {};
  const gateway = {
    hasXcmWrapper: () => true,
    provider: {
      async getBlockNumber() { return 1_000; },
      async getBlock(block) {
        assert.equal(block, STAGING_BLOCK);
        return { timestamp: 1_785_915_000 };
      }
    },
    signer: { async getAddress() { return OPERATOR; } },
    config: {
      xcmWrapperAddress: WRAPPER,
      rpcUrl: "https://services.polkadothub-rpc.com/mainnet/",
      chainId: 420420419,
      supportedAssets: [{ symbol: "USDC", address: USDC }]
    }
  };
  const runtime = new BankXcmV22Runtime({
    gateway,
    balanceObserver,
    balanceReader: { async getSubstrateApi() { return api; } },
    bankLaneFeed: {
      targets: {
        position: {
          ledger: "erc20",
          endpoint: "https://rpc.hydradx.cloud/",
          chainId: 222222,
          account: OPERATOR,
          contract: AUSDC
        },
        float: {
          ledger: "substrate_tokens",
          endpoint: "wss://hydration-rpc.n.dwellir.com/",
          account: `0x${"ab".repeat(32)}`,
          assetId: 22
        }
      }
    },
    adapterAddress: ADAPTER,
    assetHubSubstrateEndpoint: "wss://asset-hub-polkadot-rpc.n.dwellir.com/",
    hydrationSubstrateEndpoint: "wss://hydration-rpc.n.dwellir.com/",
    eventBus: { publish(event) { published.push(event); } },
    wrapperContract: wrapper,
    adapterContract: {},
    wrapperInterface
  });
  runtime.readStampedBalance = async () => ({
    raw: 0n,
    asOf: "2026-08-04T06:37:00.000Z",
    blockNumber: 12_345_678,
    blockHash: BLOCK_HASH
  });
  return {
    runtime,
    calls,
    published,
    api,
    getSubscription: () => subscription
  };
}

test("disabled Bank v2.2 runtime performs no bootstrap construction", () => {
  assert.deepEqual(createBankXcmV22RuntimeServices({ enabled: false }), {
    runtime: undefined,
    dispatcher: undefined
  });
});

test("enabled factory bootstraps both the concrete runtime and refusing dispatcher", () => {
  const services = createBankXcmV22RuntimeServices({
    enabled: true,
    gateway: {
      hasXcmWrapper: () => true,
      provider: {},
      signer: {},
      config: { xcmWrapperAddress: WRAPPER }
    },
    balanceObserver: {},
    balanceReader: {},
    bankLaneFeed: {
      targets: {
        position: {
          ledger: "erc20",
          endpoint: "https://rpc.hydradx.cloud/",
          chainId: 222222,
          account: OPERATOR,
          contract: AUSDC
        },
        float: {
          ledger: "substrate_tokens",
          endpoint: "wss://hydration-rpc.n.dwellir.com/",
          account: `0x${"ab".repeat(32)}`,
          assetId: 22
        }
      }
    },
    env: {
      HYDRATION_USDC_ADAPTER_ADDRESS: ADAPTER,
      BANK_XCM_ASSET_HUB_SUBSTRATE_RPC_URL: "wss://asset-hub-polkadot-rpc.n.dwellir.com/",
      BANK_XCM_HYDRATION_SUBSTRATE_RPC_URL: "wss://hydration-rpc.n.dwellir.com/"
    }
  });

  assert.ok(services.runtime instanceof BankXcmV22Runtime);
  assert.equal(services.dispatcher.enabled, true);
  assert.equal(services.dispatcher.expectedWrapper, WRAPPER);
});

test("enabled runtime reports staging readiness only with both observer and Substrate event watch running", async () => {
  const { runtime } = makeRuntime();
  assert.equal((await runtime.getStatus()).readyForStaging, false);
  await runtime.start();
  assert.deepEqual(await runtime.getStatus(), {
    enabled: true,
    wrapper: WRAPPER,
    adapter: ADAPTER,
    observerEnabled: true,
    observerRunning: true,
    chainEventWatchEnabled: true,
    chainEventIngestionError: undefined,
    substrateEventWatchRunning: true,
    substrateEventIngestionError: undefined,
    readyForStaging: true
  });
  assert.ok(runtime.createDispatcher());
});

test("staged-request backfill derives the event and block-bound baseline from chain truth", async () => {
  const { runtime, calls } = makeRuntime();
  const watch = await runtime.backfillStagedRequestWatch({
    requestId: REQUEST_ID,
    fromBlock: STAGING_BLOCK,
    toBlock: STAGING_BLOCK
  });

  assert.equal(watch.registrationSource, "chain_event_backfill");
  assert.equal(watch.baselineRaw, "0");
  assert.equal(watch.baselineBlockNumber, 12_345_678);
  assert.equal(watch.baselineBlockHash, BLOCK_HASH);
  const imported = calls.find((entry) => entry.event);
  assert.equal(imported.event.txHash, TX_HASH);
  assert.equal(imported.event.blockNumber, STAGING_BLOCK);
  assert.equal(imported.event.data.requestId, REQUEST_ID);
  assert.equal(imported.event.data.dispatchDeadlineRaw, "1785919032");
  assert.deepEqual(imported.baseline, {
    raw: 0n,
    asOf: "2026-08-04T06:37:00.000Z",
    blockNumber: 12_345_678,
    blockHash: BLOCK_HASH
  });
});

test("backfill refuses an unbounded or ambiguous RequestQueued history", async () => {
  const { runtime } = makeRuntime();
  await assert.rejects(
    runtime.backfillStagedRequestWatch({ requestId: REQUEST_ID, fromBlock: 1, toBlock: 6_002 }),
    /no wider than 5,000 blocks/u
  );
});

test("live Substrate revive event bridge publishes RequestQueued with its authoritative block and extrinsic", async () => {
  const { runtime, published, getSubscription } = makeRuntime();
  await runtime.start();
  const records = requestQueuedRecords();
  records.createdAtHash = hexCodec(BLOCK_HASH);
  getSubscription()(records);
  await runtime.flushSubstrateEventIngestion();

  assert.equal(published.length, 1);
  assert.equal(published[0].topic, "xcm.request_queued");
  assert.equal(published[0].txHash, TX_HASH);
  assert.equal(published[0].blockNumber, STAGING_BLOCK);
  assert.equal(published[0].data.requestId, REQUEST_ID);
  assert.equal(published[0].data.assetsRaw, "150000");
  assert.equal(published[0].data.dispatchDeadlineRaw, "1785919032");
});

test("Substrate event ingestion fails staging readiness honestly when block provenance is missing", async () => {
  const { runtime, getSubscription } = makeRuntime();
  await runtime.start();
  getSubscription()(requestQueuedRecords());
  await runtime.flushSubstrateEventIngestion();

  const status = await runtime.getStatus();
  assert.equal(status.readyForStaging, false);
  assert.match(status.substrateEventIngestionError, /authoritative block hash/u);
});

function requestQueuedRecords() {
  return [
    reviveRecord("RequestQueued", [
      REQUEST_ID,
      STRATEGY_ID,
      0,
      ACCOUNT,
      USDC,
      RECIPIENT,
      150_000n,
      0n,
      1n
    ], 9),
    reviveRecord("RequestParametersStored", [
      REQUEST_ID,
      100_000n,
      100_000n,
      40_000n,
      1_785_919_032n
    ], 10)
  ];
}

function reviveRecord(eventName, values, eventIndex) {
  const encoded = wrapperInterface.encodeEventLog(wrapperInterface.getEvent(eventName), values);
  return {
    eventIndex,
    phase: {
      isApplyExtrinsic: true,
      asApplyExtrinsic: stringCodec("2")
    },
    event: {
      section: "revive",
      method: "ContractEmitted",
      data: [
        stringCodec(WRAPPER),
        hexCodec(encoded.data),
        encoded.topics.map(hexCodec)
      ]
    }
  };
}

function hexCodec(value) {
  return { toHex: () => value, toString: () => value };
}

function stringCodec(value) {
  return { toString: () => value };
}

function hexExtrinsic(byte) {
  return { hash: hexCodec(`0x${byte.repeat(32)}`) };
}

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
const HYDRATION_DESTINATION = {
  v5: { parents: 1, interior: { x1: [{ parachain: 2034 }] } }
};
const ASSET_HUB_DESTINATION = {
  v5: { parents: 1, interior: { x1: [{ parachain: 1000 }] } }
};
const HYDRATION_USDC_LOCATION = {
  parents: 0,
  interior: { x2: [{ palletInstance: 10 }, { generalIndex: 22 }] }
};
const wrapperInterface = new Interface(XCM_WRAPPER_ABI);

function makeRuntime({
  observer = undefined,
  records = undefined,
  connectHangs = 0,
  subscriptionFailures = 0,
} = {}) {
  const calls = [];
  const published = [];
  const retryDelays = [];
  let subscription;
  let connectAttempts = 0;
  let subscriptionAttempts = 0;
  let resetAttempts = 0;
  const blockRecords = records ?? requestQueuedRecords();
  const eventsQuery = async (callback) => {
    subscriptionAttempts += 1;
    if (subscriptionAttempts <= subscriptionFailures) {
      throw new Error("fixture system.events subscription failure");
    }
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
    balanceReader: {
      async getSubstrateApi() {
        connectAttempts += 1;
        if (connectAttempts <= connectHangs) return new Promise(() => {});
        return api;
      },
      resetSubstrateApi() {
        resetAttempts += 1;
        return true;
      }
    },
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
    wrapperInterface,
    logger: { info() {}, error() {} },
    eventWatchConnectTimeoutMs: 5,
    eventWatchRetryBaseMs: 1,
    eventWatchRetryMaxMs: 4,
    async eventWatchSleep(ms) { retryDelays.push(ms); }
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
    getSubscription: () => subscription,
    getConnectAttempts: () => connectAttempts,
    getSubscriptionAttempts: () => subscriptionAttempts,
    getResetAttempts: () => resetAttempts,
    retryDelays,
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

test("Substrate event watch retries with backoff and recovers after the first subscription failure", async () => {
  const fixture = makeRuntime({ subscriptionFailures: 1 });

  await fixture.runtime.start();

  assert.equal(fixture.getSubscriptionAttempts(), 2);
  assert.equal(fixture.getResetAttempts(), 1);
  assert.deepEqual(fixture.retryDelays, [1]);
  assert.equal((await fixture.runtime.getStatus()).substrateEventWatchRunning, true);
  assert.equal((await fixture.runtime.getStatus()).substrateEventIngestionError, undefined);
});

test("Substrate event watch bounds a wedged connection and retries with a fresh provider", async () => {
  const fixture = makeRuntime({ connectHangs: 1 });

  await fixture.runtime.start();

  assert.equal(fixture.getConnectAttempts(), 2);
  assert.equal(fixture.getResetAttempts(), 1);
  assert.deepEqual(fixture.retryDelays, [1]);
  assert.equal((await fixture.runtime.getStatus()).substrateEventWatchRunning, true);
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

test("funding quote passes the live three-argument delivery API and keeps DOT delivery separate from USDC headroom", async () => {
  const fixture = makeFundingFeeRuntime();
  const quote = await fixture.runtime.readFundingTransferFee({ requestId: REQUEST_ID });

  assert.equal(fixture.deliveryArgs.length, 3);
  assert.deepEqual(fixture.deliveryArgs[0], HYDRATION_DESTINATION);
  assert.deepEqual(fixture.deliveryArgs[2], { V5: { parents: 1, interior: "Here" } });
  assert.deepEqual(fixture.remoteFeeAsset, { V5: HYDRATION_USDC_LOCATION });
  assert.equal(quote.amount, "565");
  assert.equal(quote.nativeDeliveryFeePlanck, "305450000");
  assert.equal(quote.nativeDeliveryFeeAsset, "DOT");
  assert.equal(quote.endpoint, "wss://hydration-rpc.n.dwellir.com/");
  assert.equal(quote.deliveryEndpoint, "wss://asset-hub-polkadot-rpc.n.dwellir.com/");
});

test("funding quote refuses implausible native delivery amounts on both sides of the denomination band", async () => {
  await assert.rejects(
    makeFundingFeeRuntime({ nativeDeliveryFeePlanck: "19999999" }).runtime.readFundingTransferFee({ requestId: REQUEST_ID }),
    /outside the 0\.002-0\.15 DOT plausibility band/u
  );
  await assert.rejects(
    makeFundingFeeRuntime({ nativeDeliveryFeePlanck: "1500000001" }).runtime.readFundingTransferFee({ requestId: REQUEST_ID }),
    /outside the 0\.002-0\.15 DOT plausibility band/u
  );
});

test("funding quote refuses a delivery quote denominated in anything except relay-native DOT", async () => {
  await assert.rejects(
    makeFundingFeeRuntime({ deliveryAsset: { parents: 0, interior: { here: null } } })
      .runtime.readFundingTransferFee({ requestId: REQUEST_ID }),
    /did not return relay-chain DOT/u
  );
});

test("funding quote refuses unless the exact wrapper call forwards one message to Hydration", async () => {
  await assert.rejects(
    makeFundingFeeRuntime({ forwardedMessages: [] }).runtime.readFundingTransferFee({ requestId: REQUEST_ID }),
    /forward exactly one message to Hydration/u
  );
  await assert.rejects(
    makeFundingFeeRuntime({ forwardedMessages: [fundingMessage(), fundingMessage()] })
      .runtime.readFundingTransferFee({ requestId: REQUEST_ID }),
    /forward exactly one message to Hydration/u
  );
});

test("withdraw-home quote binds Asset Hub execution pricing to the same-session Hydration arrival", async () => {
  const fixture = makeHomeFeeRuntime();
  const quote = await fixture.runtime.quoteHomeExecutionFee({
    requestId: REQUEST_ID,
    leg: 3
  });

  assert.equal(quote.amount, "1400");
  assert.equal(quote.grossAmount, "100000");
  assert.equal(quote.upstreamFee, "2000");
  assert.equal(quote.quotedArrival, "98000");
  assert.equal(quote.quoteSession.hydration.upstreamFeeRaw, "2000");
  assert.equal(quote.quoteSession.hydration.quotedArrivalRaw, "98000");
  assert.equal(quote.quoteSession.assetHub.homeExecutionQuoteRaw, "1400");
  assert.deepEqual(fixture.hydrationFeeAsset, { V5: HYDRATION_USDC_LOCATION });
  assert.deepEqual(fixture.assetHubFeeAsset, { V5: HYDRATION_USDC_LOCATION });
  assert.equal(fixture.hydrationDryRunCount, 1);
});

test("withdraw-home quote refuses when the forwarded arrival disagrees with the fresh Hydration fee", async () => {
  const fixture = makeHomeFeeRuntime({ forwardedArrivalRaw: "97999" });
  await assert.rejects(
    fixture.runtime.quoteHomeExecutionFee({ requestId: REQUEST_ID, leg: 3 }),
    /does not reconcile to gross amount minus the fresh upstream fee/u
  );
});

function makeFundingFeeRuntime({
  nativeDeliveryFeePlanck = "305450000",
  remoteFeeRaw = "565",
  deliveryAsset = { parents: 1, interior: { here: null } },
  forwardedMessages = [fundingMessage()]
} = {}) {
  const { runtime } = makeRuntime();
  const deliveryArgs = [];
  let remoteFeeAsset;
  const header = {
    number: { toNumber: () => 19_084_561 },
    hash: hexCodec(BLOCK_HASH)
  };
  const assetHub = {
    rpc: { chain: { async getHeader() { return header; } } },
    query: { timestamp: { async now() { return stringCodec("1785919056000"); } } },
    tx: { revive: { call(...args) { return { kind: "revive.call", args }; } } },
    call: {
      reviveApi: { async accountId() { return hexCodec(`0x${"aa".repeat(32)}`); } },
      dryRunApi: {
        async dryRunCall() {
          return {
            toJSON() {
              return {
                ok: {
                  executionResult: { ok: {} },
                  forwardedXcms: forwardedMessages.length
                    ? [[HYDRATION_DESTINATION, forwardedMessages]]
                    : []
                }
              };
            }
          };
        }
      },
      xcmPaymentApi: {
        async queryDeliveryFees(...args) {
          deliveryArgs.push(...args);
          return {
            isOk: true,
            asOk: {
              toJSON() {
                return {
                  v5: [{ id: deliveryAsset, fun: { fungible: nativeDeliveryFeePlanck } }]
                };
              }
            }
          };
        }
      }
    }
  };
  const hydration = {
    rpc: { chain: { async getHeader() { return header; } } },
    query: { timestamp: { async now() { return stringCodec("1785919056000"); } } },
    call: {
      xcmPaymentApi: {
        async queryXcmWeight() {
          return { isOk: true, asOk: { refTime: "576300688", proofSize: "10736" } };
        },
        async queryWeightToAssetFee(_weight, asset) {
          remoteFeeAsset = asset;
          return { isOk: true, asOk: stringCodec(remoteFeeRaw) };
        }
      }
    }
  };
  runtime.getAssetHubApi = async () => assetHub;
  runtime.getHydrationApi = async () => hydration;
  runtime.encodeDispatch = () => "0x1234";
  return {
    runtime,
    deliveryArgs,
    get remoteFeeAsset() { return remoteFeeAsset; }
  };
}

function makeHomeFeeRuntime({
  grossAmountRaw = "100000",
  upstreamFeeRaw = "2000",
  forwardedArrivalRaw = "98000",
  homeExecutionFeeRaw = "1400"
} = {}) {
  const { runtime } = makeRuntime();
  let hydrationFeeAsset;
  let assetHubFeeAsset;
  let hydrationDryRunCount = 0;
  const header = {
    number: { toNumber: () => 19_121_365 },
    hash: hexCodec(BLOCK_HASH)
  };
  const previewMessage = homeMessage(grossAmountRaw);
  const forwardedMessage = homeArrivalMessage(forwardedArrivalRaw);
  const assetHub = {
    rpc: { chain: { async getHeader() { return header; } } },
    query: { timestamp: { async now() { return stringCodec("1786000000000"); } } },
    createType(_name, message) { return { toJSON() { return message; } }; },
    call: {
      xcmPaymentApi: {
        async queryXcmWeight(message) {
          assert.deepEqual(message, forwardedMessage);
          return { isOk: true, asOk: { refTime: "500000000", proofSize: "12000" } };
        },
        async queryWeightToAssetFee(_weight, asset) {
          assetHubFeeAsset = asset;
          return { isOk: true, asOk: stringCodec(homeExecutionFeeRaw) };
        }
      }
    }
  };
  const hydration = {
    rpc: { chain: { async getHeader() { return header; } } },
    query: { timestamp: { async now() { return stringCodec("1786000000000"); } } },
    createType(_name, message) { return { toJSON() { return message; } }; },
    call: {
      dryRunApi: {
        async dryRunXcm(origin, message) {
          hydrationDryRunCount += 1;
          assert.deepEqual(origin, { V5: { parents: 1, interior: { X1: [{ Parachain: 1000 }] } } });
          assert.deepEqual(message, previewMessage);
          return {
            toJSON() {
              return {
                ok: {
                  executionResult: { complete: {} },
                  forwardedXcms: [[ASSET_HUB_DESTINATION, [forwardedMessage]]]
                }
              };
            }
          };
        }
      },
      xcmPaymentApi: {
        async queryXcmWeight(message) {
          assert.deepEqual(message, previewMessage);
          return { isOk: true, asOk: { refTime: "550000000", proofSize: "13000" } };
        },
        async queryWeightToAssetFee(_weight, asset) {
          hydrationFeeAsset = asset;
          return { isOk: true, asOk: stringCodec(upstreamFeeRaw) };
        }
      }
    }
  };
  runtime.getAssetHubApi = async () => assetHub;
  runtime.getHydrationApi = async () => hydration;
  runtime.previewLeg = async (_requestId, leg, feeAmount) => {
    assert.equal(leg, 3);
    assert.equal(feeAmount, 1n);
    return { destination: HYDRATION_DESTINATION, message: previewMessage };
  };
  return {
    runtime,
    get hydrationFeeAsset() { return hydrationFeeAsset; },
    get assetHubFeeAsset() { return assetHubFeeAsset; },
    get hydrationDryRunCount() { return hydrationDryRunCount; }
  };
}

function homeMessage(amount) {
  return {
    v5: [{
      withdrawAsset: [{
        id: HYDRATION_USDC_LOCATION,
        fun: { fungible: String(amount) }
      }]
    }]
  };
}

function homeArrivalMessage(amount) {
  return {
    v5: [
      {
        reserveAssetDeposited: [{
          id: HYDRATION_USDC_LOCATION,
          fun: { fungible: String(amount) }
        }]
      },
      {
        buyExecution: {
          fees: {
            id: HYDRATION_USDC_LOCATION,
            fun: { fungible: "1" }
          },
          weightLimit: "Unlimited"
        }
      }
    ]
  };
}

function fundingMessage() {
  return {
    v5: [
      {
        buyExecution: {
          fees: { id: HYDRATION_USDC_LOCATION, fun: { fungible: "150000" } },
          weightLimit: "Unlimited"
        }
      }
    ]
  };
}

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

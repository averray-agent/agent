import assert from "node:assert/strict";
import test from "node:test";

import {
  BankXcmV22Runtime,
  createBankXcmV22RuntimeServices
} from "./bank-xcm-v22-runtime.js";

const WRAPPER = "0x1111111111111111111111111111111111111111";
const ADAPTER = "0x2222222222222222222222222222222222222222";
const OPERATOR = "0x3333333333333333333333333333333333333333";
const USDC = "0x0000053900000000000000000000000001200000";
const AUSDC = "0x2ec4884088d84e5c2970a034732e5209b0acfa93";
const REQUEST_ID = `0x${"44".repeat(32)}`;
const BLOCK_HASH = `0x${"55".repeat(32)}`;

function makeRuntime({ observer = undefined } = {}) {
  const calls = [];
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
  const wrapper = {
    filters: { RequestQueued: (requestId) => ({ requestId }) },
    async queryFilter(_filter, fromBlock, toBlock) {
      calls.push({ fromBlock, toBlock });
      return [{
        transactionHash: `0x${"66".repeat(32)}`,
        index: 3,
        blockNumber: 900,
        args: {
          requestId: REQUEST_ID,
          strategyId: `0x${"77".repeat(32)}`,
          kind: 0,
          account: "0x8888888888888888888888888888888888888888",
          asset: USDC,
          recipient: "0x9999999999999999999999999999999999999999",
          assets: 150_000n,
          shares: 0n,
          nonce: 1n
        }
      }];
    },
    async getRequestParameters() {
      return { dispatchDeadline: 1_785_919_032n };
    }
  };
  const gateway = {
    hasXcmWrapper: () => true,
    provider: {
      async getBlockNumber() { return 1_000; },
      async getBlock(block) {
        assert.equal(block, 900);
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
    adapterAddress: ADAPTER,
    assetHubSubstrateEndpoint: "wss://asset-hub-polkadot-rpc.n.dwellir.com/",
    hydrationSubstrateEndpoint: "wss://hydration-rpc.n.dwellir.com/",
    wrapperContract: wrapper,
    adapterContract: {},
    wrapperInterface: { encodeFunctionData() { return "0x1234"; } }
  });
  runtime.readStampedBalance = async () => ({
    raw: 0n,
    asOf: "2026-08-04T06:37:00.000Z",
    blockNumber: 12_345_678,
    blockHash: BLOCK_HASH
  });
  return { runtime, calls };
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

test("enabled runtime reports staging readiness only with a running chain-event observer", async () => {
  const { runtime } = makeRuntime();
  assert.deepEqual(await runtime.getStatus(), {
    enabled: true,
    wrapper: WRAPPER,
    adapter: ADAPTER,
    observerEnabled: true,
    observerRunning: true,
    chainEventWatchEnabled: true,
    chainEventIngestionError: undefined,
    readyForStaging: true
  });
  assert.ok(runtime.createDispatcher());
});

test("staged-request backfill derives the event and block-bound baseline from chain truth", async () => {
  const { runtime, calls } = makeRuntime();
  const watch = await runtime.backfillStagedRequestWatch({
    requestId: REQUEST_ID,
    fromBlock: 900,
    toBlock: 900
  });

  assert.equal(watch.registrationSource, "chain_event_backfill");
  assert.equal(watch.baselineRaw, "0");
  assert.equal(watch.baselineBlockNumber, 12_345_678);
  assert.equal(watch.baselineBlockHash, BLOCK_HASH);
  const imported = calls.find((entry) => entry.event);
  assert.equal(imported.event.txHash, `0x${"66".repeat(32)}`);
  assert.equal(imported.event.blockNumber, 900);
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

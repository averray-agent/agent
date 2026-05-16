import test from "node:test";
import assert from "node:assert/strict";

import { EventListener } from "./event-listener.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const ASSET = "0x3333333333333333333333333333333333333333";
const REQUEST_ID = `0x${"aa".repeat(32)}`;
const STRATEGY_ID = `0x${"bb".repeat(32)}`;

function makeContract({ address, eventTopics = {} } = {}) {
  return {
    target: address,
    interface: {
      getEvent(name) {
        const topicHash = eventTopics[name];
        return topicHash ? { topicHash } : null;
      }
    }
  };
}

const XCM_CONTRACT_ADDRESS = `0x${"ab".repeat(20)}`;
const XCM_EVENT_TOPICS = {
  RequestQueued: `0x${"01".repeat(32)}`,
  RequestPayloadStored: `0x${"02".repeat(32)}`,
  RequestDispatched: `0x${"03".repeat(32)}`,
  RequestStatusUpdated: `0x${"04".repeat(32)}`
};

function makeListener({ gateway = {}, xcmRequest = {} } = {}) {
  const xcmWrapperContract = makeContract({
    address: XCM_CONTRACT_ADDRESS,
    eventTopics: XCM_EVENT_TOPICS
  });
  const events = [];
  const listener = new EventListener(
    {
      isEnabled: () => true,
      provider: {
        getBlock: async () => ({ timestamp: 1_700_000_000n }),
        getBlockNumber: async () => 12_345n,
        getLogs: async () => []
      },
      xcmWrapperContract,
      getXcmRequest: async () => ({
        account: ACCOUNT,
        strategyId: STRATEGY_ID,
        kind: 0,
        status: 1,
        statusLabel: "pending",
        remoteRef: `0x${"00".repeat(32)}`,
        remoteRefLabel: "",
        failureCode: `0x${"00".repeat(32)}`,
        failureCodeLabel: "",
        ...xcmRequest
      }),
      ...gateway
    },
    {
      publish(event) {
        events.push(event);
        return event;
      }
    },
    undefined,
    { pollIntervalMs: 60_000 }
  );
  return { listener, xcmWrapperContract, events };
}

const DEFAULT_LOG = {
  transactionHash: `0x${"12".repeat(32)}`,
  index: 0,
  blockNumber: 12_345n
};

async function emit(listener, eventName, args, log = {}) {
  await listener.dispatch(eventName, args, { ...DEFAULT_LOG, ...log });
}

test("EventListener preserves unsafe XCM queued nonce as raw string", async () => {
  const { listener, xcmWrapperContract, events } = makeListener();
  await listener.start();
  const unsafeNonce = BigInt(Number.MAX_SAFE_INTEGER) + 99n;

  await emit(listener, "RequestQueued", {
    requestId: REQUEST_ID,
    strategyId: STRATEGY_ID,
    kind: 0,
    account: ACCOUNT,
    asset: ASSET,
    recipient: RECIPIENT,
    assets: 1_250_000n,
    shares: 500_000n,
    nonce: unsafeNonce
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].topic, "xcm.request_queued");
  assert.equal(events[0].data.assets, "1250000");
  assert.equal(events[0].data.assetsRaw, "1250000");
  assert.equal(events[0].data.shares, "500000");
  assert.equal(events[0].data.sharesRaw, "500000");
  assert.equal(events[0].data.nonce, unsafeNonce.toString());
  assert.equal(events[0].data.nonceRaw, unsafeNonce.toString());
  assert.equal(events[0].data.blockNumberRaw, "12345");
});

test("EventListener preserves unsafe XCM weight fields as raw strings", async () => {
  const { listener, xcmWrapperContract, events } = makeListener();
  await listener.start();
  const unsafeRefTime = BigInt(Number.MAX_SAFE_INTEGER) + 123n;

  await emit(listener, "RequestPayloadStored", {
    requestId: REQUEST_ID,
    destinationHash: `0x${"cc".repeat(32)}`,
    messageHash: `0x${"dd".repeat(32)}`,
    refTime: unsafeRefTime,
    proofSize: 777n
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].topic, "xcm.request_payload_stored");
  assert.equal(events[0].data.refTime, unsafeRefTime.toString());
  assert.equal(events[0].data.refTimeRaw, unsafeRefTime.toString());
  assert.equal(events[0].data.proofSize, 777);
  assert.equal(events[0].data.proofSizeRaw, "777");
});

test("EventListener exposes raw settled XCM amounts on status updates", async () => {
  const { listener, xcmWrapperContract, events } = makeListener({
    xcmRequest: { status: 2, statusLabel: "succeeded" }
  });
  await listener.start();
  const settledAssets = 12_500_000_000_000_000_000n;
  const settledShares = 2_500_000_000_000_000_000n;

  await emit(listener, "RequestStatusUpdated", {
    requestId: REQUEST_ID,
    status: 2,
    settledAssets,
    settledShares
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].topic, "xcm.request_status_updated");
  assert.equal(events[0].data.status, 2);
  assert.equal(events[0].data.statusLabel, "succeeded");
  assert.equal(events[0].data.settledAssets, settledAssets.toString());
  assert.equal(events[0].data.settledAssetsRaw, settledAssets.toString());
  assert.equal(events[0].data.settledShares, settledShares.toString());
  assert.equal(events[0].data.settledSharesRaw, settledShares.toString());
});

test("EventListener readJob preserves unsafe lifecycle timestamps as raw strings", async () => {
  const unsafeClaimExpiry = BigInt(Number.MAX_SAFE_INTEGER) + 456n;
  const unsafeDisputedAt = BigInt(Number.MAX_SAFE_INTEGER) + 789n;
  const { listener } = makeListener({
    gateway: {
      escrowContract: {
        jobs: async () => ({
          poster: ACCOUNT,
          worker: RECIPIENT,
          verifier: `0x${"44".repeat(20)}`,
          asset: ASSET,
          reward: 1_000n,
          released: 0n,
          claimExpiry: unsafeClaimExpiry,
          claimStake: 0n,
          claimStakeBps: 0n,
          claimFee: 0n,
          claimFeeBps: 0n,
          claimEconomicsWaived: false,
          rejectingVerifier: `0x${"55".repeat(20)}`,
          rejectedAt: 777n,
          disputedAt: unsafeDisputedAt,
          state: 2n
        })
      }
    }
  });

  const job = await listener.readJob(REQUEST_ID);

  assert.equal(job.claimExpiry, unsafeClaimExpiry.toString());
  assert.equal(job.claimExpiryRaw, unsafeClaimExpiry.toString());
  assert.equal(job.rejectedAt, 777);
  assert.equal(job.rejectedAtRaw, "777");
  assert.equal(job.disputedAt, unsafeDisputedAt.toString());
  assert.equal(job.disputedAtRaw, unsafeDisputedAt.toString());
});

test("EventListener pollOnce queries eth_getLogs and advances lastBlock", async () => {
  const getLogsCalls = [];
  const { listener } = makeListener({
    gateway: {
      provider: {
        getBlock: async () => ({ timestamp: 1_700_000_000n }),
        getBlockNumber: async () => 1_010n,
        async getLogs(filter) {
          getLogsCalls.push(filter);
          return [];
        }
      }
    }
  });

  listener.running = true;
  listener.attachEventHandlers();
  listener.lastBlock = 1_000;
  await listener.pollOnce();

  assert.equal(getLogsCalls.length, 1);
  assert.equal(getLogsCalls[0].fromBlock, 1_001);
  assert.equal(getLogsCalls[0].toBlock, 1_010);
  assert.equal(getLogsCalls[0].address, XCM_CONTRACT_ADDRESS.toLowerCase());
  assert.equal(listener.lastBlock, 1_010);

  await listener.stop();
});

test("EventListener pollOnce skips when head has not advanced", async () => {
  const getLogsCalls = [];
  const { listener } = makeListener({
    gateway: {
      provider: {
        getBlock: async () => ({ timestamp: 1_700_000_000n }),
        getBlockNumber: async () => 1_000n,
        async getLogs(filter) {
          getLogsCalls.push(filter);
          return [];
        }
      }
    }
  });

  listener.running = true;
  listener.attachEventHandlers();
  listener.lastBlock = 1_000;
  await listener.pollOnce();

  assert.equal(getLogsCalls.length, 0);
  assert.equal(listener.lastBlock, 1_000);

  await listener.stop();
});

test("EventListener pollOnce surfaces provider errors and schedules reconnect", async () => {
  const { listener, events } = makeListener({
    gateway: {
      provider: {
        getBlock: async () => ({ timestamp: 1_700_000_000n }),
        getBlockNumber: async () => {
          throw new Error("Method not found");
        },
        getLogs: async () => []
      }
    }
  });

  listener.running = true;
  listener.attachEventHandlers();
  listener.lastBlock = 0;
  await listener.pollOnce();

  const providerError = events.find((event) => event.topic === "system.provider_error");
  const reconnect = events.find((event) => event.topic === "system.reconnect");
  assert.ok(providerError, "expected provider error event");
  assert.match(providerError.data.message, /Method not found/u);
  assert.ok(reconnect, "expected reconnect event");
  assert.ok(reconnect.data.delayMs >= 1_000);

  await listener.stop();
});

test("EventListener register skips contracts missing interface or target", () => {
  const { listener } = makeListener();
  const before = listener.registrations.length;
  listener.register(undefined, "JobFunded", async () => null);
  listener.register({ target: "0x123" }, "JobFunded", async () => null);
  listener.register({ interface: { getEvent: () => null } }, "JobFunded", async () => null);
  assert.equal(listener.registrations.length, before);
});

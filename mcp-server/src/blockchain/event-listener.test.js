import test from "node:test";
import assert from "node:assert/strict";

import { EventListener } from "./event-listener.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const ASSET = "0x3333333333333333333333333333333333333333";
const REQUEST_ID = `0x${"aa".repeat(32)}`;
const STRATEGY_ID = `0x${"bb".repeat(32)}`;

function makeContract() {
  const handlers = new Map();
  return {
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
    off(eventName, handler) {
      if (handlers.get(eventName) === handler) {
        handlers.delete(eventName);
      }
    },
    async emitEvent(eventName, args, log = {}) {
      const handler = handlers.get(eventName);
      assert.ok(handler, `missing handler for ${eventName}`);
      await handler({
        args,
        log: {
          transactionHash: `0x${"12".repeat(32)}`,
          index: 0,
          blockNumber: 12345n,
          ...log
        }
      });
    }
  };
}

function makeListener({ gateway = {}, xcmRequest = {} } = {}) {
  const xcmWrapperContract = makeContract();
  const events = [];
  const listener = new EventListener(
    {
      isEnabled: () => true,
      provider: {
        on() {},
        off() {},
        getBlock: async () => ({ timestamp: 1_700_000_000n })
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
    }
  );
  return { listener, xcmWrapperContract, events };
}

test("EventListener preserves unsafe XCM queued nonce as raw string", async () => {
  const { listener, xcmWrapperContract, events } = makeListener();
  await listener.start();
  const unsafeNonce = BigInt(Number.MAX_SAFE_INTEGER) + 99n;

  await xcmWrapperContract.emitEvent("RequestQueued", {
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

  await xcmWrapperContract.emitEvent("RequestPayloadStored", {
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

  await xcmWrapperContract.emitEvent("RequestStatusUpdated", {
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

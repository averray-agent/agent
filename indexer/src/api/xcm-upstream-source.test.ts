import assert from "node:assert/strict";
import test from "node:test";

import {
  NativePapiXcmSourceAdapter,
  createXcmUpstreamSourceAdapter,
  decodeNativePapiCursor,
  encodeNativePapiCursor,
  normalizeNativeXcmEvidence
} from "./xcm-upstream-source.ts";

const requestId = `0x${"11".repeat(32)}`;
const remoteRef = `0x${"22".repeat(32)}`;
const failureCode = `0x${"33".repeat(32)}`;

test("native PAPI cursor helpers round-trip hub and Bifrost block positions", () => {
  const cursor = encodeNativePapiCursor({ hubBlock: 123, bifrostBlock: 456 });

  assert.deepEqual(decodeNativePapiCursor(cursor), {
    hubBlock: 123,
    bifrostBlock: 456
  });
});

test("native PAPI cursor decode falls back on missing or invalid cursors", () => {
  assert.deepEqual(decodeNativePapiCursor(undefined, 99), {
    hubBlock: 99,
    bifrostBlock: 99
  });
  assert.deepEqual(decodeNativePapiCursor("not-base64", 7), {
    hubBlock: 7,
    bifrostBlock: 7
  });
});

test("native PAPI evidence normalizes into the published outcome contract", () => {
  const outcome = normalizeNativeXcmEvidence({
    requestId,
    status: "Succeeded",
    remoteRef,
    observedAt: "2026-04-23T12:00:00.000Z",
    decision: {
      settledAssets: "5000000000000",
      settledShares: "4900000000000"
    },
    hub: {
      blockNumber: "123"
    },
    bifrost: {
      blockNumber: "456"
    }
  });

  assert.deepEqual(outcome, {
    requestId,
    status: "succeeded",
    settledAssets: "5000000000000",
    settledShares: "4900000000000",
    remoteRef,
    failureCode: null,
    observedAt: "2026-04-23T12:00:00.000Z",
    source: "native_papi_observer"
  });
});

test("native PAPI evidence preserves explicit failure metadata", () => {
  const outcome = normalizeNativeXcmEvidence({
    requestId,
    status: "failed",
    settledAssets: 0,
    settledShares: 0,
    failureCode,
    observedAt: "2026-04-23T12:30:00.000Z",
    source: "native_papi_staging"
  });

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failureCode, failureCode);
  assert.equal(outcome.source, "native_papi_staging");
});

test("native PAPI source validates required endpoints and describes configuration", () => {
  assert.throws(
    () => createXcmUpstreamSourceAdapter({ type: "native_papi" }),
    /XCM_NATIVE_HUB_WS/u
  );

  const adapter = createXcmUpstreamSourceAdapter({
    type: "native_papi",
    nativeHubWs: "wss://hub.example",
    nativeBifrostWs: "wss://bifrost.example",
    nativeStartBlock: 10,
    nativeConfirmations: 4
  });

  assert.ok(adapter instanceof NativePapiXcmSourceAdapter);
  assert.deepEqual(adapter.describe(), {
    type: "native_papi",
    hubWs: "wss://hub.example",
    bifrostWs: "wss://bifrost.example",
    startBlock: 10,
    confirmations: 4
  });
});

test("native PAPI source fails clearly until live reads are implemented", async () => {
  const adapter = new NativePapiXcmSourceAdapter({
    hubWs: "wss://hub.example",
    bifrostWs: "wss://bifrost.example"
  });

  await assert.rejects(
    () => adapter.fetchBatch({ limit: 25 }),
    /correlation gate/u
  );
});

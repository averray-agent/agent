import test from "node:test";
import assert from "node:assert/strict";

import {
  appendSetTopic,
  buildXcmRequestPayload,
  encodeVersionedParachainLocation,
  resolveDestinationParachainId,
  XCM_SET_TOPIC_INSTRUCTION
} from "./xcm-message-builder.js";

const REQUEST_ID = `0x${"11".repeat(32)}`;

function vdotStrategy(overrides = {}) {
  return {
    strategyId: `0x${"22".repeat(32)}`,
    kind: "polkadot_vdot",
    assetConfig: {
      assetClass: "foreign",
      foreignAssetIndex: 5,
      symbol: "vDOT",
      xcmLocation: "{ parents: 1, interior: X1(Parachain(2030)) }"
    },
    ...overrides
  };
}

test("encodeVersionedParachainLocation builds the Bifrost destination location", () => {
  assert.equal(encodeVersionedParachainLocation(2030), "0x05010100ee070000");
});

test("resolveDestinationParachainId reads the strategy asset XCM location", () => {
  assert.equal(resolveDestinationParachainId(vdotStrategy()), 2030);
});

test("resolveDestinationParachainId allows an explicit strategy XCM override", () => {
  assert.equal(resolveDestinationParachainId(vdotStrategy({ xcm: { destinationParachain: 2001 } })), 2001);
});

test("appendSetTopic appends the request id as the final XCM instruction", () => {
  const message = appendSetTopic("0x050c000102", REQUEST_ID);
  assert.equal(message, `0x050c000102${XCM_SET_TOPIC_INSTRUCTION.toString(16)}${"11".repeat(32)}`);
});

test("buildXcmRequestPayload creates deterministic deposit and withdraw payloads", () => {
  const deposit = buildXcmRequestPayload({
    strategy: vdotStrategy(),
    direction: "deposit",
    requestId: REQUEST_ID
  });
  const withdraw = buildXcmRequestPayload({
    strategy: vdotStrategy(),
    direction: "withdraw",
    requestId: REQUEST_ID
  });

  assert.equal(deposit.destination, "0x05010100ee070000");
  assert.equal(withdraw.destination, "0x05010100ee070000");
  assert.match(deposit.message, /^0x0510/u);
  assert.match(withdraw.message, /^0x050c/u);
  assert.ok(deposit.message.endsWith(`2c${"11".repeat(32)}`));
  assert.ok(withdraw.message.endsWith(`2c${"11".repeat(32)}`));
  assert.deepEqual(deposit.maxWeight, { refTime: 0, proofSize: 0 });
});

test("buildXcmRequestPayload rejects unsupported strategy kinds", () => {
  assert.throws(
    () => buildXcmRequestPayload({ strategy: vdotStrategy({ kind: "mock_vdot" }), direction: "deposit", requestId: REQUEST_ID }),
    /Unsupported async XCM strategy kind/u
  );
});

test("buildXcmRequestPayload rejects missing or malformed request ids", () => {
  assert.throws(
    () => buildXcmRequestPayload({ strategy: vdotStrategy(), direction: "deposit", requestId: "0x1234" }),
    /requestId must be/u
  );
});

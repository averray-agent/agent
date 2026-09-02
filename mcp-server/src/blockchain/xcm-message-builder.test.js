import test from "node:test";
import assert from "node:assert/strict";

import {
  buildParaSpellDestination,
  buildXcmRequestPayload,
  encodeVersionedParachainLocation,
  encodeVersionedXcm,
  resolveDestinationParachainId,
  XCM_SET_TOPIC_INSTRUCTION
} from "./xcm-message-builder.js";

const REQUEST_ID = `0x${"11".repeat(32)}`;
const ACCOUNT = "0x1234567890123456789012345678901234567890";
const RECIPIENT = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

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
    xcm: {
      destinationParachain: 2030
    },
    ...overrides
  };
}

test("encodeVersionedParachainLocation builds the Bifrost destination location", () => {
  assert.equal(encodeVersionedParachainLocation(2030), "0x05010100ee070000");
});

test("buildParaSpellDestination returns a ParaSpell VersionedLocation", () => {
  assert.deepEqual(buildParaSpellDestination(vdotStrategy()), {
    V5: {
      parents: 1,
      interior: {
        X1: [{ Parachain: 2030 }]
      }
    }
  });
});

test("resolveDestinationParachainId reads the strategy asset XCM location", () => {
  assert.equal(resolveDestinationParachainId(vdotStrategy({ xcm: undefined })), 2030);
});

test("resolveDestinationParachainId allows an explicit strategy XCM override", () => {
  assert.equal(resolveDestinationParachainId(vdotStrategy({ xcm: { destinationParachain: 2001 } })), 2001);
});

test("encodeVersionedXcm encodes the supported PAPI/ParaSpell v5 instruction subset", () => {
  const message = encodeVersionedXcm({
    V5: [
      {
        WithdrawAsset: [
          {
            id: { parents: 1, interior: "Here" },
            fun: { Fungible: 1_000_000_000n }
          }
        ]
      },
      {
        PayFees: {
          id: { parents: 1, interior: "Here" },
          fun: { Fungible: 1_000_000n }
        }
      },
      {
        DepositAsset: {
          assets: { Wild: { AllCounted: 1 } },
          beneficiary: { parents: 0, interior: { X1: [{ AccountKey20: { network: null, key: ACCOUNT } }] } }
        }
      },
      { SetTopic: REQUEST_ID }
    ]
  });

  assert.ok(message.startsWith("0x0510"));
  assert.ok(message.includes("1301000002"));
  assert.ok(message.includes(`0d01010100000000010300${ACCOUNT.slice(2)}`));
  assert.ok(message.endsWith(`${XCM_SET_TOPIC_INSTRUCTION.toString(16)}${"11".repeat(32)}`));
});

test("buildXcmRequestPayload creates deterministic deposit and withdraw payloads without raw prefixes", () => {
  const deposit = buildXcmRequestPayload({
    strategy: vdotStrategy(),
    direction: "deposit",
    requestId: REQUEST_ID,
    account: ACCOUNT,
    recipient: ACCOUNT,
    amount: 1_000_000_000
  });
  const withdraw = buildXcmRequestPayload({
    strategy: vdotStrategy(),
    direction: "withdraw",
    requestId: REQUEST_ID,
    account: ACCOUNT,
    recipient: RECIPIENT,
    amount: 2_000_000_000,
    shares: 2_000_000_000
  });

  assert.equal(deposit.destination, "0x05010100ee070000");
  assert.equal(withdraw.destination, "0x05010100ee070000");
  assert.ok(deposit.message.startsWith("0x0510"));
  assert.ok(withdraw.message.startsWith("0x0510"));
  assert.ok(deposit.message.endsWith(`2c${"11".repeat(32)}`));
  assert.ok(withdraw.message.endsWith(`2c${"11".repeat(32)}`));
  assert.notEqual(deposit.message, withdraw.message);
  assert.deepEqual(deposit.maxWeight, { refTime: 0, proofSize: 0 });
});

test("buildXcmRequestPayload honors configured 32-byte beneficiary locations", () => {
  const beneficiary = `0x${"aa".repeat(32)}`;
  const payload = buildXcmRequestPayload({
    strategy: vdotStrategy({ xcm: { destinationParachain: 2030, beneficiary } }),
    direction: "deposit",
    requestId: REQUEST_ID,
    account: ACCOUNT,
    recipient: ACCOUNT,
    amount: 1_000_000_000
  });

  assert.ok(payload.message.includes(`0100${"aa".repeat(32)}`));
});

test("buildXcmRequestPayload rejects unsupported strategy kinds", () => {
  assert.throws(
    () => buildXcmRequestPayload({
      strategy: vdotStrategy({ kind: "mock_vdot" }),
      direction: "deposit",
      requestId: REQUEST_ID,
      account: ACCOUNT,
      amount: 1
    }),
    /Unsupported async XCM strategy kind/u
  );
});

test("buildXcmRequestPayload rejects missing amount context", () => {
  assert.throws(
    () => buildXcmRequestPayload({
      strategy: vdotStrategy(),
      direction: "deposit",
      requestId: REQUEST_ID,
      account: ACCOUNT
    }),
    /deposit amount must be/u
  );
});

test("buildXcmRequestPayload rejects missing or malformed request ids", () => {
  assert.throws(
    () => buildXcmRequestPayload({
      strategy: vdotStrategy(),
      direction: "deposit",
      requestId: "0x1234",
      account: ACCOUNT,
      amount: 1
    }),
    /requestId must be/u
  );
});

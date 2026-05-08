import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMultisigOwnerRecord,
  normalizeSignatories
} from "./prepare-multisig-owner-record.mjs";

const SIGNATORIES = [
  "0x3333333333333333333333333333333333333333333333333333333333333333",
  "0x1111111111111111111111111111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222222222222222222222222222"
];

test("buildMultisigOwnerRecord derives a stable multisig owner record", async () => {
  const record = await buildMultisigOwnerRecord({
    profile: "testnet",
    threshold: 2,
    signatories: SIGNATORIES
  });

  assert.equal(record.status, "draft");
  assert.equal(record.threshold, 2);
  assert.deepEqual(record.signatories.map((entry) => entry.accountId32), [
    "0x1111111111111111111111111111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333333333333333333333333333"
  ]);
  assert.equal(record.multisig.ss58Address, "1pEnJbesJVDcSG7TixQvkZoDYkCXsp4afj2rNgLREsc94eD");
  assert.equal(record.multisig.accountId32, "0x2406ece07636b132f3091e772b0408c7aa0d1543f5df80881a69fd518a4b0034");
  assert.equal(record.multisig.ownerEnvValue, "0x6fa3fa64bba94777ea5b938cc59c0316d3335730");
  assert.equal(record.mapAccount.required, true);
  assert.equal(record.launchGate.readyForOwnerUse, false);
});

test("buildMultisigOwnerRecord fails closed for final records without live evidence", async () => {
  await assert.rejects(
    () => buildMultisigOwnerRecord({
      threshold: 2,
      signatories: SIGNATORIES,
      final: true,
      mapAccountTxHash: "0xmap"
    }),
    /--final requires/u
  );
});

test("buildMultisigOwnerRecord marks complete evidence as verified", async () => {
  const record = await buildMultisigOwnerRecord({
    threshold: 2,
    signatories: SIGNATORIES,
    mapAccountTxHash: "0xmap",
    ownershipTransferTxHash: "0xowner",
    adminRehearsalTxHash: "0xadmin",
    verifyDeploymentRun: "25500000000",
    final: true
  });

  assert.equal(record.status, "verified");
  assert.equal(record.mapAccount.status, "recorded");
  assert.equal(record.launchGate.readyForOwnerUse, true);
});

test("normalizeSignatories rejects duplicate accounts", async () => {
  await assert.rejects(
    () => buildMultisigOwnerRecord({
      threshold: 2,
      signatories: [
        "0x1111111111111111111111111111111111111111111111111111111111111111",
        "0x1111111111111111111111111111111111111111111111111111111111111111"
      ]
    }),
    /unique/u
  );

  assert.deepEqual(
    normalizeSignatories(SIGNATORIES.join(",")),
    SIGNATORIES
  );
});

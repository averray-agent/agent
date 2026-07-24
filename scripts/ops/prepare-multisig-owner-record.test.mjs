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

test("auto_map records the on-chain mapping without a mapping extrinsic", async () => {
  const record = await buildMultisigOwnerRecord({
    profile: "mainnet",
    threshold: 2,
    signatories: SIGNATORIES,
    mapAccountMechanism: "auto_map",
    autoMapVerified: true,
    accountCreationBlock: "18618014",
    accountCreationTxHash: "0xcreate"
  });

  assert.equal(record.mapAccount.mechanism, "auto_map");
  assert.equal(record.mapAccount.required, false);
  assert.equal(record.mapAccount.status, "auto_mapped");
  assert.equal(record.mapAccount.txHash, null);
  assert.equal(record.mapAccount.extrinsic, null);
  assert.equal(record.mapAccount.autoMap.originalAccountVerified, true);
  assert.equal(record.mapAccount.autoMap.accountCreationTxHash, "0xcreate");
  // The proof must be re-checkable chain state, not a bare assertion.
  assert.equal(
    record.mapAccount.autoMap.verify.storage,
    `revive.originalAccount(${record.multisig.ownerEnvValue})`
  );
  assert.equal(record.mapAccount.autoMap.verify.expect, record.multisig.accountId32);
});

test("auto_map refuses to file an unrelated hash as the mapping extrinsic", async () => {
  // Regression guard: under AutoMap no map_account() extrinsic exists, so passing
  // the account-creating funding transfer here would record it as proof of a
  // mapping call that never happened.
  await assert.rejects(
    () => buildMultisigOwnerRecord({
      threshold: 2,
      signatories: SIGNATORIES,
      mapAccountMechanism: "auto_map",
      mapAccountTxHash: "0xfundingtransfer"
    }),
    /--map-account-tx is invalid with --map-account-mechanism auto_map/u
  );
});

test("auto_map without on-chain verification stays a draft and cannot be finalized", async () => {
  const record = await buildMultisigOwnerRecord({
    threshold: 2,
    signatories: SIGNATORIES,
    mapAccountMechanism: "auto_map",
    ownershipTransferTxHash: "0xowner",
    adminRehearsalTxHash: "0xadmin",
    verifyDeploymentRun: "25500000000"
  });
  assert.equal(record.mapAccount.status, "pending");
  assert.equal(record.status, "draft");
  assert.equal(record.launchGate.readyForOwnerUse, false);

  await assert.rejects(
    () => buildMultisigOwnerRecord({
      threshold: 2,
      signatories: SIGNATORIES,
      mapAccountMechanism: "auto_map",
      ownershipTransferTxHash: "0xowner",
      adminRehearsalTxHash: "0xadmin",
      verifyDeploymentRun: "25500000000",
      final: true
    }),
    /--final requires --auto-map-verified/u
  );
});

test("auto_map with full evidence verifies", async () => {
  const record = await buildMultisigOwnerRecord({
    threshold: 2,
    signatories: SIGNATORIES,
    mapAccountMechanism: "auto_map",
    autoMapVerified: true,
    ownershipTransferTxHash: "0xowner",
    adminRehearsalTxHash: "0xadmin",
    verifyDeploymentRun: "25500000000",
    final: true
  });
  assert.equal(record.status, "verified");
  assert.equal(record.launchGate.readyForOwnerUse, true);
});

test("an unknown mapping mechanism is rejected", async () => {
  await assert.rejects(
    () => buildMultisigOwnerRecord({
      threshold: 2,
      signatories: SIGNATORIES,
      mapAccountMechanism: "assumed"
    }),
    /must be "extrinsic" or "auto_map"/u
  );
});

test("the extrinsic mechanism remains the default and is unchanged", async () => {
  const record = await buildMultisigOwnerRecord({
    threshold: 2,
    signatories: SIGNATORIES,
    mapAccountTxHash: "0xmap"
  });
  assert.equal(record.mapAccount.mechanism, "extrinsic");
  assert.equal(record.mapAccount.required, true);
  assert.equal(record.mapAccount.extrinsic, "pallet_revive.map_account()");
  assert.equal(record.mapAccount.status, "recorded");
  assert.equal(record.mapAccount.autoMap, null);
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

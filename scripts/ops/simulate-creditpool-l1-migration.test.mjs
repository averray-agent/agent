import assert from "node:assert/strict";
import test from "node:test";
import { getCreateAddress } from "ethers";

import {
  assertByteExactMigration,
  buildVestingMigrationRecord,
  predictCreditPoolMigrationAddresses
} from "./simulate-creditpool-l1-migration.mjs";

const DEPLOYER = "0x9Ab8531FBb0948C542a31298FD61335f30064239";

test("migration predictions reserve the four consecutive circular-wiring CREATEs", () => {
  const value = predictCreditPoolMigrationAddresses(DEPLOYER, 14);
  assert.deepEqual(value, {
    lane: getCreateAddress({ from: DEPLOYER, nonce: 14 }),
    venueAdapter: getCreateAddress({ from: DEPLOYER, nonce: 15 }),
    depositPoolV2: getCreateAddress({ from: DEPLOYER, nonce: 16 }),
    creditPool: getCreateAddress({ from: DEPLOYER, nonce: 17 })
  });
});

test("migration acceptance refuses any share, asset, principal, tranche, or age drift", () => {
  const position = {
    sharesRaw: "10000000",
    assetsRaw: "10000123",
    principalRaw: "10000000",
    tranches: [{ depositedRaw: "10000000", remainingRaw: "10000000", depositedAt: "2026-08-12T00:00:00.000Z" }]
  };
  assert.equal(assertByteExactMigration({ before: position, after: structuredClone(position) }), true);
  assert.throws(() => assertByteExactMigration({ before: position, after: { ...position, sharesRaw: "10000001" } }), /sharesRaw drift/u);
  assert.throws(() => assertByteExactMigration({ before: position, after: { ...position, tranches: [{ ...position.tranches[0], depositedAt: "2026-08-13T00:00:00.000Z" }] } }), /tranches or ages drifted/u);
});

test("vesting migration record names only the paired transfer events to ignore", () => {
  const value = buildVestingMigrationRecord({
    fromPool: "0x1111111111111111111111111111111111111111",
    toPool: "0x2222222222222222222222222222222222222222",
    wallet: "0x3333333333333333333333333333333333333333",
    oldWithdrawTx: `0x${"44".repeat(32)}`,
    newDepositTx: `0x${"55".repeat(32)}`,
    tranches: [{ depositedRaw: "10", remainingRaw: "9", depositedAt: "2026-08-12T00:00:00Z", blockNumber: 1, logIndex: 2 }]
  });
  assert.equal(value.preservedTranches[0].depositedAt, "2026-08-12T00:00:00.000Z");
  assert.equal(value.ignoredTransferEvents.oldWithdrawTx, `0x${"44".repeat(32)}`);
});

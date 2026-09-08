import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStateStore } from "../core/state-store.js";
import { buildYieldAttribution, YieldAttributionService } from "./yield-attribution-service.js";
import { DepositPoolDoorService } from "./deposit-pool-door.js";
import { createDepositPoolRoutes } from "../protocols/http/deposit-pool-routes.js";

const POOL = "0x9B35A102d656Fb86d798aF81959e09961DEc28E0";
const ASSET = "0x0000053900000000000000000000000001200000";
const events = [{ type: "Deposit", owner: "0x1111111111111111111111111111111111111111", assetsRaw: "19962187", sharesRaw: "19962187", blockNumber: 1, logIndex: 0 }];
const snapshot = {
  blockNumber: 20421344, asset: ASSET, totalSupply: 19962187n,
  totalAssets: 20511787n, bufferAssets: 10581650n,
  deployedPrincipal: 9930137n, venueMarkedAssets: 9930537n,
  totalAssetCap: 1000000000n, perAgentAssetCap: 100000000n
};

test("unattested NAV gain is unattributed and never becomes venue earnings", () => {
  const idle = { ...snapshot, deployedPrincipal: 0n, venueMarkedAssets: null, bufferAssets: 20512187n };
  const result = buildYieldAttribution({ snapshot: idle, events });
  assert.equal(result.gain.cumulativeNav.raw, "550000");
  assert.equal(result.gain.venueEarned.raw, "0");
  assert.equal(result.gain.operatorAdded.raw, "0");
  assert.equal(result.gain.unattributed.raw, "550000");
  assert.match(result.statement, /cannot attribute/iu);
});

test("adapter marked position minus cost basis still credits genuine venue yield", () => {
  const result = buildYieldAttribution({ snapshot, events });
  assert.equal(result.gain.venueEarned.raw, "400");
  assert.equal(result.gain.cumulativeNav.raw, "550000");
  assert.equal(result.gain.unattributed.raw, "549600");
  const donated = buildYieldAttribution({ snapshot: { ...snapshot, bufferAssets: snapshot.bufferAssets + 600000n }, events });
  assert.equal(donated.gain.venueEarned.raw, "400", "moving buffer alone cannot manufacture venue performance");
  assert.equal(donated.gain.unattributed.raw, "1149600");
  const liveBook = buildYieldAttribution({ snapshot: { ...snapshot, venueMarkedAssets: snapshot.deployedPrincipal, bufferAssets: 10582050n }, events });
  assert.equal(liveBook.gain.venueEarned.raw, "0", "the live adapter has not marked the separately observed AAVE accrual");
  assert.equal(liveBook.gain.unattributed.raw, "550000");
});

test("wallet approximation preserves unattributed gain and signed pool residual closes exactly", () => {
  const idle = { ...snapshot, deployedPrincipal: 0n, venueMarkedAssets: null, bufferAssets: 20512187n, wallet: { shares: 19962187n } };
  const wallet = buildYieldAttribution({ snapshot: idle, events, wallet: events[0].owner });
  assert.equal(wallet.wallet.splitApproximation.venueEarned.raw, "0");
  assert.equal(wallet.wallet.splitApproximation.unattributed.raw, "550000");
  const attested = buildYieldAttribution({ snapshot, events, ledgerEntries: [{ txHash: `0x${"ab".repeat(32)}`, amountRaw: "600000", blockNumber: 2, chainId: 420420419, timestamp: "2026-09-08T19:12:24.000Z" }] });
  assert.equal(attested.gain.unattributed.raw, "-50400");
  assert.equal(BigInt(attested.gain.venueEarned.raw) + BigInt(attested.gain.operatorAdded.raw) + BigInt(attested.gain.unattributed.raw), BigInt(attested.gain.cumulativeNav.raw));
  assert.equal(BigInt(attested.splitRatio.venueEarnedBps) + BigInt(attested.splitRatio.operatorAddedBps) + BigInt(attested.splitRatio.unattributedBps), 10000n);
});

test("public pool venue earnings never exceed the adapter marked-minus-cost-basis figure", async () => {
  const yieldAttributionService = new YieldAttributionService({
    poolAddress: POOL, assetAddress: ASSET, chainId: 420420419,
    stateStore: new MemoryStateStore(), chainReader: { async readHistory() { return events; } }
  });
  const door = new DepositPoolDoorService({
    poolAddress: POOL, chainId: 420420419, yieldAttributionService,
    chainReader: { async readSnapshot() { return snapshot; } }
  });
  let body;
  const route = createDepositPoolRoutes({
    depositPoolDoor: door,
    authMiddleware() { assert.fail("public pool needs no auth"); },
    respond(_response, status, payload) { assert.equal(status, 200); body = payload; }
  });
  await route({ request: { method: "GET", headers: {} }, response: {}, pathname: "/pool", url: new URL("https://example.test/pool") });
  assert.equal(body.available, true);
  assert.equal(body.yieldAttribution.gain.venueEarned.raw, "400");
  assert.ok(BigInt(body.yieldAttribution.gain.venueEarned.raw) <= snapshot.venueMarkedAssets - snapshot.deployedPrincipal);
  assert.equal(body.yieldAttribution.gain.cumulativeNav.raw, "550000");
});

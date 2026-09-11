import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import { DEPOSIT_POOL_ABI } from "../blockchain/abis.js";
import { createDepositPoolRoutes } from "../protocols/http/deposit-pool-routes.js";
import { DepositPoolDoorService } from "./deposit-pool-door.js";
import { EvmDepositPoolVenueHistoryReader } from "./deposit-pool-venue-history.js";
import { EvmYieldAttributionChainReader, YieldAttributionService } from "./yield-attribution-service.js";

const POOL = "0x1111111111111111111111111111111111111111";
const WALLET = "0x2222222222222222222222222222222222222222";
const ASSET = "0x0000053900000000000000000000000001200000";
const HASH = `0x${"ab".repeat(32)}`;
const abi = new Interface(DEPOSIT_POOL_ABI);

function fixture({ loggedLosses = [[51_765n]], ledgerLosses = [51_765n], omitDeployments = [],
  returnedAssets = 9_928_372n, principalReduction = 9_928_372n } = {}) {
  const log = (name, args, blockNumber, index = 0) => ({
    ...abi.encodeEventLog(abi.getEvent(name), args), address: POOL, blockNumber, index, transactionHash: HASH
  });
  const logs = [log("Deposit", [WALLET, WALLET, 20_000_000n, 20_000_000n], 1)];
  loggedLosses.forEach((losses, index) => {
    const id = BigInt(index + 1);
    if (omitDeployments.includes(Number(id))) return;
    logs.push(log("VenueDeploymentCreated", [id, HASH, 9_980_137n, 1_800_000_000], 10, index));
    logs.push(log("VenuePrincipalReturned", [id, returnedAssets, principalReduction], 20, index));
    losses.forEach((loss, ordinal) => logs.push(log("VenueLossWrittenOff", [id, loss, 0n], 25 + ordinal, index)));
  });
  const state = { ledgerLosses, attested: true, fail: null, calls: [], queries: [] };
  const provider = {
    async call(tx) {
      assert.equal(tx.to.toLowerCase(), POOL);
      const fn = abi.parseTransaction(tx);
      assert.ok(Number.isSafeInteger(Number(tx.blockTag)), "never read the getter at latest");
      const id = fn.args.length ? fn.args[0] : undefined;
      state.calls.push({ name: fn.name, id: id?.toString(), block: Number(tx.blockTag) });
      if (state.fail === fn.name) throw new Error("RPC offline");
      const values = {
        nextVenueDeploymentId: [BigInt(state.ledgerLosses.length + 1)],
        activeVenueDeploymentId: [0n],
        venueDeployments: [9_980_137n, 9_928_372n, 1_800_000_000, HASH, 2],
        venueWrittenOffPrincipalAssets: [Number(tx.blockTag) < 25 ? 0n : state.ledgerLosses[Number(id) - 1]]
      };
      assert.ok(values[fn.name], fn.name);
      return abi.encodeFunctionResult(fn.name, values[fn.name]);
    },
    async getLogs(query) {
      assert.equal(query.address, POOL);
      state.queries.push(query);
      return logs.filter((row) => row.blockNumber >= query.fromBlock && row.blockNumber <= query.toBlock);
    },
    async getBlock() { return { hash: HASH, timestamp: 1_800_000_000 }; }
  };
  const reader = new EvmYieldAttributionChainReader(provider, { deploymentBlock: 1 });
  const service = new YieldAttributionService({
    poolAddress: POOL, assetAddress: ASSET, chainId: 420420419, chainReader: reader,
    stateStore: { async listYieldSubsidyEntries() { return state.attested ? [{
      txHash: HASH, amountRaw: "600000", blockNumber: 30, chainId: 420420419, timestamp: "2026-09-09T00:00:00.000Z"
    }] : []; } }
  });
  const snapshot = {
    blockNumber: 40, asset: ASSET, totalSupply: 20_000_000n, totalAssets: 20_548_235n,
    bufferAssets: 20_548_235n, deployedPrincipal: 0n, venueMarkedAssets: null,
    totalAssetCap: 1_000_000_000n, perAgentAssetCap: 100_000_000n
  };
  const door = new DepositPoolDoorService({
    poolAddress: POOL, chainId: 420420419, yieldAttributionService: service,
    venueHistoryReader: new EvmDepositPoolVenueHistoryReader(provider, { eventReader: reader }),
    chainReader: { async readSnapshot() { return snapshot; } }
  });
  return { reader, service, snapshot, state, door };
}

function assertUnavailable(result, reason = "venue_writeoff_journal_mismatch") {
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "realised_venue_unavailable");
  assert.equal(result.realisedVenueResult.status, "unavailable");
  assert.equal(result.realisedVenueResult.reason, reason);
  assert.equal(result.gain, undefined, "do not publish a zero venue result or guessed residual");
  assert.equal(result.wallet, undefined, "do not manufacture a wallet ratio from incomplete realised evidence");
}

test("write-off production pin — getter 51765 and journal zero yield venue-earned -51765", async () => {
  const f = fixture({ loggedLosses: [[]] });
  let body;
  const route = createDepositPoolRoutes({
    depositPoolDoor: f.door,
    authMiddleware() { assert.fail("public pool needs no auth"); },
    respond(_response, status, payload) { assert.equal(status, 200); body = payload; }
  });
  await route({ request: { method: "GET", headers: {} }, response: {}, pathname: "/pool", url: new URL("https://example.test/pool") });
  assert.equal(body.available, true);
  assert.equal(body.withdrawal.status, "open");
  assert.equal(body.yieldAttribution.status, "attributed");
  assert.equal(body.yieldAttribution.gain.venueEarned.raw, "-51765");
  assert.equal(body.yieldAttribution.gain.operatorAdded.raw, "600000");
  assert.equal(body.yieldAttribution.gain.unattributed.raw, "0");
  assert.equal(body.yieldAttribution.basis.netShareBackedCapital.raw, "20000000");
  assert.match(body.yieldAttributionText, /cost of 0\.051765 USDC/u);
  assert.equal(body.venueHistory.lastDeployment.writtenOff.raw, "51765", "history still shows its independently reconciled getter");
  assert.equal(body.venueHistory.lastDeployment.lastWriteOff, null, "do not invent an event date");
  assert.equal(f.state.queries.length, 1, "history and attribution still share one journal scan");
  const rawHistory = await f.reader.readHistory({ poolAddress: POOL, toBlock: 40 });
  assert.equal(rawHistory.filter((row) => row.type === "VenueLossWrittenOff").length, 0, "getter evidence is not a fabricated log");
  const wallet = await f.service.getAttribution({ snapshot: { ...f.snapshot, wallet: { shares: 20_000_000n } }, wallet: WALLET });
  assert.deepEqual(wallet.wallet.splitApproximation.poolRatio, wallet.splitRatio);
  assert.equal(wallet.wallet.splitApproximation.venueEarned.raw, "-51765");
  f.state.attested = false;
  const beforeAttestation = await f.service.getAttribution({ snapshot: f.snapshot });
  assert.equal(beforeAttestation.gain.venueEarned.raw, "-51765");
  assert.equal(beforeAttestation.gain.operatorAdded.raw, "0");
  assert.equal(beforeAttestation.gain.unattributed.raw, "600000");
});

test("matching split write-off logs retain cycle-1 attribution and the wallet ratio", async () => {
  const f = fixture({ loggedLosses: [[30_000n, 21_765n]] });
  const result = await f.service.getAttribution({ snapshot: { ...f.snapshot, wallet: { shares: 20_000_000n } }, wallet: WALLET });
  assert.equal(result.status, "attributed");
  assert.equal(result.gain.venueEarned.raw, "-51765");
  assert.equal(result.gain.operatorAdded.raw, "600000");
  assert.equal(result.gain.unattributed.raw, "0");
  assert.equal(result.basis.netShareBackedCapital.raw, "20000000");
  assert.deepEqual(result.wallet.splitApproximation.poolRatio, result.splitRatio);
  assert.equal(result.wallet.splitApproximation.venueEarned.raw, "-51765");
});

test("partial journal uses the getter once, without double-counting the logged subset", async () => {
  const f = fixture({ loggedLosses: [[30_000n]] });
  const result = await f.service.getAttribution({ snapshot: f.snapshot });
  assert.equal(result.status, "attributed");
  assert.equal(result.gain.venueEarned.raw, "-51765");
  assert.equal(result.gain.unattributed.raw, "0");
});

test("write-off excess pin — journal 60000 versus getter 51765 remains unavailable", async () => {
  for (const [logged, getter] of [[60_000n, 51_765n], [51_765n, 0n]]) {
    const f = fixture({ loggedLosses: [[logged]], ledgerLosses: [getter] });
    const result = await f.service.getAttribution({ snapshot: f.snapshot });
    assertUnavailable(result);
    assert.equal(result.realisedVenueResult.journalWrittenOffRaw, String(logged));
    assert.equal(result.realisedVenueResult.contractWrittenOffRaw, String(getter));
  }
});

test("returned-surplus pin — profit still comes from EVM return logs with zero getter loss", async () => {
  const f = fixture({ loggedLosses: [[]], ledgerLosses: [0n], returnedAssets: 10_230_137n, principalReduction: 9_980_137n });
  f.state.attested = false;
  const result = await f.service.getAttribution({ snapshot: { ...f.snapshot, bufferAssets: 20_250_000n, totalAssets: 20_250_000n } });
  assert.equal(result.status, "attributed");
  assert.equal(result.gain.venueEarned.raw, "250000");
  assert.equal(result.gain.unattributed.raw, "0");
});

test("reconciliation reads every deployment including one wholly absent from the journal", async () => {
  const f = fixture({ loggedLosses: [[51_765n], []], ledgerLosses: [51_765n, 9n], omitDeployments: [2] });
  const result = await f.service.getAttribution({ snapshot: { ...f.snapshot, bufferAssets: 20_548_226n, totalAssets: 20_548_226n } });
  assert.equal(result.status, "attributed");
  assert.equal(result.gain.venueEarned.raw, "-51774");
  assert.equal(result.gain.unattributed.raw, "0");
  assert.deepEqual(f.state.calls.filter((call) => call.name === "venueWrittenOffPrincipalAssets").map((call) => call.id), ["1", "2"]);
});

test("equal aggregate write-offs cannot hide journal-over-getter on an individual deployment", async () => {
  const f = fixture({ loggedLosses: [[30_000n], [21_765n]], ledgerLosses: [21_765n, 30_000n] });
  const result = await f.service.getAttribution({ snapshot: f.snapshot });
  assertUnavailable(result);
  assert.equal(result.realisedVenueResult.deploymentId, "1");
});

test("cached journal is reconciled again at the requested block, including an older snapshot", async () => {
  const f = fixture();
  assert.equal((await f.service.getAttribution({ snapshot: f.snapshot })).status, "attributed");
  const old = await f.reader.readAttributionEvidence({ poolAddress: POOL, toBlock: 20 });
  assert.ok(old.events.every((row) => row.blockNumber <= 20));
  assert.equal(old.events.some((row) => row.type === "VenueLossWrittenOff"), false);
  assert.equal(old.venueWrittenOffRaw, "0", "an older snapshot cannot inherit the later getter balance");
  f.state.ledgerLosses[0] = 60_000n;
  const updated = await f.service.getAttribution({ snapshot: f.snapshot });
  assert.equal(updated.gain.venueEarned.raw, "-60000", "getter is re-read even while the log journal stays cached");
  assert.equal(f.state.queries.length, 1);
  assert.deepEqual(f.state.calls.filter((call) => call.name === "venueWrittenOffPrincipalAssets").map((call) => call.block), [40, 20, 40]);
});

test("unreadable deployment count or write-off getter never falls back to journal-only zero", async () => {
  for (const method of ["nextVenueDeploymentId", "venueWrittenOffPrincipalAssets"]) {
    const f = fixture();
    f.state.fail = method;
    assertUnavailable(await f.service.getAttribution({ snapshot: f.snapshot }), "venue_writeoff_ledger_unreadable");
  }
});

test("empty contract ledger is valid but a log referring to a nonexistent deployment is unavailable", async () => {
  const empty = fixture({ loggedLosses: [], ledgerLosses: [] });
  const result = await empty.service.getAttribution({ snapshot: empty.snapshot });
  assert.equal(result.gain.venueEarned.raw, "0");
  assert.equal(empty.state.calls.length, 1, "only the deployment count is read for a proven empty ledger");
  const inconsistent = fixture({ ledgerLosses: [] });
  assertUnavailable(await inconsistent.service.getAttribution({ snapshot: inconsistent.snapshot }), "venue_writeoff_ledger_unreadable");
});

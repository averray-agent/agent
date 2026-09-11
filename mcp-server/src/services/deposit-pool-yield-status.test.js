import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Interface } from "ethers";
import { DEPOSIT_POOL_ABI } from "../blockchain/abis.js";
import { DepositPoolDoorService } from "./deposit-pool-door.js";
import { DepositPoolObservabilityService } from "./deposit-pool-observability.js";
import { EvmDepositPoolVenueHistoryReader, EMPTY_VENUE_HISTORY } from "./deposit-pool-venue-history.js";
import { depositPoolYieldStatus, depositPoolYieldAttributionText } from "./deposit-pool-yield-status.js";

const POOL = "0x1111111111111111111111111111111111111111";
const ASSET = "0x2222222222222222222222222222222222222222";
const abi = new Interface(DEPOSIT_POOL_ABI);
const amount = (raw) => ({ raw: String(raw), decimals: 6 });
const gain = (unattributed = 0, operatorAdded = 0, venueEarned = 0) => ({
  gain: { unattributed: amount(unattributed), operatorAdded: amount(operatorAdded), venueEarned: amount(venueEarned) }
});

function fixture({ id = 1n, out = 9_980_137n, back = 9_928_372n, loss = out - back,
  active = 0n, omitReturn = false, omitWriteOff = false, unreadable = false, next = id + 1n } = {}) {
  const calls = [];
  const hash = `0x${"ab".repeat(32)}`;
  const log = (name, args, blockNumber) => ({
    ...abi.encodeEventLog(abi.getEvent(name), args), address: POOL,
    blockNumber, index: 0, transactionHash: hash
  });
  const logs = [
    log("VenueDeploymentCreated", [id, hash, out, 1_800_000_000], 10),
    ...(!omitReturn ? [log("VenuePrincipalReturned", [id, back, back > out ? out : back], 20)] : []),
    ...(loss > 0n && !omitWriteOff ? [log("VenueLossWrittenOff", [id, loss, 0n], 30)] : [])
  ];
  const provider = {
    async call(tx) {
      calls.push(tx);
      assert.equal(tx.to.toLowerCase(), POOL);
      assert.equal(Number(tx.blockTag), 40, "every ledger read is pinned to the door snapshot");
      if (unreadable) throw new Error("RPC failed");
      const fn = abi.parseTransaction(tx);
      if (fn.name === "venueDeployments" || fn.name === "venueWrittenOffPrincipalAssets") {
        assert.equal(fn.args[0], id, "read the newest ID from the contract, not deployment #1 literally");
      }
      const values = {
        nextVenueDeploymentId: [next], activeVenueDeploymentId: [active],
        venueDeployments: [out, back > out ? out : back, 1_800_000_000, hash, 2],
        venueWrittenOffPrincipalAssets: [loss]
      };
      return abi.encodeFunctionResult(fn.name, values[fn.name]);
    },
    async getLogs(query) {
      assert.equal(query.address, POOL);
      assert.equal(query.fromBlock, 10);
      assert.equal(query.toBlock, 40);
      return logs;
    },
    async getBlock(block) {
      const dates = { 10: "2026-09-05", 20: "2026-09-08", 30: "2026-09-09" };
      return { hash, timestamp: Date.parse(dates[block]) / 1000 };
    }
  };
  const venueHistoryReader = new EvmDepositPoolVenueHistoryReader(provider, { deploymentBlock: 10 });
  const snapshot = {
    blockNumber: 40, asset: ASSET, totalAssets: 20_000_000n, totalSupply: 20_000_000n,
    bufferAssets: 20_000_000n, deployedPrincipal: 0n,
    totalAssetCap: 1_000_000_000n, perAgentAssetCap: 100_000_000n
  };
  const door = new DepositPoolDoorService({
    poolAddress: POOL, chainId: 420420419, venueHistoryReader,
    chainReader: { async readSnapshot() { return snapshot; } },
    yieldAttributionService: { async getAttribution() { return gain(548235); } }
  });
  return { venueHistoryReader, door, snapshot, calls };
}

test("pool history pin 1 — home copy names the chain deployment, cycle count, dates, amounts and measured difference", async () => {
  const f = fixture();
  const info = await f.door.getInfo();
  assert.equal(info.yieldStatus, "home_after_cycle");
  for (const fact of ["1 venue cycle(s) completed", "deployment #1", "9.980137 USDC", "9.928372 USDC",
    "0.051765 USDC difference", "2026-09-05", "2026-09-08", "0.051765 USDC was written off"]) {
    assert.ok(info.yieldStatusText.includes(fact), fact);
  }
  assert.equal(info.venueHistory.lastDeployment.lastWriteOff.timestampIso, "2026-09-09T00:00:00.000Z");
  assert.match(info.yieldAttributionText, /0\.548235 USDC.*not yield/u);
  const changed = await fixture({ id: 7n, out: 4_500_000n, back: 4_400_000n }).door.getInfo();
  for (const fact of ["7 venue cycle(s)", "deployment #7", "4.5 USDC", "4.4 USDC", "0.1 USDC difference"]) {
    assert.ok(changed.yieldStatusText.includes(fact), fact);
  }
  const observability = new DepositPoolObservabilityService({
    poolAddress: POOL, venueHistoryReader: f.venueHistoryReader,
    chainReader: {
      async getBlockNumber() { return 40; },
      async getBlock() { return { number: 40, timestamp: 1_800_000_000 }; },
      async readState() { return { ...f.snapshot, totalShares: f.snapshot.totalSupply, buffer: f.snapshot.bufferAssets, deployed: 0n }; },
      async readEvents() { return []; }
    }
  });
  assert.equal((await observability.getSnapshot()).yieldStatusText, info.yieldStatusText);
});

test("pool history pin 2 — public text has no stale measurement promises or insider vocabulary", async () => {
  const forbidden = /not scheduled|being re-measured|trust-and-capacity|reward entitlement|Flex is a membership/iu;
  for (const file of ["deposit-pool-yield-status.js", "../core/deposit-pool-disclosure.js"]) {
    assert.doesNotMatch(await readFile(new URL(file, import.meta.url), "utf8"), forbidden);
  }
  assert.doesNotMatch(JSON.stringify(await fixture().door.getInfo()), forbidden);
});

test("pool history pin 3 — unattributed gain is not yield, operator additions are named, and negative venue result is a cost", () => {
  assert.match(depositPoolYieldAttributionText(gain(548235)), /0\.548235 USDC.*not yet attributed; an unattributed gain is not yield/u);
  assert.match(depositPoolYieldAttributionText(gain(0, 600000)), /0\.6 USDC.*added by the operator, attested against chain evidence/u);
  assert.match(depositPoolYieldAttributionText(gain(0, 0, -51765)), /cost of 0\.051765 USDC/u);
  const combined = depositPoolYieldAttributionText(gain(100000, 600000, -51765));
  for (const phrase of ["not yield", "added by the operator", "cost of 0.051765"]) assert.ok(combined.includes(phrase));
  assert.match(depositPoolYieldAttributionText(gain(0, 0, 125000)), /venue result is 0\.125 USDC/u);
  assert.match(depositPoolYieldAttributionText(gain(-12)), /0\.000012 USDC of loss/u);
  assert.match(depositPoolYieldAttributionText(), /unavailable/u);
});

test("missing, inconsistent, or unclosed history never becomes never-deployed history", async () => {
  for (const options of [{ unreadable: true }, { omitReturn: true }, { active: 1n }]) {
    const info = await fixture(options).door.getInfo();
    assert.equal(info.available, true);
    assert.equal(info.yieldStatus, "history_unavailable");
    assert.doesNotMatch(info.yieldStatusText, /No venue deployment is recorded/u);
    assert.equal(info.withdrawal.status, "open");
  }
  assert.equal(depositPoolYieldStatus(0n).yieldStatus, "history_unavailable");
  assert.equal(depositPoolYieldStatus(0n, EMPTY_VENUE_HISTORY).yieldStatus, "not_yet_earning");
  assert.equal(depositPoolYieldStatus(1n).yieldStatus, "earning");
  assert.equal((await fixture({ next: 1n }).door.getInfo()).yieldStatus, "not_yet_earning");
});

test("returned surplus is a positive recorded result, not a negative cost or principal-only return", async () => {
  const info = await fixture({ out: 1_000_000n, back: 1_025_000n, loss: 0n }).door.getInfo();
  assert.match(info.yieldStatusText, /received 1\.025 USDC/u);
  assert.match(info.yieldStatusText, /0\.025 USDC excess returned/u);
  assert.doesNotMatch(info.yieldStatusText, /round-trip cost/u);
});

test("write-off amount comes from the contract getter even when the RPC has no write-off log", async () => {
  const info = await fixture({ omitWriteOff: true }).door.getInfo();
  assert.equal(info.yieldStatus, "home_after_cycle");
  assert.equal(info.venueHistory.lastDeployment.writtenOff.raw, "51765");
  assert.equal(info.venueHistory.lastDeployment.lastWriteOff, null);
  assert.match(info.yieldStatusText, /0\.051765 USDC was written off/u);
});

test("deposit benefit figures follow the served runtime policy and never promise eligibility", async () => {
  const f = fixture();
  f.door.vestingHours = 72;
  f.door.claimPriority = { enabled: true, windowSeconds: 900, minRewardRaw: 2_000_000n, thresholdRaw: 3_000_000n };
  const { benefitsText } = (await f.door.getInfo()).capitalSignal;
  for (const phrase of ["72 hours", "2 USDC", "15 minutes", "3 USDC vested", "listed in the directory", "never buys a reward", "all other eligibility checks"]) {
    assert.ok(benefitsText.includes(phrase), phrase);
  }
  f.door.claimPriority.enabled = false;
  assert.match((await f.door.getInfo()).capitalSignal.benefitsText, /early claim access is not enabled/u);
});

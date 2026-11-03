import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { Interface, zeroPadValue } from "ethers";
import { ESCROW_CORE_ABI } from "../blockchain/abis.js";
import { ReserveBreakdownService, ReserveChainReader, RESERVE_ESCROW_V3, RESERVE_V3_START_BLOCK, reserveSweepAction } from "./reserve-breakdown.js";
const SIGNER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const USDC = "0x3333333333333333333333333333333333333333";
const NOW = 2000000;
const job = (state, overrides = {}) => ({ jobId: state, state, poster: SIGNER, asset: USDC, escrowAddress: RESERVE_ESCROW_V3, reservedRaw: "1000000", createdAt: 100, rejectedAt: 100, claimExpiry: 100, ...overrides });
function harness(jobs, options = {}) {
  const snapshot = { signer: SIGNER, asset: USDC, timestamp: NOW, blockNumber: 42, disputeWindow: 1000, minOpenForCancel: 50, chainReservedRaw: "7000000", jobs, ...options.snapshot };
  return new ReserveBreakdownService({ reader: { read: async () => snapshot }, stateStore: { listRecentSessions: async () => options.sessions ?? [] }, catalog: { listJobs: () => options.listings ?? [] }, toJobId: (id) => id });
}

test("per-state sums, oldest age and sweepable jobs reconcile, retaining unexplained reserve", async () => {
  const result = await harness([job("Open"), job("Claimed"), job("Submitted"), job("Rejected"), job("Disputed"), job("Closed"), job("Open", { jobId: "external", poster: OTHER }), job("Open", { jobId: "v2", escrowAddress: OTHER })]).getBreakdown();
  assert.equal(result.status, "ok");
  assert.equal(result.totalReservedRaw, "5000000");
  assert.equal(result.chainReservedRaw, "7000000");
  assert.equal(result.unexplainedReserved, "2000000");
  assert.equal(Object.values(result.states).reduce((sum, s) => sum + BigInt(s.reservedRaw), 0n), BigInt(result.totalReservedRaw));
  for (const state of ["Open", "Claimed", "Submitted", "Rejected", "Disputed"]) {
    assert.equal(result.states[state].jobCount, 1);
    assert.equal(result.states[state].oldestAgeSeconds, NOW - 100);
    assert.equal(result.states[state].sweepableNow, ["Submitted", "Disputed"].includes(state) ? 0 : 1);
  }
  assert.equal(result.sweepableReservedRaw, "3000000");
  assert.equal(JSON.stringify(result).includes("external"), false);
  assert.equal(JSON.stringify(result).includes("v2"), false);
});

test("over-accounted reserves remain a negative discrepancy, never clamped", async () => {
  const result = await harness([job("Open")], { snapshot: { chainReservedRaw: "500000" } }).getBreakdown();
  assert.equal(result.unexplainedReserved, "-500000");
});

test("active sessions and live catalogue lifecycle determine sweepability", async () => {
  const recent = NOW - 100;
  const result = await harness([
    job("Open", { jobId: "active" }), job("Open", { jobId: "stale", createdAt: recent }),
    job("Open", { jobId: "closed", createdAt: recent }), job("Open", { jobId: "young", createdAt: recent })
  ], { sessions: [{ chainJobId: "active", status: "claimed" }], listings: [{ id: "stale", lifecycle: { state: "stale" } }, { id: "closed", lifecycle: { state: "closed" } }] }).getBreakdown();
  assert.equal(result.states.Open.sweepableNow, 2);
  assert.deepEqual(result.states.Open.jobs.map(j => j.sweepAction), [null, "cancel_open", "cancel_open", null]);
});

test("timing rules use contract constants and strict dispute/claim boundaries", () => {
  const context = { timestamp: 1000, disputeWindow: 79, minOpenForCancel: 50, openMaxAgeDays: 14 };
  assert.equal(reserveSweepAction(job("Rejected", { rejectedAt: 922 }), context), null);
  assert.equal(reserveSweepAction(job("Rejected", { rejectedAt: 920 }), context), "finalize_rejected");
  assert.equal(reserveSweepAction(job("Claimed", { claimExpiry: 1000 }), context), null);
  assert.equal(reserveSweepAction(job("Claimed", { claimExpiry: 999 }), context), "timeout_claim");
  assert.equal(reserveSweepAction(job("Open", { createdAt: 951, catalogueState: "stale" }), context), null);
  assert.equal(reserveSweepAction(job("Open", { createdAt: 950, catalogueState: "stale" }), context), "cancel_open");
});

test("failed chain, session or catalogue reads report null rather than zero", async () => {
  for (const fail of [s => { s.reader.read = async () => { throw Error("RPC down"); }; }, s => { s.stateStore.listRecentSessions = async () => { throw Error("Redis down"); }; }, s => { s.catalog.listJobs = () => { throw Error("catalog down"); }; }]) {
    const service = harness([job("Open")]); fail(service);
    const body = await service.getBreakdown();
    assert.equal(body.status, "unavailable");
    for (const key of ["states", "totalReservedRaw", "chainReservedRaw", "unexplainedReserved", "sweepableReservedRaw"]) assert.equal(body[key], null);
  }
});

function chainHarness() {
  const iface = new Interface(ESCROW_CORE_ABI);
  const jobId = `0x${"ab".repeat(32)}`;
  const encoded = iface.encodeEventLog(iface.getEvent("JobCreated"), [jobId, SIGNER, `0x${"00".repeat(32)}`, USDC, 123n, 0]);
  const calls = [];
  const g = {
    config: { enabled: true, escrowCoreAddress: RESERVE_ESCROW_V3, supportedAssets: [{ symbol: "USDC", address: USDC, decimals: 6 }] },
    signer: { getAddress: async () => SIGNER, sendTransaction: () => { throw Error("must never send"); } },
    provider: { getNetwork: async () => ({ chainId: 420420419n }), getBlock: async tag => { assert.equal(tag, "finalized"); return { number: RESERVE_V3_START_BLOCK + 10001, timestamp: NOW }; }, getLogs: async filter => { calls.push(["logs", filter]); return [{ ...encoded, address: RESERVE_ESCROW_V3 }]; } },
    accountContract: { positions: async (...args) => { calls.push(["positions", ...args]); return { reserved: 321n }; } },
    escrowContract: {
      interface: iface,
      DISPUTE_WINDOW: async (...args) => { calls.push(["dispute", ...args]); return 79n; },
      MIN_OPEN_FOR_CANCEL: async (...args) => { calls.push(["minOpen", ...args]); return 53n; },
      createdAt: async (...args) => { calls.push(["createdAt", ...args]); return 99n; },
      jobs: async (...args) => { calls.push(["jobs", ...args]); return { state: 1, poster: SIGNER, asset: USDC, reward: 100n, protocolFee: 20n, opsReserve: 2n, contingencyReserve: 1n, rejectedAt: 0n, claimExpiry: 0n }; }
    }
  };
  return { reader: new ReserveChainReader(g), g, calls };
}

test("real reader scopes v3 signer logs, pins every read, sums all four amounts and never sends", async () => {
  const { reader, calls } = chainHarness();
  const result = await reader.read();
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].reservedRaw, "123");
  assert.equal(result.chainReservedRaw, "321");
  assert.equal(result.disputeWindow, 79);
  assert.equal(result.minOpenForCancel, 53);
  const logs = calls.filter(c => c[0] === "logs");
  assert.equal(logs.length, 2);
  assert.equal(logs[0][1].fromBlock, RESERVE_V3_START_BLOCK);
  for (const [, filter] of logs) { assert.equal(filter.address, RESERVE_ESCROW_V3); assert.equal(filter.topics[2], zeroPadValue(SIGNER, 32)); }
  for (const call of calls.filter(c => c[0] !== "logs")) assert.deepEqual(call.at(-1), { blockTag: result.blockNumber });
  calls.length = 0;
  await reader.read();
  assert.equal(calls.filter(c => c[0] === "logs").length, 0);
  assert.equal(calls.filter(c => c[0] === "jobs").length, 1); // state/balance never cached
});

test("wrong chain, v2 address, missing quantity and incomplete log scan fail closed", async () => {
  for (const corrupt of [g => { g.provider.getNetwork = async () => ({ chainId: 1n }); }, g => { g.config.escrowCoreAddress = OTHER; }, g => { g.accountContract.positions = async () => ({}); }, g => { g.provider.getLogs = async () => { throw Error("scan down"); }; }]) {
    const { reader, g } = chainHarness(); corrupt(g); await assert.rejects(() => reader.read());
  }
});


test("v3 address and complete history start are pinned to the deployment manifest", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../../deployments/mainnet.json", import.meta.url), "utf8"));
  assert.equal(RESERVE_ESCROW_V3, manifest.contracts.escrowCore.toLowerCase());
  assert.equal(RESERVE_V3_START_BLOCK, manifest.deploymentBlocks.escrowCoreV3);
  assert.notEqual(RESERVE_ESCROW_V3, manifest.contracts.legacyEscrowCore.toLowerCase());
});

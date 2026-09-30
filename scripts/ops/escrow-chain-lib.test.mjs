import assert from "node:assert/strict";
import { id } from "ethers";
import test from "node:test";
import { JOBS_SELECTOR, SLA_SELECTOR, DISPUTE_OPENED_TOPIC, EXPECTED_SLA_SECONDS,
  MAINNET_CHAIN_ID, decodeJob, readDisputeLogs, readArbitrationChain } from "./escrow-chain-lib.mjs";
import { runReminders, stateKey } from "./arbitration-deadlines.mjs";

const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const jobId = `0x${"11".repeat(32)}`;
const escrow = `0x${"22".repeat(20)}`;
const legacy = `0x${"33".repeat(20)}`;
const manifest = { rpcUrl: "https://primary.example.test", rpcBackupUrls: ["https://backup.example.test"],
  contracts: { escrowCore: escrow, legacyEscrowCore: legacy }, deploymentBlocks: { escrowCoreV3: 100, escrowCoreV2: 50 } };
const encoded = (state = 5, disputedAt = 1000) => `0x${Array.from({ length: 25 }, (_, index) => word(index === 18 ? disputedAt : index === 20 ? state : 0)).join("")}`;
const event = { address: escrow, topics: [DISPUTE_OPENED_TOPIC, jobId] };

test("arbitration chain selectors and event topic match their interfaces", () => {
  assert.equal(JOBS_SELECTOR, id("jobs(bytes32)").slice(0, 10));
  assert.equal(SLA_SELECTOR, id("ARBITRATOR_SLA()").slice(0, 10));
  assert.equal(DISPUTE_OPENED_TOPIC, id("DisputeOpened(bytes32,address,uint256)"));
});
test("arbitration chain decodes the dispute timestamp and state words", () => {
  assert.deepEqual(decodeJob(encoded(6, 12345)), { disputedAt: 12345, state: 6 });
  assert.throws(() => decodeJob("0x"));
});
test("arbitration log reads cover adjacent bounded ranges and reduce a rejected range", async () => {
  const accepted = [];
  let first = true;
  const logs = await readDisputeLogs({ url: manifest.rpcUrl, escrow, fromBlock: 100, toBlock: 100100,
    read: async (_url, method, [filter]) => {
      assert.equal(method, "eth_getLogs");
      assert.deepEqual(filter.topics, [DISPUTE_OPENED_TOPIC]);
      const from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock));
      if (first) { first = false; assert.equal(to - from + 1, 50000); throw new Error("block range limit"); }
      assert.ok(to - from + 1 <= 25000);
      accepted.push([from, to]);
      return [event];
    } });
  assert.equal(accepted[0][0], 100);
  assert.equal(accepted.at(-1)[1], 100100);
  for (let index = 1; index < accepted.length; index++) assert.equal(accepted[index][0], accepted[index - 1][1] + 1);
  assert.equal(logs.length, accepted.length);
});

function fixture({ missingPrimary = false, failAll = false, state = 5, sla = 1209600 } = {}) {
  const calls = [];
  return { calls, read: async (url, method, params) => {
    calls.push({ url, method, params });
    if (failAll) throw new Error("read unavailable");
    if (method === "eth_chainId") return `0x${MAINNET_CHAIN_ID.toString(16)}`;
    if (method === "eth_blockNumber") return "0xc8";
    if (method === "eth_getLogs") return params[0].address === escrow && !(missingPrimary && url === manifest.rpcUrl) ? [event] : [];
    if (method === "eth_call" && params[0].data === SLA_SELECTOR) return `0x${word(sla)}`;
    if (method === "eth_call" && params[0].data.startsWith(JOBS_SELECTOR)) return encoded(state);
    throw new Error("unexpected read");
  } };
}
test("arbitration chain combines provider logs and reports their parity", async () => {
  const f = fixture({ missingPrimary: true });
  const result = await readArbitrationChain(manifest, f);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].jobId, jobId);
  assert.equal(result.parityWarnings.length, 1);
  assert.equal(result.unknown, false);
  assert.equal(result.failureCount, 0);
  assert.equal(f.calls.filter(({ method, params }) => method === "eth_call" && params[0].data.startsWith(JOBS_SELECTOR)).length, 2);
});
test("arbitration chain retains unknown status when both providers are unavailable", async () => {
  const result = await readArbitrationChain(manifest, fixture({ failAll: true }));
  assert.equal(result.unknown, true);
  assert.ok(result.failureCount > 0);
});
test("arbitration chain confirms closed state and reads the SLA on both escrows", async () => {
  const f = fixture({ state: 6 });
  const result = await readArbitrationChain(manifest, f);
  assert.equal(result.jobs.length, 0);
  assert.equal(result.closed.length, 1);
  assert.equal(EXPECTED_SLA_SECONDS, 1209600);
  assert.equal(f.calls.filter(({ method, params }) => method === "eth_call" && params[0].data === SLA_SELECTOR).length, 4);
  const invalid = await readArbitrationChain(manifest, fixture({ sla: 604800 }));
  assert.equal(invalid.unknown, true);
  assert.ok(invalid.failureCount > 0);
});
test("arbitration chain reads both providers and gives a confirmed closed state precedence", async () => {
  const f = fixture();
  const base = f.read;
  f.read = (url, method, params) => url === manifest.rpcUrl && method === "eth_call" && params[0].data.startsWith(JOBS_SELECTOR)
    ? encoded(6) : base(url, method, params);
  const result = await readArbitrationChain(manifest, f);
  assert.equal(result.jobs.length, 0);
  assert.equal(result.closed.length, 1);
  assert.equal(result.unknown, false);
  assert.equal(result.parityWarnings[0].kind, "state_parity");
});

test("arbitration chain sends unknown status when a listed job cannot be read from either provider", async () => {
  const unavailableId = `0x${"44".repeat(32)}`;
  const f = fixture();
  const base = f.read;
  f.read = (url, method, params) => {
    if (method === "eth_getLogs" && params[0].address === escrow) {
      return [event, { ...event, topics: [DISPUTE_OPENED_TOPIC, unavailableId] }];
    }
    if (method === "eth_call" && params[0].data === JOBS_SELECTOR + unavailableId.slice(2)) {
      throw new Error("job read unavailable");
    }
    return base(url, method, params);
  };
  const chain = await readArbitrationChain(manifest, f);
  assert.equal(chain.unknown, true);
  assert.equal(chain.failureCount, 2);
  assert.equal(chain.jobs.length, 1);
  const pushes = [];
  await runReminders({ chain, now: Date.parse("2026-01-13T01:00:00Z") / 1000,
    deliver: async (push) => pushes.push(push) });
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].priority, 5);
  assert.match(pushes[0].body, /Deadline status unknown: chain read failed/);
});

test("arbitration chain removes non-disputed jobs with one successful provider read", async () => {
  for (const state of [0, 1, 2, 3, 4, 6, 7]) {
    const f = fixture({ state });
    const base = f.read;
    f.read = (url, method, params) => {
      if (url === manifest.rpcUrl && method === "eth_call" && params[0].data.startsWith(JOBS_SELECTOR)) {
        throw new Error("job read unavailable");
      }
      return base(url, method, params);
    };
    const chain = await readArbitrationChain(manifest, f);
    assert.equal(chain.jobs.length, 0);
    assert.equal(chain.closed.length, 1, `state ${state}`);
    assert.equal(chain.unknown, false, `state ${state}`);
    assert.equal(chain.failureCount, 1);
    const pushes = [];
    const result = await runReminders({ chain, now: Date.parse("2026-01-13T01:00:00Z") / 1000,
      state: { [stateKey({ escrow, jobId })]: { tier: "opened", sentAt: "2026-01-12T12:00:00Z" } },
      deliver: async (push) => pushes.push(push) });
    assert.equal(pushes.length, 0);
    assert.deepEqual(result.state, {});
  }
});

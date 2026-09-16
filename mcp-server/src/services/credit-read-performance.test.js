import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PlatformService } from "../core/platform-service.js";
import { CREDIT_POOL_RISK_DISCLOSURE } from "../core/credit-pool-disclosure.js";
import { addresses, checkpointData, countingProvider, creditReadFixture, HEAD,
  indexerFetch, NOW, UNDERWRITER_TOPICS } from "./fixtures/credit-read-fixture.js";

test("credit warm requests use real vesting caches and never scan underwriter topics", async () => {
  const fixture = creditReadFixture();
  const { provider } = fixture;
  const checkTopics = () => {
    for (const call of provider.calls.filter((c) => c.method === "getLogs")) {
      assert.equal(call.filter.topics?.flat().some((topic) => UNDERWRITER_TOPICS.includes(topic)) ?? false, false,
        "underwriter topic must never enter request-path filters");
      assert.ok([addresses.credit, addresses.deposit].includes(call.filter.address));
    }
  };
  const first = await fixture.request();
  assert.equal(first.body.receiptGraph.available, true);
  assert.equal(first.body.wallet.vestingAvailable, true);
  assert.ok(provider.calls.filter((c) => c.method === "getLogs").length > 2, "exercise cold real vesting history");
  checkTopics();
  provider.calls.length = 0;
  await fixture.request();
  checkTopics();
  assert.equal(provider.calls.filter((c) => c.method === "getLogs").length, 0);
  assert.deepEqual(provider.calls.filter((c) => c.method === "getBlock").map((c) => c.tag), ["latest"]);
  provider.head += 1;
  provider.calls.length = 0;
  await fixture.request();
  checkTopics();
  const logs = provider.calls.filter((c) => c.method === "getLogs");
  assert.equal(logs.length, 2, "only the two incremental vesting readers may read new logs");
  assert.ok(logs.every((c) => c.filter.fromBlock === provider.head && c.filter.toBlock === provider.head));
  assert.deepEqual(provider.calls.filter((c) => c.method === "getBlock").map((c) => c.tag), ["latest"]);
});

test("stale or missing indexed receipt evidence refuses with a named reason and zero chain calls", async () => {
  const cases = [
    ["indexer_stale", { fetchImpl: indexerFetch({ checkpoint: checkpointData(NOW - 601) }) }],
    ["indexer_stale", { fetchImpl: indexerFetch({ checkpoint: checkpointData(NOW - 11) }),
      env: { INDEXER_LAG_BUDGET_SECONDS: "10" } }],
    ["indexer_unconfigured", { env: { INDEXER_STATUS_URL: "" } }],
    ["indexer_evidence_unavailable", { fetchImpl: async () => Response.json({ errors: [{ message: "schema replay" }] }) }],
    ["indexer_coverage_missing", { fetchImpl: indexerFetch({ checkpoint: { ...checkpointData(), receiptGraphCoverages: null } }) }],
    ["indexer_source_mismatch", { fetchImpl: indexerFetch({ checkpoint: { ...checkpointData(),
      receiptGraphCoverages: { items: [], pageInfo: { hasNextPage: false } } } }) }]
  ];
  for (const [reason, options] of cases) {
    const fixture = creditReadFixture(options);
    const result = await fixture.creditBookDoor.getInfo(addresses.wallet);
    assert.equal(result.available, false, reason);
    assert.equal(result.reason, reason);
    assert.deepEqual(fixture.provider.calls, [], "receipt-graph refusal must not invoke a chain fallback");
  }
});

test("credit shares one block and starts both doors concurrently within three 50ms RPC phases", async (t) => {
  // A deterministic RPC clock measures dependency depth, not CPU contention
  // when the ops discovery guard nests the complete suite inside another run.
  let now = 0;
  let measuring = false;
  let pending = [];
  const provider = countingProvider({
    delayMs: 50, clock: () => now,
    sleep: (ms) => measuring
      ? new Promise((resolve) => pending.push({ due: now + ms, resolve }))
      : Promise.resolve()
  });
  const fixture = creditReadFixture({ provider });
  await fixture.request(); // warm only the real vesting caches; no snapshot cache
  provider.calls.length = 0;
  measuring = true;
  let complete = false;
  let result;
  let failure;
  void fixture.request().then((value) => { result = value; complete = true; },
    (error) => { failure = error; complete = true; });
  for (let tick = 0; tick < 10 && !complete; tick += 1) {
    await new Promise(setImmediate); // drain real async/ABI work before advancing RPC time
    if (pending.length) {
      now = Math.min(...pending.map((entry) => entry.due));
      const ready = pending.filter((entry) => entry.due === now);
      pending = pending.filter((entry) => entry.due !== now);
      ready.forEach((entry) => entry.resolve());
    }
  }
  assert.equal(complete, true, "bounded RPC schedule must complete");
  if (failure) throw failure;
  const elapsed = now;
  t.diagnostic(`fixed 50ms RPC clock: complete warm getInfo = ${elapsed}ms`);
  assert.equal(result.body.receiptGraph.available, true);
  assert.equal(result.body.wallet.vestingAvailable, true);
  assert.equal(result.body.block.number, result.body.receiptGraph.block.number);
  const blocks = provider.calls.filter((c) => c.method === "getBlock");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].tag, "latest");
  const bookStart = provider.calls.find((c) => c.to === addresses.book).at;
  const l1Start = provider.calls.find((c) => c.to === addresses.credit).at;
  const l1Dependent = provider.calls.find((c) => c.to === addresses.asset).at;
  assert.ok(bookStart < l1Dependent, "receipt graph must start before L1 completes");
  assert.ok(l1Start < bookStart + 50, "L1 must not await receipt graph completion");
  assert.ok(elapsed < 200, `three 50ms phases took ${elapsed.toFixed(1)}ms`);
  for (const phase of ["blockMs", "l1StateMs", "l1DependentMs", "capacityMs",
    "receiptGraphEvidenceMs", "receiptGraphStateMs", "receiptGraphLoansMs", "underwritingMs"]) {
    assert.equal(typeof result._creditReadTimings[phase], "number", phase);
  }
  const source = await readFile(new URL("../protocols/http/server.js", import.meta.url), "utf8");
  assert.match(source, /creditReadTimings: response\._creditReadTimings/);
});

test("listRecentSessionRecords throws when the store lacks listRecentSessions", async () => {
  const service = Object.create(PlatformService.prototype);
  service.stateStore = {};
  await assert.rejects(service.listRecentSessionRecords(250), /must implement listRecentSessions/);
  service.stateStore.listRecentSessions = async () => [];
  assert.deepEqual(await service.listRecentSessionRecords(250), []);
});

// --- Cold history after a backend recreate ----------------------------------
// The hosted smoke's CreditPool door timed out (3 x 20 s) on the 2026-09-16
// deploys. Every other phase of GET /credit is one bounded RPC round trip; the
// vesting history was the unbounded one: ~1,050 sequential 2,000-block
// eth_getLogs reads from the pools' deployment blocks, 97 s at the 150 ms per
// read the deploy-time gateway measured, restarted from scratch by every
// concurrent or retried request.

// Mainnet on 2026-09-16: head 20,715,916; CreditPool deployed at 19,421,558;
// DepositPool v2.1 at 19,913,549. 10,000-block chunks, 8 ranges per wave.
const MAINNET_HEAD = 20_715_916;
const CREDIT_POOL_DEPLOYMENT = 19_421_558;
const DEPOSIT_POOL_DEPLOYMENT = 19_913_549;
const CHUNK_BLOCKS = 10_000;
const SCAN_CONCURRENCY = 8;
const chunks = (deployment, head) => Math.ceil((head - deployment + 1) / CHUNK_BLOCKS);

function rpcClockFixture({ getLogsMs, callMs, head, credit, deposit }) {
  let now = 0;
  let pending = [];
  let inFlightLogs = 0;
  const provider = countingProvider({
    delayMs: 1, clock: () => now,
    sleep: () => new Promise((resolve) => {
      pending.push({ due: now + (provider.calls.at(-1)?.method === "getLogs" ? getLogsMs : callMs), resolve });
    })
  });
  provider.head = head;
  const rawGetLogs = provider.getLogs.bind(provider);
  const stats = { maxInFlightLogs: 0 };
  provider.getLogs = async (filter) => {
    inFlightLogs += 1;
    stats.maxInFlightLogs = Math.max(stats.maxInFlightLogs, inFlightLogs);
    try { return await rawGetLogs(filter); } finally { inFlightLogs -= 1; }
  };
  const checkpoint = checkpointData();
  checkpoint._meta.status.polkadotHubMainnet.block.number = head;
  const fixture = creditReadFixture({ provider, fetchImpl: indexerFetch({ checkpoint }) });
  fixture.gateway.config.creditPoolDeploymentBlock = credit;
  fixture.gateway.config.depositPoolV2DeploymentBlock = deposit;
  async function drive() {
    provider.calls.length = 0;
    stats.maxInFlightLogs = 0;
    const startedAt = now;
    let complete = false;
    let result;
    let failure;
    void fixture.request().then((value) => { result = value; complete = true; },
      (error) => { failure = error; complete = true; });
    for (let tick = 0; tick < 100_000 && !complete; tick += 1) {
      await new Promise(setImmediate);
      if (complete || !pending.length) continue;
      now = Math.min(...pending.map((entry) => entry.due));
      const ready = pending.filter((entry) => entry.due === now);
      pending = pending.filter((entry) => entry.due !== now);
      ready.forEach((entry) => entry.resolve());
    }
    assert.equal(complete, true, "bounded RPC schedule must complete");
    if (failure) throw failure;
    return { result, elapsedMs: now - startedAt, getLogs: provider.calls.filter((c) => c.method === "getLogs").length,
      calls: provider.calls.length, maxInFlightLogs: stats.maxInFlightLogs };
  }
  return { fixture, provider, drive };
}

test("a cold credit door with production block ranges stays inside its RPC budget and bounds its gateway calls", async (t) => {
  const { drive, provider } = rpcClockFixture({
    getLogsMs: 150, callMs: 50, head: MAINNET_HEAD, credit: CREDIT_POOL_DEPLOYMENT, deposit: DEPOSIT_POOL_DEPLOYMENT
  });
  const cold = await drive();
  t.diagnostic(`cold /credit on a 150 ms/getLogs gateway: ${cold.elapsedMs} ms RPC clock, ${cold.getLogs} getLogs, ${cold.calls} RPC calls`);
  assert.equal(cold.result.body.available, true);
  assert.equal(cold.result.body.wallet.vestingAvailable, true);
  assert.equal(cold.result.body.receiptGraph.available, true);
  assert.equal(cold.getLogs, chunks(CREDIT_POOL_DEPLOYMENT, MAINNET_HEAD) + chunks(DEPOSIT_POOL_DEPLOYMENT, MAINNET_HEAD),
    "exactly one getLogs per 10,000-block chunk of each pool's history");
  assert.equal(cold.getLogs, 211);
  assert.ok(cold.calls <= 300, `${cold.calls} RPC calls`);
  assert.ok(cold.maxInFlightLogs <= 2 * SCAN_CONCURRENCY, `${cold.maxInFlightLogs} concurrent getLogs`);
  assert.ok(cold.elapsedMs < 4_000, `cold read took ${cold.elapsedMs} ms of RPC time; the smoke allows 20 s wall clock`);

  const warm = await drive();
  assert.equal(warm.getLogs, 0);
  assert.ok(warm.elapsedMs <= 300, `warm read took ${warm.elapsedMs} ms`);

  provider.head += 1;
  const extended = await drive();
  assert.equal(extended.getLogs, 2, "one incremental range per pool");
  assert.ok(extended.elapsedMs <= 450, `incremental read took ${extended.elapsedMs} ms`);
});

test("a history slower than the wait budget still answers /credit inside the budget with an honest vesting reason", async () => {
  const provider = countingProvider();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const rawGetLogs = provider.getLogs.bind(provider);
  provider.getLogs = async (filter) => { await gate; return rawGetLogs(filter); };
  const fixture = creditReadFixture({ provider });
  fixture.gateway.config.poolEventHistoryWaitMs = 20;

  const startedAt = performance.now();
  const degraded = await fixture.request();
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 1_000, `the door waited ${elapsedMs} ms on a gated history`);
  assert.equal(degraded.status, 200);
  assert.equal(degraded.body.available, true);
  assert.equal(degraded.body.wallet.vestingAvailable, false);
  assert.equal(degraded.body.wallet.vestingUnavailableReason, "deposit_history_warming");
  assert.equal(degraded.body.wallet.vestedAssets.raw, "0", "an unknown history vests nothing");
  assert.equal(degraded.body.wallet.loanable.raw, "0");
  // Everything the hosted smoke's CreditPool clause reads is present and live.
  assert.match(degraded.body.wallet.outstanding.raw, /^[0-9]+$/u);
  assert.match(degraded.body.receiptGraph.wallet.cash.outstanding.raw, /^[0-9]+$/u);
  assert.match(degraded.body.receiptGraph.wallet.posting.outstanding.raw, /^[0-9]+$/u);
  assert.equal(degraded.body.disclosure.statement, CREDIT_POOL_RISK_DISCLOSURE);
  assert.equal(degraded.body.block.number, HEAD);
  assert.equal(fixture.gateway.poolEventScans.size, 2, "both history scans keep running after the door answered");

  release();
  await Promise.all(fixture.gateway.poolEventScans.values());
  const logsAfterWarm = provider.calls.filter((c) => c.method === "getLogs").length;
  assert.equal(logsAfterWarm, 2 * Math.ceil(HEAD / CHUNK_BLOCKS), "one scan per pool, never restarted");
  const warmed = await fixture.request();
  assert.equal(warmed.body.wallet.vestingAvailable, true);
  assert.equal(warmed.body.wallet.vestingUnavailableReason, undefined);
  assert.equal(provider.calls.filter((c) => c.method === "getLogs").length, logsAfterWarm);
});

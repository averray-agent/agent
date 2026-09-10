import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PlatformService } from "../core/platform-service.js";
import { addresses, checkpointData, countingProvider, creditReadFixture,
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

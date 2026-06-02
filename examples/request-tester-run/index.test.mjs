import assert from "node:assert/strict";
import test from "node:test";

import * as testerClient from "./index.mjs";
import {
  TesterRequestError,
  discoverTesterCapabilities,
  parseArgs,
  readTesterReport,
  requestTesterRun,
  runTesterDemo
} from "./index.mjs";

const MONITOR = "https://monitor.averray.test/";

/** A fetch stub that records calls and returns a canned JSON response. */
function stubFetch(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    return { ok, status, text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, calls };
}

test("discoverTesterCapabilities GETs the manifest with a Bearer token", async () => {
  const { fetchImpl, calls } = stubFetch({ flows: [{ name: "surface_sweep", status: "available" }] });
  const manifest = await discoverTesterCapabilities({ monitorUrl: MONITOR, token: "t0ken", fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://monitor.averray.test/monitor/tester/capabilities");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.authorization, "Bearer t0ken");
  assert.deepEqual(manifest.flows[0], { name: "surface_sweep", status: "available" });
});

test("requestTesterRun POSTs requester+reason to the T6 request endpoint (board-gated)", async () => {
  const { fetchImpl, calls } = stubFetch({ ok: true, boardGated: true, run: { id: "testbed-mission-abc" } });
  const result = await requestTesterRun({
    monitorUrl: MONITOR,
    token: "t0ken",
    requesterAgent: "averray-agent",
    targetUrl: "https://app.averray.com/overview",
    goal: "Check a fresh agent can reach the first receipt.",
    reason: "Pre-merge UX check for the onboarding change.",
    mode: "fresh",
    fetchImpl
  });
  assert.equal(calls[0].url, "https://monitor.averray.test/monitor/testbed-missions/request");
  assert.equal(calls[0].init.method, "POST");
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent, {
    requesterAgent: "averray-agent",
    targetUrl: "https://app.averray.com/overview",
    goal: "Check a fresh agent can reach the first receipt.",
    reason: "Pre-merge UX check for the onboarding change.",
    mode: "fresh"
  });
  // Security boundary: the request NEVER carries a run/approve/mutation field.
  assert.ok(!("initialStatus" in sent));
  assert.ok(!("allowTestMutations" in sent));
  assert.ok(!("approve" in sent));
  assert.equal(result.boardGated, true);
});

test("requestTesterRun requires an attributable, justified request", async () => {
  const { fetchImpl } = stubFetch({});
  const base = { monitorUrl: MONITOR, targetUrl: "https://x.test", reason: "why", requesterAgent: "a", fetchImpl };
  await assert.rejects(() => requestTesterRun({ ...base, requesterAgent: undefined }), TesterRequestError);
  await assert.rejects(() => requestTesterRun({ ...base, reason: undefined }), TesterRequestError);
  await assert.rejects(() => requestTesterRun({ ...base, targetUrl: undefined }), TesterRequestError);
  await assert.rejects(() => requestTesterRun({ ...base, mode: "live" }), TesterRequestError);
});

test("readTesterReport GETs the mission by id", async () => {
  const { fetchImpl, calls } = stubFetch({ id: "testbed-mission-abc", status: "completed", verdict: "OK" });
  const report = await readTesterReport({ monitorUrl: MONITOR, missionId: "testbed-mission-abc", fetchImpl });
  assert.equal(calls[0].url, "https://monitor.averray.test/monitor/testbed-missions/testbed-mission-abc");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(report.verdict, "OK");
});

test("a non-ok response surfaces an honest error, not a silent empty result", async () => {
  const { fetchImpl } = stubFetch({ error: "monitor_unauthorized" }, { ok: false, status: 401 });
  await assert.rejects(
    () => discoverTesterCapabilities({ monitorUrl: MONITOR, fetchImpl }),
    /monitor_unauthorized/u
  );
});

test("the helper exposes ONLY discover/request/read — never run, approve, or mutate", () => {
  // Exact allow-list: external agents are requesters, never runners. There is no
  // exported way to RUN, APPROVE, or MUTATE a mission from this repo — that
  // authority stays with the operator on the Hermes board.
  const exportedFns = Object.keys(testerClient)
    .filter((k) => typeof testerClient[k] === "function")
    .sort();
  assert.deepEqual(exportedFns, [
    "TesterRequestError",
    "discoverTesterCapabilities",
    "parseArgs",
    "readTesterReport",
    "requestTesterRun",
    "runTesterDemo"
  ]);
});

test("runTesterDemo discovers, then requests when target+reason are given (and notes the gate)", async () => {
  const { fetchImpl, calls } = stubFetch({ ok: true, boardGated: true, run: { id: "m1" } });
  const summary = await runTesterDemo({
    monitorUrl: MONITOR,
    targetUrl: "https://app.averray.com",
    reason: "smoke",
    fetchImpl
  });
  assert.equal(calls[0].url.endsWith("/monitor/tester/capabilities"), true);
  assert.equal(calls[1].url.endsWith("/monitor/testbed-missions/request"), true);
  assert.match(summary.note, /operator approval/u);
});

test("parseArgs maps the request + report flags", () => {
  assert.deepEqual(
    parseArgs(["--monitor", "https://m", "--requester", "a", "--target", "https://t", "--reason", "why", "--mode", "memory"]),
    { monitorUrl: "https://m", requesterAgent: "a", targetUrl: "https://t", reason: "why", mode: "memory" }
  );
});

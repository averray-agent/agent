import test from "node:test";
import assert from "node:assert/strict";

import {
  QUEUE_LABEL,
  guardrailsFor,
  fetchQueuedIssues,
  issueBodyFor,
  issueTitleFor,
  markerFor,
  queueFiredSignals
} from "./social-signal-queue.mjs";

const SWEPT_AT = "2026-08-10T05:12:00.000Z";
const ENV = { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r" };

function signal(id = "jobs-settled-500", claim = "Averray mainnet has passed 500 settled jobs") {
  return {
    signalId: id,
    claim,
    source: "transparency",
    receipt: { kind: "transparency", url: "https://averray.com/transparency" },
    checkedAgainst: { endpoint: "/transparency", fields: {} }
  };
}

/** A fake GitHub that records what it was asked to do. */
function fakeGitHub({ existing = [], failCreate = false } = {}) {
  const calls = { list: 0, created: [] };
  const fetchImpl = async (url, init = {}) => {
    if ((init.method ?? "GET") === "GET") {
      calls.list += 1;
      return { ok: true, status: 200, json: async () => existing };
    }
    if (failCreate) return { ok: false, status: 422, json: async () => ({}) };
    const payload = JSON.parse(init.body);
    calls.created.push(payload);
    const number = 900 + calls.created.length;
    return {
      ok: true,
      status: 201,
      json: async () => ({ number, html_url: `https://github.com/o/r/issues/${number}` })
    };
  };
  return { fetchImpl, calls };
}

test("nothing fired means nothing is touched — not even a list call", async () => {
  const { fetchImpl, calls } = fakeGitHub();
  const result = await queueFiredSignals({ fetchImpl, env: ENV, signals: [], sweptAt: SWEPT_AT });

  assert.equal(result.state, "idle");
  assert.equal(calls.list, 0, "a quiet sweep must not talk to GitHub at all");
});

test("a fired signal becomes one issue carrying its marker", async () => {
  const { fetchImpl, calls } = fakeGitHub();
  const result = await queueFiredSignals({
    fetchImpl,
    env: ENV,
    signals: [signal()],
    sweptAt: SWEPT_AT
  });

  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].title, "Averray mainnet has passed 500 settled jobs");
  assert.ok(calls.created[0].body.includes(markerFor("jobs-settled-500")));
  assert.deepEqual(calls.created[0].labels, [QUEUE_LABEL]);
  assert.equal(result.queued[0].number, 901);
});

test("an already-queued signal opens no duplicate", async () => {
  // This is the case that happens EVERY DAY: CI never persists state, so the
  // same signal re-fires until a human commits the bump.
  const { fetchImpl, calls } = fakeGitHub({
    existing: [
      {
        number: 5,
        state: "open",
        body: `${markerFor("jobs-settled-500")}\nsomething`,
        html_url: "https://github.com/o/r/issues/5"
      }
    ]
  });

  const result = await queueFiredSignals({
    fetchImpl,
    env: ENV,
    signals: [signal()],
    sweptAt: SWEPT_AT
  });

  assert.equal(calls.created.length, 0, "a daily re-fire must not open a new issue daily");
  assert.equal(result.skipped[0].number, 5);
  assert.equal(result.skipped[0].action, "already-queued");
});

test("a CLOSED issue still blocks recreation — closing means handled", async () => {
  const { fetchImpl, calls } = fakeGitHub({
    existing: [
      {
        number: 5,
        state: "closed",
        body: markerFor("jobs-settled-500"),
        html_url: "https://github.com/o/r/issues/5"
      }
    ]
  });

  const result = await queueFiredSignals({
    fetchImpl,
    env: ENV,
    signals: [signal()],
    sweptAt: SWEPT_AT
  });

  assert.equal(calls.created.length, 0, "the queue must not argue with a deliberate close");
  assert.equal(result.skipped[0].state, "closed");
});

test("pull requests on the issues endpoint are never mistaken for the queue", async () => {
  const { fetchImpl } = fakeGitHub({
    existing: [
      { number: 7, state: "open", body: markerFor("x"), html_url: "u", pull_request: { url: "p" } }
    ]
  });

  assert.deepEqual(await fetchQueuedIssues({ fetchImpl, token: "t", repo: "o/r" }), []);
});

test("a failed list throws rather than opening duplicates against an unknown queue", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });

  await assert.rejects(
    () => queueFiredSignals({ fetchImpl, env: ENV, signals: [signal()], sweptAt: SWEPT_AT }),
    /GitHub issue list responded 500/u
  );
});

test("a non-array list throws rather than reading as 'nothing queued'", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });

  await assert.rejects(
    () => fetchQueuedIssues({ fetchImpl, token: "t", repo: "o/r" }),
    /refusing to read it as 'nothing queued'/u
  );
});

test("a failed create throws — a dropped signal reached nobody", async () => {
  const { fetchImpl } = fakeGitHub({ failCreate: true });

  await assert.rejects(
    () => queueFiredSignals({ fetchImpl, env: ENV, signals: [signal()], sweptAt: SWEPT_AT }),
    /GitHub issue create responded 422/u
  );
});

test("firing with an unconfigured queue is an error, not a shrug", async () => {
  const { fetchImpl } = fakeGitHub();

  await assert.rejects(
    () => queueFiredSignals({ fetchImpl, env: {}, signals: [signal()], sweptAt: SWEPT_AT }),
    /fired but the queue is unconfigured/u
  );
});

test("switching the queue off is explicit, recorded, and never the default", async () => {
  const { fetchImpl, calls } = fakeGitHub();

  const result = await queueFiredSignals({
    fetchImpl,
    env: { SOCIAL_SWEEP_QUEUE: "off" },
    signals: [signal()],
    sweptAt: SWEPT_AT
  });

  assert.equal(result.state, "off", "off is a recorded state, not an absence");
  assert.equal(calls.created.length, 0);
  assert.notEqual(result.state, "idle", "off and 'nothing fired' must not look the same");
});

test("a merged-PR signal carries the merged-is-not-deployed warning into the issue", () => {
  const body = issueBodyFor(
    {
      signalId: "shipped-pr-42",
      claim: "Merged: Arm the x402 poster ramp",
      source: "github",
      receipt: { kind: "pull-request", url: "https://github.com/o/r/pull/42" },
      deployVerified: false
    },
    { sweptAt: SWEPT_AT }
  );

  assert.match(body, /Merged is not deployed/u);
  assert.match(body, /https:\/\/github\.com\/o\/r\/pull\/42/u);
});

test("a transparency signal carries no deploy warning — it has nothing to deploy", () => {
  assert.doesNotMatch(issueBodyFor(signal(), { sweptAt: SWEPT_AT }), /Merged is not deployed/u);
});

test("the body says plainly that closing means handled", () => {
  assert.match(issueBodyFor(signal(), { sweptAt: SWEPT_AT }), /closing means handled/u);
});

test("an overlong claim is truncated for the title, not dropped", () => {
  const long = "x".repeat(200);
  const title = issueTitleFor({ signalId: "s", claim: long });

  assert.ok(title.length <= 120);
  assert.ok(title.endsWith("…"));
});

const FRESH_OBSERVED = {
  "flow.jobsSettled.allTime": { value: 164, status: "fresh" },
  "flow.composition24h.external": { value: 0, status: "fresh" }
};

test("the do-not-claim rail names the external-agents trap explicitly", () => {
  const rails = guardrailsFor(FRESH_OBSERVED);

  assert.ok(rails.some((r) => /external/u.test(r) && /\*\*0\*\*/u.test(r)));
  assert.ok(rails.some((r) => /164/u.test(r)));
});

test("a stale reading licenses no rail — we do not lecture from a number we distrust", () => {
  const rails = guardrailsFor({
    "flow.composition24h.external": { value: 0, status: "stale" },
    "flow.jobsSettled.allTime": { value: 164, status: "stale" }
  });

  assert.deepEqual(rails, []);
});

test("a non-zero external count drops the do-not-say-external rail", () => {
  const rails = guardrailsFor({
    ...FRESH_OBSERVED,
    "flow.composition24h.external": { value: 2, status: "fresh" }
  });

  assert.ok(!rails.some((r) => /outside agents are active/u.test(r)));
});

test("the issue carries the material and the rails together", () => {
  const body = issueBodyFor(
    { ...signal(), context: "We measured 0.202% friction moving 10 USDC." },
    { sweptAt: SWEPT_AT, observed: FRESH_OBSERVED }
  );

  assert.match(body, /What the author said it does/u);
  assert.match(body, /0\.202% friction/u);
  assert.match(body, /Do not claim/u);
  assert.match(body, /composition24h\.external/u);
});

test("no material and no reading still produces a usable issue", () => {
  const body = issueBodyFor(signal(), { sweptAt: SWEPT_AT });

  assert.doesNotMatch(body, /What the author said it does/u);
  assert.doesNotMatch(body, /Do not claim/u);
  assert.match(body, /closing means handled/u);
});

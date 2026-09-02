import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AuthenticationError } from "../../core/errors.js";
import { createEventRoutes } from "./event-routes.js";

const AUTH = {
  wallet: "0x1111111111111111111111111111111111111111"
};

function makeRequest({ method = "GET", headers = {} } = {}) {
  const request = new EventEmitter();
  request.method = method;
  request.headers = headers;
  return request;
}

function makeResponse() {
  return {
    _corsHeaders: { "access-control-allow-origin": "https://app.averray.com" },
    _requestId: "req-1",
    chunks: [],
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    write(chunk) {
      this.chunks.push(chunk);
    },
    end() {
      this.ended = true;
    },
  };
}

function makeHarness(overrides = {}) {
  const calls = [];
  let subscriber;
  const route = createEventRoutes({
    authMiddleware: async (_request, _url, options) => {
      calls.push(["auth", options]);
      if (overrides.authError) {
        throw overrides.authError;
      }
      return overrides.auth ?? AUTH;
    },
    enforceLimit: async (bucket, key, limits) => {
      calls.push(["limit", { bucket, key, limits }]);
    },
    eventBus: overrides.eventBus ?? {
      replayDurable: async (filter, lastEventId, options) => {
        calls.push(["replayDurable", { filter, lastEventId, options }]);
        return overrides.replay ?? {
          gap: true,
          events: [
            { id: "event-1", topic: "session.claimed", payload: { ok: true } }
          ]
        };
      },
      subscribe: (filter, callback) => {
        calls.push(["subscribe", filter]);
        subscriber = callback;
        return () => calls.push(["unsubscribe"]);
      }
    },
    metrics: {
      gauge: (name) => ({
        inc: () => calls.push(["gauge.inc", name]),
        dec: () => calls.push(["gauge.dec", name]),
      })
    },
    parseEventFilters: (url) => {
      calls.push(["parseEventFilters", url.search]);
      return {
        topics: url.searchParams.get("topics")?.split(",").filter(Boolean) ?? [],
        sources: [],
        phases: [],
        severities: [],
      };
    },
    parseLimit: (url, fallback, max) => {
      calls.push(["parseLimit", { fallback, max, limit: url.searchParams.get("limit") }]);
      return Number(url.searchParams.get("limit") ?? fallback);
    },
    rateLimitConfig: { events: { windowMs: 10_000, max: 3 } },
  });
  return {
    calls,
    emitSubscribedEvent(event) {
      assert.equal(typeof subscriber, "function");
      subscriber(event);
    },
    route,
  };
}

test("event routes ignore unrelated paths and methods", async () => {
  const { calls, route } = makeHarness();
  const response = makeResponse();

  assert.equal(await route({
    request: makeRequest(),
    response,
    url: new URL("http://localhost/audit"),
    pathname: "/audit",
  }), false);
  assert.equal(await route({
    request: makeRequest({ method: "POST" }),
    response,
    url: new URL("http://localhost/events"),
    pathname: "/events",
  }), false);

  assert.deepEqual(calls, []);
  assert.equal(response.statusCode, undefined);
});

test("GET /events authenticates, replays durable events, subscribes, and cleans up on close", async () => {
  const { calls, emitSubscribedEvent, route } = makeHarness();
  const request = makeRequest();
  const response = makeResponse();
  const handled = await route({
    request,
    response,
    url: new URL("http://localhost/events?jobId=job-1&sessionId=session-1&topics=session.claimed&lastEventId=event-0&limit=7"),
    pathname: "/events",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/event-stream");
  assert.equal(response.headers["x-request-id"], "req-1");
  assert.equal(response.headers["access-control-allow-origin"], "https://app.averray.com");
  assert.deepEqual(calls.find(([name]) => name === "auth")?.[1], { allowQueryToken: true });
  assert.deepEqual(calls.find(([name]) => name === "limit")?.[1], {
    bucket: "events",
    key: AUTH.wallet,
    limits: { windowMs: 10_000, max: 3 }
  });
  assert.deepEqual(calls.find(([name]) => name === "replayDurable")?.[1], {
    filter: {
      wallet: AUTH.wallet,
      jobId: "job-1",
      sessionId: "session-1",
      topics: ["session.claimed"],
      sources: [],
      phases: [],
      severities: [],
    },
    lastEventId: "event-0",
    options: { limit: 7 }
  });
  assert.ok(response.chunks.some((chunk) => chunk.includes("event: gap")));
  assert.ok(response.chunks.some((chunk) => chunk.includes("event: session.claimed")));

  emitSubscribedEvent({ id: "event-2", topic: "session.verified", payload: { ok: true } });
  assert.ok(response.chunks.some((chunk) => chunk.includes("event: session.verified")));

  request.emit("close");
  assert.equal(response.ended, true);
  assert.ok(calls.some(([name]) => name === "unsubscribe"));
  assert.deepEqual(calls.filter(([name]) => name.startsWith("gauge.")), [
    ["gauge.inc", "sse_active_connections"],
    ["gauge.dec", "sse_active_connections"],
  ]);
});

test("GET /events falls back to volatile replay and uses last-event-id header", async () => {
  const calls = [];
  const eventBus = {
    replay: (filter, lastEventId) => {
      calls.push(["replay", { filter, lastEventId }]);
      return { events: [{ id: "event-legacy", topic: "legacy", payload: {} }] };
    },
    subscribe: () => () => calls.push(["unsubscribe"]),
  };
  const { route } = makeHarness({ eventBus });
  const request = makeRequest({ headers: { "last-event-id": "header-event" } });
  const response = makeResponse();

  const handled = await route({
    request,
    response,
    url: new URL("http://localhost/events?lastEventId=query-event"),
    pathname: "/events",
  });

  assert.equal(handled, true);
  assert.deepEqual(calls.find(([name]) => name === "replay")?.[1].lastEventId, "header-event");
  assert.ok(response.chunks.some((chunk) => chunk.includes("event: legacy")));
  request.emit("close");
});

test("event routes propagate auth failures before opening SSE", async () => {
  const authError = new AuthenticationError("No token.");
  const { calls, route } = makeHarness({ authError });
  const response = makeResponse();

  await assert.rejects(
    () => route({
      request: makeRequest(),
      response,
      url: new URL("http://localhost/events"),
      pathname: "/events",
    }),
    authError
  );

  assert.deepEqual(calls, [["auth", { allowQueryToken: true }]]);
  assert.equal(response.statusCode, undefined);
  assert.deepEqual(response.chunks, []);
});

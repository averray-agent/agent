import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizationError } from "../../core/errors.js";
import { createShareRoutes } from "./share-routes.js";

const AUTH = {
  wallet: "0x1111111111111111111111111111111111111111",
  claims: { roles: ["admin"] }
};

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const route = createShareRoutes({
    authConfig: {
      signingSecret: "share-route-test-secret-with-at-least-32-bytes",
      strict: true
    },
    authMiddleware: async (_request, _url) => {
      calls.push(["auth"]);
      return overrides.auth ?? AUTH;
    },
    authorizeShareTarget: async (target) => {
      calls.push(["authorize", target]);
      if (overrides.authorizeError) throw overrides.authorizeError;
    },
    publicBaseUrl: "https://api.averray.com",
    readJsonBody: async () => {
      calls.push(["body"]);
      return overrides.payload ?? { surface: "session", id: "session-1", ttlSeconds: 60 };
    },
    resolveShareResource: async (share) => {
      calls.push(["resolve", share]);
      return overrides.resource ?? { kind: `${share.surface}_snapshot`, id: share.id };
    },
    respond: (res, statusCode, body, headers = {}) => {
      calls.push(["respond", { statusCode, body, headers }]);
      res.statusCode = statusCode;
      res.body = body;
      res.headers = headers;
    }
  });
  return { calls, response, route };
}

test("share routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/nope"),
    pathname: "/nope"
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("POST /shares authenticates, authorizes target, and returns a signed app path", async () => {
  const { calls, response, route } = makeHarness({
    payload: { surface: "session_audit", sessionId: "session-1", ttlSeconds: 60 }
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/shares"),
    pathname: "/shares"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.status, "created");
  assert.equal(response.body.share.surface, "session");
  assert.equal(response.body.share.id, "session-1");
  assert.equal(response.body.share.mode, "read_only");
  assert.match(response.body.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assert.equal(response.body.appPath, `/share?token=${encodeURIComponent(response.body.token)}`);
  assert.equal(response.body.apiUrl, `https://api.averray.com/shares/${response.body.token}`);
  assert.deepEqual(calls.slice(0, 3), [
    ["auth"],
    ["body"],
    ["authorize", { surface: "session", id: "session-1", auth: AUTH }]
  ]);
});

test("GET /shares/:token validates token and resolves resource without auth", async () => {
  const created = makeHarness();
  await created.route({
    request: { method: "POST" },
    response: created.response,
    url: new URL("http://localhost/shares"),
    pathname: "/shares"
  });

  const { calls, response, route } = makeHarness();
  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL(`http://localhost/shares/${created.response.body.token}`),
    pathname: `/shares/${created.response.body.token}`
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.share.surface, "session");
  assert.equal(response.body.resource.kind, "session_snapshot");
  assert.equal(calls[0][0], "resolve");
  assert.equal(calls.some(([name]) => name === "auth"), false);
});

test("GET /shares/:token rejects tampered token", async () => {
  const { response, route } = makeHarness();

  await assert.rejects(
    route({
      request: { method: "GET" },
      response,
      url: new URL("http://localhost/shares/bad.token"),
      pathname: "/shares/bad.token"
    }),
    AuthorizationError
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizationError, ValidationError } from "../../core/errors.js";
import { createXcmRequestRoutes } from "./xcm-request-routes.js";

const AUTH = {
  wallet: "0x1111111111111111111111111111111111111111",
};
const REQUEST_ID = `0x${"ab".repeat(32)}`;
const RECORD = {
  requestId: REQUEST_ID,
  account: AUTH.wallet,
  status: "pending",
};

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const route = createXcmRequestRoutes({
    authMiddleware: async (_request, _url) => {
      calls.push(["auth"]);
      return overrides.auth ?? AUTH;
    },
    ensureXcmRequestOwnership: (record, auth) => {
      calls.push(["ensureOwnership", { record, auth }]);
      if (overrides.ownershipError) {
        throw overrides.ownershipError;
      }
    },
    respond: (res, statusCode, body, headers = {}) => {
      calls.push(["respond", { statusCode, body, headers }]);
      res.statusCode = statusCode;
      res.body = body;
      res.headers = headers;
    },
    service: {
      getXcmRequest: async (requestId) => {
        calls.push(["getXcmRequest", requestId]);
        return overrides.record ?? RECORD;
      },
    },
  });
  return { calls, response, route };
}

test("xcm request routes ignore unrelated paths and methods", async () => {
  const { calls, response, route } = makeHarness();

  assert.equal(await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/xcm/not-request"),
    pathname: "/xcm/not-request",
  }), false);
  assert.equal(await route({
    request: { method: "POST" },
    response,
    url: new URL(`http://localhost/xcm/request?requestId=${REQUEST_ID}`),
    pathname: "/xcm/request",
  }), false);

  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET /xcm/request authenticates, loads the request, checks ownership, and responds", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL(`http://localhost/xcm/request?requestId=${REQUEST_ID}`),
    pathname: "/xcm/request",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, RECORD);
  assert.deepEqual(calls, [
    ["auth"],
    ["getXcmRequest", REQUEST_ID],
    ["ensureOwnership", { record: RECORD, auth: AUTH }],
    ["respond", { statusCode: 200, body: RECORD, headers: {} }],
  ]);
});

test("GET /xcm/request validates requestId before service reads", async () => {
  const { calls, response, route } = makeHarness();

  await assert.rejects(
    () => route({
      request: { method: "GET" },
      response,
      url: new URL("http://localhost/xcm/request"),
      pathname: "/xcm/request",
    }),
    ValidationError,
  );

  assert.deepEqual(calls, [["auth"]]);
  assert.deepEqual(response, {});
});

test("GET /xcm/request propagates ownership failures before responding", async () => {
  const ownershipError = new AuthorizationError("not yours", "xcm_request_not_owned");
  const { calls, response, route } = makeHarness({ ownershipError });

  await assert.rejects(
    () => route({
      request: { method: "GET" },
      response,
      url: new URL(`http://localhost/xcm/request?requestId=${REQUEST_ID}`),
      pathname: "/xcm/request",
    }),
    ownershipError,
  );

  assert.deepEqual(calls, [
    ["auth"],
    ["getXcmRequest", REQUEST_ID],
    ["ensureOwnership", { record: RECORD, auth: AUTH }],
  ]);
  assert.deepEqual(response, {});
});

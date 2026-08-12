import assert from "node:assert/strict";
import test from "node:test";

import { Readable } from "node:stream";

import { createDepositPoolRoutes } from "./deposit-pool-routes.js";

function request(method, body, authorization) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  stream.method = method;
  stream.headers = authorization ? { authorization } : {};
  return stream;
}

function routeFixture() {
  const calls = [];
  const route = createDepositPoolRoutes({
    authMiddleware: async () => ({ wallet: "0x2222222222222222222222222222222222222222" }),
    depositPoolDoor: {
      async getInfo(wallet) { calls.push(["getInfo", wallet]); return { available: true, wallet }; },
      async buildTransactions(wallet, payload) { calls.push(["build", wallet, payload]); return { direction: payload.direction, wallet }; }
    },
    readJsonBody: async (source) => {
      let text = "";
      for await (const chunk of source) text += chunk;
      return text ? JSON.parse(text) : {};
    },
    respond(response, statusCode, body) {
      response.statusCode = statusCode;
      response.body = body;
    }
  });
  return { calls, route };
}

test("GET /pool is public and adds wallet-only fields when a bearer is present", async () => {
  const { calls, route } = routeFixture();
  const publicResponse = {};
  const authedResponse = {};
  await route({ request: request("GET"), response: publicResponse, url: new URL("http://local/pool"), pathname: "/pool" });
  await route({ request: request("GET", undefined, "Bearer token"), response: authedResponse, url: new URL("http://local/pool"), pathname: "/pool" });
  assert.deepEqual(calls, [
    ["getInfo", undefined],
    ["getInfo", "0x2222222222222222222222222222222222222222"]
  ]);
  assert.equal(publicResponse.body.wallet, undefined);
  assert.equal(authedResponse.body.wallet, "0x2222222222222222222222222222222222222222");
});

test("POST /pool/transactions is wallet-authenticated and returns the shared payload", async () => {
  const { calls, route } = routeFixture();
  const response = {};
  await route({
    request: request("POST", { direction: "withdraw", shares: "1" }, "Bearer token"),
    response,
    url: new URL("http://local/pool/transactions"),
    pathname: "/pool/transactions"
  });
  assert.deepEqual(calls[0], [
    "build",
    "0x2222222222222222222222222222222222222222",
    { direction: "withdraw", shares: "1" }
  ]);
  assert.equal(response.body.direction, "withdraw");
});

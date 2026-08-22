import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";

import { createMcpToolExecutor } from "../mcp/tools.js";
import { invokeHttpRoute } from "../mcp/route-adapter.js";
import { createEarningsDoorRoutes } from "./earnings-door-routes.js";

const WALLET = "0x1111111111111111111111111111111111111111";

function request(method, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  stream.method = method;
  stream.headers = { authorization: "Bearer token" };
  return stream;
}

function routeFixture({ eventBus } = {}) {
  const calls = [];
  const route = createEarningsDoorRoutes({
    authMiddleware: async () => ({ wallet: WALLET }),
    earningsDoor: {
      async getAccount(wallet, asset) {
        calls.push(["get", wallet, asset]);
        return { available: true, account: { owner: wallet, asset: { symbol: asset }, available: { raw: "7" } } };
      },
      async buildWithdrawTransactions(wallet, payload) {
        calls.push(["build", wallet, payload]);
        return {
          available: true,
          wallet,
          templates: [{ unsigned: true }],
          firstWithdrawalGasGrant: { status: payload.requestGasGrant ? "granted" : "available", reason: "fixture" },
          whatYourBalanceCanDo: { retentionNotGates: { templatesRemainComplete: true } }
        };
      }
    },
    eventBus,
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

test("earnings HTTP routes bind every account read and template to the authenticated wallet", async () => {
  const { calls, route } = routeFixture();
  const getResponse = {};
  const buildResponse = {};
  await route({
    request: request("GET"), response: getResponse,
    url: new URL("http://local/account/position?asset=USDC"), pathname: "/account/position"
  });
  await route({
    request: request("POST", { amount: "1", destination: "0x2222222222222222222222222222222222222222" }),
    response: buildResponse,
    url: new URL("http://local/account/withdraw/transactions"), pathname: "/account/withdraw/transactions"
  });
  assert.deepEqual(calls, [
    ["get", WALLET, "USDC"],
    ["build", WALLET, { amount: "1", destination: "0x2222222222222222222222222222222222222222" }]
  ]);
  assert.equal(getResponse.body.account.owner, WALLET);
  assert.equal(buildResponse.body.templates[0].unsigned, true);
});

test("withdrawal intent telemetry stores creation and grant status without transaction payloads", async () => {
  const events = [];
  const { route } = routeFixture({ eventBus: { publish: (event) => events.push(event) } });
  await route({
    request: request("POST", {
      amount: "7000000",
      destination: "0x2222222222222222222222222222222222222222",
      requestGasGrant: true
    }),
    response: {},
    url: new URL("http://local/account/withdraw/transactions"),
    pathname: "/account/withdraw/transactions"
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].topic, "journey.withdrawal_intent_created");
  assert.equal(events[0].wallet, WALLET);
  assert.deepEqual(events[0].data, {
    status: "created",
    gasGrantRequested: true,
    gasGrantStatus: "granted",
    gasGrantReason: "fixture"
  });
  assert.doesNotMatch(JSON.stringify(events[0]), /7000000|0x222222/u);
});

test("HTTP and MCP earnings doors return byte-identical payloads", async () => {
  const { route } = routeFixture();
  const sourceRequest = { headers: { authorization: "Bearer token" }, socket: { remoteAddress: "127.0.0.1" } };
  const execute = createMcpToolExecutor({
    handleAuthRoute: async () => false,
    handleDepositPoolRoute: async () => false,
    handleEarningsDoorRoute: route,
    handleJobRoute: async () => false,
    handlePublicMetadataRoute: async () => false
  });
  const directGet = await invokeHttpRoute(route, {
    method: "GET", path: "/account/position?asset=USDC", sourceRequest
  });
  const mcpGet = await execute("getAccountPosition", { asset: "USDC" }, { request: sourceRequest });
  assert.equal(JSON.stringify(mcpGet), JSON.stringify(directGet.body));

  const input = {
    asset: "USDC",
    amount: "1",
    destination: "0x2222222222222222222222222222222222222222",
    requestGasGrant: true
  };
  const directBuild = await invokeHttpRoute(route, {
    method: "POST", path: "/account/withdraw/transactions", body: input, sourceRequest
  });
  const mcpBuild = await execute("buildWithdrawTransactions", input, { request: sourceRequest });
  assert.equal(JSON.stringify(mcpBuild), JSON.stringify(directBuild.body));
});

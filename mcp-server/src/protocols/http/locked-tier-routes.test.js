import assert from "node:assert/strict";
import test from "node:test";

import { createLockedTierRoutes } from "./locked-tier-routes.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LOCK_ID = `0x${"11".repeat(32)}`;

function routeHarness() {
  const calls = [];
  const route = createLockedTierRoutes({
    authMiddleware: async () => ({ wallet: WALLET }),
    depositPoolDoor: { getInfo: async (wallet) => ({ available: true, wallet: { address: wallet } }) },
    lockedTierService: {
      quote: async (wallet, payload, options) => {
        calls.push(["quote", wallet, payload, options.poolInfo]);
        return { kind: "quote" };
      },
      createLock: async (wallet, payload, options) => {
        calls.push(["consent", wallet, payload, options.poolInfo]);
        return { kind: "lock" };
      },
      requestExit: async (wallet, id) => {
        calls.push(["exit", wallet, id]);
        return { kind: "exit" };
      }
    },
    readJsonBody: async (request) => request.body ?? {},
    respond: (response, statusCode, body) => Object.assign(response, { statusCode, body })
  });
  return { route, calls };
}

async function invoke(route, path, body = {}, method = "POST") {
  const response = {};
  const url = new URL(path, "https://api.averray.com");
  const handled = await route({
    request: { method, body, headers: { authorization: "Bearer wallet" } },
    response,
    url,
    pathname: url.pathname
  });
  return { handled, response };
}

test("locked-tier HTTP quote precedes signed-consent creation and both bind auth wallet", async () => {
  const h = routeHarness();
  const quoted = await invoke(h.route, "/locked-deposits/quote", { tier: "t30" });
  const created = await invoke(h.route, "/locked-deposits/consent", { termsHash: LOCK_ID });
  assert.equal(quoted.response.statusCode, 200);
  assert.equal(created.response.statusCode, 201);
  assert.deepEqual(h.calls.map(([kind, wallet]) => [kind, wallet]), [
    ["quote", WALLET],
    ["consent", WALLET]
  ]);
});

test("locked-tier HTTP early exit accepts no alternate terms", async () => {
  const h = routeHarness();
  const exited = await invoke(h.route, `/locked-deposits/${LOCK_ID}/exit`);
  assert.equal(exited.response.statusCode, 200);
  assert.deepEqual(h.calls[0], ["exit", WALLET, LOCK_ID]);
  await assert.rejects(
    () => invoke(h.route, `/locked-deposits/${LOCK_ID}/exit`, { penalty: "1" }),
    /accepts no caller-supplied terms/u
  );
});

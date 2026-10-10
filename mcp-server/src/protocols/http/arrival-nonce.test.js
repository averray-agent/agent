import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SelfIdentityRegistry } from "../../core/self-identity-registry.js";
import { ArrivalObservatory, extractHttpClientInfo } from "../../services/arrival-observatory.js";
import { ArrivalSessionTrail } from "../../services/arrival-session-trail.js";
import { verifiedArrivalWallet } from "./arrival-wallet.js";
import { createAuthRoutes } from "./auth-routes.js";

const ARBITRARY = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SELF = "0xcccccccccccccccccccccccccccccccccccccccc";
const USER_AGENT = "NonceProbe/9";

function memoryStore() {
  const state = new Map();
  return {
    state,
    async getServiceState(scope) { return state.get(scope); },
    async upsertServiceState(scope, value) {
      state.set(scope, { ...(state.get(scope) ?? {}), ...value });
      return state.get(scope);
    },
    async deleteServiceState(scope) { state.delete(scope); }
  };
}

function observatoryFor(identityRegistry) {
  return new ArrivalObservatory({
    stateStore: memoryStore(),
    now: () => 10_000,
    flushIntervalMs: 0,
    identityRegistry
  });
}

async function recordFinish(observatory, request, pathname, method) {
  await observatory.recordHttp({
    method,
    pathname,
    clientInfo: extractHttpClientInfo(request),
    ip: "203.0.113.8",
    wallet: verifiedArrivalWallet(pathname, request),
    outcome: { ok: true }
  });
}

test("the HTTP finish hook drops an unsigned nonce wallet", () => {
  const source = readFileSync(new URL("./server.js", import.meta.url), "utf8");
  assert.match(source, /const arrivalWallet = verifiedArrivalWallet\(pathname, request\)/u);
  assert.equal(source.includes("wallet: request._arrivalWallet"), false);
  assert.equal(verifiedArrivalWallet("/auth/nonce", {
    _arrivalWallet: ARBITRARY
  }), undefined);
  assert.equal(verifiedArrivalWallet("/auth/session", {
    _arrivalWallet: ARBITRARY
  }), ARBITRARY);
});

test("a nonce for an arbitrary wallet does not link the user agent", async () => {
  const observatory = observatoryFor(new SelfIdentityRegistry());
  const request = { headers: { "user-agent": USER_AGENT }, _arrivalWallet: ARBITRARY };
  await recordFinish(observatory, request, "/auth/nonce", "POST");
  await recordFinish(observatory, { headers: { "user-agent": USER_AGENT } }, "/openapi.json", "GET");
  const snapshot = await observatory.getSnapshot();
  assert.equal(snapshot.funnelHttpSelf.identified, 0);
  assert.equal(snapshot.funnelHttpSelf.reached, 0);
  assert.equal(snapshot.funnelHttpExternal.identified, 1);
  assert.equal(snapshot.funnelHttpExternal.reached, 1);
  assert.equal(snapshot.funnelHttpAmbiguous.identified, 0);
  assert.equal(snapshot.httpClients.some((entry) => entry.wallet === ARBITRARY), false);
  const probe = snapshot.httpClients.find((entry) => entry.name === "NonceProbe");
  assert.equal(probe.wallet, null);
  assert.equal(probe.self, false);
  assert.equal(probe.ambiguous, false);
});

test("a nonce for a registered self wallet is not counted as self", async () => {
  const observatory = observatoryFor(new SelfIdentityRegistry({ qaEngineerWallets: [SELF] }));
  const request = { headers: { "user-agent": USER_AGENT }, _arrivalWallet: SELF };
  await recordFinish(observatory, request, "/auth/nonce", "POST");
  await recordFinish(observatory, { headers: { "user-agent": USER_AGENT } }, "/openapi.json", "GET");
  const snapshot = await observatory.getSnapshot();
  assert.equal(snapshot.funnelHttpSelf.identified, 0);
  assert.equal(snapshot.funnelHttpSelf.reached, 0);
  assert.equal(snapshot.funnelHttpExternal.identified, 1);
  assert.equal(snapshot.httpClients.some((entry) => entry.wallet === SELF), false);
  assert.equal(snapshot.httpClients.find((entry) => entry.name === "NonceProbe").self, false);
});

test("POST /auth/nonce does not stamp an arrival wallet or stitch a session", async () => {
  const route = createAuthRoutes({
    authConfig: {
      domain: "app.example.test",
      chainId: 1,
      nonceTtlSeconds: 60,
      tokenTtlSeconds: 60,
      signingSecret: "test-secret"
    },
    stateStore: { async storeNonce() { return true; } },
    rateLimitConfig: { authNonce: { limit: 10, windowSeconds: 60 } },
    readJsonBody: async () => ({ wallet: ARBITRARY }),
    clientIp: () => "203.0.113.9",
    enforceLimit: async () => {},
    respond: (_response, status, body) => ({ status, body })
  });
  const response = { headers: {}, setHeader() {} };
  const request = { method: "POST", headers: { "user-agent": USER_AGENT } };
  assert.equal(await route({
    request,
    response,
    url: new URL("http://localhost/auth/nonce"),
    pathname: "/auth/nonce"
  }), true);
  assert.equal(request._arrivalWallet, undefined);

  const store = memoryStore();
  const sessions = new ArrivalSessionTrail({ stateStore: store, now: () => 10_000, flushIntervalMs: 0 });
  await sessions.observe({
    wallet: ARBITRARY,
    door: "http",
    name: "GET /auth/session",
    resultClass: "ok",
    stage: "reached"
  });
  const before = await sessions.get(`wallet:${ARBITRARY}`);
  request._arrivalWallet = ARBITRARY;
  await sessions.observe({
    wallet: verifiedArrivalWallet("/auth/nonce", request),
    clientInfo: extractHttpClientInfo(request),
    door: "http",
    name: "POST /auth/nonce",
    resultClass: "ok",
    stage: "identified"
  });
  const after = await sessions.get(`wallet:${ARBITRARY}`);
  assert.equal(after.session.steps.length, before.session.steps.length);
  assert.equal(after.session.steps.some((step) => step.name === "POST /auth/nonce"), false);
  const fresh = "0xdddddddddddddddddddddddddddddddddddddddd";
  await sessions.observe({
    wallet: verifiedArrivalWallet("/auth/nonce", { _arrivalWallet: fresh }),
    door: "http",
    name: "POST /auth/nonce",
    resultClass: "ok",
    stage: "identified"
  });
  assert.equal(await sessions.get(`wallet:${fresh}`), undefined);
});

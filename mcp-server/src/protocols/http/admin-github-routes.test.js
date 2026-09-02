import assert from "node:assert/strict";
import test from "node:test";
import { createAdminGithubRoutes } from "./admin-github-routes.js";

const AUTH = { wallet: "0xadmin", roles: ["admin"] };

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const route = createAdminGithubRoutes({
    authMiddleware: async (_request, _url, options) => {
      calls.push(["auth", options]);
      return overrides.auth ?? AUTH;
    },
    parseLimit: (url, fallback, max) => {
      calls.push(["parseLimit", { fallback, max }]);
      return Number(url.searchParams.get("limit") ?? fallback);
    },
    respond: (res, statusCode, body) => {
      calls.push(["respond", { statusCode, body }]);
      res.statusCode = statusCode;
      res.body = body;
    },
    service: {
      getGithubOperatorStatus: async (options) => {
        calls.push(["getGithubOperatorStatus", options]);
        return overrides.githubStatus ?? { ok: true, options };
      },
    },
  });
  return { calls, response, route };
}

test("admin GitHub routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/not-github/status"),
    pathname: "/admin/not-github/status",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET /admin/github/status requires admin auth and returns helper status", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/github/status"),
    pathname: "/admin/github/status",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    options: {
      repos: undefined,
      limit: 5,
      view: undefined,
    },
  });
  assert.deepEqual(calls, [
    ["auth", { requireRole: "admin" }],
    ["parseLimit", { fallback: 5, max: 20 }],
    ["getGithubOperatorStatus", {
      repos: undefined,
      limit: 5,
      view: undefined,
    }],
    ["respond", {
      statusCode: 200,
      body: {
        ok: true,
        options: {
          repos: undefined,
          limit: 5,
          view: undefined,
        },
      },
    }],
  ]);
});

test("GET /admin/github/status preserves repos, limit, and view query handling", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/github/status?repos=org/a,org/b&limit=17&view=prs"),
    pathname: "/admin/github/status",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.slice(1, 3), [
    ["parseLimit", { fallback: 5, max: 20 }],
    ["getGithubOperatorStatus", {
      repos: "org/a,org/b",
      limit: 17,
      view: "prs",
    }],
  ]);
});

test("GET /admin/github/status preserves explicitly empty query values", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/github/status?repos=&view="),
    pathname: "/admin/github/status",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.find(([name]) => name === "getGithubOperatorStatus"), [
    "getGithubOperatorStatus",
    {
      repos: "",
      limit: 5,
      view: "",
    },
  ]);
});

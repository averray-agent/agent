import assert from "node:assert/strict";
import test from "node:test";
import { createPublicMetadataRoutes } from "./public-metadata-routes.js";

const STRATEGIES = [
  { strategyId: "vdot-test", asset: "DOT", executionMode: "async_xcm" }
];
const PROVIDER_STATUS = {
  github: { ok: true, lastRun: { status: "success" } }
};
const PLATFORM_CAPABILITIES = {
  version: "v1",
  onboarding: { walletModes: [{ id: "siwe" }] }
};

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const route = createPublicMetadataRoutes({
    authConfig: overrides.authConfig ?? { mode: "strict" },
    buildDiscoveryManifest: (options) => {
      calls.push(["buildDiscoveryManifest", options]);
      return overrides.discoveryManifest ?? {
        version: "2026-05-24",
        baseUrl: options.baseUrl,
      };
    },
    publicBaseUrl: overrides.publicBaseUrl ?? " https://api.averray.com ",
    respond: (res, statusCode, body, headers = {}) => {
      calls.push(["respond", { statusCode, body, headers }]);
      res.statusCode = statusCode;
      res.body = body;
      res.headers = headers;
    },
    service: {
      getPublicProviderOperations: async () => {
        calls.push(["getPublicProviderOperations"]);
        return overrides.providerStatus ?? PROVIDER_STATUS;
      },
      getPlatformCapabilities: () => {
        calls.push(["getPlatformCapabilities"]);
        return overrides.platformCapabilities ?? PLATFORM_CAPABILITIES;
      }
    },
    strategies: overrides.strategies ?? STRATEGIES,
  });
  return { calls, response, route };
}

test("public metadata routes ignore unrelated paths and methods", async () => {
  const { calls, response, route } = makeHarness();

  assert.equal(await route({
    request: { method: "GET" },
    response,
    pathname: "/health",
  }), false);
  assert.equal(await route({
    request: { method: "POST" },
    response,
    pathname: "/onboarding",
  }), false);

  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET / returns public API metadata without calling provider services", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    pathname: "/",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.name, "agent-platform");
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.authMode, "strict");
  assert.ok(response.body.endpoints.includes("/agent-tools.json"));
  assert.ok(response.body.endpoints.includes("/.well-known/badge-receipt-jwks.json"));
  assert.deepEqual(response.body.receiptVerification, {
    badgeReceipts: {
      alg: "ES256",
      kid: "badge-1",
      jwksUrl: "https://api.averray.com/.well-known/badge-receipt-jwks.json",
      canonicalizationDocs: "https://github.com/averray-agent/agent/blob/main/docs/schemas/agent-badge-v1.md#exact-canonicalization-and-signing-bytes"
    },
    runReceipts: {
      alg: "ES256",
      kid: "badge-1",
      jwksUrl: "https://api.averray.com/.well-known/badge-receipt-jwks.json",
      canonicalPath: "/badges/:sessionId/run",
      schema: "https://raw.githubusercontent.com/averray-agent/agent/main/docs/schemas/run-receipt-v1.json",
      canonicalizationDocs: "https://github.com/averray-agent/agent/blob/main/docs/schemas/run-receipt-v1.md#signature-and-canonical-bytes"
    }
  });
  assert.ok(response.body.endpoints.includes("/status/providers") === false);
  assert.deepEqual(calls, [
    ["respond", { statusCode: 200, body: response.body, headers: {} }],
  ]);
});

test("GET /status/providers returns sanitized provider operations", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    pathname: "/status/providers",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, PROVIDER_STATUS);
  assert.deepEqual(calls, [
    ["getPublicProviderOperations"],
    ["respond", { statusCode: 200, body: PROVIDER_STATUS, headers: {} }],
  ]);
});

test("GET /onboarding returns platform capabilities", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    pathname: "/onboarding",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, PLATFORM_CAPABILITIES);
  assert.deepEqual(calls, [
    ["getPlatformCapabilities"],
    ["respond", { statusCode: 200, body: PLATFORM_CAPABILITIES, headers: {} }],
  ]);
});

test("GET discovery manifest mirrors trim the public base URL and cache the response", async () => {
  for (const pathname of ["/agent-tools.json", "/.well-known/agent-tools.json"]) {
    const { calls, response, route } = makeHarness();

    const handled = await route({
      request: { method: "GET" },
      response,
      pathname,
    });

    assert.equal(handled, true);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      version: "2026-05-24",
      baseUrl: "https://api.averray.com",
    });
    assert.deepEqual(response.headers, { "cache-control": "public, max-age=300" });
    assert.deepEqual(calls, [
      ["buildDiscoveryManifest", { baseUrl: "https://api.averray.com" }],
      ["respond", {
        statusCode: 200,
        body: response.body,
        headers: { "cache-control": "public, max-age=300" }
      }],
    ]);
  }
});

test("GET /strategies returns configured strategy metadata with public cache headers", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    pathname: "/strategies",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    strategies: STRATEGIES,
    docs: "https://github.com/depre-dev/agent/blob/main/docs/strategies/vdot.md"
  });
  assert.deepEqual(response.headers, { "cache-control": "public, max-age=300" });
  assert.deepEqual(calls, [
    ["respond", {
      statusCode: 200,
      body: response.body,
      headers: { "cache-control": "public, max-age=300" }
    }],
  ]);
});

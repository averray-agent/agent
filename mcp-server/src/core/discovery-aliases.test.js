import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import test from "node:test";
import { buildDiscoveryManifest, CONNECTED_ONLY_TOOLS } from "./discovery-manifest.js";
import { DISCOVERY_ALIAS_PATHS } from "./discovery-aliases.js";
import { publicOpenApiErrors } from "./public-openapi-contract.js";
import { createPublicMetadataRoutes } from "../protocols/http/public-metadata-routes.js";
import { HTTP_METRIC_PATHS, metricPathLabel, respond } from "../protocols/http/http-helpers.js";
import { buildX402DiscoveryDocument } from "../payments/x402-discovery.js";
import { VerificationProfileRegistry } from "../services/verification-profile-registry.js";

function harness() {
  let amount = "7123456";
  let marker = "first request";
  const profiles = new VerificationProfileRegistry().list();
  const getX402Discovery = () => buildX402DiscoveryDocument({
    profiles,
    paymentGate: {
      eip712Domain: async () => ({ name: "USD Coin", version: "2" }),
      paymentResource: () => ({ url: "https://api.averray.com/verify/runs", description: "Verify", mimeType: "application/json" }),
      paymentRequirements: () => ({ scheme: "exact", network: "eip155:8453", amount, payTo: "0x1111111111111111111111111111111111111111" })
    }
  });
  const manifest = () => ({ ...buildDiscoveryManifest({ chainId: 420420419 }), name: marker });
  const route = createPublicMetadataRoutes({ buildDiscoveryManifest: manifest, getX402Discovery, respond });
  return {
    manifest,
    setAmount(value) { amount = value; },
    setMarker(value) { marker = value; },
    async get(pathname, method = "GET") {
      const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
      const handled = await route({ request: { method }, pathname, response });
      return { ...response, handled, json: response.body ? JSON.parse(response.body) : null };
    }
  };
}

test("discovery aliases expose exactly the request-time directory-safe tools and no connected-only tools", async () => {
  const h = harness();
  for (const path of DISCOVERY_ALIAS_PATHS) {
    for (const marker of ["first request", "changed manifest"]) {
      h.setMarker(marker);
      const response = await h.get(path);
      assert.equal(response.status, 200);
      assert.equal(response.headers["content-type"], "application/json");
      assert.equal(response.json.name, marker);
      assert.equal(response.json.discoveryMode, "directory-safe");
      assert.deepEqual(response.json.capabilities, h.manifest().tools);
      const serializedBody = JSON.stringify(response.json);
      for (const name of CONNECTED_ONLY_TOOLS) {
        assert.ok(!response.json.capabilities.some((tool) => tool.name === name), `${path}: ${name}`);
        assert.equal(serializedBody.includes(name), false, `${path}: serialized body contains connected-only name ${name}`);
      }
    }
    assert.equal((await h.get(path, "POST")).handled, false);
  }
});

test("discovery alias pricing follows changed live x402 terms with no literal or cached price", async () => {
  const h = harness();
  for (const amount of ["7123456", "9234567"]) {
    h.setAmount(amount);
    const discovery = (await h.get("/.well-known/x402")).json;
    assert.equal(discovery.resources.length, 1);
    for (const path of DISCOVERY_ALIAS_PATHS) {
      const response = await h.get(path);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.deepEqual(response.json.pricing, discovery);
      assert.equal(response.json.pricing.resources[0].maxAmountRequired, amount);
      assert.ok(response.json.pricing.resources[0].accepts.every((terms) => terms.amount === amount));
    }
  }
});

test("ai-agent discovery has the exact directory-safe projection key set", async () => {
  const { json: body } = await harness().get("/.well-known/ai-agent.json");
  assert.deepEqual(Object.keys(body).sort(), ["auth", "capabilities", "description", "discoveryMode", "name", "pricing", "url"]);
});

test("agent card is descriptive only with no task or RPC endpoint and no A2A claim", async () => {
  const { json: card } = await harness().get("/.well-known/agent-card.json");
  assert.deepEqual(Object.keys(card).sort(), ["capabilities", "description", "discoveryMode", "name", "pricing", "url"]);
  assert.equal(card.url, "https://averray.com/");
  assert.doesNotMatch(JSON.stringify(card), /\ba2a\b/iu);
  const inspect = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.doesNotMatch(key, /^(?:tasks?|rpc|jsonrpc|protocolVersion|protocolEndpoints|supportedInterfaces|preferredTransport)(?:$|Endpoint|Url)/iu);
      inspect(child);
    }
  };
  inspect(card);
});

test("discovery aliases omit unmeasured rate limits and do not invent contact details", async () => {
  const h = harness();
  for (const path of DISCOVERY_ALIAS_PATHS) {
    const { json } = await h.get(path);
    assert.equal(Object.hasOwn(json, "rateLimit"), false);
    assert.equal(Object.hasOwn(json, "contact"), false, "the source manifest has no contact");
  }
  const { json } = await h.get("/.well-known/ai-agent.json");
  assert.deepEqual(json.auth, {
    scheme: h.manifest().auth.scheme,
    schemeId: h.manifest().auth.schemeId,
    supportedWalletModes: h.manifest().auth.supportedWalletModes
  });
});

test("unavailable x402 terms stay empty or fail honestly without a fallback price", async () => {
  for (const path of DISCOVERY_ALIAS_PATHS) {
    const response = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    const dependencies = { buildDiscoveryManifest, respond };
    const empty = { x402Version: 2, resources: [] };
    await createPublicMetadataRoutes({ ...dependencies, getX402Discovery: async () => empty })({ request: { method: "GET" }, pathname: path, response });
    assert.deepEqual(response.body.pricing, empty);
    const unavailable = new Error("payment terms unavailable");
    await assert.rejects(createPublicMetadataRoutes({ ...dependencies, getX402Discovery: async () => { throw unavailable; } })({ request: { method: "GET" }, pathname: path, response }), (error) => error === unavailable);
  }
});

test("discovery aliases are public inventoried OpenAPI operations with no static copies", async () => {
  const document = JSON.parse(await readFile(new URL("../../../docs/api/openapi.json", import.meta.url), "utf8"));
  assert.deepEqual(publicOpenApiErrors(document), []);
  for (const path of DISCOVERY_ALIAS_PATHS) {
    assert.ok(buildDiscoveryManifest().publicEndpoints.some((entry) => entry.method === "GET" && entry.path === path));
    assert.ok(HTTP_METRIC_PATHS.includes(path));
    assert.equal(metricPathLabel(path), path);
    assert.deepEqual(document.paths[path].get.security, []);
    const missing = structuredClone(document);
    delete missing.paths[path];
    assert.ok(publicOpenApiErrors(missing).includes(`missing public operation GET ${path}`));
    for (const directory of ["site", "marketing/public", "discovery"]) {
      await assert.rejects(access(new URL(`../../../${directory}${path}`, import.meta.url)), { code: "ENOENT" });
    }
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildDiscoveryManifest } from "./discovery-manifest.js";
import { readPublicOpenApi, PUBLIC_OPENAPI_DOCUMENT_URL } from "./public-openapi.js";
import { createPublicMetadataRoutes, buildAgentLlmsText } from "../protocols/http/public-metadata-routes.js";
import { HTTP_METRIC_PATHS, respond, respondText } from "../protocols/http/http-helpers.js";
import { buildX402DiscoveryDocument } from "../payments/x402-discovery.js";
import { VerificationProfileRegistry } from "../services/verification-profile-registry.js";
import { OPENAPI_INVENTORY_EXCLUSIONS, PUBLIC_OPENAPI_EXCLUSIONS, publicOpenApiErrors } from "./public-openapi-contract.js";

const readDocument = async () => JSON.parse(await readFile(new URL("../../../docs/api/openapi.json", import.meta.url), "utf8"));

test("public OpenAPI drift guard covers every public discovery operation or named exclusion", async () => {
  assert.deepEqual(publicOpenApiErrors(await readDocument()), []);
});

test("published OpenAPI excludes admin paths, testnet chain ids and localhost servers", async () => {
  const document = await readDocument();
  assert.equal(Object.keys(document.paths).some((path) => path.startsWith("/admin/")), false);
  assert.doesNotMatch(JSON.stringify(document), /420420417/u);
  assert.deepEqual(document.servers.map(({ url }) => url), ["https://api.averray.com"]);
  assert.equal(document.paths["/metrics"], undefined);
  assert.equal(document.paths["/verifier/run"], undefined);
});

test("public OpenAPI drift guard rejects a new unrepresented public registry operation", async () => {
  const document = await readDocument();
  const manifest = buildDiscoveryManifest({ chainId: 420420419 });
  manifest.publicEndpoints.push({ method: "GET", path: "/unrepresented-public-read" });
  assert.ok(publicOpenApiErrors(document, { manifest }).includes("missing public operation GET /unrepresented-public-read"));
  const privateDocument = structuredClone(document);
  privateDocument.paths["/admin/accidental-publication"] = { get: {} };
  assert.ok(publicOpenApiErrors(privateDocument).some((error) => error.includes("private admin path")));
  assert.ok(publicOpenApiErrors(document, { inventory: [...HTTP_METRIC_PATHS, "/unrepresented-public-read"] })
    .some((error) => error.includes("route inventory path needs documentation or a named exclusion")));
});

test("public OpenAPI drift guard rejects documented /monitor/deposit-pool", async () => {
  const document = await readDocument();
  document.paths["/monitor/deposit-pool"] = { get: {} };
  assert.ok(publicOpenApiErrors(document).some((error) => error.startsWith("excluded path /monitor/deposit-pool must not be published")));
});

test("public OpenAPI drift guard rejects every documented inventory exclusion", async () => {
  const document = await readDocument();
  for (const path of Object.keys(OPENAPI_INVENTORY_EXCLUSIONS)) {
    const candidate = structuredClone(document);
    candidate.paths[path] = { get: {} };
    assert.ok(publicOpenApiErrors(candidate).some((error) => error.startsWith(`excluded path ${path} must not be published`)), path);
  }
});

test("public OpenAPI drift guard independently rejects every documented public operation exclusion", async () => {
  const document = await readDocument();
  for (const key of Object.keys(PUBLIC_OPENAPI_EXCLUSIONS)) {
    const [method, path] = key.split(" ");
    const candidate = structuredClone(document);
    candidate.paths[path] = { [method.toLowerCase()]: {} };
    // These operations also have path exclusions: that error alone must not
    // mask a missing operation-level publication check.
    assert.ok(publicOpenApiErrors(candidate).some((error) => error.startsWith(`excluded public operation ${key} must not be published`)), key);
  }
});

test("public OpenAPI GET returns 200 application/json with the structural mainnet contract", async () => {
  const route = createPublicMetadataRoutes({ respond, respondText });
  const response = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
  assert.equal(await route({ request: { method: "GET" }, pathname: "/openapi.json", response }), true);
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/json");
  const document = JSON.parse(response.body);
  assert.deepEqual(document, await readDocument());
  assert.deepEqual(publicOpenApiErrors(document), []);
  assert.equal(await route({ request: { method: "POST" }, pathname: "/openapi.json", response: {} }), false);
});

test("both llms surfaces and discovery mirrors link the same served OpenAPI URL", async () => {
  const expected = "https://api.averray.com/openapi.json";
  const manifest = buildDiscoveryManifest({ chainId: 420420419 });
  assert.equal(manifest.openapi, expected);
  assert.ok(manifest.publicEndpoints.some(({ method, path }) => method === "GET" && path === "/openapi.json"));
  assert.ok(buildAgentLlmsText().includes(expected));
  assert.ok((await readFile(new URL("../../../site/llms.txt", import.meta.url), "utf8")).includes(expected));
  for (const path of ["discovery/agent-tools.json", "discovery/.well-known/agent-tools.json", "site/.well-known/agent-tools.json"]) {
    assert.equal(JSON.parse(await readFile(new URL(`../../../${path}`, import.meta.url), "utf8")).openapi, expected);
  }
  const route = createPublicMetadataRoutes({ respond, respondText });
  const response = { writeHead(status) { this.status = status; }, end(body) { this.document = JSON.parse(body); } };
  await route({ request: { method: "GET" }, response, pathname: new URL(manifest.openapi).pathname });
  assert.equal(response.status, 200);
  assert.equal(response.document.openapi, "3.1.0");
});

test("public OpenAPI image ships the exact source document at its runtime-resolved path", async () => {
  const dockerfile = await readFile(new URL("../../../mcp-server/Dockerfile", import.meta.url), "utf8");
  const imageModuleUrl = new URL("file:///app/src/core/public-openapi.js");
  const source = await readFile(new URL("./public-openapi.js", import.meta.url), "utf8");
  const relativeDocument = source.match(/new URL\("([^"]+openapi\.json)", import\.meta\.url\)/u)?.[1];
  assert.ok(relativeDocument);
  const runtimePath = new URL(relativeDocument, imageModuleUrl).pathname;
  assert.ok(dockerfile.split("\n").includes(`COPY docs/api/openapi.json ${runtimePath}`));
  assert.equal(PUBLIC_OPENAPI_DOCUMENT_URL.pathname.endsWith("/docs/api/openapi.json"), true);
  assert.deepEqual(await readPublicOpenApi(), await readDocument());
});

test("public OpenAPI references and path parameters resolve without duplicate operation ids", async () => {
  const document = await readDocument();
  const operationIds = new Set();
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.$ref) {
      assert.ok(value.$ref.startsWith("#/"), "all current schema references are local");
      assert.ok(value.$ref.slice(2).split("/").reduce((node, key) => node?.[key], document), value.$ref);
    }
    Object.values(value).forEach(walk);
  };
  walk(document);
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!["get", "post"].includes(method)) continue;
      assert.ok(operation.operationId);
      assert.equal(operationIds.has(operation.operationId), false, operation.operationId);
      operationIds.add(operation.operationId);
      for (const [, name] of path.matchAll(/\{([^}]+)\}/gu)) {
        assert.ok(operation.parameters?.some((p) => p.in === "path" && p.required === true && p.name === name), `${method} ${path}: ${name}`);
      }
    }
  }
});

test("publishing OpenAPI keeps x402 discovery at one Verify resource without a baked price", async () => {
  const document = await readDocument();
  const profiles = new VerificationProfileRegistry().list();
  const discovery = await buildX402DiscoveryDocument({
    profiles,
    paymentGate: {
      eip712Domain: async () => ({ name: "USD Coin", version: "2" }),
      paymentResource: () => ({ url: "https://api.averray.com/verify/runs", description: "Verify", mimeType: "application/json" }),
      paymentRequirements: () => ({ scheme: "exact", network: "eip155:8453", amount: "7123456", payTo: "0x1111111111111111111111111111111111111111" })
    }
  });
  assert.equal(discovery.resources.length, 1);
  assert.equal(discovery.resources[0].resource, "https://api.averray.com/verify/runs");
  assert.match(document.paths["/jobs/x402"].post.description, /advertises only POST \/verify\/runs/u);
  for (const path of ["/verify/runs", "/verify/profiles", "/.well-known/x402"]) {
    assert.doesNotMatch(JSON.stringify(document.paths[path]), /5000000|5 USDC|420420419/u);
  }
});

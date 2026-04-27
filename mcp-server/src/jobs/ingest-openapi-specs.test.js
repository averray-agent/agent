import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchOpenApiDetails,
  ingestOpenApiSpecs,
  openApiSpecKey,
  parseOpenApiDocument,
  parseOpenApiSpecs,
  scoreOpenApiTarget,
  toPlatformJob
} from "./ingest-openapi-specs.js";

const SPEC = {
  provider: "stripe",
  specId: "stripe-openapi",
  apiTitle: "Stripe OpenAPI",
  specUrl: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
  localSurface: "mcp-server/src/protocols/http/server.js",
  repo: "averray-agent/agent"
};

const OPENAPI_DOC = {
  openapi: "3.1.0",
  info: { title: "Stripe OpenAPI", version: "2026-01-01" },
  paths: {
    "/v1/customers": {
      get: {
        operationId: "listCustomers",
        responses: { "200": { description: "ok" } }
      },
      post: {
        summary: "Create a customer",
        responses: { "200": { description: "ok" } }
      }
    }
  },
  components: {
    schemas: {
      customer: { type: "object", properties: { id: { type: "string", example: "cus_123" } } }
    }
  }
};

function makeFetch({ status = 200, ok = true } = {}) {
  return async (url, request) => {
    assert.equal(url, SPEC.specUrl);
    assert.match(request.headers.accept, /application\/json/u);
    return {
      ok,
      status,
      url: `${SPEC.specUrl}?from=test`,
      headers: new Map([
        ["content-type", "application/json"],
        ["last-modified", "Mon, 27 Apr 2026 08:00:00 GMT"],
        ["etag", "\"abc123\""]
      ]),
      async text() {
        return JSON.stringify(OPENAPI_DOC);
      }
    };
  };
}

test("parseOpenApiSpecs accepts JSON and compact line syntax", () => {
  assert.deepEqual(parseOpenApiSpecs(JSON.stringify([SPEC])), [SPEC]);
  assert.deepEqual(
    parseOpenApiSpecs("Stripe OpenAPI|https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json|stripe|mcp-server/src/protocols/http/server.js|averray-agent/agent"),
    [
      {
        provider: "stripe",
        specId: "",
        apiTitle: "Stripe OpenAPI",
        specUrl: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
        localSurface: "mcp-server/src/protocols/http/server.js",
        repo: "averray-agent/agent"
      }
    ]
  );
});

test("parseOpenApiDocument inspects JSON OpenAPI documents", () => {
  const details = parseOpenApiDocument(JSON.stringify(OPENAPI_DOC), "application/json");

  assert.equal(details.parseMode, "json");
  assert.equal(details.openapiVersion, "3.1.0");
  assert.equal(details.title, "Stripe OpenAPI");
  assert.equal(details.documentVersion, "2026-01-01");
  assert.equal(details.pathCount, 1);
  assert.equal(details.operationCount, 2);
  assert.equal(details.schemaCount, 1);
  assert.equal(details.missingOperationDescriptions, 1);
  assert.equal(details.missingOperationIds, 1);
  assert.equal(details.exampleCount, 1);
});

test("parseOpenApiDocument captures simple YAML metadata", () => {
  const details = parseOpenApiDocument("openapi: 3.0.3\ninfo:\n  title: Sample API\n  version: 1.0.0\npaths:\n  /health:\n    get:\n      responses: {}\n", "application/yaml");

  assert.equal(details.parseMode, "yaml");
  assert.equal(details.openapiVersion, "3.0.3");
  assert.equal(details.title, "Sample API");
  assert.equal(details.documentVersion, "1.0.0");
  assert.equal(details.operationCount, 1);
});

test("fetchOpenApiDetails captures spec metadata", async () => {
  const details = await fetchOpenApiDetails({ target: SPEC, fetchImpl: makeFetch() });

  assert.equal(details.finalUrl, `${SPEC.specUrl}?from=test`);
  assert.equal(details.openapiVersion, "3.1.0");
  assert.equal(details.operationCount, 2);
  assert.equal(details.lastModified, "Mon, 27 Apr 2026 08:00:00 GMT");
  assert.equal(details.etag, "\"abc123\"");
});

test("scoreOpenApiTarget prefers reachable auditable OpenAPI specs", async () => {
  const details = await fetchOpenApiDetails({ target: SPEC, fetchImpl: makeFetch() });

  assert.ok(scoreOpenApiTarget(details) >= 90);
  assert.ok(scoreOpenApiTarget({ ...details, ok: false, httpStatus: 404 }) < scoreOpenApiTarget(details));
});

test("toPlatformJob creates OpenAPI quality audit job", async () => {
  const details = await fetchOpenApiDetails({ target: SPEC, fetchImpl: makeFetch() });
  const job = toPlatformJob(details, 95);

  assert.equal(job.id, "openapi-stripe-stripe-openapi");
  assert.equal(job.category, "api");
  assert.equal(job.tier, "starter");
  assert.equal(job.verifierMode, "benchmark");
  assert.equal(job.inputSchemaRef, "schema://jobs/openapi-quality-audit-input");
  assert.equal(job.outputSchemaRef, "schema://jobs/openapi-quality-audit-output");
  assert.equal(job.source.type, "openapi_spec");
  assert.equal(job.source.operationCount, 2);
  assert.ok(job.verifierTerms.includes("recommended_actions"));
});

test("openApiSpecKey dedupes by provider, URL, and local surface", () => {
  assert.equal(
    openApiSpecKey({ provider: "Stripe", specUrl: SPEC.specUrl, localSurface: SPEC.localSurface }),
    "stripe|https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json|mcp-server/src/protocols/http/server.js"
  );
});

test("ingestOpenApiSpecs fetches configured specs and returns jobs", async () => {
  const payload = await ingestOpenApiSpecs({
    specs: [SPEC],
    limit: 5,
    minScore: 55,
    fetchImpl: makeFetch()
  });

  assert.equal(payload.provider, "openapi");
  assert.equal(payload.specCount, 1);
  assert.equal(payload.count, 1);
  assert.equal(payload.jobs[0].source.apiTitle, SPEC.apiTitle);
  assert.deepEqual(payload.skipped, []);
});

test("ingestOpenApiSpecs reports fetch failures as skipped targets", async () => {
  const payload = await ingestOpenApiSpecs({
    specs: [SPEC],
    fetchImpl: async () => {
      throw new Error("network unavailable");
    }
  });

  assert.equal(payload.count, 0);
  assert.equal(payload.skipped[0].reason, "fetch_failed");
  assert.equal(payload.skipped[0].message, "network unavailable");
});

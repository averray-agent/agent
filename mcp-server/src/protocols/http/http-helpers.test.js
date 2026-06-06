import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { ValidationError } from "../../core/errors.js";
import {
  createCorsHeaderResolver,
  createJsonBodyReader,
  metricPathLabel,
  parseEventFilters,
  parseLimit,
  parsePositiveInteger,
  respond
} from "./http-helpers.js";

function readableBody(body) {
  return Readable.from([Buffer.from(body)]);
}

test("createJsonBodyReader parses empty and JSON bodies", async () => {
  const readJsonBody = createJsonBodyReader({ maxBytes: 100 });

  assert.deepEqual(await readJsonBody(readableBody("")), {});
  assert.deepEqual(await readJsonBody(readableBody('{"ok":true}')), { ok: true });
});

test("createJsonBodyReader rejects oversized and invalid JSON bodies", async () => {
  const readJsonBody = createJsonBodyReader({ maxBytes: 4 });

  await assert.rejects(
    () => readJsonBody(readableBody('{"too":"large"}')),
    /Request body exceeds 4 bytes/
  );

  await assert.rejects(
    () => createJsonBodyReader({ maxBytes: 100 })(readableBody("{broken")),
    ValidationError
  );
});

test("parseEventFilters accepts aliases and optional event wallet", () => {
  const url = new URL("http://localhost/events?topics=a,b&source=chain&sources=api&phase=claim&severity=error&correlationId=run-1&wallet=0xabc");

  assert.deepEqual(parseEventFilters(url, { includeWallet: true }), {
    topics: ["a", "b"],
    sources: ["api", "chain"],
    phases: ["claim"],
    severities: ["error"],
    correlationId: "run-1",
    eventWallet: "0xabc"
  });
});

test("parseLimit and parsePositiveInteger clamp invalid and oversized values", () => {
  assert.equal(parseLimit(new URL("http://localhost/jobs?limit=12"), 50, 100), 12);
  assert.equal(parseLimit(new URL("http://localhost/jobs?limit=999"), 50, 100), 100);
  assert.equal(parseLimit(new URL("http://localhost/jobs?limit=nope"), 50, 100), 50);

  assert.equal(parsePositiveInteger("7", 3, 10), 7);
  assert.equal(parsePositiveInteger("999", 3, 10), 10);
  assert.equal(parsePositiveInteger("-1", 3, 10), 3);
});

test("createCorsHeaderResolver only emits headers for allowed origins", () => {
  const resolveCorsHeaders = createCorsHeaderResolver({
    allowAllOrigins: false,
    allowedOrigins: new Set(["https://app.averray.com"]),
    allowedMethods: "GET,POST",
    allowedHeaders: "authorization,content-type",
    exposedHeaders: "x-request-id",
    maxAgeSeconds: 600
  });

  assert.deepEqual(resolveCorsHeaders({ headers: { origin: "https://other.example" } }), {});
  assert.deepEqual(resolveCorsHeaders({ headers: { origin: "https://app.averray.com" } }), {
    "access-control-allow-origin": "https://app.averray.com",
    "access-control-allow-methods": "GET,POST",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-expose-headers": "x-request-id",
    "access-control-max-age": "600",
    vary: "origin"
  });
});

test("metricPathLabel keeps known routes and buckets dynamic routes", () => {
  assert.equal(metricPathLabel("/jobs"), "/jobs");
  assert.equal(metricPathLabel("/disputes/dispute-1/verdict"), "/disputes/:id/verdict");
  assert.equal(metricPathLabel("/content/0xabc/publish"), "/content/:hash/publish");
  assert.equal(metricPathLabel("/agents/0xabc"), "/agents/:wallet");
  assert.equal(metricPathLabel("/something/else"), "other");
});

test("respond adds JSON, CORS, and request id headers", () => {
  const response = {
    _requestId: "req-123",
    _corsHeaders: { "access-control-allow-origin": "https://app.averray.com" },
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    }
  };

  respond(response, 201, { ok: true });

  assert.equal(response.statusCode, 201);
  assert.equal(response.headers["content-type"], "application/json");
  assert.equal(response.headers["x-request-id"], "req-123");
  assert.equal(response.headers["access-control-allow-origin"], "https://app.averray.com");
  assert.deepEqual(JSON.parse(response.body), { ok: true });
});

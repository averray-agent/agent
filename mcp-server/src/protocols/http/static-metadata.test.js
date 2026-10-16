import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPublicMetadataRoutes, buildRootMetadata, buildAgentLlmsText } from "./public-metadata-routes.js";
import { respond, respondText } from "./http-helpers.js";
import { readPublicOpenApi } from "../../core/public-openapi.js";

function response() {
  return {
    _corsHeaders: { "access-control-allow-origin": "https://caller.example" },
    _requestId: "request-specific",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
}

for (const path of ["/", "/openapi.json", "/llms.txt"]) {
  test(`listing static ${path}: concurrent builds and serialization happen once; ETag, HEAD and 304 preserve HTTP metadata`, async () => {
    let builds = 0, serializations = 0;
    const json = path !== "/llms.txt";
    const build = async (...args) => {
      builds++;
      const payload = path === "/" ? buildRootMetadata(...args) : json ? await readPublicOpenApi() : buildAgentLlmsText(...args);
      return json ? { toJSON() { serializations++; return payload; } }
        : { toString() { serializations++; return payload; } };
    };
    const routes = createPublicMetadataRoutes({ respond, respondText, authConfig: { mode: "strict" },
      publicBaseUrl: "https://api.example.test", buildRoot: build, readOpenApi: build, buildLlms: build });
    const get = async (headers = {}, head = false) => {
      const res = response(); res._headOnly = head;
      await routes({ request: { method: "GET", headers }, response: res, pathname: path });
      return res;
    };
    const responses = await Promise.all(Array.from({ length: 8 }, () => get()));
    const first = responses[0];
    assert.equal(first.status, 200);
    assert.ok(first.body.length > 100);
    assert.equal(first.headers["content-type"], json ? "application/json" : "text/plain; charset=utf-8");
    assert.equal(first.headers["cache-control"], "public, max-age=300");
    assert.equal(first.headers["content-length"], Buffer.byteLength(first.body));
    const etag = `"${createHash("sha256").update(first.body).digest("hex")}"`;
    assert.equal(first.headers.etag, etag);
    for (const res of responses) assert.equal(res.body, first.body);
    assert.equal((await get({ "if-none-match": '"different"' })).status, 200);
    for (const tag of [etag, `W/${etag}`, `"different", W/${etag}`, "*"]) {
      const res = await get({ "if-none-match": tag });
      assert.equal(res.status, 304);
      assert.equal(res.body, "");
      assert.equal(res.headers.etag, etag);
      assert.equal(res.headers["content-length"], undefined);
      assert.equal(res.headers["access-control-allow-origin"], "https://caller.example");
      assert.equal(res.headers["x-request-id"], "request-specific");
    }
    const head = await get({}, true);
    assert.equal(head.status, 200);
    assert.equal(head.body, undefined);
    assert.equal(head.headers["content-length"], first.headers["content-length"]);
    assert.equal(head.headers.etag, etag);
    assert.equal(builds, 1, "must not rebuild per request");
    assert.equal(serializations, 1, "must cache final bytes, not just the object");
    assert.equal(await routes({ request: { method: "POST" }, response: response(), pathname: path }), false);
  });
}

test("listing static failed build retries, and a fresh router gets new bytes and ETag", async () => {
  let builds = 0;
  const routes = createPublicMetadataRoutes({ respond, respondText, readOpenApi: async () => {
    if (++builds === 1) throw new Error("transient read");
    return { openapi: "3.1.0" };
  } });
  const get = (route, res) => route({ request: { method: "GET" }, response: res, pathname: "/openapi.json" });
  await assert.rejects(get(routes, response()), /transient read/u);
  const original = response(); await get(routes, original);
  await get(routes, response()); assert.equal(builds, 2);
  const next = response();
  await get(createPublicMetadataRoutes({ respond, respondText, readOpenApi: () => ({ openapi: "changed" }) }), next);
  assert.notEqual(next.headers.etag, original.headers.etag);
  assert.notEqual(next.body, original.body);
});

test("listing OpenAPI describes conditional requests and bodyless 304s for all cached paths", async () => {
  const document = await readPublicOpenApi();
  for (const path of ["/", "/openapi.json", "/llms.txt"]) {
    const operation = document.paths[path].get;
    assert.ok(operation.parameters.some((p) => p.in === "header" && p.name === "If-None-Match"));
    assert.equal(operation.responses["200"].headers.ETag.schema.type, "string");
    assert.equal(operation.responses["304"].headers.ETag.schema.type, "string");
    assert.equal(operation.responses["304"].content, undefined);
  }
});

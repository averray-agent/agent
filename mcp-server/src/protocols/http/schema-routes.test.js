import assert from "node:assert/strict";
import test from "node:test";
import { createSchemaRoutes } from "./schema-routes.js";

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const route = createSchemaRoutes({
    getPublicBuiltinJobSchemaByName: (name) => {
      calls.push(["getPublicBuiltinJobSchemaByName", name]);
      return overrides.schemaByName?.[name];
    },
    listBuiltinJobSchemas: () => {
      calls.push(["listBuiltinJobSchemas"]);
      return overrides.schemas ?? [
        {
          $id: "schema://jobs/release-input",
          title: "Release Input",
        },
      ];
    },
    respond: (res, statusCode, body, headers) => {
      calls.push(["respond", { statusCode, body, headers }]);
      res.statusCode = statusCode;
      res.body = body;
      res.headers = headers;
    },
    schemaRefToJobSchemaPath: (schemaRef) => {
      calls.push(["schemaRefToJobSchemaPath", schemaRef]);
      return `/schemas/jobs/${schemaRef.slice("schema://jobs/".length)}.json`;
    },
  });
  return { calls, response, route };
}

test("schema routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    pathname: "/not-schemas",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET /schemas/jobs lists public built-in job schemas with paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    pathname: "/schemas/jobs",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.headers, { "cache-control": "public, max-age=300" });
  assert.deepEqual(response.body, {
    schemas: [
      {
        $id: "schema://jobs/release-input",
        title: "Release Input",
        path: "/schemas/jobs/release-input.json",
      },
    ],
    count: 1,
    docs: "https://github.com/depre-dev/agent/tree/main/docs/schemas/jobs",
  });
  assert.deepEqual(calls, [
    ["listBuiltinJobSchemas"],
    ["schemaRefToJobSchemaPath", "schema://jobs/release-input"],
    ["respond", {
      statusCode: 200,
      body: response.body,
      headers: { "cache-control": "public, max-age=300" },
    }],
  ]);
});

test("GET /schemas/jobs/:name returns a public built-in schema", async () => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "schema://jobs/release-input",
    type: "object",
  };
  const { calls, response, route } = makeHarness({
    schemaByName: {
      "release-input.json": schema,
    },
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    pathname: "/schemas/jobs/release-input.json",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, schema);
  assert.deepEqual(response.headers, { "cache-control": "public, max-age=300" });
  assert.deepEqual(calls, [
    ["getPublicBuiltinJobSchemaByName", "release-input.json"],
    ["respond", {
      statusCode: 200,
      body: schema,
      headers: { "cache-control": "public, max-age=300" },
    }],
  ]);
});

test("GET /schemas/jobs/:name decodes names and reports unknown schemas", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    pathname: "/schemas/jobs/custom%20schema.json",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, {
    status: "not_found",
    message: "Unknown built-in job schema.",
  });
  assert.deepEqual(calls, [
    ["getPublicBuiltinJobSchemaByName", "custom schema.json"],
    ["respond", {
      statusCode: 404,
      body: response.body,
      headers: undefined,
    }],
  ]);
});

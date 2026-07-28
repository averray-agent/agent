import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildDiscoveryManifest } from "./discovery-manifest.js";

const OPENAPI_URL = new URL("../../../docs/api/openapi.json", import.meta.url);
const WORKER_ONBOARDING_ACTIONS = new Set([
  "request_siwe_nonce",
  "verify_siwe_signature",
  "wallet_sign_in"
]);
const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head"];

function toOpenApiPath(path) {
  return path.replace(/:([^/]+)/gu, "{$1}");
}

async function readOpenApi() {
  return JSON.parse(await readFile(OPENAPI_URL, "utf8"));
}

function workerOnboardingRequirements() {
  return buildDiscoveryManifest()
    .onboarding
    .actionRequirements
    .filter((requirement) => WORKER_ONBOARDING_ACTIONS.has(requirement.requiredAction));
}

test("OpenAPI covers every route advertised by the worker onboarding contract", async () => {
  const openapi = await readOpenApi();
  const openApiPaths = new Set(Object.keys(openapi.paths ?? {}));
  const advertisedRoutes = workerOnboardingRequirements()
    .map((requirement) => toOpenApiPath(requirement.path));

  const missingPaths = [...new Set(advertisedRoutes)]
    .filter((path) => !openApiPaths.has(path))
    .sort();

  assert.deepEqual(
    missingPaths,
    [],
    `OpenAPI is missing worker-onboarding routes: ${missingPaths.join(", ")}`
  );
});

test("OpenAPI applies bearer auth to every protected worker-onboarding operation", async () => {
  const openapi = await readOpenApi();

  for (const requirement of workerOnboardingRequirements()) {
    const path = toOpenApiPath(requirement.path);
    const pathItem = openapi.paths[path];
    assert.ok(pathItem, `${path} must be documented before its security can be checked`);

    const methods = requirement.method === "*"
      ? HTTP_METHODS.filter((method) => pathItem[method])
      : [requirement.method.toLowerCase()];

    for (const method of methods) {
      const operation = pathItem[method];
      assert.ok(operation, `${requirement.method} ${path} must be documented`);
      if (requirement.requiresAuth) {
        assert.deepEqual(
          operation.security,
          [{ bearerAuth: [] }],
          `${method.toUpperCase()} ${path} must require bearerAuth`
        );
      } else {
        assert.deepEqual(
          operation.security,
          [],
          `${method.toUpperCase()} ${path} must explicitly remain public`
        );
      }
    }
  }
});

test("OpenAPI documents the direct-schema job submission envelope", async () => {
  const openapi = await readOpenApi();
  const submit = openapi.paths["/jobs/submit"].post;
  const requestSchema = submit.requestBody.content["application/json"].schema;
  const example = submit.requestBody.content["application/json"]
    .examples
    .directOpenApiAuditSchema
    .value;

  assert.deepEqual(requestSchema, { $ref: "#/components/schemas/JobSubmissionRequest" });
  assert.ok(example.submission && typeof example.submission === "object");
  assert.equal("output" in example.submission, false);
  assert.equal(
    openapi.components.schemas.SubmissionContract.properties.schemaValidates.const,
    "payload.submission"
  );
  assert.equal(
    openapi.components.schemas.SubmissionContract.properties.doNotWrapInOutput.const,
    true
  );
});

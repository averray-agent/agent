import test from "node:test";
import assert from "node:assert/strict";

import { ValidationError } from "./errors.js";
import {
  getBuiltinJobSchema,
  getBuiltinJobSchemaByName,
  getPublicBuiltinJobSchemaByName,
  listBuiltinJobSchemas,
  schemaRefToJobSchemaPath,
  validateStructuredSubmission
} from "./job-schema-registry.js";

test("getBuiltinJobSchema resolves built-in first-wave schemas", () => {
  const schema = getBuiltinJobSchema("schema://jobs/pr-review-findings-output");
  assert.equal(schema?.$id, "schema://jobs/pr-review-findings-output");
});

test("validateStructuredSubmission accepts a schema-compliant PR review payload", () => {
  const payload = {
    summary: "Found two issues in the auth flow.",
    findings: [
      {
        severity: "high",
        file: "frontend/auth.js",
        issue: "Reauth loop can hide expired token state.",
        recommendation: "Surface token expiry and short-circuit reauth once."
      }
    ],
    risk_level: "high",
    files_touched: ["frontend/auth.js"],
    recommended_next_step: "request_changes"
  };

  assert.doesNotThrow(() => {
    validateStructuredSubmission("schema://jobs/pr-review-findings-output", payload);
  });
});

test("validateStructuredSubmission rejects missing required fields", () => {
  assert.throws(
    () => validateStructuredSubmission("schema://jobs/pr-review-findings-output", {
      summary: "Looks good"
    }),
    (error) => error instanceof ValidationError && /findings is required/.test(error.message)
  );
});

test("validateStructuredSubmission rejects unknown schemas for structured payloads", () => {
  assert.throws(
    () => validateStructuredSubmission("schema://jobs/custom-output", { ok: true }),
    (error) => error instanceof ValidationError && /known built-in schema/.test(error.message)
  );
});

test("getBuiltinJobSchemaByName resolves a schema from its public name", () => {
  const schema = getBuiltinJobSchemaByName("release-input.json");
  assert.equal(schema?.$id, "schema://jobs/release-input");
});

test("getPublicBuiltinJobSchemaByName returns a JSON-schema-shaped document", () => {
  const schema = getPublicBuiltinJobSchemaByName("release-input");
  assert.equal(schema?.$schema, "http://json-schema.org/draft-07/schema#");
  assert.equal(schema?.$id, "schema://jobs/release-input");
});

test("listBuiltinJobSchemas can expose canonical paths for discovery consumers", () => {
  const schemas = listBuiltinJobSchemas();
  const release = schemas.find((entry) => entry.$id === "schema://jobs/release-input");
  assert.equal(schemaRefToJobSchemaPath(release?.$id), "/schemas/jobs/release-input.json");
});

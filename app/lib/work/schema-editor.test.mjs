import test from "node:test";
import assert from "node:assert/strict";

import {
  assembleSchemaSubmission,
  deriveSchemaExample,
  rawFieldDraft,
  validateSubmissionAgainstSchema
} from "./schema-editor.js";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "status", "checks"],
  properties: {
    summary: { type: "string", minLength: 3 },
    status: { type: "string", enum: ["complete", "blocked"] },
    checks: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    score: { type: "integer", minimum: 0 }
  }
};

test("schema example and guided field draft are derived from the real schema", () => {
  const example = deriveSchemaExample(SCHEMA);
  assert.deepEqual(example, {
    summary: "<summary>",
    status: "complete",
    checks: ["<check>"]
  });
  assert.deepEqual(rawFieldDraft(SCHEMA, example), {
    summary: "<summary>",
    status: "complete",
    checks: '[\n  "<check>"\n]',
    score: ""
  });
});

test("client-side schema validation returns readable field paths", () => {
  const result = validateSubmissionAgainstSchema(SCHEMA, {
    summary: "x",
    status: "unknown",
    checks: []
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((error) => error.path), ["/summary", "/status", "/checks"]);
  assert.match(result.errors[0].message, /at least 3/u);
  assert.match(result.errors[1].message, /complete, blocked/u);
});

test("guided raw fields assemble a schema-valid direct submission object", () => {
  const result = assembleSchemaSubmission(SCHEMA, {
    summary: "Completed the audit",
    status: "complete",
    checks: '["npm test"]',
    score: "7"
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.value, {
    summary: "Completed the audit",
    status: "complete",
    checks: ["npm test"],
    score: 7
  });
});

test("malformed complex fields fail locally without reaching the server validator", () => {
  const result = assembleSchemaSubmission(SCHEMA, {
    summary: "Completed",
    status: "complete",
    checks: "not-json"
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [{ path: "/checks", message: "Enter valid JSON for this array." }]);
});

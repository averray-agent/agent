import test from "node:test";
import assert from "node:assert/strict";

import { ValidationError } from "./errors.js";
import {
  arrayOfStrings,
  booleanSchema,
  enumString,
  integerSchema,
  isPlainObject,
  objectSchema,
  stringSchema,
  validateAgainstSchema
} from "./job-schema-validation.js";

function assertValidationError(fn, message) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.message, message);
    return true;
  });
}

test("validateAgainstSchema validates object requirements and field paths", () => {
  const schema = objectSchema({
    required: ["summary"],
    properties: {
      summary: stringSchema({ minLength: 1 }),
      result: objectSchema({
        required: ["status"],
        properties: {
          status: enumString(["pass", "fail"])
        }
      })
    }
  });

  assert.doesNotThrow(() => {
    validateAgainstSchema({ summary: "ready", result: { status: "pass" } }, schema, "submission");
  });
  assertValidationError(() => {
    validateAgainstSchema({ result: { status: "pass" } }, schema, "submission");
  }, "submission.summary is required");
  assertValidationError(() => {
    validateAgainstSchema({ summary: "ready", result: { status: "maybe" } }, schema, "submission");
  }, "submission.result.status must be one of pass, fail");
  assertValidationError(() => {
    validateAgainstSchema({ summary: "ready", extra: true }, schema, "submission");
  }, "submission.extra is not an allowed field");
});

test("validateAgainstSchema validates arrays and nested item paths", () => {
  const schema = {
    type: "array",
    minItems: 1,
    maxItems: 2,
    items: objectSchema({
      required: ["url"],
      properties: {
        url: stringSchema({ minLength: 1 })
      }
    })
  };

  assert.doesNotThrow(() => {
    validateAgainstSchema([{ url: "https://example.com/source" }], schema, "evidence");
  });
  assertValidationError(() => {
    validateAgainstSchema([], schema, "evidence");
  }, "evidence must contain at least 1 item(s)");
  assertValidationError(() => {
    validateAgainstSchema([{ url: "a" }, { url: "b" }, { url: "c" }], schema, "evidence");
  }, "evidence must contain at most 2 item(s)");
  assertValidationError(() => {
    validateAgainstSchema([{ url: "" }], schema, "evidence");
  }, "evidence[0].url must be at least 1 character(s)");
});

test("validateAgainstSchema validates scalar constraints", () => {
  assertValidationError(() => {
    validateAgainstSchema("", stringSchema({ minLength: 1 }), "title");
  }, "title must be at least 1 character(s)");
  assertValidationError(() => {
    validateAgainstSchema("toolong", stringSchema({ maxLength: 3 }), "title");
  }, "title must be at most 3 character(s)");
  assertValidationError(() => {
    validateAgainstSchema("abc", stringSchema({ pattern: "^[0-9]+$" }), "revision_id");
  }, "revision_id does not match the expected format");
  assertValidationError(() => {
    validateAgainstSchema("draft", enumString(["complete", "blocked"]), "status");
  }, "status must be one of complete, blocked");
  assertValidationError(() => {
    validateAgainstSchema(0.5, integerSchema({ minimum: 1 }), "attempts");
  }, "attempts must be an integer");
  assertValidationError(() => {
    validateAgainstSchema(0, integerSchema({ minimum: 1 }), "attempts");
  }, "attempts must be at least 1");
  assertValidationError(() => {
    validateAgainstSchema("yes", booleanSchema(), "claimable");
  }, "claimable must be a boolean");
});

test("schema constructor helpers preserve expected defaults", () => {
  assert.deepEqual(arrayOfStrings({ minItems: 1 }), {
    type: "array",
    items: { type: "string", minLength: 1 },
    minItems: 1
  });
  assert.deepEqual(objectSchema({ properties: { title: stringSchema() } }), {
    type: "object",
    properties: { title: { type: "string" } },
    required: [],
    additionalProperties: false
  });
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
});

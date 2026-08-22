import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { schemaDisplayFields } from "./schema-shape.js";

test("schema display recursively exposes citation finding array item terms", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../../../docs/schemas/jobs/wikipedia-citation-repair-output-v2.json", import.meta.url),
    "utf8"
  ));
  const finding = schemaDisplayFields(schema).find((field) => field.name === "citation_findings");

  assert.equal(finding.node.minItems, 1);
  assert.equal(finding.node.items.type, "object");
  const itemFields = Object.fromEntries(finding.node.items.fields.map((field) => [field.name, field]));
  assert.equal(itemFields.section.required, true);
  assert.equal(itemFields.current_claim.required, true);
  assert.equal(itemFields.source_quote.required, true);
  assert.equal(itemFields.source_quote.node.minLength, 1);
  assert.equal(itemFields.problem.node.enum.length, 5);
});

test("schema display recurses through nested objects and nested array items", () => {
  const [outer] = schemaDisplayFields({
    type: "object",
    required: ["outer"],
    properties: {
      outer: {
        type: "object",
        required: ["rows"],
        properties: {
          rows: {
            type: "array",
            minItems: 2,
            items: {
              type: "object",
              required: ["label"],
              properties: { label: { type: "string", minLength: 3 } }
            }
          }
        }
      }
    }
  });

  const rows = outer.node.fields[0];
  assert.equal(rows.name, "rows");
  assert.equal(rows.node.minItems, 2);
  assert.equal(rows.node.items.fields[0].name, "label");
  assert.equal(rows.node.items.fields[0].node.minLength, 3);
});

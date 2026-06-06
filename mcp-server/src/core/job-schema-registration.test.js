import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";

import {
  EXTERNAL_SCHEMA_TRUST_BOUNDARY,
  buildExternalSchemaRegistrationMessage,
  normalizeExternalSchemaRegistrations,
  normalizeJobSchemaRef
} from "./job-schema-registration.js";

const EXTERNAL_SCHEMA_SIGNER = new Wallet("0x59c6995e998f97a5a004497e5da795437b4466ad5c2af1c6a6d1dcb1b1ce36b9");

function externalRegistrationBase(overrides = {}) {
  const schemaRef = overrides.schemaRef ?? "schema://jobs/external-audit-output";
  const schema = overrides.schema ?? {
    $id: schemaRef,
    type: "object",
    additionalProperties: false,
    required: ["summary", "score"],
    properties: {
      summary: { type: "string", minLength: 1 },
      score: { type: "integer", minimum: 1 }
    }
  };
  return {
    schemaRef,
    schemaUrl: "https://schemas.example.com/jobs/external-audit-output.json",
    schema,
    issuer: EXTERNAL_SCHEMA_SIGNER.address,
    signedAt: "2026-05-23T00:00:00.000Z",
    ...overrides
  };
}

async function signedExternalRegistration(overrides = {}) {
  const base = externalRegistrationBase(overrides);
  return {
    ...base,
    signature: await EXTERNAL_SCHEMA_SIGNER.signMessage(buildExternalSchemaRegistrationMessage(base))
  };
}

test("normalizeJobSchemaRef accepts canonical job schema refs only", () => {
  assert.equal(normalizeJobSchemaRef(" schema://jobs/external-audit-output "), "schema://jobs/external-audit-output");
  assert.equal(normalizeJobSchemaRef("schema://jobs/Bad_Name"), undefined);
  assert.equal(normalizeJobSchemaRef("https://schemas.example.com/jobs/external-audit-output.json"), undefined);
  assert.equal(normalizeJobSchemaRef(null), undefined);
});

test("normalizeExternalSchemaRegistrations verifies a trusted signed schema", async () => {
  const registration = await signedExternalRegistration();
  const [normalized] = normalizeExternalSchemaRegistrations([registration], {
    allowedSchemaRefs: [registration.schemaRef],
    trustedIssuers: [EXTERNAL_SCHEMA_SIGNER.address]
  });

  assert.equal(normalized.schemaRef, "schema://jobs/external-audit-output");
  assert.equal(normalized.issuer, EXTERNAL_SCHEMA_SIGNER.address);
  assert.equal(normalized.trustBoundary, EXTERNAL_SCHEMA_TRUST_BOUNDARY);
  assert.equal(normalized.signatureVerified, true);
  assert.equal(normalized.trusted, true);
  assert.match(normalized.schemaHash, /^0x[0-9a-f]{64}$/u);
});

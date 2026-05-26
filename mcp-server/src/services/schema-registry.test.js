import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, getBytes, id } from "ethers";

import {
  buildExternalSchemaRegistrationDigest,
  hashExternalSchemaContent
} from "../core/job-schema-registry.js";
import {
  registerExternalSchema,
  validateSubmissionAgainstRegisteredSchema
} from "./schema-registry.js";

const ISSUER = new Wallet("0x59c6995e998f97a5a004497e5da795437b4466ad5c2af1c6a6d1dcb1b1ce36b9");
const OTHER = new Wallet("0x8b3a350cf5c34c9194ca3a545d0ec67d61f328d6e5d11dd95b9af16e70ec4c63");
const JOB_ID = "external-schema-job-001";
const SCHEMA_URL = "https://schemas.example.com/jobs/external-audit-output.json";
const SCHEMA_REF = "schema://jobs/external-audit-output";
const SCHEMA = {
  $id: SCHEMA_REF,
  type: "object",
  additionalProperties: false,
  required: ["summary", "result"],
  properties: {
    summary: { type: "string", minLength: 1 },
    result: { type: "string", enum: ["pass", "fail"] }
  }
};

async function signSchema({ signer = ISSUER, schema = SCHEMA, schemaUrl = SCHEMA_URL, jobId = JOB_ID } = {}) {
  const schemaHash = hashExternalSchemaContent(schema);
  const digest = buildExternalSchemaRegistrationDigest({
    schemaHash,
    schemaUrl,
    jobId: id(jobId)
  });
  return {
    schemaHash,
    signature: await signer.signMessage(getBytes(digest))
  };
}

function fetchSchema(schema = SCHEMA) {
  return async () => ({
    ok: true,
    status: 200,
    async json() {
      return schema;
    }
  });
}

test("registerExternalSchema verifies signer, trust, URL fetch, and content hash", async () => {
  const signed = await signSchema();

  const registration = await registerExternalSchema({
    schemaHash: signed.schemaHash,
    schemaUrl: SCHEMA_URL,
    schemaIssuer: ISSUER.address,
    signature: signed.signature,
    jobId: JOB_ID,
    schemaRef: SCHEMA_REF,
    isTrustedIssuer: async (issuer) => issuer === ISSUER.address,
    fetchImpl: fetchSchema()
  });

  assert.equal(registration.registrationVersion, "external-job-schema-eip191-v1");
  assert.equal(registration.schemaHash, signed.schemaHash);
  assert.equal(registration.schemaIssuer, ISSUER.address);
  assert.equal(registration.chainJobId, id(JOB_ID));
  assert.equal(registration.signatureVerified, true);
  assert.equal(registration.trusted, true);
});

test("registerExternalSchema rejects invalid signatures and untrusted issuers", async () => {
  const signedByOther = await signSchema({ signer: OTHER });

  await assert.rejects(
    () => registerExternalSchema({
      schemaHash: signedByOther.schemaHash,
      schemaUrl: SCHEMA_URL,
      schemaIssuer: ISSUER.address,
      signature: signedByOther.signature,
      jobId: JOB_ID,
      schemaRef: SCHEMA_REF,
      isTrustedIssuer: async () => true,
      fetchImpl: fetchSchema()
    }),
    /signature does not match schemaIssuer/u
  );

  const signed = await signSchema();
  await assert.rejects(
    () => registerExternalSchema({
      schemaHash: signed.schemaHash,
      schemaUrl: SCHEMA_URL,
      schemaIssuer: ISSUER.address,
      signature: signed.signature,
      jobId: JOB_ID,
      schemaRef: SCHEMA_REF,
      isTrustedIssuer: async () => false,
      fetchImpl: fetchSchema()
    }),
    /schemaIssuer is not trusted/u
  );
});

test("validateSubmissionAgainstRegisteredSchema fetches schema and catches hash mismatch", async () => {
  const signed = await signSchema();
  const registration = await registerExternalSchema({
    schemaHash: signed.schemaHash,
    schemaUrl: SCHEMA_URL,
    schemaIssuer: ISSUER.address,
    signature: signed.signature,
    jobId: JOB_ID,
    schemaRef: SCHEMA_REF,
    trustedIssuers: [ISSUER.address],
    fetchImpl: fetchSchema()
  });

  const normalized = await validateSubmissionAgainstRegisteredSchema({
    summary: "External schema output is valid.",
    result: "pass"
  }, JOB_ID, {
    schemaRef: SCHEMA_REF,
    registrations: [registration],
    fetchImpl: fetchSchema()
  });
  assert.equal(normalized.kind, "structured");

  await assert.rejects(
    () => validateSubmissionAgainstRegisteredSchema({
      summary: "External schema output is invalid.",
      result: "maybe"
    }, JOB_ID, {
      schemaRef: SCHEMA_REF,
      registrations: [registration],
      fetchImpl: fetchSchema()
    }),
    /submission.result must be one of pass, fail/u
  );

  await assert.rejects(
    () => validateSubmissionAgainstRegisteredSchema({
      summary: "Hash mismatch should fail before validation.",
      result: "pass"
    }, JOB_ID, {
      schemaRef: SCHEMA_REF,
      registrations: [registration],
      fetchImpl: fetchSchema({ ...SCHEMA, description: "changed content" })
    }),
    /content hash mismatch/u
  );
});

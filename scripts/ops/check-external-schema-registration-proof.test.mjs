import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { normalizeExternalSchemaRegistrations } from "../../mcp-server/src/core/job-schema-registry.js";
import { checkExternalSchemaRegistrationProof } from "./check-external-schema-registration-proof.mjs";

const API_BASE_URL = "https://api.example.test";
const ADMIN_TOKEN = "admin-token";
const JOB_ID = "external-schema-proof-test";
const NORMALIZED_UPPERCASE_JOB_ID = "external-schema-proof-2026-05-27t12-00-00-000z";
const SCHEMA_REF = "schema://jobs/external-proof-output";
const SCHEMA_URL = "https://schemas.example.com/jobs/external-proof-output.json";
const ISSUER = "0xF4Bc6F29F319dE2e6A9197F3f214a3C4B6138BAB";

test("checkExternalSchemaRegistrationProof creates an archived job and proves registered schema validation", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "external-schema-proof-"));
  const evidenceFile = join(tmp, "evidence.json");
  const { fetch, calls } = fakeExternalSchemaFetch();

  const evidence = await checkExternalSchemaRegistrationProof({
    env: {
      ADMIN_JWT: ADMIN_TOKEN,
      API_BASE_URL,
      EXTERNAL_SCHEMA_PROOF_JOB_ID: JOB_ID,
      EXTERNAL_SCHEMA_PROOF_IDEMPOTENCY_KEY: "proof-key",
      EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE: evidenceFile
    },
    fetchImpl: fetch,
    log: () => {},
    now: () => new Date("2026-05-26T12:00:00.000Z")
  });

  assert.equal(evidence.status, "passed");
  assert.equal(evidence.jobId, JOB_ID);
  assert.equal(evidence.definition.registeredSchema, true);
  assert.equal(evidence.validSubmission.valid, true);
  assert.equal(evidence.invalidSubmission.valid, false);
  assert.match(evidence.invalidSubmission.path, /^payload\.submission/u);

  const createCall = calls.find((call) => call.method === "POST" && call.url === `${API_BASE_URL}/admin/jobs`);
  assert.equal(createCall.authorization, `Bearer ${ADMIN_TOKEN}`);
  assert.equal(createCall.body.id, JOB_ID);
  assert.equal(createCall.body.outputSchemaRef, SCHEMA_REF);
  assert.equal(createCall.body.lifecycle.status, "archived");
  assert.equal(createCall.body.schemaTrustPolicy.trustedIssuers[0], ISSUER);
  assert.equal(createCall.body.schemaRegistrations[0].schemaRef, SCHEMA_REF);
  assert.equal(createCall.body.schemaRegistrations[0].schemaUrl, SCHEMA_URL);
  assert.equal(createCall.body.idempotencyKey, "proof-key");
  const normalizedRegistrations = normalizeExternalSchemaRegistrations(createCall.body.schemaRegistrations, {
    allowedSchemaRefs: [SCHEMA_REF],
    trustedIssuers: [ISSUER]
  });
  assert.equal(normalizedRegistrations[0].signatureVerified, true);
  assert.equal(normalizedRegistrations[0].trusted, true);

  const definitionCall = calls.find((call) => call.method === "GET" && call.url.startsWith(`${API_BASE_URL}/jobs/definition?`));
  assert.equal(definitionCall.authorization, `Bearer ${ADMIN_TOKEN}`);
  assert.equal(definitionCall.url, `${API_BASE_URL}/jobs/definition?jobId=${encodeURIComponent(JOB_ID)}&includeArchived=true`);

  const validationCalls = calls.filter((call) => call.method === "POST" && call.url === `${API_BASE_URL}/jobs/validate-submission`);
  assert.equal(validationCalls.length, 2);
  assert.deepEqual(validationCalls[0].body, {
    jobId: JOB_ID,
    submission: {
      summary: "External schema proof passed.",
      result: "pass"
    }
  });

  const evidenceText = await readFile(evidenceFile, "utf8");
  assert.doesNotMatch(evidenceText, new RegExp(ADMIN_TOKEN, "u"));
  assert.equal(JSON.parse(evidenceText).schemaRef, SCHEMA_REF);
});

test("checkExternalSchemaRegistrationProof normalizes jobId before create and lookup", async () => {
  const { fetch, calls } = fakeExternalSchemaFetch({ expectedJobId: NORMALIZED_UPPERCASE_JOB_ID });

  const evidence = await checkExternalSchemaRegistrationProof({
    env: {
      ADMIN_JWT: ADMIN_TOKEN,
      API_BASE_URL,
      EXTERNAL_SCHEMA_PROOF_JOB_ID: "External Schema Proof 2026-05-27T12:00:00.000Z"
    },
    fetchImpl: fetch,
    log: () => {},
    now: () => new Date("2026-05-26T12:00:00.000Z")
  });

  assert.equal(evidence.jobId, NORMALIZED_UPPERCASE_JOB_ID);
  const createCall = calls.find((call) => call.method === "POST" && call.url === `${API_BASE_URL}/admin/jobs`);
  assert.equal(createCall.body.id, NORMALIZED_UPPERCASE_JOB_ID);
  const definitionCall = calls.find((call) => call.method === "GET" && call.url.startsWith(`${API_BASE_URL}/jobs/definition?`));
  assert.equal(definitionCall.url, `${API_BASE_URL}/jobs/definition?jobId=${encodeURIComponent(NORMALIZED_UPPERCASE_JOB_ID)}&includeArchived=true`);
});

test("checkExternalSchemaRegistrationProof fails closed before network calls without ADMIN_JWT", async () => {
  const calls = [];

  await assert.rejects(
    () => checkExternalSchemaRegistrationProof({
      env: { API_BASE_URL },
      fetchImpl: async (...args) => {
        calls.push(args);
        throw new Error("should not fetch");
      },
      log: () => {}
    }),
    /requires ADMIN_JWT/u
  );

  assert.equal(calls.length, 0);
});

test("checkExternalSchemaRegistrationProof requires admin create capability", async () => {
  const { fetch } = fakeExternalSchemaFetch({
    adminSession: {
      wallet: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
      roles: ["admin"],
      capabilities: ["ops:view"]
    }
  });

  await assert.rejects(
    () => checkExternalSchemaRegistrationProof({
      env: { ADMIN_JWT: ADMIN_TOKEN, API_BASE_URL, EXTERNAL_SCHEMA_PROOF_JOB_ID: JOB_ID },
      fetchImpl: fetch,
      log: () => {}
    }),
    /admin token must include jobs:create/u
  );
});

test("checkExternalSchemaRegistrationProof rejects definitions missing trust metadata", async () => {
  const { fetch } = fakeExternalSchemaFetch({ omitTrustMetadata: true });

  await assert.rejects(
    () => checkExternalSchemaRegistrationProof({
      env: { ADMIN_JWT: ADMIN_TOKEN, API_BASE_URL, EXTERNAL_SCHEMA_PROOF_JOB_ID: JOB_ID },
      fetchImpl: fetch,
      log: () => {},
      now: () => new Date("2026-05-26T12:00:00.000Z")
    }),
    /Expected values to be strictly equal/u
  );
});

function fakeExternalSchemaFetch({
  adminSession = defaultAdminSession(),
  expectedJobId = JOB_ID,
  omitTrustMetadata = false
} = {}) {
  const calls = [];

  const fetch = async (url, options = {}) => {
    const method = options.method ?? "GET";
    const call = {
      method,
      url: String(url),
      authorization: normalizeHeaders(options.headers).authorization,
      body: options.body ? JSON.parse(options.body) : undefined
    };
    calls.push(call);

    if (call.url === `${API_BASE_URL}/auth/session` && call.authorization === `Bearer ${ADMIN_TOKEN}`) {
      return json(adminSession);
    }

    if (call.url === `${API_BASE_URL}/admin/jobs` && method === "POST") {
      return json({
        id: normalizeJobIdForTest(call.body.id),
        outputSchemaRef: call.body.outputSchemaRef,
        schemaRegistrations: call.body.schemaRegistrations,
        lifecycle: call.body.lifecycle
      }, 201);
    }

    if (call.url === `${API_BASE_URL}/jobs/definition?jobId=${encodeURIComponent(expectedJobId)}&includeArchived=true`) {
      return json({
        id: expectedJobId,
        submissionContract: {
          registeredSchema: true,
          outputSchemaRef: SCHEMA_REF,
          outputSchemaUrl: SCHEMA_URL,
          schemaHash: "0xabc",
          schemaIssuer: ISSUER,
          trustBoundary: omitTrustMetadata ? undefined : "external_signed_schema"
        },
        schemaContract: {
          output: {
            knownBuiltin: false,
            registered: true,
            trusted: true,
            signatureVerified: true
          }
        }
      });
    }

    if (call.url === `${API_BASE_URL}/jobs/validate-submission` && method === "POST") {
      if (call.body.submission.result === "pass") {
        return json({
          jobId: call.body.jobId,
          valid: true,
          submitSafe: true,
          schemaRef: SCHEMA_REF,
          normalizedSubmission: call.body.submission
        });
      }
      return json({
        jobId: call.body.jobId,
        valid: false,
        submitSafe: false,
        schemaRef: SCHEMA_REF,
        schemaValidates: "payload.submission",
        path: "payload.submission.result",
        message: "payload.submission.result must be one of pass, fail."
      });
    }

    return text(`unexpected ${method} ${call.url}`, 500);
  };

  return { fetch, calls };
}

function defaultAdminSession() {
  return {
    wallet: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
    roles: ["admin", "verifier"],
    capabilities: ["jobs:create", "ops:view"]
  };
}

function normalizeHeaders(headers = {}) {
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
}

function json(body, status = 200) {
  return {
    status,
    text: async () => JSON.stringify(body)
  };
}

function text(body, status = 200) {
  return {
    status,
    text: async () => body
  };
}

function normalizeJobIdForTest(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

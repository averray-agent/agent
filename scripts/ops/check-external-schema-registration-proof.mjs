#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_API_BASE_URL = "https://api.averray.com";
const DEFAULT_SCHEMA_REF = "schema://jobs/external-proof-output";
const DEFAULT_SCHEMA_URL = "https://schemas.example.com/jobs/external-proof-output.json";
const DEFAULT_ISSUER = "0xF4Bc6F29F319dE2e6A9197F3f214a3C4B6138BAB";
const DEFAULT_SIGNATURE =
  "0x20d903628ce5c56bf695875deac95b776dae5d0ccc7019acaf44ae6a16be2574575218a27db1d47a22144fa7303497ac63043cb88d603f1901a9d2ef47f3cd541b";
const SECRET_PATTERN = /Bearer\s+[^\s,}\]]+|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/u;

const EXTERNAL_SCHEMA = {
  $id: DEFAULT_SCHEMA_REF,
  type: "object",
  additionalProperties: false,
  required: ["summary", "result"],
  properties: {
    summary: { type: "string", minLength: 1 },
    result: { type: "string", enum: ["pass", "fail"] }
  }
};

const EXTERNAL_SCHEMA_REGISTRATION = {
  schemaRef: DEFAULT_SCHEMA_REF,
  schemaUrl: DEFAULT_SCHEMA_URL,
  schema: EXTERNAL_SCHEMA,
  issuer: DEFAULT_ISSUER,
  signedAt: "2026-05-23T00:00:00.000Z",
  signature: DEFAULT_SIGNATURE
};

export async function checkExternalSchemaRegistrationProof({
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log,
  now = () => new Date()
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this Node runtime.");
  }
  const adminToken = string(env.ADMIN_JWT);
  if (!adminToken) {
    throw new Error("CHECK_EXTERNAL_SCHEMA_PROOF=1 requires ADMIN_JWT.");
  }

  const apiBaseUrl = stripTrailingSlash(env.API_BASE_URL || DEFAULT_API_BASE_URL);
  const runStamp = `${now().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const jobId = string(env.EXTERNAL_SCHEMA_PROOF_JOB_ID) || `external-schema-proof-${runStamp}`;
  const idempotencyKey = string(env.EXTERNAL_SCHEMA_PROOF_IDEMPOTENCY_KEY) || `external-schema-proof:${jobId}`;
  const evidenceFile = string(env.EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE);

  const evidence = {
    proof: "external-schema-registration",
    apiBaseUrl,
    jobId,
    schemaRef: DEFAULT_SCHEMA_REF,
    schemaUrl: DEFAULT_SCHEMA_URL,
    issuer: DEFAULT_ISSUER,
    startedAt: now().toISOString()
  };

  log(`Checking admin schema-registration capability surface: ${apiBaseUrl}/auth/session`);
  const adminSession = await fetchJson(fetchImpl, `${apiBaseUrl}/auth/session`, {
    headers: bearer(adminToken)
  });
  assertRole(adminSession, "admin");
  assertCapability(adminSession, "jobs:create");
  evidence.admin = {
    wallet: adminSession.wallet,
    roles: Array.isArray(adminSession.roles) ? adminSession.roles : [],
    createCapabilityPresent: true
  };

  log(`Creating archived proof job ${jobId} with signed external schema ${DEFAULT_SCHEMA_REF}`);
  const created = await fetchJson(fetchImpl, `${apiBaseUrl}/admin/jobs`, {
    method: "POST",
    headers: {
      ...bearer(adminToken),
      "content-type": "application/json"
    },
    body: JSON.stringify(buildProofJob({ jobId, idempotencyKey, now: now() })),
    expectedStatus: 201
  });
  assert.equal(created.id, jobId);
  evidence.create = {
    status: 201,
    jobId: created.id,
    lifecycleStatus: created.lifecycle?.status
  };

  log("Checking public job definition exposes registered schema trust metadata");
  const definition = await fetchJson(fetchImpl, `${apiBaseUrl}/jobs/definition?jobId=${encodeURIComponent(jobId)}`);
  assert.equal(definition.id, jobId);
  assert.equal(definition.submissionContract?.registeredSchema, true);
  assert.equal(definition.submissionContract?.outputSchemaRef, DEFAULT_SCHEMA_REF);
  assert.equal(definition.submissionContract?.outputSchemaUrl, DEFAULT_SCHEMA_URL);
  assert.equal(definition.submissionContract?.schemaIssuer, DEFAULT_ISSUER);
  assert.equal(definition.submissionContract?.trustBoundary, "external_signed_schema");
  assert.equal(definition.schemaContract?.output?.knownBuiltin, false);
  assert.equal(definition.schemaContract?.output?.registered, true);
  assert.equal(definition.schemaContract?.output?.trusted, true);
  assert.equal(definition.schemaContract?.output?.signatureVerified, true);
  evidence.definition = {
    status: 200,
    registeredSchema: definition.submissionContract.registeredSchema,
    trustBoundary: definition.submissionContract.trustBoundary,
    schemaHashPresent: typeof definition.submissionContract.schemaHash === "string",
    outputRegistered: definition.schemaContract.output.registered,
    outputTrusted: definition.schemaContract.output.trusted,
    outputSignatureVerified: definition.schemaContract.output.signatureVerified
  };

  log("Checking valid external-schema submission passes validation");
  const valid = await validateSubmission(fetchImpl, { apiBaseUrl, jobId, submission: {
    summary: "External schema proof passed.",
    result: "pass"
  } });
  assert.equal(valid.valid, true);
  assert.equal(valid.submitSafe, true);
  assert.equal(valid.schemaRef, DEFAULT_SCHEMA_REF);
  assert.deepEqual(valid.normalizedSubmission, {
    summary: "External schema proof passed.",
    result: "pass"
  });
  evidence.validSubmission = {
    status: 200,
    valid: valid.valid,
    submitSafe: valid.submitSafe,
    schemaRef: valid.schemaRef
  };

  log("Checking invalid external-schema submission fails with a JSON path");
  const invalid = await validateSubmission(fetchImpl, { apiBaseUrl, jobId, submission: {
    summary: "External schema proof should fail.",
    result: "unknown"
  } });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.submitSafe, false);
  assert.equal(invalid.schemaRef, DEFAULT_SCHEMA_REF);
  assert.equal(invalid.schemaValidates, "payload.submission");
  assert.match(invalid.path ?? "", /^payload\.submission/u);
  evidence.invalidSubmission = {
    status: 200,
    valid: invalid.valid,
    submitSafe: invalid.submitSafe,
    path: invalid.path,
    message: invalid.message
  };

  evidence.completedAt = now().toISOString();
  evidence.status = "passed";
  assertNoSecrets(evidence);
  if (evidenceFile) {
    await writeEvidence(evidenceFile, evidence);
    log(`Wrote external-schema proof evidence to ${evidenceFile}`);
  }
  log("External-schema registration proof passed.");
  return evidence;
}

function buildProofJob({ jobId, idempotencyKey, now }) {
  const timestamp = now.toISOString();
  return {
    id: jobId,
    title: "Hosted external schema registration proof",
    category: "coding",
    tier: "starter",
    rewardAmount: 1,
    rewardAsset: "DOT",
    verifierMode: "benchmark",
    verifierTerms: ["pass"],
    verifierMinimumMatches: 1,
    outputSchemaRef: DEFAULT_SCHEMA_REF,
    schemaTrustPolicy: {
      trustedIssuers: [DEFAULT_ISSUER]
    },
    schemaRegistrations: [EXTERNAL_SCHEMA_REGISTRATION],
    lifecycle: {
      status: "archived",
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: timestamp,
      reason: "hosted external schema registration proof"
    },
    idempotencyKey
  };
}

async function validateSubmission(fetchImpl, { apiBaseUrl, jobId, submission }) {
  return fetchJson(fetchImpl, `${apiBaseUrl}/jobs/validate-submission`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify({ jobId, submission })
  });
}

async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchRaw(fetchImpl, url, options);
  const expectedStatus = options.expectedStatus ?? 200;
  if (response.status !== expectedStatus) {
    throw new Error(`${url} returned HTTP ${response.status}; expected ${expectedStatus}: ${truncate(response.text)}`);
  }
  try {
    return JSON.parse(response.text);
  } catch (error) {
    throw new Error(`${url} did not return valid JSON: ${error.message}`);
  }
}

async function fetchRaw(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, {
    method: options.method ?? "GET",
    headers: options.headers,
    body: options.body
  });
  return {
    status: response.status,
    text: await response.text()
  };
}

function bearer(token) {
  return {
    accept: "application/json",
    authorization: `Bearer ${token}`
  };
}

function assertCapability(session, capability) {
  const capabilities = Array.isArray(session?.capabilities) ? session.capabilities : [];
  assert.ok(capabilities.includes(capability), `admin token must include ${capability}`);
}

function assertRole(session, role) {
  const roles = Array.isArray(session?.roles) ? session.roles : [];
  assert.ok(roles.includes(role), `admin token must include ${role} role`);
}

async function writeEvidence(path, evidence) {
  await mkdir(dirname(path), { recursive: true });
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  assertNoSecrets(body);
  await writeFile(path, body);
}

function assertNoSecrets(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (SECRET_PATTERN.test(text)) {
    throw new Error("external-schema proof evidence contains token-shaped secret material.");
  }
}

function stripTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/u, "");
}

function string(value) {
  return String(value ?? "").trim();
}

function truncate(value, max = 400) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  checkExternalSchemaRegistrationProof().catch((error) => {
    console.error(error?.stack ?? error?.message ?? error);
    process.exitCode = 1;
  });
}

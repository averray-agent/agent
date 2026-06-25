import {
  EXTERNAL_SCHEMA_EIP712_VERSION,
  getRegisteredJobSchemaRegistration,
  hashExternalSchemaContent,
  normalizeExternalSchemaRegistrations,
  recoverExternalSchemaRegistrationSignerV1,
  validateAgainstSchema
} from "../core/job-schema-registry.js";
import { ExternalServiceError, ValidationError } from "../core/errors.js";
import { normalizeSubmission } from "../core/submission.js";
import { id } from "ethers";

export async function registerExternalSchema({
  schemaHash,
  schemaUrl,
  schemaIssuer,
  signature,
  jobId,
  chainId,
  verifyingContract,
  schemaRef = undefined,
  trustedIssuers = [],
  isTrustedIssuer = undefined,
  fetchImpl = globalThis.fetch
} = {}) {
  const schema = await fetchSchemaDocument(schemaUrl, { fetchImpl });
  const computedHash = hashExternalSchemaContent(schema);
  if (String(computedHash).toLowerCase() !== String(schemaHash ?? "").toLowerCase()) {
    throw new ValidationError("externalSchema.schemaHash does not match schemaUrl content.", {
      expected: schemaHash,
      actual: computedHash,
      schemaUrl
    });
  }

  const chainJobId = id(requireNonEmptyString(jobId, "externalSchema.jobId"));
  const recovered = recoverExternalSchemaRegistrationSignerV1({
    schemaHash: computedHash,
    schemaUrl,
    jobId: chainJobId,
    chainId,
    verifyingContract,
    signature
  });
  if (recovered.toLowerCase() !== String(schemaIssuer ?? "").toLowerCase()) {
    throw new ValidationError("externalSchema.signature does not match schemaIssuer.", {
      expected: schemaIssuer,
      actual: recovered
    });
  }

  const trusted = typeof isTrustedIssuer === "function"
    ? await isTrustedIssuer(recovered)
    : trustedIssuers.some((issuer) => String(issuer).toLowerCase() === recovered.toLowerCase());
  if (!trusted) {
    throw new ValidationError("externalSchema.schemaIssuer is not trusted.", {
      schemaIssuer: recovered
    });
  }

  const [registration] = normalizeExternalSchemaRegistrations([
    {
      schemaRef: schemaRef ?? schema.$id,
      schemaUrl,
      schema,
      schemaHash: computedHash,
      schemaIssuer: recovered,
      signature,
      jobId,
      chainJobId,
      chainId,
      verifyingContract,
      registrationVersion: EXTERNAL_SCHEMA_EIP712_VERSION
    }
  ], {
    allowedSchemaRefs: [schemaRef ?? schema.$id].filter(Boolean),
    trustedIssuers: [recovered]
  });
  return registration;
}

export async function validateSubmissionAgainstRegisteredSchema(
  submission,
  jobId,
  {
    schemaRef = undefined,
    registrations = [],
    fetchImpl = globalThis.fetch
  } = {}
) {
  const registration = selectRegistrationForJob({ jobId, schemaRef, registrations });
  if (!registration) {
    throw new ValidationError(`No registered external schema is available for job ${jobId}.`);
  }
  const schema = await fetchSchemaDocument(registration.schemaUrl, { fetchImpl });
  const computedHash = hashExternalSchemaContent(schema);
  if (computedHash.toLowerCase() !== String(registration.schemaHash).toLowerCase()) {
    throw new ValidationError("Registered external schema content hash mismatch.", {
      schemaUrl: registration.schemaUrl,
      expected: registration.schemaHash,
      actual: computedHash
    });
  }

  const normalized = submission?.kind === "structured" || submission?.kind === "text"
    ? submission
    : normalizeSubmission(submission);
  if (normalized.kind !== "structured") {
    throw new ValidationError("Registered external schema submissions must be structured JSON.");
  }
  validateAgainstSchema(normalized.structured, schema, "submission");
  return normalized;
}

async function fetchSchemaDocument(schemaUrl, { fetchImpl } = {}) {
  const url = requireHttpUrl(schemaUrl, "externalSchema.schemaUrl");
  if (typeof fetchImpl !== "function") {
    throw new ExternalServiceError("No fetch implementation available for external schema registration.");
  }
  let response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/schema+json, application/json" } });
  } catch (error) {
    throw new ExternalServiceError(`Failed to fetch external schema: ${error?.message ?? "fetch failed"}`);
  }
  if (!response?.ok) {
    throw new ExternalServiceError(`External schema fetch failed with HTTP ${response?.status ?? "unknown"}.`);
  }
  let schema;
  try {
    schema = await response.json();
  } catch (error) {
    throw new ValidationError(`External schema response is not JSON: ${error?.message ?? "invalid JSON"}`);
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new ValidationError("External schema response must be a JSON object.");
  }
  return schema;
}

function selectRegistrationForJob({ jobId, schemaRef, registrations }) {
  if (schemaRef) {
    const byRef = getRegisteredJobSchemaRegistration(schemaRef, registrations);
    if (byRef) return byRef;
  }
  const normalizedChainJobId = jobId ? id(String(jobId)) : undefined;
  return registrations.find((entry) =>
    entry?.registrationVersion === EXTERNAL_SCHEMA_EIP712_VERSION
      && (!normalizedChainJobId || entry.chainJobId === normalizedChainJobId || entry.jobId === jobId)
  );
}

function requireHttpUrl(value, field) {
  const text = requireNonEmptyString(value, field);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new ValidationError(`${field} must be an http(s) URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new ValidationError(`${field} must be an http(s) URL.`);
  }
  return parsed.toString();
}

function requireNonEmptyString(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new ValidationError(`${field} is required.`);
  }
  return text;
}

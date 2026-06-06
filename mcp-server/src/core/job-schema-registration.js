import { AbiCoder, getAddress, getBytes, id, isAddress, keccak256, toUtf8Bytes, verifyMessage } from "ethers";

import { canonicalizeContent, hashCanonicalContent } from "./canonical-content.js";
import { ValidationError } from "./errors.js";
import { isPlainObject } from "./job-schema-validation.js";

export const EXTERNAL_SCHEMA_TRUST_BOUNDARY = "external_signed_schema";
export const EXTERNAL_SCHEMA_EIP191_VERSION = "external-job-schema-eip191-v1";

const abiCoder = AbiCoder.defaultAbiCoder();

export function normalizeExternalSchemaRegistrations(raw, {
  allowedSchemaRefs = [],
  trustedIssuers = []
} = {}) {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new ValidationError("schemaRegistrations must be an array if provided.");
  }

  const allowedRefs = new Set(
    allowedSchemaRefs
      .map((entry) => normalizeJobSchemaRef(entry))
      .filter(Boolean)
  );
  const trustedIssuerSet = new Set(
    trustedIssuers
      .map((entry) => normalizeIssuerAddress(entry, "schemaTrustPolicy.trustedIssuers"))
      .filter(Boolean)
  );

  if (raw.length && trustedIssuerSet.size === 0) {
    throw new ValidationError("schemaTrustPolicy.trustedIssuers must include every external schema issuer.");
  }

  const seen = new Set();
  return raw.map((entry, index) => {
    const normalized = normalizeExternalSchemaRegistration(entry, { index });
    if (allowedRefs.size && !allowedRefs.has(normalized.schemaRef)) {
      throw new ValidationError(`schemaRegistrations[${index}].schemaRef must match the job inputSchemaRef or outputSchemaRef.`);
    }
    if (seen.has(normalized.schemaRef)) {
      throw new ValidationError(`Duplicate schema registration for ${normalized.schemaRef}.`);
    }
    seen.add(normalized.schemaRef);
    if (!trustedIssuerSet.has(normalized.issuer)) {
      throw new ValidationError(`External schema issuer is not trusted for ${normalized.schemaRef}.`);
    }
    return {
      ...normalized,
      trusted: true
    };
  });
}

export function normalizeExternalSchemaRegistration(raw, { index = 0 } = {}) {
  if (!isPlainObject(raw)) {
    throw new ValidationError(`schemaRegistrations[${index}] must be an object.`);
  }
  const prefix = `schemaRegistrations[${index}]`;
  const schema = cloneSchema(requirePlainObject(raw.schema, `${prefix}.schema`));
  if (raw.schemaHash !== undefined || raw.schemaIssuer !== undefined || raw.jobId !== undefined) {
    return normalizeExternalSchemaRegistrationV1(raw, { index, schema });
  }

  const schemaRef = requireJobSchemaRef(raw.schemaRef, `${prefix}.schemaRef`);
  const schemaUrl = requireNonEmptyString(raw.schemaUrl, `${prefix}.schemaUrl`);
  if (schema.$id !== schemaRef) {
    throw new ValidationError(`${prefix}.schema.$id must match ${schemaRef}.`);
  }
  assertSupportedExternalSchema(schema, `${prefix}.schema`);

  const issuer = normalizeIssuerAddress(raw.issuer, `${prefix}.issuer`);
  const signedAt = normalizeIsoTimestamp(raw.signedAt, `${prefix}.signedAt`);
  const expiresAt = raw.expiresAt === undefined || raw.expiresAt === null || raw.expiresAt === ""
    ? undefined
    : normalizeIsoTimestamp(raw.expiresAt, `${prefix}.expiresAt`);
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(signedAt)) {
    throw new ValidationError(`${prefix}.expiresAt must be after signedAt.`);
  }

  const signature = requireNonEmptyString(raw.signature, `${prefix}.signature`);
  const schemaHash = hashCanonicalContent(schema);
  const registration = {
    schemaRef,
    schemaUrl,
    schema,
    schemaHash,
    issuer,
    signedAt,
    ...(expiresAt ? { expiresAt } : {}),
    signature
  };
  const signingMessage = buildExternalSchemaRegistrationMessage(registration);
  const recovered = recoverExternalSchemaRegistrationSigner(registration);
  if (recovered !== issuer) {
    throw new ValidationError(`${prefix}.signature does not match issuer.`);
  }

  return {
    ...registration,
    registrationVersion: "external-job-schema-v1",
    trustBoundary: EXTERNAL_SCHEMA_TRUST_BOUNDARY,
    signatureVerified: true,
    registrationMessageHash: hashCanonicalContent(signingMessage)
  };
}

function normalizeExternalSchemaRegistrationV1(raw, { index, schema }) {
  const prefix = `schemaRegistrations[${index}]`;
  const schemaRef = requireJobSchemaRef(raw.schemaRef ?? schema.$id, `${prefix}.schemaRef`);
  const schemaUrl = requireNonEmptyString(raw.schemaUrl, `${prefix}.schemaUrl`);
  if (schema.$id !== schemaRef) {
    throw new ValidationError(`${prefix}.schema.$id must match ${schemaRef}.`);
  }
  assertSupportedExternalSchema(schema, `${prefix}.schema`);

  const schemaHash = normalizeBytes32(raw.schemaHash ?? hashExternalSchemaContent(schema), `${prefix}.schemaHash`);
  const computedHash = hashExternalSchemaContent(schema);
  if (schemaHash.toLowerCase() !== computedHash.toLowerCase()) {
    throw new ValidationError(`${prefix}.schemaHash does not match fetched schema content.`);
  }
  const issuer = normalizeIssuerAddress(raw.schemaIssuer ?? raw.issuer, `${prefix}.schemaIssuer`);
  const jobId = requireNonEmptyString(raw.jobId, `${prefix}.jobId`);
  const chainJobId = normalizeBytes32(raw.chainJobId ?? id(jobId), `${prefix}.chainJobId`);
  const signature = requireNonEmptyString(raw.schemaSignature ?? raw.signature, `${prefix}.signature`);
  const recovered = recoverExternalSchemaRegistrationSignerV1({
    schemaHash,
    schemaUrl,
    jobId: chainJobId,
    signature
  });
  if (recovered !== issuer) {
    throw new ValidationError(`${prefix}.signature does not match schemaIssuer.`);
  }

  return {
    schemaRef,
    schemaUrl,
    schema,
    schemaHash,
    issuer,
    schemaIssuer: issuer,
    jobId,
    chainJobId,
    signature,
    registrationVersion: EXTERNAL_SCHEMA_EIP191_VERSION,
    trustBoundary: EXTERNAL_SCHEMA_TRUST_BOUNDARY,
    signatureVerified: true,
    registrationMessageHash: buildExternalSchemaRegistrationDigest({ schemaHash, schemaUrl, jobId: chainJobId })
  };
}

export function hashExternalSchemaContent(schema) {
  return keccak256(toUtf8Bytes(canonicalizeContent(requirePlainObject(schema, "schema"))));
}

export function buildExternalSchemaRegistrationDigest({ schemaHash, schemaUrl, jobId }) {
  return keccak256(abiCoder.encode(
    ["bytes32", "string", "bytes32"],
    [
      normalizeBytes32(schemaHash, "schemaHash"),
      requireNonEmptyString(schemaUrl, "schemaUrl"),
      normalizeBytes32(jobId, "jobId")
    ]
  ));
}

export function recoverExternalSchemaRegistrationSignerV1({ schemaHash, schemaUrl, jobId, signature }) {
  const digest = buildExternalSchemaRegistrationDigest({ schemaHash, schemaUrl, jobId });
  try {
    return getAddress(verifyMessage(getBytes(digest), requireNonEmptyString(signature, "signature")));
  } catch (error) {
    throw new ValidationError(`External schema signature verification failed: ${error?.message ?? "invalid signature"}`);
  }
}

export function buildExternalSchemaRegistrationMessage(registration) {
  const schemaRef = requireJobSchemaRef(registration?.schemaRef, "schemaRef");
  const schemaHash = typeof registration?.schemaHash === "string" && registration.schemaHash.trim()
    ? registration.schemaHash.trim()
    : hashCanonicalContent(requirePlainObject(registration?.schema, "schema"));
  const payload = {
    version: "external-job-schema-v1",
    schemaRef,
    schemaUrl: requireNonEmptyString(registration?.schemaUrl, "schemaUrl"),
    schemaHash,
    issuer: normalizeIssuerAddress(registration?.issuer, "issuer"),
    signedAt: normalizeIsoTimestamp(registration?.signedAt, "signedAt"),
    ...(registration?.expiresAt ? { expiresAt: normalizeIsoTimestamp(registration.expiresAt, "expiresAt") } : {})
  };
  return `Averray external job schema registration\n${canonicalizeContent(payload)}`;
}

export function recoverExternalSchemaRegistrationSigner(registration) {
  const message = buildExternalSchemaRegistrationMessage(registration);
  try {
    return getAddress(verifyMessage(message, registration.signature));
  } catch (error) {
    throw new ValidationError(`External schema signature verification failed: ${error?.message ?? "invalid signature"}`);
  }
}

export function normalizeJobSchemaRef(schemaRef) {
  if (typeof schemaRef !== "string") {
    return undefined;
  }
  const trimmed = schemaRef.trim();
  return /^schema:\/\/jobs\/[a-z0-9-]+$/u.test(trimmed) ? trimmed : undefined;
}

function requireJobSchemaRef(value, field) {
  const ref = normalizeJobSchemaRef(value);
  if (!ref) {
    throw new ValidationError(`${field} must be a schema://jobs/<name> ref.`);
  }
  return ref;
}

function requireNonEmptyString(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new ValidationError(`${field} is required.`);
  }
  return text;
}

function requirePlainObject(value, field) {
  if (!isPlainObject(value)) {
    throw new ValidationError(`${field} must be an object.`);
  }
  return value;
}

function normalizeIsoTimestamp(value, field) {
  const text = requireNonEmptyString(value, field);
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new ValidationError(`${field} must be ISO-8601.`);
  }
  return new Date(parsed).toISOString();
}

function normalizeIssuerAddress(value, field) {
  const text = requireNonEmptyString(value, field);
  if (!isAddress(text)) {
    throw new ValidationError(`${field} must be an EVM address.`);
  }
  return getAddress(text);
}

function normalizeBytes32(value, field) {
  const text = requireNonEmptyString(value, field);
  if (!/^0x[a-fA-F0-9]{64}$/u.test(text)) {
    throw new ValidationError(`${field} must be a bytes32 hex string.`);
  }
  return text;
}

function assertSupportedExternalSchema(schema, path) {
  if (!isPlainObject(schema)) {
    throw new ValidationError(`${path} must be an object.`);
  }
  const type = schema.type;
  if (!["object", "array", "string", "number", "integer", "boolean"].includes(type)) {
    throw new ValidationError(`${path}.type is not supported for external schema validation.`);
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schema.required.every((entry) => typeof entry === "string" && entry.trim())) {
      throw new ValidationError(`${path}.required must be an array of field names.`);
    }
  }
  if (type === "object") {
    const properties = schema.properties ?? {};
    if (!isPlainObject(properties)) {
      throw new ValidationError(`${path}.properties must be an object.`);
    }
    for (const key of schema.required ?? []) {
      if (!(key in properties)) {
        throw new ValidationError(`${path}.required references unknown property ${key}.`);
      }
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
      throw new ValidationError(`${path}.additionalProperties must be boolean when provided.`);
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      assertSupportedExternalSchema(propertySchema, `${path}.properties.${key}`);
    }
  }
  if (type === "array") {
    assertSupportedExternalSchema(schema.items ?? {}, `${path}.items`);
  }
  if (Array.isArray(schema.enum)) {
    const enumTypeOk = schema.enum.every((entry) => {
      if (type === "integer") return Number.isInteger(entry);
      if (type === "number") return Number.isFinite(entry);
      return typeof entry === type;
    });
    if (!enumTypeOk) {
      throw new ValidationError(`${path}.enum values must match ${type}.`);
    }
  }
}

function cloneSchema(schema) {
  return JSON.parse(JSON.stringify(schema));
}

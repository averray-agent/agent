import { AppError, ConflictError, NotFoundError, ValidationError } from "../core/errors.js";
import { AUTO_DECIDABLE_MODES } from "./submitted-job-auto-verifier.js";

export const VERIFY_PROFILE_PRICE = Object.freeze({
  amount: "5",
  amountRaw: "5000000",
  asset: "USDC",
  decimals: 6,
  network: "eip155:8453",
  billingRule: "inconclusive_not_billed"
});

export const VERIFY_INCONCLUSIVE_REASONS = Object.freeze([
  "target_unreachable",
  "flaky",
  "ambiguous_evidence",
  "runner_fault"
]);

export const GIT_PATCH_TESTS_PROFILE_REF = "git-patch-tests-v1@1";
export const MCP_FAILURE_SEMANTICS_PROFILE_REF = "mcp-failure-semantics-v1@1";
export const STRUCTURED_OUTPUT_EVIDENCE_PROFILE_REF = "structured-output-evidence-v1@1";

export const MCP_FAILURE_SEMANTICS_CHECKS = Object.freeze([
  "auth-boundary",
  "timeout-recovery",
  "tool-schema-stability",
  "destructive-action-safety",
  "error-shape-conformance"
]);

export const STRUCTURED_OUTPUT_EVIDENCE_CHECKS = Object.freeze([
  "output-integrity",
  "schema-valid",
  "schema-conformance",
  "citation-resolution",
  "quote-support"
]);

export const STRUCTURED_OUTPUT_EVIDENCE_OUTPUTS = Object.freeze({
  "output-integrity": "structured_output_integrity_pass",
  "schema-valid": "structured_schema_valid_pass",
  "schema-conformance": "structured_schema_conformance_pass",
  "citation-resolution": "structured_citation_resolution_pass",
  "quote-support": "structured_quote_support_pass"
});

const GIT_ARTIFACT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["sha256", "bytes", "locator", "format"],
  properties: {
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    bytes: { type: "integer", minimum: 1 },
    locator: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "url"],
      properties: {
        kind: { type: "string", enum: ["https"] },
        url: { type: "string", pattern: "^https://" }
      }
    },
    format: { type: "string" }
  }
});

const GIT_PATCH_TESTS_V1 = {
  name: "git-patch-tests-v1",
  version: 1,
  handler: "deterministic",
  handlerVersion: 1,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["target", "inputs"],
    properties: {
      target: {
        type: "object",
        additionalProperties: false,
        required: ["repository", "commit"],
        properties: {
          repository: { type: "string", minLength: 1, maxLength: 500 },
          commit: { type: "string", pattern: "^[a-f0-9]{40}$" }
        }
      },
      inputs: {
        type: "object",
        additionalProperties: false,
        required: ["gitBundle", "patch", "testCommand"],
        properties: {
          gitBundle: { ...GIT_ARTIFACT_SCHEMA, properties: { ...GIT_ARTIFACT_SCHEMA.properties, format: { type: "string", enum: ["git-bundle"] } } },
          patch: { ...GIT_ARTIFACT_SCHEMA, properties: { ...GIT_ARTIFACT_SCHEMA.properties, format: { type: "string", enum: ["file"] } } },
          testCommand: {
            type: "array",
            minItems: 1,
            maxItems: 32,
            items: { type: "string", minLength: 1, maxLength: 500 }
          },
          workingDirectory: { type: "string", default: "." },
          allowedPaths: { type: "array", items: { type: "string", minLength: 1 }, default: ["**"] },
          protectedPaths: { type: "array", items: { type: "string", minLength: 1 }, default: [] },
          maximumChangedFiles: { type: "integer", minimum: 1, maximum: 500, default: 100 }
        }
      }
    }
  },
  successCriteria: {
    statement: "The pinned source fails the requested test before the patch and passes it after the patch, under the bounded offline Witness runner.",
    requiredEvidence: ["source_binding_verified", "tests_passed"]
  },
  limits: {
    timeoutMs: 120_000,
    sizeBytes: 25 * 1024 * 1024,
    cpuLimit: 2,
    memoryMb: 4096,
    processLimit: 512,
    temporaryStorageMb: 1024,
    outputLimitBytes: 10 * 1024 * 1024
  },
  price: VERIFY_PROFILE_PRICE,
  replayFixtureRef: "services/__fixtures__/verifier-replay/deterministic/v1/release-readiness.json",
  status: "published",
  verifierConfig: {
    version: 1,
    handler: "deterministic",
    expectedOutputs: ["source_binding_verified", "tests_passed"],
    matchMode: "contains_all"
  }
};

const MCP_FAILURE_SEMANTICS_V1 = {
  name: "mcp-failure-semantics-v1",
  version: 1,
  handler: "deterministic",
  handlerVersion: 1,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["target", "inputs"],
    properties: {
      target: {
        type: "object",
        additionalProperties: false,
        required: ["endpoint", "transport"],
        properties: {
          endpoint: { type: "string", pattern: "^(?:https|wss)://", maxLength: 2_048 },
          transport: { type: "string", enum: ["streamable_http", "websocket"] },
          auth: {
            type: "object",
            additionalProperties: false,
            required: ["scheme"],
            properties: {
              scheme: { type: "string", enum: ["bearer"] },
              credentialRef: { type: "string", minLength: 1, maxLength: 200 }
            }
          }
        }
      },
      inputs: {
        type: "object",
        additionalProperties: false,
        properties: {}
      }
    }
  },
  successCriteria: {
    statement: "The declared endpoint passed each named mcp-failure-semantics-v1@1 check during one bounded observation. This is not a certification or blanket security claim.",
    requiredEvidence: MCP_FAILURE_SEMANTICS_CHECKS.map((name) => `mcp_${name.replaceAll("-", "_")}_pass`)
  },
  limits: {
    timeoutMs: 30_000,
    sizeBytes: 64 * 1024,
    cpuLimit: 1,
    memoryMb: 256,
    processLimit: 64,
    temporaryStorageMb: 16,
    outputLimitBytes: 512 * 1024
  },
  price: VERIFY_PROFILE_PRICE,
  replayFixtureRef: "services/__fixtures__/mcp-failure-semantics-v1-known-good.json",
  status: "published",
  verifierConfig: {
    version: 1,
    handler: "deterministic",
    expectedOutputs: MCP_FAILURE_SEMANTICS_CHECKS.map((name) => `mcp_${name.replaceAll("-", "_")}_pass`),
    matchMode: "contains_all"
  }
};

const STRUCTURED_OUTPUT_EVIDENCE_V1 = {
  name: "structured-output-evidence-v1",
  version: 1,
  handler: "deterministic",
  handlerVersion: 1,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["target", "inputs"],
    properties: {
      target: {
        type: "object",
        additionalProperties: false,
        required: ["output", "schema", "sources"],
        properties: {
          output: artifactSchema({ formats: ["json"] }),
          schema: artifactSchema({ formats: ["json"] }),
          sources: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: artifactSchema({ formats: ["text", "markdown", "json"] })
          }
        }
      },
      inputs: {
        type: "object",
        additionalProperties: false,
        properties: {
          citationsPointer: {
            type: "string",
            maxLength: 256,
            pattern: "^(?:|(?:/(?:[^~/]|~[01])*)+)$"
          }
        }
      }
    }
  },
  successCriteria: {
    statement: "The output document parsed as JSON, validated against the declared schema, and every cited quote appears verbatim (whitespace-normalized) in its referenced source artifact during one bounded check. Verbatim presence is not an assessment that the sources semantically support the claims, and this is not a certification.",
    requiredEvidence: STRUCTURED_OUTPUT_EVIDENCE_CHECKS.map(
      (name) => STRUCTURED_OUTPUT_EVIDENCE_OUTPUTS[name]
    )
  },
  limits: {
    timeoutMs: 30_000,
    sizeBytes: 8_388_608,
    outputSizeBytes: 1_048_576,
    schemaSizeBytes: 262_144,
    sourceSizeBytes: 2_097_152,
    schemaDepth: 32,
    cpuLimit: 1,
    memoryMb: 256,
    processLimit: 64,
    temporaryStorageMb: 32,
    outputLimitBytes: 512 * 1024
  },
  price: VERIFY_PROFILE_PRICE,
  replayFixtureRef: "services/__fixtures__/structured-output-evidence-v1-known-good.json",
  status: "published",
  verifierConfig: {
    version: 1,
    handler: "deterministic",
    expectedOutputs: STRUCTURED_OUTPUT_EVIDENCE_CHECKS.map(
      (name) => STRUCTURED_OUTPUT_EVIDENCE_OUTPUTS[name]
    ),
    matchMode: "contains_all",
    citationContract: {
      pointerSyntax: "RFC 6901",
      defaultPointer: "/citations",
      array: "non_empty",
      entry: { source: "zero_based_source_index", quote: "string_1_to_2048_characters" }
    },
    quoteNormalization: {
      whitespace: "trim_then_collapse_runs_to_single_ascii_space",
      caseFolding: false,
      fuzzyMatching: false
    }
  }
};

export class VerificationProfileRegistry {
  constructor({
    profiles = [GIT_PATCH_TESTS_V1, MCP_FAILURE_SEMANTICS_V1, STRUCTURED_OUTPUT_EVIDENCE_V1],
    autoDecidableModes = AUTO_DECIDABLE_MODES,
    availabilityByProfile = {}
  } = {}) {
    this.autoDecidableModes = new Set(autoDecidableModes);
    this.profiles = new Map();
    this.availabilityByProfile = new Map();
    for (const profile of profiles) this.publish(profile);
    for (const [ref, availability] of Object.entries(availabilityByProfile)) {
      if (this.profiles.has(ref)) this.availabilityByProfile.set(ref, normalizeAvailability(availability));
    }
  }

  publish(candidate) {
    const profile = normalizeProfile(candidate);
    if (!this.autoDecidableModes.has(profile.handler)) {
      throw new ValidationError(
        `Verification profile handler ${profile.handler} is not in the frozen auto-decidable mode set.`
      );
    }
    const ref = profileRef(profile.name, profile.version);
    if (this.profiles.has(ref)) {
      throw new ConflictError(
        `Verification profile ${ref} is already published and cannot be changed. Publish a new version instead.`,
        "verification_profile_immutable"
      );
    }
    const published = deepFreeze(structuredClone({ ...profile, ref }));
    this.profiles.set(ref, published);
    return published;
  }

  get(name, version) {
    const ref = profileRef(name, version);
    const profile = this.profiles.get(ref);
    if (!profile) {
      throw new NotFoundError(`Verification profile ${ref} was not found.`, "verification_profile_not_found");
    }
    return profile;
  }

  requireAvailable(name, version) {
    const profile = this.get(name, version);
    const availability = this.availability(profile.ref);
    if (availability.status !== "available") {
      throw new AppError(
        `Verification profile ${profile.ref} is temporarily unavailable: ${availability.reason}`,
        {
          name: "VerificationProfileUnavailableError",
          code: "verification_profile_unavailable",
          statusCode: 503,
          details: { profile: profile.ref, ...availability }
        }
      );
    }
    return profile;
  }

  availability(ref) {
    return this.availabilityByProfile.get(ref) ?? AVAILABLE;
  }

  list() {
    return [...this.profiles.values()].map((profile) => deepFreeze(structuredClone({
      ...profile,
      availability: this.availability(profile.ref)
    })));
  }
}

function artifactSchema({ formats }) {
  return {
    ...GIT_ARTIFACT_SCHEMA,
    properties: {
      ...GIT_ARTIFACT_SCHEMA.properties,
      format: { type: "string", enum: formats }
    }
  };
}

const AVAILABLE = deepFreeze({ status: "available" });

export function profileRef(name, version) {
  const normalizedName = String(name ?? "").trim();
  const normalizedVersion = Number(version);
  if (!normalizedName || !Number.isInteger(normalizedVersion) || normalizedVersion <= 0) {
    throw new ValidationError("Verification profile name and positive integer version are required.");
  }
  return `${normalizedName}@${normalizedVersion}`;
}

function normalizeProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new ValidationError("Verification profile must be an object.");
  }
  const version = Number(profile.version);
  const handlerVersion = Number(profile.handlerVersion);
  if (!String(profile.name ?? "").trim() || !String(profile.handler ?? "").trim()) {
    throw new ValidationError("Verification profile name and handler are required.");
  }
  if (!Number.isInteger(version) || version <= 0 || !Number.isInteger(handlerVersion) || handlerVersion <= 0) {
    throw new ValidationError("Verification profile and handler versions must be positive integers.");
  }
  if (profile.status !== "published") {
    throw new ValidationError("Only published verification profiles may enter the public registry.");
  }
  return { ...profile, name: profile.name.trim(), handler: profile.handler.trim(), version, handlerVersion };
}

function normalizeAvailability(value) {
  if (value?.status === "available") return AVAILABLE;
  const reasonCode = String(value?.reasonCode ?? "verification_profile_dependency_unavailable").trim();
  const reason = String(value?.reason ?? "A required verification dependency is unavailable.").trim();
  return deepFreeze({ status: "unavailable", reasonCode, reason });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

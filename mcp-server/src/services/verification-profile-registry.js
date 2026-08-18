import { ConfigError, ValidationError } from "../core/errors.js";
import { AUTO_DECIDABLE_MODES } from "./submitted-job-auto-verifier.js";

export const VERIFY_PRICE_RAW = "5000000";
export const VERIFY_PRICE_USDC = "5";
export const VERIFY_PAYMENT_NETWORK = "eip155:8453";

const GIT_ARTIFACT_SCHEMA = Object.freeze({
  type: "object",
  required: ["sha256", "bytes", "locator", "format"],
  properties: {
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    bytes: { type: "integer", minimum: 1 },
    locator: {
      type: "object",
      required: ["kind", "url"],
      properties: {
        kind: { const: "https" },
        url: { type: "string", format: "uri", pattern: "^https://" }
      },
      additionalProperties: false
    },
    format: { type: "string" }
  },
  additionalProperties: false
});

const GIT_PATCH_TESTS_V1 = {
  name: "git-patch-tests-v1",
  version: 1,
  handler: "deterministic",
  handlerVersion: 1,
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["target", "inputs"],
    properties: {
      target: {
        type: "object",
        required: ["repository", "commit"],
        properties: {
          repository: { type: "string", minLength: 1 },
          commit: { type: "string", pattern: "^[a-f0-9]{40}$" }
        },
        additionalProperties: false
      },
      inputs: {
        type: "object",
        required: ["bundle", "patch", "testCommand"],
        properties: {
          bundle: { ...GIT_ARTIFACT_SCHEMA, properties: {
            ...GIT_ARTIFACT_SCHEMA.properties,
            format: { const: "git-bundle" }
          } },
          patch: { ...GIT_ARTIFACT_SCHEMA, properties: {
            ...GIT_ARTIFACT_SCHEMA.properties,
            format: { const: "file" }
          } },
          testCommand: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 }
          },
          workingDirectory: { type: "string", default: "." },
          allowedPaths: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
            default: ["**"]
          },
          protectedPaths: {
            type: "array",
            items: { type: "string", minLength: 1 },
            default: []
          },
          maximumChangedFiles: { type: "integer", minimum: 1, maximum: 1000, default: 250 }
        },
        additionalProperties: false
      }
    },
    additionalProperties: false
  },
  successCriteria: "The pinned test command fails on the supplied base commit and passes after the supplied patch, with source binding and integrity checks satisfied.",
  limits: {
    timeout: 300,
    size: 10 * 1024 * 1024
  },
  price: {
    asset: "USDC",
    amount: VERIFY_PRICE_USDC,
    amountRaw: VERIFY_PRICE_RAW,
    network: VERIFY_PAYMENT_NETWORK,
    billing: "conclusive_only",
    inconclusive: "not_billed"
  },
  replayFixtureRef: "services/__fixtures__/verifier-replay/deterministic/v1/release-readiness.json",
  status: "published"
};

export class VerificationProfileRegistry {
  constructor({ profiles = [GIT_PATCH_TESTS_V1] } = {}) {
    this.profiles = new Map();
    for (const profile of profiles) this.publish(profile);
  }

  publish(profile) {
    assertProfile(profile);
    const key = profileKey(profile.name, profile.version);
    if (this.profiles.has(key)) {
      throw new ValidationError(
        `Verification profile ${key} is already published and immutable; publish a new version.`
      );
    }
    const stored = deepFreeze(structuredClone(profile));
    this.profiles.set(key, stored);
    return structuredClone(stored);
  }

  get(name, version) {
    const resolvedVersion = version ?? latestVersion(this.profiles, name);
    const profile = this.profiles.get(profileKey(name, resolvedVersion));
    return profile ? structuredClone(profile) : undefined;
  }

  list() {
    return [...this.profiles.values()]
      .sort((left, right) => left.name.localeCompare(right.name) || left.version - right.version)
      .map((profile) => structuredClone(profile));
  }
}

function assertProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new ConfigError("Verification profile must be an object.");
  }
  if (typeof profile.name !== "string" || !profile.name.trim()) {
    throw new ConfigError("Verification profile requires a name.");
  }
  if (!Number.isInteger(profile.version) || profile.version <= 0) {
    throw new ConfigError("Verification profile requires a positive integer version.");
  }
  if (!AUTO_DECIDABLE_MODES.includes(profile.handler)) {
    throw new ConfigError(
      `Verification profile handler ${JSON.stringify(profile.handler)} is outside frozen AUTO_DECIDABLE_MODES.`
    );
  }
  if (!Number.isInteger(profile.handlerVersion) || profile.handlerVersion <= 0) {
    throw new ConfigError("Verification profile requires a positive handlerVersion.");
  }
  if (profile.status !== "published") {
    throw new ConfigError("Only published verification profiles may enter the public registry.");
  }
}

function profileKey(name, version) {
  return `${String(name ?? "").trim()}@${Number(version)}`;
}

function latestVersion(profiles, name) {
  const prefix = `${String(name ?? "").trim()}@`;
  const versions = [...profiles.keys()]
    .filter((key) => key.startsWith(prefix))
    .map((key) => Number(key.slice(prefix.length)))
    .filter(Number.isInteger);
  return versions.length > 0 ? Math.max(...versions) : NaN;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

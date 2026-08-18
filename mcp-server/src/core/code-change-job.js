import { hashCanonicalContent } from "./canonical-content.js";
import { ValidationError } from "./errors.js";

export const CODE_CHANGE_JOB_SCHEMA_VERSION = "averray.code-change-job/v1";
export const FROZEN_CONTRACT_DIGEST_ALGORITHM = "sha256:averray-canonical-json-v1";
export const PATCH_SUBMISSION_OUTPUT_SCHEMA_REF = "schema://jobs/patch-submission-output";

const SHA256 = /^[a-f0-9]{64}$/u;
const CONTENT_DIGEST = /^0x[a-f0-9]{64}$/u;
const GIT_COMMIT = /^[a-f0-9]{40}$/u;
const ASSURANCE_LEVEL = /^AV-(\d+)$/u;
const PREFLIGHT_RESULTS = new Set(["EXECUTABLE", "PARTIALLY_EXECUTABLE"]);
const MATERIALIZATION_RESULTS = Object.freeze({
  HERMETIC: "EXECUTABLE",
  FROZEN_DEPENDENCIES: "EXECUTABLE",
  MOCKED_EXTERNAL_SYSTEM: "PARTIALLY_EXECUTABLE"
});

export function hashFrozenVerificationContract(contract) {
  return hashCanonicalContent(contract).toLowerCase();
}

export function normalizeCodeChangeDefinition(value, { expectedJobId } = {}) {
  const path = "codeChange";
  assertRecord(value, path);
  assertOnlyKeys(value, [
    "schemaVersion",
    "contractState",
    "contractDigest",
    "contractDigestAlgorithm",
    "contract",
    "preflight",
    "freeze"
  ], path);

  if (value.schemaVersion !== CODE_CHANGE_JOB_SCHEMA_VERSION) {
    throw new ValidationError(`${path}.schemaVersion must be ${CODE_CHANGE_JOB_SCHEMA_VERSION}.`);
  }
  if (value.contractState !== "frozen") {
    throw new ValidationError(`${path}.contractState must be frozen before publication.`);
  }
  if (value.contractDigestAlgorithm !== FROZEN_CONTRACT_DIGEST_ALGORITHM) {
    throw new ValidationError(
      `${path}.contractDigestAlgorithm must be ${FROZEN_CONTRACT_DIGEST_ALGORITHM}.`
    );
  }
  if (!CONTENT_DIGEST.test(value.contractDigest ?? "")) {
    throw new ValidationError(`${path}.contractDigest must be a 0x-prefixed SHA-256 digest.`);
  }

  // Full schema and freeze-rule validation belongs to the Witness creation
  // pipeline. Keep this synchronous catalogue boundary independent of the
  // optional Witness runtime while reproducing the digest and checking every
  // field that makes a code_change job safe to advertise.
  const contract = clone(value.contract);
  validateContractProjection(contract, { expectedJobId, path: `${path}.contract` });
  const reproducedDigest = hashFrozenVerificationContract(contract);
  if (reproducedDigest !== value.contractDigest) {
    throw new ValidationError(
      `${path}.contractDigest does not match the frozen contract.`,
      { expected: reproducedDigest, actual: value.contractDigest }
    );
  }

  const preflight = normalizePreflight(value.preflight, contract, `${path}.preflight`);
  const freeze = normalizeFreeze(value.freeze, contract, `${path}.freeze`);
  return {
    schemaVersion: CODE_CHANGE_JOB_SCHEMA_VERSION,
    contractState: "frozen",
    contractDigest: reproducedDigest,
    contractDigestAlgorithm: FROZEN_CONTRACT_DIGEST_ALGORITHM,
    contract,
    preflight,
    freeze
  };
}

function validateContractProjection(contract, { expectedJobId, path }) {
  assertRecord(contract, path);
  if (contract.schema_version !== "averray.verification-contract/v1.1") {
    throw new ValidationError(`${path}.schema_version must be averray.verification-contract/v1.1.`);
  }
  assertRecord(contract.job, `${path}.job`);
  if (contract.job.type !== "code_change") {
    throw new ValidationError(`${path}.job.type must be code_change.`);
  }
  if (expectedJobId && contract.job.id !== expectedJobId) {
    throw new ValidationError(`${path}.job.id must match the published job id ${expectedJobId}.`);
  }
  assertAssuranceFloor(contract.job.required_verification_level, `${path}.job.required_verification_level`);

  assertRecord(contract.subject, `${path}.subject`);
  assertRecord(contract.subject.acquisition, `${path}.subject.acquisition`);
  if (!GIT_COMMIT.test(contract.subject.acquisition.base_commit ?? "")) {
    throw new ValidationError(`${path}.subject.acquisition.base_commit must be a lowercase Git commit.`);
  }
  assertArtifact(
    contract.subject.acquisition.git_bundle,
    `${path}.subject.acquisition.git_bundle`,
    "git-bundle",
    { requireHttps: true }
  );
  assertRecord(contract.subject.materialization, `${path}.subject.materialization`);
  if (!MATERIALIZATION_RESULTS[contract.subject.materialization.status]) {
    throw new ValidationError(
      `${path}.subject.materialization.status must be HERMETIC, FROZEN_DEPENDENCIES, or MOCKED_EXTERNAL_SYSTEM.`
    );
  }
  if (contract.subject.materialization.dependency_cache) {
    assertArtifact(
      contract.subject.materialization.dependency_cache.artifact,
      `${path}.subject.materialization.dependency_cache.artifact`,
      undefined,
      { requireHttps: true }
    );
  }
  if (!Array.isArray(contract.subject.materialization.frozen_inputs)) {
    throw new ValidationError(`${path}.subject.materialization.frozen_inputs must be an array.`);
  }
  contract.subject.materialization.frozen_inputs.forEach((input, index) => {
    assertArtifact(
      input.artifact,
      `${path}.subject.materialization.frozen_inputs[${index}].artifact`,
      undefined,
      { requireHttps: true }
    );
  });

  assertRecord(contract.candidate, `${path}.candidate`);
  assertNonEmptyStringArray(contract.candidate.protected_paths, `${path}.candidate.protected_paths`);

  assertRecord(contract.checks, `${path}.checks`);
  assertRecord(contract.checks.hidden, `${path}.checks.hidden`);
  if (contract.checks.hidden.required !== true) {
    throw new ValidationError(`${path}.checks.hidden.required must be true for a supplied failing test.`);
  }
  if (contract.checks.hidden.expected_on_base !== "fail" ||
      contract.checks.hidden.expected_on_candidate !== "pass") {
    throw new ValidationError(
      `${path}.checks.hidden must declare fail on base and pass on candidate.`
    );
  }
  assertArtifact(
    contract.checks.hidden.artifact,
    `${path}.checks.hidden.artifact`,
    "file",
    { requireHttps: true }
  );

  assertRecord(contract.settlement, `${path}.settlement`);
  assertAssuranceFloor(
    contract.settlement.minimum_assurance_level,
    `${path}.settlement.minimum_assurance_level`
  );
}

function normalizePreflight(value, contract, path) {
  assertRecord(value, path);
  assertOnlyKeys(value, ["result", "materializationStatus", "reports"], path);
  if (!PREFLIGHT_RESULTS.has(value.result)) {
    throw new ValidationError(`${path}.result must be EXECUTABLE or PARTIALLY_EXECUTABLE.`);
  }
  const declaredStatus = contract.subject.materialization.status;
  if (value.materializationStatus !== declaredStatus) {
    throw new ValidationError(`${path}.materializationStatus must match the frozen contract.`);
  }
  if (MATERIALIZATION_RESULTS[declaredStatus] !== value.result) {
    throw new ValidationError(`${path}.result is inconsistent with ${declaredStatus}.`);
  }
  if (!Array.isArray(value.reports) || value.reports.length === 0) {
    throw new ValidationError(`${path}.reports must contain at least one executed preflight.`);
  }
  const reports = value.reports.map((report, index) => {
    const reportPath = `${path}.reports[${index}]`;
    assertRecord(report, reportPath);
    assertOnlyKeys(report, ["checkId", "checkKind", "classification", "baseOutcome"], reportPath);
    assertNonEmptyString(report.checkId, `${reportPath}.checkId`);
    if (!["targeted", "regression", "materialization"].includes(report.checkKind)) {
      throw new ValidationError(`${reportPath}.checkKind is unsupported.`);
    }
    if (!MATERIALIZATION_RESULTS[report.classification]) {
      throw new ValidationError(`${reportPath}.classification is not publishable.`);
    }
    if (!["pass", "fail"].includes(report.baseOutcome)) {
      throw new ValidationError(`${reportPath}.baseOutcome must be pass or fail.`);
    }
    return clone(report);
  });
  return { result: value.result, materializationStatus: declaredStatus, reports };
}

function normalizeFreeze(value, contract, path) {
  assertRecord(value, path);
  assertOnlyKeys(value, ["validated", "baselineDifferentials"], path);
  if (value.validated !== true) {
    throw new ValidationError(`${path}.validated must be true.`);
  }
  if (!Array.isArray(value.baselineDifferentials) || value.baselineDifferentials.length === 0) {
    throw new ValidationError(`${path}.baselineDifferentials must contain observed freeze evidence.`);
  }
  const differentials = value.baselineDifferentials.map((entry, index) => {
    const entryPath = `${path}.baselineDifferentials[${index}]`;
    assertRecord(entry, entryPath);
    assertOnlyKeys(entry, ["id", "kind", "expected", "outcome"], entryPath);
    assertNonEmptyString(entry.id, `${entryPath}.id`);
    if (!["targeted", "hidden"].includes(entry.kind)) {
      throw new ValidationError(`${entryPath}.kind must be targeted or hidden.`);
    }
    if (entry.expected !== "fail" || entry.outcome !== "fail") {
      throw new ValidationError(`${entryPath} must record an observed base failure.`);
    }
    return clone(entry);
  });
  const suppliedId = contract.checks.hidden.id;
  if (!differentials.some((entry) => entry.kind === "hidden" && entry.id === suppliedId)) {
    throw new ValidationError(`${path} must include the supplied failing test ${suppliedId}.`);
  }
  return { validated: true, baselineDifferentials: differentials };
}

function assertArtifact(value, path, format, { requireHttps = false } = {}) {
  assertRecord(value, path);
  assertOnlyKeys(value, ["sha256", "bytes", "locator", "format"], path);
  if (!SHA256.test(value.sha256 ?? "")) {
    throw new ValidationError(`${path}.sha256 must be 64 lowercase hexadecimal characters.`);
  }
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0) {
    throw new ValidationError(`${path}.bytes must be a positive safe integer.`);
  }
  if (format && value.format !== format) {
    throw new ValidationError(`${path}.format must be ${format}.`);
  }
  assertRecord(value.locator, `${path}.locator`);
  if (value.locator.kind === "path") {
    if (requireHttps) {
      throw new ValidationError(`${path}.locator.kind must be https in a published job.`);
    }
    assertOnlyKeys(value.locator, ["kind", "path"], `${path}.locator`);
    assertNonEmptyString(value.locator.path, `${path}.locator.path`);
  } else if (value.locator.kind === "https") {
    assertOnlyKeys(value.locator, ["kind", "url"], `${path}.locator`);
    try {
      if (new URL(value.locator.url).protocol !== "https:") throw new Error("not HTTPS");
    } catch {
      throw new ValidationError(`${path}.locator.url must be an absolute HTTPS URL.`);
    }
  } else {
    throw new ValidationError(
      `${path}.locator.kind must be ${requireHttps ? "https" : "path or https"}.`
    );
  }
}

function assertAssuranceFloor(value, path) {
  const match = ASSURANCE_LEVEL.exec(value ?? "");
  if (!match || Number(match[1]) < 2) {
    throw new ValidationError(`${path} must be AV-2 or higher.`);
  }
}

function assertNonEmptyStringArray(value, path) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError(`${path} must contain at least one path.`);
  }
  value.forEach((entry, index) => assertNonEmptyString(entry, `${path}[${index}]`));
}

function assertNonEmptyString(value, path) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`${path} must be a non-empty string.`);
  }
}

function assertRecord(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${path} must be an object.`);
  }
}

function assertOnlyKeys(value, allowed, path) {
  const allowedKeys = new Set(allowed);
  const unsupported = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unsupported) {
    throw new ValidationError(`${path}.${unsupported} is not supported.`);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

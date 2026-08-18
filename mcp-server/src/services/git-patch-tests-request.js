import { ValidationError } from "../core/errors.js";

const PROFILE_NAME = "git-patch-tests-v1";
const PROFILE_VERSION = 1;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const COMMIT_RE = /^[a-f0-9]{40}$/u;

export function validateGitPatchTestsRequest(
  profile,
  target,
  inputs,
  { allowPathLocators = false } = {}
) {
  if (profile?.name !== PROFILE_NAME || profile?.version !== PROFILE_VERSION) {
    throw new ValidationError("Only git-patch-tests-v1@1 is implemented.");
  }
  assertRecord(target, "target");
  assertOnlyKeys(target, ["repository", "commit"], "target");
  if (typeof target.repository !== "string" || !target.repository.trim()) {
    throw new ValidationError("target.repository is required.");
  }
  if (!COMMIT_RE.test(target.commit ?? "")) {
    throw new ValidationError("target.commit must be 40 lowercase hexadecimal characters.");
  }

  assertRecord(inputs, "inputs");
  assertOnlyKeys(inputs, [
    "bundle",
    "patch",
    "testCommand",
    "workingDirectory",
    "allowedPaths",
    "protectedPaths",
    "maximumChangedFiles"
  ], "inputs");
  assertArtifact(inputs.bundle, "bundle", "git-bundle", { allowPathLocators });
  assertArtifact(inputs.patch, "patch", "file", { allowPathLocators });
  if (!Array.isArray(inputs.testCommand) || inputs.testCommand.length === 0
      || inputs.testCommand.some((part) => typeof part !== "string" || !part.trim())) {
    throw new ValidationError("inputs.testCommand must be a non-empty argv array.");
  }
  if (inputs.workingDirectory !== undefined
      && (typeof inputs.workingDirectory !== "string" || !inputs.workingDirectory.trim())) {
    throw new ValidationError("inputs.workingDirectory must be a non-empty string.");
  }
  assertStringArray(inputs.allowedPaths, "inputs.allowedPaths", { minimum: 1 });
  assertStringArray(inputs.protectedPaths, "inputs.protectedPaths");
  if (inputs.maximumChangedFiles !== undefined
      && (!Number.isInteger(inputs.maximumChangedFiles)
        || inputs.maximumChangedFiles < 1
        || inputs.maximumChangedFiles > 1000)) {
    throw new ValidationError("inputs.maximumChangedFiles must be an integer from 1 to 1000.");
  }
  const declaredBytes = Number(inputs.bundle.bytes) + Number(inputs.patch.bytes);
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes > profile.limits.size) {
    throw new ValidationError(
      `Verification inputs exceed the profile's ${profile.limits.size}-byte limit.`
    );
  }
}

function assertArtifact(artifact, label, format, { allowPathLocators }) {
  assertRecord(artifact, `inputs.${label}`);
  assertOnlyKeys(artifact, ["sha256", "bytes", "locator", "format"], `inputs.${label}`);
  if (artifact.format !== format || !SHA256_RE.test(artifact.sha256 ?? "")
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
    throw new ValidationError(`inputs.${label} must be a hash-pinned ${format} artifact.`);
  }
  assertRecord(artifact.locator, `inputs.${label}.locator`);
  if (artifact.locator.kind === "https") {
    assertOnlyKeys(artifact.locator, ["kind", "url"], `inputs.${label}.locator`);
    let url;
    try {
      url = new URL(artifact.locator.url);
    } catch {
      throw new ValidationError(`inputs.${label}.locator.url must be a valid HTTPS URL.`);
    }
    if (url.protocol !== "https:") {
      throw new ValidationError(`inputs.${label}.locator.url must use HTTPS.`);
    }
    return;
  }
  if (allowPathLocators && artifact.locator.kind === "path") {
    assertOnlyKeys(artifact.locator, ["kind", "path"], `inputs.${label}.locator`);
    if (typeof artifact.locator.path !== "string" || !artifact.locator.path.trim()) {
      throw new ValidationError(`inputs.${label}.locator.path is required.`);
    }
    return;
  }
  throw new ValidationError(`inputs.${label}.locator must be HTTPS.`);
}

function assertStringArray(value, label, { minimum = 0 } = {}) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length < minimum
      || value.some((part) => typeof part !== "string" || !part.trim())) {
    throw new ValidationError(`${label} must be an array of non-empty strings.`);
  }
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object.`);
  }
}

function assertOnlyKeys(value, allowed, label) {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) throw new ValidationError(`${label}.${unknown} is not supported.`);
}

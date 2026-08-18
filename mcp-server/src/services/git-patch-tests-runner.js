import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import { hashCanonicalContent } from "../core/canonical-content.js";
import { ValidationError } from "../core/errors.js";
import { ArtifactAcquisitionError, materializeArtifact } from "../../../witness/src/artifacts.mjs";
import { executeVerificationContract, VERDICTS } from "../../../witness/src/executor.mjs";
import { resolveJudgingCommandDefinition } from "../../../witness/src/verification-contract.mjs";

const PROFILE_NAME = "git-patch-tests-v1";
const INTEGRITY_FORBID = Object.freeze([
  "test_deletion",
  "skip_or_xfail_markers_added",
  "runner_replacement",
  "assertion_neutering",
  "snapshot_rewrite_to_accept_current",
  "coverage_or_lint_exclusion_of_changed_files",
  "error_swallowing_to_force_zero_exit"
]);

export class GitPatchTestsRunner {
  constructor({
    executeImpl = executeVerificationContract,
    materializeArtifactImpl = materializeArtifact,
    makeTemporaryDirectory = () => mkdtemp(join(tmpdir(), "averray-verify-")),
    removeTemporaryDirectory = (path) => rm(path, { recursive: true, force: true })
  } = {}) {
    this.executeImpl = executeImpl;
    this.materializeArtifactImpl = materializeArtifactImpl;
    this.makeTemporaryDirectory = makeTemporaryDirectory;
    this.removeTemporaryDirectory = removeTemporaryDirectory;
  }

  validate({ profile, target, inputs }) {
    try {
      buildGitPatchVerificationContract({
        profile,
        runId: hashCanonicalContent({ profile: profile.ref, target, inputs }),
        target,
        inputs
      });
    } catch (error) {
      // A declared resource breach is a run outcome, not malformed JSON. Let
      // the paid-run state machine record it as inconclusive and release the
      // authorization without billing.
      if (!(error instanceof VerificationResourceLimitError)) throw error;
    }
    return true;
  }

  async run({ profile, runId, target, inputs }) {
    if (profile?.name !== PROFILE_NAME) {
      throw new ValidationError(`No standalone runner is registered for profile ${profile?.name ?? "missing"}.`);
    }
    const contract = buildGitPatchVerificationContract({ profile, runId, target, inputs });
    const temporaryDirectory = await this.makeTemporaryDirectory();
    try {
      const patch = await this.materializeArtifactImpl(
        inputs.patch,
        join(temporaryDirectory, "candidate.patch"),
        { baseDirectory: temporaryDirectory }
      );
      const report = await this.executeImpl({
        contract,
        candidatePatch: patch.path,
        cwd: temporaryDirectory
      });
      return mapWitnessReport({ report, target, inputs });
    } catch (error) {
      if (error instanceof ArtifactAcquisitionError) {
        return {
          status: "inconclusive",
          reason: "target_unreachable",
          detail: error.message,
          artifactHash: `0x${inputs.patch.sha256}`,
          sourceBinding: {
            method: "git-bundle",
            verified: false,
            ref: target.commit,
            bundleHash: `0x${inputs.gitBundle.sha256}`
          }
        };
      }
      throw error;
    } finally {
      await this.removeTemporaryDirectory(temporaryDirectory);
    }
  }
}

export function buildGitPatchVerificationContract({ profile, target, inputs }) {
  validateGitPatchInputs({ profile, target, inputs });
  const workingDirectory = normalizeRepositoryPath(inputs.workingDirectory ?? ".", { allowDot: true });
  const commandDefinition = resolveJudgingCommandDefinition(inputs.testCommand, { workingDirectory });
  if (!commandDefinition.resolved) {
    throw new ValidationError(
      `The test command cannot be pinned to a repository definition: ${commandDefinition.reason}.`
    );
  }
  const protectedPaths = [...new Set([
    ...(inputs.protectedPaths ?? []),
    ...(commandDefinition.definitionFile ? [commandDefinition.definitionFile] : [])
  ].map((entry) => normalizeRepositoryPath(entry)))];
  const limits = profile.limits;
  return {
    schema_version: "averray.verification-contract/v1.1",
    job: {
      id: hashCanonicalContent({ profile: profile.ref, target, inputs }),
      type: "code_change",
      required_verification_level: "AV-2"
    },
    subject: {
      acquisition: {
        repository: target.repository,
        base_commit: target.commit,
        git_bundle: structuredClone(inputs.gitBundle)
      },
      materialization: {
        status: "HERMETIC",
        dependency_cache: null,
        frozen_inputs: []
      }
    },
    candidate: {
      format: "git_patch",
      allowed_paths: (inputs.allowedPaths ?? ["**"]).map((entry) => normalizeRepositoryPath(entry)),
      protected_paths: protectedPaths,
      maximum_changed_files: Number(inputs.maximumChangedFiles ?? 100)
    },
    checks: {
      targeted: [{
        id: "customer-test-command",
        command: [...inputs.testCommand],
        working_directory: workingDirectory,
        expected_on_base: "fail",
        expected_on_candidate: "pass",
        required: true
      }],
      regression: [],
      hidden: null
    },
    integrity: {
      judging_commands_immutable: true,
      forbid: [...INTEGRITY_FORBID]
    },
    inconclusive_policy: {
      infrastructure_attributable: ["host_failure", "image_unavailable", "platform_timeout", "artifact_unavailable"],
      contract_attributable: ["source_commit_binding_failed", "baseline_mismatch", "contract_precondition_untrue"],
      candidate_attributable: ["candidate_exceeded_resource_limit", "candidate_caused_nondeterminism_across_repetitions"],
      verifier_attributable: ["integrity_detection_ambiguous", "integrity_detection_unimplemented", "integrity_detection_failed"],
      repeated_candidate_attributable: { window: 10, threshold: 3, action: "escalate_to_human" }
    },
    reproducibility: {
      repetitions: 2,
      disagreement_result: "INCONCLUSIVE_FLAKY",
      random_seed: 48291
    },
    resources: {
      timeout_seconds: Math.max(1, Math.floor(limits.timeoutMs / 1000)),
      cpu_limit: limits.cpuLimit,
      memory_mb: limits.memoryMb,
      process_limit: limits.processLimit,
      temporary_storage_mb: limits.temporaryStorageMb,
      max_output_bytes: limits.outputLimitBytes
    },
    // This is the Witness assurance-policy field, not a chain action. The
    // standalone run service never imports or invokes the settlement service.
    settlement: {
      minimum_assurance_level: "AV-2",
      pass_required: true,
      human_overlay_required: false,
      challenge_window_blocks: 0
    }
  };
}

export function mapWitnessReport({ report, target, inputs }) {
  const sourceBindingVerified = report?.materialization?.bindingVerified === true;
  const common = {
    report: canonicalWitnessEvidence(report),
    artifactHash: `0x${inputs.patch.sha256}`,
    sourceBinding: {
      method: "git-bundle",
      verified: sourceBindingVerified,
      ref: target.commit,
      bundleHash: `0x${inputs.gitBundle.sha256}`
    },
    environment: {
      kind: "averray_witness",
      schemaVersion: report?.schemaVersion,
      image: report?.sandbox?.imageId ?? report?.sandbox?.image ?? null
    }
  };
  if (!sourceBindingVerified) {
    return {
      ...common,
      status: "inconclusive",
      reason: "ambiguous_evidence",
      detail: "Witness did not prove that the evaluated source reproduced the requested commit."
    };
  }
  if (report?.verdict === VERDICTS.PASS) {
    return { ...common, status: "decidable", evidence: "source_binding_verified tests_passed" };
  }
  if (report?.verdict === VERDICTS.FAIL || report?.verdict === VERDICTS.POLICY_VIOLATION) {
    return { ...common, status: "decidable", evidence: "source_binding_verified tests_failed" };
  }
  return {
    ...common,
    status: "inconclusive",
    reason: classifyInconclusiveReason(report),
    detail: String(report?.details ?? report?.reason ?? "The runner could not reach a decisive result.")
  };
}

export function canonicalWitnessEvidence(report) {
  const stableCheck = (check) => ({
    id: check?.id,
    kind: check?.kind,
    required: check?.required,
    command: check?.command,
    expected: check?.expected,
    outcome: check?.outcome,
    expectationMet: check?.expectationMet,
    exitCode: check?.exitCode,
    signal: check?.signal,
    timedOut: check?.timedOut,
    outputTruncated: check?.outputTruncated
  });
  const stableAttempt = (attempt) => ({
    preparation: attempt?.preparation ? {
      exitCode: attempt.preparation.exitCode,
      signal: attempt.preparation.signal,
      timedOut: attempt.preparation.timedOut,
      outputTruncated: attempt.preparation.outputTruncated,
      networkMode: attempt.preparation.networkMode,
      networkAssertionPassed: attempt.preparation.networkAssertionPassed
    } : null,
    checks: Array.isArray(attempt?.checks) ? attempt.checks.map(stableCheck) : [],
    inconclusives: attempt?.inconclusives ?? []
  });
  return {
    schemaVersion: report?.schemaVersion,
    mode: report?.mode,
    contract: report?.contract,
    verdict: report?.verdict,
    attribution: report?.attribution,
    reason: report?.reason,
    details: report?.details,
    materialization: report?.materialization ? {
      sourceType: report.materialization.sourceType,
      commit: report.materialization.commit,
      sha256: report.materialization.sha256,
      bytes: report.materialization.bytes,
      format: report.materialization.format,
      tree: report.materialization.tree,
      bindingVerified: report.materialization.bindingVerified
    } : null,
    sandbox: report?.sandbox ? {
      image: report.sandbox.image,
      imageId: report.sandbox.imageId,
      resourceEnforcement: report.sandbox.resourceEnforcement
    } : null,
    patch: report?.patch,
    policyViolations: report?.policyViolations ?? [],
    integrityViolations: report?.integrityViolations ?? [],
    integrityAmbiguities: report?.integrityAmbiguities ?? [],
    baseline: Array.isArray(report?.baseline) ? report.baseline.map(stableAttempt) : [],
    candidate: Array.isArray(report?.candidate) ? report.candidate.map(stableAttempt) : []
  };
}

export function classifyInconclusiveReason(report) {
  const reason = String(report?.reason ?? "").toLowerCase();
  const detail = String(report?.details ?? "").toLowerCase();
  if (
    reason.includes("artifact_unavailable")
    || reason.includes("target_unreachable")
    || detail.includes("artifact fetch")
    || detail.includes("target unreachable")
  ) {
    return "target_unreachable";
  }
  if (reason.includes("nondetermin") || reason.includes("flaky")) return "flaky";
  if (
    reason.includes("ambiguous")
    || reason.includes("source_commit_binding")
    || reason.includes("baseline_mismatch")
    || reason.includes("contract_precondition")
  ) {
    return "ambiguous_evidence";
  }
  return "runner_fault";
}

function validateGitPatchInputs({ profile, target, inputs }) {
  if (profile?.handler !== "deterministic" || Number(profile?.handlerVersion) !== 1) {
    throw new ValidationError("git-patch-tests-v1 requires the pinned deterministic/v1 handler.");
  }
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new ValidationError("Verification target is required.");
  }
  if (!String(target.repository ?? "").trim()) throw new ValidationError("target.repository is required.");
  if (!/^[a-f0-9]{40}$/u.test(String(target.commit ?? ""))) {
    throw new ValidationError("target.commit must be a full lowercase 40-character Git commit.");
  }
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
    throw new ValidationError("Verification inputs are required.");
  }
  validateArtifact(inputs.gitBundle, "inputs.gitBundle", "git-bundle");
  validateArtifact(inputs.patch, "inputs.patch", "file");
  if (!Array.isArray(inputs.testCommand) || inputs.testCommand.length === 0 || inputs.testCommand.some((part) => !String(part).trim())) {
    throw new ValidationError("inputs.testCommand must be a non-empty argv array.");
  }
  const totalBytes = Number(inputs.gitBundle.bytes) + Number(inputs.patch.bytes);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > profile.limits.sizeBytes) {
    throw new VerificationResourceLimitError(
      `Declared bundle and patch size exceeds the ${profile.limits.sizeBytes}-byte profile limit.`
    );
  }
}

function validateArtifact(artifact, label, format) {
  if (!artifact || artifact.format !== format || !/^[a-f0-9]{64}$/u.test(String(artifact.sha256 ?? ""))) {
    throw new ValidationError(`${label} must be a hash-pinned ${format} artifact.`);
  }
  if (!Number.isSafeInteger(Number(artifact.bytes)) || Number(artifact.bytes) <= 0) {
    throw new ValidationError(`${label}.bytes must be a positive integer.`);
  }
  if (artifact.locator?.kind !== "https" || !String(artifact.locator?.url ?? "").startsWith("https://")) {
    throw new ValidationError(`${label}.locator must be an HTTPS URL.`);
  }
}

function normalizeRepositoryPath(value, { allowDot = false } = {}) {
  const input = String(value ?? "").trim().replaceAll("\\", "/");
  const normalized = posix.normalize(input || ".").replace(/^\.\//u, "");
  if ((normalized === "." && allowDot) || (
    normalized && normalized !== ".." && !normalized.startsWith("../") && !normalized.startsWith("/")
  )) {
    return normalized;
  }
  throw new ValidationError(`Repository path ${JSON.stringify(value)} escapes the pinned source.`);
}

export class VerificationResourceLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "VerificationResourceLimitError";
    this.code = "verification_resource_limit";
  }
}

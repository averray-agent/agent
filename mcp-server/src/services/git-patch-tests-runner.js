import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashCanonicalContent } from "../core/canonical-content.js";
import { materializeArtifact } from "../../../witness/src/artifacts.mjs";
import {
  executeVerificationContract,
  VERDICTS
} from "../../../witness/src/executor.mjs";
import { ensureWitnessImage } from "../../../witness/src/docker.mjs";
import { resolveJudgingCommandDefinition } from "../../../witness/src/verification-contract.mjs";
import { validateGitPatchTestsRequest } from "./git-patch-tests-request.js";

const WITNESS_INTEGRITY_RULES = Object.freeze([
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
    execute = executeVerificationContract,
    ensureRuntime = ensureWitnessImage,
    materialize = materializeArtifact,
    temporaryParent = process.env.WITNESS_TEMP_ROOT ?? tmpdir()
  } = {}) {
    this.execute = execute;
    this.ensureRuntime = ensureRuntime;
    this.materialize = materialize;
    this.temporaryParent = temporaryParent;
  }

  async initialize() {
    return this.ensureRuntime();
  }

  async run({ runId, profile, target, inputs, artifactBaseDirectory = undefined }) {
    validateGitPatchTestsRequest(profile, target, inputs, {
      allowPathLocators: artifactBaseDirectory !== undefined
    });
    const temporaryRoot = await mkdtemp(join(this.temporaryParent, "averray-verify-"));
    try {
      const patchPath = join(temporaryRoot, "candidate.patch");
      try {
        await this.materialize(inputs.patch, patchPath, {
          baseDirectory: artifactBaseDirectory ?? temporaryRoot
        });
      } catch (error) {
        return inconclusive("target_unreachable", "TARGET_UNREACHABLE", error.message);
      }
      const contract = buildGitPatchTestsContract({ runId, profile, target, inputs });
      let report;
      try {
        report = await this.execute({
          contract,
          candidatePatch: patchPath,
          cwd: artifactBaseDirectory ?? temporaryRoot
        });
      } catch (error) {
        const ambiguous = /judging|freeze validation|verification contract rejected/iu.test(error?.message ?? "");
        return inconclusive(
          ambiguous ? "ambiguous_evidence" : "runner_fault",
          ambiguous ? "AMBIGUOUS_EVIDENCE" : "RUNNER_FAULT",
          error?.message ?? "The verification runner failed."
        );
      }
      return normalizeWitnessReport(report, inputs);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

export function buildGitPatchTestsContract({ runId, profile, target, inputs }) {
  const workingDirectory = inputs.workingDirectory ?? ".";
  const commandResolution = resolveJudgingCommandDefinition(inputs.testCommand, {
    workingDirectory
  });
  const protectedPaths = new Set(inputs.protectedPaths ?? []);
  if (commandResolution.definitionFile) protectedPaths.add(commandResolution.definitionFile);
  return {
    schema_version: "averray.verification-contract/v1.1",
    job: {
      id: runId,
      type: "code_change",
      required_verification_level: "AV-2"
    },
    subject: {
      acquisition: {
        repository: target.repository,
        base_commit: target.commit,
        git_bundle: inputs.bundle
      },
      materialization: {
        status: "HERMETIC",
        dependency_cache: null,
        frozen_inputs: []
      }
    },
    candidate: {
      format: "git_patch",
      allowed_paths: inputs.allowedPaths ?? ["**"],
      protected_paths: [...protectedPaths],
      maximum_changed_files: inputs.maximumChangedFiles ?? 250
    },
    checks: {
      targeted: [{
        id: "customer-test-command",
        command: inputs.testCommand,
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
      forbid: [...WITNESS_INTEGRITY_RULES]
    },
    inconclusive_policy: {
      infrastructure_attributable: [
        "host_failure", "image_unavailable", "platform_timeout", "artifact_unavailable"
      ],
      contract_attributable: [
        "source_commit_binding_failed", "baseline_mismatch", "contract_precondition_untrue"
      ],
      candidate_attributable: [
        "candidate_exceeded_resource_limit", "candidate_caused_nondeterminism_across_repetitions"
      ],
      verifier_attributable: [
        "integrity_detection_ambiguous", "integrity_detection_unimplemented", "integrity_detection_failed"
      ],
      repeated_candidate_attributable: { window: 10, threshold: 3, action: "escalate_to_human" }
    },
    reproducibility: {
      repetitions: 2,
      disagreement_result: "INCONCLUSIVE_FLAKY",
      random_seed: 48291
    },
    resources: {
      // The profile timeout covers two phases across two repetitions. Keep each
      // untrusted command inside one quarter of that public end-to-end bound.
      timeout_seconds: Math.max(1, Math.floor(profile.limits.timeout / 4)),
      cpu_limit: 1,
      memory_mb: 512,
      process_limit: 128,
      temporary_storage_mb: 512,
      max_output_bytes: 1024 * 1024
    },
    // This is a Witness assurance rule, not an Averray job-settlement request.
    settlement: {
      minimum_assurance_level: "AV-2",
      pass_required: true,
      human_overlay_required: false,
      challenge_window_blocks: 0
    }
  };
}

function normalizeWitnessReport(report, inputs) {
  const stableEvidence = stableReportEvidence(report);
  const common = {
    evidenceHash: hashCanonicalContent(stableEvidence),
    report: stableEvidence,
    execution: {
      artifactHash: `0x${inputs.patch.sha256}`,
      sourceBinding: {
        method: "offline_git_bundle",
        verified: report?.materialization?.bindingVerified === true,
        ref: report?.materialization?.commit,
        bundleHash: `0x${inputs.bundle.sha256}`
      },
      environment: {
        kind: "witness_offline_container",
        image: report?.sandbox?.imageId ?? report?.sandbox?.image ?? null,
        network: "none",
        repetitions: 2
      }
    }
  };
  if (report?.verdict === VERDICTS.PASS) {
    return { status: "conclusive", evidence: "pass", reasonCode: "TESTS_PASSED", ...common };
  }
  if ([VERDICTS.FAIL, VERDICTS.POLICY_VIOLATION].includes(report?.verdict)) {
    return {
      status: "conclusive",
      evidence: "fail",
      reasonCode: report.verdict === VERDICTS.POLICY_VIOLATION
        ? "POLICY_VIOLATION"
        : "TESTS_FAILED",
      ...common
    };
  }
  const reason = mapInconclusiveReason(report);
  return {
    status: "inconclusive",
    reason,
    reasonCode: reason.toUpperCase(),
    detail: report?.details ?? report?.reason ?? "The runner could not determine an outcome.",
    ...common
  };
}

function mapInconclusiveReason(report) {
  if (report?.reason === "candidate_caused_nondeterminism_across_repetitions") return "flaky";
  if (report?.reason === "integrity_detection_ambiguous") return "ambiguous_evidence";
  if (
    report?.reason === "artifact_unavailable"
    || (report?.reason === "host_failure" && /source materialization|artifact fetch/iu.test(report?.details ?? ""))
  ) return "target_unreachable";
  return "runner_fault";
}

function stableReportEvidence(report) {
  return {
    schemaVersion: report?.schemaVersion,
    mode: report?.mode,
    contract: report?.contract,
    verdict: report?.verdict,
    attribution: report?.attribution,
    reason: report?.reason,
    details: report?.details,
    materialization: report?.materialization && {
      commit: report.materialization.commit,
      tree: report.materialization.tree,
      sha256: report.materialization.sha256,
      bytes: report.materialization.bytes,
      format: report.materialization.format,
      bindingVerified: report.materialization.bindingVerified
    },
    patch: report?.patch && {
      bytes: report.patch.bytes,
      changedFileCount: report.patch.changedFileCount,
      changedPaths: report.patch.changedPaths,
      stats: report.patch.stats,
      valid: report.patch.valid,
      reason: report.patch.reason
    },
    policyViolations: report?.policyViolations ?? [],
    integrityViolations: report?.integrityViolations ?? [],
    integrityAmbiguities: report?.integrityAmbiguities ?? [],
    baseline: stableChecks(report?.baseline),
    candidate: stableChecks(report?.candidate)
  };
}

function stableChecks(attempts) {
  return (attempts ?? []).map((attempt) => ({
    repetition: attempt.repetition,
    checks: (attempt.checks ?? []).map((check) => ({
      id: check.id,
      kind: check.kind,
      expected: check.expected,
      outcome: check.outcome,
      expectationMet: check.expectationMet,
      exitCode: check.exitCode,
      signal: check.signal,
      timedOut: check.timedOut,
      outputTruncated: check.outputTruncated
    }))
  }));
}

function inconclusive(reason, reasonCode, detail) {
  return {
    status: "inconclusive",
    reason,
    reasonCode,
    detail,
    evidenceHash: hashCanonicalContent({ reason, reasonCode, detail })
  };
}

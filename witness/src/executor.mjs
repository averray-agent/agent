import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  applyCandidatePatch,
  evaluateCandidatePolicy,
  inspectCandidatePatch
} from "./candidate-patch.mjs";
import { DEFAULT_IMAGE, DEFAULT_TIMEOUT_SECONDS } from "./constants.mjs";
import { ensureWitnessImage, runInWitnessContainer } from "./docker.mjs";
import {
  INTEGRITY_DETECTION_SUPPORT,
  detectIntegrityViolations,
  unsupportedIntegrityDetections
} from "./integrity.mjs";
import { createAttemptCopy, materializeRepository } from "./materialize.mjs";
import { tail } from "./process.mjs";
import { assertValidVerificationContract } from "./verification-contract.mjs";

export const VERIFICATION_RESULT_SCHEMA = "averray.witness.verification-result/v1";
export const VERDICTS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  INCONCLUSIVE: "INCONCLUSIVE",
  POLICY_VIOLATION: "POLICY_VIOLATION"
});

function quoteShell(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function commandToShell(command) {
  return command.map(quoteShell).join(" ");
}

function expectedOutcome(check, phase) {
  if (phase === "baseline") {
    return check.kind === "targeted"
      ? check.expected_on_base
      : check.base_state === "green" ? "pass" : "fail";
  }
  return check.kind === "targeted" ? check.expected_on_candidate : check.expected;
}

function allChecks(contract) {
  return [
    ...contract.checks.targeted.map((check) => ({ ...check, kind: "targeted" })),
    ...contract.checks.regression.map((check) => ({ ...check, kind: "regression" }))
  ];
}

function resourcesFor(contract) {
  return {
    timeoutSeconds: contract.resources?.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
    cpuLimit: contract.resources?.cpu_limit ?? 2,
    memoryMb: contract.resources?.memory_mb ?? 4096,
    processLimit: contract.resources?.process_limit ?? 512,
    temporaryStorageMb: contract.resources?.writable_storage_mb ?? 1024,
    outputLimitBytes: contract.resources?.max_output_bytes ?? 10 * 1024 * 1024
  };
}

function untrustedResult(result, phase) {
  if (result.spawnError) {
    return {
      attribution: "infrastructure",
      reason: "host_failure",
      detail: result.spawnError
    };
  }
  if (!result.networkAssertionPassed) {
    return {
      attribution: "infrastructure",
      reason: "host_failure",
      detail: "sandbox did not prove loopback-only NetworkMode none"
    };
  }
  if (result.timedOut) {
    return phase === "candidate"
      ? {
          attribution: "candidate",
          reason: "candidate_exceeded_resource_limit",
          detail: "candidate check exceeded timeout_seconds"
        }
      : {
          attribution: "infrastructure",
          reason: "platform_timeout",
          detail: "baseline check exceeded timeout_seconds"
        };
  }
  if (result.outputTruncated) {
    return phase === "candidate"
      ? {
          attribution: "candidate",
          reason: "candidate_exceeded_resource_limit",
          detail: "candidate check exceeded max_output_bytes"
        }
      : {
          attribution: "infrastructure",
          reason: "host_failure",
          detail: "baseline check exceeded max_output_bytes"
        };
  }
  if (phase === "candidate" && (result.signal || [137, 143].includes(result.exitCode))) {
    return {
      attribution: "candidate",
      reason: "candidate_exceeded_resource_limit",
      detail: `candidate process ended by ${result.signal || `exit ${result.exitCode}`}`
    };
  }
  if (result.exitCode === null) {
    return {
      attribution: "infrastructure",
      reason: "host_failure",
      detail: "container returned no exit status"
    };
  }
  return null;
}

async function runEnvironment({
  contract,
  workspace,
  phase,
  repetition,
  image,
  runContainer
}) {
  const checks = [];
  const inconclusives = [];
  const resources = resourcesFor(contract);
  for (const check of allChecks(contract)) {
    const expected = expectedOutcome(check, phase);
    let result;
    try {
      result = await runContainer({
        image,
        workspace,
        command: commandToShell(check.command),
        environment: {
          AVERRAY_WITNESS_PHASE: phase,
          AVERRAY_WITNESS_REPETITION: String(repetition),
          AVERRAY_WITNESS_RANDOM_SEED: String(contract.reproducibility?.random_seed ?? 0)
        },
        networkMode: "none",
        phase,
        repetition,
        checkId: check.id,
        ...resources
      });
    } catch (error) {
      result = {
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        spawnError: error.message,
        timedOut: false,
        outputTruncated: false,
        seconds: 0,
        containerId: null,
        networkMode: "none",
        networkInterfaces: [],
        networkAssertionPassed: false
      };
    }
    const untrusted = untrustedResult(result, phase);
    if (untrusted) inconclusives.push({ ...untrusted, checkId: check.id });
    const outcome = result.exitCode === null ? "not_run" : result.exitCode === 0 ? "pass" : "fail";
    checks.push({
      id: check.id,
      kind: check.kind,
      required: check.required,
      command: check.command,
      expected,
      outcome,
      expectationMet: !untrusted && outcome === expected,
      containerId: result.containerId || null,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      outputTruncated: result.outputTruncated,
      seconds: result.seconds,
      networkMode: result.networkMode,
      networkInterfaces: result.networkInterfaces || [],
      networkAssertionPassed: result.networkAssertionPassed,
      stdout: tail(result.stdout),
      stderr: tail(result.stderr),
      spawnError: result.spawnError
    });
  }
  return {
    workspaceId: `${phase}-${repetition}`,
    containerIds: checks.map((check) => check.containerId).filter(Boolean),
    checks,
    inconclusives
  };
}

function baselineProblem(baselines) {
  const untrusted = baselines.flatMap((baseline) => baseline.inconclusives);
  if (untrusted.length > 0) return untrusted[0];
  const mismatch = baselines
    .flatMap((baseline) => baseline.checks)
    .find((check) => !check.expectationMet);
  if (mismatch) {
    return {
      attribution: "infrastructure",
      reason: "baseline_mismatch",
      detail: `baseline check ${JSON.stringify(mismatch.id)} expected ${mismatch.expected} but observed ${mismatch.outcome}`
    };
  }
  const signatures = baselines.map(environmentSignature);
  if (!signatures.every((signature) => signature === signatures[0])) {
    return {
      attribution: "infrastructure",
      reason: "baseline_mismatch",
      detail: "baseline outcomes disagreed across clean repetitions"
    };
  }
  return null;
}

function environmentSignature(environment) {
  return JSON.stringify(environment.checks.map((check) => ({ id: check.id, outcome: check.outcome })));
}

function candidateProblem(candidates) {
  const untrusted = candidates.flatMap((candidate) => candidate.inconclusives);
  if (untrusted.length > 0) {
    return untrusted.find((entry) => entry.attribution === "infrastructure") || untrusted[0];
  }
  const signatures = candidates.map(environmentSignature);
  if (!signatures.every((signature) => signature === signatures[0])) {
    return {
      attribution: "candidate",
      reason: "candidate_caused_nondeterminism_across_repetitions",
      detail: "candidate outcomes disagreed across clean repetitions"
    };
  }
  return null;
}

function requiredCandidateFailure(candidates) {
  return candidates
    .flatMap((candidate) => candidate.checks)
    .find((check) => check.required && !check.expectationMet);
}

function newReport(contract, candidatePatch, mode) {
  return {
    schemaVersion: VERIFICATION_RESULT_SCHEMA,
    generatedAt: new Date().toISOString(),
    mode,
    contract: {
      schemaVersion: contract.schema_version,
      jobId: contract.job.id,
      repository: contract.subject.acquisition.repository,
      baseCommit: contract.subject.acquisition.base_commit
    },
    candidatePatch,
    verdict: null,
    attribution: null,
    reason: null,
    details: null,
    materialization: null,
    sandbox: {
      image: null,
      imageId: null,
      resourceEnforcement: {
        timeoutSeconds: "enforced",
        cpuLimit: "enforced",
        memoryMb: "enforced",
        processLimit: "enforced",
        maxOutputBytes: "enforced",
        writableStorageMb: "tmp-only; bind-mounted workspace quota unimplemented"
      }
    },
    patch: null,
    policyViolations: [],
    integrityViolations: [],
    integritySupport: INTEGRITY_DETECTION_SUPPORT,
    baseline: [],
    candidate: [],
    seconds: 0
  };
}

function conclude(report, started, verdict, { attribution = null, reason = null, details = null } = {}) {
  report.verdict = verdict;
  report.attribution = attribution;
  report.reason = reason;
  report.details = details;
  report.seconds = Number(((performance.now() - started) / 1_000).toFixed(3));
  if (verdict === VERDICTS.INCONCLUSIVE && !["infrastructure", "candidate"].includes(attribution)) {
    throw new Error("INCONCLUSIVE verdict is missing infrastructure/candidate attribution");
  }
  return report;
}

export async function executeVerificationContract(options, dependencies = {}) {
  const contract = assertValidVerificationContract(options.contract);
  const candidatePatch = options.candidatePatch;
  const mode = options.mode === "naive" ? "naive" : "real";
  if (!candidatePatch) throw new Error("candidatePatch is required");

  const materialize = dependencies.materialize || materializeRepository;
  const ensureImage = dependencies.ensureImage || ensureWitnessImage;
  const runContainer = dependencies.runContainer || runInWitnessContainer;
  const temporaryParent = dependencies.temporaryParent ||
    process.env.WITNESS_TEMP_ROOT || join(homedir(), ".cache", "averray-witness");
  await mkdir(temporaryParent, { recursive: true, mode: 0o700 });
  // Docker Desktop does not resolve macOS's /var -> /private/var symlink when
  // interpreting bind-mount sources. Canonicalize once before creating any
  // workspace path so a populated host directory cannot become an empty mount.
  const temporaryRoot = await realpath(await mkdtemp(join(temporaryParent, "verify-")));
  const started = performance.now();
  const report = newReport(contract, candidatePatch, mode);

  try {
    const sourcePath = join(temporaryRoot, "source");
    let materialized;
    try {
      materialized = await materialize({
        repo: contract.subject.acquisition.repository,
        commit: contract.subject.acquisition.base_commit,
        destination: sourcePath,
        cwd: options.cwd || process.cwd()
      });
    } catch (error) {
      return conclude(report, started, VERDICTS.INCONCLUSIVE, {
        attribution: "infrastructure",
        reason: "host_failure",
        details: `source materialization failed: ${error.message}`
      });
    }
    report.materialization = {
      source: materialized.source,
      sourceType: materialized.sourceType,
      commit: materialized.commit,
      seconds: materialized.seconds
    };

    if (materialized.commit !== contract.subject.acquisition.base_commit) {
      return conclude(report, started, VERDICTS.INCONCLUSIVE, {
        attribution: "infrastructure",
        reason: "baseline_mismatch",
        details: `materialized ${materialized.commit || "no commit"}; expected ${contract.subject.acquisition.base_commit}`
      });
    }

    // Static policy is evaluated before any execution blocker so the declared
    // precedence remains POLICY_VIOLATION > INCONCLUSIVE > FAIL > PASS.
    let inspection;
    try {
      inspection = await inspectCandidatePatch({ patchPath: candidatePatch, baseRoot: sourcePath });
    } catch (error) {
      inspection = {
        valid: false,
        reason: `candidate patch could not be inspected: ${error.message}`
      };
    }
    report.patch = inspection.valid
      ? {
          bytes: inspection.bytes,
          changedPaths: inspection.changedPaths,
          stats: inspection.stats
        }
      : { valid: false, reason: inspection.reason };
    let candidateFailure = inspection.valid ? null : inspection.reason;
    const unsupported = mode === "real" ? unsupportedIntegrityDetections(contract) : [];
    let integrityFailure = null;

    if (inspection.valid) {
      if (mode === "real") {
        report.policyViolations = evaluateCandidatePolicy(contract, inspection);
      }
      const analysisRoot = join(temporaryRoot, "candidate-analysis");
      try {
        await createAttemptCopy(sourcePath, analysisRoot);
        const applied = await applyCandidatePatch({ patch: inspection, workspace: analysisRoot });
        if (!applied.applied) candidateFailure = applied.reason;
        if (applied.applied && mode === "real") {
          try {
            report.integrityViolations = await detectIntegrityViolations({
              contract,
              patch: inspection,
              baseRoot: sourcePath,
              candidateRoot: analysisRoot
            });
          } catch (error) {
            integrityFailure = error.message;
          }
        }
      } catch (error) {
        integrityFailure = `candidate analysis workspace failed: ${error.message}`;
      }
    }

    const violations = [...report.policyViolations, ...report.integrityViolations];
    if (violations.length > 0) {
      return conclude(report, started, VERDICTS.POLICY_VIOLATION, {
        reason: "candidate_policy_or_integrity_violation",
        details: violations.map((entry) => entry.detection)
      });
    }
    if (unsupported.length > 0) {
      return conclude(report, started, VERDICTS.INCONCLUSIVE, {
        attribution: "infrastructure",
        reason: "integrity_detection_unimplemented",
        details: `contract declares unsupported detections: ${unsupported.join(", ")}`
      });
    }
    if (integrityFailure) {
      return conclude(report, started, VERDICTS.INCONCLUSIVE, {
        attribution: "infrastructure",
        reason: "integrity_detection_failed",
        details: integrityFailure
      });
    }
    if (contract.subject.materialization.status !== "HERMETIC") {
      return conclude(report, started, VERDICTS.INCONCLUSIVE, {
        attribution: "infrastructure",
        reason: "dependency_cache_unavailable",
        details: "v1 names cache/input hashes but supplies no artifact locator; only HERMETIC execution is materializable"
      });
    }
    if (contract.checks.hidden?.required === true) {
      return conclude(report, started, VERDICTS.INCONCLUSIVE, {
        attribution: "infrastructure",
        reason: "hidden_bundle_unavailable",
        details: "v1 names the hidden bundle digest but supplies no artifact locator or command manifest"
      });
    }

    let image;
    try {
      image = await ensureImage(options.image || process.env.WITNESS_IMAGE || DEFAULT_IMAGE);
    } catch (error) {
      return conclude(report, started, VERDICTS.INCONCLUSIVE, {
        attribution: "infrastructure",
        reason: "image_unavailable",
        details: error.message
      });
    }
    report.sandbox.image = image.image;
    report.sandbox.imageId = image.imageId || null;
    const executionImage = image.imageId || image.image;
    const repetitions = contract.reproducibility?.repetitions ?? 1;

    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const workspace = join(temporaryRoot, `baseline-${repetition}`);
      await createAttemptCopy(sourcePath, workspace);
      report.baseline.push(await runEnvironment({
        contract,
        workspace,
        phase: "baseline",
        repetition,
        image: executionImage,
        runContainer
      }));
    }
    const baselineIssue = baselineProblem(report.baseline);
    if (baselineIssue) {
      return conclude(report, started, VERDICTS.INCONCLUSIVE, {
        attribution: baselineIssue.attribution,
        reason: baselineIssue.reason,
        details: baselineIssue.detail
      });
    }
    if (candidateFailure) {
      return conclude(report, started, VERDICTS.FAIL, {
        reason: "candidate_patch_invalid",
        details: candidateFailure
      });
    }

    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const workspace = join(temporaryRoot, `candidate-${repetition}`);
      await createAttemptCopy(sourcePath, workspace);
      const applied = await applyCandidatePatch({ patch: inspection, workspace });
      if (!applied.applied) {
        return conclude(report, started, VERDICTS.FAIL, {
          reason: "candidate_patch_invalid",
          details: applied.reason
        });
      }
      report.candidate.push(await runEnvironment({
        contract,
        workspace,
        phase: "candidate",
        repetition,
        image: executionImage,
        runContainer
      }));
    }

    const candidateIssue = candidateProblem(report.candidate);
    if (candidateIssue) {
      return conclude(report, started, VERDICTS.INCONCLUSIVE, {
        attribution: candidateIssue.attribution,
        reason: candidateIssue.reason,
        details: candidateIssue.detail
      });
    }

    const failed = requiredCandidateFailure(report.candidate);
    if (failed) {
      return conclude(report, started, VERDICTS.FAIL, {
        reason: "required_check_failed",
        details: `required ${failed.kind} check ${JSON.stringify(failed.id)} expected ${failed.expected} but observed ${failed.outcome}`
      });
    }
    return conclude(report, started, VERDICTS.PASS);
  } finally {
    if (dependencies.keepTemporaryRoot) report.temporaryRoot = temporaryRoot;
    else await rm(temporaryRoot, { recursive: true, force: true });
  }
}

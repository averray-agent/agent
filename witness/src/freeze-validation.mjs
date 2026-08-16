import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_IMAGE, DEFAULT_TIMEOUT_SECONDS } from "./constants.mjs";
import {
  dockerReadOnlyMounts,
  materializeContractSource,
  prepareContractArtifacts,
  prepareWorkspaceMountTargets
} from "./contract-runtime.mjs";
import { ensureWitnessImage, runInWitnessContainer } from "./docker.mjs";
import { createAttemptCopy, materializeRepository } from "./materialize.mjs";
import { REJECTION_RULES, VERIFICATION_CONTRACT_SCHEMA_VERSION } from "./verification-contract.mjs";

function commandToShell(command) {
  return command.map((value) => `'${value.replaceAll("'", `'"'"'`)}'`).join(" ");
}

function runtimeIssue(code, rule, path, message, details = {}) {
  return { code, rule, path, message, ...details };
}

function differentialChecks(contract) {
  const checks = contract.checks.targeted.map((check) => ({ ...check, kind: "targeted" }));
  if (contract.schema_version === VERIFICATION_CONTRACT_SCHEMA_VERSION && contract.checks.hidden) {
    checks.push({ ...contract.checks.hidden, kind: "hidden" });
  }
  return checks;
}

function resourceOptions(contract) {
  return {
    timeoutSeconds: contract.resources?.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
    cpuLimit: contract.resources?.cpu_limit ?? 2,
    memoryMb: contract.resources?.memory_mb ?? 4096,
    processLimit: contract.resources?.process_limit ?? 512,
    temporaryStorageMb: contract.resources?.temporary_storage_mb ??
      contract.resources?.writable_storage_mb ?? 1024,
    outputLimitBytes: contract.resources?.max_output_bytes ?? 10 * 1024 * 1024
  };
}

export async function confirmVerificationContractBase(contract, options = {}, dependencies = {}) {
  const materialize = dependencies.materialize || materializeRepository;
  const ensureImage = dependencies.ensureImage || ensureWitnessImage;
  const runContainer = dependencies.runContainer || runInWitnessContainer;
  const temporaryParent = dependencies.temporaryParent || options.temporaryParent ||
    process.env.WITNESS_TEMP_ROOT || join(homedir(), ".cache", "averray-witness");
  await mkdir(temporaryParent, { recursive: true, mode: 0o700 });
  const temporaryRoot = await realpath(await mkdtemp(join(temporaryParent, "freeze-")));
  const evidence = { source: null, artifacts: null, checks: [] };
  const issues = [];

  try {
    const sourcePath = join(temporaryRoot, "source");
    try {
      evidence.source = await materializeContractSource({
        contract,
        destination: sourcePath,
        cwd: options.cwd || process.cwd(),
        materialize
      });
      if (evidence.source.commit !== contract.subject.acquisition.base_commit) {
        throw new Error(
          `materialized ${evidence.source.commit || "no commit"}; expected ${contract.subject.acquisition.base_commit}`
        );
      }
      evidence.artifacts = await prepareContractArtifacts(contract, temporaryRoot, {
        cwd: options.cwd || process.cwd()
      });
    } catch (error) {
      issues.push(runtimeIssue(
        "VCV11_FREEZE_ARTIFACT_EVIDENCE",
        "freeze evidence: source and supplied artifacts must be retrievable and match their digests",
        "subject",
        error.message
      ));
      return { valid: false, contract, issues, evidence };
    }

    let image;
    try {
      image = await ensureImage(options.image || process.env.WITNESS_IMAGE || DEFAULT_IMAGE);
    } catch (error) {
      issues.push(runtimeIssue(
        "VCV11_FREEZE_INFRASTRUCTURE",
        "freeze evidence: the baseline sandbox must execute",
        "checks",
        error.message
      ));
      return { valid: false, contract, issues, evidence };
    }

    let index = 0;
    for (const check of differentialChecks(contract)) {
      const workspace = join(temporaryRoot, `baseline-${++index}`);
      await createAttemptCopy(sourcePath, workspace);
      await prepareWorkspaceMountTargets(workspace, evidence.artifacts.mounts);
      let result;
      try {
        result = await runContainer({
          image: image.imageId || image.image,
          workspace,
          command: commandToShell(check.command),
          workingDirectory: check.working_directory || ".",
          readOnlyMounts: dockerReadOnlyMounts(evidence.artifacts.mounts),
          environment: {
            AVERRAY_WITNESS_PHASE: "freeze-baseline",
            AVERRAY_WITNESS_REPETITION: "1",
            AVERRAY_WITNESS_RANDOM_SEED: String(contract.reproducibility?.random_seed ?? 0)
          },
          networkMode: "none",
          phase: "freeze-baseline",
          repetition: 1,
          checkId: check.id,
          ...resourceOptions(contract)
        });
      } catch (error) {
        result = { exitCode: null, spawnError: error.message, networkAssertionPassed: false };
      }
      const outcome = result.exitCode === 0 ? "pass" : result.exitCode === null ? "not_run" : "fail";
      evidence.checks.push({
        id: check.id,
        kind: check.kind,
        expected: "fail",
        outcome,
        exitCode: result.exitCode,
        networkAssertionPassed: result.networkAssertionPassed,
        suppliedArtifactMounted: check.kind !== "hidden" || Boolean(evidence.artifacts.hidden)
      });
      if (result.exitCode === null || result.networkAssertionPassed !== true || result.timedOut ||
          result.outputTruncated || result.signal) {
        issues.push(runtimeIssue(
          "VCV11_FREEZE_INFRASTRUCTURE",
          "freeze evidence: the baseline sandbox must execute",
          check.kind === "hidden" ? "checks.hidden.command" : `checks.targeted[${index - 1}].command`,
          result.spawnError || "baseline sandbox execution was incomplete or not trusted"
        ));
      } else if (outcome !== "fail") {
        const rule = REJECTION_RULES.TARGETED_BASE_MUST_FAIL;
        issues.push(runtimeIssue(
          rule.code,
          rule.name,
          check.kind === "hidden" ? "checks.hidden.expected_on_base" : `checks.targeted[${index - 1}].expected_on_base`,
          `${check.kind} check ${JSON.stringify(check.id)} claimed fail on base but the Witness observed pass`,
          { observedOutcome: outcome, checkId: check.id }
        ));
      }
    }
    return { valid: issues.length === 0, contract, issues, evidence };
  } finally {
    if (dependencies.keepTemporaryRoot) evidence.temporaryRoot = temporaryRoot;
    else await rm(temporaryRoot, { recursive: true, force: true });
  }
}

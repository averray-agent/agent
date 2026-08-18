import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";

import {
  CLASSIFICATIONS,
  DEFAULT_IMAGE,
  DEFAULT_TIMEOUT_SECONDS,
  REPORT_SCHEMA
} from "./constants.mjs";
import { dependencyPlan, detectToolchain, inferCheckDefinition } from "./detect.mjs";
import { ensureWitnessImage, runInWitnessContainer } from "./docker.mjs";
import { createAttemptCopy, materializeRepository } from "./materialize.mjs";
import {
  extractFailureReason,
  interpretExecution,
  looksLikeNetworkFailure
} from "./observe.mjs";
import { tail } from "./process.mjs";

export async function runPreflight(options, dependencies = {}) {
  const {
    repo,
    check,
    image = process.env.WITNESS_IMAGE || DEFAULT_IMAGE,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    frozenInputs = [],
    protectedPaths = [],
    preparationCommands = [],
    includeGitMetadata = false,
    copyCheckWorkspaceToTmpfs = false,
    workingDirectory = ".",
    cwd = process.cwd()
  } = options;
  if (!repo || !check) throw new Error("repo and check are required");
  if (!Array.isArray(preparationCommands) || preparationCommands.some((command) =>
    typeof command !== "string" || command.trim() === "")) {
    throw new Error("preparationCommands must be an array of non-empty shell commands");
  }
  const checkWorkingDirectory = normalizeWorkingDirectory(workingDirectory);

  const runContainer = dependencies.runContainer || runInWitnessContainer;
  const ensureImage = dependencies.ensureImage || ensureWitnessImage;
  const materialize = dependencies.materialize || materializeRepository;
  const started = performance.now();
  const temporaryParent = dependencies.temporaryParent || process.env.WITNESS_TEMP_ROOT || join(homedir(), ".cache", "averray-witness");
  await mkdir(temporaryParent, { recursive: true, mode: 0o700 });
  const temporaryRoot = await mkdtemp(join(temporaryParent, "run-"));
  const report = initialReport({
    repo,
    check,
    image,
    timeoutSeconds,
    protectedPaths,
    preparationCommands,
    includeGitMetadata,
    copyCheckWorkspaceToTmpfs,
    workingDirectory: checkWorkingDirectory
  });

  try {
    const sourcePath = join(temporaryRoot, "source");
    let materialized;
    try {
      materialized = await materialize({ repo, destination: sourcePath, cwd });
      report.commit = materialized.commit;
      report.materialization = {
        source: materialized.source,
        sourceType: materialized.sourceType,
        seconds: materialized.seconds
      };
    } catch (error) {
      return finishReport(report, started, {
        classification: CLASSIFICATIONS.UNMATERIALIZABLE,
        reason: `repository materialization failed: ${error.message}`
      });
    }

    try {
      const checkRoot = join(sourcePath, checkWorkingDirectory);
      report.toolchain = await detectToolchain(sourcePath, check);
      const protectedFromCheckRoot = protectedPaths
        .map((path) => relative(checkWorkingDirectory, path).replaceAll("\\", "/"))
        .filter((path) => path === "" || (!path.startsWith("..") && !isAbsolute(path)));
      const definition = await inferCheckDefinition(checkRoot, check, protectedFromCheckRoot);
      report.check = {
        ...report.check,
        ...definition,
        definitionFile: definition.definitionFile === null
          ? null
          : checkWorkingDirectory === "."
            ? definition.definitionFile
            : `${checkWorkingDirectory}/${definition.definitionFile}`
      };
      report.checkCommandExists = report.check.declared !== false;
      report.candidateModifiable = report.check.candidateModifiable;
    } catch (error) {
      return finishReport(report, started, {
        classification: CLASSIFICATIONS.UNMATERIALIZABLE,
        reason: `toolchain detection failed: ${error.message}`
      });
    }

    try {
      report.frozenInputs = await describeFrozenInputs(sourcePath, frozenInputs);
    } catch (error) {
      return finishReport(report, started, {
        classification: CLASSIFICATIONS.UNMATERIALIZABLE,
        reason: `frozen input is not materializable: ${error.message}`
      });
    }

    try {
      report.sandbox.imagePreparation = await ensureImage(image);
      report.sandbox.imageId = report.sandbox.imagePreparation.imageId || null;
    } catch (error) {
      return finishReport(report, started, {
        classification: CLASSIFICATIONS.UNMATERIALIZABLE,
        reason: `sandbox toolchain unavailable: ${error.message}`
      });
    }

    const executionImage = report.sandbox.imageId || image;
    const plan = await dependencyPlan(sourcePath, report.toolchain);
    report.dependencyPreparation.plan = plan;
    let firstObservation = null;
    let unprepared = null;

    // uv resolves and downloads from its lock automatically. Preparing that
    // frozen closure before the first check keeps a missing cache distinct from
    // a check that genuinely attempts egress; the check itself still only runs
    // with NetworkMode none.
    if (!(plan.supported && plan.proactive === true)) {
      const unpreparedPath = join(temporaryRoot, "unprepared");
      await createAttemptCopy(sourcePath, unpreparedPath, { includeGitMetadata });
      unprepared = await runContainer({
        image: executionImage,
        workspace: unpreparedPath,
        command: check,
        workingDirectory: checkWorkingDirectory,
        networkMode: "none",
        timeoutSeconds
      });
      recordAttempt(report, "unprepared-check", unprepared, true);
      updateSandboxObservation(report, unprepared);
      updateBaseExit(report, unprepared);

      if (!unprepared.networkAssertionPassed) {
        return finishReport(report, started, {
          classification: CLASSIFICATIONS.UNMATERIALIZABLE,
          reason: networkAssertionFailure(unprepared)
        });
      }

      firstObservation = interpretExecution(unprepared, {
        command: check,
        definition: report.check
      });
      if (firstObservation.commandAbsent) {
        report.checkCommandExists = false;
        return finishReport(report, started, {
          classification: CLASSIFICATIONS.UNMATERIALIZABLE,
          reason: `check command is absent: ${extractFailureReason(unprepared, check)}`
        });
      }
      report.checkCommandExists = true;
      if (firstObservation.timedOut) {
        return finishReport(report, started, {
          classification: CLASSIFICATIONS.UNMATERIALIZABLE,
          reason: extractFailureReason(unprepared, "offline check timed out")
        });
      }
      if (firstObservation.networkFailure) {
        return finishReport(report, started, {
          classification: CLASSIFICATIONS.REQUIRES_NETWORK,
          reason: extractFailureReason(unprepared, "offline check observed a network failure")
        });
      }
      if (!firstObservation.dependencyFailure && preparationCommands.length === 0) {
        return finishReport(report, started, {
          classification: successfulOfflineClassification(report),
          reason: null
        });
      }
    }

    if (!plan.supported) {
      if (firstObservation?.missingExecutable && firstObservation.missingExecutable === report.toolchain.detail) {
        return finishReport(report, started, {
          classification: CLASSIFICATIONS.UNMATERIALIZABLE,
          reason: `toolchain executable is missing: ${firstObservation.missingExecutable}`
        });
      }
      return finishReport(report, started, {
        classification: CLASSIFICATIONS.REQUIRES_NETWORK,
        reason: `${plan.reason}; observed ${extractFailureReason(unprepared, "dependency or preparation requirement")}`
      });
    }

    const preparedPath = join(temporaryRoot, "prepared");
    const cachePath = dependencies.cacheDirectory || join(temporaryRoot, "dependency-cache");
    await createAttemptCopy(sourcePath, preparedPath, { includeGitMetadata });
    await mkdir(cachePath, { recursive: true, mode: 0o777 });
    const populate = await runContainer({
      image: executionImage,
      workspace: preparedPath,
      cache: cachePath,
      command: plan.populateCommand,
      networkMode: "bridge",
      timeoutSeconds
    });
    recordAttempt(report, "cache-population", populate, false);
    report.dependencyPreparation.attempted = true;
    report.dependencyPreparation.kind = plan.kind;
    report.dependencyPreparation.seconds = populate.seconds;
    report.dependencyPreparation.cachePopulationSeconds = populate.seconds;
    report.dependencyPreparation.succeeded = populate.exitCode === 0;
    report.dependencyPreparation.cacheSizeBytes = await directorySize(cachePath);
    syncDependencyFields(report);

    if (populate.exitCode !== 0) {
      return finishReport(report, started, {
        classification: CLASSIFICATIONS.UNMATERIALIZABLE,
        reason: `dependency cache preparation failed: ${extractFailureReason(populate, plan.populateCommand)}`
      });
    }

    await removePreparedDependencies(preparedPath);
    const offlineInstall = await runContainer({
      image: executionImage,
      workspace: preparedPath,
      cache: cachePath,
      command: plan.offlineInstallCommand,
      networkMode: "none",
      timeoutSeconds
    });
    recordAttempt(report, "offline-dependency-install", offlineInstall, false);
    updateSandboxObservation(report, offlineInstall);
    report.dependencyPreparation.offlineInstallSeconds = offlineInstall.seconds;
    report.dependencyPreparation.totalSeconds = Number((
      report.dependencyPreparation.cachePopulationSeconds + offlineInstall.seconds
    ).toFixed(3));
    if (!offlineInstall.networkAssertionPassed) {
      return finishReport(report, started, {
        classification: CLASSIFICATIONS.UNMATERIALIZABLE,
        reason: networkAssertionFailure(offlineInstall)
      });
    }
    if (offlineInstall.exitCode !== 0) {
      const classification = looksLikeNetworkFailure(offlineInstall)
        ? CLASSIFICATIONS.REQUIRES_NETWORK
        : CLASSIFICATIONS.UNMATERIALIZABLE;
      return finishReport(report, started, {
        classification,
        reason: `offline dependency installation failed: ${extractFailureReason(offlineInstall, plan.offlineInstallCommand)}`
      });
    }

    for (const preparationCommand of preparationCommands) {
      const preparation = await runContainer({
        image: executionImage,
        workspace: preparedPath,
        cache: cachePath,
        command: preparationCommand,
        environment: plan.checkEnvironment || {},
        networkMode: "none",
        timeoutSeconds
      });
      recordAttempt(report, "check-preparation", preparation, false);
      updateSandboxObservation(report, preparation);
      if (!preparation.networkAssertionPassed) {
        return finishReport(report, started, {
          classification: CLASSIFICATIONS.UNMATERIALIZABLE,
          reason: networkAssertionFailure(preparation)
        });
      }
      if (preparation.exitCode !== 0) {
        return finishReport(report, started, {
          classification: looksLikeNetworkFailure(preparation)
            ? CLASSIFICATIONS.REQUIRES_NETWORK
            : CLASSIFICATIONS.UNMATERIALIZABLE,
          reason: `check preparation failed: ${extractFailureReason(preparation, preparationCommand)}`
        });
      }
    }

    const preparedCheck = await runContainer({
      image: executionImage,
      workspace: preparedPath,
      cache: cachePath,
      command: check,
      workingDirectory: checkWorkingDirectory,
      environment: plan.checkEnvironment || {},
      networkMode: "none",
      copyWorkspaceToTmpfs: copyCheckWorkspaceToTmpfs,
      timeoutSeconds
    });
    recordAttempt(report, "prepared-check", preparedCheck, true);
    updateSandboxObservation(report, preparedCheck);
    updateBaseExit(report, preparedCheck);
    if (!preparedCheck.networkAssertionPassed) {
      return finishReport(report, started, {
        classification: CLASSIFICATIONS.UNMATERIALIZABLE,
        reason: networkAssertionFailure(preparedCheck)
      });
    }

    const preparedObservation = interpretExecution(preparedCheck, {
      command: check,
      definition: report.check
    });
    if (preparedObservation.commandAbsent || preparedObservation.missingExecutable) {
      return finishReport(report, started, {
        classification: CLASSIFICATIONS.UNMATERIALIZABLE,
        reason: `required executable is missing after dependency preparation: ${preparedObservation.missingExecutable || extractFailureReason(preparedCheck, check)}`
      });
    }
    if (preparedObservation.timedOut) {
      return finishReport(report, started, {
        classification: CLASSIFICATIONS.UNMATERIALIZABLE,
        reason: extractFailureReason(preparedCheck, "prepared offline check timed out")
      });
    }
    if (preparedObservation.networkFailure) {
      return finishReport(report, started, {
        classification: CLASSIFICATIONS.REQUIRES_NETWORK,
        reason: extractFailureReason(preparedCheck, "prepared check observed a network failure")
      });
    }

    return finishReport(report, started, {
      classification: report.frozenInputs.length > 0
        ? CLASSIFICATIONS.MOCKED_EXTERNAL_SYSTEM
        : CLASSIFICATIONS.FROZEN_DEPENDENCIES,
      reason: null
    });
  } finally {
    if (!dependencies.keepTemporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true });
    } else {
      report.temporaryRoot = temporaryRoot;
    }
  }
}

function initialReport({
  repo,
  check,
  image,
  timeoutSeconds,
  protectedPaths,
  preparationCommands,
  includeGitMetadata,
  copyCheckWorkspaceToTmpfs,
  workingDirectory
}) {
  return {
    schemaVersion: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    repo,
    commit: null,
    toolchain: { kind: "other", detail: "undetected", packageManager: null, detectedBy: [], additional: [] },
    classification: null,
    classificationReason: null,
    observedFailureReason: null,
    checkCommand: check,
    checkCommandExists: null,
    baseExitStatus: null,
    basePassed: null,
    candidateModifiable: false,
    dependencyCacheSizeBytes: 0,
    dependencyPreparationSeconds: 0,
    totalSeconds: 0,
    materialization: null,
    check: {
      command: check,
      preparationCommands,
      includesGitMetadata: includeGitMetadata,
      workspaceMode: copyCheckWorkspaceToTmpfs ? "ephemeral-tmpfs" : "bind",
      workingDirectory,
      timeoutSeconds,
      definitionFile: null,
      definitionKind: "external-command",
      declared: null,
      candidateModifiable: false,
      protectedBy: null,
      baseExitStatus: null,
      baseOutcome: "not_run"
    },
    candidatePolicy: {
      allowedPaths: ["**"],
      protectedPaths
    },
    frozenInputs: [],
    dependencyPreparation: {
      attempted: false,
      kind: "none",
      plan: null,
      cacheSizeBytes: 0,
      seconds: 0,
      cachePopulationSeconds: 0,
      offlineInstallSeconds: 0,
      totalSeconds: 0,
      succeeded: false
    },
    sandbox: {
      image,
      imageId: null,
      imagePreparation: null,
      requestedNetworkMode: "none",
      observedNetworkMode: null,
      observedInterfaces: [],
      networkAssertion: "not_run"
    },
    attempts: []
  };
}

function normalizeWorkingDirectory(value) {
  if (typeof value !== "string" || value.trim() === "" || isAbsolute(value)) {
    throw new Error("workingDirectory must be a repository-relative directory");
  }
  const normalized = normalize(value.trim()).replaceAll("\\", "/").replace(/^\.\//u, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("workingDirectory must not escape the repository");
  }
  return normalized === "" ? "." : normalized;
}

function recordAttempt(report, phase, result, checkAttempt) {
  report.attempts.push({
    phase,
    checkAttempt,
    workspaceMode: result.workspaceMode || "bind",
    networkMode: result.networkMode,
    networkInterfaces: result.networkInterfaces,
    networkAssertionPassed: result.networkAssertionPassed,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    outputTruncated: result.outputTruncated,
    seconds: result.seconds,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr),
    spawnError: result.spawnError
  });
}

function updateSandboxObservation(report, result) {
  report.sandbox.observedNetworkMode = result.networkMode;
  report.sandbox.observedInterfaces = result.networkInterfaces || [];
  report.sandbox.networkAssertion = result.networkAssertionPassed ? "passed" : "failed";
}

function updateBaseExit(report, result) {
  report.baseExitStatus = result.exitCode;
  report.basePassed = result.exitCode === null ? null : result.exitCode === 0;
  report.check.baseExitStatus = result.exitCode;
  report.check.baseOutcome = result.exitCode === null ? "not_run" : result.exitCode === 0 ? "pass" : "fail";
}

function syncDependencyFields(report) {
  report.dependencyCacheSizeBytes = report.dependencyPreparation.cacheSizeBytes;
  report.dependencyPreparation.totalSeconds = Number((
    report.dependencyPreparation.cachePopulationSeconds +
    report.dependencyPreparation.offlineInstallSeconds
  ).toFixed(3));
  report.dependencyPreparationSeconds = report.dependencyPreparation.totalSeconds;
}

function successfulOfflineClassification(report) {
  return report.frozenInputs.length > 0
    ? CLASSIFICATIONS.MOCKED_EXTERNAL_SYSTEM
    : CLASSIFICATIONS.HERMETIC;
}

function finishReport(report, started, { classification, reason }) {
  report.classification = classification;
  report.classificationReason = reason;
  report.observedFailureReason = [
    CLASSIFICATIONS.REQUIRES_NETWORK,
    CLASSIFICATIONS.UNMATERIALIZABLE
  ].includes(classification) ? reason : null;
  report.totalSeconds = Number(((performance.now() - started) / 1_000).toFixed(3));
  syncDependencyFields(report);
  return report;
}

function networkAssertionFailure(result) {
  const interfaces = result.networkInterfaces?.join(",") || "unobserved";
  return `sandbox did not prove NetworkMode none from inside the container (mode=${result.networkMode || "unknown"}, interfaces=${interfaces})`;
}

async function removePreparedDependencies(root) {
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (["node_modules", ".venv", ".witness-venv"].includes(entry.name)) {
      await rm(path, { recursive: true, force: true });
    } else if (entry.isDirectory() && entry.name !== ".git") {
      await removePreparedDependencies(path);
    }
  }));
}

async function directorySize(root) {
  let total = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) total += await directorySize(path);
    else if (entry.isFile()) total += (await lstat(path)).size;
  }
  return total;
}

async function describeFrozenInputs(root, inputs) {
  const descriptions = [];
  for (const input of inputs) {
    const clean = normalize(input).replace(/^\.\//u, "");
    if (clean.startsWith("..")) throw new Error(`${input} escapes the repository`);
    const path = join(root, clean);
    const handle = await open(path, "r");
    await handle.close();
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`${input} is not a regular file`);
    const content = await readFile(path);
    descriptions.push({
      path: clean,
      sha256: createHash("sha256").update(content).digest("hex"),
      sizeBytes: info.size
    });
  }
  return descriptions;
}

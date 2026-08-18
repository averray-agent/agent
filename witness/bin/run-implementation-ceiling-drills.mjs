#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_IMAGE } from "../src/constants.mjs";
import { ensureWitnessImage, runInWitnessContainer } from "../src/docker.mjs";
import { runPreflight } from "../src/preflight.mjs";
import { REJECTION_RULES, validateVerificationContract } from "../src/verification-contract.mjs";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = resolve(WITNESS_ROOT, "src");
const UV_FIXTURE = resolve(WITNESS_ROOT, "test/fixtures/uv-toolchain");
const NETWORK_FIXTURE = resolve(WITNESS_ROOT, "test/fixtures/network-required");
const UV_COPY = "COPY --from=ghcr.io/astral-sh/uv:0.12.5@sha256:e85be844203885286c60ffad8a858d48afb6c5a5c237ca0e67f12e74b8f174b1 /uv /uvx /bin/";

function parseArgs(argv) {
  const result = {
    out: resolve(WITNESS_ROOT, "evidence", "implementation-ceiling-drills-pkt-witness-009.json")
  };
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index] !== "--out" || !argv[index + 1]) throw new Error(`${argv[index]} requires a value`);
    result.out = resolve(argv[index + 1]);
  }
  return result;
}

function mutate(source, anchor, replacement) {
  const anchorOccurrences = source.split(anchor).length - 1;
  const changed = anchorOccurrences === 1 ? source.replace(anchor, replacement) : source;
  return {
    source: changed,
    anchorOccurrences,
    applied: anchorOccurrences === 1 && changed !== source && !changed.includes(anchor)
  };
}

async function loadMutant(root, { file, anchor, replacement, query }) {
  const source = await readFile(resolve(SOURCE_ROOT, file), "utf8");
  const result = mutate(source, anchor, replacement);
  const mutantRoot = join(root, `mutant-${query}`);
  await cp(SOURCE_ROOT, mutantRoot, { recursive: true });
  await writeFile(join(mutantRoot, file), result.source);
  const module = await import(`${pathToFileURL(join(mutantRoot, file)).href}?seen-red=${query}`);
  return {
    module,
    mutation: { anchorOccurrences: result.anchorOccurrences, applied: result.applied }
  };
}

function status(value) {
  return value ? "GREEN" : "RED";
}

const options = parseArgs(process.argv.slice(2));
// Docker Desktop/Colima only shares the repository roots with its VM. Keep the
// short-lived drill tree here so the live container sees the same fixture that
// the host mutation runner sees.
const temporaryRoot = await mkdtemp(resolve(WITNESS_ROOT, ".implementation-ceiling-drills-"));
try {
  const image = await ensureWitnessImage(DEFAULT_IMAGE);
  const uvRun = await runInWitnessContainer({
    image: image.imageId || DEFAULT_IMAGE,
    workspace: UV_FIXTURE,
    command: "make gate",
    networkMode: "none",
    timeoutSeconds: 30,
    copyWorkspaceToTmpfs: true
  });
  const dockerfile = await readFile(resolve(WITNESS_ROOT, "sandbox/Dockerfile"), "utf8");
  const uvMutation = mutate(dockerfile, UV_COPY, "# MUTANT: pinned uv binary omitted");
  const uvPresent = dockerfile.includes(UV_COPY) &&
    /uv 0\.12\.5/u.test(uvRun.stdout) &&
    /Python 3\.12\.12/u.test(uvRun.stdout) &&
    /uv-build 0\.9\.27/u.test(uvRun.stdout) &&
    /UV_TOOLCHAIN_CHECK_PASSED/u.test(uvRun.stdout) &&
    uvRun.exitCode === 0;
  const uvAbsent = !uvMutation.source.includes(UV_COPY);

  const isolationMutant = await loadMutant(temporaryRoot, {
    file: "docker.mjs",
    anchor: '      observedHostMode === "none" &&',
    replacement: '      observedHostMode === "bridge" && // MUTANT: accept the wrong Docker network mode',
    query: "network-mode-assertion"
  });
  const mutatedIsolationRun = await isolationMutant.module.runInWitnessContainer({
    image: image.imageId || DEFAULT_IMAGE,
    workspace: UV_FIXTURE,
    command: "true",
    networkMode: "none",
    timeoutSeconds: 30,
    copyWorkspaceToTmpfs: true
  });
  const isolationPresent = uvRun.networkMode === "none" &&
    uvRun.networkInterfaces.length === 1 &&
    uvRun.networkInterfaces[0] === "lo" &&
    uvRun.networkAssertionPassed === true;
  const isolationDisabled = mutatedIsolationRun.networkMode === "none" &&
    mutatedIsolationRun.networkAssertionPassed === false;

  const networkReport = await runPreflight({
    repo: NETWORK_FIXTURE,
    check: "npm test",
    image: image.imageId || DEFAULT_IMAGE,
    timeoutSeconds: 30,
    cwd: WITNESS_ROOT
  }, { temporaryParent: temporaryRoot });
  const networkMutation = await loadMutant(temporaryRoot, {
    file: "observe.mjs",
    anchor: "  const networkFailure = result.exitCode !== 0 && NETWORK_PATTERNS.some((pattern) => pattern.test(output));",
    replacement: "  const networkFailure = false && result.exitCode !== 0 && NETWORK_PATTERNS.some((pattern) => pattern.test(output)); // MUTANT: check-level network classification disabled",
    query: "network-classification"
  });
  const mutatedObservation = networkMutation.module.interpretExecution({
    exitCode: 1,
    stdout: "",
    stderr: "TypeError: fetch failed",
    timedOut: false
  }, { command: "npm test", definition: { declared: true } });
  const checkAttempts = networkReport.attempts.filter((attempt) => attempt.checkAttempt);
  const networkClassified = networkReport.classification === "REQUIRES_NETWORK" &&
    checkAttempts.length === 1 &&
    networkReport.dependencyPreparation.attempted === false &&
    checkAttempts.every((attempt) => attempt.networkMode === "none");

  const authored = JSON.parse(await readFile(
    resolve(WITNESS_ROOT, "test/fixtures/verification-contract/worked-averray-send-test.json"),
    "utf8"
  ));
  authored.checks.targeted[0].command = ["make", "gate"];
  authored.candidate.protected_paths.push("Makefile");
  const authoredValidation = validateVerificationContract(authored);
  const rule5Held = !authoredValidation.valid && authoredValidation.issues.some((issue) =>
    issue.code === REJECTION_RULES.JUDGING_COMMAND_PROTECTED.code);

  const evidence = {
    schemaVersion: "averray.witness.implementation-ceiling-drills/v1",
    image: { tag: DEFAULT_IMAGE, imageId: image.imageId, built: image.built },
    uvToolchain: {
      mutation: { anchorOccurrences: uvMutation.anchorOccurrences, applied: uvMutation.applied },
      present: {
        status: status(uvPresent),
        exitCode: uvRun.exitCode,
        output: uvRun.stdout.trim(),
        pin: UV_COPY
      },
      omitted: { status: uvAbsent ? "RED" : "GREEN" }
    },
    egressIsolation: {
      mutation: isolationMutant.mutation,
      enforced: {
        status: status(isolationPresent),
        dockerNetworkMode: uvRun.networkMode,
        interfacesInsideContainer: uvRun.networkInterfaces,
        workspaceMode: uvRun.workspaceMode
      },
      assertionDisabled: {
        status: isolationDisabled ? "RED" : "GREEN",
        dockerNetworkMode: mutatedIsolationRun.networkMode,
        networkAssertionPassed: mutatedIsolationRun.networkAssertionPassed
      }
    },
    checkLevelNetworkDependency: {
      mutation: networkMutation.mutation,
      classifiedWithoutRetry: {
        status: status(networkClassified),
        classification: networkReport.classification,
        checkAttempts: checkAttempts.length,
        cachePopulationAttempted: networkReport.dependencyPreparation.attempted,
        reason: networkReport.classificationReason
      },
      classifierDisabled: {
        status: mutatedObservation.networkFailure === false ? "RED" : "GREEN",
        networkFailure: mutatedObservation.networkFailure
      }
    },
    authoredRule5Regression: {
      status: status(rule5Held),
      issueCodes: authoredValidation.issues.map((issue) => issue.code)
    }
  };

  await mkdir(dirname(options.out), { recursive: true });
  await writeFile(options.out, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

  const mutationsApplied = [uvMutation, isolationMutant.mutation, networkMutation.mutation]
    .every((entry) => entry.anchorOccurrences === 1 && entry.applied === true);
  const allPassed = uvPresent && uvAbsent && isolationPresent && isolationDisabled &&
    networkClassified && mutatedObservation.networkFailure === false && rule5Held && mutationsApplied;
  if (!allPassed) process.exitCode = 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

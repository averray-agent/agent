#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { materializeRepository } from "../src/materialize.mjs";
import {
  BASE_CHECK_CAUSES,
  BASE_CHECK_ERROR_SUBCAUSES,
  diagnoseBaseCheckUnavailability,
  evaluatePrShadowStatic
} from "../src/pr-shadow.mjs";
import {
  REJECTION_RULES,
  validateVerificationContract
} from "../src/verification-contract.mjs";
import { runProcess } from "../src/process.mjs";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = resolve(WITNESS_ROOT, "src");

function parseArgs(argv) {
  const result = { out: resolve(WITNESS_ROOT, "evidence", "coverage-diagnosis-drills-pkt-witness-008.json") };
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index] !== "--out" || !argv[index + 1]) throw new Error(`${argv[index]} requires a value`);
    result.out = resolve(argv[index + 1]);
  }
  return result;
}

async function git(cwd, args) {
  const result = await runProcess("git", args, { cwd, timeoutSeconds: 30 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "git failed");
  return result.stdout.trim();
}

async function shadowFixture(root) {
  const repository = join(root, "repository");
  await mkdir(join(repository, "docs"), { recursive: true });
  await writeFile(join(repository, "Makefile"), "gate:\n\t@true\n");
  await writeFile(join(repository, "docs", "README.md"), "before\n");
  await git(repository, ["init"]);
  await git(repository, ["config", "user.name", "Witness diagnosis drill"]);
  await git(repository, ["config", "user.email", "witness@example.invalid"]);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "base"]);
  const baseCommit = await git(repository, ["rev-parse", "HEAD"]);
  await writeFile(join(repository, "docs", "README.md"), "after\n");
  const diffText = `${await git(repository, ["diff", "--binary", "--full-index", "--no-renames", baseCommit, "--"])}\n`;
  const patchPath = join(root, "candidate.patch");
  await writeFile(patchPath, diffText);
  const baseRoot = join(root, "base");
  await materializeRepository({ repo: repository, commit: baseCommit, destination: baseRoot, cwd: root });
  return {
    entry: {
      id: "drill/make#1",
      repository: "drill/make",
      number: 1,
      category: "fixture",
      selectionReason: "shadow-only relaxation drill",
      check: { id: "gate", command: ["make", "gate"], workingDirectory: "." },
      protectedPaths: ["Makefile"],
      allowedPaths: ["**"],
      maximumChangedFiles: 10,
      timeoutSeconds: 30
    },
    metadata: {
      repository: "drill/make",
      number: 1,
      title: "Make drill",
      url: "https://example.invalid/drill/make/1",
      mergedAt: "2026-08-18T00:00:00Z",
      baseCommit,
      headCommit: "b".repeat(40)
    },
    patchPath,
    baseRoot,
    diffText
  };
}

async function loadMutant(root, { file, anchor, replacement, query }) {
  const source = await readFile(resolve(SOURCE_ROOT, file), "utf8");
  const anchorOccurrences = source.split(anchor).length - 1;
  const mutated = anchorOccurrences === 1 ? source.replace(anchor, replacement) : source;
  const applied = anchorOccurrences === 1 && mutated !== source && !mutated.includes(anchor);
  const mutantRoot = join(root, `mutant-${query}`);
  await cp(SOURCE_ROOT, mutantRoot, { recursive: true });
  await writeFile(join(mutantRoot, file), mutated);
  const module = await import(`${pathToFileURL(join(mutantRoot, file)).href}?seen-red=${query}`);
  return { module, mutation: { anchorOccurrences, applied } };
}

function baseReport(output) {
  return {
    classification: "FROZEN_DEPENDENCIES",
    checkCommandExists: true,
    checkDefinition: { declared: true },
    basePassed: false,
    attempts: [{ checkAttempt: true, stdout: output, stderr: "" }]
  };
}

const options = parseArgs(process.argv.slice(2));
const temporaryRoot = await mkdtemp(join(tmpdir(), "witness-coverage-diagnosis-drill-"));
try {
  const fixture = await shadowFixture(temporaryRoot);
  const normalShadow = await evaluatePrShadowStatic({
    ...fixture,
    candidateRoot: join(temporaryRoot, "normal-candidate")
  });
  const shadowMutant = await loadMutant(temporaryRoot, {
    file: "pr-shadow.mjs",
    anchor: "  const shadowAllowsUnprotectedCommand = true;",
    replacement: "  const shadowAllowsUnprotectedCommand = false; // MUTANT: restore authored-contract rule in shadow",
    query: "shadow-relaxation"
  });
  const mutatedShadow = await shadowMutant.module.evaluatePrShadowStatic({
    ...fixture,
    candidateRoot: join(temporaryRoot, "mutated-candidate")
  });

  const authored = JSON.parse(await readFile(
    resolve(WITNESS_ROOT, "test", "fixtures", "verification-contract", "worked-averray-send-test.json"),
    "utf8"
  ));
  authored.checks.targeted[0].command = ["make", "gate"];
  authored.candidate.protected_paths.push("Makefile");
  const normalAuthored = validateVerificationContract(authored);
  const authoredMutant = await loadMutant(temporaryRoot, {
    file: "verification-contract.mjs",
    anchor: "      if (!resolution.resolved) {",
    replacement: "      if (false && !resolution.resolved) { // MUTANT: authored rule 5 disabled",
    query: "authored-rule-5"
  });
  const mutatedAuthored = authoredMutant.module.validateVerificationContract(authored);

  const timeoutReport = baseReport("error: test timed out after 60000ms");
  const normalTimeout = diagnoseBaseCheckUnavailability(timeoutReport);
  const timeoutMutant = await loadMutant(temporaryRoot, {
    file: "pr-shadow.mjs",
    anchor: "      subcause: BASE_CHECK_ERROR_SUBCAUSES.CHECK_TIMEOUT,",
    replacement: "      subcause: BASE_CHECK_ERROR_SUBCAUSES.UNCLASSIFIED, // MUTANT: timeout cause disabled",
    query: "timeout-cause"
  });
  const mutatedTimeout = timeoutMutant.module.diagnoseBaseCheckUnavailability(timeoutReport);

  const prerequisitesReport = baseReport("make: uv: No such file or directory");
  const normalPrerequisites = diagnoseBaseCheckUnavailability(prerequisitesReport);
  const prerequisitesMutant = await loadMutant(temporaryRoot, {
    file: "pr-shadow.mjs",
    anchor: "      subcause: BASE_CHECK_ERROR_SUBCAUSES.MISSING_CI_PREREQUISITES,",
    replacement: "      subcause: BASE_CHECK_ERROR_SUBCAUSES.UNCLASSIFIED, // MUTANT: prerequisites cause disabled",
    query: "prerequisites-cause"
  });
  const mutatedPrerequisites = prerequisitesMutant.module.diagnoseBaseCheckUnavailability(prerequisitesReport);

  const failedReport = baseReport("not ok 1 - expected value\nAssertionError");
  const normalFailed = diagnoseBaseCheckUnavailability(failedReport);
  const failedMutant = await loadMutant(temporaryRoot, {
    file: "pr-shadow.mjs",
    anchor: "      cause: BASE_CHECK_CAUSES.CHECK_FAILED,",
    replacement: "      cause: BASE_CHECK_CAUSES.CHECK_ERRORED, // MUTANT: red-base cause disabled",
    query: "check-failed-cause"
  });
  const mutatedFailed = failedMutant.module.diagnoseBaseCheckUnavailability(failedReport);

  const materializationReport = {
    classification: "REQUIRES_NETWORK",
    classificationReason: "dependency closure could not be prepared offline",
    checkCommandExists: true,
    checkDefinition: { declared: true },
    basePassed: false,
    attempts: []
  };
  const normalMaterialization = diagnoseBaseCheckUnavailability(materializationReport);
  const materializationMutant = await loadMutant(temporaryRoot, {
    file: "pr-shadow.mjs",
    anchor: "      cause: BASE_CHECK_CAUSES.MATERIALIZATION_FAILED,",
    replacement: "      cause: BASE_CHECK_CAUSES.CHECK_ERRORED, // MUTANT: materialization cause disabled",
    query: "materialization-cause"
  });
  const mutatedMaterialization = materializationMutant.module.diagnoseBaseCheckUnavailability(materializationReport);

  const evidence = {
    schemaVersion: "averray.witness.coverage-diagnosis-drills/v1",
    authoredContractRule5: {
      mutation: authoredMutant.mutation,
      rulePresent: {
        status: !normalAuthored.valid && normalAuthored.issues.some((issue) =>
          issue.code === REJECTION_RULES.JUDGING_COMMAND_PROTECTED.code) ? "GREEN" : "RED"
      },
      ruleDisabled: { status: mutatedAuthored.valid ? "RED" : "GREEN", valid: mutatedAuthored.valid }
    },
    shadowUnprotectedCommand: {
      mutation: shadowMutant.mutation,
      relaxationPresent: {
        status: normalShadow.verdict === null && normalShadow.judgingCommandProtected === false ? "GREEN" : "RED",
        verdict: normalShadow.verdict || "STATIC_CLEAN",
        judgingCommandProtected: normalShadow.judgingCommandProtected
      },
      relaxationDisabled: {
        status: mutatedShadow.reason === "unresolvable_command" ? "RED" : "GREEN",
        verdict: mutatedShadow.verdict,
        reason: mutatedShadow.reason
      }
    },
    baseCheckCauses: {
      checkTimeout: {
        mutation: timeoutMutant.mutation,
        causePresent: {
          status: normalTimeout.cause === BASE_CHECK_CAUSES.CHECK_ERRORED &&
            normalTimeout.subcause === BASE_CHECK_ERROR_SUBCAUSES.CHECK_TIMEOUT ? "GREEN" : "RED",
          diagnosis: normalTimeout
        },
        causeDisabled: {
          status: mutatedTimeout.subcause !== BASE_CHECK_ERROR_SUBCAUSES.CHECK_TIMEOUT ? "RED" : "GREEN",
          diagnosis: mutatedTimeout
        }
      },
      missingCiPrerequisites: {
        mutation: prerequisitesMutant.mutation,
        causePresent: {
          status: normalPrerequisites.cause === BASE_CHECK_CAUSES.CHECK_ERRORED &&
            normalPrerequisites.subcause === BASE_CHECK_ERROR_SUBCAUSES.MISSING_CI_PREREQUISITES ? "GREEN" : "RED",
          diagnosis: normalPrerequisites
        },
        causeDisabled: {
          status: mutatedPrerequisites.subcause !== BASE_CHECK_ERROR_SUBCAUSES.MISSING_CI_PREREQUISITES ? "RED" : "GREEN",
          diagnosis: mutatedPrerequisites
        }
      },
      checkFailed: {
        mutation: failedMutant.mutation,
        causePresent: {
          status: normalFailed.cause === BASE_CHECK_CAUSES.CHECK_FAILED && normalFailed.structural ? "GREEN" : "RED",
          diagnosis: normalFailed
        },
        causeDisabled: {
          status: mutatedFailed.cause !== BASE_CHECK_CAUSES.CHECK_FAILED ? "RED" : "GREEN",
          diagnosis: mutatedFailed
        }
      },
      materializationFailed: {
        mutation: materializationMutant.mutation,
        causePresent: {
          status: normalMaterialization.cause === BASE_CHECK_CAUSES.MATERIALIZATION_FAILED &&
            !normalMaterialization.structural ? "GREEN" : "RED",
          diagnosis: normalMaterialization
        },
        causeDisabled: {
          status: mutatedMaterialization.cause !== BASE_CHECK_CAUSES.MATERIALIZATION_FAILED ? "RED" : "GREEN",
          diagnosis: mutatedMaterialization
        }
      }
    }
  };

  await mkdir(dirname(options.out), { recursive: true });
  await writeFile(options.out, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  const mutations = [
    authoredMutant.mutation,
    shadowMutant.mutation,
    timeoutMutant.mutation,
    prerequisitesMutant.mutation,
    failedMutant.mutation,
    materializationMutant.mutation
  ];
  const passed = mutations.every((mutation) => mutation.anchorOccurrences === 1 && mutation.applied) &&
    evidence.authoredContractRule5.rulePresent.status === "GREEN" &&
    evidence.authoredContractRule5.ruleDisabled.status === "RED" &&
    evidence.shadowUnprotectedCommand.relaxationPresent.status === "GREEN" &&
    evidence.shadowUnprotectedCommand.relaxationDisabled.status === "RED" &&
    evidence.baseCheckCauses.checkTimeout.causePresent.status === "GREEN" &&
    evidence.baseCheckCauses.checkTimeout.causeDisabled.status === "RED" &&
    evidence.baseCheckCauses.missingCiPrerequisites.causePresent.status === "GREEN" &&
    evidence.baseCheckCauses.missingCiPrerequisites.causeDisabled.status === "RED" &&
    evidence.baseCheckCauses.checkFailed.causePresent.status === "GREEN" &&
    evidence.baseCheckCauses.checkFailed.causeDisabled.status === "RED" &&
    evidence.baseCheckCauses.materializationFailed.causePresent.status === "GREEN" &&
    evidence.baseCheckCauses.materializationFailed.causeDisabled.status === "RED";
  if (!passed) process.exitCode = 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

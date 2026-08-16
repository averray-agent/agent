#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { makeTreeWritable } from "../src/materialize.mjs";
import {
  loadVerificationContract,
  validateVerificationContract,
  validateVerificationContractAtFreeze
} from "../src/verification-contract.mjs";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = resolve(WITNESS_ROOT, "src");
const WORKED_PATH = resolve(WITNESS_ROOT, "examples", "averray-send-test", "contract-v1.1.json");
const BASE_ROOT = resolve(WITNESS_ROOT, "corpus", "adversarial", "seed");
const verificationSource = await readFile(resolve(SOURCE_ROOT, "verification-contract.mjs"), "utf8");
const freezeSource = await readFile(resolve(SOURCE_ROOT, "freeze-validation.mjs"), "utf8");
const workedJson = JSON.parse(await readFile(WORKED_PATH, "utf8"));

const MUTATIONS = Object.freeze([
  {
    id: "artifact_locator_path",
    anchor: "    requireRepositoryPath(issues, artifact.locator.path, `${path}.locator.path`, { allowDot: false });",
    replacement: "    // MUTANT: artifact locator path guard disabled",
    mutate(contract) {
      contract.subject.acquisition.git_bundle.locator = { kind: "path", path: "../outside.bundle" };
    }
  },
  {
    id: "artifact_format",
    anchor: "  requireEnum(issues, artifact.format, `${path}.format`, formats);",
    replacement: "  // MUTANT: artifact format guard disabled",
    mutate(contract) { contract.subject.acquisition.git_bundle.format = "file"; }
  },
  {
    id: "artifact_sha256",
    anchor: "  requirePattern(issues, artifact.sha256, `${path}.sha256`, SHA256, \"VCV11_SCHEMA_SHA256\", \"64 lowercase hex characters\");",
    replacement: "  // MUTANT: artifact digest guard disabled",
    mutate(contract) { contract.checks.hidden.artifact.sha256 = "not-a-digest"; }
  },
  {
    id: "hidden_command_manifest",
    anchor: "        if (Array.isArray(hidden.command) && isNonEmptyString(hidden.mount_path) &&",
    replacement: "        if (false && Array.isArray(hidden.command) && isNonEmptyString(hidden.mount_path) &&",
    mutate(contract) { contract.checks.hidden.command = ["node", "--test", "test/duration.test.js"]; }
  },
  {
    id: "working_directory",
    anchor: "        requireRepositoryPath(issues, hidden.working_directory, \"checks.hidden.working_directory\");",
    replacement: "        // MUTANT: hidden working-directory guard disabled",
    mutate(contract) { contract.checks.hidden.working_directory = "../outside"; }
  },
  {
    id: "temporary_storage",
    anchor: "      version === VERIFICATION_CONTRACT_SCHEMA_VERSION ? \"temporary_storage_mb\" : \"writable_storage_mb\",",
    replacement: "      \"writable_storage_mb\", // MUTANT: unenforceable v1 field restored",
    mutate(contract) {
      contract.resources.writable_storage_mb = contract.resources.temporary_storage_mb;
      delete contract.resources.temporary_storage_mb;
    }
  },
  {
    id: "contract_attribution",
    anchor: `      requireStringArray(
        issues,
        contract.inconclusive_policy.contract_attributable,
        "inconclusive_policy.contract_attributable"
      );`,
    replacement: "      // MUTANT: contract-attributable reason manifest guard disabled",
    mutate(contract) { delete contract.inconclusive_policy.contract_attributable; }
  }
]);

async function loadStaticMutant(drill, temporaryRoot) {
  const root = resolve(temporaryRoot, drill.id);
  await mkdir(root);
  await cp(resolve(SOURCE_ROOT, "constants.mjs"), resolve(root, "constants.mjs"));
  const anchorOccurrences = verificationSource.split(drill.anchor).length - 1;
  const mutatedSource = anchorOccurrences === 1
    ? verificationSource.replace(drill.anchor, drill.replacement)
    : verificationSource;
  const mutationApplied = anchorOccurrences === 1 &&
    mutatedSource !== verificationSource &&
    !mutatedSource.includes(drill.anchor) &&
    mutatedSource.includes(drill.replacement);
  const mutantPath = resolve(root, "verification-contract.mjs");
  await writeFile(mutantPath, mutatedSource);
  const module = await import(`${pathToFileURL(mutantPath).href}?mutation=${drill.id}`);
  return { module, anchorOccurrences, mutationApplied };
}

function sandboxResult(exitCode) {
  return {
    exitCode,
    signal: null,
    stdout: "",
    stderr: "",
    spawnError: null,
    timedOut: false,
    outputTruncated: false,
    seconds: 0,
    containerId: "mutation-container",
    networkMode: "none",
    networkInterfaces: ["lo"],
    networkAssertionPassed: true
  };
}

async function materializeFixture({ destination }) {
  await cp(BASE_ROOT, destination, { recursive: true, errorOnExist: true });
  await makeTreeWritable(destination);
  return {
    path: destination,
    commit: workedJson.subject.acquisition.base_commit,
    source: "mutation-fixture",
    sourceType: "fixture",
    bindingVerified: true,
    seconds: 0
  };
}

async function loadFreezeMutant(temporaryRoot) {
  const root = resolve(temporaryRoot, "freeze_observed_base");
  await mkdir(root);
  for (const file of [
    "artifacts.mjs",
    "constants.mjs",
    "contract-runtime.mjs",
    "docker.mjs",
    "materialize.mjs",
    "process.mjs",
    "git-bundle-source.mjs",
    "verification-contract.mjs"
  ]) {
    await cp(resolve(SOURCE_ROOT, file), resolve(root, file));
  }
  const anchor = "      } else if (outcome !== \"fail\") {";
  const replacement = "      } else if (false) { // MUTANT: observed-base-failure guard disabled";
  const anchorOccurrences = freezeSource.split(anchor).length - 1;
  const mutatedSource = anchorOccurrences === 1 ? freezeSource.replace(anchor, replacement) : freezeSource;
  const mutationApplied = anchorOccurrences === 1 &&
    mutatedSource !== freezeSource &&
    !mutatedSource.includes(anchor) &&
    mutatedSource.includes(replacement);
  const mutantPath = resolve(root, basename("freeze-validation.mjs"));
  await writeFile(mutantPath, mutatedSource);
  const module = await import(`${pathToFileURL(mutantPath).href}?mutation=observed-base`);
  return { module, anchorOccurrences, mutationApplied };
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "witness-v11-mutations-"));
const output = {};
try {
  for (const drill of MUTATIONS) {
    const malformed = structuredClone(workedJson);
    drill.mutate(malformed);
    const guarded = validateVerificationContract(malformed);
    const corrected = validateVerificationContract(workedJson);
    const mutant = await loadStaticMutant(drill, temporaryRoot);
    const mutated = mutant.module.validateVerificationContract(malformed);
    output[drill.id] = {
      mutation: { anchorOccurrences: mutant.anchorOccurrences, applied: mutant.mutationApplied },
      malformedWithGuard: { status: guarded.valid ? "RED" : "GREEN", result: guarded.valid ? "ACCEPTED" : "REJECTED" },
      corrected: { status: corrected.valid ? "GREEN" : "RED", result: corrected.valid ? "ACCEPTED" : "REJECTED" },
      seenRedWithGuardDisabled: { status: mutated.valid ? "RED" : "GREEN", result: mutated.valid ? "ACCEPTED" : "REJECTED" }
    };
  }

  const contract = await loadVerificationContract(WORKED_PATH);
  const dependencies = {
    materialize: materializeFixture,
    ensureImage: async () => ({ image: "fixture", imageId: "sha256:fixture" }),
    runContainer: async () => sandboxResult(0),
    temporaryParent: temporaryRoot
  };
  const guarded = await validateVerificationContractAtFreeze(contract, { cwd: dirname(WORKED_PATH) }, dependencies);
  const mutant = await loadFreezeMutant(temporaryRoot);
  const mutated = await mutant.module.confirmVerificationContractBase(
    contract,
    { cwd: dirname(WORKED_PATH) },
    dependencies
  );
  output.observed_base_failure = {
    mutation: { anchorOccurrences: mutant.anchorOccurrences, applied: mutant.mutationApplied },
    passingBaseWithGuard: { status: guarded.valid ? "RED" : "GREEN", result: guarded.valid ? "ACCEPTED" : "REJECTED" },
    seenRedWithGuardDisabled: { status: mutated.valid ? "RED" : "GREEN", result: mutated.valid ? "ACCEPTED" : "REJECTED" }
  };
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: "averray.verification-contract-drills/v1.1",
  drills: output
}, null, 2)}\n`);

const passed = Object.values(output).every((result) =>
  result.mutation.anchorOccurrences === 1 &&
  result.mutation.applied === true &&
  Object.entries(result)
    .filter(([key]) => key !== "mutation")
    .every(([key, value]) => key.startsWith("seenRed") ? value.status === "RED" : value.status === "GREEN")
);
if (!passed) process.exitCode = 1;

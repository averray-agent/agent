#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { materializeContractSource } from "../src/contract-runtime.mjs";
import { executeVerificationContract } from "../src/executor.mjs";
import { materializeGitBundleSource } from "../src/git-bundle-source.mjs";
import { makeTreeWritable } from "../src/materialize.mjs";
import { runProcess } from "../src/process.mjs";
import {
  loadVerificationContract,
  validateVerificationContractAtFreeze
} from "../src/verification-contract.mjs";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = resolve(WITNESS_ROOT, "src");
const EXAMPLE_ROOT = resolve(WITNESS_ROOT, "examples", "averray-send-test");
const WORKED_PATH = resolve(EXAMPLE_ROOT, "contract-v1.1.json");
const BASE_ROOT = resolve(WITNESS_ROOT, "corpus", "adversarial", "seed");
const CORRECT_PATCH = resolve(WITNESS_ROOT, "corpus", "adversarial", "cases", "pass-correct.patch");

function result(status, value) {
  return { status, result: value };
}

function artifactFor(bytes, path) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    locator: { kind: "path", path },
    format: "git-bundle"
  };
}

async function git(args, cwd) {
  const output = await runProcess("git", args, { cwd, timeoutSeconds: 30 });
  if (output.exitCode !== 0) {
    throw new Error(output.spawnError || output.stderr || output.stdout || `git ${args.join(" ")} failed`);
  }
  return output.stdout.trim();
}

async function fixture(root) {
  const worked = await loadVerificationContract(WORKED_PATH);
  const repository = join(root, "real-repository");
  const source = await materializeContractSource({ contract: worked, destination: repository, cwd: EXAMPLE_ROOT });
  await git(["config", "user.name", "Witness binding drill"], repository);
  await git(["config", "user.email", "witness@example.invalid"], repository);
  await writeFile(join(repository, "different-commit.txt"), "this artifact is a different tree\n");
  await git(["add", "different-commit.txt"], repository);
  await git(["commit", "-m", "binding drill: different tree"], repository);
  const differentCommit = await git(["rev-parse", "HEAD"], repository);
  await git(["branch", "artifact-commit", differentCommit], repository);
  const path = join(root, "different-commit.bundle");
  await git(["bundle", "create", path, "refs/heads/artifact-commit"], repository);
  const bytes = await readFile(path);
  await writeFile(join(root, "unitless.test.mjs"), await readFile(join(EXAMPLE_ROOT, "unitless.test.mjs")));
  return {
    artifact: artifactFor(bytes, "different-commit.bundle"),
    baseCommit: source.commit,
    bytes,
    differentCommit
  };
}

async function contractFor(sourceFixture, baseCommit = sourceFixture.baseCommit) {
  const contract = JSON.parse(await readFile(WORKED_PATH, "utf8"));
  contract.subject.acquisition.base_commit = baseCommit;
  contract.subject.acquisition.git_bundle = sourceFixture.artifact;
  return contract;
}

function sandboxResult(exitCode, id = "binding-drill-container") {
  return {
    exitCode,
    signal: null,
    stdout: "",
    stderr: "",
    spawnError: null,
    timedOut: false,
    outputTruncated: false,
    seconds: 0,
    containerId: id,
    networkMode: "none",
    networkInterfaces: ["lo"],
    networkAssertionPassed: true
  };
}

async function mutateSourceTree(root, file, anchor, replacement, id) {
  const destination = join(root, id);
  await cp(SOURCE_ROOT, destination, { recursive: true });
  const path = join(destination, file);
  const source = await readFile(path, "utf8");
  const anchorOccurrences = source.split(anchor).length - 1;
  const mutated = anchorOccurrences === 1 ? source.replace(anchor, replacement) : source;
  const applied = anchorOccurrences === 1 && mutated !== source &&
    !mutated.includes(anchor) && mutated.includes(replacement);
  await writeFile(path, mutated);
  return { destination, anchorOccurrences, applied };
}

async function materializeFixture({ destination }) {
  await cp(BASE_ROOT, destination, { recursive: true, errorOnExist: true });
  await makeTreeWritable(destination);
  return {
    path: destination,
    commit: "42571061ca9b6da8c6aca908f1ee1df1dab4e10a",
    source: "attribution-mutation-fixture",
    sourceType: "fixture",
    bindingVerified: true,
    seconds: 0
  };
}

async function mismatchReport(executorModule, temporaryParent) {
  return executorModule.executeVerificationContract({
    contract: await loadVerificationContract(WORKED_PATH),
    candidatePatch: CORRECT_PATCH,
    cwd: EXAMPLE_ROOT
  }, {
    materialize: materializeFixture,
    temporaryParent,
    ensureImage: async () => ({ image: "fixture", imageId: "sha256:fixture" }),
    runContainer: async (options) => sandboxResult(0, `${options.phase}-${options.checkId}`)
  });
}

const root = await mkdtemp(join(tmpdir(), "witness-binding-drills-"));
const drills = {};
try {
  const sourceFixture = await fixture(root);
  const wrongContract = await contractFor(sourceFixture);
  let guardedContainers = 0;
  const guarded = await validateVerificationContractAtFreeze(wrongContract, { cwd: root }, {
    temporaryParent: root,
    ensureImage: async () => ({ image: "unused" }),
    runContainer: async () => {
      guardedContainers += 1;
      return sandboxResult(1);
    }
  });
  const corrected = await validateVerificationContractAtFreeze(
    await contractFor(sourceFixture, sourceFixture.differentCommit),
    { cwd: root },
    {
      temporaryParent: root,
      ensureImage: async () => ({ image: "fixture", imageId: "sha256:fixture" }),
      runContainer: async () => sandboxResult(1)
    }
  );

  const bindingAnchor = "  assertDeclaredBundleBinding(advertisedHeads, checkedOutCommit, declaredCommit);";
  const bindingReplacement = "  // MUTANT: declared-commit binding disabled";
  const bindingMutant = await mutateSourceTree(
    root,
    "git-bundle-source.mjs",
    bindingAnchor,
    bindingReplacement,
    "binding-mutant"
  );
  const mutantFreeze = await import(
    `${pathToFileURL(join(bindingMutant.destination, "freeze-validation.mjs")).href}?mutation=binding`
  );
  let mutantContainers = 0;
  const mutantAccepted = await mutantFreeze.confirmVerificationContractBase(wrongContract, { cwd: root }, {
    temporaryParent: root,
    ensureImage: async () => ({ image: "fixture", imageId: "sha256:fixture" }),
    runContainer: async () => {
      mutantContainers += 1;
      return sandboxResult(1);
    }
  });
  drills.different_commit = {
    mutation: {
      anchorOccurrences: bindingMutant.anchorOccurrences,
      applied: bindingMutant.applied
    },
    differentCommitWithGuard: result(guarded.valid ? "RED" : "GREEN", guarded.valid ? "ACCEPTED" : "REJECTED"),
    correctedDeclaredCommit: result(corrected.valid ? "GREEN" : "RED", corrected.valid ? "ACCEPTED" : "REJECTED"),
    seenRedWithBindingDisabled: result(mutantAccepted.valid ? "RED" : "GREEN", mutantAccepted.valid ? "ACCEPTED" : "REJECTED")
  };
  drills.pre_baseline_rejection = {
    mutation: {
      anchorOccurrences: bindingMutant.anchorOccurrences,
      applied: bindingMutant.applied
    },
    guardedContainerCount: result(guardedContainers === 0 ? "GREEN" : "RED", guardedContainers),
    seenRedWithBindingDisabled: result(mutantContainers > 0 ? "RED" : "GREEN", mutantContainers)
  };

  const tampered = Buffer.from(sourceFixture.bytes);
  const refOffset = tampered.indexOf("refs/heads/artifact-commit");
  if (refOffset === -1) throw new Error("tamper anchor not found in Git bundle header");
  tampered[refOffset + "refs/heads/artifact-".length] = "x".charCodeAt(0);
  await writeFile(join(root, "tampered.bundle"), tampered);
  const tamperedArtifact = {
    ...sourceFixture.artifact,
    locator: { kind: "path", path: "tampered.bundle" }
  };
  let guardedTamperRejected = false;
  try {
    await materializeGitBundleSource({
      artifact: tamperedArtifact,
      declaredCommit: sourceFixture.differentCommit,
      destination: join(root, "guarded-tamper"),
      baseDirectory: root
    });
  } catch {
    guardedTamperRejected = true;
  }
  const digestAnchor = "  if (digest !== artifact.sha256) {";
  const digestReplacement = "  if (false) { // MUTANT: artifact digest comparison disabled";
  const digestMutant = await mutateSourceTree(
    root,
    "artifacts.mjs",
    digestAnchor,
    digestReplacement,
    "digest-mutant"
  );
  const mutantBinding = await import(
    `${pathToFileURL(join(digestMutant.destination, "git-bundle-source.mjs")).href}?mutation=digest`
  );
  let mutantTamperAccepted = false;
  try {
    const materialized = await mutantBinding.materializeGitBundleSource({
      artifact: tamperedArtifact,
      declaredCommit: sourceFixture.differentCommit,
      destination: join(root, "mutant-tamper"),
      baseDirectory: root
    });
    mutantTamperAccepted = materialized.bindingVerified === true;
  } catch {
    mutantTamperAccepted = false;
  }
  const correctedMaterialized = await materializeGitBundleSource({
    artifact: sourceFixture.artifact,
    declaredCommit: sourceFixture.differentCommit,
    destination: join(root, "corrected-tamper"),
    baseDirectory: root
  });
  drills.tampered_artifact = {
    mutation: { anchorOccurrences: digestMutant.anchorOccurrences, applied: digestMutant.applied },
    tamperedWithGuard: result(guardedTamperRejected ? "GREEN" : "RED", guardedTamperRejected ? "REJECTED" : "ACCEPTED"),
    correctedArtifact: result(correctedMaterialized.bindingVerified ? "GREEN" : "RED", "ACCEPTED"),
    seenRedWithDigestDisabled: result(mutantTamperAccepted ? "RED" : "GREEN", mutantTamperAccepted ? "ACCEPTED" : "REJECTED")
  };

  const truncated = sourceFixture.bytes.subarray(0, sourceFixture.bytes.length - 32);
  await writeFile(join(root, "truncated.bundle"), truncated);
  const truncatedArtifact = artifactFor(truncated, "truncated.bundle");
  let guardedTruncationRejected = false;
  try {
    await materializeGitBundleSource({
      artifact: truncatedArtifact,
      declaredCommit: sourceFixture.differentCommit,
      destination: join(root, "guarded-truncation"),
      baseDirectory: root
    });
  } catch {
    guardedTruncationRejected = true;
  }
  const graphAnchor = "  const binding = await verifyAndCheckoutGitBundle(verified.bytes, declaredCommit, destination);";
  const graphReplacement = "  const binding = { checkedOutCommit: declaredCommit, tree: null }; // MUTANT: Git object-graph verification disabled";
  const graphMutant = await mutateSourceTree(
    root,
    "git-bundle-source.mjs",
    graphAnchor,
    graphReplacement,
    "graph-mutant"
  );
  const mutantGraph = await import(
    `${pathToFileURL(join(graphMutant.destination, "git-bundle-source.mjs")).href}?mutation=graph`
  );
  let mutantTruncationAccepted = false;
  try {
    const materialized = await mutantGraph.materializeGitBundleSource({
      artifact: truncatedArtifact,
      declaredCommit: sourceFixture.differentCommit,
      destination: join(root, "mutant-truncation"),
      baseDirectory: root
    });
    mutantTruncationAccepted = materialized.bindingVerified === true;
  } catch {
    mutantTruncationAccepted = false;
  }
  drills.truncated_artifact = {
    mutation: { anchorOccurrences: graphMutant.anchorOccurrences, applied: graphMutant.applied },
    truncatedWithGuard: result(
      guardedTruncationRejected ? "GREEN" : "RED",
      guardedTruncationRejected ? "REJECTED" : "ACCEPTED"
    ),
    correctedArtifact: result(correctedMaterialized.bindingVerified ? "GREEN" : "RED", "ACCEPTED"),
    seenRedWithGraphVerificationDisabled: result(
      mutantTruncationAccepted ? "RED" : "GREEN",
      mutantTruncationAccepted ? "ACCEPTED" : "REJECTED"
    )
  };

  const guardedMismatch = await mismatchReport({ executeVerificationContract }, root);
  const attributionMutant = await mutateSourceTree(
    root,
    "executor.mjs",
    "const BASELINE_MISMATCH_ATTRIBUTION = \"contract\";",
    "const BASELINE_MISMATCH_ATTRIBUTION = \"infrastructure\"; // MUTANT: contract attribution disabled",
    "attribution-mutant"
  );
  const mutantExecutor = await import(
    `${pathToFileURL(join(attributionMutant.destination, "executor.mjs")).href}?mutation=attribution`
  );
  const wronglyAttributed = await mismatchReport(mutantExecutor, root);
  drills.contract_attribution = {
    mutation: { anchorOccurrences: attributionMutant.anchorOccurrences, applied: attributionMutant.applied },
    guardedAttribution: result(
      guardedMismatch.attribution === "contract" ? "GREEN" : "RED",
      guardedMismatch.attribution
    ),
    seenRedWithAttributionDisabled: result(
      wronglyAttributed.attribution !== "contract" ? "RED" : "GREEN",
      wronglyAttributed.attribution
    )
  };

  const consequenceAnchor = "  report.workerConsequence = workerConsequenceFor(verdict);";
  const consequenceReplacement = "  report.workerConsequence = null; // MUTANT: explicit no-consequence record disabled";
  const consequenceMutant = await mutateSourceTree(
    root,
    "executor.mjs",
    consequenceAnchor,
    consequenceReplacement,
    "consequence-mutant"
  );
  const consequenceExecutor = await import(
    `${pathToFileURL(join(consequenceMutant.destination, "executor.mjs")).href}?mutation=consequence`
  );
  const missingConsequence = await mismatchReport(consequenceExecutor, root);
  drills.no_worker_consequence = {
    mutation: { anchorOccurrences: consequenceMutant.anchorOccurrences, applied: consequenceMutant.applied },
    guardedConsequence: result(
      guardedMismatch.workerConsequence === "none" ? "GREEN" : "RED",
      guardedMismatch.workerConsequence
    ),
    seenRedWithConsequenceDisabled: result(
      missingConsequence.workerConsequence !== "none" ? "RED" : "GREEN",
      missingConsequence.workerConsequence
    )
  };
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: "averray.witness.binding-drills/v1",
  drills
}, null, 2)}\n`);

const passed = Object.values(drills).every((drill) =>
  drill.mutation.anchorOccurrences === 1 &&
  drill.mutation.applied === true &&
  Object.entries(drill)
    .filter(([key]) => key !== "mutation")
    .every(([key, entry]) => key.startsWith("seenRed") ? entry.status === "RED" : entry.status === "GREEN")
);
if (!passed) process.exitCode = 1;

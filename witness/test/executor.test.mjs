import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { executeVerificationContract, VERDICTS } from "../src/executor.mjs";
import { detectIntegrityFindings, detectIntegrityViolations } from "../src/integrity.mjs";
import { makeTreeWritable } from "../src/materialize.mjs";
import { INTEGRITY_DRILLS } from "./fixtures/integrity/cases.mjs";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INTEGRITY_ROOT = resolve(WITNESS_ROOT, "test", "fixtures", "integrity");
const BASE_ROOT = resolve(INTEGRITY_ROOT, "base");
const PATCH_ROOT = resolve(INTEGRITY_ROOT, "patches");
const CONTRACT_PATH = resolve(WITNESS_ROOT, "corpus", "adversarial", "contract.json");
const BASE_COMMIT = "42571061ca9b6da8c6aca908f1ee1df1dab4e10a";

async function contractFor(detection, repetitions = 2) {
  const contract = JSON.parse(await readFile(CONTRACT_PATH, "utf8"));
  contract.integrity.forbid = [detection];
  contract.reproducibility.repetitions = repetitions;
  return contract;
}

function successfulContainerStub(overrides = {}) {
  let counter = 0;
  const calls = [];
  const runContainer = async (options) => {
    calls.push(options);
    const targetedBaseline = options.phase === "baseline" && options.checkId === "unitless-duration";
    const result = {
      exitCode: targetedBaseline ? 1 : 0,
      signal: null,
      stdout: "",
      stderr: "",
      spawnError: null,
      timedOut: false,
      outputTruncated: false,
      seconds: 0.001,
      containerId: `container-${++counter}`,
      networkMode: "none",
      networkInterfaces: ["lo"],
      networkAssertionPassed: true
    };
    return overrides.result ? overrides.result(options, result) : result;
  };
  return { runContainer, calls };
}

async function executeFixture({ contract, patch, stub, temporaryParent, ensureImage }) {
  return executeVerificationContract({ contract, candidatePatch: patch }, {
    materialize: async ({ destination }) => {
      await cp(BASE_ROOT, destination, { recursive: true, errorOnExist: true });
      await makeTreeWritable(destination);
      return {
        path: destination,
        commit: BASE_COMMIT,
        source: "integrity-drill",
        sourceType: "fixture",
        seconds: 0
      };
    },
    ensureImage: ensureImage || (async () => ({ image: "fixture", imageId: "sha256:fixture" })),
    runContainer: stub.runContainer,
    temporaryParent
  });
}

for (const drill of INTEGRITY_DRILLS) {
  test(`${drill.detection}: attack is named POLICY_VIOLATION and corrected patch is PASS`, async (context) => {
    const temporaryParent = await mkdtemp(join(tmpdir(), "witness-integrity-test-"));
    context.after(() => rm(temporaryParent, { recursive: true, force: true }));
    const contract = await contractFor(drill.detection);

    const attack = await executeFixture({
      contract,
      patch: resolve(PATCH_ROOT, drill.attack),
      stub: successfulContainerStub(),
      temporaryParent
    });
    assert.equal(attack.verdict, VERDICTS.POLICY_VIOLATION);
    assert.ok(
      attack.integrityViolations.some((entry) => entry.detection === drill.detection),
      `${drill.detection} was not named in ${JSON.stringify(attack.integrityViolations)}`
    );

    const safe = await executeFixture({
      contract,
      patch: resolve(PATCH_ROOT, drill.safe),
      stub: successfulContainerStub(),
      temporaryParent
    });
    assert.equal(safe.verdict, VERDICTS.PASS, `${drill.detection}: ${safe.reason} ${safe.details}`);
    assert.deepEqual(safe.integrityViolations, []);
  });
}

test("baseline and candidate repetitions use distinct container IDs", async (context) => {
  const temporaryParent = await mkdtemp(join(tmpdir(), "witness-container-test-"));
  context.after(() => rm(temporaryParent, { recursive: true, force: true }));
  const stub = successfulContainerStub();
  const report = await executeFixture({
    contract: await contractFor("test_deletion"),
    patch: resolve(PATCH_ROOT, "test-deletion.safe.patch"),
    stub,
    temporaryParent
  });
  assert.equal(report.verdict, VERDICTS.PASS);
  const baseline = report.baseline.flatMap((run) => run.containerIds);
  const candidate = report.candidate.flatMap((run) => run.containerIds);
  assert.equal(baseline.length, 4);
  assert.equal(candidate.length, 4);
  assert.equal(new Set([...baseline, ...candidate]).size, 8);
  assert.equal(stub.calls.filter((call) => call.phase === "baseline").length, 4);
  assert.equal(stub.calls.filter((call) => call.phase === "candidate").length, 4);
});

test("candidate repetition disagreement is candidate-attributable INCONCLUSIVE", async (context) => {
  const temporaryParent = await mkdtemp(join(tmpdir(), "witness-repetition-test-"));
  context.after(() => rm(temporaryParent, { recursive: true, force: true }));
  const stub = successfulContainerStub({
    result(options, result) {
      if (options.phase === "candidate" && options.repetition === 2 && options.checkId === "unitless-duration") {
        result.exitCode = 1;
      }
      return result;
    }
  });
  const report = await executeFixture({
    contract: await contractFor("test_deletion"),
    patch: resolve(PATCH_ROOT, "test-deletion.safe.patch"),
    stub,
    temporaryParent
  });
  assert.equal(report.verdict, VERDICTS.INCONCLUSIVE);
  assert.equal(report.attribution, "candidate");
  assert.equal(report.reason, "candidate_caused_nondeterminism_across_repetitions");
});

test("untrusted candidate execution outranks an apparent check failure", async (context) => {
  const temporaryParent = await mkdtemp(join(tmpdir(), "witness-precedence-test-"));
  context.after(() => rm(temporaryParent, { recursive: true, force: true }));
  const stub = successfulContainerStub({
    result(options, result) {
      if (options.phase === "candidate" && options.checkId === "unitless-duration") {
        result.exitCode = null;
        result.spawnError = "simulated host failure";
        result.containerId = null;
      }
      if (options.phase === "candidate" && options.checkId === "full-suite") result.exitCode = 1;
      return result;
    }
  });
  const report = await executeFixture({
    contract: await contractFor("test_deletion", 1),
    patch: resolve(PATCH_ROOT, "test-deletion.safe.patch"),
    stub,
    temporaryParent
  });
  assert.equal(report.verdict, VERDICTS.INCONCLUSIVE);
  assert.equal(report.attribution, "infrastructure");
  assert.equal(report.reason, "host_failure");
});

test("policy violation outranks an unavailable execution image", async (context) => {
  const temporaryParent = await mkdtemp(join(tmpdir(), "witness-policy-precedence-test-"));
  context.after(() => rm(temporaryParent, { recursive: true, force: true }));
  const report = await executeFixture({
    contract: await contractFor("test_deletion", 1),
    patch: resolve(PATCH_ROOT, "test-deletion.attack.patch"),
    stub: successfulContainerStub(),
    temporaryParent,
    ensureImage: async () => { throw new Error("simulated missing image"); }
  });
  assert.equal(report.verdict, VERDICTS.POLICY_VIOLATION);
  assert.ok(report.integrityViolations.some((entry) => entry.detection === "test_deletion"));
});

test("required hidden bundle fails closed when v1 supplies no locator", async (context) => {
  const temporaryParent = await mkdtemp(join(tmpdir(), "witness-hidden-test-"));
  context.after(() => rm(temporaryParent, { recursive: true, force: true }));
  const contract = await contractFor("test_deletion", 1);
  contract.checks.hidden = {
    bundle_sha256: "3f1a",
    required: true,
    eligibility_reference_sha256: "9c72"
  };
  const report = await executeFixture({
    contract,
    patch: resolve(PATCH_ROOT, "test-deletion.safe.patch"),
    stub: successfulContainerStub(),
    temporaryParent
  });
  assert.equal(report.verdict, VERDICTS.INCONCLUSIVE);
  assert.equal(report.attribution, "infrastructure");
  assert.equal(report.reason, "hidden_bundle_unavailable");
});

test("an unknown declared integrity detection is a verifier evidence gap, not infrastructure", async (context) => {
  const temporaryParent = await mkdtemp(join(tmpdir(), "witness-unknown-integrity-test-"));
  context.after(() => rm(temporaryParent, { recursive: true, force: true }));
  const contract = await contractFor("not_implemented_by_witness", 1);
  const report = await executeFixture({
    contract,
    patch: resolve(PATCH_ROOT, "test-deletion.safe.patch"),
    stub: successfulContainerStub(),
    temporaryParent
  });
  assert.equal(report.verdict, VERDICTS.INCONCLUSIVE);
  assert.equal(report.attribution, "verifier");
  assert.equal(report.reason, "integrity_detection_unimplemented");
  assert.equal(report.workerConsequence, "none");
  assert.equal(report.verifierReputationSignal.kind, "evidence_completeness_gap");
});

test("a renamed-and-expanded declaration is verifier-attributed INCONCLUSIVE with no worker consequence", async (context) => {
  const temporaryParent = await mkdtemp(join(tmpdir(), "witness-ambiguous-integrity-test-"));
  context.after(() => rm(temporaryParent, { recursive: true, force: true }));
  const report = await executeFixture({
    contract: await contractFor("test_deletion", 1),
    patch: resolve(PATCH_ROOT, "test-declaration-rename.patch"),
    stub: successfulContainerStub(),
    temporaryParent
  });
  assert.equal(report.verdict, VERDICTS.INCONCLUSIVE);
  assert.equal(report.attribution, "verifier");
  assert.equal(report.reason, "integrity_detection_ambiguous");
  assert.equal(report.workerConsequence, "none");
  assert.equal(report.integrityViolations.length, 0);
  assert.equal(report.integrityAmbiguities.length, 1);
  assert.equal(report.verifierReputationSignal.kind, "evidence_completeness_gap");
  assert.equal(report.verifierReputationSignal.reason, "integrity_detection_ambiguous");
});

test("runner replacement compares the frozen package script, not unrelated metadata", async (context) => {
  const candidateRoot = await mkdtemp(join(tmpdir(), "witness-runner-definition-test-"));
  context.after(() => rm(candidateRoot, { recursive: true, force: true }));
  await cp(BASE_ROOT, candidateRoot, { recursive: true, force: true });
  const packagePath = resolve(candidateRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.description = "metadata-only candidate edit";
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const violations = await detectIntegrityViolations({
    contract: await contractFor("runner_replacement", 1),
    patch: {
      changedPaths: ["package.json"],
      files: [{ path: "package.json", previousPath: "package.json", addedLines: [], removedLines: [] }]
    },
    baseRoot: BASE_ROOT,
    candidateRoot
  });
  assert.deepEqual(violations, []);
});

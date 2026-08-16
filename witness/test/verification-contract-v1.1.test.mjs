import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { executeVerificationContract, VERDICTS } from "../src/executor.mjs";
import { makeTreeWritable } from "../src/materialize.mjs";
import {
  REJECTION_RULES,
  loadVerificationContract,
  normalizeVerificationContract,
  resolveJudgingCommandDefinition,
  validateVerificationContract,
  validateVerificationContractAtFreeze
} from "../src/verification-contract.mjs";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKED_PATH = resolve(WITNESS_ROOT, "examples", "averray-send-test", "contract-v1.1.json");
const BASE_ROOT = resolve(WITNESS_ROOT, "corpus", "adversarial", "seed");
const CORRECT_PATCH = resolve(WITNESS_ROOT, "corpus", "adversarial", "cases", "pass-correct.patch");
const ATTACK_PATCH = resolve(
  WITNESS_ROOT,
  "test",
  "fixtures",
  "verification-contract",
  "supplied-test-modification.patch"
);
const BASE_COMMIT = "42571061ca9b6da8c6aca908f1ee1df1dab4e10a";

async function workedContract() {
  return loadVerificationContract(WORKED_PATH);
}

async function materializeFixture({ destination }) {
  await cp(BASE_ROOT, destination, { recursive: true, errorOnExist: true });
  await makeTreeWritable(destination);
  return {
    path: destination,
    commit: BASE_COMMIT,
    source: "pinned-test-fixture",
    sourceType: "fixture",
    seconds: 0
  };
}

function sandboxResult(exitCode, id) {
  return {
    exitCode,
    signal: null,
    stdout: "",
    stderr: "",
    spawnError: null,
    timedOut: false,
    outputTruncated: false,
    seconds: 0.001,
    containerId: id,
    networkMode: "none",
    networkInterfaces: ["lo"],
    networkAssertionPassed: true
  };
}

test("the checked-in schema and worked instance use v1.1", async () => {
  const schema = JSON.parse(await readFile(
    resolve(WITNESS_ROOT, "schema", "verification-contract-v1.1.schema.json"),
    "utf8"
  ));
  assert.equal(schema.properties.schema_version.const, "averray.verification-contract/v1.1");
  const contract = await workedContract();
  assert.equal(contract.subject.acquisition.base_commit, BASE_COMMIT);
  assert.equal(contract.checks.targeted.length, 0);
  assert.equal(contract.checks.hidden.required, true);
});

test("v1.1 normalization canonicalizes artifact and working paths without mutating input", async () => {
  const input = structuredClone(await workedContract());
  input.checks.hidden.artifact.locator.path = "./unitless.test.mjs";
  input.checks.hidden.working_directory = "./packages/../";
  const normalized = normalizeVerificationContract(input);
  assert.equal(normalized.checks.hidden.artifact.locator.path, "unitless.test.mjs");
  assert.equal(normalized.checks.hidden.working_directory, ".");
  assert.equal(input.checks.hidden.artifact.locator.path, "./unitless.test.mjs");
});

const MALFORMED_ADDITIONS = [
  {
    name: "source artifact locator",
    mutate(contract) { delete contract.subject.acquisition.bundle.locator; },
    path: "subject.acquisition.bundle.locator"
  },
  {
    name: "source artifact format",
    mutate(contract) { contract.subject.acquisition.bundle.format = "file"; },
    path: "subject.acquisition.bundle.format"
  },
  {
    name: "dependency-cache artifact locator and format",
    mutate(contract) {
      contract.subject.materialization.dependency_cache = {
        artifact: {
          sha256: "a".repeat(64),
          bytes: 1,
          locator: { kind: "path", path: "cache.tar" },
          format: "unknown"
        },
        mount_path: ".averray/cache",
        populate_command: ["npm", "ci", "--offline"],
        working_directory: "."
      };
    },
    path: "subject.materialization.dependency_cache.artifact.format"
  },
  {
    name: "frozen-input artifact locator",
    mutate(contract) {
      contract.subject.materialization.frozen_inputs = [{
        path: "fixtures/api.json",
        artifact: { sha256: "b".repeat(64), bytes: 1, format: "file" }
      }];
    },
    path: "subject.materialization.frozen_inputs[0].artifact.locator"
  },
  {
    name: "hidden command manifest",
    mutate(contract) { contract.checks.hidden.command = ["node", "--test", "test/duration.test.js"]; },
    path: "checks.hidden.command"
  },
  {
    name: "check working directory",
    mutate(contract) { contract.checks.hidden.working_directory = "../outside"; },
    path: "checks.hidden.working_directory"
  },
  {
    name: "temporary storage quota",
    mutate(contract) {
      contract.resources.writable_storage_mb = contract.resources.temporary_storage_mb;
      delete contract.resources.temporary_storage_mb;
    },
    path: "resources.writable_storage_mb"
  },
  {
    name: "strict artifact digest",
    mutate(contract) { contract.checks.hidden.artifact.sha256 = "not-a-digest"; },
    path: "checks.hidden.artifact.sha256"
  }
];

for (const malformed of MALFORMED_ADDITIONS) {
  test(`v1.1 rejects malformed ${malformed.name}`, async () => {
    const contract = structuredClone(await workedContract());
    malformed.mutate(contract);
    const result = validateVerificationContract(contract);
    assert.equal(result.valid, false);
    assert.ok(
      result.issues.some((entry) => entry.path === malformed.path),
      `${malformed.path} missing from ${JSON.stringify(result.issues)}`
    );
  });
}

test("rule 5 resolves package scripts relative to a monorepo working directory", () => {
  assert.deepEqual(resolveJudgingCommandDefinition(["npm", "test"], {
    workingDirectory: "packages/app"
  }), {
    resolved: true,
    definitionFile: "packages/app/package.json",
    kind: "package-script",
    script: "test"
  });
});

test("freeze validation proves the supplied check fails on base and rejects an observed pass", async (context) => {
  const temporaryParent = await mkdtemp(join(tmpdir(), "witness-v11-freeze-test-"));
  context.after(() => rm(temporaryParent, { recursive: true, force: true }));
  const calls = [];
  const dependencies = {
    materialize: materializeFixture,
    ensureImage: async () => ({ image: "fixture", imageId: "sha256:fixture" }),
    temporaryParent,
    runContainer: async (options) => {
      calls.push(options);
      return sandboxResult(1, `freeze-${calls.length}`);
    }
  };
  const accepted = await validateVerificationContractAtFreeze(await workedContract(), {}, dependencies);
  assert.equal(accepted.valid, true, accepted.issues.map((entry) => entry.message).join("\n"));
  assert.deepEqual(accepted.evidence.checks.map((entry) => entry.outcome), ["fail"]);
  assert.equal(calls[0].readOnlyMounts[0].target, "/workspace/.averray/supplied-tests/unitless.test.mjs");

  const rejected = await validateVerificationContractAtFreeze(await workedContract(), {}, {
    ...dependencies,
    runContainer: async () => sandboxResult(0, "freeze-pass")
  });
  assert.equal(rejected.valid, false);
  assert.ok(rejected.issues.some((entry) => entry.code === REJECTION_RULES.TARGETED_BASE_MUST_FAIL.code));
  assert.match(rejected.issues[0].message, /Witness observed pass/u);

  const digestMismatch = await workedContract();
  digestMismatch.checks.hidden.artifact.sha256 = "0".repeat(64);
  const artifactRejected = await validateVerificationContractAtFreeze(digestMismatch, {}, dependencies);
  assert.equal(artifactRejected.valid, false);
  assert.equal(artifactRejected.issues[0].code, "VCV11_FREEZE_ARTIFACT_EVIDENCE");
  assert.match(artifactRejected.issues[0].message, /does not match declared/u);
});

test("the supplied test is read-only-mounted in baseline and candidate runs", async (context) => {
  const temporaryParent = await mkdtemp(join(tmpdir(), "witness-v11-execution-test-"));
  context.after(() => rm(temporaryParent, { recursive: true, force: true }));
  const calls = [];
  const report = await executeVerificationContract({
    contract: await workedContract(),
    candidatePatch: CORRECT_PATCH
  }, {
    materialize: materializeFixture,
    ensureImage: async () => ({ image: "fixture", imageId: "sha256:fixture" }),
    temporaryParent,
    runContainer: async (options) => {
      calls.push(options);
      const hiddenBase = options.phase === "baseline" && options.checkId === "supplied-unitless-duration";
      return sandboxResult(hiddenBase ? 1 : 0, `${options.phase}-${calls.length}`);
    }
  });
  assert.equal(report.verdict, VERDICTS.PASS, `${report.reason}: ${report.details}`);
  const suppliedCalls = calls.filter((entry) => entry.checkId === "supplied-unitless-duration");
  assert.equal(suppliedCalls.filter((entry) => entry.phase === "baseline").length, 2);
  assert.equal(suppliedCalls.filter((entry) => entry.phase === "candidate").length, 2);
  assert.ok(suppliedCalls.every((entry) => entry.readOnlyMounts.some((mount) =>
    mount.target === "/workspace/.averray/supplied-tests/unitless.test.mjs")));
});

test("a v1.1 dependency artifact is mounted and populated offline in every clean run", async (context) => {
  const temporaryParent = await mkdtemp(join(tmpdir(), "witness-v11-cache-test-"));
  context.after(() => rm(temporaryParent, { recursive: true, force: true }));
  const contract = await workedContract();
  contract.subject.materialization.status = "FROZEN_DEPENDENCIES";
  contract.subject.materialization.dependency_cache = {
    artifact: structuredClone(contract.checks.hidden.artifact),
    mount_path: ".averray/dependency-cache/unitless.test.mjs",
    populate_command: ["node", "--eval", "process.exit(0)"],
    working_directory: "."
  };
  const calls = [];
  const report = await executeVerificationContract({ contract, candidatePatch: CORRECT_PATCH }, {
    materialize: materializeFixture,
    ensureImage: async () => ({ image: "fixture", imageId: "sha256:fixture" }),
    temporaryParent,
    runContainer: async (options) => {
      calls.push(options);
      const hiddenBase = options.phase === "baseline" && options.checkId === "supplied-unitless-duration";
      return sandboxResult(hiddenBase ? 1 : 0, `${options.phase}-${calls.length}`);
    }
  });
  assert.equal(report.verdict, VERDICTS.PASS, `${report.reason}: ${report.details}`);
  const preparations = calls.filter((entry) => entry.checkId === "dependency-materialization");
  assert.equal(preparations.length, 4);
  assert.ok(preparations.every((entry) => entry.networkMode === "none"));
  assert.ok(preparations.every((entry) => entry.readOnlyMounts.some((mount) =>
    mount.target === "/workspace/.averray/dependency-cache/unitless.test.mjs")));
});

test("a candidate attempt to replace the supplied test is POLICY_VIOLATION", async (context) => {
  const temporaryParent = await mkdtemp(join(tmpdir(), "witness-v11-policy-test-"));
  context.after(() => rm(temporaryParent, { recursive: true, force: true }));
  const report = await executeVerificationContract({
    contract: await workedContract(),
    candidatePatch: ATTACK_PATCH
  }, {
    materialize: materializeFixture,
    ensureImage: async () => ({ image: "unused" }),
    temporaryParent,
    runContainer: async () => sandboxResult(0, "unused")
  });
  assert.equal(report.verdict, VERDICTS.POLICY_VIOLATION);
  assert.ok(report.policyViolations.some((entry) => entry.detection === "supplied_test_modified"));
});

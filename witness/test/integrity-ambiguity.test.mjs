import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateCandidatePolicy, inspectCandidatePatch } from "../src/candidate-patch.mjs";
import { detectIntegrityFindings } from "../src/integrity.mjs";
import {
  REAL_TEST_RENAMES,
  declarationPatch
} from "./fixtures/integrity/real-test-renames.mjs";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_ROOT = resolve(WITNESS_ROOT, "test/fixtures/integrity/base");
const PATCH_ROOT = resolve(WITNESS_ROOT, "test/fixtures/integrity/patches");
const CONTRACT = { integrity: { forbid: ["test_deletion"] } };

for (const example of REAL_TEST_RENAMES) {
  test(`${example.name} real renamed-and-expanded declarations are ambiguous, not violations`, async () => {
    const findings = await detectIntegrityFindings({
      contract: CONTRACT,
      patch: declarationPatch(example.path, example.removed, example.added),
      baseRoot: BASE_ROOT,
      candidateRoot: BASE_ROOT
    });
    assert.deepEqual(findings.violations, []);
    assert.equal(findings.ambiguities.length, 1);
    assert.equal(findings.ambiguities[0].detection, "test_deletion");
    assert.equal(findings.ambiguities[0].confidence, "ambiguous");
  });
}

test("a declaration removed without any replacement remains a confident violation", async () => {
  const findings = await detectIntegrityFindings({
    contract: CONTRACT,
    patch: declarationPatch(
      "test/value.test.js",
      ['test("returns one", () => {'],
      []
    ),
    baseRoot: BASE_ROOT,
    candidateRoot: BASE_ROOT
  });
  assert.equal(findings.violations.length, 1);
  assert.deepEqual(findings.ambiguities, []);
  assert.equal(findings.violations[0].confidence, "confident");
});

test("a Git file rename is followed confidently and creates no test-deletion ambiguity", async () => {
  const patch = await inspectCandidatePatch({
    patchPath: resolve(PATCH_ROOT, "test-file-rename.patch"),
    baseRoot: BASE_ROOT
  });
  assert.equal(patch.valid, true, patch.reason);
  assert.deepEqual(
    [...patch.changedPaths].sort(),
    ["test/renamed-value.test.js", "test/value.test.js"]
  );
  assert.equal(patch.files.length, 1);
  assert.equal(patch.files[0].isRenamed, true);
  assert.equal(patch.files[0].previousPath, "test/value.test.js");
  assert.equal(patch.files[0].path, "test/renamed-value.test.js");
  assert.equal(patch.changedFileCount, 1);
  assert.deepEqual(evaluateCandidatePolicy({
    schema_version: "averray.verification-contract/v1",
    candidate: {
      allowed_paths: ["test/**"],
      protected_paths: [],
      maximum_changed_files: 1
    }
  }, patch), []);
  assert.deepEqual(evaluateCandidatePolicy({
    schema_version: "averray.verification-contract/v1",
    candidate: {
      allowed_paths: ["test/**"],
      protected_paths: ["test/value.test.js"],
      maximum_changed_files: 1
    }
  }, patch).map((entry) => entry.detection), ["protected_path_modified"]);

  const findings = await detectIntegrityFindings({
    contract: CONTRACT,
    patch,
    baseRoot: BASE_ROOT,
    candidateRoot: BASE_ROOT
  });
  assert.deepEqual(findings, { violations: [], ambiguities: [] });
});

test("a deleted test file with a replacement test file is verifier ambiguity", async () => {
  const findings = await detectIntegrityFindings({
    contract: CONTRACT,
    patch: {
      changedPaths: ["test/value.test.js", "test/value-expanded.test.js"],
      files: [
        {
          path: "test/value.test.js",
          previousPath: "test/value.test.js",
          isNew: false,
          isDeleted: true,
          isRenamed: false,
          removedLines: ['test("old behavior", () => {'],
          addedLines: []
        },
        {
          path: "test/value-expanded.test.js",
          previousPath: "test/value-expanded.test.js",
          isNew: true,
          isDeleted: false,
          isRenamed: false,
          removedLines: [],
          addedLines: ['test("new behavior", () => {']
        }
      ]
    },
    baseRoot: BASE_ROOT,
    candidateRoot: BASE_ROOT
  });
  assert.deepEqual(findings.violations, []);
  assert.equal(findings.ambiguities.length, 1);
  assert.deepEqual(
    findings.ambiguities[0].paths,
    ["test/value.test.js", "test/value-expanded.test.js"]
  );
});

test("an unrelated new test file does not mask an outright deleted test file", async () => {
  const findings = await detectIntegrityFindings({
    contract: CONTRACT,
    patch: {
      changedPaths: ["test/old.test.js", "other/new.spec.ts"],
      files: [
        {
          path: "test/old.test.js",
          previousPath: "test/old.test.js",
          isNew: false,
          isDeleted: true,
          isRenamed: false,
          removedLines: ['test("old behavior", () => {'],
          addedLines: []
        },
        {
          path: "other/new.spec.ts",
          previousPath: "other/new.spec.ts",
          isNew: true,
          isDeleted: false,
          isRenamed: false,
          removedLines: [],
          addedLines: ['test("unrelated behavior", () => {']
        }
      ]
    },
    baseRoot: BASE_ROOT,
    candidateRoot: BASE_ROOT
  });
  assert.equal(findings.violations.length, 1);
  assert.deepEqual(findings.ambiguities, []);
});

test("a token replacement does not make a much larger declaration deletion ambiguous", async () => {
  const findings = await detectIntegrityFindings({
    contract: CONTRACT,
    patch: declarationPatch(
      "test/value.test.js",
      Array.from({ length: 5 }, (_, index) => `test("removed ${index}", () => {`),
      ['test("replacement", () => {']
    ),
    baseRoot: BASE_ROOT,
    candidateRoot: BASE_ROOT
  });
  assert.equal(findings.violations.length, 1);
  assert.deepEqual(findings.ambiguities, []);
});

test("the frozen 4:1 declaration boundary is ambiguous at 4.0 and a violation at 4.1", async () => {
  const findingsAt = async (removedCount) => detectIntegrityFindings({
    contract: CONTRACT,
    patch: declarationPatch(
      "test/value.test.js",
      Array.from({ length: removedCount }, (_, index) => `test("removed ${index}", () => {`),
      Array.from({ length: 10 }, (_, index) => `test("replacement ${index}", () => {`)
    ),
    baseRoot: BASE_ROOT,
    candidateRoot: BASE_ROOT
  });
  const atFour = await findingsAt(40);
  const aboveFour = await findingsAt(41);
  assert.deepEqual(atFour.violations, []);
  assert.equal(atFour.ambiguities.length, 1);
  assert.equal(aboveFour.violations.length, 1);
  assert.deepEqual(aboveFour.ambiguities, []);
});

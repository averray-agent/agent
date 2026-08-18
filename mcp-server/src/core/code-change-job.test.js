import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ValidationError } from "./errors.js";
import {
  CODE_CHANGE_JOB_SCHEMA_VERSION,
  FROZEN_CONTRACT_DIGEST_ALGORITHM,
  hashFrozenVerificationContract,
  normalizeCodeChangeDefinition
} from "./code-change-job.js";
import { normalizeJobInput } from "./job-catalog-normalization.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const worked = JSON.parse(readFileSync(
  resolve(repoRoot, "witness/examples/averray-send-test/contract-testnet-v1.1.json"),
  "utf8"
));

function envelope(contract = worked) {
  return {
    schemaVersion: CODE_CHANGE_JOB_SCHEMA_VERSION,
    contractState: "frozen",
    contractDigest: hashFrozenVerificationContract(contract),
    contractDigestAlgorithm: FROZEN_CONTRACT_DIGEST_ALGORITHM,
    contract,
    preflight: {
      result: "EXECUTABLE",
      materializationStatus: "HERMETIC",
      reports: [{
        checkId: "full-suite",
        checkKind: "regression",
        classification: "HERMETIC",
        baseOutcome: "pass"
      }]
    },
    freeze: {
      validated: true,
      baselineDifferentials: [{
        id: "supplied-unitless-duration",
        kind: "hidden",
        expected: "fail",
        outcome: "fail"
      }]
    }
  };
}

function job(codeChange = envelope()) {
  return {
    id: worked.job.id,
    category: "coding",
    tier: "starter",
    lane: "benchmark-showcase",
    jobType: "code_change",
    rewardAsset: "USDC",
    rewardAmount: 1,
    verifierMode: "witness",
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: "schema://jobs/patch-submission-output",
    codeChange
  };
}

test("code_change normalization preserves a frozen digest-bound contract", () => {
  const normalized = normalizeJobInput(job());
  assert.equal(normalized.jobType, "code_change");
  assert.equal(normalized.requiredRole, "worker");
  assert.equal(normalized.verifierConfig.handler, "witness");
  assert.equal(normalized.verifierConfig.requiredAssuranceLevel, "AV-2");
  assert.equal(normalized.codeChange.contractDigest, hashFrozenVerificationContract(worked));
  assert.equal(normalized.codeChange.contract.subject.acquisition.base_commit, worked.subject.acquisition.base_commit);
  assert.equal(normalized.codeChange.contract.checks.hidden.required, true);
  assert.deepEqual(normalized.codeChange.contract.candidate.protected_paths, ["package.json"]);
});

test("unfrozen and mutated contracts are refused before entering the catalog", () => {
  assert.throws(
    () => normalizeJobInput(job({ ...envelope(), contractState: "draft" })),
    (error) => error instanceof ValidationError && /must be frozen before publication/u.test(error.message)
  );

  const mutated = envelope();
  mutated.contract.candidate.maximum_changed_files += 1;
  assert.throws(
    () => normalizeJobInput(job(mutated)),
    (error) => error instanceof ValidationError && /does not match the frozen contract/u.test(error.message)
  );
});

test("published contracts refuse local-only artifact locators", () => {
  const localOnly = structuredClone(worked);
  localOnly.subject.acquisition.git_bundle.locator = { kind: "path", path: "source.bundle" };
  assert.throws(
    () => normalizeCodeChangeDefinition(envelope(localOnly), { expectedJobId: localOnly.job.id }),
    /locator\.kind must be https in a published job/u
  );
});

test("malformed publication projections fail with a validation error", () => {
  const malformed = structuredClone(worked);
  malformed.subject.materialization.frozen_inputs = null;
  assert.throws(
    () => normalizeCodeChangeDefinition(envelope(malformed), { expectedJobId: malformed.job.id }),
    (error) => error instanceof ValidationError && /frozen_inputs must be an array/u.test(error.message)
  );
});

test("code_change rejects the wrong output schema, verifier, and assurance floor", () => {
  assert.throws(
    () => normalizeJobInput({ ...job(), outputSchemaRef: "schema://jobs/coding-output" }),
    /must use schema:\/\/jobs\/patch-submission-output/u
  );
  assert.throws(
    () => normalizeJobInput({ ...job(), verifierMode: "human_fallback" }),
    /must use the witness verifier mode/u
  );
  const belowFloor = structuredClone(worked);
  belowFloor.job.required_verification_level = "AV-1";
  assert.throws(
    () => normalizeCodeChangeDefinition(envelope(belowFloor), { expectedJobId: belowFloor.job.id }),
    /must be AV-2 or higher/u
  );
});

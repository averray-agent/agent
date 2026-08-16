import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  REJECTION_RULES,
  assertValidVerificationContract,
  isProtectedPath,
  loadVerificationContract,
  normalizeVerificationContract,
  parseVerificationContractJson,
  resolveJudgingCommandDefinition,
  validateVerificationContract
} from "../src/verification-contract.mjs";
import { RULE_DRILLS } from "./fixtures/verification-contract/cases.mjs";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = resolve(WITNESS_ROOT, "test", "fixtures", "verification-contract");

async function readFixture(file) {
  return JSON.parse(await readFile(resolve(FIXTURES, file), "utf8"));
}

for (const drill of RULE_DRILLS) {
  test(`${drill.code}: rejects the rule ${drill.number} fixture and accepts its one-field correction`, async () => {
    const invalid = await readFixture(drill.file);
    const rejected = validateVerificationContract(invalid);
    assert.equal(rejected.valid, false);
    assert.deepEqual(rejected.issues.map((entry) => entry.code), [drill.code]);
    assert.match(rejected.issues[0].rule, new RegExp(`^rule ${drill.number}:`, "u"));

    const corrected = structuredClone(invalid);
    drill.correct(corrected);
    const accepted = validateVerificationContract(corrected);
    assert.equal(accepted.valid, true, accepted.issues.map((entry) => entry.message).join("\n"));
  });
}

test("the #1134 averray-send-test worked instance validates unchanged", async () => {
  const path = resolve(FIXTURES, "worked-averray-send-test.json");
  const json = await readFile(path, "utf8");
  const fromFile = await loadVerificationContract(path);
  const fromJson = parseVerificationContractJson(json);
  assert.deepEqual(fromFile, fromJson);
  assert.equal(fromFile.subject.acquisition.repository, "github.com/depre-dev/averray-send-test");
  assert.deepEqual(fromFile.checks.regression[0].command, ["npm", "test"]);
});

test("normalization is detached, fills documented defaults, and normalizes repository paths", async () => {
  const input = await readFixture("worked-averray-send-test.json");
  delete input.checks.regression;
  input.candidate.protected_paths = ["./package.json", "package.json"];
  const normalized = normalizeVerificationContract(input);
  assert.deepEqual(normalized.checks.regression, []);
  assert.deepEqual(normalized.candidate.protected_paths, ["package.json"]);
  assert.equal(input.checks.regression, undefined);
  assert.deepEqual(input.candidate.protected_paths, ["./package.json", "package.json"]);
});

test("empty or repository-escaping candidate paths are schema errors", async () => {
  const empty = await readFixture("worked-averray-send-test.json");
  empty.candidate.protected_paths = [""];
  assert.equal(validateVerificationContract(empty).issues[0].code, "VCV1_SCHEMA_STRING");

  const escaping = await readFixture("worked-averray-send-test.json");
  escaping.candidate.protected_paths = ["../package.json"];
  assert.equal(validateVerificationContract(escaping).issues[0].code, "VCV1_SCHEMA_REPOSITORY_PATH");
});

test("the checked-in JSON Schema names the v1 discriminator", async () => {
  const schema = JSON.parse(await readFile(
    resolve(WITNESS_ROOT, "schema", "verification-contract-v1.schema.json"),
    "utf8"
  ));
  assert.equal(schema.properties.schema_version.const, "averray.verification-contract/v1");
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
});

test("the JSON loader reports parse failures separately from contract rejection", () => {
  assert.throws(
    () => parseVerificationContractJson("{"),
    (error) => error.issues?.[0]?.code === "VCV1_JSON_PARSE" && /JSON loader/u.test(error.message)
  );
});

test("rule 5 resolves supported command-definition paths and direct Node commands", () => {
  assert.deepEqual(resolveJudgingCommandDefinition(["npm", "test"]), {
    resolved: true,
    definitionFile: "package.json",
    kind: "package-script",
    script: "test"
  });
  assert.equal(resolveJudgingCommandDefinition(["pnpm", "run", "verify"]).definitionFile, "package.json");
  assert.equal(resolveJudgingCommandDefinition(["yarn", "test"]).definitionFile, "package.json");
  assert.equal(resolveJudgingCommandDefinition(["make", "check"]).resolved, false);
  assert.equal(resolveJudgingCommandDefinition(["node", "scripts/check.mjs"]).definitionFile, "scripts/check.mjs");
  assert.equal(resolveJudgingCommandDefinition(["node", "scripts/check"]).definitionFile, "scripts/check");
  assert.deepEqual(resolveJudgingCommandDefinition(["node", "--test"]), {
    resolved: true,
    definitionFile: null,
    kind: "direct-node"
  });
  assert.equal(isProtectedPath("scripts/check.mjs", ["scripts/**"]), true);
  assert.equal(isProtectedPath("scripts/check.mjs", ["scripts"]), true);
  assert.equal(resolveJudgingCommandDefinition(["make", "-f", "ci.mk", "check"]).resolved, false);
  assert.equal(resolveJudgingCommandDefinition(["yarn", "workspace", "app", "test"]).resolved, false);
});

test("rule 1 rejects both non-materializable preflight states", async () => {
  const contract = await readFixture("rule-1-materialization-status.json");
  contract.subject.materialization.status = "UNMATERIALIZABLE";
  const result = validateVerificationContract(contract);
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map((entry) => entry.code), [REJECTION_RULES.MATERIALIZATION_STATUS.code]);
});

test("rule 5 fails closed when a command-definition path cannot be proven", async () => {
  const contract = await readFixture("worked-averray-send-test.json");
  contract.checks.targeted[0].command = ["cargo", "test"];
  const result = validateVerificationContract(contract);
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map((entry) => entry.code), [REJECTION_RULES.JUDGING_COMMAND_PROTECTED.code]);
  assert.match(result.issues[0].message, /cannot prove.*cargo.*fails closed/iu);
});

test("assertion errors name the exact freeze-time rule", async () => {
  const contract = await readFixture("rule-7-hidden-eligibility.json");
  assert.throws(
    () => assertValidVerificationContract(contract),
    (error) => error.issues?.[0]?.code === REJECTION_RULES.REQUIRED_HIDDEN_ELIGIBILITY.code &&
      /rule 7: required hidden bundles/u.test(error.message)
  );
});

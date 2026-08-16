#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateVerificationContract,
  validateVerificationContractShape
} from "../src/verification-contract.mjs";
import { RULE_DRILLS } from "../test/fixtures/verification-contract/cases.mjs";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = resolve(WITNESS_ROOT, "test", "fixtures", "verification-contract");
const output = {};

for (const drill of RULE_DRILLS) {
  const invalid = JSON.parse(await readFile(resolve(FIXTURES, drill.file), "utf8"));
  const withoutFreezeRules = validateVerificationContractShape(invalid);
  const withFreezeRules = validateVerificationContract(invalid);
  const corrected = structuredClone(invalid);
  drill.correct(corrected);
  const correctedResult = validateVerificationContract(corrected);

  output[`rule${drill.number}`] = {
    expectedRule: drill.code,
    withoutFreezeRules: {
      status: withoutFreezeRules.valid ? "RED" : "GREEN",
      result: withoutFreezeRules.valid ? "ACCEPTED" : "REJECTED"
    },
    withFreezeRules: {
      status: !withFreezeRules.valid && withFreezeRules.issues.some((entry) => entry.code === drill.code)
        ? "GREEN"
        : "RED",
      result: withFreezeRules.valid ? "ACCEPTED" : "REJECTED",
      errors: withFreezeRules.issues.map((entry) => `${entry.code}: ${entry.rule}`)
    },
    corrected: {
      status: correctedResult.valid ? "GREEN" : "RED",
      result: correctedResult.valid ? "ACCEPTED" : "REJECTED",
      errors: correctedResult.issues.map((entry) => `${entry.code}: ${entry.rule}`)
    }
  };
}

process.stdout.write(`${JSON.stringify({ schemaVersion: "averray.verification-contract/v1", rules: output }, null, 2)}\n`);

const passed = Object.values(output).every((drill) =>
  drill.withoutFreezeRules.status === "RED" &&
  drill.withFreezeRules.status === "GREEN" &&
  drill.corrected.status === "GREEN"
);
if (!passed) process.exitCode = 1;

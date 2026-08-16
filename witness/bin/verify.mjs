#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { executeVerificationContract, VERDICTS } from "../src/executor.mjs";
import { loadVerificationContract } from "../src/verification-contract.mjs";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--contract", "--candidate", "--out"].includes(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (!options.contract || !options.candidate) {
    throw new Error("usage: verify.mjs --contract <file> --candidate <patch> [--out <file>]");
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const contractPath = resolve(options.contract);
const candidatePatch = resolve(options.candidate);
const contract = await loadVerificationContract(contractPath);
const report = await executeVerificationContract({
  contract,
  candidatePatch,
  cwd: dirname(contractPath)
});
const json = `${JSON.stringify(report, null, 2)}\n`;
if (options.out) {
  const outputPath = resolve(options.out);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, json);
}
process.stdout.write(json);

const exitCodes = {
  [VERDICTS.PASS]: 0,
  [VERDICTS.FAIL]: 1,
  [VERDICTS.POLICY_VIOLATION]: 2,
  [VERDICTS.INCONCLUSIVE]: 3
};
process.exitCode = exitCodes[report.verdict];

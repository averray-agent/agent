#!/usr/bin/env node
import { dirname, resolve } from "node:path";

import {
  loadVerificationContract,
  validateVerificationContractAtFreeze
} from "../src/verification-contract.mjs";

const contractIndex = process.argv.indexOf("--contract");
const contractArgument = contractIndex >= 0 ? process.argv[contractIndex + 1] : null;
if (!contractArgument) throw new Error("usage: freeze-contract.mjs --contract <file>");
const contractPath = resolve(contractArgument);
const contract = await loadVerificationContract(contractPath);
const result = await validateVerificationContractAtFreeze(contract, { cwd: dirname(contractPath) });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.valid) process.exitCode = 1;

#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  createCodeChangeJob
} from "../src/code-change-publication.mjs";
import { loadVerificationContract } from "../src/verification-contract.mjs";

const options = parseArgs(process.argv.slice(2));
const contractPath = resolve(options.contract);
const jobPath = resolve(options.job);
const contract = await loadVerificationContract(contractPath);
const job = JSON.parse(await readFile(jobPath, "utf8"));
const { prepared, publication: result } = await createCodeChangeJob(
  { contract, job },
  {
    cwd: dirname(contractPath),
    apiUrl: options.apiUrl,
    token: options.token,
    idempotencyKey: options.idempotencyKey
  }
);
const evidence = {
  jobId: prepared.job.id,
  contractDigest: prepared.contractDigest,
  preflight: prepared.preflight,
  freeze: prepared.freeze,
  published: Boolean(result),
  ...(result ? { created: result.created, boardDefinition: result.definition } : { job: prepared.job })
};
const json = `${JSON.stringify(evidence, null, 2)}\n`;
if (options.out) {
  const output = resolve(options.out);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, json);
} else {
  process.stdout.write(json);
}

function parseArgs(argv) {
  const result = {
    apiUrl: process.env.API_URL || "",
    token: process.env.ADMIN_JWT || process.env.AVERRAY_TOKEN || ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--contract", "--job", "--api", "--token", "--idempotency-key", "--out"].includes(flag)) {
      throw new Error(`unknown flag: ${flag}`);
    }
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--contract") result.contract = value;
    if (flag === "--job") result.job = value;
    if (flag === "--api") result.apiUrl = value;
    if (flag === "--token") result.token = value;
    if (flag === "--idempotency-key") result.idempotencyKey = value;
    if (flag === "--out") result.out = value;
    index += 1;
  }
  if (!result.contract || !result.job) throw new Error("--contract and --job are required");
  if (result.apiUrl && !result.token) throw new Error("--token is required when --api is supplied");
  return result;
}

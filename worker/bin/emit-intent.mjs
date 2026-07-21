#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { mapJobToTaskIntent, serializeIntent } from "../src/job-adapter.js";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      workspace: { type: "string" },
      "verify-command": { type: "string" },
      "working-directory": { type: "string" },
      profile: { type: "string" },
      revision: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 1) {
    throw new TypeError("Provide at most one job JSON file; omit it or use '-' for stdin");
  }

  const inputPath = positionals[0];
  const input = inputPath && inputPath !== "-"
    ? await readFile(inputPath, "utf8")
    : await readStdin();
  const job = JSON.parse(input);
  const { intent, warnings } = mapJobToTaskIntent(job, {
    workspacePath: values.workspace,
    verifyCommand: values["verify-command"],
    workingDirectory: values["working-directory"],
    profile: values.profile,
    revision: values.revision,
  });

  process.stdout.write(serializeIntent(intent));
  for (const warning of warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
  if (warnings.length > 0) {
    process.exitCode = 3;
  }
}

main().catch((error) => {
  process.stderr.write(`emit-intent: ${error.message}\n`);
  process.exitCode = 2;
});

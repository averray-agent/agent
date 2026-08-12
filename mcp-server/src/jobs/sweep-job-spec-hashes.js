#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "http://localhost:8787";

export function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    parsed[key] = next && !next.startsWith("--") ? next : true;
    if (next && !next.startsWith("--")) index += 1;
  }
  return parsed;
}

export async function runJobSpecHashSweepCli({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = fetch,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  const args = parseArgs(argv);
  const baseUrl = String(args["base-url"] ?? env.AGENT_API_BASE_URL ?? DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/u, "");
  const adminToken = String(env.AGENT_ADMIN_TOKEN ?? "").trim();
  if (!adminToken) {
    throw new Error("AGENT_ADMIN_TOKEN is required for the guarded live board sweep.");
  }

  const response = await fetchImpl(`${baseUrl}/admin/jobs/spec-hash-sweep`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json"
    },
    body: "{}"
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.message ?? body?.error ?? `Sweep failed with HTTP ${response.status}.`);
  }

  stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  if (body.guardTriggered === true) {
    stderr.write(
      `Operator handback required: ${body.drifted} of ${body.total} committed served jobs drifted; no jobs were changed.\n`
    );
    return { summary: body, exitCode: 2 };
  }
  return { summary: body, exitCode: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runJobSpecHashSweepCli();
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}

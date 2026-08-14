#!/usr/bin/env node
import { resolve } from "node:path";

import { formatSummary, loadReports, summarizeReports } from "../src/summary.mjs";

function parseArgs(argv) {
  const result = { json: false };
  for (const arg of argv) {
    if (arg === "--json") result.json = true;
    else if (!result.directory) result.directory = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!result.directory) throw new Error("usage: witness/bin/preflight-summary.mjs <report-directory> [--json]");
  return result;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const reports = await loadReports(resolve(options.directory));
  const summary = summarizeReports(reports);
  process.stdout.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : formatSummary(summary));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}

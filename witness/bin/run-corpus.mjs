#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runPreflight } from "../src/preflight.mjs";
import { formatSummary, summarizeReports } from "../src/summary.mjs";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const result = {
    manifest: resolve(WITNESS_ROOT, "corpus", "repos.json"),
    outDir: resolve(WITNESS_ROOT, "evidence", "corpus"),
    timeoutSeconds: 300
  };
  for (let index = 0; index < argv.length; index += 2) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === "--manifest") result.manifest = resolve(value);
    else if (arg === "--out-dir") result.outDir = resolve(value);
    else if (arg === "--timeout") result.timeoutSeconds = Number(value);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

const options = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
if (!Array.isArray(manifest) || manifest.length === 0) throw new Error("corpus manifest must be a non-empty array");
await mkdir(options.outDir, { recursive: true });

const reports = [];
for (let index = 0; index < manifest.length; index += 1) {
  const entry = manifest[index];
  console.error(`[${index + 1}/${manifest.length}] ${entry.repo}: ${entry.check}`);
  const report = await runPreflight({
    repo: entry.repo,
    check: entry.check,
    timeoutSeconds: options.timeoutSeconds,
    frozenInputs: entry.frozenInputs || [],
    protectedPaths: entry.protectedPaths || []
  });
  report.corpus = { why: entry.why, source: entry.source };
  reports.push(report);
  const filename = `${String(index + 1).padStart(2, "0")}-${entry.repo.replaceAll(/[^A-Za-z0-9_.-]+/gu, "-")}.json`;
  await writeFile(resolve(options.outDir, filename), `${JSON.stringify(report, null, 2)}\n`);
  console.error(`  ${report.classification} (${report.totalSeconds}s)`);
}

const summary = summarizeReports(reports);
await writeFile(resolve(options.outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(formatSummary(summary));

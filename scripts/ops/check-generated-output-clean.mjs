#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const GENERATED_PREFIXES = ["frontend/", "site/"];
const BYPASS_TAG = "[allow-generated]";

function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = git(["rev-parse", "--show-toplevel"]).trim();
  const mode = resolveMode(options);

  if (process.env.ALLOW_GENERATED_EDIT === "1") {
    console.log("check-generated-output-clean: bypassed by ALLOW_GENERATED_EDIT=1");
    return;
  }

  const changedFiles = listChangedFiles(mode, repoRoot);
  const generatedFiles = changedFiles.filter(isGeneratedPath);
  if (generatedFiles.length === 0) {
    console.log("check-generated-output-clean: ok");
    return;
  }

  if (mode.kind !== "staged" && commitMessagesIncludeBypass(mode, repoRoot)) {
    console.log(`check-generated-output-clean: bypassed by commit message tag ${BYPASS_TAG}`);
    return;
  }

  console.error("check-generated-output-clean: generated deploy output changed");
  console.error("");
  for (const file of generatedFiles) {
    console.error(`  ${file}`);
  }
  console.error("");
  console.error("Source changes should usually be made under app/ or marketing/.");
  console.error("CI and production deploy rebuild frontend/ and site/ from source.");
  console.error("");
  console.error("If this task intentionally changes generated static deploy output, rerun with:");
  console.error("  ALLOW_GENERATED_EDIT=1 <command>");
  console.error(`or include ${BYPASS_TAG} in the commit message for CI range checks.`);
  process.exit(1);
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--staged") {
      options.staged = true;
    } else if (arg === "--last-commit") {
      options.lastCommit = true;
    } else if (arg === "--range") {
      options.range = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--range=")) {
      options.range = arg.slice("--range=".length);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`check-generated-output-clean: unknown argument ${arg}`);
      printHelp();
      process.exit(2);
    }
  }
  return options;
}

function resolveMode(options) {
  const selected = [options.staged, options.lastCommit, Boolean(options.range)].filter(Boolean).length;
  if (selected > 1) {
    console.error("check-generated-output-clean: choose only one of --staged, --last-commit, or --range");
    process.exit(2);
  }
  if (options.staged) {
    return { kind: "staged" };
  }
  if (options.lastCommit) {
    return { kind: "lastCommit" };
  }
  if (options.range) {
    return { kind: "range", range: options.range };
  }
  if (process.env.BASE_SHA) {
    return { kind: "range", range: `${process.env.BASE_SHA}..HEAD` };
  }
  return { kind: "staged" };
}

function listChangedFiles(mode, cwd) {
  if (mode.kind === "staged") {
    return splitLines(git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"], { cwd }));
  }
  if (mode.kind === "lastCommit") {
    return splitLines(git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], { cwd }));
  }
  return splitLines(git(["diff", "--name-only", "--diff-filter=ACMR", mode.range], { cwd }));
}

function commitMessagesIncludeBypass(mode, cwd) {
  if (mode.kind === "lastCommit") {
    return git(["log", "-1", "--format=%B"], { cwd }).includes(BYPASS_TAG);
  }
  if (mode.kind === "range") {
    return git(["log", "--format=%B", mode.range], { cwd }).includes(BYPASS_TAG);
  }
  return false;
}

function isGeneratedPath(file) {
  return GENERATED_PREFIXES.some((prefix) => file === prefix.slice(0, -1) || file.startsWith(prefix));
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
}

function splitLines(output) {
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

function printHelp() {
  console.log(`Usage:
  node scripts/ops/check-generated-output-clean.mjs --staged
  node scripts/ops/check-generated-output-clean.mjs --range <base..head>
  node scripts/ops/check-generated-output-clean.mjs --last-commit

Rejects committed changes under frontend/ and site/ unless ALLOW_GENERATED_EDIT=1
is set or the checked commit range contains ${BYPASS_TAG}.`);
}

main();

#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_NAME = basename(fileURLToPath(import.meta.url));
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

export const SCHEMA_VERSION = "mainnet-audit-freeze-v1";

const REQUIRED_FILES = [
  "docs/AUDIT_PACKAGE.md",
  "docs/PROJECT_ROADMAP.md",
  "docs/PRODUCTION_CHECKLIST.md",
  "docs/THREAT_MODEL.md",
  "docs/MAINNET_PARAMETERS.md",
  "docs/INCIDENT_RESPONSE.md",
  "docs/MULTISIG_SETUP.md",
  "docs/PHASE_4E_PLAN.md",
  "docs/PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md",
  "docs/SECRETS.md",
  "docs/SECRETS_MIGRATION.md",
  "deployments/mainnet.env.example",
  "scripts/ops/check-mainnet-usdc-config.mjs",
  "scripts/ops/check-mainnet-env-secrets-proof.mjs",
  "scripts/ops/check-mainnet-smoke-proof.mjs",
  "scripts/ops/check-incident-response-proof.mjs"
];

const REQUIRED_POLKADOT_DOC_PATHS = [
  "reference/polkadot-hub/smart-contracts.md",
  "smart-contracts/precompiles/erc20.md",
  "smart-contracts/for-eth-devs/accounts.md",
  "smart-contracts/explorers.md"
];

const REQUIRED_REPRODUCTION_COMMANDS = [
  "npm install",
  "forge build",
  "forge test",
  "npm --workspace mcp-server test",
  "npm test",
  "npm run typecheck:app",
  "npm run build:frontend",
  "npm run build:site",
  "npm run typecheck:indexer",
  "npm run check:sdk-types"
];

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b0x[a-fA-F0-9]{64}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bASIA[0-9A-Z]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
  /\bre_[A-Za-z0-9_]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u
];

function usage() {
  return `Usage: node scripts/ops/${SCRIPT_NAME} [--tag audit/mainnet-YYYY-MM-DD] [--create-tag] [--evidence <path>] [--json]

Preflights a frozen external-audit candidate for mainnet launch. By default this
is read-only: it checks that HEAD matches origin/main, the worktree is clean, the
mainnet audit package links are valid, and the required package files exist.

Pass --create-tag to create a local annotated tag after all checks pass. The
script never pushes tags; run the printed git push command explicitly.
`;
}

export function defaultAuditTag(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("now must be a valid Date or timestamp");
  }
  return `audit/mainnet-${date.toISOString().slice(0, 10)}`;
}

export function parseArgs(argv, { now = new Date() } = {}) {
  const args = {
    tag: defaultAuditTag(now),
    createTag: false,
    evidencePath: undefined,
    json: false,
    allowDirty: false,
    skipOriginMainCheck: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tag") {
      args.tag = argv[index + 1];
      index += 1;
    } else if (arg === "--create-tag") {
      args.createTag = true;
    } else if (arg === "--evidence") {
      args.evidencePath = argv[index + 1];
      index += 1;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--allow-dirty") {
      args.allowDirty = true;
    } else if (arg === "--skip-origin-main-check") {
      args.skipOriginMainCheck = true;
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

export function validateAuditTag(tag) {
  const errors = [];
  if (typeof tag !== "string" || !tag.trim()) {
    errors.push("tag must be a non-empty string");
    return errors;
  }
  if (!/^audit\/mainnet-\d{4}-\d{2}-\d{2}$/u.test(tag)) {
    errors.push("tag must match audit/mainnet-YYYY-MM-DD");
  }
  const date = tag.slice("audit/mainnet-".length);
  if (!isIsoCalendarDate(date)) {
    errors.push("tag date must be a valid calendar date");
  }
  return errors;
}

function isIsoCalendarDate(date) {
  const match = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
  );
}

export function parseMarkdownLinks(markdown) {
  const links = [];
  const pattern = /\]\(([^)#][^)#]*)(?:#[^)]+)?\)/gu;
  for (const match of markdown.matchAll(pattern)) {
    const href = match[1].trim();
    if (!href || /^[a-z][a-z0-9+.-]*:/iu.test(href) || href.startsWith("mailto:")) {
      continue;
    }
    links.push(href);
  }
  return links;
}

export function findMissingLocalMarkdownLinks({ markdown, markdownPath, root }) {
  const markdownDir = dirname(markdownPath);
  const missing = [];
  const rootPath = resolve(root);
  for (const href of parseMarkdownLinks(markdown)) {
    const target = normalize(resolve(root, markdownDir, href));
    const targetRelative = relative(rootPath, target);
    if (targetRelative.startsWith("..") || isAbsolute(targetRelative) || !existsSync(target)) {
      missing.push(href);
    }
  }
  return missing;
}

export function collectAuditPackageChecks({
  root,
  auditPackagePath = "docs/AUDIT_PACKAGE.md",
  requiredFiles = REQUIRED_FILES
}) {
  const checks = [];
  const auditPackageAbs = resolve(root, auditPackagePath);
  const auditPackageExists = existsSync(auditPackageAbs);
  addCheck(checks, "auditPackage.exists", auditPackageExists, {
    path: auditPackagePath
  });

  let auditPackageText = "";
  if (auditPackageExists) {
    auditPackageText = readFileSync(auditPackageAbs, "utf8");
    addCheck(checks, "auditPackage.sha256", true, {
      sha256: sha256(auditPackageText)
    });
    const missingLinks = findMissingLocalMarkdownLinks({
      markdown: auditPackageText,
      markdownPath: auditPackagePath,
      root
    });
    addCheck(checks, "auditPackage.localLinks", missingLinks.length === 0, {
      missing: missingLinks
    });
    for (const docsPath of REQUIRED_POLKADOT_DOC_PATHS) {
      addCheck(checks, `auditPackage.polkadotDocs.${docsPath}`, auditPackageText.includes(docsPath), {
        path: docsPath
      });
    }
    for (const command of REQUIRED_REPRODUCTION_COMMANDS) {
      addCheck(checks, `auditPackage.reproduction.${command}`, auditPackageText.includes(command), {
        command
      });
    }
    addCheck(checks, "auditPackage.noObviousSecrets", !SECRET_PATTERNS.some((pattern) => pattern.test(auditPackageText)));
  }

  for (const file of requiredFiles) {
    addCheck(checks, `requiredFile.${file}`, existsSync(resolve(root, file)), { path: file });
  }

  return checks;
}

export function buildFreezePreflight({
  tag,
  headCommit,
  originMainCommit,
  statusPorcelain,
  tagCommit,
  packageChecks,
  allowDirty = false,
  skipOriginMainCheck = false,
  generatedAt = new Date()
}) {
  const checks = [];
  const tagErrors = validateAuditTag(tag);
  for (const error of tagErrors) {
    addCheck(checks, "tag.format", false, { error });
  }
  if (tagErrors.length === 0) {
    addCheck(checks, "tag.format", true, { tag });
  }

  addCheck(checks, "git.headCommit", isSha(headCommit), { commit: headCommit });
  if (skipOriginMainCheck) {
    addCheck(checks, "git.headMatchesOriginMain", true, {
      skipped: true,
      headCommit,
      originMainCommit
    });
  } else {
    addCheck(checks, "git.headMatchesOriginMain", headCommit === originMainCommit && isSha(headCommit), {
      headCommit,
      originMainCommit
    });
  }

  const dirtyEntries = parseDirtyEntries(statusPorcelain);
  addCheck(checks, "git.worktreeClean", allowDirty || dirtyEntries.length === 0, {
    allowDirty,
    dirtyEntries
  });

  if (tagCommit) {
    addCheck(checks, "git.tagAvailable", tagCommit === headCommit, {
      existingTagCommit: tagCommit,
      headCommit
    });
  } else {
    addCheck(checks, "git.tagAvailable", true, {
      existingTagCommit: null
    });
  }

  checks.push(...packageChecks);

  const ok = checks.every((check) => check.ok);
  return {
    schema: SCHEMA_VERSION,
    generatedAt: new Date(generatedAt).toISOString(),
    ok,
    tag,
    commit: headCommit,
    originMainCommit,
    checks,
    nextActions: ok ? [
      `git push origin refs/tags/${tag}`,
      "Record the tag, commit, report destination, and final deployed contract addresses in the external audit engagement brief.",
      "Do not deploy real-funds mainnet contracts from post-audit deltas unless they receive separate review."
    ] : []
  };
}

function parseDirtyEntries(statusPorcelain) {
  return String(statusPorcelain ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function isSha(value) {
  return /^[a-f0-9]{40}$/u.test(String(value ?? ""));
}

function addCheck(checks, name, ok, details = {}) {
  checks.push({ name, ok: Boolean(ok), ...details });
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (error) {
    if (allowFailure) return "";
    const stderr = String(error.stderr ?? "").trim();
    throw new Error(stderr || error.message);
  }
}

function writeEvidence(path, result) {
  const absPath = resolve(repoRoot, path);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, `${JSON.stringify(result, null, 2)}\n`);
}

function printHuman(result, { createdTag = false, evidencePath = undefined } = {}) {
  const status = result.ok ? "ok" : "failed";
  console.log(`Mainnet audit freeze preflight: ${status}`);
  console.log(`tag: ${result.tag}`);
  console.log(`commit: ${result.commit}`);
  if (createdTag) console.log("local tag: created");
  if (evidencePath) console.log(`evidence: ${evidencePath}`);
  console.log("");
  console.log("Checks:");
  for (const check of result.checks) {
    console.log(`- ${check.ok ? "ok" : "fail"} ${check.name}`);
    if (!check.ok && check.error) console.log(`  ${check.error}`);
    if (!check.ok && Array.isArray(check.missing) && check.missing.length > 0) {
      for (const missing of check.missing) console.log(`  missing: ${missing}`);
    }
    if (!check.ok && Array.isArray(check.dirtyEntries) && check.dirtyEntries.length > 0) {
      for (const dirty of check.dirtyEntries) console.log(`  dirty: ${dirty}`);
    }
  }
  if (result.ok) {
    console.log("");
    console.log("Next:");
    for (const action of result.nextActions) console.log(`- ${action}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const headCommit = git(["rev-parse", "HEAD"]);
  const originMainCommit = args.skipOriginMainCheck ? "" : git(["rev-parse", "origin/main"], { allowFailure: true });
  const statusPorcelain = git(["status", "--porcelain"]);
  const tagCommit = git(["rev-parse", "-q", "--verify", `refs/tags/${args.tag}^{}`], { allowFailure: true });
  const packageChecks = collectAuditPackageChecks({ root: repoRoot });
  const result = buildFreezePreflight({
    tag: args.tag,
    headCommit,
    originMainCommit,
    statusPorcelain,
    tagCommit,
    packageChecks,
    allowDirty: args.allowDirty,
    skipOriginMainCheck: args.skipOriginMainCheck
  });

  let createdTag = false;
  if (result.ok && args.createTag && !tagCommit) {
    git(["tag", "-a", args.tag, headCommit, "-m", `Freeze mainnet audit package at ${headCommit}`]);
    createdTag = true;
  }
  if (result.ok && args.evidencePath) {
    writeEvidence(args.evidencePath, { ...result, createdTag });
  }

  if (args.json) {
    console.log(JSON.stringify({ ...result, createdTag, evidencePath: args.evidencePath ?? null }, null, 2));
  } else {
    printHuman(result, { createdTag, evidencePath: args.evidencePath });
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

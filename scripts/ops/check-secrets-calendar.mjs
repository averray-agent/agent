#!/usr/bin/env node

/**
 * Reads docs/SECRETS_CALENDAR.yml and warns when any tracked token's
 * `expires_at` is within the warning window of now.
 *
 * Designed to run on every CI build — non-zero exit when any entry
 * is past expiry; otherwise prints a summary and exits zero. Warnings
 * (within `warn_days` but not yet expired) print but do NOT fail CI,
 * because failing CI on a 7-day warning would block legitimate work.
 *
 * Usage:
 *   node scripts/ops/check-secrets-calendar.mjs
 *   node scripts/ops/check-secrets-calendar.mjs --calendar docs/SECRETS_CALENDAR.yml
 *   node scripts/ops/check-secrets-calendar.mjs --json
 *
 * Exit codes:
 *   0  All entries are healthy or only emitting warnings
 *   1  Script error (bad YAML, missing file, etc.)
 *   2  At least one entry is past expiry
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

// CI intentionally runs this lint before npm install. Prefer js-yaml when a
// local node_modules tree exists, but keep a small parser for this repo's
// calendar shape so the check remains self-contained on clean runners.
const require = createRequire(import.meta.url);
let parseCalendarYaml;
if (process.env.SECRETS_CALENDAR_SIMPLE_YAML === "1") {
  parseCalendarYaml = parseSimpleCalendarYaml;
} else {
  try {
    const yaml = require("js-yaml");
    parseCalendarYaml = (raw) => yaml.load(raw);
  } catch (error) {
    parseCalendarYaml = parseSimpleCalendarYaml;
  }
}

function stripInlineComment(value) {
  let quote = "";
  let output = "";
  for (const char of value) {
    if ((char === "\"" || char === "'") && !quote) {
      quote = char;
      output += char;
      continue;
    }
    if (char === quote) {
      quote = "";
      output += char;
      continue;
    }
    if (char === "#" && !quote) break;
    output += char;
  }
  return output.trim();
}

function parseScalar(value) {
  const clean = stripInlineComment(value);
  if (!clean) return "";
  if (
    (clean.startsWith("\"") && clean.endsWith("\"")) ||
    (clean.startsWith("'") && clean.endsWith("'"))
  ) {
    return clean.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(clean)) return Number(clean);
  if (clean === "true") return true;
  if (clean === "false") return false;
  return clean;
}

function parseSimpleCalendarYaml(raw) {
  const parsed = { entries: [], config: {} };
  let section = "";
  let currentEntry;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^entries:\s*$/.test(line)) {
      section = "entries";
      currentEntry = undefined;
      continue;
    }
    if (/^config:\s*$/.test(line)) {
      section = "config";
      currentEntry = undefined;
      continue;
    }

    if (section === "entries") {
      const entryMatch = line.match(/^  - name:\s*(.*)$/);
      if (entryMatch) {
        currentEntry = { name: parseScalar(entryMatch[1]) };
        parsed.entries.push(currentEntry);
        continue;
      }

      const fieldMatch = line.match(/^    ([A-Za-z0-9_]+):\s*(.*)$/);
      if (fieldMatch && currentEntry) {
        const [, key, value] = fieldMatch;
        currentEntry[key] = value.trim() === "|" ? "" : parseScalar(value);
      }
      continue;
    }

    if (section === "config") {
      const configMatch = line.match(/^  ([A-Za-z0-9_]+):\s*(.*)$/);
      if (configMatch) {
        const [, key, value] = configMatch;
        parsed.config[key] = parseScalar(value);
      }
    }
  }

  return parsed;
}

function parseArgs(argv) {
  const args = {
    calendarPath: resolve(repoRoot, "docs", "SECRETS_CALENDAR.yml"),
    jsonOutput: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--calendar") args.calendarPath = resolve(argv[++i]);
    else if (flag === "--json") args.jsonOutput = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
  }
  return args;
}

function classify(entry, now, defaults) {
  const warnDays = Number.isFinite(entry.warn_days) ? entry.warn_days : defaults.default_warn_days;
  const failWithinDays = defaults.fail_within_days;
  const expiresAtRaw = entry.expires_at;

  if (expiresAtRaw === "never") {
    return { status: "skip", reason: "expires_at=never (intentional, no expiry tracking)" };
  }
  if (expiresAtRaw === "TBD") {
    return { status: "warn", reason: "expires_at=TBD — set this after the next rotation" };
  }
  if (typeof expiresAtRaw !== "string") {
    return { status: "error", reason: `expires_at must be a YYYY-MM-DD string, "TBD", or "never"; got ${JSON.stringify(expiresAtRaw)}` };
  }
  const expiresAt = new Date(expiresAtRaw);
  if (Number.isNaN(expiresAt.getTime())) {
    return { status: "error", reason: `expires_at "${expiresAtRaw}" is not a valid date` };
  }
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysUntilExpiry = Math.ceil((expiresAt.getTime() - now.getTime()) / msPerDay);
  if (daysUntilExpiry <= 0) {
    return { status: "fail", reason: `expired ${Math.abs(daysUntilExpiry)} day${Math.abs(daysUntilExpiry) === 1 ? "" : "s"} ago`, daysUntilExpiry };
  }
  if (daysUntilExpiry <= failWithinDays) {
    return { status: "fail", reason: `expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"} (within fail_within_days=${failWithinDays})`, daysUntilExpiry };
  }
  if (daysUntilExpiry <= warnDays) {
    return { status: "warn", reason: `expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}`, daysUntilExpiry };
  }
  return { status: "ok", reason: `expires in ${daysUntilExpiry} days`, daysUntilExpiry };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        "Usage: node scripts/ops/check-secrets-calendar.mjs [options]",
        "",
        "Options:",
        "  --calendar <path>   Calendar YAML file. Default: docs/SECRETS_CALENDAR.yml",
        "  --json              Output a JSON report instead of human-readable lines",
        "",
        "Exit codes:",
        "  0   all healthy / warnings only",
        "  1   script error (bad YAML, missing file)",
        "  2   one or more entries past expiry"
      ].join("\n")
    );
    return;
  }

  let raw;
  try {
    raw = await readFile(args.calendarPath, "utf8");
  } catch (error) {
    console.error(`could not read calendar at ${args.calendarPath}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  let parsed;
  try {
    parsed = parseCalendarYaml(raw);
  } catch (error) {
    console.error(`could not parse calendar YAML: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  const config = parsed?.config ?? {};
  const defaults = {
    default_warn_days: Number.isFinite(config.default_warn_days) ? config.default_warn_days : 7,
    fail_within_days: Number.isFinite(config.fail_within_days) ? config.fail_within_days : 1
  };
  const now = new Date();

  const results = entries.map((entry) => ({
    name: String(entry.name ?? "(unnamed)"),
    description: String(entry.description ?? ""),
    owner: String(entry.owner ?? "unknown"),
    expiresAt: String(entry.expires_at ?? ""),
    ...classify(entry, now, defaults)
  }));

  if (args.jsonOutput) {
    console.log(JSON.stringify({ now: now.toISOString(), defaults, entries: results }, null, 2));
  } else {
    console.log(`# secrets calendar (${args.calendarPath})`);
    console.log(`now: ${now.toISOString()}`);
    console.log(`fail_within_days=${defaults.fail_within_days}, default_warn_days=${defaults.default_warn_days}`);
    console.log("");
    for (const r of results) {
      const icon = { ok: "✅", warn: "⚠️", fail: "❌", skip: "—", error: "💥" }[r.status] ?? "?";
      console.log(`${icon}  ${r.name.padEnd(36, " ")} owner=${r.owner.padEnd(12, " ")} expires=${r.expiresAt.padEnd(12, " ")} ${r.reason}`);
    }
  }

  const totals = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  if (!args.jsonOutput) {
    console.log("");
    console.log(`summary: ${totals.ok ?? 0} ok · ${totals.warn ?? 0} warn · ${totals.fail ?? 0} fail · ${totals.skip ?? 0} skipped · ${totals.error ?? 0} errors`);
  }

  if ((totals.fail ?? 0) > 0 || (totals.error ?? 0) > 0) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`check-secrets-calendar failed: ${error?.stack ?? error?.message ?? error}`);
  process.exitCode = 1;
});

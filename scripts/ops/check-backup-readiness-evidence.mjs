#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_NAME = basename(fileURLToPath(import.meta.url));
const COMPONENT_RULES = {
  postgres: {
    suffix: ".sql.gz"
  },
  redis: {
    suffix: ".rdb.gz"
  }
};

function usage() {
  return `Usage: node scripts/ops/${SCRIPT_NAME} --file docs/evidence/backup-readiness-YYYY-MM-DD.json [--json] [--max-checked-age-hours N]

Validates the saved JSON emitted by check-backup-readiness.sh --json. This
check is read-only; it does not inspect, restore, delete, or modify backups.
`;
}

function parseArgs(argv) {
  const args = {
    file: undefined,
    json: false,
    maxCheckedAgeHours: undefined,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      args.file = argv[index + 1];
      index += 1;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--max-checked-age-hours") {
      args.maxCheckedAgeHours = parsePositiveInteger(argv[index + 1], "--max-checked-age-hours");
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (!args.file && !arg.startsWith("-")) {
      args.file = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

function parsePositiveInteger(value, flag) {
  if (!/^[1-9][0-9]*$/u.test(String(value ?? ""))) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return Number(value);
}

function assertObject(value, path, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return {};
  }
  return value;
}

function requireString(value, path, errors, { pattern = undefined } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path} must be a non-empty string`);
    return "";
  }
  const trimmed = value.trim();
  if (pattern && !pattern.test(trimmed)) {
    errors.push(`${path} has an invalid format`);
  }
  return trimmed;
}

function requireNumber(value, path, errors, { integer = false, min = undefined } = {}) {
  const ok = integer ? Number.isInteger(value) : Number.isFinite(value);
  if (!ok) {
    errors.push(`${path} must be ${integer ? "an integer" : "a finite number"}`);
    return undefined;
  }
  if (min !== undefined && value < min) {
    errors.push(`${path} must be >= ${min}`);
  }
  return value;
}

function requireIsoDate(value, path, errors) {
  const raw = requireString(value, path, errors);
  if (!raw) return "";
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(raw) || !Number.isFinite(Date.parse(raw))) {
    errors.push(`${path} must be an ISO-8601 date/time`);
  }
  return raw;
}

function requireArray(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  return value;
}

function componentByName(readiness, name) {
  const components = Array.isArray(readiness?.components) ? readiness.components : [];
  return components.find((component) => component?.name === name);
}

function validateComponent(readiness, name, errors) {
  const rules = COMPONENT_RULES[name];
  const component = assertObject(componentByName(readiness, name), `components.${name}`, errors);

  if (component.status !== "ok") {
    errors.push(`components.${name}.status must be ok`);
  }
  const file = requireString(component.file, `components.${name}.file`, errors);
  if (file && !file.endsWith(rules.suffix)) {
    errors.push(`components.${name}.file must end with ${rules.suffix}`);
  }
  const ageSeconds = requireNumber(component.ageSeconds, `components.${name}.ageSeconds`, errors, {
    integer: true,
    min: 0
  });
  requireString(component.message, `components.${name}.message`, errors);

  if (Number.isInteger(readiness.maxAgeHours) && Number.isInteger(ageSeconds)) {
    const maxAgeSeconds = readiness.maxAgeHours * 3600;
    if (ageSeconds > maxAgeSeconds) {
      errors.push(`components.${name}.ageSeconds must be <= maxAgeHours * 3600`);
    }
  }

  return { file, ageSeconds };
}

export function validateEvidence(evidence, options = {}) {
  const errors = [];
  const warnings = [];
  const doc = assertObject(evidence, "evidence", errors);

  const checkedAt = requireIsoDate(doc.checkedAt, "checkedAt", errors);
  requireString(doc.backupDir, "backupDir", errors);
  requireNumber(doc.maxAgeHours, "maxAgeHours", errors, { integer: true, min: 1 });
  if (doc.overallStatus !== "ok") {
    errors.push("overallStatus must be ok");
  }

  const components = requireArray(doc.components, "components", errors);
  const seenComponents = new Set();
  for (const [index, rawComponent] of components.entries()) {
    const component = assertObject(rawComponent, `components[${index}]`, errors);
    const name = requireString(component.name, `components[${index}].name`, errors);
    if (!name) continue;
    if (seenComponents.has(name)) {
      errors.push(`components must not contain duplicate ${name}`);
    }
    seenComponents.add(name);
  }

  const postgres = validateComponent(doc, "postgres", errors);
  const redis = validateComponent(doc, "redis", errors);

  if (checkedAt && options.maxCheckedAgeHours !== undefined) {
    const checkedAtMs = Date.parse(checkedAt);
    const nowMs = Date.now();
    const maxAgeMs = options.maxCheckedAgeHours * 3600 * 1000;
    const futureSlackMs = 5 * 60 * 1000;
    if (checkedAtMs > nowMs + futureSlackMs) {
      errors.push("checkedAt must not be in the future");
    } else if (nowMs - checkedAtMs > maxAgeMs) {
      errors.push(`checkedAt must be within ${options.maxCheckedAgeHours}h`);
    }
  }

  if (!errors.length && options.maxCheckedAgeHours === undefined) {
    warnings.push("checkedAt freshness was not enforced; use --max-checked-age-hours for launch proof");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      checkedAt: doc.checkedAt,
      backupDir: doc.backupDir,
      maxAgeHours: doc.maxAgeHours,
      postgresFile: postgres.file,
      postgresAgeSeconds: postgres.ageSeconds,
      redisFile: redis.file,
      redisAgeSeconds: redis.ageSeconds
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (!args.file) {
    throw new Error("--file is required");
  }

  const parsed = JSON.parse(await readFile(args.file, "utf8"));
  const result = validateEvidence(parsed, {
    maxCheckedAgeHours: args.maxCheckedAgeHours
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      status: result.ok ? "ok" : "not_ok",
      file: args.file,
      summary: result.summary,
      warnings: result.warnings,
      errors: result.errors
    }, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`Backup readiness evidence ok: ${args.file}\n`);
    for (const warning of result.warnings) {
      process.stderr.write(`- warning: ${warning}\n`);
    }
  } else {
    process.stderr.write(`Backup readiness evidence invalid: ${args.file}\n`);
    for (const error of result.errors) {
      process.stderr.write(`- ${error}\n`);
    }
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

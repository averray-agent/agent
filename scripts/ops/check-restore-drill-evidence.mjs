#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_NAME = basename(fileURLToPath(import.meta.url));
const SCHEMA_VERSION = "restore-drill-evidence-v1";

function usage() {
  return `Usage: node scripts/ops/${SCRIPT_NAME} --file docs/evidence/restore-drill-YYYY-MM-DD.json [--json]

Validates the machine-readable evidence produced by the monthly backup restore
drill. This check is read-only; it does not restore, delete, or modify backups.
`;
}

function parseArgs(argv) {
  const args = {
    file: undefined,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      args.file = argv[index + 1];
      index += 1;
    } else if (arg === "--json") {
      args.json = true;
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

function requireBoolean(value, path, errors) {
  if (typeof value !== "boolean") {
    errors.push(`${path} must be boolean`);
    return undefined;
  }
  return value;
}

function requireIsoDate(value, path, errors) {
  const raw = requireString(value, path, errors);
  if (!raw) return "";
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(raw)) {
    errors.push(`${path} must be an ISO-8601 date/time`);
    return raw;
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    errors.push(`${path} must be an ISO-8601 date/time`);
  }
  return raw;
}

function requireDateOnly(value, path, errors) {
  return requireString(value, path, errors, { pattern: /^\d{4}-\d{2}-\d{2}$/u });
}

function readinessComponent(readiness, name) {
  const components = Array.isArray(readiness?.components) ? readiness.components : [];
  return components.find((component) => component?.name === name);
}

function validateBackupComponent(component, name, suffix, errors) {
  const path = `readiness.components.${name}`;
  if (!component) {
    errors.push(`${path} is required`);
    return "";
  }
  if (component.status !== "ok") {
    errors.push(`${path}.status must be ok`);
  }
  const file = requireString(component.file, `${path}.file`, errors);
  if (file && !file.endsWith(suffix)) {
    errors.push(`${path}.file must end with ${suffix}`);
  }
  requireNumber(component.ageSeconds, `${path}.ageSeconds`, errors, { integer: true, min: 0 });
  return file;
}

function sameBackupFile(left, right) {
  return Boolean(left && right && basename(left) === basename(right));
}

function validateEvidence(evidence) {
  const errors = [];
  const doc = assertObject(evidence, "evidence", errors);

  if (doc.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  }
  requireDateOnly(doc.drillDate, "drillDate", errors);
  requireIsoDate(doc.completedAt, "completedAt", errors);

  const operator = assertObject(doc.operator, "operator", errors);
  requireString(operator.name, "operator.name", errors);
  requireString(operator.signature, "operator.signature", errors);

  const target = assertObject(doc.target, "target", errors);
  const targetType = requireString(target.type, "target.type", errors);
  if (!["disposable_container", "disposable_vm", "local_throwaway"].includes(targetType)) {
    errors.push("target.type must be disposable_container, disposable_vm, or local_throwaway");
  }
  requireString(target.label, "target.label", errors);
  if (/prod|production|live/i.test(String(target.label ?? ""))) {
    errors.push("target.label must not describe a production/live target");
  }

  const readiness = assertObject(doc.readiness, "readiness", errors);
  if (readiness.overallStatus !== "ok") {
    errors.push("readiness.overallStatus must be ok");
  }
  requireIsoDate(readiness.checkedAt, "readiness.checkedAt", errors);
  requireString(readiness.backupDir, "readiness.backupDir", errors);
  requireNumber(readiness.maxAgeHours, "readiness.maxAgeHours", errors, { integer: true, min: 1 });
  const postgresReadinessFile = validateBackupComponent(
    readinessComponent(readiness, "postgres"),
    "postgres",
    ".sql.gz",
    errors
  );
  const redisReadinessFile = validateBackupComponent(
    readinessComponent(readiness, "redis"),
    "redis",
    ".rdb.gz",
    errors
  );

  const postgres = assertObject(doc.postgres, "postgres", errors);
  const postgresBackupFile = requireString(postgres.backupFile, "postgres.backupFile", errors);
  if (postgresBackupFile && !postgresBackupFile.endsWith(".sql.gz")) {
    errors.push("postgres.backupFile must end with .sql.gz");
  }
  if (postgresReadinessFile && !sameBackupFile(postgresReadinessFile, postgresBackupFile)) {
    errors.push("postgres.backupFile must match the readiness postgres backup file");
  }
  requireString(postgres.restoreTarget, "postgres.restoreTarget", errors);
  if (!/drill|throwaway|disposable/i.test(String(postgres.restoreTarget ?? ""))) {
    errors.push("postgres.restoreTarget must clearly be a drill/throwaway target");
  }
  requireNumber(postgres.restoreExitCode, "postgres.restoreExitCode", errors, { integer: true, min: 0 });
  if (postgres.restoreExitCode !== 0) {
    errors.push("postgres.restoreExitCode must be 0");
  }
  const rowCheck = assertObject(postgres.rowCheck, "postgres.rowCheck", errors);
  requireString(rowCheck.query, "postgres.rowCheck.query", errors);
  requireNumber(rowCheck.rowCount, "postgres.rowCheck.rowCount", errors, { integer: true, min: 0 });

  const redis = assertObject(doc.redis, "redis", errors);
  const redisBackupFile = requireString(redis.backupFile, "redis.backupFile", errors);
  if (redisBackupFile && !redisBackupFile.endsWith(".rdb.gz")) {
    errors.push("redis.backupFile must end with .rdb.gz");
  }
  if (redisReadinessFile && !sameBackupFile(redisReadinessFile, redisBackupFile)) {
    errors.push("redis.backupFile must match the readiness redis backup file");
  }
  requireString(redis.restoreTarget, "redis.restoreTarget", errors);
  if (!/drill|throwaway|disposable/i.test(String(redis.restoreTarget ?? ""))) {
    errors.push("redis.restoreTarget must clearly be a drill/throwaway target");
  }
  requireNumber(redis.restoreExitCode, "redis.restoreExitCode", errors, { integer: true, min: 0 });
  if (redis.restoreExitCode !== 0) {
    errors.push("redis.restoreExitCode must be 0");
  }
  requireNumber(redis.dbSize, "redis.dbSize", errors, { integer: true, min: 0 });

  const cleanup = assertObject(doc.cleanup, "cleanup", errors);
  if (requireBoolean(cleanup.postgresTargetRemoved, "cleanup.postgresTargetRemoved", errors) !== true) {
    errors.push("cleanup.postgresTargetRemoved must be true");
  }
  if (requireBoolean(cleanup.redisTargetRemoved, "cleanup.redisTargetRemoved", errors) !== true) {
    errors.push("cleanup.redisTargetRemoved must be true");
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      drillDate: doc.drillDate,
      postgresBackupFile,
      redisBackupFile,
      postgresRowCount: rowCheck.rowCount,
      redisDbSize: redis.dbSize,
      operator: operator.name
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
  const raw = await readFile(args.file, "utf8");
  const parsed = JSON.parse(raw);
  const result = validateEvidence(parsed);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      status: result.ok ? "ok" : "not_ok",
      file: args.file,
      summary: result.summary,
      errors: result.errors
    }, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`Restore drill evidence ok: ${args.file}\n`);
  } else {
    process.stderr.write(`Restore drill evidence invalid: ${args.file}\n`);
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

export {
  SCHEMA_VERSION,
  validateEvidence
};

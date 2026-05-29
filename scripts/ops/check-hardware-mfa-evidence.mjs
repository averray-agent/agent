#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_NAME = basename(fileURLToPath(import.meta.url));
export const SCHEMA_VERSION = "hardware-mfa-evidence-v1";
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const REQUIRED_ACCOUNT_IDS = [
  "one_password_admin",
  "aws_root",
  "aws_iam_admins",
  "github_org_admin",
  "domain_registrar",
  "vps_provider"
];

const ALLOWED_METHODS = new Set(["provider_ui", "provider_api", "operator_attestation"]);

function usage() {
  return `Usage: node scripts/ops/${SCRIPT_NAME} --file docs/evidence/hardware-mfa-YYYY-MM-DD.json [--json] [--max-completed-age-hours N] [--now <iso>]

Validates the operator evidence that hardware-backed MFA is enrolled across the
admin trust chain. This check is read-only; it does not call providers or store
recovery codes.

Use --max-completed-age-hours when validating live launch evidence so stale
historical artifacts cannot be reused as current admin-trust proof.

Use --now <iso> to pin the freshness comparison clock to an ISO-8601 date/time
(defaults to the current time); primarily for deterministic tests.
`;
}

function parseIsoNow(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(value.trim())) {
    throw new Error("--now must be an ISO-8601 date/time");
  }
  const date = new Date(value.trim());
  if (!Number.isFinite(date.getTime())) {
    throw new Error("--now must be an ISO-8601 date/time");
  }
  return date;
}

function parseArgs(argv) {
  const args = {
    file: undefined,
    json: false,
    help: false,
    maxCompletedAgeHours: undefined,
    now: undefined
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      args.file = argv[index + 1];
      index += 1;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--max-completed-age-hours") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--max-completed-age-hours must be a positive number");
      }
      args.maxCompletedAgeHours = value;
      index += 1;
    } else if (arg === "--now") {
      args.now = parseIsoNow(argv[index + 1]);
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
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(raw) || !Number.isFinite(Date.parse(raw))) {
    errors.push(`${path} must be an ISO-8601 date/time`);
  }
  return raw;
}

function requireIsoTimestamp(value, path, errors) {
  const raw = requireIsoDate(value, path, errors);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function requireNonEmptyArray(value, path, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path} must be a non-empty array`);
    return [];
  }
  return value;
}

function containsSecretLikeValue(value) {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /\bAKIA[0-9A-Z]{16}\b/u,
    /\bASIA[0-9A-Z]{16}\b/u,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/u,
    /\b0x[a-fA-F0-9]{64}\b/u,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u
  ];
  return patterns.some((pattern) => pattern.test(trimmed));
}

function scanForSecretLikeValues(value, path, errors) {
  if (containsSecretLikeValue(value)) {
    errors.push(`${path} appears to contain a secret value; store recovery material outside this evidence file`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForSecretLikeValues(entry, `${path}[${index}]`, errors));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      scanForSecretLikeValues(entry, `${path}.${key}`, errors);
    }
  }
}

function assertFreshTimestamp(timestamp, path, options, errors, { completedAt = undefined } = {}) {
  if (!Number.isFinite(timestamp)) return;
  if (Number.isFinite(completedAt) && timestamp > completedAt + FUTURE_SKEW_MS) {
    errors.push(`${path} must not be later than completedAt`);
  }

  const maxCompletedAgeHours = options.maxCompletedAgeHours;
  if (maxCompletedAgeHours === undefined) return;
  if (!Number.isFinite(maxCompletedAgeHours) || maxCompletedAgeHours <= 0) {
    errors.push("maxCompletedAgeHours must be a positive number");
    return;
  }

  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    errors.push("now must be a valid Date or timestamp");
    return;
  }
  if (timestamp > nowMs + FUTURE_SKEW_MS) {
    errors.push(`${path} must not be in the future`);
  }
  const maxAgeMs = maxCompletedAgeHours * 60 * 60 * 1000;
  if (nowMs - timestamp > maxAgeMs) {
    errors.push(`${path} must be within ${maxCompletedAgeHours} hour(s)`);
  }
}

function validateHardwareKeys(keys, errors) {
  const items = requireNonEmptyArray(keys, "hardwareKeys", errors);
  if (items.length < 2) {
    errors.push("hardwareKeys must include at least two keys");
  }
  const labels = new Set();
  for (const [index, rawKey] of items.entries()) {
    const path = `hardwareKeys[${index}]`;
    const key = assertObject(rawKey, path, errors);
    const label = requireString(key.label, `${path}.label`, errors);
    if (label) labels.add(label);
    requireString(key.serialFingerprint, `${path}.serialFingerprint`, errors, {
      pattern: /^[A-Za-z0-9._:-]{4,80}$/u
    });
    if (requireBoolean(key.physicalCustodyConfirmed, `${path}.physicalCustodyConfirmed`, errors) !== true) {
      errors.push(`${path}.physicalCustodyConfirmed must be true`);
    }
  }
  return labels;
}

function validateAccount(rawAccount, index, keyLabels, errors, { completedAt, freshnessOptions }) {
  const path = `accounts[${index}]`;
  const account = assertObject(rawAccount, path, errors);
  const id = requireString(account.id, `${path}.id`, errors);
  requireString(account.provider, `${path}.provider`, errors);
  requireString(account.accountLabel, `${path}.accountLabel`, errors);
  if (account.status !== "hardware_key_enrolled") {
    errors.push(`${path}.status must be hardware_key_enrolled`);
  }
  const primary = requireString(account.primaryKeyLabel, `${path}.primaryKeyLabel`, errors);
  const backup = requireString(account.backupKeyLabel, `${path}.backupKeyLabel`, errors);
  if (primary && !keyLabels.has(primary)) {
    errors.push(`${path}.primaryKeyLabel must match a hardwareKeys[].label`);
  }
  if (backup && !keyLabels.has(backup)) {
    errors.push(`${path}.backupKeyLabel must match a hardwareKeys[].label`);
  }
  if (primary && backup && primary === backup) {
    errors.push(`${path}.primaryKeyLabel and ${path}.backupKeyLabel must be different`);
  }
  if (requireBoolean(account.backupKeyLoginTested, `${path}.backupKeyLoginTested`, errors) !== true) {
    errors.push(`${path}.backupKeyLoginTested must be true`);
  }
  if (requireBoolean(account.recoveryPathDocumented, `${path}.recoveryPathDocumented`, errors) !== true) {
    errors.push(`${path}.recoveryPathDocumented must be true`);
  }
  if (requireBoolean(account.recoveryCodesStored, `${path}.recoveryCodesStored`, errors) !== true) {
    errors.push(`${path}.recoveryCodesStored must be true`);
  }
  requireString(account.recoveryLocation, `${path}.recoveryLocation`, errors);
  const lastVerifiedAt = requireIsoTimestamp(account.lastVerifiedAt, `${path}.lastVerifiedAt`, errors);
  assertFreshTimestamp(lastVerifiedAt, `${path}.lastVerifiedAt`, freshnessOptions, errors, { completedAt });

  const evidence = assertObject(account.evidence, `${path}.evidence`, errors);
  const method = requireString(evidence.method, `${path}.evidence.method`, errors);
  if (method && !ALLOWED_METHODS.has(method)) {
    errors.push(`${path}.evidence.method must be provider_ui, provider_api, or operator_attestation`);
  }
  requireString(evidence.reference, `${path}.evidence.reference`, errors);

  if (id === "domain_registrar") {
    if (requireBoolean(account.fido2Supported, `${path}.fido2Supported`, errors) !== true) {
      errors.push(`${path}.fido2Supported must be true; migrate registrar before mainnet if unavailable`);
    }
  }
  if (id === "github_org_admin") {
    if (requireBoolean(account.memberAuditCompleted, `${path}.memberAuditCompleted`, errors) !== true) {
      errors.push(`${path}.memberAuditCompleted must be true before org-wide 2FA enforcement`);
    }
    if (requireBoolean(account.orgTwoFactorRequirementEnabled, `${path}.orgTwoFactorRequirementEnabled`, errors) !== true) {
      errors.push(`${path}.orgTwoFactorRequirementEnabled must be true`);
    }
  }
  if (id === "aws_iam_admins") {
    const subjects = requireNonEmptyArray(account.subjects, `${path}.subjects`, errors);
    for (const [subjectIndex, rawSubject] of subjects.entries()) {
      const subjectPath = `${path}.subjects[${subjectIndex}]`;
      const subject = assertObject(rawSubject, subjectPath, errors);
      requireString(subject.username, `${subjectPath}.username`, errors);
      if (requireBoolean(subject.hardwareKeyEnrolled, `${subjectPath}.hardwareKeyEnrolled`, errors) !== true) {
        errors.push(`${subjectPath}.hardwareKeyEnrolled must be true`);
      }
      if (requireBoolean(subject.backupKeyLoginTested, `${subjectPath}.backupKeyLoginTested`, errors) !== true) {
        errors.push(`${subjectPath}.backupKeyLoginTested must be true`);
      }
    }
  }
  return id;
}

export function validateEvidence(evidence, options = {}) {
  const errors = [];
  const doc = assertObject(evidence, "evidence", errors);

  if (doc.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  }
  const completedAt = requireIsoTimestamp(doc.completedAt, "completedAt", errors);
  assertFreshTimestamp(completedAt, "completedAt", options, errors);

  const operator = assertObject(doc.operator, "operator", errors);
  requireString(operator.name, "operator.name", errors);
  requireString(operator.signature, "operator.signature", errors);

  const keyLabels = validateHardwareKeys(doc.hardwareKeys, errors);
  const accounts = requireNonEmptyArray(doc.accounts, "accounts", errors);
  const seenAccountIds = new Set();
  accounts.forEach((account, index) => {
    const id = validateAccount(account, index, keyLabels, errors, {
      completedAt,
      freshnessOptions: options
    });
    if (id) {
      if (seenAccountIds.has(id)) {
        errors.push(`accounts must not contain duplicate id ${id}`);
      }
      seenAccountIds.add(id);
    }
  });

  for (const accountId of REQUIRED_ACCOUNT_IDS) {
    if (!seenAccountIds.has(accountId)) {
      errors.push(`accounts must include ${accountId}`);
    }
  }

  const recovery = assertObject(doc.recoveryRunbook, "recoveryRunbook", errors);
  requireString(recovery.location, "recoveryRunbook.location", errors);
  if (requireBoolean(recovery.backupKeyTestedAcrossAllAccounts, "recoveryRunbook.backupKeyTestedAcrossAllAccounts", errors) !== true) {
    errors.push("recoveryRunbook.backupKeyTestedAcrossAllAccounts must be true");
  }
  if (requireBoolean(recovery.noRawRecoveryCodesInEvidence, "recoveryRunbook.noRawRecoveryCodesInEvidence", errors) !== true) {
    errors.push("recoveryRunbook.noRawRecoveryCodesInEvidence must be true");
  }

  scanForSecretLikeValues(doc, "evidence", errors);

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      completedAt: doc.completedAt,
      operator: operator.name,
      hardwareKeyCount: Array.isArray(doc.hardwareKeys) ? doc.hardwareKeys.length : 0,
      accountCount: Array.isArray(doc.accounts) ? doc.accounts.length : 0,
      accounts: Array.isArray(doc.accounts)
        ? doc.accounts.map((account) => account?.id).filter(Boolean)
        : [],
      freshnessEnforced: Number.isFinite(options.maxCompletedAgeHours)
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
  const result = validateEvidence(parsed, {
    maxCompletedAgeHours: args.maxCompletedAgeHours,
    now: args.now
  });
  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      status: result.ok ? "ok" : "not_ok",
      file: args.file,
      summary: result.summary,
      errors: result.errors
    }, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`Hardware MFA evidence ok: ${args.file}\n`);
  } else {
    process.stderr.write(`Hardware MFA evidence invalid: ${args.file}\n`);
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

#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_NAME = basename(fileURLToPath(import.meta.url));
export const SCHEMA_VERSION = 1;
export const EVIDENCE_KIND = "averray.pauserRehearsalEvidence";
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const READ_ONLY_REQUIRED_CHECKS = [
  "owner_matches_manifest",
  "pauser_matches_manifest",
  "pauser_is_nonzero",
  "pauser_not_owner",
  "pauser_not_service_operator",
  "pauser_not_owner_admin_if_owner_distinct",
  "pauser_can_call_setPaused_true",
  "pauser_cannot_call_setPauser",
  "pauser_cannot_call_setVerifier",
  "pauser_cannot_call_setServiceOperator",
  "pauser_cannot_call_transferOwnership"
];

const DEDICATED_PAUSER_REQUIRED_CHECKS = [
  "pauser_is_dedicated_role",
  "pauser_not_verifier",
  "pauser_not_arbitrator"
];

const LIVE_REQUIRED_CHECKS = [
  "live_pause_state_confirmed",
  "live_unpause_state_confirmed"
];

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/u;
const TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/u;

function usage() {
  return `Usage: node scripts/ops/${SCRIPT_NAME} --file docs/evidence/pauser-rehearsal-YYYY-MM-DD.json [--json] [--require-live] [--require-dedicated-pauser] [--max-generated-age-hours N]

Validates the machine-readable evidence produced by run-pauser-rehearsal.mjs.
This check is read-only; it does not call RPC, sign transactions, pause, or
unpause contracts.

Use --max-generated-age-hours when validating live launch evidence so stale
historical artifacts cannot be reused as current pauser proof.
`;
}

function parseArgs(argv) {
  const args = {
    file: undefined,
    json: false,
    requireLive: false,
    requireDedicatedPauser: false,
    maxGeneratedAgeHours: undefined,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      args.file = argv[index + 1];
      index += 1;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--require-live") {
      args.requireLive = true;
    } else if (arg === "--require-dedicated-pauser") {
      args.requireDedicatedPauser = true;
    } else if (arg === "--max-generated-age-hours") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--max-generated-age-hours must be a positive number");
      }
      args.maxGeneratedAgeHours = value;
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

function requireIsoTimestamp(value, path, errors) {
  const raw = requireIsoDate(value, path, errors);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function requireArray(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  return value;
}

function requireAddress(value, path, errors, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === "")) {
    return "";
  }
  return requireString(value, path, errors, { pattern: ADDRESS_PATTERN });
}

function checkByName(checks, name) {
  return checks.find((check) => check?.name === name);
}

function requireChecks(checks, names, errors) {
  for (const name of names) {
    const check = checkByName(checks, name);
    if (!check) {
      errors.push(`checks must include ${name}`);
    } else if (check.ok !== true) {
      errors.push(`checks.${name}.ok must be true`);
    }
  }
}

function validateChecks(value, errors) {
  const checks = requireArray(value, "checks", errors);
  const seen = new Set();
  for (const [index, rawCheck] of checks.entries()) {
    const path = `checks[${index}]`;
    const check = assertObject(rawCheck, path, errors);
    const name = requireString(check.name, `${path}.name`, errors);
    if (name) {
      if (seen.has(name)) {
        errors.push(`checks must not contain duplicate check ${name}`);
      }
      seen.add(name);
    }
    if (check.ok !== true) {
      errors.push(`${path}.ok must be true`);
    }
    assertObject(check.details ?? {}, `${path}.details`, errors);
  }
  return checks;
}

function validateTx(tx, path, errors) {
  const doc = assertObject(tx, path, errors);
  requireString(doc.hash, `${path}.hash`, errors, { pattern: TX_HASH_PATTERN });
  requireNumber(doc.blockNumber, `${path}.blockNumber`, errors, { integer: true, min: 1 });
  if (doc.status !== 1) {
    errors.push(`${path}.status must be 1`);
  }
}

function validateGeneratedFreshness(generatedAt, options, errors) {
  const maxGeneratedAgeHours = options.maxGeneratedAgeHours;
  if (maxGeneratedAgeHours === undefined) return;
  if (!Number.isFinite(maxGeneratedAgeHours) || maxGeneratedAgeHours <= 0) {
    errors.push("maxGeneratedAgeHours must be a positive number");
    return;
  }
  if (!Number.isFinite(generatedAt)) return;

  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    errors.push("now must be a valid Date or timestamp");
    return;
  }
  if (generatedAt > nowMs + FUTURE_SKEW_MS) {
    errors.push("generatedAt must not be in the future");
  }
  const maxAgeMs = maxGeneratedAgeHours * 60 * 60 * 1000;
  if (nowMs - generatedAt > maxAgeMs) {
    errors.push(`generatedAt must be within ${maxGeneratedAgeHours} hour(s)`);
  }
}

export function validateEvidence(evidence, options = {}) {
  const errors = [];
  const warnings = [];
  const doc = assertObject(evidence, "evidence", errors);

  if (doc.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (doc.kind !== EVIDENCE_KIND) {
    errors.push(`kind must be ${EVIDENCE_KIND}`);
  }
  requireString(doc.profile, "profile", errors);
  const generatedAt = requireIsoTimestamp(doc.generatedAt, "generatedAt", errors);
  validateGeneratedFreshness(generatedAt, options, errors);
  const mode = requireString(doc.mode, "mode", errors);
  if (!["read_only_capability_proof", "live_pause_unpause"].includes(mode)) {
    errors.push("mode must be read_only_capability_proof or live_pause_unpause");
  }
  requireString(doc.manifestPath, "manifestPath", errors);
  requireString(doc.rpcUrl, "rpcUrl", errors);

  const contracts = assertObject(doc.contracts, "contracts", errors);
  requireAddress(contracts.treasuryPolicy, "contracts.treasuryPolicy", errors);

  const manifest = assertObject(doc.manifest, "manifest", errors);
  requireAddress(manifest.owner, "manifest.owner", errors);
  requireAddress(manifest.pauser, "manifest.pauser", errors);
  requireAddress(manifest.verifier, "manifest.verifier", errors, { optional: true });
  requireAddress(manifest.arbitrator, "manifest.arbitrator", errors, { optional: true });
  requireAddress(manifest.deployer, "manifest.deployer", errors, { optional: true });

  const live = assertObject(doc.live, "live", errors);
  requireAddress(live.owner, "live.owner", errors);
  requireAddress(live.pauser, "live.pauser", errors);
  requireBoolean(live.paused, "live.paused", errors);

  const roleOverlap = assertObject(doc.roleOverlap, "roleOverlap", errors);
  requireBoolean(roleOverlap.dedicated, "roleOverlap.dedicated", errors);
  const overlaps = requireArray(roleOverlap.overlaps, "roleOverlap.overlaps", errors);
  if (!["ok", "warning", "error"].includes(String(roleOverlap.severity))) {
    errors.push("roleOverlap.severity must be ok, warning, or error");
  }
  if (roleOverlap.severity === "error") {
    errors.push("roleOverlap.severity must not be error");
  }

  const roleReads = assertObject(doc.roleReads, "roleReads", errors);
  requireBoolean(roleReads.serviceOperator, "roleReads.serviceOperator", errors);
  requireBoolean(roleReads.verifier, "roleReads.verifier", errors);
  requireBoolean(roleReads.arbitrator, "roleReads.arbitrator", errors);

  requireArray(doc.simulation, "simulation", errors);
  const transactions = assertObject(doc.transactions, "transactions", errors);
  const checks = validateChecks(doc.checks, errors);
  requireArray(doc.warnings ?? [], "warnings", errors);

  if (doc.ok !== true) {
    errors.push("ok must be true");
  }
  requireChecks(checks, READ_ONLY_REQUIRED_CHECKS, errors);

  const launchGate = assertObject(doc.launchGate, "launchGate", errors);
  if (launchGate.controlPlanePauserReady !== true) {
    errors.push("launchGate.controlPlanePauserReady must be true");
  }
  requireBoolean(launchGate.pauseUnpauseRehearsed, "launchGate.pauseUnpauseRehearsed", errors);
  requireBoolean(launchGate.requiresLiveRehearsal, "launchGate.requiresLiveRehearsal", errors);

  if (options.requireDedicatedPauser) {
    if (roleOverlap.dedicated !== true) {
      errors.push("roleOverlap.dedicated must be true when --require-dedicated-pauser is used");
    }
    if (overlaps.length > 0) {
      errors.push("roleOverlap.overlaps must be empty when --require-dedicated-pauser is used");
    }
    requireChecks(checks, DEDICATED_PAUSER_REQUIRED_CHECKS, errors);
  }

  const claimsLiveProof = mode === "live_pause_unpause" || launchGate.pauseUnpauseRehearsed === true;

  if (options.requireLive || claimsLiveProof) {
    if (mode !== "live_pause_unpause") {
      errors.push("mode must be live_pause_unpause for live proof");
    }
    if (launchGate.pauseUnpauseRehearsed !== true) {
      errors.push("launchGate.pauseUnpauseRehearsed must be true for live proof");
    }
    if (launchGate.requiresLiveRehearsal !== false) {
      errors.push("launchGate.requiresLiveRehearsal must be false for live proof");
    }
    requireChecks(checks, LIVE_REQUIRED_CHECKS, errors);
    validateTx(transactions.pause, "transactions.pause", errors);
    validateTx(transactions.unpause, "transactions.unpause", errors);
  } else if (launchGate.pauseUnpauseRehearsed !== true) {
    warnings.push("live pause/unpause was not rehearsed; rerun with --require-live before closing the launch box");
  }

  if (!options.requireDedicatedPauser && roleOverlap.dedicated !== true) {
    warnings.push("pauser overlaps another role; rerun with --require-dedicated-pauser before mainnet or real-funds proof");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      profile: doc.profile,
      mode,
      generatedAt: doc.generatedAt,
      treasuryPolicy: contracts.treasuryPolicy,
      pauser: live.pauser,
      controlPlanePauserReady: launchGate.controlPlanePauserReady,
      pauseUnpauseRehearsed: launchGate.pauseUnpauseRehearsed,
      dedicatedPauser: roleOverlap.dedicated,
      freshnessEnforced: Number.isFinite(options.maxGeneratedAgeHours)
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
    requireLive: args.requireLive,
    requireDedicatedPauser: args.requireDedicatedPauser,
    maxGeneratedAgeHours: args.maxGeneratedAgeHours
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
    process.stdout.write(`Pauser rehearsal evidence ok: ${args.file}\n`);
    for (const warning of result.warnings) {
      process.stderr.write(`- warning: ${warning}\n`);
    }
  } else {
    process.stderr.write(`Pauser rehearsal evidence invalid: ${args.file}\n`);
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

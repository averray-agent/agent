import { readFile } from "node:fs/promises";
import { normalize as normalizePath } from "node:path";

import { CLASSIFICATIONS } from "./constants.mjs";

export const VERIFICATION_CONTRACT_SCHEMA_VERSION = "averray.verification-contract/v1";

export const REJECTION_RULES = Object.freeze({
  MATERIALIZATION_STATUS: Object.freeze({
    code: "VCV1_RULE_1_MATERIALIZATION_STATUS",
    name: "rule 1: materialization status must be Witness-compatible"
  }),
  MOCKED_EXTERNAL_INPUTS: Object.freeze({
    code: "VCV1_RULE_2_MOCKED_EXTERNAL_INPUTS",
    name: "rule 2: mocked external systems require frozen inputs"
  }),
  REQUIRED_TARGETED_CHECK: Object.freeze({
    code: "VCV1_RULE_3_REQUIRED_TARGETED_CHECK",
    name: "rule 3: at least one targeted check must be required"
  }),
  TARGETED_BASE_MUST_FAIL: Object.freeze({
    code: "VCV1_RULE_4_TARGETED_BASE_MUST_FAIL",
    name: "rule 4: targeted checks must fail on base"
  }),
  JUDGING_COMMAND_PROTECTED: Object.freeze({
    code: "VCV1_RULE_5_JUDGING_COMMAND_PROTECTED",
    name: "rule 5: judging command definitions must be protected"
  }),
  REQUIRED_REGRESSION_BASE_RED: Object.freeze({
    code: "VCV1_RULE_6_REQUIRED_REGRESSION_BASE_RED",
    name: "rule 6: a base-red regression check cannot be required"
  }),
  REQUIRED_HIDDEN_ELIGIBILITY: Object.freeze({
    code: "VCV1_RULE_7_REQUIRED_HIDDEN_ELIGIBILITY",
    name: "rule 7: required hidden bundles need an eligibility reference"
  }),
  SETTLEMENT_ASSURANCE_FLOOR: Object.freeze({
    code: "VCV1_RULE_8_SETTLEMENT_ASSURANCE_FLOOR",
    name: "rule 8: settlement-gating contracts require AV-2 or higher"
  })
});

const MATERIALIZATION_STATUSES = new Set(Object.values(CLASSIFICATIONS));
const ASSURANCE_LEVEL = /^AV-(\d+)$/u;
const COMMAND_INTERPRETERS = new Set(["node", "python", "python3", "sh", "bash"]);
const SCRIPT_EXTENSION = /\.(?:c?js|mjs|py|sh)$/u;

export class VerificationContractValidationError extends Error {
  constructor(issues, source = "verification contract") {
    super(`${source} rejected:\n${issues.map(formatIssue).join("\n")}`);
    this.name = "VerificationContractValidationError";
    this.issues = issues;
  }
}

function formatIssue(issue) {
  const location = issue.path ? ` at ${issue.path}` : "";
  return `[${issue.code}] ${issue.rule}${location}: ${issue.message}`;
}

function issue(code, rule, path, message, details = {}) {
  return { code, rule, path, message, ...details };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function cloneJson(value) {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeRepositoryPath(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim().replaceAll("\\", "/");
  if (trimmed.length === 0) return trimmed;
  return normalizePath(trimmed)
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "");
}

function normalizeCommand(value) {
  if (!Array.isArray(value)) return value;
  return value.map((part) => typeof part === "string" ? part.trim() : part);
}

function normalizeCheck(check, defaultRequired) {
  if (!isRecord(check)) return check;
  return {
    ...check,
    command: normalizeCommand(check.command),
    required: check.required ?? defaultRequired
  };
}

/**
 * Return a detached, predictable representation. This does not calculate a
 * digest and intentionally preserves array order.
 */
export function normalizeVerificationContract(input) {
  const contract = cloneJson(input);
  if (!isRecord(contract)) return contract;

  if (isRecord(contract.subject?.materialization)) {
    contract.subject.materialization.frozen_inputs ??= [];
    if (Array.isArray(contract.subject.materialization.dependency_cache?.populate_command)) {
      contract.subject.materialization.dependency_cache.populate_command = normalizeCommand(
        contract.subject.materialization.dependency_cache.populate_command
      );
    }
  }

  if (isRecord(contract.candidate)) {
    contract.candidate.allowed_paths ??= [];
    contract.candidate.protected_paths ??= [];
    if (Array.isArray(contract.candidate.allowed_paths)) {
      contract.candidate.allowed_paths = [...new Set(contract.candidate.allowed_paths.map(normalizeRepositoryPath))];
    }
    if (Array.isArray(contract.candidate.protected_paths)) {
      contract.candidate.protected_paths = [...new Set(contract.candidate.protected_paths.map(normalizeRepositoryPath))];
    }
  }

  if (isRecord(contract.checks)) {
    contract.checks.targeted ??= [];
    contract.checks.regression ??= [];
    if (Array.isArray(contract.checks.targeted)) {
      contract.checks.targeted = contract.checks.targeted.map((check) => normalizeCheck(check, false));
    }
    if (Array.isArray(contract.checks.regression)) {
      contract.checks.regression = contract.checks.regression.map((check) => normalizeCheck(check, false));
    }
    if (isRecord(contract.checks.hidden)) {
      contract.checks.hidden.required ??= false;
    }
  }

  return contract;
}

function requireRecord(issues, value, path) {
  if (!isRecord(value)) {
    issues.push(issue("VCV1_SCHEMA_OBJECT", "schema", path, "must be an object"));
    return false;
  }
  return true;
}

function requireString(issues, value, path) {
  if (!isNonEmptyString(value)) {
    issues.push(issue("VCV1_SCHEMA_STRING", "schema", path, "must be a non-empty string"));
    return false;
  }
  return true;
}

function requireAssuranceLevel(issues, value, path) {
  if (!requireString(issues, value, path)) return false;
  if (!ASSURANCE_LEVEL.test(value)) {
    issues.push(issue("VCV1_SCHEMA_ASSURANCE_LEVEL", "schema", path, "must have the form AV-<integer>"));
    return false;
  }
  return true;
}

function requireBoolean(issues, value, path) {
  if (typeof value !== "boolean") {
    issues.push(issue("VCV1_SCHEMA_BOOLEAN", "schema", path, "must be a boolean"));
    return false;
  }
  return true;
}

function requireInteger(issues, value, path, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    issues.push(issue("VCV1_SCHEMA_INTEGER", "schema", path, `must be an integer greater than or equal to ${minimum}`));
    return false;
  }
  return true;
}

function requireEnum(issues, value, path, allowed) {
  if (!allowed.includes(value)) {
    issues.push(issue("VCV1_SCHEMA_ENUM", "schema", path, `must be one of: ${allowed.join(", ")}`));
    return false;
  }
  return true;
}

function requireStringArray(issues, value, path, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    issues.push(issue("VCV1_SCHEMA_ARRAY", "schema", path, nonEmpty ? "must be a non-empty array" : "must be an array"));
    return false;
  }
  value.forEach((entry, index) => requireString(issues, entry, `${path}[${index}]`));
  return true;
}

function requireRepositoryPathArray(issues, value, path) {
  if (!requireStringArray(issues, value, path)) return false;
  value.forEach((entry, index) => {
    if (!isNonEmptyString(entry)) return;
    if (entry.startsWith("/") || /^[A-Za-z]:\//u.test(entry) || entry === ".." || entry.startsWith("../")) {
      issues.push(issue(
        "VCV1_SCHEMA_REPOSITORY_PATH",
        "schema",
        `${path}[${index}]`,
        "must be relative to the repository root and must not traverse upward"
      ));
    }
  });
  return true;
}

function validateCommandShape(issues, command, path) {
  requireStringArray(issues, command, path, { nonEmpty: true });
}

function validateCheckShape(issues, check, path, kind) {
  if (!requireRecord(issues, check, path)) return;
  requireString(issues, check.id, `${path}.id`);
  validateCommandShape(issues, check.command, `${path}.command`);
  requireBoolean(issues, check.required, `${path}.required`);
  if (kind === "targeted") {
    requireEnum(issues, check.expected_on_base, `${path}.expected_on_base`, ["fail", "pass"]);
    requireEnum(issues, check.expected_on_candidate, `${path}.expected_on_candidate`, ["fail", "pass"]);
  } else {
    requireEnum(issues, check.expected, `${path}.expected`, ["fail", "pass"]);
    requireEnum(issues, check.base_state, `${path}.base_state`, ["green", "red"]);
  }
}

function validateOptionalSections(issues, contract) {
  if (contract.integrity !== undefined && requireRecord(issues, contract.integrity, "integrity")) {
    requireBoolean(issues, contract.integrity.judging_commands_immutable, "integrity.judging_commands_immutable");
    requireStringArray(issues, contract.integrity.forbid, "integrity.forbid");
  }

  if (contract.inconclusive_policy !== undefined &&
      requireRecord(issues, contract.inconclusive_policy, "inconclusive_policy")) {
    requireStringArray(
      issues,
      contract.inconclusive_policy.infrastructure_attributable,
      "inconclusive_policy.infrastructure_attributable"
    );
    requireStringArray(
      issues,
      contract.inconclusive_policy.candidate_attributable,
      "inconclusive_policy.candidate_attributable"
    );
    if (requireRecord(
      issues,
      contract.inconclusive_policy.repeated_candidate_attributable,
      "inconclusive_policy.repeated_candidate_attributable"
    )) {
      const repeated = contract.inconclusive_policy.repeated_candidate_attributable;
      requireInteger(issues, repeated.window, "inconclusive_policy.repeated_candidate_attributable.window", 1);
      requireInteger(issues, repeated.threshold, "inconclusive_policy.repeated_candidate_attributable.threshold", 1);
      requireString(issues, repeated.action, "inconclusive_policy.repeated_candidate_attributable.action");
    }
  }

  if (contract.reproducibility !== undefined &&
      requireRecord(issues, contract.reproducibility, "reproducibility")) {
    requireInteger(issues, contract.reproducibility.repetitions, "reproducibility.repetitions", 1);
    requireString(issues, contract.reproducibility.disagreement_result, "reproducibility.disagreement_result");
    requireInteger(issues, contract.reproducibility.random_seed, "reproducibility.random_seed");
  }

  if (contract.resources !== undefined && requireRecord(issues, contract.resources, "resources")) {
    for (const field of [
      "timeout_seconds",
      "cpu_limit",
      "memory_mb",
      "process_limit",
      "writable_storage_mb",
      "max_output_bytes"
    ]) {
      requireInteger(issues, contract.resources[field], `resources.${field}`, 1);
    }
  }
}

/**
 * Validate the v1 JSON shape without applying the eight freeze-time rules.
 * Exposed so the drill runner can prove the policy rules, not shape validation,
 * are what reject each fixture.
 */
export function validateVerificationContractShape(input) {
  const contract = normalizeVerificationContract(input);
  const issues = [];
  if (!requireRecord(issues, contract, "$")) return { valid: false, contract, issues };

  if (contract.schema_version !== VERIFICATION_CONTRACT_SCHEMA_VERSION) {
    issues.push(issue(
      "VCV1_SCHEMA_VERSION",
      "schema",
      "schema_version",
      `must equal ${VERIFICATION_CONTRACT_SCHEMA_VERSION}`
    ));
  }

  if (requireRecord(issues, contract.job, "job")) {
    requireString(issues, contract.job.id, "job.id");
    requireString(issues, contract.job.type, "job.type");
    requireAssuranceLevel(issues, contract.job.required_verification_level, "job.required_verification_level");
  }

  if (requireRecord(issues, contract.subject, "subject")) {
    if (requireRecord(issues, contract.subject.acquisition, "subject.acquisition")) {
      requireString(issues, contract.subject.acquisition.repository, "subject.acquisition.repository");
      requireString(issues, contract.subject.acquisition.base_commit, "subject.acquisition.base_commit");
      requireString(issues, contract.subject.acquisition.bundle_sha256, "subject.acquisition.bundle_sha256");
    }
    if (requireRecord(issues, contract.subject.materialization, "subject.materialization")) {
      const materialization = contract.subject.materialization;
      requireEnum(
        issues,
        materialization.status,
        "subject.materialization.status",
        [...MATERIALIZATION_STATUSES]
      );
      if (materialization.dependency_cache !== null &&
          requireRecord(issues, materialization.dependency_cache, "subject.materialization.dependency_cache")) {
        requireString(issues, materialization.dependency_cache.sha256, "subject.materialization.dependency_cache.sha256");
        requireInteger(issues, materialization.dependency_cache.bytes, "subject.materialization.dependency_cache.bytes");
        validateCommandShape(
          issues,
          materialization.dependency_cache.populate_command,
          "subject.materialization.dependency_cache.populate_command"
        );
      }
      if (!Array.isArray(materialization.frozen_inputs)) {
        issues.push(issue("VCV1_SCHEMA_ARRAY", "schema", "subject.materialization.frozen_inputs", "must be an array"));
      } else {
        materialization.frozen_inputs.forEach((input, index) => {
          const path = `subject.materialization.frozen_inputs[${index}]`;
          if (!requireRecord(issues, input, path)) return;
          requireString(issues, input.path, `${path}.path`);
          requireString(issues, input.sha256, `${path}.sha256`);
        });
      }
    }
  }

  if (requireRecord(issues, contract.candidate, "candidate")) {
    requireEnum(issues, contract.candidate.format, "candidate.format", ["git_patch"]);
    requireRepositoryPathArray(issues, contract.candidate.allowed_paths, "candidate.allowed_paths");
    requireRepositoryPathArray(issues, contract.candidate.protected_paths, "candidate.protected_paths");
    requireInteger(issues, contract.candidate.maximum_changed_files, "candidate.maximum_changed_files", 1);
  }

  if (requireRecord(issues, contract.checks, "checks")) {
    if (!Array.isArray(contract.checks.targeted)) {
      issues.push(issue("VCV1_SCHEMA_ARRAY", "schema", "checks.targeted", "must be an array"));
    } else {
      contract.checks.targeted.forEach((check, index) => {
        validateCheckShape(issues, check, `checks.targeted[${index}]`, "targeted");
      });
    }
    if (!Array.isArray(contract.checks.regression)) {
      issues.push(issue("VCV1_SCHEMA_ARRAY", "schema", "checks.regression", "must be an array"));
    } else {
      contract.checks.regression.forEach((check, index) => {
        validateCheckShape(issues, check, `checks.regression[${index}]`, "regression");
      });
    }
    if (contract.checks.hidden !== undefined && contract.checks.hidden !== null &&
        requireRecord(issues, contract.checks.hidden, "checks.hidden")) {
      requireString(issues, contract.checks.hidden.bundle_sha256, "checks.hidden.bundle_sha256");
      requireBoolean(issues, contract.checks.hidden.required, "checks.hidden.required");
      if (contract.checks.hidden.eligibility_reference_sha256 !== undefined) {
        requireString(
          issues,
          contract.checks.hidden.eligibility_reference_sha256,
          "checks.hidden.eligibility_reference_sha256"
        );
      }
    }
  }

  if (requireRecord(issues, contract.settlement, "settlement")) {
    requireAssuranceLevel(issues, contract.settlement.minimum_assurance_level, "settlement.minimum_assurance_level");
    requireBoolean(issues, contract.settlement.pass_required, "settlement.pass_required");
    if (contract.settlement.human_overlay_required !== undefined) {
      requireBoolean(issues, contract.settlement.human_overlay_required, "settlement.human_overlay_required");
    }
    if (contract.settlement.challenge_window_blocks !== undefined) {
      requireInteger(issues, contract.settlement.challenge_window_blocks, "settlement.challenge_window_blocks");
    }
  }

  validateOptionalSections(issues, contract);
  return { valid: issues.length === 0, contract, issues };
}

function pathPatternMatches(pattern, repositoryPath) {
  if (!/[?*]/u.test(pattern)) {
    return repositoryPath === pattern || repositoryPath.startsWith(`${pattern}/`);
  }
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${escaped}$`, "u").test(repositoryPath);
}

export function isProtectedPath(path, protectedPaths) {
  const normalized = normalizeRepositoryPath(path);
  return protectedPaths.some((pattern) => pathPatternMatches(normalizeRepositoryPath(pattern), normalized));
}

function repositoryScriptFrom(command) {
  const [executable, ...args] = command;
  if (executable.startsWith("./") || executable.startsWith("../") || SCRIPT_EXTENSION.test(executable)) {
    return executable;
  }
  if (!COMMAND_INTERPRETERS.has(executable)) return null;
  if ((executable === "sh" || executable === "bash") && ["-c", "-lc"].includes(args[0])) return null;
  const firstPositional = args.find((part) => !part.startsWith("-"));
  if (!firstPositional || firstPositional === "test") return null;
  if (firstPositional.startsWith("./") || firstPositional.startsWith("../") || SCRIPT_EXTENSION.test(firstPositional)) {
    return firstPositional;
  }
  return null;
}

/**
 * Resolve only command families whose defining path is provable from the argv.
 * `definitionFile: null` means the command is wholly contract/direct-runner
 * defined. `resolved: false` means validation must fail closed.
 */
export function resolveJudgingCommandDefinition(command) {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => !isNonEmptyString(part))) {
    return { resolved: false, definitionFile: null, kind: "invalid-command", reason: "command argv is invalid" };
  }

  const [executable, ...args] = command;
  if (["npm", "pnpm"].includes(executable)) {
    const first = args[0];
    const script = first === "run" || first === "run-script" ? args[1] : first;
    if (script && !script.startsWith("-") && !["exec", "x", "dlx"].includes(script)) {
      return { resolved: true, definitionFile: "package.json", kind: "package-script", script };
    }
    return {
      resolved: false,
      definitionFile: null,
      kind: "package-manager",
      reason: `${executable} command is not a statically identifiable package script`
    };
  }

  if (executable === "yarn") {
    const script = args[0] === "run" ? args[1] : args[0];
    if (script && !script.startsWith("-") &&
        !["dlx", "exec", "workspace", "workspaces"].includes(script)) {
      return { resolved: true, definitionFile: "package.json", kind: "package-script", script };
    }
    return {
      resolved: false,
      definitionFile: null,
      kind: "package-manager",
      reason: "yarn command is not a statically identifiable package script"
    };
  }

  if (executable === "make") {
    return {
      resolved: false,
      definitionFile: null,
      kind: "make-target",
      reason: "make may select GNUmakefile, makefile, Makefile, or included definitions"
    };
  }

  if (executable === "node") {
    if (args.includes("--test") || args.some((part) => part.startsWith("--test="))) {
      return { resolved: true, definitionFile: null, kind: "direct-node" };
    }
    if (["-e", "--eval", "-p", "--print"].includes(args[0])) {
      return { resolved: true, definitionFile: null, kind: "direct-node" };
    }
    if (args[0] && !args[0].startsWith("-")) {
      const definitionFile = normalizeRepositoryPath(args[0]);
      if (definitionFile !== ".." && !definitionFile.startsWith("../") && !definitionFile.startsWith("/")) {
        return { resolved: true, definitionFile, kind: "repository-script" };
      }
    }
  }

  const script = repositoryScriptFrom(command);
  if (script) {
    const definitionFile = normalizeRepositoryPath(script);
    if (definitionFile === ".." || definitionFile.startsWith("../") || definitionFile.startsWith("/")) {
      return {
        resolved: false,
        definitionFile: null,
        kind: "repository-script",
        reason: "repository script escapes the repository root"
      };
    }
    return { resolved: true, definitionFile, kind: "repository-script" };
  }

  return {
    resolved: false,
    definitionFile: null,
    kind: "unknown",
    reason: `cannot prove the judging-command definition path for ${executable}`
  };
}

function collectFreezeRuleIssues(contract) {
  const issues = [];
  const rules = REJECTION_RULES;
  const materialization = contract.subject.materialization;

  if ([CLASSIFICATIONS.REQUIRES_NETWORK, CLASSIFICATIONS.UNMATERIALIZABLE].includes(materialization.status)) {
    const rule = rules.MATERIALIZATION_STATUS;
    issues.push(issue(
      rule.code,
      rule.name,
      "subject.materialization.status",
      `${materialization.status} cannot be frozen into a Witness contract`
    ));
  }

  if (materialization.status === CLASSIFICATIONS.MOCKED_EXTERNAL_SYSTEM && materialization.frozen_inputs.length === 0) {
    const rule = rules.MOCKED_EXTERNAL_INPUTS;
    issues.push(issue(
      rule.code,
      rule.name,
      "subject.materialization.frozen_inputs",
      "MOCKED_EXTERNAL_SYSTEM requires at least one hashed frozen input"
    ));
  }

  if (!contract.checks.targeted.some((check) => check.required === true)) {
    const rule = rules.REQUIRED_TARGETED_CHECK;
    issues.push(issue(rule.code, rule.name, "checks.targeted", "no targeted check has required: true"));
  }

  contract.checks.targeted.forEach((check, index) => {
    if (check.expected_on_base === "pass") {
      const rule = rules.TARGETED_BASE_MUST_FAIL;
      issues.push(issue(
        rule.code,
        rule.name,
        `checks.targeted[${index}].expected_on_base`,
        `targeted check ${JSON.stringify(check.id)} already passes on base`
      ));
    }
  });

  for (const [kind, checks] of [
    ["targeted", contract.checks.targeted],
    ["regression", contract.checks.regression]
  ]) {
    checks.forEach((check, index) => {
      const resolution = resolveJudgingCommandDefinition(check.command);
      const path = `checks.${kind}[${index}].command`;
      if (!resolution.resolved) {
        const rule = rules.JUDGING_COMMAND_PROTECTED;
        issues.push(issue(
          rule.code,
          rule.name,
          path,
          `${resolution.reason}; freeze validation fails closed`,
          { commandResolution: resolution }
        ));
      } else if (resolution.definitionFile !== null &&
                 !isProtectedPath(resolution.definitionFile, contract.candidate.protected_paths)) {
        const rule = rules.JUDGING_COMMAND_PROTECTED;
        issues.push(issue(
          rule.code,
          rule.name,
          path,
          `${resolution.definitionFile} defines judging check ${JSON.stringify(check.id)} but is not protected`,
          { commandResolution: resolution }
        ));
      }
    });
  }

  contract.checks.regression.forEach((check, index) => {
    if (check.required === true && check.base_state === "red") {
      const rule = rules.REQUIRED_REGRESSION_BASE_RED;
      issues.push(issue(
        rule.code,
        rule.name,
        `checks.regression[${index}].base_state`,
        `required regression check ${JSON.stringify(check.id)} is red on base`
      ));
    }
  });

  if (contract.checks.hidden?.required === true &&
      !isNonEmptyString(contract.checks.hidden.eligibility_reference_sha256)) {
    const rule = rules.REQUIRED_HIDDEN_ELIGIBILITY;
    issues.push(issue(
      rule.code,
      rule.name,
      "checks.hidden.eligibility_reference_sha256",
      "a required hidden bundle needs a known-good eligibility reference"
    ));
  }

  const assuranceMatch = ASSURANCE_LEVEL.exec(contract.settlement.minimum_assurance_level);
  const assurance = assuranceMatch ? Number(assuranceMatch[1]) : null;
  if (contract.settlement.pass_required === true && (assurance === null || assurance < 2)) {
    const rule = rules.SETTLEMENT_ASSURANCE_FLOOR;
    issues.push(issue(
      rule.code,
      rule.name,
      "settlement.minimum_assurance_level",
      `${JSON.stringify(contract.settlement.minimum_assurance_level)} is below AV-2 or is not a comparable AV level`
    ));
  }

  return issues;
}

export function validateVerificationContract(input) {
  const shape = validateVerificationContractShape(input);
  if (!shape.valid) return shape;
  const issues = collectFreezeRuleIssues(shape.contract);
  return { valid: issues.length === 0, contract: shape.contract, issues };
}

export function assertValidVerificationContract(input, { source = "verification contract" } = {}) {
  const result = validateVerificationContract(input);
  if (!result.valid) throw new VerificationContractValidationError(result.issues, source);
  return result.contract;
}

export function parseVerificationContractJson(json, { source = "JSON input" } = {}) {
  let parsed;
  try {
    const sourceText = Buffer.isBuffer(json) || json instanceof Uint8Array
      ? Buffer.from(json).toString("utf8")
      : json;
    parsed = JSON.parse(sourceText);
  } catch (error) {
    throw new VerificationContractValidationError([
      issue("VCV1_JSON_PARSE", "JSON loader", "$", error.message)
    ], source);
  }
  return assertValidVerificationContract(parsed, { source });
}

export async function loadVerificationContract(path) {
  const json = await readFile(path, "utf8");
  return parseVerificationContractJson(json, { source: path });
}

import {
  CODE_CHANGE_JOB_SCHEMA_VERSION,
  FROZEN_CONTRACT_DIGEST_ALGORITHM,
  PATCH_SUBMISSION_OUTPUT_SCHEMA_REF,
  hashFrozenVerificationContract,
  normalizeCodeChangeDefinition
} from "../../mcp-server/src/core/code-change-job.js";
import { normalizeJobInput } from "../../mcp-server/src/core/job-catalog-normalization.js";

import { CLASSIFICATIONS } from "./constants.mjs";
import { runPreflight } from "./preflight.mjs";
import {
  validateVerificationContract,
  validateVerificationContractAtFreeze
} from "./verification-contract.mjs";

export const CODE_CHANGE_CREATION_REASONS = Object.freeze({
  CONTRACT_SCHEMA_REJECTED: "CODE_CHANGE_CONTRACT_SCHEMA_REJECTED",
  PREFLIGHT_REQUIRES_NETWORK: "CODE_CHANGE_PREFLIGHT_REQUIRES_NETWORK",
  PREFLIGHT_UNMATERIALIZABLE: "CODE_CHANGE_PREFLIGHT_UNMATERIALIZABLE",
  PREFLIGHT_PRIVILEGED_SERVICE: "CODE_CHANGE_PREFLIGHT_PRIVILEGED_SERVICE",
  PREFLIGHT_PRIVATE_CREDENTIAL: "CODE_CHANGE_PREFLIGHT_PRIVATE_CREDENTIAL",
  PREFLIGHT_BASE_EXPECTATION_MISMATCH: "CODE_CHANGE_PREFLIGHT_BASE_EXPECTATION_MISMATCH",
  PREFLIGHT_COMMIT_MISMATCH: "CODE_CHANGE_PREFLIGHT_COMMIT_MISMATCH",
  CONTRACT_FREEZE_REJECTED: "CODE_CHANGE_CONTRACT_FREEZE_REJECTED",
  PUBLICATION_REJECTED: "CODE_CHANGE_PUBLICATION_REJECTED",
  PUBLICATION_MISMATCH: "CODE_CHANGE_PUBLICATION_MISMATCH"
});

const PUBLISHABLE_CLASSIFICATIONS = new Set([
  CLASSIFICATIONS.HERMETIC,
  CLASSIFICATIONS.FROZEN_DEPENDENCIES,
  CLASSIFICATIONS.MOCKED_EXTERNAL_SYSTEM
]);

export class CodeChangeCreationRefusedError extends Error {
  constructor(reason, message, details = {}) {
    super(message);
    this.name = "CodeChangeCreationRefusedError";
    this.reason = reason;
    this.details = details;
  }
}

export async function createCodeChangeJob(input, options = {}, dependencies = {}) {
  const prepared = await prepareCodeChangeJob(input, options, dependencies);
  if (!options.apiUrl) return { prepared, publication: null };
  const publication = await publishCodeChangeJob(prepared, options, dependencies);
  return { prepared, publication };
}

export async function prepareCodeChangeJob(
  { contract: contractInput, job: jobInput },
  options = {},
  dependencies = {}
) {
  const staticResult = validateVerificationContract(contractInput);
  if (!staticResult.valid) {
    refuse(
      CODE_CHANGE_CREATION_REASONS.CONTRACT_SCHEMA_REJECTED,
      "The VerificationContract failed static freeze validation.",
      { issues: staticResult.issues }
    );
  }
  const contract = staticResult.contract;
  const preflightRunner = dependencies.runPreflight || runPreflight;
  const preflightChecks = checksForPreflight(contract);
  const reports = [];

  for (const check of preflightChecks) {
    const report = await preflightRunner({
      repo: contract.subject.acquisition.repository,
      commit: contract.subject.acquisition.base_commit,
      check: commandToShell(check.command),
      workingDirectory: check.working_directory,
      protectedPaths: contract.candidate.protected_paths,
      timeoutSeconds: contract.resources.timeout_seconds,
      cwd: options.cwd || process.cwd()
    }, dependencies.preflightDependencies || {});
    assertPublishablePreflight(report, contract, check);
    reports.push({
      checkId: check.id,
      checkKind: check.kind,
      classification: report.classification,
      baseOutcome: report.basePassed ? "pass" : "fail"
    });
  }

  const freezeValidator = dependencies.validateAtFreeze || validateVerificationContractAtFreeze;
  const freezeResult = await freezeValidator(
    contract,
    { cwd: options.cwd || process.cwd() },
    dependencies.freezeDependencies || {}
  );
  if (!freezeResult.valid) {
    refuse(
      CODE_CHANGE_CREATION_REASONS.CONTRACT_FREEZE_REJECTED,
      "The VerificationContract was not frozen because its runtime evidence failed validation.",
      { issues: freezeResult.issues, evidence: freezeResult.evidence }
    );
  }

  const materializationStatus = contract.subject.materialization.status;
  const preflightResult = materializationStatus === CLASSIFICATIONS.MOCKED_EXTERNAL_SYSTEM
    ? "PARTIALLY_EXECUTABLE"
    : "EXECUTABLE";
  const contractDigest = hashFrozenVerificationContract(contract);
  const codeChange = normalizeCodeChangeDefinition({
    schemaVersion: CODE_CHANGE_JOB_SCHEMA_VERSION,
    contractState: "frozen",
    contractDigest,
    contractDigestAlgorithm: FROZEN_CONTRACT_DIGEST_ALGORITHM,
    contract,
    preflight: {
      result: preflightResult,
      materializationStatus,
      reports
    },
    freeze: {
      validated: true,
      baselineDifferentials: freezeResult.evidence.checks.map(({ id, kind, expected, outcome }) => ({
        id,
        kind,
        expected,
        outcome
      }))
    }
  }, { expectedJobId: contract.job.id });

  const job = normalizeJobInput({
    ...jobInput,
    id: contract.job.id,
    jobType: "code_change",
    verifierMode: "witness",
    outputSchemaRef: PATCH_SUBMISSION_OUTPUT_SCHEMA_REF,
    codeChange
  });
  return { job, contractDigest, preflight: codeChange.preflight, freeze: codeChange.freeze };
}

export async function publishCodeChangeJob(
  prepared,
  { apiUrl, token, idempotencyKey = `code-change:${prepared?.job?.id}` },
  dependencies = {}
) {
  if (!apiUrl || !token) throw new Error("apiUrl and token are required for publication");
  const fetchImpl = dependencies.fetchImpl || fetch;
  const base = String(apiUrl).replace(/\/+$/u, "");
  const response = await fetchImpl(`${base}/admin/jobs`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ ...prepared.job, idempotencyKey })
  });
  if (!response.ok) {
    refuse(
      CODE_CHANGE_CREATION_REASONS.PUBLICATION_REJECTED,
      `The platform refused code_change publication with HTTP ${response.status}.`,
      { status: response.status, body: await response.text() }
    );
  }
  const created = await response.json();
  const definitionResponse = await fetchImpl(`${base}/admin/jobs`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`
    }
  });
  if (!definitionResponse.ok) {
    refuse(
      CODE_CHANGE_CREATION_REASONS.PUBLICATION_MISMATCH,
      `The created job could not be read back from the board (HTTP ${definitionResponse.status}).`
    );
  }
  const board = await definitionResponse.json();
  const definition = board?.jobs?.find((candidate) => candidate?.id === prepared.job.id);
  if (definition?.jobType !== "code_change" ||
      definition?.codeChange?.contractDigest !== prepared.contractDigest) {
    refuse(
      CODE_CHANGE_CREATION_REASONS.PUBLICATION_MISMATCH,
      "The operator board did not reproduce the frozen code_change job shape.",
      {
        expectedDigest: prepared.contractDigest,
        actualDigest: definition?.codeChange?.contractDigest,
        actualJobType: definition?.jobType
      }
    );
  }
  return { created, definition };
}

function checksForPreflight(contract) {
  const checks = [
    ...contract.checks.targeted.map((check) => ({ ...check, kind: "targeted" })),
    ...contract.checks.regression.map((check) => ({ ...check, kind: "regression" }))
  ];
  if (checks.length > 0) return checks;
  return [{
    id: "repository-materialization",
    kind: "materialization",
    command: ["true"],
    working_directory: ".",
    required: true
  }];
}

function assertPublishablePreflight(report, contract, check) {
  const structural = structuralRefusal(report);
  if (structural) {
    refuse(structural.reason, structural.message, { report, checkId: check.id });
  }
  if (report.classification === CLASSIFICATIONS.REQUIRES_NETWORK) {
    refuse(
      CODE_CHANGE_CREATION_REASONS.PREFLIGHT_REQUIRES_NETWORK,
      `Preflight refused ${check.id}: the check requires network access.`,
      { report, checkId: check.id }
    );
  }
  if (!PUBLISHABLE_CLASSIFICATIONS.has(report.classification)) {
    refuse(
      CODE_CHANGE_CREATION_REASONS.PREFLIGHT_UNMATERIALIZABLE,
      `Preflight refused ${check.id}: the repository or check is unmaterializable.`,
      { report, checkId: check.id }
    );
  }
  if (report.commit !== contract.subject.acquisition.base_commit) {
    refuse(
      CODE_CHANGE_CREATION_REASONS.PREFLIGHT_COMMIT_MISMATCH,
      `Preflight materialized ${report.commit || "no commit"}, not the contract base commit.`,
      { report, checkId: check.id }
    );
  }
  if (typeof report.basePassed !== "boolean") {
    refuse(
      CODE_CHANGE_CREATION_REASONS.PREFLIGHT_UNMATERIALIZABLE,
      `Preflight refused ${check.id}: no trusted base outcome was observed.`,
      { report, checkId: check.id }
    );
  }
  if (check.kind === "regression" && check.base_state === "green" && !report.basePassed) {
    refuse(
      CODE_CHANGE_CREATION_REASONS.PREFLIGHT_BASE_EXPECTATION_MISMATCH,
      `Preflight refused ${check.id}: the contract declares a green regression base, but it did not pass.`,
      { report, checkId: check.id }
    );
  }
}

function structuralRefusal(report) {
  const text = [
    report?.classificationReason || "",
    ...(report?.attempts || []).map((attempt) => `${attempt.stdout || ""}\n${attempt.stderr || ""}`)
  ].join("\n");
  if (/(?:DATABASE_START|DOCKER_START)_FAILED|cannot connect to (?:the )?docker daemon|docker\.sock|spawnSync\s+docker\s+ENOENT|docker:\s+(?:not found|command not found)/iu.test(text)) {
    return {
      reason: CODE_CHANGE_CREATION_REASONS.PREFLIGHT_PRIVILEGED_SERVICE,
      message: "Preflight refused publication: the check requires a privileged Docker or database service."
    };
  }
  if (/HARNESS_(?:CHECKOUT|AUTH)_FAILED|authenticated SSH clone .* failed|deploy key|missing (?:CI )?credential/iu.test(text)) {
    return {
      reason: CODE_CHANGE_CREATION_REASONS.PREFLIGHT_PRIVATE_CREDENTIAL,
      message: "Preflight refused publication: the check requires a private CI credential."
    };
  }
  return null;
}

function commandToShell(command) {
  return command.map((value) => `'${value.replaceAll("'", `'"'"'`)}'`).join(" ");
}

function refuse(reason, message, details = {}) {
  throw new CodeChangeCreationRefusedError(reason, message, details);
}

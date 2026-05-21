import { hashCanonicalContent } from "./canonical-content.js";

export const VERIFICATION_CONTRACT_VERSION = "verification-contract-v1";

export function buildVerificationContract(job, { verdict = undefined, verificationInput = undefined } = {}) {
  const verifierConfig = cloneJson(job?.verifierConfig);
  // verifierConfigVersion is the *data* version of the config blob itself
  // (bump when the shape of `verifierConfig` evolves). policyVersion is the
  // *rules* version — i.e. "verifier policy v3 means signers must include
  // at least two of N, not the v2 single-signer rule." They are intentionally
  // independent so a policy change does not require a backwards-incompatible
  // config-shape bump, and a config-shape migration does not pretend to
  // re-version the rules.
  //
  // Back-compat: pre-split fixtures and stored verifications only carry
  // `verifierConfig.version`. Read `policyVersion` first; fall back to
  // `version` when absent so legacy data keeps working.
  const verifierConfigVersion = normalizeVersion(verifierConfig?.version);
  const policyVersion = normalizeVersion(
    verifierConfig?.policyVersion ?? verifierConfig?.version
  );
  const handler = firstString(verdict?.handler, verifierConfig?.handler, job?.verifierMode, "unknown");
  const handlerVersion = normalizeOptionalVersion(verdict?.handlerVersion);
  const evidenceSchemaRef = firstString(
    job?.verification?.evidenceSchemaRef,
    job?.outputSchemaRef,
    undefined
  );
  const hasInput = verificationInput !== undefined;

  return compact({
    version: VERIFICATION_CONTRACT_VERSION,
    verifierMode: firstString(job?.verifierMode, undefined),
    handler,
    handlerVersion,
    policyVersion,
    verifierConfigVersion,
    verifierConfigHash: hashCanonicalContent(verifierConfig ?? null),
    evidenceSchemaRef,
    verificationInputHash: hasInput ? hashCanonicalContent(verificationInput ?? null) : undefined,
    replayEndpoint: "POST /verifier/replay",
    resultEndpoint: "GET /verifier/result",
    snapshotFields: [
      "verificationInput",
      "verificationInputHash",
      "verifierConfigSnapshot",
      "verifierConfigHash",
      "verifierConfigVersion",
      "policyVersion",
      "handlerVersion",
      "evidenceSchemaRef"
    ]
  });
}

export function buildVerificationAuditFields(job, { verdict = {}, verificationInput = undefined } = {}) {
  const verifierConfigSnapshot = cloneJson(job?.verifierConfig);
  const contract = buildVerificationContract(job, { verdict, verificationInput });
  const fields = {
    verifierConfigVersion: contract.verifierConfigVersion,
    policyVersion: contract.policyVersion,
    verifierConfigHash: contract.verifierConfigHash,
    verifierConfigSnapshot,
    verificationContract: contract
  };

  if (contract.handlerVersion !== undefined) {
    fields.handlerVersion = contract.handlerVersion;
  }
  if (contract.evidenceSchemaRef !== undefined) {
    fields.evidenceSchemaRef = contract.evidenceSchemaRef;
  }
  if (verificationInput !== undefined) {
    fields.verificationInput = verificationInput;
    fields.verificationInputHash = contract.verificationInputHash;
  }

  return compact(fields);
}

export function jobWithVerifierConfigSnapshot(job, verifierConfigSnapshot) {
  return {
    ...job,
    verifierConfig: cloneJson(verifierConfigSnapshot ?? job?.verifierConfig)
  };
}

function normalizeVersion(value) {
  const number = Number(value ?? 1);
  return Number.isInteger(number) && number > 0 ? number : 1;
}

function normalizeOptionalVersion(value) {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim();
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

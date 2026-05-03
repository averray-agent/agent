import { hashCanonicalContent } from "./canonical-content.js";

export const VERIFICATION_CONTRACT_VERSION = "verification-contract-v1";

export function buildVerificationContract(job, { verdict = undefined, verificationInput = undefined } = {}) {
  const verifierConfig = cloneJson(job?.verifierConfig);
  const verifierConfigVersion = normalizeVersion(verifierConfig?.version);
  const handler = firstString(verdict?.handler, verifierConfig?.handler, job?.verifierMode, "unknown");
  const handlerVersion = normalizeOptionalVersion(verdict?.handlerVersion);
  const hasInput = verificationInput !== undefined;

  return compact({
    version: VERIFICATION_CONTRACT_VERSION,
    verifierMode: firstString(job?.verifierMode, undefined),
    handler,
    handlerVersion,
    verifierConfigVersion,
    verifierConfigHash: hashCanonicalContent(verifierConfig ?? null),
    verificationInputHash: hasInput ? hashCanonicalContent(verificationInput ?? null) : undefined,
    replayEndpoint: "POST /verifier/replay",
    resultEndpoint: "GET /verifier/result",
    snapshotFields: [
      "verificationInput",
      "verificationInputHash",
      "verifierConfigSnapshot",
      "verifierConfigHash",
      "verifierConfigVersion",
      "handlerVersion"
    ]
  });
}

export function buildVerificationAuditFields(job, { verdict = {}, verificationInput = undefined } = {}) {
  const verifierConfigSnapshot = cloneJson(job?.verifierConfig);
  const contract = buildVerificationContract(job, { verdict, verificationInput });
  const fields = {
    verifierConfigVersion: contract.verifierConfigVersion,
    verifierConfigHash: contract.verifierConfigHash,
    verifierConfigSnapshot,
    verificationContract: contract
  };

  if (contract.handlerVersion !== undefined) {
    fields.handlerVersion = contract.handlerVersion;
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

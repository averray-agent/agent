import { ValidationError } from "../core/errors.js";

const FORBIDDEN_SETTLEMENT_REACHABILITY = Object.freeze([
  { pattern: /from\s+["'][^"']*verifier-service\.js["']/u, label: "VerifierService import" },
  { pattern: /from\s+["'][^"']*blockchain\/gateway\.js["']/u, label: "BlockchainGateway import" },
  { pattern: /from\s+["'][^"']*payments\/settlement-adapter\.js["']/u, label: "settlement adapter import" },
  { pattern: /from\s+["'][^"']*x402-poster-ramp\.js["']/u, label: "posting settlement path import" },
  { pattern: /resolveSinglePayout\s*\(/u, label: "resolveSinglePayout call" },
  { pattern: /resolvePayout\s*\(/u, label: "resolvePayout call" },
  { pattern: /\.settle\s*\(/u, label: "settlement call" }
]);

/** Static capability boundary used by the mutation drill and source audit. */
export function assertStandaloneVerificationSourceIsolation(source) {
  for (const forbidden of FORBIDDEN_SETTLEMENT_REACHABILITY) {
    if (forbidden.pattern.test(source)) {
      throw new ValidationError(
        `Standalone verification service may not reach settlement: ${forbidden.label}.`
      );
    }
  }
  return true;
}

export function assertVerifyIntakeIsolation(source) {
  for (const forbidden of [
    { pattern: /from\s+["'][^"']*x402-poster-ramp\.js["']/u, label: "posting ramp import" },
    { pattern: /from\s+["'][^"']*blockchain\/gateway\.js["']/u, label: "Hub gateway import" },
    { pattern: /\.settle\s*\(/u, label: "job settlement call" }
  ]) {
    if (forbidden.pattern.test(source)) {
      throw new ValidationError(
        `Standalone verification payment intake may not reach the posting rail: ${forbidden.label}.`
      );
    }
  }
  return true;
}

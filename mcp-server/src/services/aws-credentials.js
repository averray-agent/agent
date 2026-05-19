// fromIni lives in @aws-sdk/credential-provider-ini (which is already
// a transitive dep via @aws-sdk/client-kms) — avoiding a new top-level
// dep on @aws-sdk/credential-providers (just a convenience re-export).
import { fromIni } from "@aws-sdk/credential-provider-ini";

import { ConfigError } from "../core/errors.js";

/**
 * Phase 5a (IAM Roles Anywhere) cutover helper.
 *
 * The backend constructs two KMSClients — one for the blockchain
 * signer (`KmsSigner`) and one for the JWT signer (`KmsJwtSigner`).
 * Before Phase 5a both relied on the SDK's default credential
 * provider chain, which on the VPS reads `AWS_ACCESS_KEY_ID` /
 * `AWS_SECRET_ACCESS_KEY` env vars (long-lived static IAM keys).
 *
 * Phase 5a swaps those static keys for IAM Roles Anywhere — the VPS
 * holds X.509 client certs, and `aws_signing_helper credential-process`
 * exchanges them for 1-hour STS sessions. The SDK reaches the helper
 * via `~/.aws/config` `credential_process` directives, but only when
 * the SDK is told to use a specific shared-config profile (otherwise
 * it falls back to env vars). The single Node process needs to address
 * two profiles — one per signer — so we can't just set `AWS_PROFILE`
 * globally.
 *
 * This module returns an SDK-shaped credential provider (the result
 * of `fromIni({ profile })`) the signer-construction sites pass to
 * `KMSClient({ credentials })`. The provider lazy-spawns the helper
 * on each refresh and caches the resulting session until expiry —
 * standard AWS SDK behavior.
 *
 * Gated by `AWS_USE_ROLES_ANYWHERE=true`. When unset or false, returns
 * null and the signers fall through to the default chain (preserves
 * pre-cutover behavior). The flag is documented in
 * `docs/PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md` §6 (Phase 5a-cutover).
 */

const FLAG_ENV_VAR = "AWS_USE_ROLES_ANYWHERE";

/**
 * AWS shared-config profile names baked into the VPS
 * /etc/agent-stack/aws-config — created during the Phase 5a operator
 * setup. Hard-coded because the profiles match specific Roles
 * Anywhere trust anchors + IAM roles defined in the same setup; an
 * env-configurable name would only invite drift between the env and
 * the actual config file.
 */
export const PROFILE_BLOCKCHAIN_SIGNER = "averray-signer";
export const PROFILE_JWT_SIGNER = "averray-jwt-signer";

/**
 * Return an AWS SDK credentials provider bound to the given shared-
 * config profile, or `null` when Roles Anywhere isn't enabled in the
 * current env. The signer construction sites pass the result to
 * `new KMSClient({ credentials })` only when non-null; otherwise they
 * let the SDK use its default credential chain (existing static-key
 * path, unchanged).
 *
 * @param {object} opts
 * @param {string} opts.profile      Shared-config profile name (use the
 *                                   `PROFILE_*` constants above).
 * @param {Record<string,string>} [opts.env]  Override `process.env` for tests.
 * @returns {import("@aws-sdk/types").AwsCredentialIdentityProvider | null}
 */
export function buildKmsCredentialsProvider({ profile, env = process.env } = {}) {
  const raw = env[FLAG_ENV_VAR];
  const enabled = typeof raw === "string" && raw.trim().toLowerCase() === "true";
  if (!enabled) {
    return null;
  }
  if (!profile || typeof profile !== "string" || profile.trim().length === 0) {
    throw new ConfigError(
      `buildKmsCredentialsProvider: profile is required when ${FLAG_ENV_VAR}=true ` +
        "(use PROFILE_BLOCKCHAIN_SIGNER or PROFILE_JWT_SIGNER from this module).",
    );
  }
  return fromIni({ profile });
}

/**
 * Test-only escape hatch. Exposes the flag name so tests can manipulate
 * env without hard-coding the string in multiple places.
 */
export const ROLES_ANYWHERE_FLAG_ENV_VAR = FLAG_ENV_VAR;

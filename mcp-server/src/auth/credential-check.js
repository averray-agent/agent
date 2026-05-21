import { ConfigError } from "../core/errors.js";

/**
 * Boot-time validation that the AWS credential chain can reach the JWT
 * KMS key. Calls `kms:DescribeKey` against the configured `keyId` —
 * cheap (returns metadata only, no signing), but exercises the full
 * credential resolution path the backend would use on the first
 * `kms:Sign` call.
 *
 * Why this exists (Phase 5a prep): under static IAM keys today, a
 * misconfigured `AWS_JWT_ACCESS_KEY_ID`/`AWS_JWT_SECRET_ACCESS_KEY`
 * surfaces only at the first SIWE refresh — the backend boots clean,
 * `/health` reports green, then every user sign-in returns 500. Under
 * IAM Roles Anywhere (Phase 5a cutover), the failure modes multiply:
 * wrong cert path, wrong profile name, wrong trust-anchor ARN, expired
 * cert. All silent at boot, all surface at request time.
 *
 * This module fails the boot loudly with a `ConfigError` that names
 * the specific AWS error, so operators see the problem at deploy time
 * (in `bootstrap.init_failed` log line, in the systemd journal) rather
 * than as a user-facing 500.
 *
 * The check runs only when `authConfig.kmsJwt` is set — i.e., when
 * `JWT_BACKEND` is `kms` or `both`. Under `JWT_BACKEND=hmac` there's
 * no KMS dependency to validate.
 */

const VALIDATION_TIMEOUT_MS = 10_000;

/**
 * @param {object} kmsJwtConfig    The `authConfig.kmsJwt` block (region, keyId, kmsClient, ...).
 * @param {object} [opts]
 * @param {object} [opts.logger]   Logger with `.info`/`.warn` methods.
 * @param {boolean} [opts.skip]    Test-only escape hatch — skip the live check.
 * @param {Function} [opts.credentialsProvider]
 *   AWS SDK credentials-provider function (e.g. the `fromIni` result from
 *   `buildKmsCredentialsProvider`). When provided AND no `kmsJwtConfig.kmsClient`
 *   is injected, the constructed `KMSClient` is built with this provider so the
 *   boot check uses the same credential resolution path as the runtime signer
 *   (`getKmsSigner` in `jwt.js`). Without it, `new KMSClient({ region })` falls
 *   through to the SDK default chain (env vars / shared config / IMDS) — which
 *   does NOT pick up Roles Anywhere by default and therefore disagrees with the
 *   runtime path when `AWS_USE_ROLES_ANYWHERE=true` is set + static keys are
 *   not in env. That drift was the root cause of the Phase 5a Stage 2C-3 prod
 *   outage (#455 → reverted in #456): the runtime KmsJwtSigner had Roles
 *   Anywhere wired in, but this boot check did not — so removing the env-
 *   rendered static keys broke the boot check (`CredentialsProviderError`)
 *   while the runtime kept working. Production callers MUST pass this opt.
 * @returns {Promise<{ ok: true, keyId: string, keyArn: string, keyState: string }>}
 * @throws {ConfigError}            If the credential chain cannot resolve or DescribeKey fails.
 */
export async function validateJwtKmsCredentialAccess(kmsJwtConfig, opts = {}) {
  if (!kmsJwtConfig) {
    // HMAC-only mode; nothing to validate.
    return { ok: true, skipped: "hmac-only" };
  }
  if (opts.skip === true || process.env.JWT_KMS_CREDENTIAL_CHECK_SKIP === "1") {
    // Explicit escape hatch for test environments where AWS is not
    // available. Logged at warn level so a stray prod skip is loud.
    opts.logger?.warn?.(
      { reason: "JWT_KMS_CREDENTIAL_CHECK_SKIP=1 or opts.skip=true" },
      "jwt-kms-credential-check.skipped",
    );
    return { ok: true, skipped: "explicit" };
  }
  if (!kmsJwtConfig.region || !kmsJwtConfig.keyId) {
    throw new ConfigError(
      "validateJwtKmsCredentialAccess: authConfig.kmsJwt is missing region or keyId. " +
        "This indicates a bug in loadAuthConfig — the kmsJwt block should not exist without both fields.",
    );
  }

  // Lazy-import the SDK to keep cold-import light for HMAC-only
  // callers. Matches the import strategy in KmsJwtSigner.
  const { KMSClient, DescribeKeyCommand } = await import("@aws-sdk/client-kms");

  // Reuse the test-injected KMSClient if present (KmsJwtSigner does
  // the same), so unit tests can stub the check without configuring a
  // real AWS account. When none is injected, build one with the same
  // credentials-provider the runtime signer uses — see the
  // opts.credentialsProvider JSDoc above for the failure mode this
  // avoids.
  const client =
    kmsJwtConfig.kmsClient ??
    new KMSClient({
      region: kmsJwtConfig.region,
      ...(opts.credentialsProvider ? { credentials: opts.credentialsProvider } : {}),
    });

  const startedAt = Date.now();
  let response;
  try {
    response = await withTimeout(
      client.send(new DescribeKeyCommand({ KeyId: kmsJwtConfig.keyId })),
      VALIDATION_TIMEOUT_MS,
      "jwt-kms-credential-check",
    );
  } catch (error) {
    throw classifyError(error, kmsJwtConfig);
  }

  const meta = response?.KeyMetadata;
  if (!meta) {
    throw new ConfigError(
      `JWT KMS credential check returned no KeyMetadata for ${kmsJwtConfig.keyId}. ` +
        "Either the key was deleted between config-load and this call, or the AWS SDK returned an unexpected shape.",
    );
  }
  if (meta.KeyState && meta.KeyState !== "Enabled") {
    throw new ConfigError(
      `JWT KMS key ${kmsJwtConfig.keyId} is in state "${meta.KeyState}" (not "Enabled"). ` +
        "kms:Sign calls will fail until the key is re-enabled.",
    );
  }
  if (meta.KeyUsage && meta.KeyUsage !== "SIGN_VERIFY") {
    throw new ConfigError(
      `JWT KMS key ${kmsJwtConfig.keyId} has KeyUsage="${meta.KeyUsage}" (expected "SIGN_VERIFY"). ` +
        "This is the wrong key — confirm AWS_JWT_KEY_ID points at the JWT signer key, not the blockchain signer key.",
    );
  }

  const durationMs = Date.now() - startedAt;
  opts.logger?.info?.(
    {
      keyId: kmsJwtConfig.keyId,
      keyArn: meta.Arn,
      keyState: meta.KeyState,
      keyUsage: meta.KeyUsage,
      durationMs,
    },
    "jwt-kms-credential-check.ok",
  );

  return {
    ok: true,
    keyId: kmsJwtConfig.keyId,
    keyArn: meta.Arn,
    keyState: meta.KeyState,
  };
}

function classifyError(error, kmsJwtConfig) {
  const name = error?.name ?? "";
  const message = String(error?.message ?? error);
  const httpStatus = error?.$metadata?.httpStatusCode;

  // The AWS SDK throws CredentialsProviderError when nothing in the
  // credential chain resolves (no env vars, no shared config, no
  // EC2/ECS/IRSA, no Roles Anywhere). Most common failure mode after
  // a Phase 5a cutover with a botched cert install.
  if (name === "CredentialsProviderError" || /Could not load credentials/i.test(message)) {
    return new ConfigError(
      "JWT KMS credential chain failed to resolve at boot. " +
        "The AWS SDK could not find usable credentials in env vars, shared config, " +
        "or any provider chain. Common causes: AWS_JWT_ACCESS_KEY_ID / AWS_JWT_SECRET_ACCESS_KEY " +
        "missing (static-key mode); ~/.aws/config credential_process directive missing or " +
        "pointing at the wrong cert/key path (Roles Anywhere mode); aws_signing_helper " +
        "binary missing from PATH. " +
        `Underlying error: ${message}`,
    );
  }

  // Auth failures from KMS itself — credentials resolved, but the
  // resolved principal doesn't have kms:DescribeKey on this key.
  if (name === "AccessDeniedException" || httpStatus === 403) {
    return new ConfigError(
      "JWT KMS credential chain resolved, but the resulting principal lacks " +
        `kms:DescribeKey on ${kmsJwtConfig.keyId}. The IAM policy attached to the JWT signer ` +
        "role/user should permit kms:DescribeKey (a low-privilege metadata read; the existing " +
        "kms:Sign-only policy needs to be expanded to include DescribeKey for boot validation, " +
        "or this check needs to be skipped via JWT_KMS_CREDENTIAL_CHECK_SKIP=1). " +
        `Underlying error: ${message}`,
    );
  }

  if (name === "NotFoundException" || httpStatus === 404) {
    return new ConfigError(
      `JWT KMS key ${kmsJwtConfig.keyId} not found by AWS. The AWS_JWT_KEY_ID env var ` +
        "may point at a key that was deleted, an alias that was retargeted away, or a key " +
        "in a different region than AWS_JWT_REGION. " +
        `Underlying error: ${message}`,
    );
  }

  // Generic fall-through. Surface enough context for the operator to
  // troubleshoot from the bootstrap.init_failed log line alone.
  return new ConfigError(
    `JWT KMS credential check failed with ${name || "an unrecognized AWS error"}. ` +
      `keyId=${kmsJwtConfig.keyId}, region=${kmsJwtConfig.region}, httpStatus=${httpStatus ?? "n/a"}. ` +
      `Underlying error: ${message}`,
  );
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `${label}: timed out after ${timeoutMs} ms (AWS SDK retries may indicate a network-level outage, ` +
            "DNS failure, or aws_signing_helper hanging on stdin).",
        ),
      );
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

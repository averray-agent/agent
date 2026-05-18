import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { AuthenticationError, ConfigError } from "../core/errors.js";

const HEADER = { alg: "HS256", typ: "JWT" };
const CLOCK_SKEW_SECONDS = 60;

/**
 * Minimal JWT (HS256) implementation — no external dependency.
 *
 * Supports key rotation: pass an array of secrets; `verifyToken` accepts any,
 * `signToken` always uses the first (newest).
 *
 * Phase 4b (PR 4b.4) adds the dispatcher entry points
 * `signTokenFromConfig` / `verifyTokenFromConfig` below the legacy
 * `signToken` / `verifyToken` functions. The legacy API is preserved
 * byte-for-byte so existing tests and the `scripts/ops/mint-admin-jwt.mjs`
 * caller keep working under `JWT_BACKEND=hmac` (default).
 */

export function signToken(payload, { secret, expiresInSeconds }) {
  if (!secret) {
    throw new ConfigError("JWT signing secret missing.");
  }
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new ConfigError("expiresInSeconds must be a positive integer.");
  }

  const now = nowSeconds();
  const fullPayload = {
    jti: randomUUID(),
    iat: now,
    exp: now + expiresInSeconds,
    ...payload
  };

  const headerPart = base64UrlEncode(JSON.stringify(HEADER));
  const payloadPart = base64UrlEncode(JSON.stringify(fullPayload));
  const signingInput = `${headerPart}.${payloadPart}`;
  const signature = sign(signingInput, secret);

  return {
    token: `${signingInput}.${signature}`,
    claims: fullPayload
  };
}

export function verifyToken(token, { secrets }) {
  if (!secrets || secrets.length === 0) {
    throw new ConfigError("At least one JWT secret is required for verification.");
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new AuthenticationError("Missing token.", "missing_token");
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AuthenticationError("Malformed token.", "malformed_token");
  }

  const [headerPart, payloadPart, signaturePart] = parts;
  const signingInput = `${headerPart}.${payloadPart}`;

  let header;
  try {
    header = JSON.parse(base64UrlDecode(headerPart).toString("utf8"));
  } catch {
    throw new AuthenticationError("Invalid token header.", "malformed_token");
  }
  if (header?.alg !== "HS256" || header?.typ !== "JWT") {
    throw new AuthenticationError("Unsupported token algorithm.", "unsupported_alg");
  }

  const matches = secrets.some((secret) => constantTimeEquals(sign(signingInput, secret), signaturePart));
  if (!matches) {
    throw new AuthenticationError("Token signature mismatch.", "bad_signature");
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadPart).toString("utf8"));
  } catch {
    throw new AuthenticationError("Invalid token payload.", "malformed_token");
  }

  const now = nowSeconds();
  if (typeof payload.iat === "number" && payload.iat > now + CLOCK_SKEW_SECONDS) {
    throw new AuthenticationError("Token issued in the future.", "token_iat_future");
  }
  if (typeof payload.exp === "number" && payload.exp + CLOCK_SKEW_SECONDS < now) {
    throw new AuthenticationError("Token expired.", "token_expired");
  }

  return payload;
}

// ───────────────────────────────────────────────────────────────────────
// Phase 4b dispatcher
// ───────────────────────────────────────────────────────────────────────

/**
 * Lazily-cached KmsJwtSigner instance, keyed by the kmsJwt config
 * reference (each config load creates one instance and the dispatcher
 * keeps it alive for the process lifetime). Cached via a WeakMap so
 * test code that loads multiple distinct configs doesn't accumulate
 * dangling signers.
 *
 * We intentionally don't import @aws-sdk/client-kms eagerly — HMAC-only
 * deploys must not pay the SDK import cost. The KmsJwtSigner module
 * itself defers the SDK import to the first send().
 */
const SIGNER_CACHE = new WeakMap();

async function getKmsSigner(authConfig) {
  if (!authConfig?.kmsJwt) {
    throw new ConfigError(
      "JWT_BACKEND requires KMS but authConfig.kmsJwt is null. Set AWS_JWT_REGION / AWS_JWT_KEY_ID / JWT_PUBLIC_KEY_PEM / JWT_PUBLIC_KEY_FINGERPRINT.",
    );
  }
  const cached = SIGNER_CACHE.get(authConfig.kmsJwt);
  if (cached) return cached;
  // Lazy-import; ensures hmac-only callers never pull in
  // @aws-sdk/client-kms (KmsJwtSigner's own SDK import is also lazy).
  const { KmsJwtSigner } = await import("./kms-jwt-signer.js");
  // Allow tests to inject a KMSClient via authConfig.kmsJwt.kmsClient
  // without leaking that field into the loaded-from-env public shape —
  // production env never sets it.
  const signer = new KmsJwtSigner({
    kmsClient: authConfig.kmsJwt.kmsClient,
    region: authConfig.kmsJwt.region,
    keyId: authConfig.kmsJwt.keyId,
    kid: authConfig.kmsJwt.kid,
    publicKeyPem: authConfig.kmsJwt.publicKeyPem,
    expectedIssuer: authConfig.kmsJwt.expectedIssuer,
    expectedAudience: authConfig.kmsJwt.expectedAudience,
    expectedRoles: authConfig.kmsJwt.expectedRoles,
    maxTtlSeconds: authConfig.kmsJwt.maxTtlSeconds,
    clockSkewSeconds: authConfig.kmsJwt.clockSkewSeconds,
  });
  SIGNER_CACHE.set(authConfig.kmsJwt, signer);
  return signer;
}

/**
 * Determine which alg the sign path should produce.
 *
 *   hmac → always HS256
 *   kms  → always ES256
 *   both → JWT_PRIMARY_ALG decides (default "hmac")
 */
function pickSignAlg(authConfig) {
  switch (authConfig?.jwtBackend) {
    case "kms":
      return "ES256";
    case "both":
      return authConfig.jwtPrimaryAlg === "kms" ? "ES256" : "HS256";
    case "hmac":
    case undefined: // treat missing as default "hmac" for safety
    case null:
      return "HS256";
    default:
      throw new ConfigError(`Unknown jwtBackend "${authConfig.jwtBackend}".`);
  }
}

/**
 * Sign a JWT according to `authConfig.jwtBackend`.
 *
 * HS256 path returns the same `{ token, claims }` shape as the existing
 * `signToken` (and reuses it under the hood). ES256 path returns the
 * same shape — the dispatcher decodes the produced token's claims to
 * keep the interface uniform for callers that need the issued claims
 * (e.g., HTTP handlers that echo `jti` back to clients).
 *
 * For ES256, the caller supplies `issuer` / `audience` / `subject` /
 * `role` in `opts` (matching KmsJwtSigner's signAsync contract). When
 * those are absent, the dispatcher derives sensible defaults from
 * `authConfig.kmsJwt`'s configured expectations, so the HTTP-server
 * sign-in handler can keep passing only the payload + TTL during the
 * transition.
 */
export async function signTokenFromConfig(payload, opts, authConfig) {
  if (!authConfig || typeof authConfig !== "object") {
    throw new ConfigError("signTokenFromConfig: authConfig is required.");
  }
  if (!opts || typeof opts !== "object") {
    throw new ConfigError("signTokenFromConfig: opts (with expiresInSeconds) is required.");
  }
  const alg = pickSignAlg(authConfig);

  if (alg === "HS256") {
    const secret = opts.secret ?? authConfig.signingSecret;
    return signToken(payload, { secret, expiresInSeconds: opts.expiresInSeconds });
  }

  // ES256 path.
  const signer = await getKmsSigner(authConfig);
  const subject =
    opts.subject ?? (typeof payload?.sub === "string" ? payload.sub : undefined);
  const role =
    opts.role
    ?? (Array.isArray(payload?.roles) && payload.roles.length > 0 ? payload.roles[0] : undefined)
    ?? (typeof payload?.role === "string" ? payload.role : undefined);
  const issuer = opts.issuer ?? authConfig.kmsJwt?.expectedIssuer;
  const audience = opts.audience ?? authConfig.kmsJwt?.expectedAudience;

  if (!issuer || !audience || !subject || !role) {
    throw new ConfigError(
      "signTokenFromConfig (ES256): issuer/audience/subject/role must each be derivable from opts or authConfig.kmsJwt + payload.",
    );
  }

  // Strip registered claims the signer manages itself so the merged
  // payload doesn't accidentally override iat/exp/jti/iss/aud/sub/role.
  const {
    iss: _iss,
    aud: _aud,
    sub: _sub,
    role: _role,
    iat: _iat,
    nbf: _nbf,
    exp: _exp,
    jti: _jti,
    ...extras
  } = payload ?? {};

  const token = await signer.signAsync(extras, {
    issuer,
    audience,
    subject,
    role,
    expiresInSeconds: opts.expiresInSeconds,
  });
  // Decode the just-signed claims for the caller without re-verifying —
  // we trust our own emission.
  const [, claimsB64] = token.split(".");
  const claims = JSON.parse(base64UrlDecode(claimsB64).toString("utf8"));
  return { token, claims };
}

/**
 * Verify a JWT according to `authConfig.jwtBackend`. The dispatcher
 * pre-parses the JOSE header to determine which backend to route to,
 * then enforces strict header rules at the dispatcher boundary
 * (alg=none and mixed-case variants rejected unconditionally) before
 * any signature operation.
 *
 * Algorithm-confusion defense: each backend is told which algorithm it
 * supports. HMAC verify rejects ES256 tokens; KMS verify rejects HS256
 * tokens. We never use the alg claim to choose a cryptographic
 * operation — we use it only to route to the configured backend.
 */
export async function verifyTokenFromConfig(token, authConfig) {
  if (!authConfig || typeof authConfig !== "object") {
    throw new ConfigError("verifyTokenFromConfig: authConfig is required.");
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new AuthenticationError("Missing token.", "missing_token");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AuthenticationError("Malformed token.", "malformed_token");
  }
  const [headerPart] = parts;

  let header;
  try {
    header = JSON.parse(base64UrlDecode(headerPart).toString("utf8"));
  } catch {
    throw new AuthenticationError("Invalid token header.", "malformed_token");
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    throw new AuthenticationError("Invalid token header.", "malformed_token");
  }

  // Exact-match alg comparison — anything other than the two supported
  // values is rejected here, BEFORE we touch the signature. Catches
  // "none" / "None" / "NONE" / lowercase variants in one place. The
  // per-backend code re-checks alg as defense-in-depth but the dispatcher
  // is the canonical gate.
  const alg = header.alg;
  if (alg === "none" || alg === "None" || alg === "NONE") {
    throw new AuthenticationError(
      `Unsupported token algorithm "${alg}".`,
      "unsupported_alg",
    );
  }

  const backend = authConfig.jwtBackend ?? "hmac";

  if (alg === "HS256") {
    if (backend === "kms") {
      throw new AuthenticationError(
        `alg HS256 not supported in JWT_BACKEND=kms mode.`,
        "unsupported_alg",
      );
    }
    // hmac / both → existing HMAC path; verifyToken handles header.typ
    // and signature rotation against authConfig.secrets.
    return verifyToken(token, { secrets: authConfig.secrets });
  }

  if (alg === "ES256") {
    if (backend === "hmac") {
      throw new AuthenticationError(
        `alg ES256 not supported in JWT_BACKEND=hmac mode.`,
        "unsupported_alg",
      );
    }
    // kms / both → KmsJwtSigner.verify enforces header.typ, kid,
    // forbidden headers (jku/jwk/x5u/x5c/crit), the signature, and
    // all claims-validation rules from design doc §6. verifyEs256
    // lazy-imports the signer module on first call so HMAC-only
    // deploys never pay the @aws-sdk/client-kms import cost. The
    // dispatcher is async to accommodate that — the middleware
    // call site already awaits, so this is invisible to callers.
    return await verifyEs256(token, authConfig);
  }

  throw new AuthenticationError(
    `Unsupported token algorithm "${alg}".`,
    "unsupported_alg",
  );
}

async function verifyEs256(token, authConfig) {
  const signer = await getKmsSigner(authConfig);
  try {
    const claims = signer.verify(token);
    // Bridge ES256's singular `role` claim (per design doc §6) to the
    // plural `roles` array that the rest of the auth stack expects
    // (capabilities.resolveCapabilities, config.hasRole, middleware
    // expandCapabilities — all read claims.roles). The HS256 path
    // already produces roles: array via the SIWE handler; this keeps
    // downstream code algorithm-agnostic. If the token already carries
    // a `roles` array (e.g., a future multi-role variant), we leave it
    // untouched — `role` is the canonical ES256 shape but we don't
    // forbid `roles` if present.
    if (typeof claims.role === "string" && !Array.isArray(claims.roles)) {
      claims.roles = [claims.role];
    }
    return claims;
  } catch (err) {
    // KmsJwtSigner throws plain Error objects with explanatory
    // messages. Convert to AuthenticationError so the HTTP layer
    // returns 401 / the right error envelope, matching how the HMAC
    // path's AuthenticationError flows through middleware.js.
    throw new AuthenticationError(
      err?.message ?? "Token verification failed.",
      classifyKmsVerifyError(err),
    );
  }
}

function classifyKmsVerifyError(err) {
  const msg = String(err?.message ?? "");
  if (/expired/iu.test(msg)) return "token_expired";
  if (/not yet valid/iu.test(msg)) return "token_nbf_future";
  if (/issued in the future/iu.test(msg)) return "token_iat_future";
  if (/signature mismatch/iu.test(msg)) return "bad_signature";
  if (/malformed token|malformed JWS|invalid header|invalid claims|invalid signature/iu.test(msg)) {
    return "malformed_token";
  }
  if (/unsupported alg|unsupported typ/iu.test(msg)) return "unsupported_alg";
  if (/forbidden header/iu.test(msg)) return "unsupported_alg";
  if (/kid .* not in allowlist|kid header/iu.test(msg)) return "unknown_kid";
  if (/unexpected iss|unexpected aud/iu.test(msg)) return "claims_mismatch";
  if (/role .* not in allowlist/iu.test(msg)) return "role_not_allowed";
  if (/sub claim|jti missing|jti .* UUIDv4|exp - iat|iat claim|nbf claim|exp claim/iu.test(msg)) {
    return "claims_mismatch";
  }
  return "bad_signature";
}

function sign(input, secret) {
  return base64UrlEncode(createHmac("sha256", secret).update(input).digest());
}

function base64UrlEncode(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buffer.toString("base64").replace(/=+$/u, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

function base64UrlDecode(input) {
  const padded = input.replace(/-/gu, "+").replace(/_/gu, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLen), "base64");
}

function constantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

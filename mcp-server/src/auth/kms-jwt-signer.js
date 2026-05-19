/**
 * AWS KMS-backed ES256 JWT signer + verifier adapter.
 *
 * Phase 4b (per docs/PHASE_4B_KMS_JWT_PLAN.md). Drop-in replacement for
 * the HMAC-based signer in `./jwt.js`, but the private key material
 * never leaves AWS KMS. Signing dispatches `kms:Sign` over a SHA-256
 * digest; verification uses the locally-cached P-256 public key with
 * `node:crypto`'s `createVerify` (no KMS round-trip per verify).
 *
 * Wiring: this adapter is NOT yet referenced by the live auth path.
 * PR 4b.4 will introduce the dispatcher in `./jwt.js` that routes to
 * this module when `JWT_BACKEND=kms`. Until then this file ships alongside
 * the HMAC implementation and is exercised only from tests.
 *
 * IAM permissions the AWS principal must have on the JWT signing key:
 *   - kms:Sign with kms:SigningAlgorithm=ECDSA_SHA_256 and
 *     kms:MessageType=DIGEST (enforced by the condition keys in
 *     deploy/iam-policies/averray-jwt-signer-prod-role.json)
 *
 * Note that we do NOT call kms:GetPublicKey at runtime; the public key
 * is rendered into the backend env as `JWT_PUBLIC_KEY_PEM` (see §4 of
 * the design doc) — this keeps verification working through a KMS
 * outage and avoids an extra network call per process start. The
 * deploy-time render is authoritative; the public key is checked
 * against `kms:GetPublicKey` by the operator script in PR 4b.3.
 *
 * Header strictness (per design doc §6 and RFC 8725):
 *   - alg must be exactly "ES256" — no mixed-case, no "none"
 *   - typ must be exactly "averray-auth+jwt" — no generic "JWT"
 *   - kid must equal the configured kid
 *   - jku, jwk, x5u, x5c, crit headers are rejected
 *
 * Claims validation:
 *   - iss, aud match configured expected values
 *   - sub present, non-empty, lowercase
 *   - role in the configured allowlist
 *   - iat, nbf, exp numeric; exp - iat ≤ MAX_TTL_SECONDS
 *   - clock skew bounded by ±clockSkewSeconds (default 60)
 *   - jti is a UUIDv4-shaped string
 */

import {
  createHash,
  createPublicKey,
  createVerify,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { parseP256Spki } from "./p256-spki.js";
import { jwsRawFromDer, jwsRawToDer } from "./jws-ecdsa.js";

const HEADER_TYP = "averray-auth+jwt";
const HEADER_ALG = "ES256";
const DEFAULT_CLOCK_SKEW_SECONDS = 60;
const DEFAULT_MAX_TTL_SECONDS = 3600;
const FORBIDDEN_HEADERS = ["jku", "jwk", "x5u", "x5c", "crit"];
// Standard UUIDv4 shape. We don't enforce that other UUID versions are
// rejected at the regex level — the version-4 nibble is checked
// explicitly so the error message stays specific.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class KmsJwtSigner {
  #kmsClient;
  #region;
  #credentialsProvider;
  #keyId;
  #kid;
  #kidBuf;
  #publicKey;
  #publicKeyPem;
  #expectedIssuer;
  #expectedAudience;
  #expectedRoles;
  #maxTtlSeconds;
  #clockSkewSeconds;
  #now;

  /**
   * @param {object} opts
   * @param {object} [opts.kmsClient]           AWS SDK v3 KMSClient (preferred for tests).
   * @param {string} [opts.region]              AWS region; lazy KMSClient construction when kmsClient absent.
   * @param {string} opts.keyId                 Full KMS key ARN (NOT an alias — see design doc §3).
   * @param {string} opts.kid                   JWT `kid` header value (e.g., "jwt-1").
   * @param {string} opts.publicKeyPem          PEM-encoded SubjectPublicKeyInfo for the signing key.
   * @param {string} [opts.expectedIssuer]      Required for verify(); can be passed per-call instead.
   * @param {string} [opts.expectedAudience]    Required for verify(); can be passed per-call instead.
   * @param {string[]} [opts.expectedRoles]     Allowlist of accepted `role` claim values; can be per-call.
   * @param {number} [opts.maxTtlSeconds]       Cap on `exp - iat`; defaults to 3600 (1h).
   * @param {number} [opts.clockSkewSeconds]    Skew tolerance for nbf/exp; defaults to 60.
   * @param {() => number} [opts.now]           Override clock (epoch seconds) for tests.
   * @param {import("@aws-sdk/types").AwsCredentialIdentityProvider} [opts.credentialsProvider]
   *   Optional AWS SDK credentials provider passed to the lazy-constructed
   *   KMSClient. Used by Phase 5a (Roles Anywhere) — see
   *   `mcp-server/src/services/aws-credentials.js`. When null/undefined,
   *   the lazy KMSClient gets no explicit credentials and falls through to
   *   the SDK's default credential chain (env vars, shared config, etc.) —
   *   the pre-5a behavior, unchanged.
   */
  constructor(opts) {
    if (!opts || typeof opts !== "object") {
      throw new Error("KmsJwtSigner: options object is required");
    }
    const {
      kmsClient,
      region,
      keyId,
      kid,
      publicKeyPem,
      expectedIssuer,
      expectedAudience,
      expectedRoles,
      maxTtlSeconds,
      clockSkewSeconds,
      now,
      credentialsProvider,
    } = opts;
    if (!keyId || typeof keyId !== "string") {
      throw new Error("KmsJwtSigner: keyId is required (full KMS key ARN)");
    }
    // Soft-warn (in error form) when an alias appears to be used; using
    // an alias instead of the ARN opens a substitution attack via
    // kms:UpdateAlias. The design doc calls this out explicitly.
    if (keyId.startsWith("alias/")) {
      throw new Error(
        `KmsJwtSigner: keyId must be the full KMS key ARN, not an alias ("${keyId}"). Aliases can be retargeted to a different key.`,
      );
    }
    if (!kid || typeof kid !== "string") {
      throw new Error("KmsJwtSigner: kid is required");
    }
    if (!publicKeyPem || typeof publicKeyPem !== "string") {
      throw new Error("KmsJwtSigner: publicKeyPem is required");
    }
    if (!kmsClient && !region) {
      throw new Error("KmsJwtSigner: either kmsClient or region must be provided");
    }
    if (maxTtlSeconds !== undefined && (!Number.isInteger(maxTtlSeconds) || maxTtlSeconds <= 0)) {
      throw new Error("KmsJwtSigner: maxTtlSeconds must be a positive integer");
    }
    if (clockSkewSeconds !== undefined && (!Number.isInteger(clockSkewSeconds) || clockSkewSeconds < 0)) {
      throw new Error("KmsJwtSigner: clockSkewSeconds must be a non-negative integer");
    }
    if (expectedRoles !== undefined && !Array.isArray(expectedRoles)) {
      throw new Error("KmsJwtSigner: expectedRoles must be an array of strings");
    }

    // Cross-check the supplied PEM: parse the SPKI through parseP256Spki
    // to confirm it's a NIST P-256 key (not RSA, not secp256k1). This
    // closes the door on a misconfiguration where JWT_PUBLIC_KEY_PEM
    // somehow ends up pointing at the blockchain signer's public key,
    // which would mean our verify path silently accepts secp256k1
    // signatures it shouldn't (or, more likely, rejects every token
    // with a confusing low-level error).
    const publicKey = createPublicKey({ key: publicKeyPem, format: "pem" });
    const spkiDer = publicKey.export({ type: "spki", format: "der" });
    // Throws on non-P-256, non-uncompressed, or any structural issue.
    parseP256Spki(new Uint8Array(spkiDer));

    this.#kmsClient = kmsClient ?? null;
    this.#region = region ?? null;
    this.#credentialsProvider = credentialsProvider ?? null;
    this.#keyId = keyId;
    this.#kid = kid;
    // Pre-compute the buffer for constant-time kid comparison. The kid
    // isn't a secret, but timingSafeEqual short-circuits the JS-level
    // string-compare and provides a stable comparison primitive.
    this.#kidBuf = Buffer.from(kid, "utf8");
    this.#publicKey = publicKey;
    this.#publicKeyPem = publicKeyPem;
    this.#expectedIssuer = expectedIssuer ?? null;
    this.#expectedAudience = expectedAudience ?? null;
    this.#expectedRoles = expectedRoles ? new Set(expectedRoles) : null;
    this.#maxTtlSeconds = maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS;
    this.#clockSkewSeconds = clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    this.#now = typeof now === "function" ? now : null;
  }

  /** Configured `kid` header value. */
  get kid() {
    return this.#kid;
  }

  /** Configured KMS key ARN. */
  get keyId() {
    return this.#keyId;
  }

  /** PEM the signer was configured with (verification public key). */
  get publicKeyPem() {
    return this.#publicKeyPem;
  }

  async #getClient() {
    if (this.#kmsClient) return this.#kmsClient;
    const { KMSClient } = await import("@aws-sdk/client-kms");
    // Phase 5a: pass the optional credentialsProvider through to
    // KMSClient. When null (default chain), behavior matches pre-5a.
    const clientOpts = { region: this.#region };
    if (this.#credentialsProvider) {
      clientOpts.credentials = this.#credentialsProvider;
    }
    this.#kmsClient = new KMSClient(clientOpts);
    return this.#kmsClient;
  }

  #nowSeconds() {
    if (this.#now) return Math.floor(this.#now());
    return Math.floor(Date.now() / 1000);
  }

  /**
   * Sign a JWT with the KMS-backed P-256 key. Builds the standard
   * registered claims (iat, nbf, exp, jti) on top of the caller's
   * payload, plus iss/aud/sub/roles from `opts`.
   *
   * Phase 4b.6 Stage 2B: `opts.role` accepts either a single string
   * (legacy single-role admin JWTs minted via `mint-admin-jwt.mjs
   * --use-kms`) or an array (SIWE multi-role wallets that hold both
   * admin AND verifier). Emitted tokens always carry a `roles` array
   * claim — never the singular `role` — so downstream consumers
   * (middleware, capabilities) have one canonical shape. The dispatcher
   * (jwt.js verifyEs256) still bridges legacy single-`role` tokens
   * minted before this PR for backward compat.
   *
   * @param {object} payload                       Extra claims to merge in (must not override registered claims).
   * @param {object} opts
   * @param {string} opts.issuer                   `iss` claim value.
   * @param {string} opts.audience                 `aud` claim value.
   * @param {string} opts.subject                  `sub` claim value (lowercase EVM address or canonical user id).
   * @param {string | string[]} opts.role          `roles` claim source — single string or non-empty array of strings.
   * @param {number} opts.expiresInSeconds         Token lifetime; will set exp = iat + this.
   * @returns {Promise<string>}                    The serialized ES256 JWT.
   */
  async signAsync(payload, opts) {
    if (!opts || typeof opts !== "object") {
      throw new Error("KmsJwtSigner.signAsync: options object is required");
    }
    const { issuer, audience, subject, role, expiresInSeconds } = opts;
    if (!issuer || typeof issuer !== "string") {
      throw new Error("KmsJwtSigner.signAsync: issuer is required");
    }
    if (!audience || typeof audience !== "string") {
      throw new Error("KmsJwtSigner.signAsync: audience is required");
    }
    if (!subject || typeof subject !== "string") {
      throw new Error("KmsJwtSigner.signAsync: subject is required");
    }
    // Normalize role/roles input. Caller may pass a single string
    // (admin-JWT minting path) or an array (SIWE multi-role wallet).
    const rolesArr = Array.isArray(role)
      ? role
      : typeof role === "string" && role.length > 0
        ? [role]
        : null;
    if (!rolesArr || rolesArr.length === 0) {
      throw new Error(
        "KmsJwtSigner.signAsync: role (string or non-empty array of strings) is required",
      );
    }
    for (const r of rolesArr) {
      if (typeof r !== "string" || r.length === 0) {
        throw new Error(
          `KmsJwtSigner.signAsync: every entry of role must be a non-empty string (got ${JSON.stringify(r)})`,
        );
      }
    }
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0) {
      throw new Error("KmsJwtSigner.signAsync: expiresInSeconds must be a positive integer");
    }
    if (expiresInSeconds > this.#maxTtlSeconds) {
      throw new Error(
        `KmsJwtSigner.signAsync: expiresInSeconds (${expiresInSeconds}) exceeds maxTtlSeconds (${this.#maxTtlSeconds})`,
      );
    }

    const now = this.#nowSeconds();
    const header = {
      alg: HEADER_ALG,
      typ: HEADER_TYP,
      kid: this.#kid,
    };
    const claims = {
      ...payload,
      iss: issuer,
      aud: audience,
      sub: subject,
      roles: rolesArr,
      iat: now,
      nbf: now,
      exp: now + expiresInSeconds,
      jti: randomUUID(),
    };

    const headerB64 = base64UrlEncode(JSON.stringify(header));
    const claimsB64 = base64UrlEncode(JSON.stringify(claims));
    const input = `${headerB64}.${claimsB64}`;
    const digest = createHash("sha256").update(input).digest();

    // Lazy-import the SDK command — keeps cold-import light for code
    // paths that never construct a KmsJwtSigner (HMAC mode).
    const { SignCommand } = await import("@aws-sdk/client-kms");
    const client = await this.#getClient();
    const { Signature: derSig } = await client.send(
      new SignCommand({
        KeyId: this.#keyId,
        Message: digest,
        // DIGEST: our Message is already a SHA-256 digest, do not
        // re-hash. ECDSA_SHA_256: P-256 + SHA-256 = ES256. Both are
        // enforced by the signer principal's IAM policy condition keys.
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      }),
    );
    if (!derSig) {
      throw new Error("KmsJwtSigner: KMS Sign returned empty Signature");
    }
    const rawSig = jwsRawFromDer(new Uint8Array(derSig));
    return `${input}.${base64UrlEncode(rawSig)}`;
  }

  /**
   * Verify a JWT and return its claims.
   *
   * @param {string} token
   * @param {object} [verifyOpts]                      Per-call overrides for the constructor defaults.
   * @param {string} [verifyOpts.expectedIssuer]
   * @param {string} [verifyOpts.expectedAudience]
   * @param {string[]} [verifyOpts.expectedRoles]
   * @param {number} [verifyOpts.maxTtlSeconds]
   * @param {number} [verifyOpts.clockSkewSeconds]
   * @returns {object}                                 The verified claims object.
   */
  verify(token, verifyOpts = {}) {
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("KmsJwtSigner.verify: token must be a non-empty string");
    }
    const segments = token.split(".");
    if (segments.length !== 3) {
      throw new Error("KmsJwtSigner.verify: malformed token (expected 3 segments)");
    }
    const [headerB64, claimsB64, sigB64] = segments;

    // ---- JOSE header validation -------------------------------------
    let header;
    try {
      header = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
    } catch {
      throw new Error("KmsJwtSigner.verify: invalid header JSON");
    }
    if (!header || typeof header !== "object" || Array.isArray(header)) {
      throw new Error("KmsJwtSigner.verify: header must be a JSON object");
    }
    // Exact-match string comparisons. "ES256" only; anything else
    // (including mixed-case variants like "es256", "ES384", "None",
    // "none", "NONE") fails here BEFORE we touch the signature.
    if (header.alg !== HEADER_ALG) {
      throw new Error(`KmsJwtSigner.verify: unsupported alg "${header.alg}" (expected ${HEADER_ALG})`);
    }
    if (header.typ !== HEADER_TYP) {
      throw new Error(`KmsJwtSigner.verify: unsupported typ "${header.typ}" (expected ${HEADER_TYP})`);
    }
    if (typeof header.kid !== "string") {
      throw new Error("KmsJwtSigner.verify: kid header missing or not a string");
    }
    if (!safeEqualStrings(header.kid, this.#kid, this.#kidBuf)) {
      throw new Error(`KmsJwtSigner.verify: kid "${header.kid}" not in allowlist`);
    }
    for (const forbidden of FORBIDDEN_HEADERS) {
      if (forbidden in header) {
        throw new Error(`KmsJwtSigner.verify: forbidden header "${forbidden}" present`);
      }
    }

    // ---- Signature verification -------------------------------------
    let rawSig;
    try {
      rawSig = base64UrlDecode(sigB64);
    } catch {
      throw new Error("KmsJwtSigner.verify: invalid signature encoding");
    }
    if (rawSig.length !== 64) {
      throw new Error(`KmsJwtSigner.verify: invalid signature length ${rawSig.length} (expected 64)`);
    }
    let derSig;
    try {
      derSig = jwsRawToDer(new Uint8Array(rawSig));
    } catch (err) {
      throw new Error(`KmsJwtSigner.verify: malformed JWS signature: ${err.message}`);
    }
    const verifier = createVerify("SHA256");
    verifier.update(`${headerB64}.${claimsB64}`);
    const sigOk = verifier.verify(this.#publicKey, Buffer.from(derSig));
    if (!sigOk) {
      throw new Error("KmsJwtSigner.verify: signature mismatch");
    }

    // ---- Claims parsing & validation --------------------------------
    let claims;
    try {
      claims = JSON.parse(base64UrlDecode(claimsB64).toString("utf8"));
    } catch {
      throw new Error("KmsJwtSigner.verify: invalid claims JSON");
    }
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
      throw new Error("KmsJwtSigner.verify: claims must be a JSON object");
    }

    const expectedIssuer = verifyOpts.expectedIssuer ?? this.#expectedIssuer;
    const expectedAudience = verifyOpts.expectedAudience ?? this.#expectedAudience;
    const expectedRoles = verifyOpts.expectedRoles
      ? new Set(verifyOpts.expectedRoles)
      : this.#expectedRoles;
    const maxTtl = verifyOpts.maxTtlSeconds ?? this.#maxTtlSeconds;
    const skew = verifyOpts.clockSkewSeconds ?? this.#clockSkewSeconds;

    if (!expectedIssuer) {
      throw new Error("KmsJwtSigner.verify: expectedIssuer not configured (constructor or verify opts)");
    }
    if (!expectedAudience) {
      throw new Error("KmsJwtSigner.verify: expectedAudience not configured (constructor or verify opts)");
    }
    if (!expectedRoles || expectedRoles.size === 0) {
      throw new Error("KmsJwtSigner.verify: expectedRoles not configured (constructor or verify opts)");
    }

    if (claims.iss !== expectedIssuer) {
      throw new Error(`KmsJwtSigner.verify: unexpected iss "${claims.iss}"`);
    }
    if (claims.aud !== expectedAudience) {
      throw new Error(`KmsJwtSigner.verify: unexpected aud "${claims.aud}"`);
    }
    if (typeof claims.sub !== "string" || claims.sub.length === 0) {
      throw new Error("KmsJwtSigner.verify: sub claim missing or empty");
    }
    if (claims.sub !== claims.sub.toLowerCase()) {
      throw new Error("KmsJwtSigner.verify: sub claim must be lowercase");
    }
    // Accept either claims.roles (Stage 2B canonical multi-role shape)
    // or claims.role (legacy single-role tokens minted pre-2B; still
    // need to verify until they expire). Every entry must be in the
    // allowlist — a single bad role rejects the whole token. The
    // dispatcher's verifyEs256 normalizes downstream so middleware sees
    // claims.roles consistently regardless of which path we took here.
    let claimedRoles;
    if (Array.isArray(claims.roles)) {
      claimedRoles = claims.roles;
    } else if (typeof claims.role === "string") {
      claimedRoles = [claims.role];
    } else {
      throw new Error("KmsJwtSigner.verify: roles/role claim missing");
    }
    if (claimedRoles.length === 0) {
      throw new Error("KmsJwtSigner.verify: roles claim is empty");
    }
    for (const r of claimedRoles) {
      if (typeof r !== "string" || !expectedRoles.has(r)) {
        throw new Error(`KmsJwtSigner.verify: role "${r}" not in allowlist`);
      }
    }
    if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) {
      throw new Error("KmsJwtSigner.verify: iat claim missing or not numeric");
    }
    if (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf)) {
      throw new Error("KmsJwtSigner.verify: nbf claim missing or not numeric");
    }
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
      throw new Error("KmsJwtSigner.verify: exp claim missing or not numeric");
    }
    if (claims.exp - claims.iat > maxTtl) {
      throw new Error(
        `KmsJwtSigner.verify: exp - iat (${claims.exp - claims.iat}) exceeds maxTtlSeconds (${maxTtl})`,
      );
    }
    if (claims.exp <= claims.iat) {
      throw new Error("KmsJwtSigner.verify: exp must be greater than iat");
    }

    const now = this.#nowSeconds();
    if (claims.nbf > now + skew) {
      throw new Error("KmsJwtSigner.verify: token not yet valid (nbf in the future)");
    }
    if (claims.exp + skew < now) {
      throw new Error("KmsJwtSigner.verify: token expired");
    }
    if (claims.iat > now + skew) {
      throw new Error("KmsJwtSigner.verify: token issued in the future");
    }

    if (typeof claims.jti !== "string" || !UUID_V4_RE.test(claims.jti)) {
      throw new Error("KmsJwtSigner.verify: jti missing or not a UUIDv4");
    }

    return claims;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

function base64UrlEncode(input) {
  if (input instanceof Uint8Array && !Buffer.isBuffer(input)) {
    return Buffer.from(input).toString("base64url");
  }
  if (Buffer.isBuffer(input)) {
    return input.toString("base64url");
  }
  return Buffer.from(input, "utf8").toString("base64url");
}

function base64UrlDecode(input) {
  if (typeof input !== "string") {
    throw new TypeError("base64UrlDecode: expected a string");
  }
  return Buffer.from(input, "base64url");
}

/**
 * Constant-time string comparison for the kid check. Not strictly
 * required (kid isn't a secret), but using `timingSafeEqual` keeps the
 * comparison primitive consistent with how we'd compare a refresh token
 * hash and removes a length-leak side channel.
 */
function safeEqualStrings(a, expected, expectedBuf) {
  if (typeof a !== "string") return false;
  const aBuf = Buffer.from(a, "utf8");
  if (aBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(aBuf, expectedBuf);
}

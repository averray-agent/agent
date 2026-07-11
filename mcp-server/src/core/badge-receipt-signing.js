import {
  createHash,
  createPublicKey,
  createVerify,
  timingSafeEqual,
} from "node:crypto";

import { ConfigError } from "./errors.js";
import { jwsRawFromDer, jwsRawToDer } from "../auth/jws-ecdsa.js";
import { parseP256Spki } from "../auth/p256-spki.js";

export const BADGE_RECEIPT_JWS_ALG = "ES256";
export const BADGE_RECEIPT_JWS_TYP = "averray-badge-receipt+jws";
export const BADGE_RECEIPT_JWKS_PATH = "/.well-known/badge-receipt-jwks.json";

const FULL_KMS_ARN_RE = /^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9-]+$/u;
const FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/u;

/**
 * RFC 8785 JSON Canonicalization Scheme for the JSON value subset used by
 * badge receipts. Object keys are sorted by UTF-16 code units, arrays retain
 * their order, strings/numbers use JSON.stringify, and no whitespace is
 * emitted. Undefined, non-finite numbers, bigint, functions, and symbols are
 * rejected instead of being silently rewritten.
 */
export function canonicalizeJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalizeJson: numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonicalizeJson: only plain JSON objects are supported");
    }
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const entry = value[key];
        if (entry === undefined || ["bigint", "function", "symbol"].includes(typeof entry)) {
          throw new TypeError(`canonicalizeJson: property ${JSON.stringify(key)} is not a JSON value`);
        }
        return `${JSON.stringify(key)}:${canonicalizeJson(entry)}`;
      });
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`canonicalizeJson: unsupported value type ${typeof value}`);
}

/** Exact UTF-8 payload bytes covered by the detached JWS. */
export function canonicalBadgeReceiptBytes(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new TypeError("canonicalBadgeReceiptBytes: badge document must be an object");
  }
  const { signature: _signature, ...unsignedDocument } = document;
  return Buffer.from(canonicalizeJson(unsignedDocument), "utf8");
}

export function loadBadgeReceiptSigningConfig(env = process.env) {
  const names = [
    "AWS_BADGE_RECEIPT_REGION",
    "AWS_BADGE_RECEIPT_KEY_ID",
    "BADGE_RECEIPT_PUBLIC_KEY_PEM_BASE64",
    "BADGE_RECEIPT_PUBLIC_KEY_FINGERPRINT",
    "BADGE_RECEIPT_KID",
  ];
  const present = names.filter((name) => typeof env[name] === "string" && env[name].trim().length > 0);
  if (present.length === 0) {
    if (env.NODE_ENV === "production") {
      throw new ConfigError(`Badge receipt signing is required in production; missing ${names.join(", ")}.`);
    }
    return null;
  }
  const missing = names.filter((name) => !present.includes(name));
  if (missing.length > 0) {
    throw new ConfigError(`Badge receipt signing configuration is partial; missing ${missing.join(", ")}.`);
  }

  const region = env.AWS_BADGE_RECEIPT_REGION.trim();
  const keyId = env.AWS_BADGE_RECEIPT_KEY_ID.trim();
  const kid = env.BADGE_RECEIPT_KID.trim();
  const publicKeyFingerprint = env.BADGE_RECEIPT_PUBLIC_KEY_FINGERPRINT.trim().toLowerCase();
  if (!FULL_KMS_ARN_RE.test(keyId)) {
    throw new ConfigError("AWS_BADGE_RECEIPT_KEY_ID must be a full KMS key ARN; aliases and bare key ids are forbidden.");
  }
  if (kid !== "badge-1") {
    throw new ConfigError(`BADGE_RECEIPT_KID must be "badge-1" for this key generation (received ${JSON.stringify(kid)}).`);
  }
  if (!FINGERPRINT_RE.test(publicKeyFingerprint)) {
    throw new ConfigError("BADGE_RECEIPT_PUBLIC_KEY_FINGERPRINT must use sha256:<64 lowercase hex> over SPKI DER bytes.");
  }

  let publicKeyPem;
  try {
    publicKeyPem = Buffer.from(env.BADGE_RECEIPT_PUBLIC_KEY_PEM_BASE64.trim(), "base64").toString("utf8");
  } catch (error) {
    throw new ConfigError(`BADGE_RECEIPT_PUBLIC_KEY_PEM_BASE64 could not be decoded: ${error?.message ?? error}`);
  }
  if (!publicKeyPem.includes("-----BEGIN PUBLIC KEY-----") || !publicKeyPem.includes("-----END PUBLIC KEY-----")) {
    throw new ConfigError("BADGE_RECEIPT_PUBLIC_KEY_PEM_BASE64 must contain base64 of a PEM SubjectPublicKeyInfo public key.");
  }
  return { region, keyId, kid, publicKeyPem, publicKeyFingerprint };
}

export class KmsBadgeReceiptSigner {
  #config;
  #kmsClient;
  #credentialsProvider;
  #publicKey;
  #publicKeyDer;
  #jwks;
  #now;
  #initialized = false;

  constructor(config, { kmsClient, credentialsProvider, now } = {}) {
    if (!config) throw new ConfigError("KmsBadgeReceiptSigner requires configuration");
    if (!FULL_KMS_ARN_RE.test(config.keyId ?? "")) {
      throw new ConfigError("KmsBadgeReceiptSigner keyId must be a full KMS key ARN, never an alias.");
    }
    if (!FINGERPRINT_RE.test(config.publicKeyFingerprint ?? "")) {
      throw new ConfigError("KmsBadgeReceiptSigner fingerprint must use sha256:<64 lowercase hex>.");
    }
    const publicKey = createPublicKey({ key: config.publicKeyPem, format: "pem" });
    const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
    parseP256Spki(new Uint8Array(publicKeyDer));
    this.#config = { ...config };
    this.#kmsClient = kmsClient ?? null;
    this.#credentialsProvider = credentialsProvider ?? null;
    this.#publicKey = publicKey;
    this.#publicKeyDer = Buffer.from(publicKeyDer);
    this.#now = typeof now === "function" ? now : () => new Date();
  }

  async #client() {
    if (this.#kmsClient) return this.#kmsClient;
    const { KMSClient } = await import("@aws-sdk/client-kms");
    this.#kmsClient = new KMSClient({
      region: this.#config.region,
      ...(this.#credentialsProvider ? { credentials: this.#credentialsProvider } : {}),
    });
    return this.#kmsClient;
  }

  async initialize() {
    const { GetPublicKeyCommand } = await import("@aws-sdk/client-kms");
    const response = await (await this.#client()).send(new GetPublicKeyCommand({ KeyId: this.#config.keyId }));
    if (!response?.PublicKey) throw new ConfigError("Badge receipt KMS GetPublicKey returned no public key; refusing startup.");
    if (response.KeyId && response.KeyId !== this.#config.keyId) {
      throw new ConfigError(`Badge receipt KMS resolved ${response.KeyId}, expected pinned ARN ${this.#config.keyId}; refusing startup.`);
    }
    if (response.KeySpec && response.KeySpec !== "ECC_NIST_P256") {
      throw new ConfigError(`Badge receipt KMS KeySpec is ${response.KeySpec}, expected ECC_NIST_P256; refusing startup.`);
    }
    if (response.KeyUsage && response.KeyUsage !== "SIGN_VERIFY") {
      throw new ConfigError(`Badge receipt KMS KeyUsage is ${response.KeyUsage}, expected SIGN_VERIFY; refusing startup.`);
    }
    if (Array.isArray(response.SigningAlgorithms) && !response.SigningAlgorithms.includes("ECDSA_SHA_256")) {
      throw new ConfigError("Badge receipt KMS key does not support ECDSA_SHA_256; refusing startup.");
    }

    const kmsDer = Buffer.from(response.PublicKey);
    parseP256Spki(new Uint8Array(kmsDer));
    const actualFingerprint = `sha256:${createHash("sha256").update(kmsDer).digest("hex")}`;
    if (!safeEqual(actualFingerprint, this.#config.publicKeyFingerprint)) {
      throw new ConfigError(
        `Badge receipt public-key fingerprint mismatch: KMS returned ${actualFingerprint}, ` +
        `but BADGE_RECEIPT_PUBLIC_KEY_FINGERPRINT is ${this.#config.publicKeyFingerprint}. Refusing startup.`,
      );
    }
    if (!timingSafeEqualSameLength(kmsDer, this.#publicKeyDer)) {
      throw new ConfigError("Badge receipt pinned public-key PEM does not match kms:GetPublicKey; refusing startup.");
    }

    const jwk = this.#publicKey.export({ format: "jwk" });
    this.#jwks = {
      keys: [{ ...jwk, use: "sig", alg: BADGE_RECEIPT_JWS_ALG, kid: this.#config.kid }],
    };
    this.#initialized = true;
    return { keyId: this.#config.keyId, fingerprint: actualFingerprint, jwks: this.getJwks() };
  }

  getJwks() {
    if (!this.#initialized) throw new Error("KmsBadgeReceiptSigner is not initialized");
    return structuredClone(this.#jwks);
  }

  verifyDocument(document) {
    if (!this.#initialized) throw new Error("KmsBadgeReceiptSigner is not initialized");
    const jwk = this.#jwks.keys.find((key) => key.kid === document?.signature?.kid);
    return Boolean(jwk) && verifyBadgeReceiptSignature(document, jwk);
  }

  async signDocument(document) {
    if (!this.#initialized) throw new Error("KmsBadgeReceiptSigner is not initialized");
    const signedAt = this.#now().toISOString();
    const protectedHeader = {
      alg: BADGE_RECEIPT_JWS_ALG,
      kid: this.#config.kid,
      signedAt,
      typ: BADGE_RECEIPT_JWS_TYP,
    };
    const protectedB64 = Buffer.from(canonicalizeJson(protectedHeader), "utf8").toString("base64url");
    const payloadB64 = canonicalBadgeReceiptBytes(document).toString("base64url");
    const signingInput = `${protectedB64}.${payloadB64}`;
    const digest = createHash("sha256").update(signingInput, "utf8").digest();
    const { SignCommand } = await import("@aws-sdk/client-kms");
    const response = await (await this.#client()).send(new SignCommand({
      KeyId: this.#config.keyId,
      Message: digest,
      MessageType: "DIGEST",
      SigningAlgorithm: "ECDSA_SHA_256",
    }));
    if (!response?.Signature) throw new Error("Badge receipt KMS Sign returned no signature");
    const rawSignature = jwsRawFromDer(new Uint8Array(response.Signature));
    return {
      alg: BADGE_RECEIPT_JWS_ALG,
      kid: this.#config.kid,
      sig: `${protectedB64}..${Buffer.from(rawSignature).toString("base64url")}`,
      signedAt,
    };
  }
}

export function verifyBadgeReceiptSignature(document, jwk) {
  const signature = document?.signature;
  if (!signature || typeof signature.sig !== "string") return false;
  const segments = signature.sig.split(".");
  if (segments.length !== 3 || segments[1] !== "") return false;
  let protectedHeader;
  try {
    protectedHeader = JSON.parse(Buffer.from(segments[0], "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (
    protectedHeader.alg !== BADGE_RECEIPT_JWS_ALG
    || protectedHeader.typ !== BADGE_RECEIPT_JWS_TYP
    || protectedHeader.kid !== signature.kid
    || protectedHeader.signedAt !== signature.signedAt
    || signature.alg !== BADGE_RECEIPT_JWS_ALG
    || jwk?.kid !== signature.kid
    || jwk?.alg !== BADGE_RECEIPT_JWS_ALG
  ) return false;
  try {
    const payloadB64 = canonicalBadgeReceiptBytes(document).toString("base64url");
    const verifier = createVerify("SHA256");
    verifier.update(`${segments[0]}.${payloadB64}`, "utf8");
    verifier.end();
    const raw = Buffer.from(segments[2], "base64url");
    return verifier.verify(createPublicKey({ key: jwk, format: "jwk" }), jwsRawToDer(new Uint8Array(raw)));
  } catch {
    return false;
  }
}

function safeEqual(left, right) {
  return timingSafeEqualSameLength(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function timingSafeEqualSameLength(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

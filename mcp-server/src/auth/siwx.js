import { randomBytes } from "node:crypto";

import { getAddress, isAddress, verifyMessage } from "ethers";

import { AuthenticationError, ConfigError, ValidationError } from "../core/errors.js";

const SIWX_HEADER = "sign-in-with-x";
const EIP191_TYPE = "eip191";
const DEFAULT_STATEMENT = "Sign in to post an escrow-funded job on Averray.";

export class SiwxAuthAdapter {
  constructor({
    stateStore,
    publicOrigin,
    chainId,
    nonceTtlSeconds = 300,
    now = () => new Date(),
    randomBytesImpl = randomBytes
  } = {}) {
    if (!stateStore?.storeNonce || !stateStore?.consumeNonce) {
      throw new ConfigError("SIWX authentication requires one-time nonce storage.");
    }
    this.stateStore = stateStore;
    this.publicOrigin = normalizePublicOrigin(publicOrigin);
    this.chainId = normalizeCaipEvmChainId(chainId);
    this.nonceTtlSeconds = positiveInteger(nonceTtlSeconds, "SIWX nonce TTL");
    this.now = now;
    this.randomBytes = randomBytesImpl;
  }

  async issueChallenge({ resourcePath, requestBinding, statement = DEFAULT_STATEMENT } = {}) {
    const resourceUrl = this.resourceUrl(resourcePath);
    const issuedAtDate = this.currentTime();
    const expirationTime = new Date(
      issuedAtDate.getTime() + (this.nonceTtlSeconds * 1000)
    ).toISOString();
    const nonce = this.randomBytes(16).toString("hex");
    const binding = normalizeRequestBinding(requestBinding);
    const info = {
      domain: this.publicOrigin.host,
      uri: resourceUrl,
      version: "1",
      nonce,
      issuedAt: issuedAtDate.toISOString(),
      expirationTime,
      statement,
      resources: [resourceUrl]
    };
    const stored = await this.stateStore.storeNonce(
      nonce,
      JSON.stringify({
        kind: "siwx_eip4361_v1",
        binding,
        proof: challengeProofFields({
          ...info,
          chainId: this.chainId,
          type: EIP191_TYPE
        })
      }),
      this.nonceTtlSeconds
    );
    if (stored === false) {
      throw new AuthenticationError(
        "The sign-in challenge collided with an existing nonce. Request a fresh 402 response and retry.",
        "siwx_nonce_collision",
        { action: "retry_for_fresh_challenge" }
      );
    }
    return {
      info,
      supportedChains: [{ chainId: this.chainId, type: EIP191_TYPE }],
      schema: siwxSchema()
    };
  }

  async verifyHeader(headerValue, { resourcePath, requestBinding } = {}) {
    const proof = decodeSiwxHeader(headerValue);
    const expectedResource = this.resourceUrl(resourcePath);
    validateSiwxProof(proof, {
      expectedOrigin: this.publicOrigin,
      expectedResource,
      expectedChainId: this.chainId,
      now: this.currentTime(),
      maxAgeSeconds: this.nonceTtlSeconds
    });

    const message = buildSiwxEip4361Message(proof);
    let recovered;
    try {
      recovered = verifyMessage(message, proof.signature);
    } catch {
      throw new AuthenticationError(
        "SIGN-IN-WITH-X signature verification failed. Sign the challenge exactly as issued and retry with a fresh 402 response.",
        "invalid_siwx_signature",
        { action: "retry_for_fresh_challenge" }
      );
    }
    if (getAddress(recovered) !== getAddress(proof.address)) {
      throw new AuthenticationError(
        "SIGN-IN-WITH-X was signed by a different wallet. Sign with the address named in the header and retry with a fresh challenge.",
        "invalid_siwx_signature",
        { action: "sign_with_declared_wallet" }
      );
    }

    const storedChallenge = await this.stateStore.consumeNonce(proof.nonce);
    if (!storedChallenge) {
      throw new AuthenticationError(
        "SIGN-IN-WITH-X nonce is missing, expired, or already used. Request a fresh 402 response and sign its new challenge.",
        "invalid_siwx_nonce",
        { action: "retry_for_fresh_challenge" }
      );
    }
    const expectedBinding = normalizeRequestBinding(requestBinding);
    const nonceRecord = parseNonceRecord(storedChallenge);
    if (nonceRecord?.kind !== "siwx_eip4361_v1" || nonceRecord.binding !== expectedBinding) {
      throw new AuthenticationError(
        "SIGN-IN-WITH-X challenge belongs to different job content. Request a fresh 402 response for this exact body and sign that challenge.",
        "invalid_siwx_nonce_binding",
        { action: "retry_with_unchanged_body" }
      );
    }
    if (JSON.stringify(nonceRecord.proof) !== JSON.stringify(challengeProofFields(proof))) {
      throw new AuthenticationError(
        "SIGN-IN-WITH-X changed fields from the issued EIP-4361 challenge. Request a fresh 402 response and sign the message exactly as issued.",
        "invalid_siwx_challenge_mutated",
        { action: "retry_with_exact_challenge" }
      );
    }

    return {
      wallet: getAddress(recovered).toLowerCase(),
      chainId: proof.chainId,
      authenticatedAt: this.currentTime().toISOString()
    };
  }

  resourceUrl(resourcePath) {
    const path = String(resourcePath ?? "").trim();
    if (!path.startsWith("/")) {
      throw new ConfigError("SIWX resource path must start with '/'.");
    }
    return new URL(path, this.publicOrigin).toString();
  }

  currentTime() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new ConfigError("SIWX clock returned an invalid date.");
    }
    return date;
  }
}

function parseNonceRecord(value) {
  try {
    const record = JSON.parse(String(value));
    return record && typeof record === "object" ? record : undefined;
  } catch {
    return undefined;
  }
}

function challengeProofFields(proof) {
  return {
    domain: String(proof?.domain ?? ""),
    statement: String(proof?.statement ?? ""),
    uri: String(proof?.uri ?? ""),
    version: String(proof?.version ?? ""),
    chainId: String(proof?.chainId ?? ""),
    type: String(proof?.type ?? ""),
    nonce: String(proof?.nonce ?? ""),
    issuedAt: String(proof?.issuedAt ?? ""),
    expirationTime: String(proof?.expirationTime ?? ""),
    notBefore: String(proof?.notBefore ?? ""),
    requestId: String(proof?.requestId ?? ""),
    resources: Array.isArray(proof?.resources)
      ? proof.resources.map((resource) => String(resource))
      : []
  };
}

export function decodeSiwxHeader(value) {
  const encoded = String(value ?? "").trim();
  if (!encoded) {
    throw new AuthenticationError(
      "SIGN-IN-WITH-X is required. Request a 402 response, sign its challenge, and retry with the header.",
      "siwx_header_required",
      { header: "SIGN-IN-WITH-X", action: "sign_402_challenge" }
    );
  }
  let decoded;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed;
  } catch {
    throw new ValidationError(
      "SIGN-IN-WITH-X must be base64-encoded JSON from the x402 sign-in challenge.",
      { header: SIWX_HEADER, action: "rebuild_header_from_challenge" }
    );
  }
}

export function buildSiwxEip4361Message(proof) {
  const chainId = normalizeCaipEvmChainId(proof?.chainId).split(":")[1];
  const lines = [
    `${proof.domain} wants you to sign in with your Ethereum account:`,
    getAddress(proof.address),
    "",
    ...(proof.statement ? [String(proof.statement), ""] : []),
    `URI: ${proof.uri}`,
    "Version: 1",
    `Chain ID: ${chainId}`,
    `Nonce: ${proof.nonce}`,
    `Issued At: ${proof.issuedAt}`
  ];
  if (proof.expirationTime) lines.push(`Expiration Time: ${proof.expirationTime}`);
  if (proof.notBefore) lines.push(`Not Before: ${proof.notBefore}`);
  if (proof.requestId) lines.push(`Request ID: ${proof.requestId}`);
  if (Array.isArray(proof.resources) && proof.resources.length > 0) {
    lines.push("Resources:", ...proof.resources.map((resource) => `- ${resource}`));
  }
  return lines.join("\n");
}

function validateSiwxProof(proof, {
  expectedOrigin,
  expectedResource,
  expectedChainId,
  now,
  maxAgeSeconds
}) {
  if (proof.version !== "1" || proof.type !== EIP191_TYPE) {
    throw new AuthenticationError(
      "SIGN-IN-WITH-X must use EIP-4361 version 1 with eip191 signing. Request a fresh compatible challenge.",
      "invalid_siwx_type",
      { action: "use_eip191_challenge" }
    );
  }
  if (!isAddress(String(proof.address ?? ""))) {
    throw new ValidationError("SIGN-IN-WITH-X address must be a 20-byte EVM address.");
  }
  if (String(proof.domain ?? "") !== expectedOrigin.host) {
    throw new AuthenticationError(
      "SIGN-IN-WITH-X domain does not match this service. Request a challenge directly from the configured Averray origin.",
      "invalid_siwx_domain_mismatch",
      { expectedDomain: expectedOrigin.host, action: "request_challenge_from_expected_origin" }
    );
  }
  let uri;
  try {
    uri = new URL(String(proof.uri ?? ""));
  } catch {
    throw new AuthenticationError(
      "SIGN-IN-WITH-X URI is invalid. Request a fresh challenge and sign it unchanged.",
      "invalid_siwx_uri_mismatch",
      { action: "retry_for_fresh_challenge" }
    );
  }
  if (uri.origin !== expectedOrigin.origin || uri.toString() !== expectedResource) {
    throw new AuthenticationError(
      "SIGN-IN-WITH-X URI does not match the x402 posting endpoint. Request a challenge for this endpoint and sign it unchanged.",
      "invalid_siwx_uri_mismatch",
      { expectedUri: expectedResource, action: "retry_for_fresh_challenge" }
    );
  }
  if (normalizeCaipEvmChainId(proof.chainId) !== expectedChainId) {
    throw new AuthenticationError(
      "SIGN-IN-WITH-X chain is not supported for this payment route. Sign the advertised chain challenge and retry.",
      "invalid_siwx_chain_id",
      { expectedChainId, action: "use_advertised_chain" }
    );
  }
  const issuedAt = parseTimestamp(proof.issuedAt, "invalid_siwx_issued_at", "issuedAt");
  const ageMs = now.getTime() - issuedAt;
  if (ageMs < -60_000) {
    throw new AuthenticationError(
      "SIGN-IN-WITH-X was issued in the future. Check the signing clock and request a fresh challenge.",
      "invalid_siwx_issued_at_in_future",
      { action: "correct_clock_and_retry" }
    );
  }
  if (ageMs > maxAgeSeconds * 1000) {
    throw new AuthenticationError(
      "SIGN-IN-WITH-X challenge is too old. Request a fresh 402 response and sign its new challenge.",
      "invalid_siwx_issued_at_too_old",
      { action: "retry_for_fresh_challenge" }
    );
  }
  if (proof.expirationTime) {
    const expiresAt = parseTimestamp(
      proof.expirationTime,
      "invalid_siwx_expiration_time",
      "expirationTime"
    );
    if (expiresAt <= now.getTime()) {
      throw new AuthenticationError(
        "SIGN-IN-WITH-X challenge expired. Request a fresh 402 response and sign its new challenge.",
        "invalid_siwx_expired",
        { action: "retry_for_fresh_challenge" }
      );
    }
  }
  if (proof.notBefore) {
    const notBefore = parseTimestamp(proof.notBefore, "invalid_siwx_not_before", "notBefore");
    if (notBefore > now.getTime()) {
      throw new AuthenticationError(
        "SIGN-IN-WITH-X challenge is not valid yet. Wait until notBefore or request a fresh challenge.",
        "invalid_siwx_not_yet_valid",
        { action: "wait_or_retry" }
      );
    }
  }
  if (!/^[a-f0-9]{32}$/u.test(String(proof.nonce ?? ""))) {
    throw new AuthenticationError(
      "SIGN-IN-WITH-X nonce is malformed. Request a fresh challenge and sign it unchanged.",
      "invalid_siwx_nonce",
      { action: "retry_for_fresh_challenge" }
    );
  }
  if (!Array.isArray(proof.resources) || !proof.resources.includes(expectedResource)) {
    throw new AuthenticationError(
      "SIGN-IN-WITH-X resources do not include this posting endpoint. Request and sign a fresh challenge.",
      "invalid_siwx_resource",
      { expectedResource, action: "retry_for_fresh_challenge" }
    );
  }
  if (!/^0x[a-fA-F0-9]{130}$/u.test(String(proof.signature ?? ""))) {
    throw new AuthenticationError(
      "SIGN-IN-WITH-X signature must be a 65-byte EIP-191 hex signature.",
      "invalid_siwx_signature",
      { action: "sign_with_personal_sign" }
    );
  }
}

function parseTimestamp(value, code, field) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new AuthenticationError(
      `SIGN-IN-WITH-X ${field} is not a valid timestamp. Request a fresh challenge and sign it unchanged.`,
      code,
      { action: "retry_for_fresh_challenge" }
    );
  }
  return parsed;
}

function normalizePublicOrigin(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new ConfigError("X402_PUBLIC_ORIGIN must be an absolute http(s) URL.");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
    throw new ConfigError("X402_PUBLIC_ORIGIN must be an absolute http(s) origin without credentials.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new ConfigError("X402_PUBLIC_ORIGIN must contain only scheme, host, and optional port.");
  }
  return url;
}

function normalizeCaipEvmChainId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^eip155:[1-9]\d*$/u.test(normalized)) {
    throw new ConfigError("SIWX chainId must be a CAIP-2 EVM identifier such as eip155:8453.");
  }
  return normalized;
}

function normalizeRequestBinding(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/u.test(normalized)) {
    throw new ValidationError("SIWX request binding must be a 32-byte content hash.");
  }
  return normalized;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${label} must be a positive integer.`);
  }
  return parsed;
}

function siwxSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      domain: { type: "string" },
      address: { type: "string" },
      statement: { type: "string" },
      uri: { type: "string", format: "uri" },
      version: { type: "string" },
      chainId: { type: "string" },
      type: { type: "string" },
      nonce: { type: "string" },
      issuedAt: { type: "string", format: "date-time" },
      expirationTime: { type: "string", format: "date-time" },
      notBefore: { type: "string", format: "date-time" },
      requestId: { type: "string" },
      resources: { type: "array", items: { type: "string", format: "uri" } },
      signature: { type: "string" }
    },
    required: [
      "domain",
      "address",
      "uri",
      "version",
      "chainId",
      "type",
      "nonce",
      "issuedAt",
      "signature"
    ]
  };
}

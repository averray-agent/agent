import { createRequire } from "node:module";

import { getAddress, verifyMessage } from "ethers";
import { AuthenticationError, ValidationError } from "../core/errors.js";
import { parseWalletIdentity } from "../core/wallet-identity.js";

const requireModule = createRequire(import.meta.url);
let substrateSignatureVerify;

/**
 * Sign-in with Ethereum (EIP-4361) — minimal spec-compliant implementation.
 *
 * Expected message format:
 *
 *   <domain> wants you to sign in with your Ethereum account:
 *   <address>
 *
 *   <statement>
 *
 *   URI: <uri>
 *   Version: 1
 *   Chain ID: <chainId>
 *   Nonce: <nonce>
 *   Issued At: <issuedAt-ISO8601>
 *   [Expiration Time: <expirationTime-ISO8601>]
 *   [Not Before: <notBefore-ISO8601>]
 *   [Request ID: <id>]
 *   [Resources:\n- <resource>\n- <resource>]
 *
 * Only fields we need for this platform are parsed; extras are tolerated.
 */

export function buildSiweMessage({ domain, address, statement, uri, chainId, nonce, issuedAt, expirationTime }) {
  const lines = [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    "",
    statement,
    "",
    `URI: ${uri}`,
    "Version: 1",
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`
  ];
  if (expirationTime) {
    lines.push(`Expiration Time: ${expirationTime}`);
  }
  return lines.join("\n");
}

export function parseSiweMessage(message) {
  if (typeof message !== "string" || message.length === 0) {
    throw new ValidationError("SIWE message must be a non-empty string.");
  }

  const lines = message.split("\n");
  if (lines.length < 8) {
    throw new ValidationError("SIWE message is too short to be valid.");
  }

  const header = lines[0];
  const headerMatch = header.match(/^(?<domain>\S+) wants you to sign in with your Ethereum account:$/u);
  if (!headerMatch?.groups?.domain) {
    throw new ValidationError("SIWE message header is malformed.");
  }

  const addressInput = lines[1]?.trim();
  let address;
  if (addressInput && /^0x[a-fA-F0-9]{40}$/u.test(addressInput)) {
    // Preserve the pre-SIWS EVM behavior exactly, including ethers rejecting
    // an invalid mixed-case EIP-55 checksum. parseWalletIdentity deliberately
    // canonicalizes H160 input for store keys, so using it here would widen
    // the existing sign-in acceptance boundary.
    address = getAddress(addressInput);
  } else {
    try {
      const walletIdentity = parseWalletIdentity(addressInput);
      if (walletIdentity.source !== "ss58") throw new Error("identity_shape");
      address = walletIdentity.ss58;
    } catch {
      throw new ValidationError("SIWE address line is missing or malformed.");
    }
  }

  if (lines[2] !== "") {
    throw new ValidationError("SIWE message missing blank line after address.");
  }

  let index = 3;
  let statement;
  if (lines[index] !== "" && !lines[index].startsWith("URI:")) {
    statement = lines[index];
    index += 1;
    if (lines[index] !== "") {
      throw new ValidationError("SIWE message missing blank line after statement.");
    }
    index += 1;
  } else if (lines[index] === "") {
    index += 1;
  }

  const fields = {};
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "") {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    fields[key] = value;
  }

  const required = ["URI", "Version", "Chain ID", "Nonce", "Issued At"];
  for (const key of required) {
    if (!fields[key]) {
      throw new ValidationError(`SIWE message missing required field: ${key}.`);
    }
  }

  if (fields.Version !== "1") {
    throw new ValidationError(`SIWE version must be "1", got: ${fields.Version}.`);
  }

  const chainId = Number(fields["Chain ID"]);
  if (!Number.isInteger(chainId) || chainId < 0) {
    throw new ValidationError(`SIWE Chain ID must be a non-negative integer, got: ${fields["Chain ID"]}.`);
  }

  return {
    domain: headerMatch.groups.domain,
    address,
    statement,
    uri: fields.URI,
    version: fields.Version,
    chainId,
    nonce: fields.Nonce,
    issuedAt: fields["Issued At"],
    expirationTime: fields["Expiration Time"],
    notBefore: fields["Not Before"],
    requestId: fields["Request ID"]
  };
}

/**
 * Verify a signed SIWE message against expected server configuration.
 *
 * Throws AuthenticationError with a specific code on any mismatch. On success,
 * returns the parsed fields + the recovered wallet identity. EVM addresses
 * retain their checksummed return shape; SS58 identities retain their exact,
 * case-sensitive representation.
 */
export function verifySiweMessage(message, signature, { expectedDomain, expectedChainId }) {
  const parsed = parseSiweMessage(message);

  if (expectedDomain && parsed.domain !== expectedDomain) {
    throw new AuthenticationError(
      `SIWE domain mismatch: expected ${expectedDomain}, got ${parsed.domain}.`,
      "siwe_domain_mismatch"
    );
  }

  if (expectedChainId !== undefined && Number(parsed.chainId) !== Number(expectedChainId)) {
    throw new AuthenticationError(
      `SIWE chain id mismatch: expected ${expectedChainId}, got ${parsed.chainId}.`,
      "siwe_chain_mismatch"
    );
  }

  const now = Date.now();
  if (parsed.expirationTime) {
    const expires = Date.parse(parsed.expirationTime);
    if (Number.isFinite(expires) && expires < now) {
      throw new AuthenticationError("SIWE message expired.", "siwe_expired");
    }
  }
  if (parsed.notBefore) {
    const notBefore = Date.parse(parsed.notBefore);
    if (Number.isFinite(notBefore) && notBefore > now + 60_000) {
      throw new AuthenticationError("SIWE message is not yet valid.", "siwe_not_before");
    }
  }
  const issuedAt = Date.parse(parsed.issuedAt);
  if (!Number.isFinite(issuedAt)) {
    throw new AuthenticationError("SIWE Issued At is not a valid date.", "siwe_bad_issued_at");
  }
  if (issuedAt > now + 60_000) {
    throw new AuthenticationError("SIWE message issued in the future.", "siwe_iat_future");
  }

  const identity = parseWalletIdentity(parsed.address);
  if (identity.source === "ss58") {
    let verification;
    try {
      verification = getSubstrateSignatureVerify()(message, signature, identity.ss58);
    } catch {
      throw new AuthenticationError(
        "SIWE signature does not match address.",
        "siwe_signature_mismatch"
      );
    }
    if (
      verification?.isValid !== true
      || !["sr25519", "ed25519"].includes(verification.crypto)
    ) {
      throw new AuthenticationError(
        "SIWE signature does not match address.",
        "siwe_signature_mismatch"
      );
    }
    return {
      ...parsed,
      recoveredAddress: identity.ss58,
      walletIdentity: identity
    };
  }

  // Keep the existing EIP-191 seam byte-for-byte: only an SS58 identity can
  // select the Substrate verifier above, and callers cannot supply a scheme.
  let recovered;
  try {
    recovered = verifyMessage(message, signature);
  } catch (error) {
    throw new AuthenticationError(
      `SIWE signature recovery failed: ${error?.message ?? "unknown_error"}`,
      "siwe_recover_failed"
    );
  }

  if (getAddress(recovered) !== parsed.address) {
    throw new AuthenticationError("SIWE signature does not match address.", "siwe_signature_mismatch");
  }

  return {
    ...parsed,
    recoveredAddress: getAddress(recovered)
  };
}

function getSubstrateSignatureVerify() {
  // Server startup and the existing EVM sign-in path must not pay the cost of
  // loading the Substrate crypto bundle. The package's exported CJS subpath is
  // loaded synchronously only after the signed message identifies an SS58
  // account, preserving verifySiweMessage's existing synchronous contract.
  substrateSignatureVerify ??= requireModule(
    "@polkadot/util-crypto/signature/verify"
  ).signatureVerify;
  return substrateSignatureVerify;
}

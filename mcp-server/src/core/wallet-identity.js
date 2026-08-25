import { createHash } from "node:crypto";

import { base58 } from "@scure/base";
import { getAddress, getBytes, hexlify, keccak256 } from "ethers";

import { ValidationError } from "./errors.js";

export const INVALID_WALLET_IDENTITY_REASON = "invalid_wallet_identity";

const H160_RE = /^0x[0-9a-fA-F]{40}$/u;
const SS58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/u;
const SS58_HASH_PREFIX = Buffer.from("SS58PRE");
const EVM_ACCOUNT_SUFFIX = new Uint8Array(12).fill(0xee);

/**
 * Derive the EVM lens for a Substrate AccountId32.
 *
 * pallet_revive has two branches: EVM-derived accounts retain their first
 * twenty bytes and end in twelve 0xEE bytes; native accounts hash the full
 * AccountId32 and use the final twenty bytes. Collapsing these branches can
 * return a valid-looking address that the account owner does not control.
 */
export function deriveH160FromSs58(ss58) {
  const accountId = decodeSs58AccountId32(ss58);
  return deriveH160FromAccountId32(accountId);
}

/**
 * Shared branch implementation for callers that already hold AccountId32.
 * SS58 parsing delegates here; no consumer may reimplement pallet_revive's
 * EVM-derived/native split.
 */
export function deriveH160FromAccountId32(value) {
  let accountId;
  try {
    accountId = value instanceof Uint8Array ? value : getBytes(value);
  } catch {
    throw invalidWalletIdentity("account_id32_shape");
  }
  if (accountId.length !== 32) {
    throw invalidWalletIdentity("account_id32_shape");
  }
  const h160 = isEvmDerivedAccountId(accountId)
    ? hexlify(accountId.subarray(0, 20))
    : `0x${keccak256(accountId).slice(-40)}`;
  return getAddress(h160.toLowerCase());
}

/**
 * The locally-computable H160 -> AccountId32 direction used by Asset Hub:
 * append twelve 0xEE bytes and encode the result with SS58 prefix 0.
 */
export function h160ToSs58(h160) {
  if (typeof h160 !== "string" || !H160_RE.test(h160)) {
    throw invalidWalletIdentity("h160_shape");
  }
  const evm = getBytes(getAddress(h160.toLowerCase()));
  const accountId = new Uint8Array(32);
  accountId.set(evm);
  accountId.set(EVM_ACCOUNT_SUFFIX, 20);
  const payload = new Uint8Array(33);
  payload.set(accountId, 1);
  const checksum = ss58Checksum(payload);
  const encoded = new Uint8Array(35);
  encoded.set(payload);
  encoded.set(checksum.subarray(0, 2), payload.length);
  return base58.encode(encoded);
}

/**
 * Parse either public wallet form without inventing the missing direction.
 * H160 is canonicalized for storage; SS58 is preserved byte-for-byte only
 * when the caller supplied it.
 */
export function parseWalletIdentity(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidWalletIdentity("missing_or_non_string");
  }
  if (H160_RE.test(value)) {
    return {
      h160: getAddress(value.toLowerCase()).toLowerCase(),
      source: "h160"
    };
  }
  if (!SS58_RE.test(value)) {
    throw invalidWalletIdentity("unsupported_shape");
  }
  return {
    h160: deriveH160FromSs58(value).toLowerCase(),
    ss58: value,
    source: "ss58"
  };
}

function decodeSs58AccountId32(value) {
  if (typeof value !== "string" || !SS58_RE.test(value)) {
    throw invalidWalletIdentity("ss58_shape");
  }
  let decoded;
  try {
    decoded = base58.decode(value);
  } catch {
    throw invalidWalletIdentity("ss58_base58");
  }
  const prefixLength = decodeSs58PrefixLength(decoded);
  const payloadLength = prefixLength + 32;
  if (decoded.length !== payloadLength + 2) {
    throw invalidWalletIdentity("ss58_account_id32_length");
  }
  const payload = decoded.subarray(0, payloadLength);
  const checksum = ss58Checksum(payload);
  if (decoded[payloadLength] !== checksum[0] || decoded[payloadLength + 1] !== checksum[1]) {
    throw invalidWalletIdentity("ss58_checksum");
  }
  return decoded.subarray(prefixLength, payloadLength);
}

function decodeSs58PrefixLength(decoded) {
  const first = decoded[0];
  if (first === undefined || first >= 128) {
    throw invalidWalletIdentity("ss58_prefix");
  }
  if (first < 64) return 1;
  const second = decoded[1];
  if (second === undefined) {
    throw invalidWalletIdentity("ss58_prefix");
  }
  const network = ((first & 0x3f) << 2) | (second >> 6) | ((second & 0x3f) << 8);
  if (network < 64 || network > 16_383) {
    throw invalidWalletIdentity("ss58_prefix");
  }
  return 2;
}

function ss58Checksum(payload) {
  return createHash("blake2b512")
    .update(SS58_HASH_PREFIX)
    .update(payload)
    .digest();
}

function isEvmDerivedAccountId(accountId) {
  return EVM_ACCOUNT_SUFFIX.every((byte, index) => accountId[index + 20] === byte);
}

function invalidWalletIdentity(cause) {
  const error = new ValidationError(
    "wallet identity must be a 0x-prefixed 20-byte H160 or a valid SS58 AccountId32.",
    { reason: INVALID_WALLET_IDENTITY_REASON, cause }
  );
  error.code = INVALID_WALLET_IDENTITY_REASON;
  return error;
}

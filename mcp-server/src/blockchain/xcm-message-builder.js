import { ValidationError } from "../core/errors.js";

export const XCM_VERSION_V5 = 0x05;
export const XCM_SET_TOPIC_INSTRUCTION = 0x2c;

const HEX_RE = /^0x[a-fA-F0-9]*$/u;
const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/u;
const PARACHAIN_RE = /Parachain\((\d+)\)/iu;

const BIFROST_VDOT_DEPOSIT_XCM_V5_PREFIX =
  "0x0510000401000003008c86471301000003008c8647000d010101000000010100368e8759910dab756d344995f1d3c79374ca8f70066d3a709e48029f6bf0ee7e";
const BIFROST_VDOT_WITHDRAW_XCM_V5_PREFIX = "0x050c00010203040506070809";

export function buildXcmRequestPayload({ strategy, direction, requestId }) {
  const normalizedDirection = normalizeDirection(direction);
  const kind = String(strategy?.kind ?? "").trim().toLowerCase();
  if (kind !== "polkadot_vdot") {
    throw new ValidationError(`Unsupported async XCM strategy kind "${strategy?.kind ?? "unknown"}".`);
  }

  const destinationParaId = resolveDestinationParachainId(strategy);
  const messagePrefix = normalizedDirection === "deposit"
    ? BIFROST_VDOT_DEPOSIT_XCM_V5_PREFIX
    : BIFROST_VDOT_WITHDRAW_XCM_V5_PREFIX;

  return {
    destination: encodeVersionedParachainLocation(destinationParaId),
    message: appendSetTopic(messagePrefix, requestId),
    maxWeight: { refTime: 0, proofSize: 0 }
  };
}

export function appendSetTopic(messagePrefix, requestId) {
  const prefix = normalizeHex(messagePrefix, "messagePrefix");
  const topic = normalizeBytes32(requestId, "requestId").slice(2);
  return `${prefix}${XCM_SET_TOPIC_INSTRUCTION.toString(16).padStart(2, "0")}${topic}`.toLowerCase();
}

export function encodeVersionedParachainLocation(paraId) {
  return `0x${toU8Hex(XCM_VERSION_V5)}01${toU8Hex(1)}00${encodeU32LeHex(paraId)}`;
}

export function resolveDestinationParachainId(strategy) {
  const explicit = strategy?.xcm?.destinationParachain ?? strategy?.xcm?.destinationParaId;
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    return normalizeParaId(explicit, "strategy.xcm.destinationParachain");
  }

  const location = strategy?.assetConfig?.xcmLocation;
  if (typeof location === "string") {
    const match = PARACHAIN_RE.exec(location);
    if (match) {
      return normalizeParaId(match[1], "strategy.asset.xcmLocation");
    }
  }

  throw new ValidationError("Async XCM strategy requires a destination parachain in xcmLocation or strategy.xcm.");
}

function normalizeDirection(direction) {
  const normalized = String(direction ?? "").trim().toLowerCase();
  if (normalized === "deposit" || normalized === "withdraw") {
    return normalized;
  }
  throw new ValidationError('direction must be "deposit" or "withdraw".');
}

function normalizeHex(value, label) {
  if (typeof value !== "string" || !HEX_RE.test(value) || value.length % 2 !== 0) {
    throw new ValidationError(`${label} must be an even-length 0x-prefixed hex string.`);
  }
  return value.toLowerCase();
}

function normalizeBytes32(value, label) {
  if (typeof value !== "string" || !BYTES32_RE.test(value)) {
    throw new ValidationError(`${label} must be a 0x-prefixed 32-byte hex string.`);
  }
  return value.toLowerCase();
}

function normalizeParaId(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new ValidationError(`${label} must be a uint32 parachain id.`);
  }
  return parsed;
}

function toU8Hex(value) {
  return value.toString(16).padStart(2, "0");
}

function encodeU32LeHex(value) {
  const hex = value.toString(16).padStart(8, "0");
  return `${hex.slice(6, 8)}${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`;
}

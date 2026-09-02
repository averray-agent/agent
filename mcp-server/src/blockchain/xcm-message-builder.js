import { Version, createVersionedDestination } from "@paraspell/sdk-core";

import { ValidationError } from "../core/errors.js";

export const XCM_VERSION_V5 = 0x05;
export const XCM_SET_TOPIC_INSTRUCTION = 0x2c;
export const XCM_INSTRUCTION_WITHDRAW_ASSET = 0x00;
export const XCM_INSTRUCTION_DEPOSIT_ASSET = 0x0d;
export const XCM_INSTRUCTION_PAY_FEES = 0x13;

const HEX_RE = /^0x[a-fA-F0-9]*$/u;
const BYTES20_RE = /^0x[a-fA-F0-9]{40}$/u;
const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/u;
const PARACHAIN_RE = /Parachain\((\d+)\)/iu;
const DEFAULT_ORIGIN_CHAIN = "AssetHubPolkadot";
const DEFAULT_DESTINATION_CHAIN = "BifrostPolkadot";
const DEFAULT_FEE_AMOUNT = 1_000_000_000n;
const DOT_ON_ASSET_HUB = { parents: 1, interior: "Here" };

export function buildXcmRequestPayload({
  strategy,
  direction,
  requestId,
  account,
  recipient,
  amount,
  shares
}) {
  const normalizedDirection = normalizeDirection(direction);
  const kind = String(strategy?.kind ?? "").trim().toLowerCase();
  if (kind !== "polkadot_vdot") {
    throw new ValidationError(`Unsupported async XCM strategy kind "${strategy?.kind ?? "unknown"}".`);
  }

  const destinationParaId = resolveDestinationParachainId(strategy);
  const destination = buildParaSpellDestination(strategy, destinationParaId);
  const message = buildVdotXcmMessage({
    strategy,
    direction: normalizedDirection,
    requestId,
    account,
    recipient,
    amount,
    shares
  });

  return {
    destination: encodeVersionedLocation(destination),
    message,
    maxWeight: { refTime: 0, proofSize: 0 }
  };
}

export function buildParaSpellDestination(strategy, destinationParaId = resolveDestinationParachainId(strategy)) {
  const xcm = strategy?.xcm ?? {};
  const originChain = normalizeChainName(xcm.originChain, DEFAULT_ORIGIN_CHAIN, "strategy.xcm.originChain");
  const destinationChain = normalizeChainName(
    xcm.destinationChain,
    DEFAULT_DESTINATION_CHAIN,
    "strategy.xcm.destinationChain"
  );
  return createVersionedDestination(Version.V5, originChain, destinationChain, destinationParaId);
}

export function buildVdotXcmMessage({
  strategy,
  direction,
  requestId,
  account,
  recipient,
  amount,
  shares
}) {
  const normalizedDirection = normalizeDirection(direction);
  const xcm = strategy?.xcm ?? {};
  const topic = normalizeBytes32(requestId, "requestId");
  const transferAmount = resolveDirectionAmount({ xcm, direction: normalizedDirection, amount, shares });
  const feeAmount = normalizeBigInt(
    xcm[`${normalizedDirection}FeeAmount`] ?? xcm.feeAmount ?? xcm.executionFeeAmount ?? DEFAULT_FEE_AMOUNT,
    "strategy.xcm.feeAmount"
  );
  const assetLocation = normalizeLocation(xcm.assetLocation ?? xcm.feeAssetLocation ?? DOT_ON_ASSET_HUB);
  const beneficiary = resolveBeneficiaryLocation({ xcm, direction: normalizedDirection, account, recipient });

  const instructions = [
    { WithdrawAsset: [{ id: assetLocation, fun: { Fungible: transferAmount } }] },
    { PayFees: { id: assetLocation, fun: { Fungible: feeAmount } } },
    {
      DepositAsset: {
        assets: { Wild: { AllCounted: 1 } },
        beneficiary
      }
    },
    { SetTopic: topic }
  ];

  return encodeVersionedXcm({ V5: instructions });
}

export function encodeVersionedParachainLocation(paraId) {
  return encodeVersionedLocation(createVersionedDestination(Version.V5, DEFAULT_ORIGIN_CHAIN, DEFAULT_DESTINATION_CHAIN, paraId));
}

export function encodeVersionedLocation(versionedLocation) {
  const location = unwrapVersioned(versionedLocation, "VersionedLocation");
  return `0x${toU8Hex(XCM_VERSION_V5)}${encodeLocationHex(location)}`;
}

export function encodeVersionedXcm(versionedXcm) {
  const instructions = unwrapVersioned(versionedXcm, "VersionedXcm");
  if (!Array.isArray(instructions)) {
    throw new ValidationError("VersionedXcm.V5 must be an instruction array.");
  }
  return `0x${toU8Hex(XCM_VERSION_V5)}${encodeVecHex(instructions, encodeInstructionHex)}`;
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

function encodeInstructionHex(instruction) {
  if (instruction?.WithdrawAsset !== undefined) {
    return `${toU8Hex(XCM_INSTRUCTION_WITHDRAW_ASSET)}${encodeVecHex(instruction.WithdrawAsset, encodeAssetHex)}`;
  }
  if (instruction?.PayFees !== undefined) {
    return `${toU8Hex(XCM_INSTRUCTION_PAY_FEES)}${encodeAssetHex(instruction.PayFees)}`;
  }
  if (instruction?.DepositAsset !== undefined) {
    return `${toU8Hex(XCM_INSTRUCTION_DEPOSIT_ASSET)}${encodeDepositAssetHex(instruction.DepositAsset)}`;
  }
  if (instruction?.SetTopic !== undefined) {
    return `${toU8Hex(XCM_SET_TOPIC_INSTRUCTION)}${strip0x(normalizeBytes32(instruction.SetTopic, "SetTopic"))}`;
  }
  throw new ValidationError(`Unsupported XCM v5 instruction: ${JSON.stringify(instruction)}`);
}

function encodeDepositAssetHex(value) {
  if (!value || typeof value !== "object") {
    throw new ValidationError("DepositAsset must be an object.");
  }
  return `${encodeAssetFilterHex(value.assets)}${encodeLocationHex(normalizeLocation(value.beneficiary))}`;
}

function encodeAssetFilterHex(value) {
  const allCounted = value?.Wild?.AllCounted;
  if (allCounted === undefined || allCounted === null) {
    throw new ValidationError("Only DepositAsset.assets Wild.AllCounted is supported for vDOT XCM messages.");
  }
  return `01${toU8Hex(0x01)}${encodeU32LeHex(normalizeU32(allCounted, "DepositAsset.assets.Wild.AllCounted"))}`;
}

function encodeAssetHex(asset) {
  if (!asset || typeof asset !== "object") {
    throw new ValidationError("XCM asset must be an object.");
  }
  const amount = asset.fun?.Fungible;
  if (amount === undefined || amount === null) {
    throw new ValidationError("Only fungible XCM assets are supported for vDOT messages.");
  }
  return `${encodeLocationHex(normalizeLocation(asset.id))}00${encodeCompactBigIntHex(normalizeBigInt(amount, "asset.fun.Fungible"))}`;
}

function encodeLocationHex(location) {
  const normalized = normalizeLocation(location);
  return `${toU8Hex(normalized.parents)}${encodeJunctionsHex(normalized.interior)}`;
}

function encodeJunctionsHex(interior) {
  if (interior === "Here" || interior?.Here !== undefined) {
    return "00";
  }
  if (interior?.X1 !== undefined) {
    const junctions = Array.isArray(interior.X1) ? interior.X1 : [interior.X1];
    if (junctions.length !== 1) {
      throw new ValidationError("X1 must contain exactly one junction.");
    }
    return `01${encodeJunctionHex(junctions[0])}`;
  }
  throw new ValidationError(`Unsupported XCM interior junctions: ${JSON.stringify(interior)}`);
}

function encodeJunctionHex(junction) {
  if (junction?.Parachain !== undefined) {
    return `00${encodeU32LeHex(normalizeParaId(junction.Parachain, "junction.Parachain"))}`;
  }
  if (junction?.AccountId32 !== undefined) {
    const value = junction.AccountId32;
    const id = typeof value === "string" ? value : value.id;
    return `01${encodeNetworkIdHex(value.network)}${strip0x(normalizeBytes32(id, "junction.AccountId32.id"))}`;
  }
  if (junction?.AccountKey20 !== undefined) {
    const value = junction.AccountKey20;
    const key = typeof value === "string" ? value : value.key;
    return `03${encodeNetworkIdHex(value.network)}${strip0x(normalizeBytes20(key, "junction.AccountKey20.key"))}`;
  }
  throw new ValidationError(`Unsupported XCM junction: ${JSON.stringify(junction)}`);
}

function encodeNetworkIdHex(network) {
  if (network === undefined || network === null || network === "Any" || network?.Any !== undefined) {
    return "00";
  }
  if (network === "Polkadot" || network?.Polkadot !== undefined) {
    return "02";
  }
  if (network === "Paseo" || network?.Paseo !== undefined) {
    return "07";
  }
  throw new ValidationError(`Unsupported XCM network id: ${JSON.stringify(network)}`);
}

function resolveBeneficiaryLocation({ xcm, direction, account, recipient }) {
  const directionValue =
    xcm[`${direction}BeneficiaryLocation`] ??
    xcm[`${direction}Beneficiary`] ??
    xcm.beneficiaryLocation ??
    xcm.beneficiary;
  if (directionValue !== undefined && directionValue !== null && directionValue !== "") {
    return normalizeBeneficiary(directionValue, `strategy.xcm.${direction}Beneficiary`);
  }
  const fallback = direction === "withdraw" ? (recipient || account) : account;
  return normalizeBeneficiary(fallback, `${direction} beneficiary`);
}

function normalizeBeneficiary(value, label) {
  if (typeof value === "string") {
    if (BYTES20_RE.test(value)) {
      return { parents: 0, interior: { X1: [{ AccountKey20: { network: null, key: value } }] } };
    }
    if (BYTES32_RE.test(value)) {
      return { parents: 0, interior: { X1: [{ AccountId32: { network: null, id: value } }] } };
    }
    throw new ValidationError(`${label} must be a 20-byte EVM address, 32-byte AccountId, or XCM location object.`);
  }
  return normalizeLocation(value);
}

function normalizeLocation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("XCM location must be an object.");
  }
  const parents = normalizeU8(value.parents ?? 0, "location.parents");
  const interior = value.interior ?? "Here";
  return { parents, interior };
}

function resolveDirectionAmount({ xcm, direction, amount, shares }) {
  const configured = xcm[`${direction}Amount`] ?? xcm.amount;
  if (configured !== undefined && configured !== null && configured !== "") {
    return normalizeBigInt(configured, `strategy.xcm.${direction}Amount`);
  }
  const raw = direction === "withdraw" ? (shares ?? amount) : amount;
  return normalizeBigInt(raw, `${direction} amount`);
}

function normalizeDirection(direction) {
  const normalized = String(direction ?? "").trim().toLowerCase();
  if (normalized === "deposit" || normalized === "withdraw") {
    return normalized;
  }
  throw new ValidationError('direction must be "deposit" or "withdraw".');
}

function normalizeChainName(value, fallback, label) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  const normalized = String(value).trim();
  if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(normalized)) {
    throw new ValidationError(`${label} must be a ParaSpell chain identifier.`);
  }
  return normalized;
}

function normalizeHex(value, label) {
  if (typeof value !== "string" || !HEX_RE.test(value) || value.length % 2 !== 0) {
    throw new ValidationError(`${label} must be an even-length 0x-prefixed hex string.`);
  }
  return value.toLowerCase();
}

function normalizeBytes20(value, label) {
  if (typeof value !== "string" || !BYTES20_RE.test(value)) {
    throw new ValidationError(`${label} must be a 0x-prefixed 20-byte hex string.`);
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
  return normalizeU32(value, label);
}

function normalizeU8(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xff) {
    throw new ValidationError(`${label} must be a uint8.`);
  }
  return parsed;
}

function normalizeU32(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new ValidationError(`${label} must be a uint32.`);
  }
  return parsed;
}

function normalizeBigInt(value, label) {
  try {
    const parsed = typeof value === "bigint" ? value : BigInt(String(value));
    if (parsed <= 0n) {
      throw new Error("non-positive");
    }
    return parsed;
  } catch {
    throw new ValidationError(`${label} must be a positive integer.`);
  }
}

function unwrapVersioned(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.V5 === undefined) {
    throw new ValidationError(`${label} must be a V5 object.`);
  }
  return value.V5;
}

function encodeVecHex(values, encodeValue) {
  if (!Array.isArray(values)) {
    throw new ValidationError("SCALE vector value must be an array.");
  }
  return `${encodeCompactBigIntHex(BigInt(values.length))}${values.map((entry) => encodeValue(entry)).join("")}`;
}

function encodeCompactBigIntHex(value) {
  const normalized = normalizeBigInt(value, "compact integer");
  if (normalized < 64n) {
    return toU8Hex(Number(normalized << 2n));
  }
  if (normalized < 16_384n) {
    return encodeU16LeHex(Number((normalized << 2n) | 1n));
  }
  if (normalized < 1_073_741_824n) {
    return encodeU32LeHex(Number((normalized << 2n) | 2n));
  }

  let remaining = normalized;
  const bytes = [];
  while (remaining > 0n) {
    bytes.push(Number(remaining & 0xffn));
    remaining >>= 8n;
  }
  if (bytes.length < 4) {
    while (bytes.length < 4) bytes.push(0);
  }
  if (bytes.length > 67) {
    throw new ValidationError("compact integer is too large.");
  }
  return `${toU8Hex(((bytes.length - 4) << 2) | 0x03)}${bytes.map(toU8Hex).join("")}`;
}

function toU8Hex(value) {
  return value.toString(16).padStart(2, "0");
}

function encodeU16LeHex(value) {
  const hex = value.toString(16).padStart(4, "0");
  return `${hex.slice(2, 4)}${hex.slice(0, 2)}`;
}

function encodeU32LeHex(value) {
  const hex = value.toString(16).padStart(8, "0");
  return `${hex.slice(6, 8)}${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`;
}

function strip0x(value) {
  return normalizeHex(value, "hex").slice(2);
}

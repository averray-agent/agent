const POLKADOT_HUB_ASSET_SUFFIX = {
  trust_backed: "01200000",
  foreign: "02200000",
  pool: "03200000"
};

export function normaliseStrategyAssetConfig(rawAsset, idx) {
  if (rawAsset === undefined || rawAsset === null || rawAsset === "") {
    return undefined;
  }

  if (typeof rawAsset === "string") {
    return {
      assetClass: "custom",
      address: normaliseAddress(rawAsset, `strategies[${idx}].asset`)
    };
  }

  if (!rawAsset || typeof rawAsset !== "object" || Array.isArray(rawAsset)) {
    throw new Error(`strategies[${idx}].asset must be a 0x address or object`);
  }

  const assetClass = normaliseAssetClass(rawAsset.assetClass, idx);
  const symbol = normaliseOptionalString(rawAsset.symbol);
  const decimals = normaliseOptionalU16(rawAsset.decimals, `strategies[${idx}].asset.decimals`);
  const assetId = normaliseOptionalU32(rawAsset.assetId, `strategies[${idx}].asset.assetId`);
  const foreignAssetIndex = normaliseOptionalU32(
    rawAsset.foreignAssetIndex,
    `strategies[${idx}].asset.foreignAssetIndex`
  );
  const address = rawAsset.address === undefined
    ? undefined
    : normaliseAddress(rawAsset.address, `strategies[${idx}].asset.address`);
  const xcmLocation = normaliseXcmLocation(rawAsset.xcmLocation, idx);
  const derivedAddress = derivePolkadotHubAssetAddress({
    assetClass,
    assetId,
    foreignAssetIndex
  });

  if (assetClass === "trust_backed" && assetId === undefined && address === undefined) {
    throw new Error(`strategies[${idx}].asset.assetId or address is required for trust_backed assets`);
  }
  if (assetClass === "pool" && assetId === undefined && address === undefined) {
    throw new Error(`strategies[${idx}].asset.assetId or address is required for pool assets`);
  }
  if (assetClass === "foreign" && foreignAssetIndex === undefined && address === undefined) {
    throw new Error(`strategies[${idx}].asset.foreignAssetIndex or address is required for foreign assets`);
  }
  if (assetClass === "foreign" && xcmLocation === undefined && foreignAssetIndex === undefined && address === undefined) {
    throw new Error(`strategies[${idx}].asset.xcmLocation is not enough on its own; include foreignAssetIndex or address`);
  }
  if (assetClass === "custom" && address === undefined) {
    throw new Error(`strategies[${idx}].asset.address is required for custom assets`);
  }
  if (address && derivedAddress && address !== derivedAddress) {
    throw new Error(
      `strategies[${idx}].asset.address does not match derived ${assetClass} precompile address ${derivedAddress}`
    );
  }

  const normalized = {
    assetClass,
    address: address ?? derivedAddress
  };
  if (symbol !== undefined) normalized.symbol = symbol;
  if (decimals !== undefined) normalized.decimals = decimals;
  if (assetId !== undefined) normalized.assetId = assetId;
  if (foreignAssetIndex !== undefined) normalized.foreignAssetIndex = foreignAssetIndex;
  if (xcmLocation !== undefined) normalized.xcmLocation = xcmLocation;
  return normalized;
}

export function derivePolkadotHubAssetAddress({ assetClass, assetId, foreignAssetIndex }) {
  if (assetClass === "trust_backed") {
    return deriveAddressFromU32(assetId, POLKADOT_HUB_ASSET_SUFFIX.trust_backed);
  }
  if (assetClass === "pool") {
    return deriveAddressFromU32(assetId, POLKADOT_HUB_ASSET_SUFFIX.pool);
  }
  if (assetClass === "foreign") {
    return deriveAddressFromU32(foreignAssetIndex, POLKADOT_HUB_ASSET_SUFFIX.foreign);
  }
  return undefined;
}

function deriveAddressFromU32(value, suffix) {
  if (value === undefined) {
    return undefined;
  }
  const hex = value.toString(16).padStart(8, "0");
  return `0x${hex}${"0".repeat(24)}${suffix}`;
}

function normaliseAssetClass(rawAssetClass, idx) {
  if (rawAssetClass === undefined || rawAssetClass === null || rawAssetClass === "") {
    return "custom";
  }
  if (typeof rawAssetClass !== "string") {
    throw new Error(`strategies[${idx}].asset.assetClass must be a string`);
  }
  const normalized = rawAssetClass.trim().toLowerCase().replace(/[\s-]+/gu, "_");
  if (normalized === "trust_backed" || normalized === "foreign" || normalized === "pool" || normalized === "custom") {
    return normalized;
  }
  throw new Error(`strategies[${idx}].asset.assetClass must be one of trust_backed, foreign, pool, custom`);
}

function normaliseOptionalString(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new Error("asset string fields must be strings");
  }
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function normaliseOptionalU16(raw, label) {
  const value = normaliseOptionalU32(raw, label);
  if (value === undefined) return undefined;
  if (value > 255) {
    throw new Error(`${label} must be between 0 and 255`);
  }
  return value;
}

function normaliseOptionalU32(raw, label) {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${label} must be a u32 integer`);
  }
  return value;
}

function normaliseAddress(raw, label) {
  if (typeof raw !== "string" || !/^0x[a-fA-F0-9]{40}$/u.test(raw)) {
    throw new Error(`${label} must be a 0x + 20-byte EVM address`);
  }
  return raw.toLowerCase();
}

function normaliseXcmLocation(raw, idx) {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (typeof raw === "string") {
    return raw.trim() || undefined;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  throw new Error(`strategies[${idx}].asset.xcmLocation must be a string or object`);
}

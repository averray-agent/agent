import { ConfigError } from "../core/errors.js";
import { derivePolkadotHubAssetAddress } from "../services/strategy-asset-config.js";

function parseLegacyAssets(rawAssets) {
  if (!rawAssets) {
    return [];
  }

  return rawAssets
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [symbol, address] = entry.split(":");
      if (!symbol || !address) {
        throw new ConfigError(`Invalid SUPPORTED_ASSETS entry: ${entry}`);
      }
      return { symbol, address: normalizeAddress(address, `SUPPORTED_ASSETS entry ${symbol}`) };
    });
}

function parseAssetsJson(rawAssetsJson) {
  if (!rawAssetsJson) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(rawAssetsJson);
  } catch {
    throw new ConfigError("SUPPORTED_ASSETS_JSON must be valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new ConfigError("SUPPORTED_ASSETS_JSON must decode to an array.");
  }

  return parsed.map((entry, idx) => normalizeAssetEntry(entry, idx));
}

function normalizeAssetEntry(entry, idx) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new ConfigError(`SUPPORTED_ASSETS_JSON[${idx}] must be an object.`);
  }

  const symbol = normalizeSymbol(entry.symbol, idx);
  const assetClass = normalizeAssetClass(entry.assetClass, idx);
  const decimals = normalizeOptionalByte(entry.decimals, `SUPPORTED_ASSETS_JSON[${idx}].decimals`);
  const assetId = normalizeOptionalU32(entry.assetId, `SUPPORTED_ASSETS_JSON[${idx}].assetId`);
  const foreignAssetIndex = normalizeOptionalU32(
    entry.foreignAssetIndex,
    `SUPPORTED_ASSETS_JSON[${idx}].foreignAssetIndex`
  );
  const address = entry.address === undefined
    ? undefined
    : normalizeAddress(entry.address, `SUPPORTED_ASSETS_JSON[${idx}].address`);
  const xcmLocation = normalizeOptionalXcmLocation(entry.xcmLocation, idx);
  const derivedAddress = derivePolkadotHubAssetAddress({
    assetClass,
    assetId,
    foreignAssetIndex
  });

  if (assetClass === "trust_backed" && assetId === undefined && address === undefined) {
    throw new ConfigError(`SUPPORTED_ASSETS_JSON[${idx}] trust_backed assets require assetId or address.`);
  }
  if (assetClass === "pool" && assetId === undefined && address === undefined) {
    throw new ConfigError(`SUPPORTED_ASSETS_JSON[${idx}] pool assets require assetId or address.`);
  }
  if (assetClass === "foreign" && foreignAssetIndex === undefined && address === undefined) {
    throw new ConfigError(`SUPPORTED_ASSETS_JSON[${idx}] foreign assets require foreignAssetIndex or address.`);
  }
  if (assetClass === "custom" && address === undefined) {
    throw new ConfigError(`SUPPORTED_ASSETS_JSON[${idx}] custom assets require address.`);
  }
  if (address && derivedAddress && address !== derivedAddress) {
    throw new ConfigError(
      `SUPPORTED_ASSETS_JSON[${idx}].address does not match derived ${assetClass} precompile address ${derivedAddress}.`
    );
  }

  const normalized = {
    symbol,
    address: address ?? derivedAddress
  };
  if (assetClass !== "custom") normalized.assetClass = assetClass;
  if (decimals !== undefined) normalized.decimals = decimals;
  if (assetId !== undefined) normalized.assetId = assetId;
  if (foreignAssetIndex !== undefined) normalized.foreignAssetIndex = foreignAssetIndex;
  if (xcmLocation !== undefined) normalized.xcmLocation = xcmLocation;
  return normalized;
}

function normalizeSymbol(raw, idx) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ConfigError(`SUPPORTED_ASSETS_JSON[${idx}].symbol must be a non-empty string.`);
  }
  return raw.trim();
}

function normalizeAssetClass(raw, idx) {
  if (raw === undefined || raw === null || raw === "") {
    return "custom";
  }
  if (typeof raw !== "string") {
    throw new ConfigError(`SUPPORTED_ASSETS_JSON[${idx}].assetClass must be a string.`);
  }
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/gu, "_");
  if (normalized === "trust_backed" || normalized === "foreign" || normalized === "pool" || normalized === "custom") {
    return normalized;
  }
  throw new ConfigError(
    `SUPPORTED_ASSETS_JSON[${idx}].assetClass must be one of trust_backed, foreign, pool, custom.`
  );
}

function normalizeOptionalByte(raw, label) {
  const value = normalizeOptionalU32(raw, label);
  if (value === undefined) return undefined;
  if (value > 255) {
    throw new ConfigError(`${label} must be between 0 and 255.`);
  }
  return value;
}

function normalizeOptionalU32(raw, label) {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new ConfigError(`${label} must be a u32 integer.`);
  }
  return value;
}

function normalizeAddress(raw, label) {
  if (typeof raw !== "string" || !/^0x[a-fA-F0-9]{40}$/u.test(raw)) {
    throw new ConfigError(`${label} must be a 0x + 20-byte EVM address.`);
  }
  return raw.toLowerCase();
}

function normalizeOptionalXcmLocation(raw, idx) {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (typeof raw === "string") {
    return raw.trim() || undefined;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  throw new ConfigError(`SUPPORTED_ASSETS_JSON[${idx}].xcmLocation must be a string or object.`);
}

export function loadBlockchainConfig(env = process.env) {
  const rpcUrl = resolveRpcUrl(env);
  const assetConfigPresent = Boolean(env.SUPPORTED_ASSETS_JSON || env.SUPPORTED_ASSETS);
  const requiredFields = [
    {
      key: "RPC_URL",
      configured: Boolean(rpcUrl),
      missingLabel: "RPC_URL (or DWELLER_RPC_URL / POLKADOT_RPC_URL)"
    },
    { key: "SIGNER_PRIVATE_KEY", configured: Boolean(env.SIGNER_PRIVATE_KEY) },
    { key: "TREASURY_POLICY_ADDRESS", configured: Boolean(env.TREASURY_POLICY_ADDRESS) },
    { key: "AGENT_ACCOUNT_ADDRESS", configured: Boolean(env.AGENT_ACCOUNT_ADDRESS) },
    { key: "ESCROW_CORE_ADDRESS", configured: Boolean(env.ESCROW_CORE_ADDRESS) },
    { key: "REPUTATION_SBT_ADDRESS", configured: Boolean(env.REPUTATION_SBT_ADDRESS) },
    {
      key: "SUPPORTED_ASSETS",
      configured: assetConfigPresent,
      missingLabel: "SUPPORTED_ASSETS (or SUPPORTED_ASSETS_JSON)"
    }
  ];
  const configuredFields = requiredFields.filter((field) => field.configured).map((field) => field.key);
  const hasPartialConfig = configuredFields.length > 0 && configuredFields.length < requiredFields.length;
  if (hasPartialConfig) {
    const missing = requiredFields
      .filter((field) => !field.configured)
      .map((field) => field.missingLabel ?? field.key);
    throw new ConfigError(
      `Incomplete blockchain configuration. Missing: ${missing.join(", ")}`,
      { missing, configured: configuredFields }
    );
  }

  const supportedAssets = env.SUPPORTED_ASSETS_JSON?.trim()
    ? parseAssetsJson(env.SUPPORTED_ASSETS_JSON)
    : parseLegacyAssets(env.SUPPORTED_ASSETS);
  const enabled = configuredFields.length === requiredFields.length && supportedAssets.length > 0;

  if (configuredFields.length === requiredFields.length && supportedAssets.length === 0) {
    throw new ConfigError("SUPPORTED_ASSETS must contain at least one asset entry.");
  }

  return {
    enabled,
    rpcUrl,
    signerPrivateKey: env.SIGNER_PRIVATE_KEY ?? "",
    treasuryPolicyAddress: env.TREASURY_POLICY_ADDRESS ?? "",
    agentAccountAddress: env.AGENT_ACCOUNT_ADDRESS ?? "",
    escrowCoreAddress: env.ESCROW_CORE_ADDRESS ?? "",
    reputationSbtAddress: env.REPUTATION_SBT_ADDRESS ?? "",
    verifierRegistryAddress: normalizeOptionalAddress(env.VERIFIER_REGISTRY_ADDRESS, "VERIFIER_REGISTRY_ADDRESS"),
    discoveryRegistryAddress: normalizeOptionalAddress(env.DISCOVERY_REGISTRY_ADDRESS, "DISCOVERY_REGISTRY_ADDRESS"),
    disclosureLogAddress: normalizeOptionalAddress(env.DISCLOSURE_LOG_ADDRESS, "DISCLOSURE_LOG_ADDRESS"),
    xcmWrapperAddress: normalizeOptionalAddress(env.XCM_WRAPPER_ADDRESS, "XCM_WRAPPER_ADDRESS"),
    supportedAssets
  };
}

function resolveRpcUrl(env = process.env) {
  return env.DWELLER_RPC_URL?.trim() || env.POLKADOT_RPC_URL?.trim() || env.RPC_URL?.trim() || "";
}

function normalizeOptionalAddress(raw, label) {
  if (raw === undefined || raw === null || raw === "") {
    return "";
  }
  return normalizeAddress(raw, label);
}

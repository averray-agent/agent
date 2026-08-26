import { ConfigError } from "../core/errors.js";
import { knownAssetMinBalanceRaw } from "../core/assets.js";
import { loadDeploymentManifest } from "../core/health-capability.js";
import { derivePolkadotHubAssetAddress } from "../services/strategy-asset-config.js";

const DEFAULT_GAS_FEE_BUFFER_BPS = 2000;
const DEFAULT_RPC_FAILOVER_STALL_MS = 250;
const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 750;
const DEFAULT_RPC_WRITE_REQUEST_TIMEOUT_MS = 15_000;

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
  const configuredMinBalanceRaw = normalizeOptionalRawAmount(
    entry.minBalanceRaw,
    `SUPPORTED_ASSETS_JSON[${idx}].minBalanceRaw`
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
  const minBalanceRaw = configuredMinBalanceRaw ?? knownAssetMinBalanceRaw(normalized);
  if (minBalanceRaw !== undefined) normalized.minBalanceRaw = minBalanceRaw;
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

function normalizeOptionalRawAmount(raw, label) {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  const value = typeof raw === "bigint" ? raw.toString() : String(raw).trim();
  if (!/^\d+$/u.test(value)) {
    throw new ConfigError(`${label} must be a non-negative integer string in base units.`);
  }
  return value;
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
  const rpcBackupUrls = resolveRpcBackupUrls(env, rpcUrl);
  const assetConfigPresent = Boolean(env.SUPPORTED_ASSETS_JSON || env.SUPPORTED_ASSETS);
  const deploymentManifest = loadDeploymentManifest(env);

  // Phase 3 (per docs/SECRETS_MIGRATION.md §"Phase 3 — AWS KMS for the
  // backend signer"): SIGNER_BACKEND selects which signing path the
  // gateway constructs. Defaults to "local" for backwards compat —
  // existing deployments that only set SIGNER_PRIVATE_KEY keep working.
  // When "kms", we require KMS_KEY_ID + AWS_REGION instead, and the
  // signer never sees raw key material.
  const signerBackend = (env.SIGNER_BACKEND ?? "local").trim().toLowerCase();
  if (signerBackend !== "local" && signerBackend !== "kms") {
    throw new ConfigError(
      `SIGNER_BACKEND must be "local" or "kms"; got "${env.SIGNER_BACKEND}"`,
    );
  }
  if (signerBackend === "kms" && env.SIGNER_PRIVATE_KEY) {
    throw new ConfigError(
      "SIGNER_BACKEND=kms and SIGNER_PRIVATE_KEY are mutually exclusive. " +
        "Unset SIGNER_PRIVATE_KEY when using KMS — keeping both is a " +
        "Phase 3 anti-pattern: a deployed key plus a vault key undoes the " +
        "non-exportability guarantee.",
    );
  }

  const requiredFields = [
    {
      key: "RPC_URL",
      configured: Boolean(rpcUrl),
      missingLabel: "RPC_URL (or DWELLER_RPC_URL / POLKADOT_RPC_URL)"
    },
    signerBackend === "kms"
      ? {
          key: "KMS_KEY_ID",
          configured: Boolean(env.KMS_KEY_ID) && Boolean(env.AWS_REGION),
          missingLabel: "KMS_KEY_ID + AWS_REGION (required when SIGNER_BACKEND=kms)",
        }
      : { key: "SIGNER_PRIVATE_KEY", configured: Boolean(env.SIGNER_PRIVATE_KEY) },
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
    rpcBackupUrls,
    rpcUrls: [rpcUrl, ...rpcBackupUrls].filter(Boolean),
    rpcFailoverStallMs: resolveBoundedMilliseconds(
      env.RPC_FAILOVER_STALL_MS,
      "RPC_FAILOVER_STALL_MS",
      DEFAULT_RPC_FAILOVER_STALL_MS,
      { minimum: 10, maximum: 10_000 }
    ),
    rpcRequestTimeoutMs: resolveBoundedMilliseconds(
      env.RPC_REQUEST_TIMEOUT_MS,
      "RPC_REQUEST_TIMEOUT_MS",
      DEFAULT_RPC_REQUEST_TIMEOUT_MS,
      { minimum: 100, maximum: 30_000 }
    ),
    rpcWriteRequestTimeoutMs: resolveBoundedMilliseconds(
      env.RPC_WRITE_REQUEST_TIMEOUT_MS,
      "RPC_WRITE_REQUEST_TIMEOUT_MS",
      DEFAULT_RPC_WRITE_REQUEST_TIMEOUT_MS,
      { minimum: 15_000, maximum: 120_000 }
    ),
    chainEvmFloorBlock: normalizeOptionalU32(
      env.CHAIN_EVM_FLOOR_BLOCK,
      "CHAIN_EVM_FLOOR_BLOCK"
    ) ?? 0,
    signerBackend,
    signerPrivateKey: env.SIGNER_PRIVATE_KEY ?? "",
    arbitratorSignerPrivateKey: env.ARBITRATOR_SIGNER_PRIVATE_KEY ?? "",
    kmsKeyId: env.KMS_KEY_ID ?? "",
    awsRegion: env.AWS_REGION ?? "",
    treasuryPolicyAddress: env.TREASURY_POLICY_ADDRESS ?? "",
    agentAccountAddress: env.AGENT_ACCOUNT_ADDRESS ?? "",
    escrowCoreAddress: env.ESCROW_CORE_ADDRESS ?? "",
    legacyEscrowCoreAddress: normalizeOptionalAddress(
      env.LEGACY_ESCROW_CORE_ADDRESS,
      "LEGACY_ESCROW_CORE_ADDRESS"
    ),
    reputationSbtAddress: env.REPUTATION_SBT_ADDRESS ?? "",
    discoveryRegistryAddress: normalizeOptionalAddress(env.DISCOVERY_REGISTRY_ADDRESS, "DISCOVERY_REGISTRY_ADDRESS"),
    xcmWrapperAddress: normalizeOptionalAddress(env.XCM_WRAPPER_ADDRESS, "XCM_WRAPPER_ADDRESS"),
    xcmWrapperDeploymentBlock: normalizeOptionalU32(
      deploymentManifest?.deploymentBlocks?.xcmWrapper,
      "deployments/<profile>.json#deploymentBlocks.xcmWrapper"
    ),
    hydrationUsdcAdapterAddress: normalizeOptionalAddress(
      env.HYDRATION_USDC_ADAPTER_ADDRESS,
      "HYDRATION_USDC_ADAPTER_ADDRESS"
    ),
    depositPoolAddress: normalizeOptionalAddress(
      deploymentManifest?.contracts?.depositPool,
      "deployments/<profile>.json#contracts.depositPool"
    ),
    depositPoolDeploymentBlock: normalizeOptionalU32(
      deploymentManifest?.deploymentBlocks?.depositPool,
      "deployments/<profile>.json#deploymentBlocks.depositPool"
    ),
    depositPoolV2Address: normalizeOptionalAddress(
      deploymentManifest?.contracts?.depositPoolV2,
      "deployments/<profile>.json#contracts.depositPoolV2"
    ),
    depositPoolV2DeploymentBlock: normalizeOptionalU32(
      deploymentManifest?.deploymentBlocks?.depositPoolV2,
      "deployments/<profile>.json#deploymentBlocks.depositPoolV2"
    ),
    depositPoolV21Address: normalizeOptionalAddress(
      deploymentManifest?.contracts?.depositPoolV21,
      "deployments/<profile>.json#contracts.depositPoolV21"
    ),
    depositPoolV21DeploymentBlock: normalizeOptionalU32(
      deploymentManifest?.deploymentBlocks?.depositPoolV21,
      "deployments/<profile>.json#deploymentBlocks.depositPoolV21"
    ),
    aacPoolAggregatorAdapterAddress: normalizeOptionalAddress(
      deploymentManifest?.contracts?.aacPoolAggregatorAdapter,
      "deployments/<profile>.json#contracts.aacPoolAggregatorAdapter"
    ),
    aacPoolAggregatorAdapterDeploymentBlock: normalizeOptionalU32(
      deploymentManifest?.deploymentBlocks?.aacPoolAggregatorAdapter,
      "deployments/<profile>.json#deploymentBlocks.aacPoolAggregatorAdapter"
    ),
    creditPoolAddress: normalizeOptionalAddress(
      deploymentManifest?.contracts?.creditPool,
      "deployments/<profile>.json#contracts.creditPool"
    ),
    creditPoolDeploymentBlock: normalizeOptionalU32(
      deploymentManifest?.deploymentBlocks?.creditPool,
      "deployments/<profile>.json#deploymentBlocks.creditPool"
    ),
    creditBookAddress: normalizeOptionalAddress(
      env.CREDIT_BOOK_ADDRESS ?? deploymentManifest?.contracts?.creditBook,
      "CREDIT_BOOK_ADDRESS (or deployments/<profile>.json#contracts.creditBook)"
    ),
    creditBookDeploymentBlock: normalizeOptionalU32(
      deploymentManifest?.deploymentBlocks?.creditBook,
      "deployments/<profile>.json#deploymentBlocks.creditBook"
    ),
    depositPoolVestingMigration: normalizeDepositPoolVestingMigration(
      deploymentManifest?.depositPoolVestingMigration
    ),
    supportedAssets,
    gasFeeBufferBps: resolveGasFeeBufferBps(env)
  };
}

// Basis-point buffer added to Polkadot Hub tx fee ceilings (see fee-buffer.js).
// Default 2000 (20%); GAS_FEE_BUFFER_BPS=0 disables it.
function resolveGasFeeBufferBps(env = process.env) {
  const raw = env.GAS_FEE_BUFFER_BPS;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_GAS_FEE_BUFFER_BPS;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new ConfigError("GAS_FEE_BUFFER_BPS must be an integer in [0, 10000] (basis points).");
  }
  return value;
}

function resolveRpcUrl(env = process.env) {
  return env.DWELLER_RPC_URL?.trim() || env.POLKADOT_RPC_URL?.trim() || env.RPC_URL?.trim() || "";
}

function resolveRpcBackupUrls(env = process.env, primaryUrl = "") {
  const seen = new Set(primaryUrl ? [primaryUrl] : []);
  return String(env.RPC_BACKUP_URLS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (!entry || seen.has(entry)) return false;
      seen.add(entry);
      return true;
    });
}

function resolveBoundedMilliseconds(raw, label, fallback, { minimum, maximum }) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ConfigError(`${label} must be an integer in [${minimum}, ${maximum}] milliseconds.`);
  }
  return value;
}

function normalizeOptionalAddress(raw, label) {
  if (raw === undefined || raw === null || raw === "") {
    return "";
  }
  return normalizeAddress(raw, label);
}

function normalizeDepositPoolVestingMigration(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("depositPoolVestingMigration must be an object.");
  }
  const oldWithdrawTx = String(raw?.ignoredTransferEvents?.oldWithdrawTx ?? "").toLowerCase();
  const newDepositTx = String(raw?.ignoredTransferEvents?.newDepositTx ?? "").toLowerCase();
  for (const [label, value] of [["oldWithdrawTx", oldWithdrawTx], ["newDepositTx", newDepositTx]]) {
    if (!/^0x[0-9a-f]{64}$/u.test(value)) {
      throw new ConfigError(`depositPoolVestingMigration.${label} must be a transaction hash.`);
    }
  }
  if (!Array.isArray(raw.preservedTranches)) {
    throw new ConfigError("depositPoolVestingMigration.preservedTranches must be an array.");
  }
  return {
    schemaVersion: 1,
    fromPool: normalizeAddress(raw.fromPool, "depositPoolVestingMigration.fromPool"),
    toPool: normalizeAddress(raw.toPool, "depositPoolVestingMigration.toPool"),
    wallet: normalizeAddress(raw.wallet, "depositPoolVestingMigration.wallet"),
    ignoredTransferEvents: { oldWithdrawTx, newDepositTx },
    preservedTranches: raw.preservedTranches.map((entry, index) => {
      const depositedRaw = String(entry?.depositedRaw ?? "");
      const remainingRaw = String(entry?.remainingRaw ?? "");
      if (!/^\d+$/u.test(depositedRaw) || !/^\d+$/u.test(remainingRaw)) {
        throw new ConfigError(`depositPoolVestingMigration.preservedTranches[${index}] has invalid raw amounts.`);
      }
      const depositedAt = new Date(entry.depositedAt);
      if (!Number.isFinite(depositedAt.getTime())) {
        throw new ConfigError(`depositPoolVestingMigration.preservedTranches[${index}].depositedAt is invalid.`);
      }
      return { ...entry, depositedRaw, remainingRaw, depositedAt: depositedAt.toISOString() };
    })
  };
}

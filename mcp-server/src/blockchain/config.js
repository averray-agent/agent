import { ConfigError } from "../core/errors.js";

function parseAssets(rawAssets) {
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
      return { symbol, address };
    });
}

export function loadBlockchainConfig(env = process.env) {
  const rpcUrl = resolveRpcUrl(env);
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
    { key: "SUPPORTED_ASSETS", configured: Boolean(env.SUPPORTED_ASSETS) }
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

  const supportedAssets = parseAssets(env.SUPPORTED_ASSETS);
  const enabled = configuredFields.length === requiredFields.length && supportedAssets.length > 0;

  if (configuredFields.length === requiredFields.length && supportedAssets.length === 0) {
    throw new ConfigError("SUPPORTED_ASSETS must contain at least one symbol:address entry.");
  }

  return {
    enabled,
    rpcUrl,
    signerPrivateKey: env.SIGNER_PRIVATE_KEY ?? "",
    treasuryPolicyAddress: env.TREASURY_POLICY_ADDRESS ?? "",
    agentAccountAddress: env.AGENT_ACCOUNT_ADDRESS ?? "",
    escrowCoreAddress: env.ESCROW_CORE_ADDRESS ?? "",
    reputationSbtAddress: env.REPUTATION_SBT_ADDRESS ?? "",
    supportedAssets
  };
}

function resolveRpcUrl(env = process.env) {
  return env.DWELLER_RPC_URL?.trim() || env.POLKADOT_RPC_URL?.trim() || env.RPC_URL?.trim() || "";
}

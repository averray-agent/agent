import { ConfigError } from "../core/errors.js";

export function loadPimlicoConfig(env = process.env) {
  const requiredFields = [
    "PIMLICO_BUNDLER_URL",
    "PIMLICO_PAYMASTER_URL",
    "PIMLICO_ENTRY_POINT"
  ];
  const configuredFields = requiredFields.filter((key) => Boolean(env[key]));
  const hasPartialConfig = configuredFields.length > 0 && configuredFields.length < requiredFields.length;

  if (hasPartialConfig) {
    const missing = requiredFields.filter((key) => !env[key]);
    throw new ConfigError(
      `Incomplete Pimlico configuration. Missing: ${missing.join(", ")}`,
      { missing, configured: configuredFields }
    );
  }

  return {
    enabled: configuredFields.length === requiredFields.length,
    bundlerUrl: env.PIMLICO_BUNDLER_URL ?? "",
    paymasterUrl: env.PIMLICO_PAYMASTER_URL ?? "",
    entryPoint: env.PIMLICO_ENTRY_POINT ?? "",
    sponsorshipPolicyId: env.PIMLICO_SPONSORSHIP_POLICY_ID ?? "",
    chainId: env.PIMLICO_CHAIN_ID ? Number(env.PIMLICO_CHAIN_ID) : undefined
  };
}

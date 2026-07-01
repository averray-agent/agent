import { ConfigError } from "../core/errors.js";

// Polkadot Hub chain ids (EVM/pallet-revive surface). Mainnet is the only
// network where a local hot-key signer is a launch-blocking posture — the
// TestNets deliberately run with cheaper local keys.
export const POLKADOT_HUB_MAINNET_CHAIN_ID = 420420419; // TestNet Hub = 420420417

function normalizeChainId(value) {
  const n = Number(value ?? 0);
  return Number.isInteger(n) && n >= 0 ? n : NaN;
}

/**
 * B-02 — refuse to boot the on-chain broker on **mainnet** with a local
 * hot-key signer.
 *
 * On mainnet (`AUTH_CHAIN_ID` = the Polkadot Hub mainnet chain id) with the
 * blockchain gateway live, `SIGNER_BACKEND` must be `kms`. A `local` signer
 * means a raw `SIGNER_PRIVATE_KEY` in the process environment signs real
 * value-bearing settlement transactions — exactly the hot-key exposure the
 * KMS signer exists to remove. This is a fail-closed launch gate with no
 * override: mainnet does not get a hot key.
 *
 * No-op off mainnet (TestNet keeps local keys) and when the gateway is
 * disabled (nothing signs, so there is no hot-key exposure).
 *
 * @param {object} args
 * @param {{ chainId?: number }} args.authConfig
 * @param {{ isEnabled?: () => boolean, config?: { signerBackend?: string } }} args.gateway
 * @param {Record<string, string | undefined>} [args.env]
 */
export function assertMainnetSignerPosture({ authConfig, gateway, env = process.env } = {}) {
  const chainId = normalizeChainId(authConfig?.chainId);
  if (chainId !== POLKADOT_HUB_MAINNET_CHAIN_ID) {
    return; // not mainnet — TestNet local keys are intentional
  }
  const gatewayEnabled = typeof gateway?.isEnabled === "function" && gateway.isEnabled() === true;
  if (!gatewayEnabled) {
    return; // gateway off → nothing signs on-chain → no hot-key exposure
  }
  const signerBackend = (
    gateway?.config?.signerBackend ?? env.SIGNER_BACKEND ?? "local"
  )
    .trim()
    .toLowerCase();
  if (signerBackend !== "kms") {
    throw new ConfigError(
      `Mainnet (chain ${POLKADOT_HUB_MAINNET_CHAIN_ID}) requires SIGNER_BACKEND=kms — refusing to boot the ` +
        `on-chain broker with a local hot-key signer (SIGNER_BACKEND=${signerBackend}). Provision a KMS ` +
        `signer (KMS_KEY_ID + AWS_REGION) before launching mainnet.`
    );
  }
}

/**
 * D-02 — verify the configured chain id matches the chain the RPC actually
 * serves, before the backend brokers anything.
 *
 * A backend configured for one chain (`AUTH_CHAIN_ID`) but pointed at an RPC
 * for another silently signs/settles against the wrong network — the SIWE
 * domain binding, the deployed contract addresses, and the settlement all
 * disagree. When the gateway is live and a chain id is configured, we fetch
 * the RPC's reported chain id and **fail closed on a confirmed mismatch**.
 *
 * If the RPC is unreachable at boot we do NOT block startup — that is a
 * liveness concern handled by the gateway's own health checks, and a
 * chain-id *verification* should not make the process un-bootable during a
 * transient RPC blip. We log `startup.chain_id_unverified` and continue; the
 * mismatch (the security condition) is the only fail-closed path.
 *
 * @param {object} args
 * @param {{ chainId?: number }} args.authConfig
 * @param {{ isEnabled?: () => boolean, provider?: { getNetwork: () => Promise<{ chainId: bigint|number }> }, config?: { rpcUrl?: string } }} args.gateway
 * @param {{ info?: Function, warn?: Function }} [args.logger]
 */
export async function assertChainIdMatchesRpc({ authConfig, gateway, logger } = {}) {
  const gatewayEnabled = typeof gateway?.isEnabled === "function" && gateway.isEnabled() === true;
  if (!gatewayEnabled) {
    return; // no live chain to verify against
  }
  const configuredChainId = normalizeChainId(authConfig?.chainId);
  if (!(configuredChainId > 0)) {
    return; // no configured chain id (e.g. dev/permissive) — nothing to compare
  }
  let reportedChainId;
  try {
    const network = await gateway.provider.getNetwork();
    reportedChainId = Number(network.chainId);
  } catch (error) {
    logger?.warn?.(
      {
        configuredChainId,
        rpc: gateway?.config?.rpcUrl,
        err: error instanceof Error ? error.message : String(error)
      },
      "startup.chain_id_unverified"
    );
    return;
  }
  if (reportedChainId !== configuredChainId) {
    throw new ConfigError(
      `Chain-id mismatch: configured AUTH_CHAIN_ID=${configuredChainId} but the RPC ` +
        `(${gateway?.config?.rpcUrl ?? "?"}) reports chain id ${reportedChainId}. Refusing to boot against ` +
        `the wrong chain — align AUTH_CHAIN_ID and the RPC URL to the same network.`
    );
  }
  logger?.info?.(
    { chainId: configuredChainId, rpc: gateway?.config?.rpcUrl },
    "startup.chain_id_verified"
  );
}

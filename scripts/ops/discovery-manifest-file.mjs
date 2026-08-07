import {
  buildDiscoveryManifest,
  POLKADOT_HUB_MAINNET_CHAIN_ID
} from "../../mcp-server/src/core/discovery-manifest.js";

export const PRODUCTION_DISCOVERY_BASE_URL = "https://api.averray.com";

export function buildProductionDiscoveryManifestContent() {
  return `${JSON.stringify(buildDiscoveryManifest({
    baseUrl: PRODUCTION_DISCOVERY_BASE_URL,
    chainId: POLKADOT_HUB_MAINNET_CHAIN_ID
  }), null, 2)}\n`;
}

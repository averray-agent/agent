export const DISCOVERY_ALIAS_PATHS = Object.freeze([
  "/.well-known/ai-agent.json",
  "/.well-known/agent-card.json"
]);

// Project descriptive metadata, including the same MCP catalog and auth
// requirements as the main manifest, without spreading execution endpoints.
// Neither filename is a claim to implement another agent protocol.
export function buildDiscoveryAlias(manifest, pricing, { card = false } = {}) {
  return {
    name: manifest.name,
    url: new URL("/", manifest.discoveryUrl).href,
    description: manifest.description,
    discoveryMode: manifest.discoveryMode,
    capabilities: manifest.tools,
    ...(manifest.contact ? { contact: manifest.contact } : {}),
    ...(!card ? {
      auth: {
        scheme: manifest.auth.scheme,
        schemeId: manifest.auth.schemeId,
        supportedWalletModes: manifest.auth.supportedWalletModes
      }
    } : {}),
    // The same request-time document as /.well-known/x402, including empty
    // resources when no paid door is available. No cached or fallback price.
    pricing
  };
}

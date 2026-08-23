/**
 * Format only server-projected asset identity. The UI deliberately does not
 * infer a token or chain from an asset symbol alone.
 *
 * @param {{ assetContext?: unknown, result?: unknown }} input
 * @returns {string | undefined}
 */
export function formatReceiptAssetLine({ assetContext, result } = {}) {
  if (!assetContext || typeof assetContext !== "object" || Array.isArray(assetContext)) return undefined;
  const symbol = nonEmpty(assetContext.symbol);
  const chain = nonEmpty(assetContext.chain);
  const chainName = nonEmpty(assetContext.chainName);
  if (!symbol || !chain || !chainName) return undefined;

  if (chainName === "Polkadot Hub" && Number.isInteger(assetContext.assetId)) {
    const prefix = result === "PASS" ? "Settled in" : "Settlement asset";
    return `${prefix} Hub ${symbol} · ${chainName} (${chain}) · asset ${assetContext.assetId}`;
  }
  if (chainName === "Base") {
    const prefix = result === "PASS" || result === "FAIL" ? "Billed in" : "Billing asset";
    return `${prefix} Base ${symbol} (${chain})`;
  }
  return undefined;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

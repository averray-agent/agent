import { DEFAULT_ESCROW_ASSET, normalizeAssetSymbol } from "./assets.js";
import {
  POLKADOT_HUB_MAINNET_CHAIN_ID,
  resolveHubNetwork
} from "./discovery-manifest.js";
import {
  VERIFY_X402_CHAIN_NAME,
  VERIFY_X402_NETWORK,
  resolveX402VerificationPresentationAsset
} from "../payments/x402-verification-payment-gate.js";

export const PRESENTATION_LANES = Object.freeze({
  settlement: "settlement",
  verifyBilling: "verify_billing"
});

const RESULT_BY_OUTCOME = Object.freeze({
  approved: "PASS",
  rejected: "FAIL",
  inconclusive: "INCONCLUSIVE",
  platform_fault: "PLATFORM_FAULT"
});

/** Consumer-facing projection only. Canonical verdict.outcome stays untouched. */
export function presentResult(outcome) {
  return RESULT_BY_OUTCOME[outcome];
}

/**
 * Present the chain-bound asset identity for one economic lane. Unknown assets
 * fail closed so a legacy/non-canonical symbol is never mislabeled as Hub or
 * Base USDC.
 */
export function presentAssetContext(lane, symbol, { env = process.env } = {}) {
  const normalizedSymbol = normalizeAssetSymbol(symbol, "");
  if (normalizedSymbol !== DEFAULT_ESCROW_ASSET.symbol) return undefined;

  if (lane === PRESENTATION_LANES.settlement) {
    const network = resolveHubNetwork(POLKADOT_HUB_MAINNET_CHAIN_ID);
    return {
      symbol: DEFAULT_ESCROW_ASSET.symbol,
      chain: `eip155:${POLKADOT_HUB_MAINNET_CHAIN_ID}`,
      chainName: network.name,
      assetId: DEFAULT_ESCROW_ASSET.assetId,
      token: DEFAULT_ESCROW_ASSET.address
    };
  }

  if (lane === PRESENTATION_LANES.verifyBilling) {
    const configured = resolveX402VerificationPresentationAsset(env);
    if (!configured || configured.network !== VERIFY_X402_NETWORK) return undefined;
    return {
      symbol: DEFAULT_ESCROW_ASSET.symbol,
      chain: configured.network,
      chainName: VERIFY_X402_CHAIN_NAME,
      token: configured.asset
    };
  }

  return undefined;
}

export function receiptPresentationFields(document, options = {}) {
  const result = presentResult(document?.verdict?.outcome);
  const verifyLane = document?.intent?.specSource === "verify_request";
  const symbol = verifyLane
    ? document?.intent?.valueAtRisk?.asset
    : document?.settlement?.assetSymbol
      ?? document?.settlement?.asset
      ?? document?.intent?.valueAtRisk?.asset
      ?? DEFAULT_ESCROW_ASSET.symbol;
  const assetContext = presentAssetContext(
    verifyLane ? PRESENTATION_LANES.verifyBilling : PRESENTATION_LANES.settlement,
    symbol,
    options
  );
  return compact({ result, assetContext });
}

export function decorateReceiptPresentation(document, options = {}) {
  return {
    ...document,
    ...receiptPresentationFields(document, options)
  };
}

export function decorateVerificationRunPresentation(run, options = {}) {
  const result = presentResult(run?.verdict?.outcome);
  const assetContext = presentAssetContext(
    PRESENTATION_LANES.verifyBilling,
    run?.billing?.asset,
    options
  );
  return { ...run, ...compact({ result, assetContext }) };
}

export function decorateJobPresentation(job) {
  const assetContext = presentAssetContext(
    PRESENTATION_LANES.settlement,
    job?.rewardAsset ?? DEFAULT_ESCROW_ASSET.symbol
  );
  return { ...job, ...compact({ assetContext }) };
}

export function decorateJobEstimatePresentation(estimate) {
  const assetContext = presentAssetContext(
    PRESENTATION_LANES.settlement,
    DEFAULT_ESCROW_ASSET.symbol
  );
  const body = estimate && typeof estimate === "object" && !Array.isArray(estimate)
    ? estimate
    : { netReward: estimate };
  return { ...body, ...compact({ assetContext }) };
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_ESCROW_ASSET } from "./assets.js";
import { POLKADOT_HUB_MAINNET_CHAIN_ID } from "./discovery-manifest.js";
import {
  PRESENTATION_LANES,
  decorateJobEstimatePresentation,
  decorateReceiptPresentation,
  decorateVerificationRunPresentation,
  presentAssetContext,
  presentResult
} from "./verdict-presentation.js";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const VERIFY_ENV = {
  X402_PAYMENT_NETWORK: "eip155:8453",
  X402_PAYMENT_ASSET_ADDRESS: BASE_USDC
};

test("presentResult exposes only the four consumer verdict tokens", () => {
  assert.equal(presentResult("approved"), "PASS");
  assert.equal(presentResult("rejected"), "FAIL");
  assert.equal(presentResult("inconclusive"), "INCONCLUSIVE");
  assert.equal(presentResult("platform_fault"), "PLATFORM_FAULT");
  for (const outcome of [undefined, null, "", "unknown", "PASS", "approved "]) {
    assert.equal(presentResult(outcome), undefined);
  }
});

test("presentAssetContext binds settlement USDC to the canonical Hub asset", () => {
  assert.deepEqual(
    presentAssetContext(PRESENTATION_LANES.settlement, "USDC"),
    {
      symbol: DEFAULT_ESCROW_ASSET.symbol,
      chain: `eip155:${POLKADOT_HUB_MAINNET_CHAIN_ID}`,
      chainName: "Polkadot Hub",
      assetId: DEFAULT_ESCROW_ASSET.assetId,
      token: DEFAULT_ESCROW_ASSET.address
    }
  );
});

test("presentAssetContext reads Verify billing identity from the x402 configuration", () => {
  assert.deepEqual(
    presentAssetContext(PRESENTATION_LANES.verifyBilling, "USDC", { env: VERIFY_ENV }),
    {
      symbol: "USDC",
      chain: "eip155:8453",
      chainName: "Base",
      token: BASE_USDC.toLowerCase()
    }
  );
  assert.equal(
    presentAssetContext(PRESENTATION_LANES.verifyBilling, "USDC", { env: {} }),
    undefined
  );
  assert.equal(presentAssetContext(PRESENTATION_LANES.settlement, "DOT"), undefined);
});

test("receipt and Verify-run decoration is additive and never rewrites canonical outcomes", () => {
  const stored = {
    verdict: { outcome: "approved", reasonCode: "DETERMINISTIC_MATCH" },
    intent: {
      specSource: "verify_request",
      poster: "0x1111111111111111111111111111111111111111",
      valueAtRisk: { asset: "USDC", amountRaw: "5000000" }
    }
  };
  const before = structuredClone(stored);
  const served = decorateReceiptPresentation(stored, { env: VERIFY_ENV });
  assert.deepEqual(stored, before);
  assert.equal(served.verdict.outcome, "approved");
  assert.equal(served.result, "PASS");
  assert.equal(served.buyer, stored.intent.poster);
  assert.equal(served.assetContext.chainName, "Base");
  assert.equal(Object.hasOwn(stored, "result"), false);
  assert.equal(Object.hasOwn(stored, "buyer"), false);

  const run = decorateVerificationRunPresentation({
    verdict: { outcome: "platform_fault" },
    billing: { status: "not_billed", asset: "USDC" }
  }, { env: VERIFY_ENV });
  assert.equal(run.result, "PLATFORM_FAULT");
  assert.equal(run.billing.status, "not_billed");
  assert.equal(run.assetContext.chain, "eip155:8453");
});

test("buyer is a serve-time alias of the funding poster in both job and Verify lanes", () => {
  const jobPoster = "0x1111111111111111111111111111111111111111";
  const verifyCustomer = "0x2222222222222222222222222222222222222222";
  const jobDocument = {
    intent: { specSource: "chain_verified", poster: jobPoster },
    verdict: { outcome: "approved" }
  };
  const verifyDocument = {
    intent: { specSource: "verify_request", poster: verifyCustomer },
    verdict: { outcome: "rejected" }
  };

  assert.equal(decorateReceiptPresentation(jobDocument).buyer, jobPoster);
  assert.equal(decorateReceiptPresentation(verifyDocument, { env: VERIFY_ENV }).buyer, verifyCustomer);
  assert.equal(Object.hasOwn(jobDocument, "buyer"), false);
  assert.equal(Object.hasOwn(verifyDocument, "buyer"), false);
});

test("path-addressed job estimate wraps the scalar without changing its value", () => {
  const presented = decorateJobEstimatePresentation(0.4);
  assert.equal(presented.netReward, 0.4);
  assert.equal(presented.assetContext.chainName, "Polkadot Hub");
  assert.equal(Object.hasOwn(presented, "result"), false);
});

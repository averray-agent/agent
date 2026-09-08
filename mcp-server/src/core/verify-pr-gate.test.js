import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { TypedDataEncoder } from "ethers";

import { hashCanonicalContent } from "./canonical-content.js";
import { buildX402DiscoveryDocument } from "../payments/x402-discovery.js";
import { X402VerificationPaymentGate } from "../payments/x402-verification-payment-gate.js";
import { VerificationProfileRegistry } from "../services/verification-profile-registry.js";
import { validateVerificationRunRequest } from "../services/verification-run-service.js";

const root = new URL("../../../", import.meta.url);
const recipe = () => readFileSync(new URL("docs/VERIFY_PR_GATE.md", root), "utf8");
const profiles = new VerificationProfileRegistry();
const domain = {
  name: "USD Coin", version: "2", chainId: 8453,
  verifyingContract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
};
function gate() {
  return new X402VerificationPaymentGate({
    config: {
      enabled: true, mode: "enabled", network: "eip155:8453", chainId: 8453,
      rpcUrl: "https://base.example.test", asset: domain.verifyingContract,
      payTo: "0x1013e3fe3f6deb4e61dc023ff69d420dd9ce8f9f",
      assetEip712Name: domain.name, assetEip712Version: domain.version,
      publicOrigin: "https://api.averray.com", captureMarginSeconds: 600
    },
    provider: { async getNetwork() { return { chainId: 8453n }; } },
    tokenContract: {
      async name() { return domain.name; },
      async DOMAIN_SEPARATOR() { return TypedDataEncoder.hashDomain(domain); }
    },
    captureTokenContract: { transferWithAuthorization() { assert.fail("recipe tests never pay"); } }
  });
}

test("Verify buyer discovery has exactly one resource, the Verify run door", async () => {
  const document = await buildX402DiscoveryDocument({ paymentGate: gate(), profiles: profiles.list() });
  assert.equal(document.resources.length, 1);
  assert.equal(document.resources[0].resource, "https://api.averray.com/verify/runs");
});

test("Verify recipe and Verify copy contain no Hub chain or asset identifiers", () => {
  for (const path of [
    "docs/VERIFY_PR_GATE.md",
    "mcp-server/src/core/verify-product-copy.js",
    "mcp-server/src/services/verification-profile-registry.js",
    "mcp-server/src/protocols/http/verify-routes.js",
    "mcp-server/src/payments/x402-verification-payment-gate.js"
  ]) {
    assert.doesNotMatch(readFileSync(new URL(path, root), "utf8"), /420420419|\b1337\b/u, path);
  }
});

test("Verify buyer challenge pins exact Base constants without a recipe price literal", async () => {
  const paymentGate = gate();
  for (const profile of profiles.list()) {
    const request = profile.workedExample.request;
    await assert.rejects(paymentGate.authorize({
      price: profile.price, profile: profile.ref, profileLimits: profile.limits,
      requestHash: hashCanonicalContent({ profile: profile.ref, target: request.target, inputs: request.inputs })
    }), (error) => {
      assert.equal(error.statusCode, 402);
      const terms = error.details.paymentRequired.accepts[0];
      assert.equal(terms.network, "eip155:8453");
      assert.equal(terms.asset, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
      assert.equal(terms.payTo, "0x1013e3fe3f6deb4e61dc023ff69d420dd9ce8f9f");
      assert.equal(terms.amount, "5000000");
      assert.equal(profile.price.billingRule, "inconclusive_not_billed");
      assert.equal(error.details.paymentRequired.billingRule, undefined);
      return true;
    });
  }
  assert.doesNotMatch(recipe(), /5000000|\b5(?:\.0+)?\s*USDC|\$5\b/u);
  for (const value of ["eip155:8453", domain.verifyingContract, "0x1013e3fe3f6deb4e61dc023ff69d420dd9ce8f9f"])
    assert.ok(recipe().includes(value));
});

test("Verify recipe worked requests match the published registry and validate before payment", () => {
  const examples = [...recipe().matchAll(/```json\n([\s\S]*?)\n```/gu)].map((match) => JSON.parse(match[1]));
  assert.deepEqual(examples.map((request) => request.profile), ["mcp-failure-semantics-v1", "git-patch-tests-v1"]);
  for (const request of examples) {
    const profile = profiles.get(request.profile, request.profileVersion);
    assert.deepEqual(request, profile.workedExample.request);
    assert.doesNotThrow(() => validateVerificationRunRequest(request, profiles));
    const malformed = { ...request };
    delete malformed.inputs;
    assert.throws(() => validateVerificationRunRequest(malformed, profiles));
  }
});

test("Verify recipe CI guard runs no live paid POST", async (context) => {
  context.mock.method(globalThis, "fetch", () => assert.fail("no network or paid POST in recipe CI"));
  // Execute the same published construction with all chain reads injected. The
  // documentary purchase command is never executed by this test or a workflow.
  await buildX402DiscoveryDocument({ paymentGate: gate(), profiles: profiles.list() });
  for (const name of readdirSync(new URL(".github/workflows/", root))) {
    if (!/\.ya?ml$/u.test(name)) continue;
    const workflow = readFileSync(new URL(`.github/workflows/${name}`, root), "utf8");
    assert.doesNotMatch(workflow, /api\.averray\.com\/verify\/runs/u, name);
    assert.doesNotMatch(workflow, /(?:PAYMENT-SIGNATURE|X-PAYMENT|VERIFICATION-PAYMENT)\s*:/iu, name);
  }
});

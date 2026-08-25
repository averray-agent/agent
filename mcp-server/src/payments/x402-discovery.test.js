import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { TypedDataEncoder } from "ethers";

import { hashCanonicalContent } from "../core/canonical-content.js";
import { VerificationProfileRegistry } from "../services/verification-profile-registry.js";
import { CdpSettlementAdapter } from "./adapters/cdp/settlement-adapter.js";
import {
  assertBaseOnlyX402Surface,
  buildX402DiscoveryDocument
} from "./x402-discovery.js";
import { X402VerificationPaymentGate } from "./x402-verification-payment-gate.js";

const ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PAY_TO = "0x1013e3fe3f6deb4e61dc023ff69d420dd9ce8f9f";
const DOMAIN = Object.freeze({
  name: "USD Coin",
  version: "2",
  chainId: 8453,
  verifyingContract: ASSET
});

function makeGate() {
  return new X402VerificationPaymentGate({
    config: {
      enabled: true,
      mode: "enabled",
      network: "eip155:8453",
      chainId: 8453,
      rpcUrl: "https://base.example.test",
      asset: ASSET,
      payTo: PAY_TO,
      assetEip712Name: "USD Coin",
      assetEip712Version: "2",
      publicOrigin: "https://api.averray.com",
      captureMarginSeconds: 600
    },
    provider: { async getNetwork() { return { chainId: 8453n }; } },
    tokenContract: {
      async name() { return DOMAIN.name; },
      async DOMAIN_SEPARATOR() { return TypedDataEncoder.hashDomain(DOMAIN); }
    },
    captureTokenContract: {}
  });
}

async function liveChallenge(gate, profile) {
  const request = profile.workedExample.request;
  const requestHash = hashCanonicalContent({
    profile: profile.ref,
    target: request.target,
    inputs: request.inputs
  });
  try {
    await gate.authorize({
      paymentProof: undefined,
      price: profile.price,
      profile: profile.ref,
      profileLimits: profile.limits,
      requestHash
    });
  } catch (error) {
    assert.equal(error.statusCode, 402);
    return error.details.paymentRequired;
  }
  assert.fail("an unpaid Verify request must return its live 402 challenge");
}

test("x402 discovery requirements are byte-equal to the live Verify 402 for the same request", async () => {
  const gate = makeGate();
  const profiles = new VerificationProfileRegistry().list();
  const document = await buildX402DiscoveryDocument({ paymentGate: gate, profiles });

  assert.equal(document.x402Version, 2);
  assert.equal(document.resources.length, 1);
  const [resource] = document.resources;
  assert.equal(resource.resource, "https://api.averray.com/verify/runs");
  assert.equal(resource.method, "POST");
  assert.equal(resource.inputContract.url, "https://api.averray.com/verify/profiles");
  assert.equal(resource.maxAmountRequired, "5000000");
  assert.equal(resource.accepts.length, profiles.length);

  for (const profile of profiles) {
    const advertised = resource.accepts.find((entry) => entry.extra.profile === profile.ref);
    const challenge = await liveChallenge(gate, profile);
    assert.ok(advertised, `${profile.ref} must be discoverable`);
    assert.equal(
      Buffer.from(JSON.stringify(advertised)).toString("hex"),
      Buffer.from(JSON.stringify(challenge.accepts[0])).toString("hex"),
      `${profile.ref} discovery bytes must equal its live challenge bytes`
    );
  }
});

test("x402 copy lock refuses Hub payment requirements and Hub-paired descriptions", async () => {
  const document = await buildX402DiscoveryDocument({
    paymentGate: makeGate(),
    profiles: new VerificationProfileRegistry().list()
  });
  assert.doesNotThrow(() => assertBaseOnlyX402Surface(document));

  const wrongNetwork = structuredClone(document);
  wrongNetwork.resources[0].accepts[0].network = "eip155:420420419";
  assert.throws(
    () => assertBaseOnlyX402Surface(wrongNetwork),
    /must be eip155:8453 \(Base\)/u
  );

  const wrongCopy = structuredClone(document);
  wrongCopy.resources[0].description = "Pay this x402 requirement on eip155:420420419.";
  assert.throws(
    () => assertBaseOnlyX402Surface(wrongCopy),
    /pairs x402 with Polkadot Hub/u
  );

  for (const source of [
    "./x402-verification-payment-gate.js",
    "./x402-poster-ramp.js",
    "../protocols/http/external-job-routes.js"
  ]) {
    assert.doesNotMatch(
      readFileSync(new URL(source, import.meta.url), "utf8"),
      /eip155:420420419/u,
      `${source} must not publish a Hub x402 requirement`
    );
  }
});

test("POST /jobs/x402 refuses a non-Base payment with a named network reason", async () => {
  const gate = makeGate();
  const [profile] = new VerificationProfileRegistry().list();
  const challenge = await liveChallenge(gate, profile);
  const requirements = challenge.accepts[0];
  const accepted = structuredClone(requirements);
  accepted.network = "eip155:420420419";
  let fetchCalls = 0;
  const adapter = new CdpSettlementAdapter({
    config: {
      baseUrl: new URL("https://api.cdp.coinbase.com/platform/v2/x402"),
      apiKeyId: "test-key",
      apiKeySecret: Buffer.alloc(32, 1).toString("base64"),
      timeoutMs: 1_000
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      assert.fail("a non-Base payload must be refused before the facilitator call");
    }
  });
  const paymentProof = Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted,
    payload: { authorization: {} }
  })).toString("base64");

  await assert.rejects(
    () => adapter.verify({ paymentProof, requirements }),
    (error) => error.code === "payment_requirements_mismatch"
      && error.details?.field === "network"
      && error.details?.posterFunds === "unchanged"
  );
  assert.equal(fetchCalls, 0);
});

test("the existing Verify 402 envelope remains byte-identical", async () => {
  const gate = makeGate();
  const [profile] = new VerificationProfileRegistry().list();
  const challenge = await liveChallenge(gate, profile);
  const request = profile.workedExample.request;
  const requestHash = hashCanonicalContent({
    profile: profile.ref,
    target: request.target,
    inputs: request.inputs
  });

  assert.deepEqual(challenge, {
    x402Version: 2,
    error: "Payment required to run this Averray verification profile.",
    resource: {
      url: "https://api.averray.com/verify/runs",
      description: "Run a pinned Averray verification profile. Inconclusive runs are never charged.",
      mimeType: "application/json",
      serviceName: "Averray Verify"
    },
    accepts: [{
      scheme: "exact",
      network: "eip155:8453",
      asset: ASSET,
      amount: "5000000",
      payTo: PAY_TO,
      maxTimeoutSeconds: 720,
      extra: {
        name: "USD Coin",
        version: "2",
        profile: "git-patch-tests-v1@1",
        requestHash
      }
    }]
  });
});

test("disabled x402 Verify configuration advertises no paid resource", async () => {
  assert.deepEqual(
    await buildX402DiscoveryDocument({ paymentGate: undefined, profiles: [] }),
    { x402Version: 2, resources: [] }
  );
});

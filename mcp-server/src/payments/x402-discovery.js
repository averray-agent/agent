import { hashCanonicalContent } from "../core/canonical-content.js";
import { ConfigError } from "../core/errors.js";
import { VERIFY_X402_NETWORK } from "./x402-verification-payment-gate.js";

export const X402_DISCOVERY_PATH = "/.well-known/x402";

/**
 * Self-owned x402 discovery for the paid Verify door.
 *
 * Verify binds every authorization to profile@version plus the exact request
 * hash, so a single unbound "price object" would not be a payment requirement
 * the live endpoint accepts. Each advertised requirement is therefore bound to
 * the corresponding published worked example. An agent replaces the example
 * values, requests a fresh 402, and signs the returned accepts[0] unchanged.
 */
export async function buildX402DiscoveryDocument({
  paymentGate,
  profiles = []
} = {}) {
  if (!paymentGate) {
    return {
      x402Version: 2,
      resources: []
    };
  }

  const publishedProfiles = profiles.filter((profile) => (
    profile?.status === "published"
    && profile?.availability?.status !== "unavailable"
  ));
  if (publishedProfiles.length === 0) {
    return {
      x402Version: 2,
      resources: []
    };
  }

  const domain = await paymentGate.eip712Domain();
  const resource = paymentGate.paymentResource();
  const accepts = publishedProfiles.map((profile) => {
    const request = requireWorkedExample(profile);
    const requestHash = hashCanonicalContent({
      profile: profile.ref,
      target: request.target,
      inputs: request.inputs
    });
    return paymentGate.paymentRequirements({
      domain,
      price: profile.price,
      profile: profile.ref,
      profileLimits: profile.limits,
      requestHash
    });
  });
  const document = {
    x402Version: 2,
    resources: [
      {
        resource: resource.url,
        type: "http",
        x402Version: 2,
        method: "POST",
        description: resource.description,
        mimeType: resource.mimeType,
        inputContract: {
          method: "GET",
          url: new URL("/verify/profiles", resource.url).toString(),
          mediaType: "application/json",
          requestExamples: "profiles[].workedExample.request",
          profileReference: "profiles[].ref",
          challenge: {
            method: "POST",
            status: 402,
            requirements: "accepts[0]",
            paymentRequiredHeader: "PAYMENT-REQUIRED",
            retryHeader: "PAYMENT-SIGNATURE"
          },
          completion: {
            initialStatus: "queued",
            poll: "GET /verify/runs/{runId}",
            capture: "approved_or_rejected_only",
            inconclusive: "not_billed"
          }
        },
        maxAmountRequired: maximumAmount(accepts),
        requirementsBinding: {
          advertisedFor: "profiles[].workedExample.request",
          finalRequest: "request_fresh_402_and_use_accepts_0_unchanged"
        },
        accepts
      }
    ]
  };
  assertBaseOnlyX402Surface(document);
  return document;
}

/**
 * Structural product lock: every x402 payment object is Base-only, and no
 * x402 description may pair the Hub chain id with a paid-hop claim.
 */
export function assertBaseOnlyX402Surface(value, path = "x402") {
  if (typeof value === "string") {
    if (/x402/iu.test(value) && value.includes("420420419")) {
      throw new ConfigError(`${path} pairs x402 with Polkadot Hub chain 420420419.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertBaseOnlyX402Surface(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;

  if (value.scheme === "exact" && "payTo" in value) {
    const network = String(value.network ?? "").toLowerCase();
    if (network !== VERIFY_X402_NETWORK) {
      throw new ConfigError(
        `${path}.network must be ${VERIFY_X402_NETWORK} (Base) for an x402 payment requirement; observed ${network || "missing"}.`
      );
    }
  }
  for (const [key, child] of Object.entries(value)) {
    assertBaseOnlyX402Surface(child, `${path}.${key}`);
  }
}

function requireWorkedExample(profile) {
  const request = profile?.workedExample?.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new ConfigError(
      `Published Verify profile ${String(profile?.ref ?? "unknown")} needs a workedExample.request before it can be advertised through x402 discovery.`
    );
  }
  if (request.profile !== profile.name || Number(request.profileVersion) !== Number(profile.version)) {
    throw new ConfigError(
      `Verify profile ${profile.ref} has a worked example for a different profile or version.`
    );
  }
  return request;
}

function maximumAmount(requirements) {
  let maximum = 0n;
  for (const requirement of requirements) {
    const amount = String(requirement?.amount ?? "");
    if (!/^\d+$/u.test(amount)) {
      throw new ConfigError("Advertised x402 amount must be an exact unsigned integer string.");
    }
    const parsed = BigInt(amount);
    if (parsed > maximum) maximum = parsed;
  }
  return maximum.toString();
}

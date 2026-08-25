import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildPlatformCapabilities } from "../../core/discovery-manifest.js";
import { createPublicMetadataRoutes } from "./public-metadata-routes.js";

const STRATEGIES = [
  { strategyId: "vdot-test", asset: "DOT", executionMode: "async_xcm" }
];
const PROVIDER_STATUS = {
  github: { ok: true, lastRun: { status: "success" } }
};
const WALLETLESS_ARRIVAL = {
  headline: "No wallet? Generate any EOA and earn from zero.",
  start: "Generate an EOA locally — free and offline. No funding is required to start.",
  proof: {
    summary: "A fresh-wallet run earned 0.40 USDC while the wallet nonce remained 0.",
    caseStudy: "https://github.com/averray-agent/agent/blob/main/docs/BLIND_AGENT_CASE_STUDY.md",
    pullRequest: "https://github.com/averray-agent/agent/pull/904"
  },
  limits: {
    waiverClaimsPerWallet: 3,
    waiverAppliesTo: "waiver-eligible starter jobs",
    withdrawal: "Withdrawal is an on-chain act."
  }
};
const PLATFORM_CAPABILITIES = {
  version: "v1",
  onboarding: {
    walletlessArrival: WALLETLESS_ARRIVAL,
    walletModes: [{ id: "siwe" }]
  }
};
const EXTERNAL_BOUNTIES = {
  mode: "allowlist",
  posterOnboarding: "/poster/onboarding"
};
const ACCOUNT_FUNDING = {
  routeAvailable: true,
  http: { method: "POST", path: "/account/deposit/transactions" },
  mcp: { tool: "buildAccountDepositTransactions" }
};
const WORKER_DOOR = {
  selfDeposit: ACCOUNT_FUNDING,
  accountFunding: ACCOUNT_FUNDING,
  withdrawal: { httpRouteAvailable: false }
};
const POSTER_ONBOARDING = {
  version: "poster-onboarding-v1",
  mode: "allowlist",
  minimumRewardUsdc: "1.25"
};

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const route = createPublicMetadataRoutes({
    authConfig: overrides.authConfig ?? { mode: "strict", chainId: 420420419 },
    buildDiscoveryManifest: (options) => {
      calls.push(["buildDiscoveryManifest", options]);
      return overrides.discoveryManifest ?? {
        version: "2026-05-24",
        baseUrl: options.baseUrl,
      };
    },
    minimumRewardUsdc: overrides.minimumRewardUsdc ?? "1.25",
    publicBaseUrl: overrides.publicBaseUrl ?? " https://api.averray.com ",
    getX402Discovery: async () => {
      calls.push(["getX402Discovery"]);
      return overrides.x402Discovery ?? { x402Version: 2, resources: [] };
    },
    posterOnboardingService: {
      getWorkerDoorOnboarding: async () => {
        calls.push(["getWorkerDoorOnboarding"]);
        return overrides.workerDoor ?? WORKER_DOOR;
      },
      getExternalBountiesOnboarding: async () => {
        calls.push(["getExternalBountiesOnboarding"]);
        return overrides.externalBounties ?? EXTERNAL_BOUNTIES;
      },
      getPosterOnboarding: async () => {
        calls.push(["getPosterOnboarding"]);
        return overrides.posterOnboarding ?? POSTER_ONBOARDING;
      }
    },
    lockedTierService: overrides.lockedTierService,
    respond: (res, statusCode, body, headers = {}) => {
      calls.push(["respond", { statusCode, body, headers }]);
      res.statusCode = statusCode;
      res.body = body;
      res.headers = headers;
    },
    respondText: (res, statusCode, body, headers = {}) => {
      calls.push(["respondText", { statusCode, body, headers }]);
      res.statusCode = statusCode;
      res.body = body;
      res.headers = { "content-type": "text/plain; charset=utf-8", ...headers };
    },
    service: {
      getPublicProviderOperations: async () => {
        calls.push(["getPublicProviderOperations"]);
        return overrides.providerStatus ?? PROVIDER_STATUS;
      },
      getPlatformCapabilities: (options) => {
        calls.push(["getPlatformCapabilities", options]);
        return overrides.platformCapabilities ?? PLATFORM_CAPABILITIES;
      }
    },
    strategies: overrides.strategies ?? STRATEGIES,
  });
  return { calls, response, route };
}

test("public metadata routes ignore unrelated paths and methods", async () => {
  const { calls, response, route } = makeHarness();

  assert.equal(await route({
    request: { method: "GET" },
    response,
    pathname: "/health",
  }), false);
  assert.equal(await route({
    request: { method: "POST" },
    response,
    pathname: "/onboarding",
  }), false);

  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("A2 arrival payload: GET / identifies Averray and points to site, docs, and API llms.txt", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    pathname: "/",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.name, "Averray");
  assert.equal(response.body.site, "https://averray.com");
  assert.equal(response.body.docs, "https://github.com/averray-agent/agent/tree/main/docs");
  assert.equal(response.body.llmsTxt, "https://api.averray.com/llms.txt");
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.authMode, "strict");
  assert.ok(response.body.endpoints.includes("/agent-tools.json"));
  assert.ok(response.body.endpoints.includes("/poster/onboarding"));
  assert.ok(response.body.endpoints.includes("/poster/jobs"));
  assert.ok(response.body.endpoints.includes("/llms.txt"));
  assert.ok(response.body.endpoints.includes("/.well-known/x402"));
  assert.ok(response.body.endpoints.includes("/jobs/x402"));
  assert.ok(response.body.endpoints.includes("/.well-known/badge-receipt-jwks.json"));
  assert.ok(response.body.endpoints.every((endpoint) => !endpoint.includes("/jobs/draft")));
  assert.ok(!response.body.endpoints.includes("/strategies"));
  assert.ok(!response.body.endpoints.includes("/account/strategies"));
  assert.deepEqual(response.body.receiptVerification, {
    badgeReceipts: {
      alg: "ES256",
      kid: "badge-1",
      jwksUrl: "https://api.averray.com/.well-known/badge-receipt-jwks.json",
      canonicalizationDocs: "https://github.com/averray-agent/agent/blob/main/docs/schemas/agent-badge-v1.md#exact-canonicalization-and-signing-bytes"
    },
    runReceipts: {
      alg: "ES256",
      kid: "badge-1",
      jwksUrl: "https://api.averray.com/.well-known/badge-receipt-jwks.json",
      canonicalPath: "/badges/:sessionId/run",
      schema: "https://raw.githubusercontent.com/averray-agent/agent/main/docs/schemas/run-receipt-v1.json",
      canonicalizationDocs: "https://github.com/averray-agent/agent/blob/main/docs/schemas/run-receipt-v1.md#signature-and-canonical-bytes"
    },
    workReceipts: {
      alg: "ES256",
      kid: "badge-1",
      jwksUrl: "https://api.averray.com/.well-known/badge-receipt-jwks.json",
      canonicalPath: "/receipts/:receiptId",
      publicPage: "https://averray.com/receipts/:receiptId",
      schema: "https://raw.githubusercontent.com/averray-agent/agent/main/docs/schemas/work-receipt-v1.json",
      canonicalizationDocs: "https://github.com/averray-agent/agent/blob/main/docs/schemas/work-receipt-v1.md#content-address-and-signature"
    }
  });
  assert.ok(response.body.endpoints.includes("/status/providers") === false);
  assert.deepEqual(calls, [
    ["respond", { statusCode: 200, body: response.body, headers: {} }],
  ]);
});

test("GET /.well-known/x402 is public cacheable and contains no wallet-specific data", async () => {
  const discovery = {
    x402Version: 2,
    resources: [{
      resource: "https://api.averray.com/verify/runs",
      method: "POST",
      accepts: [{
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        amount: "5000000",
        payTo: "0x1013e3fe3f6deb4e61dc023ff69d420dd9ce8f9f",
        extra: { name: "USD Coin", version: "2" }
      }]
    }]
  };
  const { calls, response, route } = makeHarness({ x402Discovery: discovery });

  assert.equal(await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/.well-known/x402"
  }), true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, discovery);
  assert.deepEqual(response.headers, { "cache-control": "public, max-age=300" });
  assert.doesNotMatch(JSON.stringify(response.body), /wallet|visitor|clientIp|userAgent/iu);
  assert.deepEqual(calls, [
    ["getX402Discovery"],
    ["respond", { statusCode: 200, body: discovery, headers: response.headers }]
  ]);
});

test("GET /status/providers returns sanitized provider operations", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    pathname: "/status/providers",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, PROVIDER_STATUS);
  assert.deepEqual(calls, [
    ["getPublicProviderOperations"],
    ["respond", { statusCode: 200, body: PROVIDER_STATUS, headers: {} }],
  ]);
});

test("A1 arrival payload: GET /onboarding keeps earn-from-zero proof and limits together", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    pathname: "/onboarding",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ...PLATFORM_CAPABILITIES,
    workerDoor: WORKER_DOOR,
    externalBounties: EXTERNAL_BOUNTIES
  });
  assert.match(response.body.onboarding.walletlessArrival.headline, /earn from zero/u);
  assert.match(response.body.onboarding.walletlessArrival.proof.summary, /0\.40 USDC/u);
  assert.match(response.body.onboarding.walletlessArrival.proof.summary, /nonce remained 0/u);
  assert.equal(response.body.onboarding.walletlessArrival.limits.waiverClaimsPerWallet, 3);
  assert.equal(
    response.body.onboarding.walletlessArrival.limits.waiverAppliesTo,
    "waiver-eligible starter jobs"
  );
  assert.match(response.body.onboarding.walletlessArrival.limits.withdrawal, /on-chain act/u);
  assert.deepEqual(response.headers, { "cache-control": "public, max-age=30" });
  // The route must forward the active chain id so /onboarding advertises the
  // same network as /health and SIWE.
  assert.deepEqual(calls, [
    ["getWorkerDoorOnboarding"],
    ["getExternalBountiesOnboarding"],
    ["getPlatformCapabilities", { chainId: 420420419 }],
    ["respond", {
      statusCode: 200,
      body: response.body,
      headers: { "cache-control": "public, max-age=30" }
    }],
  ]);
});

test("GET /onboarding serves the derived account parity section without an app-session adoption path", async () => {
  const platformCapabilities = buildPlatformCapabilities({ chainId: 420420419 });
  const { response, route } = makeHarness({ platformCapabilities });

  assert.equal(await route({
    request: { method: "GET" },
    response,
    pathname: "/onboarding"
  }), true);
  const parity = response.body.onboarding.agentSurfaceParity;
  assert.equal(parity.actions.length, 9);
  assert.ok(parity.actions.some((action) => (
    action.agentSurface.httpRoutes?.includes("GET /reputation")
  )));
  assert.match(parity.completeForAccounts, /complete for accounts/u);
  assert.match(parity.appSessionBoundary, /cannot adopt an API session/u);
  assert.equal(Object.hasOwn(parity, "sessionAdoption"), false);
  assert.equal(parity.actions.some((action) => /JWT|token|adopt/iu.test(JSON.stringify(action))), false);
});

test("platform capabilities expose the flag-off locked-tier gate without inventing yield", async () => {
  const lockedDeposits = {
    enabled: false,
    activationGate: { open: false, statement: "yield inactive — pool below activation threshold." }
  };
  const { response, route } = makeHarness({
    lockedTierService: { getCapability: async () => lockedDeposits }
  });

  await route({
    request: { method: "GET" },
    response,
    pathname: "/onboarding",
  });

  assert.deepEqual(response.body.products.lockedDeposits, lockedDeposits);
  assert.deepEqual(response.body.onboarding.lockedDeposits, lockedDeposits);
});

test("A3 arrival payload: GET /llms.txt serves the agent-adjusted API-host mirror", async () => {
  const { calls, response, route } = makeHarness();
  const siteLlms = readFileSync(new URL("../../../../site/llms.txt", import.meta.url), "utf8");

  assert.equal(await route({
    request: { method: "GET" },
    response,
    pathname: "/llms.txt"
  }), true);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(response.headers["cache-control"], "public, max-age=300");
  assert.match(response.body, /^# Averray/mu);
  assert.match(response.body, /earn real USDC/u);
  assert.match(response.body, /No funding is required to start/u);
  assert.match(response.body, /Already have a managed wallet \(Cloudflare Wallets, Coinbase, or similar\)/u);
  assert.match(response.body, /payment rails and can't sign on this chain/u);
  assert.match(response.body, /same key works on any EVM chain/u);
  assert.match(response.body, /Eligible workers can request Averray's one-time first-withdrawal DOT grant/u);
  assert.match(response.body, /waiver is capped at 3 claims per wallet/u);
  assert.match(response.body, /Withdrawal is an on-chain act/u);
  assert.match(response.body, /docs\/BLIND_AGENT_CASE_STUDY\.md/u);
  assert.match(response.body, /https:\/\/api\.averray\.com\/onboarding/u);
  for (const sharedFact of [
    "earn real USDC",
    "No funding is required to start",
    "Already have a managed wallet",
    "same key works on any EVM chain",
    "waiver is capped at 3 claims per wallet",
    "Withdrawal is an on-chain act"
  ]) {
    assert.match(siteLlms, new RegExp(sharedFact, "u"));
    assert.match(response.body, new RegExp(sharedFact, "u"));
  }
  assert.deepEqual(calls, [["respondText", {
    statusCode: 200,
    body: response.body,
    headers: { "cache-control": "public, max-age=300" }
  }]]);
});

test("GET /poster/onboarding is public and short-cacheable", async () => {
  const { calls, response, route } = makeHarness();

  assert.equal(await route({
    request: { method: "GET" },
    response,
    pathname: "/poster/onboarding"
  }), true);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, POSTER_ONBOARDING);
  assert.deepEqual(response.headers, { "cache-control": "public, max-age=30" });
  assert.deepEqual(calls, [
    ["getPosterOnboarding"],
    ["respond", {
      statusCode: 200,
      body: POSTER_ONBOARDING,
      headers: { "cache-control": "public, max-age=30" }
    }]
  ]);
});

test("GET discovery manifest mirrors trim the public base URL and cache the response", async () => {
  for (const pathname of ["/agent-tools.json", "/.well-known/agent-tools.json"]) {
    const { calls, response, route } = makeHarness();

    const handled = await route({
      request: { method: "GET" },
      response,
      pathname,
    });

    assert.equal(handled, true);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      version: "2026-05-24",
      baseUrl: "https://api.averray.com",
    });
    assert.deepEqual(response.headers, { "cache-control": "public, max-age=300" });
    assert.deepEqual(calls, [
      ["buildDiscoveryManifest", {
        baseUrl: "https://api.averray.com",
        chainId: 420420419,
        minimumRewardUsdc: "1.25"
      }],
      ["respond", {
        statusCode: 200,
        body: response.body,
        headers: { "cache-control": "public, max-age=300" }
      }],
    ]);
  }
});

test("GET /strategies returns the retired surface and DepositPool pointers", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    pathname: "/strategies",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "retired");
  assert.equal(response.body.retired, true);
  assert.deepEqual(response.body.strategies, []);
  assert.deepEqual(response.body.see, {
    pool: "/pool",
    onboarding: "/onboarding#buildVestedCapacity"
  });
  assert.deepEqual(response.headers, { "cache-control": "public, max-age=300" });
  assert.deepEqual(calls, [
    ["respond", {
      statusCode: 200,
      body: response.body,
      headers: { "cache-control": "public, max-age=300" }
    }],
  ]);
});

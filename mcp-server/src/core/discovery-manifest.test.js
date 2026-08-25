import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildDiscoveryManifest,
  buildPlatformCapabilities,
  POLKADOT_HUB_MAINNET_CHAIN_ID,
  POLKADOT_HUB_TESTNET_CHAIN_ID
} from "./discovery-manifest.js";
import { DEPOSIT_POOL_RISK_DISCLOSURE } from "./deposit-pool-disclosure.js";

test("buildDiscoveryManifest returns the full public discovery shape", () => {
  const manifest = buildDiscoveryManifest({
    baseUrl: "https://api.example.com",
    discoveryUrl: "https://example.com/.well-known/agent-tools.json",
    profile: "https://app.example.com/agents/<wallet>",
    operatorAppUrl: "https://app.example.com",
    chainId: 420420417,
    minimumRewardUsdc: "1.25",
    rpcUrl: "https://eth-rpc-testnet.polkadot.io"
  });

  assert.equal(manifest.version, "0.5.0");
  assert.equal(manifest.discoveryMode, "directory-safe");
  assert.deepEqual(manifest.products, {
    verify: {
      summary: "Paid verification runs against pinned, immutable profiles. Inconclusive runs are never billed.",
      profiles: "https://api.averray.com/verify/profiles",
      payment: "x402 (EIP-3009) — flat per-run USDC on Base",
      page: "https://averray.com/verify"
    },
    proofToPay: {
      summary: "Proof-gated escrow with a counterparty you already chose; release on PASS only.",
      page: "https://averray.com/proof-to-pay"
    },
    workReceipts: {
      schema: "averray.work-receipt.v1",
      pattern: "https://averray.com/receipts/:contentHash"
    }
  });
  assert.equal(manifest.baseUrl, "https://api.example.com");
  assert.equal(manifest.discoveryUrl, "https://example.com/.well-known/agent-tools.json");
  assert.equal(manifest.profile, "https://app.example.com/agents/<wallet>");
  assert.deepEqual(manifest.protocolEndpoints, {
    http: "https://api.example.com",
    mcp: "https://api.example.com/mcp"
  });
  assert.equal(manifest.onboarding.entrypoint, "https://api.example.com/onboarding");
  assert.equal(manifest.onboarding.posterEntrypoint, "https://api.example.com/poster/onboarding");
  assert.deepEqual(manifest.onboarding.poster, {
    entrypoint: "https://api.example.com/poster/onboarding",
    minimumRewardUsdc: "1.25",
    quoteStep: {
      method: "POST",
      path: "/jobs/draft",
      description: "POST /jobs/draft is the quote step; there is no separate /jobs/quote endpoint."
    },
    jobs: {
      method: "GET",
      path: "/poster/jobs",
      description: "SIWE-authenticated view of the caller's own postings and their escrow, claim, and session state."
    },
    mcpMirror: {
      available: true,
      status: "connected_session",
      tools: ["getPosterOnboarding", "draftJob", "buildPostJobTransactions"],
      description: "A connected MCP session exposes the same onboarding, deterministic draft, and wallet-bound unsigned funding-template services as the published HTTP poster flow."
    }
  });
  assert.equal(manifest.health, "https://api.example.com/health");
  assert.ok(Array.isArray(manifest.publicEndpoints));
  assert.ok(manifest.publicEndpoints.some((entry) => entry.path === "/poster/onboarding"));
  assert.ok(Array.isArray(manifest.authenticatedEndpoints));
  assert.ok(manifest.authenticatedEndpoints.some((entry) => entry.path === "/poster/jobs"));
  for (const endpoint of [...manifest.publicEndpoints, ...manifest.authenticatedEndpoints]) {
    assert.match(endpoint.method, /^(GET|POST)$/u, `${endpoint.path} must advertise its HTTP method`);
  }
  assert.equal(
    manifest.publicEndpoints.find((entry) => entry.path === "/jobs/validate-submission")?.method,
    "POST"
  );
  assert.equal(
    manifest.publicEndpoints.find((entry) => entry.path === "/verify/runs")?.method,
    "POST"
  );
  assert.ok(Array.isArray(manifest.tools));
  assert.ok(!manifest.publicEndpoints.some((entry) => entry.path === "/strategies"));
  assert.ok(!manifest.authenticatedEndpoints.some((entry) => entry.path === "/account/strategies"));
  assert.ok(!manifest.tools.some((tool) => ["getStrategyPositions", "listStrategies"].includes(tool.name)));
  assert.equal("vdotStrategy" in manifest.docs, false);
  assert.ok(manifest.authenticatedEndpoints.some((entry) => entry.path === "/account/position"));
  assert.ok(manifest.authenticatedEndpoints.some((entry) => entry.path === "/account/borrow-capacity"));
  assert.ok(!manifest.authenticatedEndpoints.some((entry) => entry.path === "/payments/send"));
  assert.ok(!manifest.tools.some((tool) => tool.name === "sendToAgent"));
  // /auth/refresh rotates the wallet JWT in place — both the entrypoint
  // list and the authenticated-endpoints list must advertise it so clients
  // can avoid re-running SIWE every AUTH_TOKEN_TTL_SECONDS.
  assert.ok(manifest.executionSurfaces.authEntrypoints.includes("/auth/refresh"));
  assert.ok(manifest.authenticatedEndpoints.some((entry) => entry.path === "/auth/refresh"));
  // Tools advertised in the manifest must also surface as authenticated endpoints
  // so an MCP client following the manifest can actually call them. The
  // explainEligibility / estimateNetReward tools were previously reachable only
  // as sub-fields of preflightJob / recommendJobs — they now have direct routes.
  assert.ok(manifest.tools.some((tool) => tool.name === "explainEligibility"));
  assert.ok(manifest.tools.some((tool) => tool.name === "estimateNetReward"));
  assert.ok(manifest.authenticatedEndpoints.some((entry) => entry.path === "/jobs/explain-eligibility"));
  assert.ok(manifest.authenticatedEndpoints.some((entry) => entry.path === "/jobs/estimate-reward"));
  assert.ok(manifest.authenticatedEndpoints.some((entry) => entry.path === "/jobs/:id/estimate"));
  assert.ok(manifest.authenticatedEndpoints.some((entry) => entry.path === "/me"));
  assert.ok(manifest.authenticatedEndpoints.some((entry) => entry.path === "/receipts"));
  assert.equal(manifest.tools[0]?.name, "getPlatformCapabilities");
  assert.equal(manifest.executionSurfaces.operatorApp, "https://app.example.com");
  assert.equal(manifest.schemas.agentBadge, "https://averray.com/schemas/agent-badge-v1.json");
  assert.equal(manifest.schemas.jobSchemasIndex, "https://api.example.com/schemas/jobs");
  assert.equal(manifest.schemas.jobSchemaPathTemplate, "https://api.example.com/schemas/jobs/<name>.json");
  assert.ok(manifest.publicEndpoints.some((entry) => entry.path === "/schemas/jobs"));
  assert.ok(manifest.publicEndpoints.some((entry) => entry.path === "/session/state-machine"));
  assert.ok(manifest.publicEndpoints.some((entry) => entry.path === "/verify/profiles"));
  assert.ok(manifest.publicEndpoints.some((entry) => entry.path === "/verify/runs"));
  assert.ok(manifest.publicEndpoints.some((entry) => entry.path === "/verify/runs/:runId"));
  assert.ok(manifest.tools.some((tool) => tool.name === "listJobSchemas"));
  assert.ok(manifest.tools.some((tool) => tool.name === "listVerificationProfiles"));
  assert.ok(manifest.tools.some((tool) => tool.name === "getSessionStateMachine"));
  assert.equal(manifest.auth.schemeId, "SIWE_JWT");
  assert.deepEqual(manifest.auth.supportedWalletModes, ["evm-siwe", "substrate-native"]);
  assert.deepEqual(manifest.auth.plannedWalletModes, []);
  assert.equal(manifest.docs.walletOnboarding, "https://github.com/averray-agent/agent/blob/main/docs/AGENT_WALLET_ONBOARDING.md");
  assert.equal(manifest.docs.productionChecklist, "https://github.com/averray-agent/agent/blob/main/docs/PRODUCTION_CHECKLIST.md");
  assert.equal(manifest.docs.threatModel, "https://github.com/averray-agent/agent/blob/main/docs/THREAT_MODEL.md");
  assert.equal(manifest.docs.noToken, "https://github.com/averray-agent/agent/blob/main/docs/NO_TOKEN.md");
  assert.equal(manifest.docs.week12Gate, "https://github.com/averray-agent/agent/blob/main/docs/WEEK12_GATE.md");
  assert.equal(manifest.docs.productProofGate, "https://github.com/averray-agent/agent/blob/main/docs/PRODUCT_PROOF_GATE.md");
  assert.equal(manifest.docs.disputeCodes, "https://github.com/averray-agent/agent/blob/main/docs/DISPUTE_CODES.md");
  assert.equal(manifest.docs.arbitrationMigration, "https://github.com/averray-agent/agent/blob/main/docs/ARBITRATION_MIGRATION.md");
  assert.ok(manifest.onboarding.walletModes.some((mode) => (
    mode.id === "evm-siwe"
    && mode.status === "supported"
    && mode.chain.faucetUrl === "https://faucet.polkadot.io/"
    && mode.setup.secretHandling.includes("never paste raw keys")
  )));
  assert.equal(manifest.onboarding.walletModes.some((mode) => mode.id === "substrate-mapped"), false);
  assert.ok(manifest.onboarding.walletModes.some((mode) => (
    mode.id === "substrate-native"
    && mode.status === "supported"
    && mode.authScheme === "SIWE_JWT"
    && mode.mappingRequirement.includes("pallet_revive.map_account")
    && mode.setup.mappingGuidance.includes("not Averray")
    && mode.setup.mappingGuidance.includes("refunded on unmap")
  )));
  assert.ok(manifest.onboarding.walletModes.some((mode) => (
    mode.id === "agent-self-custody"
    && mode.status === "supported"
    && mode.forAutonomousAgents === true
    && mode.authScheme === "SIWE_JWT"
    && Array.isArray(mode.bootstrap) && mode.bootstrap.length >= 3
    && mode.setup.secretHandling.includes("Never paste it into chat")
  )));
  assert.ok(manifest.onboarding.readinessChecks.some((check) => (
    check.id === "wallet-funded" && check.faucetUrl === "https://faucet.polkadot.io/"
  )));
  assert.ok(manifest.onboarding.selfServeChecklist.some((entry) => entry.includes("do not paste")));
  assert.ok(manifest.onboarding.starterFlow.includes("select-first-waiver-eligible-claimable-job"));
  assert.equal(manifest.onboarding.starterFlow.includes("claim-starter-job"), false);
  assert.ok(manifest.onboarding.actionRequirements.some((entry) => (
    entry.method === "POST" && entry.path === "/jobs/claim" && entry.requiredAction === "wallet_sign_in"
  )));
});

test("A1 manifest payload: walletless arrival states the perk, proof, and limits in one block", () => {
  const manifest = buildDiscoveryManifest({ chainId: POLKADOT_HUB_MAINNET_CHAIN_ID });
  const arrival = manifest.onboarding.walletlessArrival;

  assert.match(arrival.headline, /earn from zero/u);
  assert.match(arrival.start, /Generate an EOA/u);
  assert.match(arrival.start, /free and offline/u);
  assert.match(arrival.start, /Curated starter jobs use operator-brokered claim and submit gas/u);
  assert.match(arrival.start, /onboardingWaiverEligible/u);
  assert.match(arrival.start, /no funding is required because it needs no bond/u);
  assert.match(arrival.start, /Externally posted jobs are worker-paid/u);
  assert.match(arrival.start, /external_self_paid_claim_required/u);
  assert.match(arrival.managedWalletInterop, /Cloudflare Wallets, Coinbase, or similar/u);
  assert.match(arrival.managedWalletInterop, /payment rails and can't sign on this chain/u);
  assert.match(arrival.managedWalletInterop, /same key works on any EVM chain/u);
  assert.match(arrival.managedWalletInterop, /Eligible workers can request Averray's one-time first-withdrawal DOT grant/u);
  assert.match(arrival.proof.summary, /0\.40 USDC/u);
  assert.match(arrival.proof.summary, /nonce remained 0/u);
  assert.equal(
    arrival.proof.caseStudy,
    "https://github.com/averray-agent/agent/blob/main/docs/BLIND_AGENT_CASE_STUDY.md"
  );
  assert.equal(arrival.proof.pullRequest, "https://github.com/averray-agent/agent/pull/904");
  assert.deepEqual(arrival.limits, {
    waiverClaimsPerWallet: 3,
    waiverAppliesTo: "waiver-eligible starter jobs",
    withdrawal: "Withdrawal is an on-chain act."
  });

  assert.deepEqual(
    buildPlatformCapabilities({ chainId: POLKADOT_HUB_MAINNET_CHAIN_ID }).onboarding.walletlessArrival,
    arrival,
    "/onboarding and the discovery manifest must share the same walletless-arrival block"
  );
});

test("A4 manifest honesty: discovery advertises the served MCP endpoint and mainnet pins the live 500 bps fee", () => {
  const manifest = buildDiscoveryManifest({ chainId: POLKADOT_HUB_MAINNET_CHAIN_ID });
  const deployment = JSON.parse(readFileSync(
    new URL("../../../deployments/mainnet.json", import.meta.url),
    "utf8"
  ));

  assert.equal(manifest.version, "0.5.0");
  assert.deepEqual(manifest.protocols, ["http", "mcp"]);
  assert.deepEqual(manifest.protocolEndpoints, {
    http: "https://api.averray.com",
    mcp: "https://api.averray.com/mcp"
  });
  assert.equal(
    deployment.contracts.escrowCore,
    "0xC2Eb191FB75246667226a5D5Db9d821f95a5f793"
  );
  assert.equal(deployment.parameters.protocolFeeBps, "500");
});

test("mainnet chainId renders the mainnet chain block on every network-dependent surface", () => {
  const manifest = buildDiscoveryManifest({ chainId: POLKADOT_HUB_MAINNET_CHAIN_ID });
  const mainnetChain = {
    name: "Polkadot Hub",
    currencySymbol: "DOT",
    chainId: POLKADOT_HUB_MAINNET_CHAIN_ID,
    rpcUrl: "https://eth-rpc.polkadot.io"
  };

  for (const id of ["evm-siwe", "agent-self-custody", "substrate-native"]) {
    const mode = manifest.onboarding.walletModes.find((entry) => entry.id === id);
    assert.deepEqual(mode.chain, mainnetChain, `${id} must advertise the mainnet chain`);
  }

  const walletFunded = manifest.onboarding.readinessChecks.find((check) => check.id === "wallet-funded");
  assert.equal(
    walletFunded.description,
    "For externally posted jobs or non-waived curated jobs, acquire DOT on Polkadot Hub. Curated starter jobs use operator-brokered gas; only those also marked stake-waived need no wallet funding. For external jobs, handle external_self_paid_claim_required by signing and broadcasting the returned claimJob transaction."
  );
  assert.ok(!("faucetUrl" in walletFunded), "mainnet has no faucet — wallet-funded must not carry faucetUrl");
  assert.deepEqual(manifest.onboarding.buildVestedCapacity.disclosure, {
    statement: DEPOSIT_POOL_RISK_DISCLOSURE
  });

  assert.ok(manifest.onboarding.selfServeChecklist.includes(
    "For externally posted jobs or non-waived curated jobs, acquire DOT on Polkadot Hub. Curated starter jobs use operator-brokered gas; only those also marked stake-waived require no wallet funding. Handle external_self_paid_claim_required by signing and broadcasting the returned claimJob transaction."
  ));
  const autonomousMode = manifest.onboarding.walletModes.find((entry) => entry.id === "agent-self-custody");
  assert.ok(autonomousMode.bootstrap.some((entry) => (
    entry.includes("external_self_paid_claim_required")
    && entry.includes("external_self_paid_submit_required")
  )));

  // Anti-desync guard: nothing in the mainnet manifest may still reference the
  // testnet chain, its currency, or a faucet — however the wording evolves.
  const serialized = JSON.stringify(manifest);
  assert.ok(!serialized.includes(String(POLKADOT_HUB_TESTNET_CHAIN_ID)));
  assert.ok(!/testnet/iu.test(serialized));
  assert.ok(!/faucet/iu.test(serialized));
  assert.ok(!serialized.includes('"PAS"'));
});

test("testnet chainId and unknown/unset chainIds keep the historical testnet block", () => {
  const testnetManifest = buildDiscoveryManifest({ chainId: POLKADOT_HUB_TESTNET_CHAIN_ID });
  const testnetChain = {
    name: "Polkadot Hub TestNet",
    currencySymbol: "PAS",
    chainId: POLKADOT_HUB_TESTNET_CHAIN_ID,
    rpcUrl: "https://eth-rpc-testnet.polkadot.io",
    faucetUrl: "https://faucet.polkadot.io/"
  };
  for (const id of ["evm-siwe", "agent-self-custody", "substrate-native"]) {
    const mode = testnetManifest.onboarding.walletModes.find((entry) => entry.id === id);
    assert.deepEqual(mode.chain, testnetChain, `${id} must advertise the testnet chain`);
  }
  assert.ok(testnetManifest.onboarding.selfServeChecklist.includes(
    "For externally posted jobs or non-waived curated jobs, fund PAS on Polkadot Hub TestNet from https://faucet.polkadot.io/. Curated starter jobs use operator-brokered gas; only those also marked stake-waived require no wallet funding. Handle external_self_paid_claim_required by signing and broadcasting the returned claimJob transaction."
  ));
  assert.ok(!JSON.stringify(testnetManifest).includes(String(POLKADOT_HUB_MAINNET_CHAIN_ID)));

  // Dev stacks boot with AUTH_CHAIN_ID=0 — they must never advertise mainnet.
  assert.deepEqual(buildDiscoveryManifest(), testnetManifest);
  assert.deepEqual(buildDiscoveryManifest({ chainId: 0 }), testnetManifest);
  assert.deepEqual(buildDiscoveryManifest({ chainId: 31337 }), testnetManifest);
});

test("buildPlatformCapabilities forwards the chainId to the manifest build", () => {
  const capabilities = buildPlatformCapabilities({ chainId: POLKADOT_HUB_MAINNET_CHAIN_ID });
  const mode = capabilities.onboarding.walletModes.find((entry) => entry.id === "evm-siwe");
  assert.equal(mode.chain.chainId, POLKADOT_HUB_MAINNET_CHAIN_ID);
  assert.equal(mode.chain.name, "Polkadot Hub");
  assert.ok(!capabilities.tools.includes("getStrategyPositions"));
  assert.ok(!capabilities.tools.includes("listStrategies"));
});

test("authenticated endpoint docs carry the query-parameter contracts agents tripped on", () => {
  const manifest = buildDiscoveryManifest();
  const preflight = manifest.authenticatedEndpoints.find((entry) => entry.path.startsWith("/jobs/preflight"));
  assert.equal(preflight.path, "/jobs/preflight?jobId=X");
  assert.ok(preflight.description.includes("GET-only"));
  assert.ok(preflight.description.includes("405"));
  const session = manifest.authenticatedEndpoints.find((entry) => entry.path.startsWith("/session?"));
  assert.equal(session.path, "/session?sessionId=X");
  assert.ok(session.description.includes("compatibility alias"));
});

test("buildPlatformCapabilities stays aligned with the discovery tool list", () => {
  const manifest = buildDiscoveryManifest();
  const capabilities = buildPlatformCapabilities();

  assert.equal(capabilities.name, manifest.name);
  assert.equal(capabilities.discoveryUrl, manifest.discoveryUrl);
  assert.equal(capabilities.discoveryMode, manifest.discoveryMode);
  assert.deepEqual(capabilities.protocols, manifest.protocols);
  assert.deepEqual(capabilities.onboarding, {
    walletlessArrival: manifest.onboarding.walletlessArrival,
    starterFlow: manifest.onboarding.starterFlow,
    walletModes: manifest.onboarding.walletModes,
    actionRequirements: manifest.onboarding.actionRequirements,
    readinessChecks: manifest.onboarding.readinessChecks,
    selfServeChecklist: manifest.onboarding.selfServeChecklist,
    buildVestedCapacity: manifest.onboarding.buildVestedCapacity,
    withdrawEarnings: manifest.onboarding.withdrawEarnings
  });
  assert.deepEqual(capabilities.auth, {
    scheme: manifest.auth.scheme,
    schemeId: manifest.auth.schemeId,
    entrypoints: manifest.auth.entrypoints,
    supportedWalletModes: manifest.auth.supportedWalletModes,
    plannedWalletModes: manifest.auth.plannedWalletModes
  });
  assert.deepEqual(capabilities.executionSurfaces, manifest.executionSurfaces);
  assert.deepEqual(
    capabilities.tools,
    manifest.tools.map((tool) => tool.name)
  );
});

test("deposit walkthrough carries the D0 capacity reframe and exact risk disclosure", () => {
  const walkthrough = buildDiscoveryManifest({
    chainId: POLKADOT_HUB_MAINNET_CHAIN_ID
  }).onboarding.buildVestedCapacity;

  assert.deepEqual(
    walkthrough.disclosure,
    { statement: "Technical pilot. Principal at risk. No depositor protection." }
  );
  assert.equal(
    walkthrough.meaning,
    "A time-weighted deposit is one capital-backed trust-and-capacity signal, used alongside verified work history and reputation."
  );
  assert.match(walkthrough.steps.join(" "), /vests linearly over 48 hours/u);
  assert.match(walkthrough.steps.join(" "), /never raise catalogue credit/u);
  assert.doesNotMatch(JSON.stringify(walkthrough), /fromDeposits|daily allowance/iu);
});

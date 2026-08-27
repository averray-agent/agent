// Tests for scripts/ops/render-mainnet-backend-env.mjs — the mainnet env-template
// generator. These pin the delta transform so a future edit can't silently ship a
// mainnet template that (a) points at a testnet RPC/chainId, (b) keeps the retired
// HMAC / arbitrator key, (c) drops the SHARE_URL_SECRET, or (d) fails to resolve
// public runtime values from the committed mainnet deployment manifest.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAINNET_BACKEND_RPC,
  MAINNET_RPC,
  MAINNET_CHAIN_ID,
  buildManifestOverrides,
  repointOpRef,
  transformLine,
  transformTemplate,
  collectOpRefs,
  buildInventoryBlock,
  spliceInventory,
  generateAll,
} from "./render-mainnet-backend-env.mjs";

const MANIFEST = {
  profile: "mainnet",
  owner: "0x1111111111111111111111111111111111111111",
  verifier: "0x2222222222222222222222222222222222222222",
  treasuryReserve: "0x3333333333333333333333333333333333333333",
  contracts: {
    treasuryPolicy: "0x4444444444444444444444444444444444444444",
    agentAccountCore: "0x5555555555555555555555555555555555555555",
    escrowCore: "0x6666666666666666666666666666666666666666",
    reputationSbt: "0x7777777777777777777777777777777777777777",
    discoveryRegistry: "0x8888888888888888888888888888888888888888",
    xcmWrapper: "0x2AF394fA95f75D3ca1C786128f4dfA1eB0c9675D",
    hydrationUsdcAdapter: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  },
  bankXcmV2Deployment: {
    version: "2.1",
    flowEnabled: true,
    convertedAccountId32: "0x85663dfdb243b1a11a90f0816e1f83ccdb99f8f4c4a25d432739218efd489736",
  },
  bankXcmDeploymentHistory: [
    {
      version: "2.0",
      wrapper: "0xc846eE73e49A748e59C7Ac8f8742F542a552D24C",
    },
    {
      version: "2.1",
      wrapper: "0x2AF394fA95f75D3ca1C786128f4dfA1eB0c9675D",
    },
  ],
  deploymentBlocks: {
    treasuryPolicy: 101,
    agentAccountCore: 102,
    reputationSbt: 103,
    discoveryRegistry: 104,
    escrowCore: 105,
  },
  runtime: {
    auth: {
      adminWallets: [
        "0x1111111111111111111111111111111111111111",
        "0x9999999999999999999999999999999999999999",
      ],
      verifierWallets: ["0x2222222222222222222222222222222222222222"],
    },
    indexer: {
      database: "averray_mainnet",
      schema: "agent_indexer_mainnet_20260725131847",
    },
  },
};

// --- repointOpRef ---------------------------------------------------------

test("repointOpRef: prod-* vault → mainnet-*, and -testnet item slug → -mainnet", () => {
  assert.equal(
    repointOpRef("op://prod-backend/aws-signer-testnet/kms-key-id"),
    "op://mainnet-backend/aws-signer-testnet/kms-key-id".replace("testnet", "mainnet")
  );
  assert.equal(
    repointOpRef("op://prod-backend-external/resend-api-key/password"),
    "op://mainnet-backend-external/resend-api-key/password"
  );
  assert.equal(repointOpRef("op://prod-indexer/database-url/password"), "op://mainnet-indexer/database-url/password");
});

test("repointOpRef: preserves a multi-word field segment", () => {
  assert.equal(
    repointOpRef("op://prod-backend/admin-eoa-arbitrator-testnet/private key"),
    "op://mainnet-backend/admin-eoa-arbitrator-mainnet/private key"
  );
});

test("repointOpRef: leaves a non-op value untouched", () => {
  assert.equal(repointOpRef("redis://redis:6379"), "redis://redis:6379");
});

// --- transformLine --------------------------------------------------------

test("transformLine: identity literals flip to mainnet", () => {
  assert.equal(transformLine("AUTH_CHAIN_ID=420420417"), `AUTH_CHAIN_ID=${MAINNET_CHAIN_ID}`);
  assert.equal(
    transformLine("RPC_URL=https://services.polkadothub-rpc.com/testnet/"),
    `RPC_URL=${MAINNET_BACKEND_RPC}`
  );
  assert.equal(
    transformLine("RPC_BACKUP_URLS=https://eth-rpc-testnet.polkadot.io/"),
    `RPC_BACKUP_URLS=${MAINNET_RPC}`
  );
  assert.equal(transformLine("USDC_LIQUIDITY_CHAIN=testnet"), "USDC_LIQUIDITY_CHAIN=mainnet");
  assert.equal(transformLine("INGESTION_PREFUND_ENABLED=true"), "INGESTION_PREFUND_ENABLED=false");
  assert.equal(
    transformLine("IDLE_BALANCE_ALLOCATION_ROUTE_LIVE=false"),
    "IDLE_BALANCE_ALLOCATION_ROUTE_LIVE=1"
  );
  assert.equal(
    transformLine("BANK_LANE_FEED_HYDRATION_EVM_RPC_BACKUP_URLS="),
    "BANK_LANE_FEED_HYDRATION_EVM_RPC_BACKUP_URLS=https://hydration-rpc.n.dwellir.com"
  );
  assert.equal(transformLine("REDIS_URL=redis://redis:6379"), "REDIS_URL=redis://mainnet-redis:6379");
  assert.equal(transformLine("REDIS_NAMESPACE=agent-platform"), "REDIS_NAMESPACE=agent-platform-mainnet");
  assert.equal(
    transformLine("INDEXER_STATUS_URL=http://indexer:42069/status"),
    "INDEXER_STATUS_URL=http://mainnet-indexer:42069/status"
  );
});

test("transformLine: removed keys are dropped (returns a non-string)", () => {
  assert.notEqual(typeof transformLine("AUTH_JWT_SECRETS=op://prod-backend/auth-jwt-secrets/password"), "string");
  assert.notEqual(typeof transformLine("ARBITRATOR_SIGNER_PRIVATE_KEY=op://prod-backend/x/private key"), "string");
});

test("transformLine: per-deploy unknowns become commented TODO(operator)", () => {
  assert.match(transformLine("TREASURY_POLICY_ADDRESS=0xabc"), /^# TREASURY_POLICY_ADDRESS=\s+TODO\(operator\):/u);
  const admin = transformLine("AUTH_ADMIN_WALLETS=0x6778F050eAc8313e4dbB176d7BAB44510E833ac8");
  assert.match(admin, /^# AUTH_ADMIN_WALLETS=/u);
  assert.match(admin, /NEVER the testnet hot key nor the leaked 0xFd2E/u);
});

test("buildManifestOverrides: resolves addresses, auth, blocks, and schema", () => {
  const overrides = buildManifestOverrides(MANIFEST);
  assert.equal(overrides.TREASURY_POLICY_ADDRESS, MANIFEST.contracts.treasuryPolicy);
  assert.equal(overrides.AUTH_ADMIN_WALLETS, MANIFEST.runtime.auth.adminWallets.join(","));
  assert.equal(overrides.AUTH_VERIFIER_WALLETS, MANIFEST.runtime.auth.verifierWallets.join(","));
  assert.equal(overrides.PONDER_START_BLOCK_TREASURY, "101");
  assert.equal(overrides.PONDER_START_BLOCK_ESCROW, "102", "shared Agent/Escrow scan starts at the earlier deploy");
  assert.equal(overrides.PONDER_START_BLOCK_REPUTATION, "103");
  assert.equal(overrides.XCM_WRAPPER_ADDRESS, MANIFEST.contracts.xcmWrapper);
  assert.equal(
    overrides.HYDRATION_USDC_ADAPTER_ADDRESS,
    MANIFEST.contracts.hydrationUsdcAdapter
  );
  assert.equal(overrides.BANK_XCM_FLOW_ENABLED, "true");
  assert.equal(overrides.PONDER_START_BLOCK_REGISTRIES, "104");
  assert.equal(overrides.DATABASE_SCHEMA, MANIFEST.runtime.indexer.schema);
  assert.equal(overrides.BANK_LANE_FEED_HYDRATION_ACCOUNT_ID32, "141ujyV9aKBYqZncx6SYRWU2XQCxUcYiGYE8U7jprEKVUZNJ");
  assert.equal(overrides.BANK_LANE_FEED_POSTAGE_ACCOUNT, "1yKNU414vYDyXYXL6pu845puajfeGTezD1rBiUYwp9UKBaZ");
  assert.equal(
    overrides.BANK_LANE_FEED_WRAPPER_CANDIDATES_JSON,
    JSON.stringify(MANIFEST.bankXcmDeploymentHistory.map(({ version, wrapper }) => ({ version, wrapper })))
  );
  assert.equal(overrides.LEGACY_ESCROW_CORE_ADDRESS, "");
  assert.equal(overrides.PONDER_LEGACY_ESCROW_CORE_ADDRESS, "");
});

test("buildManifestOverrides: projects the v1 drain address into backend and indexer env", () => {
  const legacyEscrowCore = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const overrides = buildManifestOverrides({
    ...MANIFEST,
    contracts: { ...MANIFEST.contracts, legacyEscrowCore }
  });
  assert.equal(overrides.LEGACY_ESCROW_CORE_ADDRESS, legacyEscrowCore);
  assert.equal(overrides.PONDER_LEGACY_ESCROW_CORE_ADDRESS, legacyEscrowCore);
});

test("buildManifestOverrides: fails closed on incomplete runtime metadata", () => {
  assert.throws(
    () => buildManifestOverrides({ ...MANIFEST, runtime: { ...MANIFEST.runtime, auth: { adminWallets: [] } } }),
    /runtime\.auth\.adminWallets/u
  );
  assert.throws(
    () =>
      buildManifestOverrides({
        ...MANIFEST,
        deploymentBlocks: { ...MANIFEST.deploymentBlocks, treasuryPolicy: 0 },
      }),
    /deploymentBlocks\.treasuryPolicy/u
  );
  assert.throws(
    () => buildManifestOverrides({ ...MANIFEST, bankXcmV2Deployment: {} }),
    /bankXcmV2Deployment\.flowEnabled/u
  );
});

test("buildManifestOverrides: rejects malformed AccountId32 values anywhere in deployment history", () => {
  const malformed = `0x${"aa".repeat(33)}`;
  const historyShapes = [
    { convertedAccountId32: malformed },
    { incident: { writeOffs: [{ accountId32: malformed }] } },
    { retiredCapital: [{ accountId32: malformed }] },
  ];
  for (const history of historyShapes) {
    assert.throws(
      () => buildManifestOverrides({ ...MANIFEST, bankXcmDeploymentHistory: [history] }),
      /bankXcmDeploymentHistory\[0\].*must be a 32-byte AccountId/u
    );
  }
});

test("buildManifestOverrides: requires an append-only unique wrapper history containing the env wrapper", () => {
  assert.throws(
    () => buildManifestOverrides({ ...MANIFEST, bankXcmDeploymentHistory: [] }),
    /non-empty append-only wrapper history/u
  );
  assert.throws(
    () => buildManifestOverrides({
      ...MANIFEST,
      bankXcmDeploymentHistory: [MANIFEST.bankXcmDeploymentHistory[0]]
    }),
    /contracts\.xcmWrapper must be present/u
  );
  assert.throws(
    () => buildManifestOverrides({
      ...MANIFEST,
      bankXcmDeploymentHistory: [
        MANIFEST.bankXcmDeploymentHistory[1],
        { ...MANIFEST.bankXcmDeploymentHistory[1], version: "2.2" }
      ]
    }),
    /duplicate wrapper/u
  );
});

test("buildManifestOverrides: repoints the complete v2.2 pair and derives its runtime activation flag", () => {
  const wrapper = "0x1111111111111111111111111111111111111122";
  const adapter = "0x2222222222222222222222222222222222222233";
  const convertedAccountId32 = `0x${"33".repeat(32)}`;
  const v22 = {
    ...MANIFEST,
    contracts: { ...MANIFEST.contracts, xcmWrapper: wrapper, hydrationUsdcAdapter: adapter },
    bankXcmV2Deployment: { version: "2.2", flowEnabled: false, convertedAccountId32 },
    bankXcmDeploymentHistory: [
      ...MANIFEST.bankXcmDeploymentHistory,
      { version: "2.2", wrapper }
    ]
  };
  const overrides = buildManifestOverrides(v22);
  assert.equal(overrides.XCM_WRAPPER_ADDRESS, wrapper);
  assert.equal(overrides.HYDRATION_USDC_ADAPTER_ADDRESS, adapter);
  assert.equal(overrides.BANK_XCM_FLOW_ENABLED, "false");
  assert.deepEqual(
    JSON.parse(overrides.BANK_LANE_FEED_WRAPPER_CANDIDATES_JSON),
    v22.bankXcmDeploymentHistory.map(({ version, wrapper: candidate }) => ({ version, wrapper: candidate }))
  );
});

test("transformLine: op:// values are repointed; kept keys stay literal", () => {
  assert.equal(
    transformLine("METRICS_BEARER_TOKEN=op://prod-backend/metrics-bearer-token/password"),
    "METRICS_BEARER_TOKEN=op://mainnet-backend/metrics-bearer-token/password"
  );
  assert.equal(transformLine("SIGNER_BACKEND=kms"), "SIGNER_BACKEND=kms");
  assert.equal(transformLine("JWT_BACKEND=kms"), "JWT_BACKEND=kms");
  // the USDC precompile is the one correct cross-env reuse — unchanged
  assert.equal(
    transformLine("TOKEN_ADDRESS=0x0000053900000000000000000000000001200000"),
    "TOKEN_ADDRESS=0x0000053900000000000000000000000001200000"
  );
});

test("transformLine: the ponder RPC key carries the chain id and is renamed", () => {
  assert.equal(
    transformLine("PONDER_RPC_URL_420420417=https://eth-rpc-testnet.polkadot.io/"),
    `PONDER_RPC_URL_420420419=${MAINNET_RPC}`
  );
});

test("transformLine: comments and blanks pass through verbatim", () => {
  assert.equal(transformLine("# a comment"), "# a comment");
  assert.equal(transformLine(""), "");
});

// --- transformTemplate ----------------------------------------------------

test("transformTemplate: removes HMAC, adds SHARE_URL_SECRET, flips chain id", () => {
  const src = [
    "AUTH_CHAIN_ID=420420417",
    "AUTH_JWT_SECRETS=op://prod-backend/auth-jwt-secrets/password",
    "KMS_KEY_ID=op://prod-backend/aws-signer-testnet/kms-key-id",
  ].join("\n");
  const out = transformTemplate(src, "deploy/backend.env.template", {
    additions: ["SHARE_URL_SECRET=op://mainnet-backend/share-url-secret/password"],
  });
  assert.match(out, /GENERATED by scripts\/ops\/render-mainnet-backend-env\.mjs/u);
  assert.match(out, /AUTH_CHAIN_ID=420420419/u);
  assert.ok(!/^AUTH_JWT_SECRETS=/mu.test(out), "HMAC key removed");
  assert.match(out, /^KMS_KEY_ID=op:\/\/mainnet-backend\/aws-signer-mainnet\/kms-key-id$/mu);
  assert.match(out, /^SHARE_URL_SECRET=op:\/\/mainnet-backend\/share-url-secret\/password$/mu);
});

// --- inventory block ------------------------------------------------------

test("collectOpRefs + buildInventoryBlock: one parseable row per op:// ref", () => {
  const refs = collectOpRefs("A=op://mainnet-backend/i/f\nB=literal\nC=op://mainnet-indexer/db/password\n");
  assert.deepEqual(refs.map((r) => r.varName), ["A", "C"]);
  const block = buildInventoryBlock(refs);
  // rows must match the lint's row parser: | `VAR` | `op://...` |
  assert.match(block, /\|\s*`A`\s*\|\s*`op:\/\/mainnet-backend\/i\/f`/u);
  assert.match(block, /\|\s*`C`\s*\|\s*`op:\/\/mainnet-indexer\/db\/password`/u);
});

test("spliceInventory: replaces the marked block idempotently", () => {
  const base = "# doc\n\n<!-- BEGIN mainnet-generated (render-mainnet-backend-env.mjs) — do not hand-edit -->\nOLD\n<!-- END mainnet-generated -->\n";
  const block = buildInventoryBlock([{ varName: "X", path: "op://mainnet-backend/x/f" }]);
  const once = spliceInventory(base, block);
  assert.ok(!once.includes("OLD"), "old block replaced");
  assert.match(once, /`X`/u);
  assert.equal(spliceInventory(once, block), once, "second splice is a no-op");
});

test("spliceInventory: appends the block when markers are absent", () => {
  const out = spliceInventory("# doc, no markers\n", buildInventoryBlock([{ varName: "X", path: "op://mainnet-backend/x/f" }]));
  assert.match(out, /BEGIN mainnet-generated/u);
  assert.match(out, /`X`/u);
});

// --- end-to-end against the real committed testnet templates ---------------

test("generateAll: the real transform yields the mainnet essentials", () => {
  const files = generateAll();
  const backend = files["deploy/backend.mainnet.env.template"];
  assert.match(backend, /AUTH_CHAIN_ID=420420419/u);
  assert.ok(backend.includes(`RPC_URL=${MAINNET_BACKEND_RPC}`));
  assert.ok(backend.includes(`RPC_BACKUP_URLS=${MAINNET_RPC}`));
  assert.match(backend, /^RPC_WRITE_REQUEST_TIMEOUT_MS=15000$/mu);
  assert.match(backend, /^CHAIN_EVM_FLOOR_BLOCK=19414957$/mu);
  assert.match(backend, /^SHARE_URL_SECRET=op:\/\/mainnet-backend\/share-url-secret\/password$/mu);
  assert.ok(!/^AUTH_JWT_SECRETS=/mu.test(backend), "no HMAC key");
  assert.ok(!/^ARBITRATOR_SIGNER_PRIVATE_KEY=/mu.test(backend), "no arbitrator key");
  assert.ok(!/op:\/\/prod-/u.test(backend), "no prod-* vault refs leak into mainnet");
  assert.match(backend, /^REDIS_URL=redis:\/\/mainnet-redis:6379$/mu);
  assert.match(backend, /^REDIS_NAMESPACE=agent-platform-mainnet$/mu);
  assert.match(backend, /^INDEXER_STATUS_URL=http:\/\/mainnet-indexer:42069\/status$/mu);
  assert.match(backend, /^ALERT_ENVIRONMENT=mainnet$/mu);
  assert.match(backend, /^FIRST_EXTERNAL_AGENT_ALERT_ENABLED=true$/mu);
  assert.match(backend, /^EXTERNAL_POSTING_MODE=open$/mu);
  assert.match(backend, /^TREASURY_POLICY_ADDRESS=0x226F14252A98BD2eA140271647De20132F09AF20$/mu);
  assert.match(backend, /^AGENT_ACCOUNT_ADDRESS=0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57$/mu);
  assert.match(backend, /^XCM_WRAPPER_ADDRESS=0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc$/mu);
  assert.match(backend, /^BANK_XCM_FLOW_ENABLED=true$/mu);
  assert.match(backend, /^BANK_XCM_ASSET_HUB_SUBSTRATE_RPC_URL=wss:\/\/asset-hub-polkadot-rpc\.n\.dwellir\.com$/mu);
  assert.match(backend, /^BANK_XCM_HYDRATION_SUBSTRATE_RPC_URL=wss:\/\/hydration-rpc\.n\.dwellir\.com$/mu);
  assert.match(backend, /^HYDRATION_USDC_ADAPTER_ADDRESS=0x96091d4477Fe37E79557276d63883bBbbdE73159$/mu);
  assert.match(backend, /^BANK_LANE_FEED_HYDRATION_ACCOUNT_ID32=12eYrKzitqg8q8CiGCiAymMZeFH5wRnngxQ5uynmEp4WUYn4$/mu);
  assert.match(backend, /^BANK_LANE_FEED_WRAPPER_CANDIDATES_JSON=\[.+\]$/mu);
  assert.match(backend, /^BANK_LANE_FEED_POSTAGE_ACCOUNT=16UMvFEn69RefaRfq4egSzCJxN8Kdi3m2aBCYCsFH2p1T6cj$/mu);
  assert.match(
    backend,
    /^AUTH_ADMIN_WALLETS=0x01e6eed856e989201f4ff6346e18eab7e46c874c,0x9Ab8531FBb0948C542a31298FD61335f30064239,0xDeD3D610546DF151a6BB3D6ed119c3700ABC2146$/mu
  );
  assert.match(
    backend,
    /^AUTH_VERIFIER_WALLETS=0x5a6836c6D4d293F6E5377E6c28054F4171915813,0x9Ab8531FBb0948C542a31298FD61335f30064239$/mu
  );
  assert.doesNotMatch(
    backend,
    /^AUTH_VERIFIER_WALLETS=.*0xDeD3D610546DF151a6BB3D6ed119c3700ABC2146.*$/mu,
    "the human operator wallet must never inherit verifier/settlement authority"
  );
  assert.doesNotMatch(
    backend,
    /^\s*#?\s*[A-Z][A-Z0-9_]*=.*TODO\(operator\)/mu
  );

  const indexer = files["deploy/indexer.mainnet.env.template"];
  assert.match(indexer, /^POLKADOT_CHAIN_ID=420420419$/mu);
  assert.match(indexer, /^POLKADOT_CHAIN_NAME=polkadotHubMainnet$/mu);
  assert.match(indexer, /^PONDER_START_BLOCK_TREASURY=18647521$/mu);
  assert.match(indexer, /^PONDER_START_BLOCK_ESCROW=18647537$/mu);
  assert.match(indexer, /^PONDER_START_BLOCK_REPUTATION=18647544$/mu);
  assert.match(indexer, /^PONDER_START_BLOCK_REGISTRIES=18647552$/mu);
  assert.match(indexer, /^DATABASE_SCHEMA=agent_indexer_mainnet_20260725131847$/mu);
  assert.doesNotMatch(
    indexer,
    /^\s*#?\s*[A-Z][A-Z0-9_]*=.*TODO\(operator\)/mu
  );
  // no testnet RPC anywhere in the rendered mainnet templates
  assert.ok(!indexer.includes("eth-rpc-testnet.polkadot.io"));
});

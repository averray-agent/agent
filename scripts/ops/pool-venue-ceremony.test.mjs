import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { importCeremonyModule } from "./ceremony-module-loader.mjs";

import {
  DEFAULT_FINALITY_CONFIRMATIONS,
  MIN_FINALITY_CONFIRMATIONS,
  PROOF_RETURN_WINDOW_SECONDS,
  STANDING_RETURN_WINDOW_SECONDS,
  assertAccountingPostcondition,
  assertCeremonyEffectPostcondition,
  assertDeployAdmission,
  assertExpectedSigner,
  assertObservability,
  assertVenueAdapterBound,
  buildPoolObservabilityUrl,
  buildFinalityEvidence,
  confirmCanonicalPostState,
  deploymentManifestPaths,
  parseArgs,
  readDeploymentManifest,
  resolveSigner,
  resolvePoolTarget,
} from "./pool-venue-ceremony.mjs";

const OPERATOR = "0x5a6836c6D4d293F6E5377E6c28054F4171915813";
const POOL = "0xCCF5FDF3108AF8e693F28bb9326A573d9dA0F476";
const LEGACY_POOL = "0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30";
const VENUE_ADAPTER = "0xE2801E6C640e0180798912649fD567E1Ea459a35";
const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, "pool-venue-ceremony.mjs");

function healthyAdmission(overrides = {}) {
  return {
    assets: 2_000_000n,
    totalAssets: 10_000_000n,
    bufferAssets: 10_000_000n,
    venuePrincipalCostBasis: 0n,
    totalAssetCap: 1_000_000_000n,
    pendingRedemptionIds: [],
    blockTimestamp: 1_800_000_000n,
    returnBy: 1_800_000_000n + BigInt(PROOF_RETURN_WINDOW_SECONDS),
    contractMaxReturnSeconds: 7 * 24 * 60 * 60,
    deploymentKind: "proof",
    ...overrides,
  };
}

test("parseArgs keeps dry-run as the default and parses each ceremony leg", () => {
  assert.deepEqual(parseArgs(["deploy", "--profile", "mainnet", "--assets", "2000000"]), {
    command: "deploy",
    profile: "mainnet",
    pool: undefined,
    assets: "2000000",
    returnBy: undefined,
    deploymentKind: "proof",
    deploymentId: undefined,
    recallId: undefined,
    expectedSigner: undefined,
    observabilityUrl: undefined,
    confirmations: DEFAULT_FINALITY_CONFIRMATIONS,
    useKms: false,
    commit: false,
    help: false,
  });
  assert.equal(parseArgs(["settle", "--recall-id", "3", "--commit", "--use-kms"]).recallId, "3");
  assert.equal(parseArgs(["recall", "--pool", LEGACY_POOL, "--deployment-id", "2", "--assets", "500000"]).pool, LEGACY_POOL);
});

test("confirmation policy defaults to 12, is upward configurable, and refuses unsafe depths", () => {
  assert.equal(DEFAULT_FINALITY_CONFIRMATIONS, 12);
  assert.equal(parseArgs(["recall", "--confirmations", "20"]).confirmations, 20);
  assert.throws(
    () => parseArgs(["deploy", "--confirmations", String(MIN_FINALITY_CONFIRMATIONS - 1)]),
    new RegExp(`at least ${MIN_FINALITY_CONFIRMATIONS}`, "u"),
  );
});

test("omitted --pool resolves and logs the manifest default", () => {
  const lines = [];
  const resolved = resolvePoolTarget({
    manifestPool: POOL,
    requestedPool: undefined,
    log: (line) => lines.push(line),
  });

  assert.equal(resolved.poolAddress, POOL);
  assert.notEqual(resolved.poolAddress, LEGACY_POOL);
  assert.deepEqual(lines, [`POOL TARGET: ${POOL} (manifest contracts.depositPool)`]);
});

test("venue_adapter_not_bound refuses before a ceremony plan can be built", () => {
  assert.throws(
    () => assertVenueAdapterBound("0x0000000000000000000000000000000000000000", POOL),
    (error) => error?.code === "venue_adapter_not_bound" && /before building a ceremony plan/u.test(error.message),
  );
  assert.equal(assertVenueAdapterBound(VENUE_ADAPTER, LEGACY_POOL), VENUE_ADAPTER);
});

test("wrong signer refuses before ceremony reads", () => {
  assert.throws(
    () => assertExpectedSigner("0x0000000000000000000000000000000000000001", OPERATOR),
    /does not match --expected-signer.*before chain reads or writes/u,
  );
});

test("CLI wrong signer refuses against the manifest before RPC access", () => {
  const result = spawnSync("node", [
    scriptPath,
    "deploy",
    "--profile", "mainnet",
    "--assets", "2000000",
    "--return-by", "1900000000",
    "--expected-signer", "0x0000000000000000000000000000000000000001",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /does not match --expected-signer.*before chain reads or writes/u);
  assert.doesNotMatch(result.stderr, /Ceremony RPC preflight/u);
});

test("CLI commit refuses a non-KMS signer before RPC access", () => {
  const result = spawnSync("node", [
    scriptPath,
    "recall",
    "--profile", "mainnet",
    "--deployment-id", "1",
    "--assets", "500000",
    "--expected-signer", OPERATOR,
    "--commit",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /--commit requires --use-kms/u);
  assert.doesNotMatch(result.stderr, /Ceremony RPC preflight/u);
});

test("--use-kms binds KmsSigner to the averray-signer Roles Anywhere provider", async () => {
  const credentialsProvider = async () => ({ accessKeyId: "temporary", secretAccessKey: "temporary" });
  const seen = { builder: [], signer: [] };
  class FakeKmsSigner {
    constructor(options) { seen.signer.push(options); }
    async getAddress() { return OPERATOR; }
  }
  const provider = { name: "read-provider" };
  const env = {
    AWS_REGION: "eu-central-2",
    AWS_USE_ROLES_ANYWHERE: "true",
    KMS_KEY_ID: "arn:aws:kms:eu-central-2:123456789012:key/example",
  };

  const identity = await resolveSigner({
    expectedSigner: OPERATOR,
    useKms: true,
    commit: true,
  }, provider, {
    env,
    KmsSignerClass: FakeKmsSigner,
    credentialsProviderBuilder(options) {
      seen.builder.push(options);
      return credentialsProvider;
    },
  });

  assert.equal(seen.builder.length, 1);
  assert.equal(seen.builder[0].profile, "averray-signer");
  assert.equal(seen.builder[0].env, env);
  assert.equal(seen.signer.length, 1);
  assert.equal(seen.signer[0].credentialsProvider, credentialsProvider);
  assert.equal(seen.signer[0].provider, provider);
  assert.equal(identity.backend, "aws-kms");
});

test("dry run constructs no KMS signer and requests no credentials", async () => {
  const identity = await resolveSigner({
    expectedSigner: OPERATOR,
    useKms: false,
    commit: false,
  }, { name: "read-provider" }, {
    KmsSignerClass: class RefuseKmsConstruction {
      constructor() { throw new Error("dry run constructed KMS"); }
    },
    credentialsProviderBuilder() {
      throw new Error("dry run requested credentials");
    },
  });

  assert.equal(identity.address, OPERATOR);
  assert.equal(identity.signer, null);
  assert.equal(identity.backend, "expected-signer (dry-run only)");
});

test("dual-layout module resolution falls back to the image and names both attempted paths", async () => {
  const repoPath = "file:///repo/mcp-server/src/blockchain/kms-signer.js";
  const imagePath = "file:///app/src/blockchain/kms-signer.js";
  const attempts = [];
  const loaded = await importCeremonyModule({
    label: "KMS signer",
    candidates: [repoPath, imagePath],
    async importer(specifier) {
      attempts.push(specifier);
      if (specifier === repoPath) throw new Error("not found in checkout layout");
      return { layout: "image" };
    },
  });
  assert.deepEqual(attempts, [repoPath, imagePath]);
  assert.deepEqual(loaded, { layout: "image" });

  await assert.rejects(
    importCeremonyModule({
      label: "KMS signer",
      candidates: [repoPath, imagePath],
      importer: async () => { throw new Error("missing"); },
    }),
    (error) => error?.code === "ceremony_module_resolution_failed"
      && error.message.includes(repoPath)
      && error.message.includes(imagePath),
  );
});

test("deployment manifest resolves from the checkout and image layouts", async () => {
  assert.deepEqual(
    deploymentManifestPaths("mainnet", new URL("file:///repo/scripts/ops/pool-venue-ceremony.mjs")),
    ["/repo/deployments/mainnet.json", "/deployments/mainnet.json"],
  );
  assert.deepEqual(
    deploymentManifestPaths("mainnet", new URL("file:///app/scripts/ops/pool-venue-ceremony.mjs")),
    ["/app/deployments/mainnet.json", "/deployments/mainnet.json"],
  );

  const attempts = [];
  const manifest = await readDeploymentManifest("mainnet", {
    paths: ["/app/deployments/mainnet.json", "/deployments/mainnet.json"],
    async readFileImpl(path) {
      attempts.push(path);
      if (path.startsWith("/app/")) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      return JSON.stringify({ profile: "mainnet" });
    },
  });
  assert.deepEqual(attempts, ["/app/deployments/mainnet.json", "/deployments/mainnet.json"]);
  assert.deepEqual(manifest, { profile: "mainnet" });
});

test("backend image ships the ceremony and only its required runtime helpers", async () => {
  const dockerfile = await readFile(resolve(here, "..", "..", "mcp-server", "Dockerfile"), "utf8");
  assert.match(dockerfile, /^COPY scripts\/ops\/ceremony-module-loader\.mjs \.\/scripts\/ops\/ceremony-module-loader\.mjs$/mu);
  assert.match(dockerfile, /^COPY scripts\/ops\/ceremony-rpc\.mjs \.\/scripts\/ops\/ceremony-rpc\.mjs$/mu);
  assert.match(dockerfile, /^COPY scripts\/ops\/pool-venue-ceremony\.mjs \.\/scripts\/ops\/pool-venue-ceremony\.mjs$/mu);
  assert.match(dockerfile, /^COPY deployments\/mainnet\.json \/deployments\/mainnet\.json$/mu);
});

test("proof tranche at exactly 50% of total assets is admitted", () => {
  assert.doesNotThrow(() => assertDeployAdmission(healthyAdmission({ assets: 5_000_000n })));
});

test("over-policy deployment is refused", () => {
  assert.throws(
    () => assertDeployAdmission(healthyAdmission({ assets: 5_000_001n })),
    /50% deployment policy/u,
  );
});

test("pending redemption makes Leg A refuse", () => {
  assert.throws(
    () => assertDeployAdmission(healthyAdmission({ pendingRedemptionIds: [7n] })),
    /pending redemption.*7/u,
  );
});

test("empty pool makes Leg A refuse", () => {
  assert.throws(
    () => assertDeployAdmission(healthyAdmission({ totalAssets: 0n, bufferAssets: 0n })),
    /pool is empty/u,
  );
});

test("proof returnBy beyond 48 hours refuses", () => {
  assert.throws(
    () => assertDeployAdmission(healthyAdmission({
      returnBy: 1_800_000_000n + BigInt(PROOF_RETURN_WINDOW_SECONDS) + 1n,
    })),
    /48-hour proof policy/u,
  );
});

test("standing policy admits the contract's 7-day ceiling exactly", () => {
  assert.doesNotThrow(() => assertDeployAdmission(healthyAdmission({
    deploymentKind: "standing",
    returnBy: 1_800_000_000n + BigInt(STANDING_RETURN_WINDOW_SECONDS),
  })));
  assert.throws(
    () => assertDeployAdmission(healthyAdmission({
      deploymentKind: "standing",
      returnBy: 1_800_000_000n + BigInt(STANDING_RETURN_WINDOW_SECONDS) + 1n,
    })),
    /7-day standing policy/u,
  );
});

test("standing policy still refuses honestly if the contract ever tightens below it", () => {
  assert.throws(
    () => assertDeployAdmission(healthyAdmission({
      deploymentKind: "standing",
      contractMaxReturnSeconds: 3 * 24 * 60 * 60,
      returnBy: 1_800_000_000n + BigInt(STANDING_RETURN_WINDOW_SECONDS),
    })),
    /refusing rather than silently changing policy/u,
  );
});

test("wrong-pool or missing observability snapshots remain refused by mutation", () => {
  const base = {
    available: true,
    pool: POOL,
    reconciled: true,
    flows: { status: "ok" },
    block: { timestamp: 1_800_000_000 },
  };
  assert.doesNotThrow(() => assertObservability(base, {
    poolAddress: POOL,
    chainTimestamp: 1_800_000_100n,
  }));
  assert.throws(() => assertObservability(undefined, {
    poolAddress: POOL,
    chainTimestamp: 1_800_000_100n,
  }), /unavailable \(no snapshot\)/u);
  assert.throws(() => assertObservability({ ...base, pool: OPERATOR }, {
    poolAddress: POOL,
    chainTimestamp: 1_800_000_100n,
  }), /different pool generation/u);
});

test("matching legacy pool snapshot passes the unchanged observability guard", () => {
  assert.doesNotThrow(() => assertObservability({
    available: true,
    pool: LEGACY_POOL,
    reconciled: true,
    flows: { status: "ok" },
    block: { timestamp: 1_800_000_000 },
  }, {
    poolAddress: LEGACY_POOL,
    chainTimestamp: 1_800_000_100n,
  }));
});

test("observability still requires reconciliation and event-readable flow", () => {
  const base = {
    available: true,
    pool: POOL,
    reconciled: true,
    flows: { status: "ok" },
    block: { timestamp: 1_800_000_000 },
  };
  assert.throws(() => assertObservability({ ...base, reconciled: false }, {
    poolAddress: POOL,
    chainTimestamp: 1_800_000_100n,
  }), /not reconciled/u);
  assert.throws(() => assertObservability({ ...base, flows: { status: "unavailable" } }, {
    poolAddress: POOL,
    chainTimestamp: 1_800_000_100n,
  }), /event flow is unavailable/u);
});

test("observability request is explicitly bound to the resolved pool", () => {
  assert.equal(
    buildPoolObservabilityUrl("http://127.0.0.1:8787/monitor/deposit-pool?pool=wrong", LEGACY_POOL),
    `http://127.0.0.1:8787/monitor/deposit-pool?pool=${LEGACY_POOL}`,
  );
});

test("postcondition accepts the exact principal-cost reduction and reconciliation", () => {
  assert.doesNotThrow(() => assertAccountingPostcondition({
    beforePrincipalCostBasis: 2_000_000n,
    afterPrincipalCostBasis: 1_500_000n,
    emittedPrincipalReduction: 500_000n,
    afterBufferAssets: 8_500_010n,
    afterTotalAssets: 10_000_010n,
  }));
});

test("postcondition accepts the exact principal-cost increase on deploy", () => {
  assert.doesNotThrow(() => assertAccountingPostcondition({
    beforePrincipalCostBasis: 0n,
    afterPrincipalCostBasis: 2_000_000n,
    expectedPrincipalIncrease: 2_000_000n,
    emittedPrincipalReduction: 0n,
    afterBufferAssets: 8_000_000n,
    afterTotalAssets: 10_000_000n,
  }));
});

test("postcondition fails loud on injected cost-basis mismatch", () => {
  assert.throws(() => assertAccountingPostcondition({
    beforePrincipalCostBasis: 2_000_000n,
    afterPrincipalCostBasis: 1_500_001n,
    emittedPrincipalReduction: 500_000n,
    afterBufferAssets: 8_500_010n,
    afterTotalAssets: 10_000_011n,
  }), /principal cost-basis delta/u);
});

test("postcondition fails loud on injected reconciliation mismatch", () => {
  assert.throws(() => assertAccountingPostcondition({
    beforePrincipalCostBasis: 2_000_000n,
    afterPrincipalCostBasis: 2_000_000n,
    emittedPrincipalReduction: 0n,
    afterBufferAssets: 8_000_000n,
    afterTotalAssets: 10_000_001n,
  }), /buffer \+ deployed != totalAssets/u);
});

test("canonical wait reports progress, re-reads post-state, and only adds to the evidence shape", async () => {
  const transactionHash = `0x${"aa".repeat(32)}`;
  const blockHash = `0x${"bb".repeat(32)}`;
  const initialReceipt = {
    blockNumber: 100,
    blockHash,
    status: 1,
  };
  const receipt = { ...initialReceipt };
  const progress = [];
  const stateReads = [];
  const result = await confirmCanonicalPostState({
    provider: {
      async getTransactionReceipt(hash) {
        assert.equal(hash, transactionHash);
        return receipt;
      },
      async getBlock(number) {
        assert.equal(number, initialReceipt.blockNumber);
        return { number, hash: blockHash, timestamp: 1_800_000_000 };
      },
      async getBlockNumber() { return 111; },
    },
    transactionHash,
    initialReceipt,
    readPostState: async (blockNumber) => {
      stateReads.push(blockNumber);
      return { activeVenueRecallId: 6n, nextVenueRecallId: 7n };
    },
    log: (line) => progress.push(line),
  });

  assert.deepEqual(stateReads, [100]);
  assert.equal(result.postState.activeVenueRecallId, 6n);
  assert.equal(result.confirmationsWaited, 12);
  assert.equal(result.rereadBlockHash, blockHash);
  assert.equal(result.postStateReconfirmed, true);
  assert.ok(progress.some((line) => line.includes("12/12 confirmations")));
  assert.ok(progress.some((line) => line.includes("re-reading post-state")));

  const legacyTransaction = {
    hash: transactionHash,
    blockNumber: 100,
    blockHash,
    gasUsed: 42n,
    status: 1,
  };
  const additions = buildFinalityEvidence(initialReceipt, result);
  assert.deepEqual({ ...legacyTransaction, ...additions.transaction }, {
    ...legacyTransaction,
    confirmationsWaited: 12,
    rereadBlockHash: blockHash,
  });
  assert.deepEqual(additions.finality, {
    confirmationsRequired: 12,
    confirmationsWaited: 12,
    initialReceiptBlockHash: blockHash,
    rereadReceiptBlockHash: blockHash,
    rereadBlockHash: blockHash,
    receiptReconfirmed: true,
    postStateReconfirmed: true,
  });
});

test("mutated canonical block hash withholds evidence and names both hashes", async () => {
  const transactionHash = `0x${"aa".repeat(32)}`;
  const originalHash = `0x${"bb".repeat(32)}`;
  const replacementHash = `0x${"cc".repeat(32)}`;
  const initialReceipt = { blockNumber: 100, blockHash: originalHash, status: 1 };

  await assert.rejects(
    confirmCanonicalPostState({
      provider: {
        async getTransactionReceipt() { return { ...initialReceipt }; },
        async getBlock() { return { number: 100, hash: replacementHash }; },
        async getBlockNumber() { return 111; },
      },
      transactionHash,
      initialReceipt,
      readPostState: async () => ({ shouldNeverBeRead: true }),
      log: () => {},
    }),
    (error) => error?.code === "ceremony_finality_diverged"
      && error.message.includes("COMMITTED EVIDENCE WITHHELD")
      && error.message.includes(originalHash)
      && error.message.includes(replacementHash),
  );
});

test("a reorg between post-state and receipt re-read fails every ceremony effect shape", async () => {
  const transactionHash = `0x${"aa".repeat(32)}`;
  const originalHash = `0x${"bb".repeat(32)}`;
  const replacementHash = `0x${"cc".repeat(32)}`;
  const initialReceipt = { blockNumber: 100, blockHash: originalHash, status: 1 };
  let blockReads = 0;

  await assert.rejects(
    confirmCanonicalPostState({
      provider: {
        async getTransactionReceipt() { return { ...initialReceipt }; },
        async getBlock() {
          blockReads += 1;
          return { number: 100, hash: blockReads === 1 ? originalHash : replacementHash };
        },
        async getBlockNumber() { return 111; },
      },
      transactionHash,
      initialReceipt,
      readPostState: async () => ({ activeVenueRecallId: 6n }),
      log: () => {},
    }),
    (error) => error?.code === "ceremony_finality_diverged"
      && error.message.includes(originalHash)
      && error.message.includes(replacementHash),
  );

  const event = (args) => ({ args });
  const requestId = `0x${"dd".repeat(32)}`;
  assert.doesNotThrow(() => assertCeremonyEffectPostcondition({
    command: "deploy",
    parameters: { predictedDeploymentId: 4n, assetsRaw: 2_000_000n, returnBy: 1_800_000_000n },
    event: event({ deploymentId: 4n, adapterRequestId: requestId, assets: 2_000_000n }),
    after: {
      activeVenueDeploymentId: 4n,
      nextVenueDeploymentId: 5n,
      venueDeployment: {
        id: 4n,
        principalAssets: 2_000_000n,
        returnBy: 1_800_000_000n,
        adapterRequestId: requestId,
        status: 1,
      },
    },
  }));
  assert.doesNotThrow(() => assertCeremonyEffectPostcondition({
    command: "recall",
    parameters: { predictedRecallId: 6n, deploymentId: 4n, assetsRaw: 500_000n },
    event: event({ recallId: 6n, deploymentId: 4n, adapterRequestId: requestId, requestedAssets: 500_000n }),
    after: {
      activeVenueRecallId: 6n,
      nextVenueRecallId: 7n,
      venueRecall: {
        id: 6n,
        deploymentId: 4n,
        requestedAssets: 500_000n,
        adapterRequestId: requestId,
        status: 1,
      },
    },
  }));
  assert.doesNotThrow(() => assertCeremonyEffectPostcondition({
    command: "settle",
    parameters: { settlementKind: "deployment", deploymentId: 4n },
    event: event({ deploymentId: 4n, status: 2n }),
    after: { venueDeployment: { id: 4n, status: 2 } },
  }));
  assert.doesNotThrow(() => assertCeremonyEffectPostcondition({
    command: "settle",
    parameters: { settlementKind: "recall", recallId: 6n },
    event: event({ recallId: 6n, deploymentId: 4n, status: 2n, returnedAssets: 500_000n }),
    after: {
      activeVenueRecallId: 0n,
      venueRecall: { id: 6n, deploymentId: 4n, status: 2, returnedAssets: 500_000n },
    },
  }));
  assert.throws(() => assertCeremonyEffectPostcondition({
    command: "recall",
    parameters: { predictedRecallId: 6n, deploymentId: 4n, assetsRaw: 500_000n },
    event: event({ recallId: 6n, deploymentId: 4n, adapterRequestId: requestId, requestedAssets: 500_000n }),
    after: {
      activeVenueRecallId: 0n,
      nextVenueRecallId: 6n,
      venueRecall: { id: 6n, deploymentId: 0n, requestedAssets: 0n, status: 0 },
    },
  }), /confirmed recall receipt and re-read recall state diverge/u);
});

test("stalled finality wait is bounded, noisy, and exits without post-state evidence", async () => {
  const transactionHash = `0x${"aa".repeat(32)}`;
  const blockHash = `0x${"bb".repeat(32)}`;
  const initialReceipt = { blockNumber: 100, blockHash, status: 1 };
  const progress = [];
  let clock = 0;
  let postStateReads = 0;

  await assert.rejects(
    confirmCanonicalPostState({
      provider: {
        async getTransactionReceipt() { return { ...initialReceipt }; },
        async getBlock() { return { number: 100, hash: blockHash }; },
        async getBlockNumber() { return 100; },
      },
      transactionHash,
      initialReceipt,
      readPostState: async () => { postStateReads += 1; },
      timeoutMs: 20,
      pollIntervalMs: 5,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      log: (line) => progress.push(line),
    }),
    (error) => error?.code === "ceremony_finality_timeout"
      && error.message.includes("COMMITTED EVIDENCE WITHHELD"),
  );
  assert.equal(postStateReads, 0);
  assert.ok(progress.length >= 2);
  assert.ok(progress.some((line) => line.includes("1/12 confirmations")));
});

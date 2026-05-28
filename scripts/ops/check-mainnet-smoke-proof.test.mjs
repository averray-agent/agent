import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  DEFAULT_MAX_REWARD_RAW,
  EXPECTED_MAINNET_RPC_URL,
  SCHEMA_VERSION,
  validateEvidence
} from "./check-mainnet-smoke-proof.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "check-mainnet-smoke-proof.mjs"
);

function validEvidence(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    completedAt: "2026-05-28T12:00:00.000Z",
    polkadotDocs: [
      "smart-contracts/precompiles/erc20.md",
      "reference/polkadot-hub/assets.md",
      "smart-contracts/explorers.md"
    ],
    environment: {
      chainEnv: "mainnet",
      network: "polkadot-hub-mainnet",
      apiBaseUrl: "https://api.averray.com",
      rpcUrl: EXPECTED_MAINNET_RPC_URL
    },
    contracts: {
      escrowCore: "0x1111111111111111111111111111111111111111",
      agentAccountCore: "0x2222222222222222222222222222222222222222",
      treasuryPolicy: "0x3333333333333333333333333333333333333333",
      reputationSbt: "0x4444444444444444444444444444444444444444",
      discoveryRegistry: "0x5555555555555555555555555555555555555555"
    },
    asset: canonicalAsset(),
    auth: {
      tokenKind: "service_token",
      accessTokenTtlSeconds: 900,
      longLivedAdminJwtUsed: false
    },
    proofReferences: {
      mainnetAssetConfig: "docs/evidence/mainnet-usdc-asset-config-2026-05-28.json",
      mainnetEnvSecrets: "docs/evidence/mainnet-env-secrets-2026-05-28.json"
    },
    guardrails: {
      testnetEvidenceMixedIn: false,
      mainnetContractsMatchEnvProof: true,
      serviceOperatorApproved: true,
      directWikipediaEditClaimed: false
    },
    runs: [run(0), run(1), run(2)],
    ...overrides
  };
}

function canonicalAsset(overrides = {}) {
  return {
    symbol: "USDC",
    assetClass: "trust_backed",
    assetId: 1337,
    address: "0x0000053900000000000000000000000001200000",
    decimals: 6,
    minBalanceRaw: "70000",
    erc20MetadataFunctionsImplemented: false,
    ...overrides
  };
}

function run(index, overrides = {}) {
  const suffix = String(index + 1);
  const runId = `mainnet-smoke-run-${suffix}`;
  const jobId = `mainnet-smoke-job-${suffix}`;
  const sessionId = `mainnet-smoke-session-${suffix}`;
  return {
    runId,
    jobId,
    sessionId,
    workerWallet: `0x${suffix.repeat(40)}`,
    rewardRaw: "100000",
    claim: {
      status: "claimed",
      sessionId,
      txHash: hash(`a${index}`),
      explorerUrl: `https://blockscout.polkadot.io/tx/${hash(`a${index}`)}`,
      blockNumber: 1_000 + index,
      claimExpiresAt: "2026-05-28T13:00:00.000Z"
    },
    submit: {
      status: "submitted",
      sessionId,
      submittedAt: "2026-05-28T12:10:00.000Z"
    },
    verification: {
      outcome: "approved",
      storedSubmissionUsed: true,
      reasonCode: "product-proof-smoke-approved"
    },
    settlement: {
      status: "resolved",
      chainStatus: "confirmed",
      txHash: hash(`b${index}`),
      explorerUrl: `https://assethub-polkadot.subscan.io/extrinsic/${hash(`b${index}`)}`,
      blockNumber: 1_100 + index,
      asset: canonicalAsset(),
      payoutRaw: "100000"
    },
    timeline: {
      correlationId: sessionId,
      containsClaim: true,
      containsSubmit: true,
      containsSettlement: true
    },
    finalSessionStatus: "resolved",
    badgeVerified: true,
    profileVerified: true,
    ...overrides
  };
}

function hash(prefix) {
  return `0x${prefix}${"0".repeat(64 - prefix.length)}`;
}

async function writeEvidenceFile(doc) {
  const dir = await mkdtemp(join(tmpdir(), "mainnet-smoke-proof-"));
  const file = join(dir, "evidence.json");
  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return file;
}

test("validateEvidence accepts a complete redacted mainnet smoke proof", () => {
  const result = validateEvidence(validEvidence(), {
    now: new Date("2026-05-28T13:00:00.000Z"),
    maxCompletedAgeHours: 24
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.summary.runCount, 3);
  assert.equal(result.summary.totalRewardRaw, "300000");
  assert.equal(result.summary.maxSingleRewardRaw, "100000");
});

test("validateEvidence warns when launch freshness is not enforced", () => {
  const result = validateEvidence(validEvidence(), {
    now: new Date("2026-05-28T13:00:00.000Z")
  });

  assert.equal(result.ok, true);
  assert.match(result.warnings[0], /completedAt freshness was not enforced/u);
});

test("validateEvidence rejects testnet environment and missing Polkadot docs", () => {
  const result = validateEvidence(validEvidence({
    polkadotDocs: [
      "smart-contracts/precompiles/erc20.md",
      "reference/polkadot-hub/assets.md"
    ],
    environment: {
      ...validEvidence().environment,
      network: "polkadot-hub-testnet",
      apiBaseUrl: "https://testnet.api.averray.com",
      rpcUrl: "https://eth-rpc-testnet.polkadot.io/"
    }
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("polkadotDocs must include smart-contracts/explorers.md"));
  assert.ok(result.errors.includes("environment.network must be polkadot-hub-mainnet"));
  assert.ok(result.errors.includes("environment.apiBaseUrl must not point at testnet, Paseo, localhost, or a private endpoint"));
  assert.ok(result.errors.includes(`environment.rpcUrl must be ${EXPECTED_MAINNET_RPC_URL}`));
});

test("validateEvidence rejects non-canonical USDC asset metadata", () => {
  const result = validateEvidence(validEvidence({
    asset: canonicalAsset({
      assetId: 1984,
      address: "0x000007c000000000000000000000000001200000",
      erc20MetadataFunctionsImplemented: true
    })
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("asset.assetId must be 1337"));
  assert.ok(result.errors.includes("asset.address must be 0x0000053900000000000000000000000001200000"));
  assert.ok(result.errors.includes("asset.erc20MetadataFunctionsImplemented must be false"));
});

test("validateEvidence rejects fewer than three runs", () => {
  const result = validateEvidence(validEvidence({
    runs: [run(0), run(1)]
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("runs must include at least 3 completed smoke run(s)"));
});

test("validateEvidence rejects rewards outside the low-value bounds", () => {
  const result = validateEvidence(validEvidence({
    runs: [
      run(0, { rewardRaw: "69999", settlement: { ...run(0).settlement, payoutRaw: "69999" } }),
      run(1, { rewardRaw: (DEFAULT_MAX_REWARD_RAW + 1n).toString() }),
      run(2)
    ]
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("runs[0].rewardRaw must be >= 70000 (USDC minBalanceRaw)"));
  assert.ok(result.errors.includes("runs[1].rewardRaw must be <= maxRewardRaw 1000000"));
});

test("validateEvidence rejects duplicate ids and unconfirmed settlement", () => {
  const result = validateEvidence(validEvidence({
    runs: [
      run(0),
      run(1, { runId: "mainnet-smoke-run-1" }),
      run(2, {
        settlement: {
          ...run(2).settlement,
          chainStatus: "pending",
          txHash: "not-a-hash",
          explorerUrl: "https://assethub-paseo.subscan.io/extrinsic/0xabc"
        }
      })
    ]
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("runs[1].runId must be unique"));
  assert.ok(result.errors.includes("runs[2].settlement.chainStatus must be confirmed"));
  assert.ok(result.errors.includes("runs[2].settlement.txHash has an invalid format"));
  assert.ok(result.errors.includes("runs[2].settlement.explorerUrl must not point at testnet, Paseo, localhost, or a private endpoint"));
});

test("validateEvidence allows transaction hashes but rejects secret-looking free text", () => {
  const ok = validateEvidence(validEvidence());
  assert.equal(ok.ok, true);

  const result = validateEvidence(validEvidence({
    operatorNotes: `raw key accidentally pasted ${hash("c")}`
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("evidence.operatorNotes appears to contain a secret value; store raw secrets outside this evidence file"));
});

test("validateEvidence rejects long-lived admin JWT smoke auth", () => {
  const result = validateEvidence(validEvidence({
    auth: {
      tokenKind: "admin_jwt",
      accessTokenTtlSeconds: 2_592_000,
      longLivedAdminJwtUsed: true
    }
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("auth.tokenKind must be service_token, delegated_wallet, or refresh_flow"));
  assert.ok(result.errors.includes("auth.accessTokenTtlSeconds must be an integer between 1 and 3600"));
  assert.ok(result.errors.includes("auth.longLivedAdminJwtUsed must be false"));
});

test("CLI prints JSON for a valid evidence file", async () => {
  const file = await writeEvidenceFile(validEvidence());
  const { stdout } = await execFileAsync(process.execPath, [
    scriptPath,
    "--file",
    file,
    "--json",
    "--max-completed-age-hours",
    "24"
  ]);

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary.runCount, 3);
});

test("CLI exits non-zero for invalid evidence", async () => {
  const file = await writeEvidenceFile(validEvidence({ runs: [run(0)] }));
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "--file", file, "--json"]),
    (error) => {
      const parsed = JSON.parse(error.stdout);
      assert.equal(parsed.ok, false);
      assert.ok(parsed.errors.includes("runs must include at least 3 completed smoke run(s)"));
      return true;
    }
  );
});

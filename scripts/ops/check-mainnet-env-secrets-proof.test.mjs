import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  EXPECTED_MAINNET_CHAIN_ID,
  EXPECTED_MAINNET_RPC_URL,
  SCHEMA_VERSION,
  validateEvidence
} from "./check-mainnet-env-secrets-proof.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "check-mainnet-env-secrets-proof.mjs"
);

function validEvidence(overrides = {}) {
  const base = {
    schemaVersion: SCHEMA_VERSION,
    completedAt: "2026-05-28T12:00:00.000Z",
    polkadotDocs: [
      "smart-contracts/precompiles/erc20.md",
      "reference/polkadot-hub/assets.md"
    ],
    environment: {
      chainEnv: "mainnet",
      profile: "mainnet",
      rpcUrl: EXPECTED_MAINNET_RPC_URL,
      chainId: EXPECTED_MAINNET_CHAIN_ID,
      additionalRpcUrls: [EXPECTED_MAINNET_RPC_URL],
      deployEnvExample: "deployments/mainnet.env.example",
      privateEnvSource: "op://prod-mainnet-backend/backend-env/notes",
      renderedEnvChecksum: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    contracts: {
      escrowCore: "0x1111111111111111111111111111111111111111",
      agentAccountCore: "0x2222222222222222222222222222222222222222",
      treasuryPolicy: "0x3333333333333333333333333333333333333333",
      reputationSbt: "0x4444444444444444444444444444444444444444",
      discoveryRegistry: "0x5555555555555555555555555555555555555555"
    },
    roleSigners: {
      owner: roleSigner("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        kind: "multisig_mapped_evm",
        hardwareBackedSignerCount: 3
      }),
      pauser: roleSigner("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", { kind: "hot_pauser_eoa" }),
      verifier: roleSigner("0xcccccccccccccccccccccccccccccccccccccccc", { kind: "kms_eoa" }),
      arbitrator: roleSigner("0xdddddddddddddddddddddddddddddddddddddddd", { kind: "kms_eoa" })
    },
    kms: {
      blockchainSigner: {
        keyId: "arn:aws:kms:eu-central-1:123456789012:key/mainnet-blockchain-signer",
        keySpec: "ECC_SECG_P256K1",
        multiRegion: true,
        rolesAnywhere: true,
        staticAccessKeysRendered: false,
        reusedTestnetKey: false
      },
      jwtSigner: {
        keyId: "arn:aws:kms:eu-central-1:123456789012:key/mainnet-jwt-signer",
        keySpec: "ECC_NIST_P256",
        multiRegion: true,
        rolesAnywhere: true,
        staticAccessKeysRendered: false,
        reusedTestnetKey: false,
        publicKeyFingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        publicKeyPemBase64Present: true
      }
    },
    auth: {
      jwtBackend: "kms",
      jwtPrimaryAlg: "kms",
      hmacVerifyAccepted: false,
      maxTtlSeconds: 2_592_000,
      shareUrlSecretConfigured: true,
      shareUrlSecretInheritedFromJwt: false
    },
    rawFallbacks: {
      signerPrivateKeyRendered: false,
      arbitratorPrivateKeyRendered: false,
      awsStaticAccessKeysRendered: false,
      awsJwtStaticAccessKeysRendered: false,
      authJwtSecretsRendered: false,
      rawJwtSigningSecretRendered: false
    },
    serviceTokens: {
      ciDeploy: serviceToken("prod-mainnet-ci", "prod-mainnet-ci-external"),
      vpsBackend: serviceToken("prod-mainnet-backend", "prod-mainnet-backend-external"),
      vpsIndexer: serviceToken("prod-mainnet-indexer"),
      smokeTests: serviceToken("prod-mainnet-smoke")
    },
    noTestnetReuse: {
      reusedVaultItems: [],
      reusedKmsKeys: [],
      reusedServiceTokens: [],
      reusedWalletSeeds: []
    },
    vendorKeys: [
      {
        name: "github",
        enabled: true,
        mainnetDedicated: true,
        reusedTestnetKey: false,
        rawKeyRendered: false
      },
      {
        name: "resend",
        enabled: false
      }
    ],
    ...overrides
  };
  return base;
}

function roleSigner(address, overrides = {}) {
  return {
    address,
    kind: "eoa",
    freshMainnetKey: true,
    reusedTestnetKey: false,
    rawPrivateKeyFallback: false,
    ...overrides
  };
}

function serviceToken(...vaults) {
  return {
    vaults,
    mainnetOnly: true,
    reusedTestnetToken: false,
    rawTokenRendered: false
  };
}

async function writeEvidenceFile(doc) {
  const dir = await mkdtemp(join(tmpdir(), "mainnet-env-secrets-proof-"));
  const file = join(dir, "evidence.json");
  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return file;
}

test("validateEvidence accepts a complete redacted mainnet env/secrets proof", () => {
  const result = validateEvidence(validEvidence(), {
    now: new Date("2026-05-28T13:00:00.000Z"),
    maxCompletedAgeHours: 24
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.summary.rpcUrl, EXPECTED_MAINNET_RPC_URL);
  assert.equal(result.summary.serviceTokenCount, 4);
});

test("validateEvidence warns when launch freshness is not enforced", () => {
  const result = validateEvidence(validEvidence(), {
    now: new Date("2026-05-28T13:00:00.000Z")
  });
  assert.equal(result.ok, true);
  assert.match(result.warnings[0], /completedAt freshness was not enforced/u);
});

test("validateEvidence rejects testnet RPCs and missing Polkadot docs evidence", () => {
  const result = validateEvidence(validEvidence({
    polkadotDocs: ["reference/polkadot-hub/assets.md"],
    environment: {
      ...validEvidence().environment,
      rpcUrl: "https://eth-rpc-testnet.polkadot.io/",
      additionalRpcUrls: ["http://127.0.0.1:8545"]
    }
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("polkadotDocs must include smart-contracts/precompiles/erc20.md"));
  assert.ok(result.errors.includes(`environment.rpcUrl must be ${EXPECTED_MAINNET_RPC_URL}`));
  assert.ok(result.errors.includes("environment.additionalRpcUrls[0] must not point at testnet, Paseo, localhost, or a private endpoint"));
});

test("validateEvidence rejects a non-mainnet chain id (the silent SIWE break)", () => {
  const result = validateEvidence(validEvidence({
    environment: {
      ...validEvidence().environment,
      chainId: 420420417
    }
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.startsWith(`environment.chainId must be ${EXPECTED_MAINNET_CHAIN_ID}`)));
});

test("validateEvidence rejects an unprovisioned or JWT-inherited SHARE_URL_SECRET", () => {
  const result = validateEvidence(validEvidence({
    auth: {
      ...validEvidence().auth,
      shareUrlSecretConfigured: false,
      shareUrlSecretInheritedFromJwt: true
    }
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("auth.shareUrlSecretConfigured must be true (SHARE_URL_SECRET must be explicitly provisioned for mainnet)"));
  assert.ok(result.errors.includes("auth.shareUrlSecretInheritedFromJwt must be false (do not let SHARE_URL_SECRET fall back to AUTH_JWT_SECRETS once HMAC is retired)"));
});

test("validateEvidence rejects placeholder, zero, or duplicate contract addresses", () => {
  const result = validateEvidence(validEvidence({
    contracts: {
      ...validEvidence().contracts,
      escrowCore: "0x0000000000000000000000000000000000000000",
      discoveryRegistry: "0x3333333333333333333333333333333333333333"
    }
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("contracts.escrowCore must not be the zero address"));
  assert.ok(result.errors.includes("contracts.discoveryRegistry must not reuse contracts.treasuryPolicy"));
});

test("validateEvidence rejects weak KMS and JWT signer posture", () => {
  const result = validateEvidence(validEvidence({
    kms: {
      ...validEvidence().kms,
      blockchainSigner: {
        ...validEvidence().kms.blockchainSigner,
        keySpec: "ECC_NIST_P256",
        multiRegion: false,
        rolesAnywhere: false,
        staticAccessKeysRendered: true
      },
      jwtSigner: {
        ...validEvidence().kms.jwtSigner,
        publicKeyPemBase64Present: false,
        reusedTestnetKey: true
      }
    },
    auth: {
      ...validEvidence().auth,
      hmacVerifyAccepted: true,
      maxTtlSeconds: 9_999_999
    },
    rawFallbacks: {
      ...validEvidence().rawFallbacks,
      signerPrivateKeyRendered: true
    }
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("kms.blockchainSigner.keySpec must be ECC_SECG_P256K1"));
  assert.ok(result.errors.includes("kms.blockchainSigner.multiRegion must be true"));
  assert.ok(result.errors.includes("kms.blockchainSigner.rolesAnywhere must be true"));
  assert.ok(result.errors.includes("kms.blockchainSigner.staticAccessKeysRendered must be false"));
  assert.ok(result.errors.includes("kms.jwtSigner.reusedTestnetKey must be false"));
  assert.ok(result.errors.includes("kms.jwtSigner.publicKeyPemBase64Present must be true"));
  assert.ok(result.errors.includes("auth.hmacVerifyAccepted must be false for mainnet proof"));
  assert.ok(result.errors.includes("auth.maxTtlSeconds must be <= 2592000"));
  assert.ok(result.errors.includes("rawFallbacks.signerPrivateKeyRendered must be false"));
});

test("validateEvidence rejects over-broad or reused service-token scopes", () => {
  const result = validateEvidence(validEvidence({
    serviceTokens: {
      ...validEvidence().serviceTokens,
      vpsBackend: {
        vaults: ["prod-mainnet-backend", "prod-critical", "*"],
        mainnetOnly: false,
        reusedTestnetToken: true,
        rawTokenRendered: true
      }
    },
    noTestnetReuse: {
      ...validEvidence().noTestnetReuse,
      reusedServiceTokens: ["op-token-prod-vps-backend"]
    }
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("serviceTokens.vpsBackend.mainnetOnly must be true"));
  assert.ok(result.errors.includes("serviceTokens.vpsBackend.reusedTestnetToken must be false"));
  assert.ok(result.errors.includes("serviceTokens.vpsBackend.rawTokenRendered must be false"));
  assert.ok(result.errors.includes("serviceTokens.vpsBackend.vaults[1] must not grant prod-critical"));
  assert.ok(result.errors.includes("serviceTokens.vpsBackend.vaults[2] must not be wildcard scoped"));
  assert.ok(result.errors.includes("noTestnetReuse.reusedServiceTokens must be empty"));
});

test("validateEvidence rejects raw secret-looking values inside evidence", () => {
  const result = validateEvidence(validEvidence({
    notes: "accidental private key 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("appears to contain a secret value")));
});

test("validateEvidence rejects stale and future-dated proof when freshness is required", () => {
  const stale = validateEvidence(validEvidence({
    completedAt: "2026-05-27T12:00:00.000Z"
  }), {
    now: new Date("2026-05-28T13:00:00.000Z"),
    maxCompletedAgeHours: 24
  });
  assert.equal(stale.ok, false);
  assert.ok(stale.errors.includes("completedAt must be within 24 hour(s)"));

  const future = validateEvidence(validEvidence({
    completedAt: "2026-05-28T13:10:00.000Z"
  }), {
    now: new Date("2026-05-28T13:00:00.000Z"),
    maxCompletedAgeHours: 24
  });
  assert.equal(future.ok, false);
  assert.ok(future.errors.includes("completedAt must not be in the future"));
});

test("CLI exits zero and prints JSON for valid evidence", async () => {
  const file = await writeEvidenceFile(validEvidence({
    completedAt: "2026-05-28T12:00:00.000Z"
  }));

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    scriptPath,
    "--file",
    file,
    "--max-completed-age-hours",
    "24",
    "--now",
    "2026-05-28T13:00:00.000Z",
    "--json"
  ]);

  const parsed = JSON.parse(stdout);
  assert.equal(stderr, "");
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.summary.jwtBackend, "kms");
  assert.deepEqual(parsed.errors, []);
});

test("CLI exits non-zero for invalid evidence", async () => {
  const file = await writeEvidenceFile(validEvidence({
    environment: {
      ...validEvidence().environment,
      chainEnv: "testnet"
    }
  }));

  await assert.rejects(
    () => execFileAsync(process.execPath, [scriptPath, "--file", file]),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /environment\.chainEnv must be mainnet/u);
      return true;
    }
  );
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseEnvFileText,
  run,
  validateEnvConfig,
  validateRuntimeEvidence
} from "./check-mainnet-usdc-config.mjs";

const CANONICAL_ENV = {
  PROFILE: "mainnet",
  MAINNET_CONFIRM: "I-understand",
  MUTATION_BACKEND: "required",
  TOKEN_ADDRESS: "0x0000053900000000000000000000000001200000",
  SUPPORTED_ASSETS_JSON: JSON.stringify([
    {
      symbol: "USDC",
      assetClass: "trust_backed",
      assetId: 1337,
      address: "0x0000053900000000000000000000000001200000",
      decimals: 6
    }
  ]),
  DAILY_OUTFLOW_CAP: "250000000",
  BORROW_CAP: "25000000",
  MIN_COLLATERAL_RATIO_BPS: "20000",
  DEFAULT_CLAIM_STAKE_BPS: "1000",
  ONBOARDING_WAIVER_CLAIM_COUNT: "3",
  CLAIM_FEE_BPS: "200",
  MIN_CLAIM_FEE: "50000",
  CLAIM_FEE_VERIFIER_BPS: "7000",
  REJECTION_SKILL_PENALTY: "10",
  REJECTION_RELIABILITY_PENALTY: "25",
  DISPUTE_LOSS_SKILL_PENALTY: "35",
  DISPUTE_LOSS_RELIABILITY_PENALTY: "60"
};

const CANONICAL_RUNTIME_EVIDENCE = {
  schema: "mainnet-usdc-asset-config-v1",
  network: "polkadot-hub-mainnet",
  checkedAt: "2026-05-28T00:00:00.000Z",
  polkadotDocs: [
    "smart-contracts/precompiles/erc20.md",
    "reference/polkadot-hub/assets.md"
  ],
  runtime: {
    source: "Polkadot Hub mainnet runtime state",
    blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  asset: {
    symbol: "USDC",
    assetClass: "trust_backed",
    assetId: 1337,
    address: "0x0000053900000000000000000000000001200000",
    decimals: 6,
    sufficient: true,
    minBalanceRaw: "70000"
  },
  erc20Precompile: {
    address: "0x0000053900000000000000000000000001200000",
    implementedFunctions: [
      "totalSupply",
      "transfer",
      "balanceOf",
      "allowance",
      "approve",
      "transferFrom"
    ],
    metadataFunctionsImplemented: false
  }
};

test("parseEnvFileText accepts simple shell-style key values", () => {
  assert.deepEqual(
    parseEnvFileText([
      "# comment",
      "PROFILE=mainnet",
      "export MAINNET_CONFIRM='I-understand'",
      'MUTATION_BACKEND="required"'
    ].join("\n")),
    {
      PROFILE: "mainnet",
      MAINNET_CONFIRM: "I-understand",
      MUTATION_BACKEND: "required"
    }
  );
});

test("validateEnvConfig accepts canonical mainnet USDC env", () => {
  const result = validateEnvConfig(CANONICAL_ENV);
  assert.equal(result.ok, true);
});

test("validateEnvConfig rejects non-canonical token address", () => {
  const result = validateEnvConfig({
    ...CANONICAL_ENV,
    TOKEN_ADDRESS: "0x1111111111111111111111111111111111111111"
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.name === "TOKEN_ADDRESS").ok, false);
});

test("validateEnvConfig rejects stale launch parameter defaults", () => {
  const result = validateEnvConfig({
    ...CANONICAL_ENV,
    BORROW_CAP: "25000000000000000000"
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.name === "launch.BORROW_CAP").ok, false);
});

test("validateEnvConfig rejects non-USDC supported asset metadata", () => {
  const result = validateEnvConfig({
    ...CANONICAL_ENV,
    SUPPORTED_ASSETS_JSON: JSON.stringify([
      {
        symbol: "DOT",
        assetClass: "custom",
        assetId: 0,
        address: "0x5555555555555555555555555555555555555555",
        decimals: 18
      }
    ])
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.name === "SUPPORTED_ASSETS_JSON[0].symbol").ok, false);
  assert.equal(result.checks.find((check) => check.name === "SUPPORTED_ASSETS_JSON[0].address").ok, false);
});

test("validateRuntimeEvidence accepts canonical docs/runtime evidence", () => {
  const result = validateRuntimeEvidence(CANONICAL_RUNTIME_EVIDENCE);
  assert.equal(result.ok, true);
});

test("validateRuntimeEvidence rejects missing Polkadot docs evidence", () => {
  const result = validateRuntimeEvidence({
    ...CANONICAL_RUNTIME_EVIDENCE,
    polkadotDocs: ["reference/polkadot-hub/assets.md"]
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.checks.find((check) => check.name === "polkadotDocs.smart-contracts/precompiles/erc20.md").ok,
    false
  );
});

test("validateRuntimeEvidence rejects metadata-function assumptions", () => {
  const result = validateRuntimeEvidence({
    ...CANONICAL_RUNTIME_EVIDENCE,
    erc20Precompile: {
      ...CANONICAL_RUNTIME_EVIDENCE.erc20Precompile,
      metadataFunctionsImplemented: true
    }
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.checks.find((check) => check.name === "erc20Precompile.metadataFunctionsImplemented").ok,
    false
  );
});

test("run can require runtime evidence", () => {
  const result = run({
    envPath: "deployments/mainnet.env.example",
    requireRuntime: true
  });
  assert.equal(result.ok, false);
  assert.equal(result.results.find((scope) => scope.scope === "runtimeEvidence").ok, false);
});

#!/usr/bin/env node

/**
 * Validate the mainnet v1 USDC asset configuration.
 *
 * This is intentionally split into two layers:
 *   1. Static config: private deploy env matches the canonical USDC launch
 *      profile and the Polkadot Hub ERC20-precompile address derivation.
 *   2. Runtime evidence: an operator-captured JSON artifact proves the same
 *      asset metadata against mainnet runtime state before real-funds launch.
 *
 * The script does not call chain RPC. It validates the env/evidence artifacts
 * that are safe to commit or upload after secrets are redacted.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_ESCROW_ASSET } from "../../mcp-server/src/core/assets.js";
import { derivePolkadotHubAssetAddress } from "../../mcp-server/src/services/strategy-asset-config.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const REQUIRED_DOC_PATHS = new Set([
  "smart-contracts/precompiles/erc20.md",
  "reference/polkadot-hub/assets.md"
]);

const REQUIRED_ERC20_FUNCTIONS = [
  "totalSupply",
  "transfer",
  "balanceOf",
  "allowance",
  "approve",
  "transferFrom"
];

const EXPECTED_LAUNCH_VALUES = {
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

const CANONICAL_USDC = Object.freeze({
  symbol: DEFAULT_ESCROW_ASSET.symbol,
  assetClass: DEFAULT_ESCROW_ASSET.assetClass,
  assetId: DEFAULT_ESCROW_ASSET.assetId,
  address: DEFAULT_ESCROW_ASSET.address.toLowerCase(),
  decimals: DEFAULT_ESCROW_ASSET.decimals
});

function usage() {
  return [
    "Usage:",
    "  node scripts/ops/check-mainnet-usdc-config.mjs [--env <path>] [--runtime-evidence <path>] [--require-runtime] [--json]",
    "",
    "Defaults:",
    "  --env deployments/mainnet.env.example"
  ].join("\n");
}

export function parseArgs(argv) {
  const args = {
    envPath: "deployments/mainnet.env.example",
    runtimeEvidencePath: undefined,
    requireRuntime: false,
    json: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--env") args.envPath = argv[++i];
    else if (arg === "--runtime-evidence") args.runtimeEvidencePath = argv[++i];
    else if (arg === "--require-runtime") args.requireRuntime = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

export function parseEnvFileText(text) {
  const env = {};
  const lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) continue;
    const [, key, rawValue] = match;
    env[key] = stripEnvQuotes(rawValue.trim());
  }
  return env;
}

function stripEnvQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function loadText(path) {
  const absPath = resolve(repoRoot, path);
  if (!existsSync(absPath)) {
    throw new Error(`File does not exist: ${path}`);
  }
  return readFileSync(absPath, "utf8");
}

function addCheck(checks, name, ok, detail = {}) {
  checks.push({ name, ok: Boolean(ok), ...detail });
}

function assertCanonicalUsdcAsset(entry, label, checks) {
  const normalized = normalizeAssetEntry(entry);
  const derivedAddress = derivePolkadotHubAssetAddress({
    assetClass: normalized.assetClass,
    assetId: normalized.assetId
  });

  addCheck(checks, `${label}.symbol`, normalized.symbol === CANONICAL_USDC.symbol, {
    expected: CANONICAL_USDC.symbol,
    actual: normalized.symbol
  });
  addCheck(checks, `${label}.assetClass`, normalized.assetClass === CANONICAL_USDC.assetClass, {
    expected: CANONICAL_USDC.assetClass,
    actual: normalized.assetClass
  });
  addCheck(checks, `${label}.assetId`, normalized.assetId === CANONICAL_USDC.assetId, {
    expected: CANONICAL_USDC.assetId,
    actual: normalized.assetId
  });
  addCheck(checks, `${label}.decimals`, normalized.decimals === CANONICAL_USDC.decimals, {
    expected: CANONICAL_USDC.decimals,
    actual: normalized.decimals
  });
  addCheck(checks, `${label}.derivedAddress`, derivedAddress === CANONICAL_USDC.address, {
    expected: CANONICAL_USDC.address,
    actual: derivedAddress
  });
  addCheck(checks, `${label}.address`, normalized.address === CANONICAL_USDC.address, {
    expected: CANONICAL_USDC.address,
    actual: normalized.address
  });

  return normalized;
}

function normalizeAssetEntry(entry) {
  return {
    symbol: String(entry?.symbol ?? "").trim(),
    assetClass: String(entry?.assetClass ?? "").trim().toLowerCase().replace(/[\s-]+/gu, "_"),
    assetId: Number(entry?.assetId),
    address: String(entry?.address ?? "").trim().toLowerCase(),
    decimals: Number(entry?.decimals)
  };
}

export function validateEnvConfig(env) {
  const checks = [];

  addCheck(checks, "PROFILE", env.PROFILE === "mainnet", {
    expected: "mainnet",
    actual: env.PROFILE
  });
  addCheck(checks, "MAINNET_CONFIRM", env.MAINNET_CONFIRM === "I-understand", {
    expected: "I-understand",
    actual: env.MAINNET_CONFIRM
  });
  addCheck(checks, "MUTATION_BACKEND", env.MUTATION_BACKEND === "required", {
    expected: "required",
    actual: env.MUTATION_BACKEND
  });
  addCheck(checks, "TOKEN_ADDRESS", String(env.TOKEN_ADDRESS ?? "").toLowerCase() === CANONICAL_USDC.address, {
    expected: CANONICAL_USDC.address,
    actual: env.TOKEN_ADDRESS
  });

  for (const [key, expected] of Object.entries(EXPECTED_LAUNCH_VALUES)) {
    addCheck(checks, `launch.${key}`, String(env[key] ?? "") === expected, {
      expected,
      actual: env[key]
    });
  }

  let supportedAssets = [];
  try {
    supportedAssets = JSON.parse(env.SUPPORTED_ASSETS_JSON ?? "null");
    addCheck(checks, "SUPPORTED_ASSETS_JSON.validJson", Array.isArray(supportedAssets), {
      expected: "array",
      actual: Array.isArray(supportedAssets) ? "array" : typeof supportedAssets
    });
  } catch (error) {
    addCheck(checks, "SUPPORTED_ASSETS_JSON.validJson", false, { error: error.message });
  }

  if (Array.isArray(supportedAssets)) {
    addCheck(checks, "SUPPORTED_ASSETS_JSON.usdcOnly", supportedAssets.length === 1, {
      expected: 1,
      actual: supportedAssets.length
    });
    assertCanonicalUsdcAsset(supportedAssets[0], "SUPPORTED_ASSETS_JSON[0]", checks);
  }

  return makeResult("env", checks);
}

export function validateRuntimeEvidence(evidence) {
  const checks = [];

  addCheck(checks, "schema", evidence?.schema === "mainnet-usdc-asset-config-v1", {
    expected: "mainnet-usdc-asset-config-v1",
    actual: evidence?.schema
  });
  addCheck(checks, "network", evidence?.network === "polkadot-hub-mainnet", {
    expected: "polkadot-hub-mainnet",
    actual: evidence?.network
  });
  addCheck(checks, "checkedAt", isValidIsoDate(evidence?.checkedAt), {
    actual: evidence?.checkedAt
  });

  const docs = Array.isArray(evidence?.polkadotDocs) ? evidence.polkadotDocs : [];
  for (const path of REQUIRED_DOC_PATHS) {
    addCheck(checks, `polkadotDocs.${path}`, docs.includes(path), {
      expected: path,
      actual: docs
    });
  }

  const asset = assertCanonicalUsdcAsset(evidence?.asset, "asset", checks);
  addCheck(checks, "asset.sufficient", evidence?.asset?.sufficient === true, {
    expected: true,
    actual: evidence?.asset?.sufficient
  });
  addCheck(checks, "asset.minBalanceRaw", isNonNegativeIntegerString(evidence?.asset?.minBalanceRaw), {
    actual: evidence?.asset?.minBalanceRaw
  });
  addCheck(checks, "asset.minBalanceRaw.positive", BigIntSafe(evidence?.asset?.minBalanceRaw) > 0n, {
    actual: evidence?.asset?.minBalanceRaw
  });

  const runtime = evidence?.runtime ?? {};
  addCheck(checks, "runtime.blockHash", /^0x[a-fA-F0-9]{64}$/u.test(String(runtime.blockHash ?? "")), {
    actual: runtime.blockHash
  });
  addCheck(checks, "runtime.source", typeof runtime.source === "string" && runtime.source.trim().length > 0, {
    actual: runtime.source
  });

  const precompile = evidence?.erc20Precompile ?? {};
  addCheck(checks, "erc20Precompile.address", String(precompile.address ?? "").toLowerCase() === CANONICAL_USDC.address, {
    expected: CANONICAL_USDC.address,
    actual: precompile.address
  });
  const functions = Array.isArray(precompile.implementedFunctions)
    ? precompile.implementedFunctions
    : [];
  for (const fn of REQUIRED_ERC20_FUNCTIONS) {
    addCheck(checks, `erc20Precompile.implementedFunctions.${fn}`, functions.includes(fn), {
      expected: fn,
      actual: functions
    });
  }
  addCheck(checks, "erc20Precompile.metadataFunctionsImplemented", precompile.metadataFunctionsImplemented === false, {
    expected: false,
    actual: precompile.metadataFunctionsImplemented
  });

  return {
    ...makeResult("runtimeEvidence", checks),
    asset
  };
}

function isValidIsoDate(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isNonNegativeIntegerString(value) {
  return typeof value === "string" && /^\d+$/u.test(value);
}

function BigIntSafe(value) {
  try {
    if (!isNonNegativeIntegerString(value)) return -1n;
    return BigInt(value);
  } catch {
    return -1n;
  }
}

function makeResult(scope, checks) {
  return {
    scope,
    ok: checks.every((check) => check.ok),
    checks
  };
}

export function run({ envPath, runtimeEvidencePath, requireRuntime }) {
  const env = parseEnvFileText(loadText(envPath));
  const envResult = validateEnvConfig(env);
  const results = [envResult];

  if (runtimeEvidencePath) {
    const evidence = JSON.parse(loadText(runtimeEvidencePath));
    results.push(validateRuntimeEvidence(evidence));
  } else if (requireRuntime) {
    results.push(makeResult("runtimeEvidence", [
      {
        name: "runtimeEvidence.required",
        ok: false,
        expected: "Provide --runtime-evidence <path> when --require-runtime is set."
      }
    ]));
  }

  return {
    ok: results.every((result) => result.ok),
    envPath,
    runtimeEvidencePath,
    canonical: CANONICAL_USDC,
    results
  };
}

function printHuman(result) {
  console.log("Mainnet USDC config check");
  console.log(`env: ${result.envPath}`);
  if (result.runtimeEvidencePath) console.log(`runtime evidence: ${result.runtimeEvidencePath}`);
  console.log(`canonical USDC: ${result.canonical.symbol} assetId=${result.canonical.assetId} address=${result.canonical.address} decimals=${result.canonical.decimals}`);
  for (const scope of result.results) {
    console.log("");
    console.log(`${scope.scope}: ${scope.ok ? "ok" : "failed"}`);
    for (const check of scope.checks) {
      if (check.ok) continue;
      console.log(`  - ${check.name}: expected ${JSON.stringify(check.expected)} got ${JSON.stringify(check.actual)}`);
      if (check.error) console.log(`    ${check.error}`);
    }
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(2);
  }

  if (args.help) {
    console.log(usage());
    return;
  }

  try {
    const result = run(args);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHuman(result);
    }
    if (!result.ok) process.exit(1);
  } catch (error) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    } else {
      console.error(error.message);
    }
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

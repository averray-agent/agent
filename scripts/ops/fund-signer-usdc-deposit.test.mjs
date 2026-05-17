// Tests for scripts/ops/fund-signer-usdc-deposit.mjs.
//
// Two layers:
//   1. Pure parseArgs unit tests — argument parsing matrix.
//   2. CLI-level error-path tests — spawn the script and assert the
//      KMS-mode validation errors surface before any network/AWS call.
//
// Neither layer hits AWS or the chain. The full happy path is exercised
// indirectly by run-hosted-worker-loop integration smoke tests; locally
// the dry-run is the regression contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { parseArgs } from "./fund-signer-usdc-deposit.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, "fund-signer-usdc-deposit.mjs");

test("parseArgs: dry-run is the default and useKms is off", () => {
  const args = parseArgs([]);
  assert.equal(args.dryRun, true);
  assert.equal(args.useKms, false);
  assert.equal(args.profile, "testnet");
  assert.equal(args.amount, undefined);
});

test("parseArgs: --commit flips dryRun off", () => {
  const args = parseArgs(["--commit", "--amount", "10000000"]);
  assert.equal(args.dryRun, false);
  assert.equal(args.useKms, false);
  assert.equal(args.amount, "10000000");
});

test("parseArgs: --use-kms is independent of --commit", () => {
  // KMS-aware dry-run: --use-kms without --commit.
  const dryRun = parseArgs(["--use-kms", "--amount", "100000"]);
  assert.equal(dryRun.useKms, true);
  assert.equal(dryRun.dryRun, true);

  // KMS-signed commit: both flags set.
  const commit = parseArgs(["--use-kms", "--commit", "--amount", "100000"]);
  assert.equal(commit.useKms, true);
  assert.equal(commit.dryRun, false);
});

test("parseArgs: --profile picks a non-default deployments file", () => {
  const args = parseArgs(["--profile", "mainnet", "--amount", "1"]);
  assert.equal(args.profile, "mainnet");
});

test("parseArgs: --help is captured even when other flags are present", () => {
  const args = parseArgs(["--commit", "--help", "--amount", "1"]);
  assert.equal(args.help, true);
});

// --- CLI-level error paths (no AWS, no chain) -----------------------------

test("CLI: --use-kms without KMS_KEY_ID exits 1 before any AWS call", () => {
  const result = spawnSync("node", [scriptPath, "--amount", "1", "--use-kms"], {
    env: {
      ...process.env,
      KMS_KEY_ID: "",
      AWS_REGION: "eu-central-2",
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /--use-kms requires KMS_KEY_ID/u);
});

test("CLI: --use-kms without AWS_REGION exits 1 before any AWS call", () => {
  const result = spawnSync("node", [scriptPath, "--amount", "1", "--use-kms"], {
    env: {
      ...process.env,
      KMS_KEY_ID: "alias/dummy",
      AWS_REGION: "",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /--use-kms requires AWS_REGION/u);
});

test("CLI: --commit (no --use-kms) without PRIVATE_KEY exits 1 and hints at KMS path", () => {
  const result = spawnSync("node", [scriptPath, "--amount", "1", "--commit"], {
    env: {
      ...process.env,
      PRIVATE_KEY: "",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /PRIVATE_KEY env .* is required with --commit/u);
  assert.match(result.stderr, /Use --use-kms for KMS-backed signers/u);
});

test("CLI: --help prints both signer backends and SIGNER_ADDRESS_OVERRIDE", () => {
  const result = spawnSync("node", [scriptPath, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--use-kms/u);
  assert.match(result.stdout, /PRIVATE_KEY/u);
  assert.match(result.stdout, /KMS_KEY_ID/u);
  assert.match(result.stdout, /AWS_REGION/u);
  assert.match(result.stdout, /SIGNER_ADDRESS_OVERRIDE/u);
});

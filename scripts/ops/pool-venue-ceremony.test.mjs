import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROOF_RETURN_WINDOW_SECONDS,
  STANDING_RETURN_WINDOW_SECONDS,
  assertAccountingPostcondition,
  assertDeployAdmission,
  assertExpectedSigner,
  assertObservability,
  parseArgs,
} from "./pool-venue-ceremony.mjs";

const OPERATOR = "0x5a6836c6D4d293F6E5377E6c28054F4171915813";
const POOL = "0xCCF5FDF3108AF8e693F28bb9326A573d9dA0F476";
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
    assets: "2000000",
    returnBy: undefined,
    deploymentKind: "proof",
    deploymentId: undefined,
    recallId: undefined,
    expectedSigner: undefined,
    observabilityUrl: undefined,
    useKms: false,
    commit: false,
    help: false,
  });
  assert.equal(parseArgs(["settle", "--recall-id", "3", "--commit", "--use-kms"]).recallId, "3");
  assert.equal(parseArgs(["recall", "--deployment-id", "2", "--assets", "500000"]).command, "recall");
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

test("observability must be live, current-generation, reconciled, and event-readable", () => {
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
  assert.throws(() => assertObservability({ ...base, reconciled: false }, {
    poolAddress: POOL,
    chainTimestamp: 1_800_000_100n,
  }), /not reconciled/u);
  assert.throws(() => assertObservability({ ...base, flows: { status: "unavailable" } }, {
    poolAddress: POOL,
    chainTimestamp: 1_800_000_100n,
  }), /event flow is unavailable/u);
  assert.throws(() => assertObservability({ ...base, pool: OPERATOR }, {
    poolAddress: POOL,
    chainTimestamp: 1_800_000_100n,
  }), /different pool generation/u);
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

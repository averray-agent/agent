import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_ESCROW_ASSET } from "./assets.js";
import {
  buildSubmissionValidationContract,
  decimalToBaseUnits,
  formatBaseUnits,
  getTreasuryPolicyStatusSafely,
  getXcmObservationRelayStatusSafely,
  getXcmSettlementWatcherStatusSafely,
  minBalanceRawForAsset,
  sumSubJobRewards,
  validationPathFromError
} from "./platform-service-helpers.js";

test("sumSubJobRewards normalizes asset symbols and ignores negative rewards", () => {
  const total = sumSubJobRewards([
    { rewardAsset: "dot", rewardAmount: 1.25 },
    { rewardAsset: "DOT", rewardAmount: 2 },
    { rewardAsset: "USDC", rewardAmount: 10 },
    { rewardAsset: "DOT", rewardAmount: -5 },
    { rewardAsset: "DOT", rewardAmount: undefined }
  ], "DOT");

  assert.equal(total, 3.25);
});

test("minBalanceRawForAsset reads explicit and known trust-backed min balances", () => {
  assert.equal(minBalanceRawForAsset({ minBalanceRaw: " 12345 " }), 12345n);
  assert.equal(minBalanceRawForAsset({ minBalanceRaw: 987n }), 987n);
  assert.equal(minBalanceRawForAsset({ minBalanceRaw: -1n }), undefined);
  assert.equal(minBalanceRawForAsset({ ...DEFAULT_ESCROW_ASSET, minBalanceRaw: undefined }), 70000n);
  assert.equal(minBalanceRawForAsset({ symbol: "DOT" }), undefined);
});

test("decimal/base-unit helpers preserve exact token math", () => {
  assert.equal(decimalToBaseUnits("0.07", 6, "rewardAmount"), 70000n);
  assert.equal(decimalToBaseUnits(0.14, 6, "rewardAmount"), 140000n);
  assert.equal(formatBaseUnits(70000n, 6), "0.07");
  assert.equal(formatBaseUnits(140000n, 6), "0.14");
  assert.throws(
    () => decimalToBaseUnits("0.0000001", 6, "rewardAmount"),
    /rewardAmount must fit 6 decimal places/u
  );
  assert.throws(
    () => decimalToBaseUnits("1", 31, "rewardAmount"),
    /asset decimals must be an integer/u
  );
});

test("safe status readers return fallbacks instead of throwing", async () => {
  const policyError = new Error("getTreasuryPolicyStatus failed");
  policyError.code = "blockchain_revert";
  policyError.details = { rawReason: "require(false)" };
  const policy = await getTreasuryPolicyStatusSafely({
    config: { treasuryPolicyAddress: "0x1111111111111111111111111111111111111111" },
    isEnabled: () => true,
    getTreasuryPolicyStatus: async () => {
      throw policyError;
    }
  });
  assert.equal(policy.enabled, true);
  assert.equal(policy.policyAddress, "0x1111111111111111111111111111111111111111");
  assert.equal(policy.error.code, "blockchain_revert");
  assert.equal(policy.error.details.rawReason, "require(false)");

  const settlement = await getXcmSettlementWatcherStatusSafely({
    enabled: true,
    running: true,
    getStatus: async () => {
      throw new Error("watcher unavailable");
    }
  });
  assert.equal(settlement.enabled, true);
  assert.equal(settlement.running, true);
  assert.equal(settlement.error.code, "xcm_settlement_watcher_status_error");

  const observation = await getXcmObservationRelayStatusSafely({
    enabled: true,
    running: false,
    syncing: true,
    feedUrl: "https://feed.example.invalid",
    batchSize: 5,
    pollIntervalMs: 1000,
    getStatus: async () => {
      throw new Error("relay unavailable");
    }
  });
  assert.equal(observation.enabled, true);
  assert.equal(observation.syncing, true);
  assert.equal(observation.feedUrl, "https://feed.example.invalid");
  assert.equal(observation.error.code, "xcm_observation_relay_status_error");
});

test("submission validation helpers expose schema shape and normalized error paths", () => {
  const contract = buildSubmissionValidationContract({
    outputSchemaRef: "schema://jobs/coding-output"
  });

  assert.equal(contract.schemaValidates, "payload.submission");
  assert.equal(contract.submissionShape, "direct_schema_object");
  assert.equal(contract.doNotWrapInOutput, true);
  assert.deepEqual(contract.requiredTopLevelKeys, ["summary", "output", "status"]);

  assert.equal(
    validationPathFromError({ details: { expectedPath: "submission.output" } }),
    "payload.submission.output"
  );
  assert.equal(
    validationPathFromError({ message: "Invalid value at payload.submission.citations[0]" }),
    "payload.submission.citations[0]"
  );
  assert.equal(validationPathFromError({ message: "no path here" }), undefined);
});

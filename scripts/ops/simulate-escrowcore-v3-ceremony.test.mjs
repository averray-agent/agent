import test from "node:test";
import assert from "node:assert/strict";

import {
  MAINNET_ADMIN_DEPLOYER,
  RATIFIED_V3_SCHEDULE,
  assertCeremonyPostconditions,
  parseArgs,
  validateSimulationArgs
} from "./simulate-escrowcore-v3-ceremony.mjs";

const ADDRESS = {
  predicted: "0x1111111111111111111111111111111111111111",
  policy: "0x2222222222222222222222222222222222222222",
  accounts: "0x3333333333333333333333333333333333333333",
  reputation: "0x4444444444444444444444444444444444444444",
  treasury: "0x5555555555555555555555555555555555555555"
};

test("fork simulation requires the ratified deployer and never infers it from the manifest", () => {
  assert.throws(
    () => validateSimulationArgs(parseArgs(["--fork-url", "https://rpc.invalid"])),
    /--expected-deployer is required/u
  );
  assert.throws(
    () => validateSimulationArgs(parseArgs([
      "--fork-url", "https://rpc.invalid",
      "--expected-deployer", ADDRESS.predicted
    ])),
    /must be the ratified mainnet admin EOA/u
  );
  const parsed = validateSimulationArgs(parseArgs([
    "--fork-url", "https://rpc.invalid",
    "--expected-deployer", MAINNET_ADMIN_DEPLOYER,
    "--fork-block-number", "19380506"
  ]));
  assert.equal(parsed.expectedDeployer, MAINNET_ADMIN_DEPLOYER);
  assert.equal(parsed.forkBlockNumber, 19_380_506);
});

function validState() {
  return {
    predictedAddress: ADDRESS.predicted,
    deployedAddress: ADDRESS.predicted,
    runtimeCodeBytes: 26_580,
    manifestPolicy: ADDRESS.policy,
    manifestAccounts: ADDRESS.accounts,
    manifestReputation: ADDRESS.reputation,
    manifestTreasury: ADDRESS.treasury,
    boundPolicy: ADDRESS.policy,
    boundAccounts: ADDRESS.accounts,
    boundReputation: ADDRESS.reputation,
    treasuryAccount: ADDRESS.treasury,
    newSettlementBroker: true,
    newReputationWriter: true,
    newEscrowOperator: true,
    oldSettlementBroker: true,
    oldReputationWriter: true,
    oldEscrowOperator: true,
    kmsSettlementBroker: true,
    kmsVerifier: true,
    adminSettlementBroker: false,
    adminVerifier: false,
    schedule: { ...RATIFIED_V3_SCHEDULE },
    feeScheduleEvent: {
      newRetentionFlatRaw: RATIFIED_V3_SCHEDULE.retentionFlatRaw,
      newRetentionCapBps: RATIFIED_V3_SCHEDULE.retentionCapBps,
      newPosterFeeBps: RATIFIED_V3_SCHEDULE.posterFeeBps,
      newPosterFeeFloorRaw: RATIFIED_V3_SCHEDULE.posterFeeFloorRaw
    }
  };
}

test("postcondition gate accepts only the predicted address, exact wiring, drain roles, and decoded D4 schedule", () => {
  assert.equal(assertCeremonyPostconditions(validState()).deployedAddress, ADDRESS.predicted);

  for (const mutation of [
    (state) => { state.deployedAddress = "0x6666666666666666666666666666666666666666"; },
    (state) => { state.newEscrowOperator = false; },
    (state) => { state.oldSettlementBroker = false; },
    (state) => { state.kmsVerifier = false; },
    (state) => { state.adminSettlementBroker = true; },
    (state) => { state.runtimeCodeBytes = 100 * 1_024 + 1; },
    (state) => { state.schedule.retentionFlatRaw = 49_999n; },
    (state) => { state.feeScheduleEvent.newPosterFeeFloorRaw = 49_999n; }
  ]) {
    const state = validState();
    mutation(state);
    assert.throws(() => assertCeremonyPostconditions(state), /fork simulation failed/u);
  }
});

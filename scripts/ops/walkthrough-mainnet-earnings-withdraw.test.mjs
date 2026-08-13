import assert from "node:assert/strict";
import test from "node:test";

import { Interface } from "ethers";

import { verifyWithdrawDoorResponse } from "./walkthrough-mainnet-earnings-withdraw.mjs";

const WALLET = "0x1111111111111111111111111111111111111111";
const AAC = "0x2222222222222222222222222222222222222222";
const USDC = "0x3333333333333333333333333333333333333333";
const DESTINATION = "0x4444444444444444444444444444444444444444";

function response(overrides = {}) {
  return {
    available: true,
    wallet: WALLET,
    templates: [{
      step: "withdraw",
      unsigned: true,
      from: WALLET,
      to: AAC,
      data: new Interface(["function withdraw(address,uint256)"]).encodeFunctionData("withdraw", [USDC, 7n]),
      value: "0",
      chainId: 420420419
    }, {
      step: "transfer_to_destination",
      unsigned: true,
      from: WALLET,
      to: USDC,
      data: new Interface(["function transfer(address,uint256)"]).encodeFunctionData("transfer", [DESTINATION, 7n]),
      value: "0",
      chainId: 420420419,
      prerequisite: "withdraw_confirmed_on_chain"
    }],
    whatYourBalanceCanDo: {
      retentionNotGates: {
        templatesRemainComplete: true,
        conditionsWithdrawal: false,
        delaysWithdrawal: false,
        pricesWithdrawal: false,
        addsWithdrawalSteps: false
      }
    },
    ...overrides
  };
}

test("walkthrough independently verifies both templates before a signature is possible", () => {
  assert.equal(verifyWithdrawDoorResponse({
    response: response(),
    wallet: WALLET,
    agentAccountCore: AAC,
    asset: USDC,
    amount: "7",
    destination: DESTINATION
  }), true);
});

test("walkthrough rejects an amount substitution and a retention gate", () => {
  assert.throws(() => verifyWithdrawDoorResponse({
    response: response(), wallet: WALLET, agentAccountCore: AAC, asset: USDC, amount: "8", destination: DESTINATION
  }), /calldata decode did not match/u);
  const gated = response();
  gated.whatYourBalanceCanDo.retentionNotGates.conditionsWithdrawal = true;
  assert.throws(() => verifyWithdrawDoorResponse({
    response: gated, wallet: WALLET, agentAccountCore: AAC, asset: USDC, amount: "7", destination: DESTINATION
  }), /illegally gates withdrawal/u);
});

test("walkthrough rejects a target substitution before broadcast", () => {
  const tampered = response();
  tampered.templates[0].to = DESTINATION;
  assert.throws(() => verifyWithdrawDoorResponse({
    response: tampered, wallet: WALLET, agentAccountCore: AAC, asset: USDC, amount: "7", destination: DESTINATION
  }), /target is not/u);
});

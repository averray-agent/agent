import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { accountDepositTransactionsFromIntent } from "./account-deposit-transaction.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x0000053900000000000000000000000001200000";
const ACCOUNT = "0x3333333333333333333333333333333333333333";

function intent() {
  return {
    chainId: 420420419,
    templates: [
      {
        step: "approve",
        unsigned: true,
        from: WALLET,
        to: TOKEN,
        data: "0x1234",
        value: "0",
        chainId: 420420419
      },
      {
        step: "deposit",
        unsigned: true,
        from: WALLET,
        to: ACCOUNT,
        data: "0x5678",
        value: "0",
        chainId: 420420419,
        prerequisite: "approve_confirmed_on_chain"
      }
    ]
  };
}

test("account deposit intent exposes exactly approve then prerequisite-bound deposit", () => {
  assert.deepEqual(accountDepositTransactionsFromIntent(intent(), WALLET), [
    { from: WALLET, to: TOKEN, data: "0x1234", value: "0x0" },
    { from: WALLET, to: ACCOUNT, data: "0x5678", value: "0x0" }
  ]);
});

test("account deposit intent fails closed on wallet drift or missing approval prerequisite", () => {
  assert.equal(
    accountDepositTransactionsFromIntent(intent(), "0x2222222222222222222222222222222222222222"),
    null
  );
  const missingPrerequisite = intent();
  delete missingPrerequisite.templates[1].prerequisite;
  assert.equal(accountDepositTransactionsFromIntent(missingPrerequisite, WALLET), null);
});

test("work-withdraw route mounts deposit beside the unchanged withdrawal component", async () => {
  const [page, withdrawal, deposit] = await Promise.all([
    readFile(new URL("../../app/(worker)/work-withdraw/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../components/work/WorkWithdrawal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../components/work/WorkAccountDeposit.tsx", import.meta.url), "utf8")
  ]);
  assert.match(page, /<WorkAccountDeposit\s*\/>/u);
  assert.match(page, /<WorkWithdrawal\s*\/>/u);
  assert.match(deposit, /Build deposit/u);
  assert.match(deposit, /AgentAccountCore has no depositFor/u);
  assert.match(deposit, /brokered claim does not broker the deposit/u);
  assert.match(deposit, /pay.*gas.*DOT/iu);
  assert.match(withdrawal, /getClient\(\)\.buildWithdrawTransactions/u);
  assert.doesNotMatch(deposit, /private.?key|mnemonic|signed.?transaction|raw.?transaction/iu);
});

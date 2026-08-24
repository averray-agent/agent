import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  runReceiptBindingCli,
  verifyReceiptBinding
} from "./verify-receipt-binding.mjs";

const fixtureUrl = new URL("./fixtures/receipt-binding-v1.json", import.meta.url);

test("public replay fixture reproduces the receipt-keyed Verified event", async () => {
  const line = await runReceiptBindingCli(["--fixture", fixtureUrl.pathname]);
  assert.equal(
    line,
    "FIXTURE PASS receipt-keyed, operator-verified receipt 0x1111111111111111111111111111111111111111111111111111111111111111 commitment 0x33952ce4b3701db636d26570bb1898c9a3fa38c797efb7d11ec18b2b87bea358 tx 0x6666666666666666666666666666666666666666666666666666666666666666 log 3"
  );
});

test("public replay fails closed when receipt content no longer matches its commitment", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  fixture.receipt.verdict.reasonCode = "MUTATED";
  await assert.rejects(
    () => verifyReceiptBinding(fixture),
    /Receipt commitment mismatch/u
  );
});

test("public replay fails closed when the named log is not from EscrowCore", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  fixture.transactionReceipt.logs[0].address = "0x9999999999999999999999999999999999999999";
  await assert.rejects(
    () => verifyReceiptBinding(fixture),
    /was not emitted by the configured EscrowCore/u
  );
});

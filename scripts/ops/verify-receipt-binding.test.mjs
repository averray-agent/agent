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

test("fetch path verifies both flat and enveloped receipts without trusting unsigned presentation", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  for (const envelope of [false, true]) {
    let destroyed = false;
    const line = await runReceiptBindingCli([fixture.receipt.receiptId, "--escrow", fixture.escrowAddress], {
      fetchImpl: async (url) => {
        assert.ok(url.endsWith("/receipts/" + fixture.receipt.receiptId));
        return Response.json(envelope ? { schemaVersion: "averray.receipt-envelope.v1", document: fixture.receipt,
          unsignedPresentation: { chainBinding: { verifiedTxHash: "untrusted" } } } : fixture.receipt);
      },
      providerFactory: () => ({
        getTransactionReceipt: async (hash) => {
          assert.equal(hash, fixture.receipt.chainBinding.verifiedTxHash);
          return fixture.transactionReceipt;
        }, destroy() { destroyed = true; }
      })
    });
    assert.match(line, /^PASS receipt-keyed/);
    assert.equal(destroyed, true);
  }
});

test("hosted receipt selector unwraps documents and schema permits Verify provenance", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/hosted-receipt-binding-proof.yml", import.meta.url), "utf8");
  assert.ok(workflow.includes("(.document // .) | select(.chainBinding != null) | .receiptId"));
  const schema = JSON.parse(await readFile(new URL("../../docs/schemas/work-receipt-v1.json", import.meta.url), "utf8"));
  assert.ok(schema.properties.intent.properties.specSource.enum.includes("verify_request"));
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

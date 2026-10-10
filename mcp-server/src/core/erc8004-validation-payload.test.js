import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildErc8004ValidationPayload } from "./erc8004-validation-payload.js";
import { hashWorkReceiptContent } from "./work-receipt.js";

const receipt = JSON.parse(readFileSync(new URL("./fixtures/passtas-work-receipt-2026-10-08.json", import.meta.url)));
const ID = "0x91290e62a98c6d6c006a82a87893787e7cc681c55d1bd5bcc6e854864d448e7b";

// Synthetic variants are rehashed and unsigned; never represented as live evidence.
function variant(change) {
  const document = structuredClone(receipt.document);
  delete document.signature;
  change(document);
  document.receiptId = hashWorkReceiptContent(document);
  return document;
}

test("E2 real settled passtas receipt reproduces its content hash, URI and recorded score without enabling publishing", () => {
  assert.equal(receipt.document.jobId, "pr-passtas-matterbridge-elgato-4");
  assert.equal(receipt.document.verifier.handler, "github_pr");
  assert.equal(receipt.document.settlement.settlementTx, "0x24717ca2384f75f7cfab8703bde0e71289933ee889dd7e8b8ecce4ffb8054427");
  assert.equal(hashWorkReceiptContent(receipt.document), ID);
  assert.deepEqual(buildErc8004ValidationPayload(receipt), {
    schemaVersion: "averray.erc8004-validation-payload.v1",
    score: 100, status: "reported", reason: "recorded_approved",
    evidenceURI: `https://api.averray.com/receipts/${ID}`, evidenceHash: ID,
    tag: "averray-recorded-verdict-v1",
    publication: { enabled: false, blockers: [
      "publishing_deferred", "signature_and_live_evidence_not_checked",
      "chain_unavailable_fail_open", "github_pr_pre_merged_only_rule"
    ] }
  });
});

test("E2 raw document and served envelope produce the same deterministic payload without mutating input", () => {
  const before = structuredClone(receipt);
  const expected = buildErc8004ValidationPayload(receipt.document);
  assert.deepEqual(buildErc8004ValidationPayload(receipt), expected);
  assert.deepEqual(buildErc8004ValidationPayload(Object.fromEntries(Object.entries(receipt.document).reverse())), expected);
  assert.deepEqual(receipt, before);
});

test("E2 unsigned presentation, signatures, signers and self-links never enter the evidence hash or redirect its URI", () => {
  const decorated = structuredClone(receipt);
  decorated.unsignedPresentation = { result: "FAIL", score: 0, receiptId: "untrusted" };
  decorated.document.signature = { kid: "different", sig: "not-verified-here" };
  decorated.document.signers = [];
  decorated.document.canonicalUrl = "https://untrusted.example/receipt";
  assert.deepEqual(buildErc8004ValidationPayload(decorated), buildErc8004ValidationPayload(receipt));
});

test("E2 changed content or a forged receiptId is refused rather than committed under the old hash", () => {
  const changed = structuredClone(receipt.document);
  changed.verdict.outcome = "rejected";
  assert.throws(() => buildErc8004ValidationPayload(changed), /content address mismatch/u);
  const forged = { ...receipt.document, receiptId: "0x" + "f".repeat(64) };
  assert.throws(() => buildErc8004ValidationPayload(forged), /content address mismatch/u);
});

for (const [outcome, score, reason] of [
  ["approved", 100, "recorded_approved"], ["rejected", 0, "recorded_rejected"],
  ["inconclusive", null, "inconclusive"], ["platform_fault", null, "platform_fault"],
  ["future_outcome", null, "verdict_not_reported"], [undefined, null, "verdict_not_reported"]
]) {
  test(`E2 ${outcome ?? "missing"} verdict maps to ${score ?? "not reported"}, never unknown-as-zero`, () => {
    const document = variant((d) => { d.verdict.outcome = outcome; });
    const result = buildErc8004ValidationPayload(document);
    assert.equal(result.score, score);
    assert.equal(result.reason, reason);
    assert.equal(result.status, score === null ? "not reported" : "reported");
    assert.equal(result.publication.enabled, false);
    if (score === null) assert.ok(result.publication.blockers.includes(reason));
  });
}

for (const settlementTx of [undefined, "pending", "0x" + "0".repeat(64)]) {
  test(`E2 approved with ${settlementTx ?? "missing"} settlement is not reported`, () => {
    const result = buildErc8004ValidationPayload(variant((d) => { d.settlement.settlementTx = settlementTx; }));
    assert.equal(result.score, null);
    assert.equal(result.reason, "settlement_not_reported");
  });
}

test("E2 missing verification time is not reported and wrong schemas never silently downgrade", () => {
  assert.equal(buildErc8004ValidationPayload(variant((d) => { d.timestamps = {}; })).score, null);
  for (const value of [null, {}, [], { ...receipt, schemaVersion: "future" },
    { ...receipt.document, schemaVersion: "averray.run-receipt.v1" },
    { ...receipt.document, kind: "badge" }, { schemaVersion: "averray.receipt-envelope.v1" }]) {
    assert.throws(() => buildErc8004ValidationPayload(value), /requires a work run receipt/u);
  }
});

test("E2 a synthetic post-rule chain-verified receipt still cannot enable E3", () => {
  const result = buildErc8004ValidationPayload(variant((d) => {
    d.timestamps.verifiedAt = "2026-10-10T10:00:00Z";
    d.intent.specSource = "chain_verified";
  }));
  assert.deepEqual(result.publication, {
    enabled: false, blockers: ["publishing_deferred", "signature_and_live_evidence_not_checked"]
  });
});

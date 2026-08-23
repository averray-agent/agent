import assert from "node:assert/strict";
import test from "node:test";

import {
  attachStoredVerificationResults,
  isApprovedCatalogueSettlement,
  isApprovedSettlement,
  isExternalSettlement
} from "./session-settlement.js";

test("isApprovedSettlement accepts each durable verification era only for resolved sessions", () => {
  const fixtures = [
    { verificationSummary: { outcome: "approved" } },
    { verification: { outcome: "approved" } },
    { verificationSummary: { status: "approved" } },
    { verification: { status: "approved" } },
    { verdict: { outcome: "approved" } },
    { runReceipt: { verdict: { outcome: "approved" } } }
  ];
  for (const [index, fixture] of fixtures.entries()) {
    assert.equal(
      isApprovedSettlement({ sessionId: `era-${index}`, status: "resolved", ...fixture }),
      true,
      `verification era ${index}`
    );
    assert.equal(
      isApprovedSettlement({ sessionId: `pending-${index}`, status: "submitted", ...fixture }),
      false,
      `unsettled verification era ${index}`
    );
  }
});

test("lane classification is stable across flat, snapshot, spec, and public-projection eras", () => {
  const external = [
    { jobSnapshot: { definition: { source: "external" } } },
    { jobSnapshot: { definition: { source: { type: "external" } } } },
    { jobSnapshot: { specDefinition: { sourceType: "external" } } },
    { jobSnapshot: { source: "external" } },
    { jobDefinition: { source: { type: "external" } } },
    { sourceType: "external" }
  ];
  for (const [index, fixture] of external.entries()) {
    const session = {
      sessionId: `external-era-${index}`,
      status: "resolved",
      verificationSummary: { outcome: "approved" },
      ...fixture
    };
    assert.equal(isExternalSettlement(session), true, `external era ${index}`);
    assert.equal(isApprovedCatalogueSettlement(session), false, `external era ${index}`);
  }

  const wikipedia = [
    { jobSnapshot: { definition: { source: "wikipedia", sourceType: "wikipedia_article" } } },
    { jobSnapshot: { definition: { source: { type: "wikipedia_article" } } } },
    { jobSnapshot: { specDefinition: { sourceType: "wikipedia_article" } } },
    { jobSnapshot: { source: "wikipedia" } }
  ];
  for (const [index, fixture] of wikipedia.entries()) {
    const session = {
      sessionId: `catalogue-era-${index}`,
      status: "resolved",
      verificationSummary: { outcome: "approved" },
      ...fixture
    };
    assert.equal(isExternalSettlement(session), false, `catalogue era ${index}`);
    assert.equal(isApprovedCatalogueSettlement(session), true, `catalogue era ${index}`);
  }
});

test("stored verification records fill an older session document without overriding embedded evidence", async () => {
  const reads = [];
  const stateStore = {
    async getVerificationResult(sessionId) {
      reads.push(sessionId);
      return { outcome: "approved", source: "durable-verification-result" };
    }
  };
  const sessions = await attachStoredVerificationResults(stateStore, [
    { sessionId: "legacy", status: "resolved" },
    { sessionId: "current", status: "resolved", verificationSummary: { outcome: "approved" } }
  ]);

  assert.deepEqual(reads, ["legacy"]);
  assert.equal(isApprovedSettlement(sessions[0]), true);
  assert.equal(isApprovedSettlement(sessions[1]), true);
});

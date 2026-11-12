import assert from "node:assert/strict";
import test from "node:test";

import { indexPersonhood, personhoodFor, personhoodLineText, personhoodPill } from "./personhood-line.js";

const lite = {
  available: true,
  wallet: "0x0000000000000000000000000000000000000a22",
  tier: "lite",
  displayName: "cedar.07",
  line: {
    text: "cedar.07",
    pill: "lite",
    tooltip: "Lite is an attested Polkadot App install or another governance-authorized attestation. Soft signal only."
  }
};

test("a lite read shows the username and pill, and none keeps the truncated address", () => {
  const index = indexPersonhood({
    results: [
      lite,
      {
        available: true,
        wallet: "0x0000000000000000000000000000000000000a11",
        tier: "none",
        displayName: null,
        line: { text: null, pill: null, tooltip: null }
      },
      { available: false, wallet: "0x0000000000000000000000000000000000000a99", tier: null }
    ]
  });
  const shown = personhoodFor(index, lite.wallet.toUpperCase());
  assert.equal(personhoodLineText(shown, "0x000000…0a22"), "cedar.07");
  assert.equal(personhoodPill(shown).pill, "lite");
  assert.match(personhoodPill(shown).tooltip, /governance-authorized attestation/u);
  assert.doesNotMatch(personhoodPill(shown).tooltip, /unique human|sybil-proof/iu);

  const none = personhoodFor(index, "0x0000000000000000000000000000000000000a11");
  assert.equal(personhoodLineText(none, "0x000000…0a11"), "0x000000…0a11");
  assert.equal(personhoodPill(none), null);

  assert.equal(personhoodFor(index, "0x0000000000000000000000000000000000000a99"), null);
});

test("full and suspended pills stay on the line the server described", () => {
  const full = {
    available: true,
    tier: "full",
    line: { text: "cedar.dot", pill: "full", tooltip: "Full is the stronger on-chain personhood track." }
  };
  const suspended = {
    available: true,
    tier: "none",
    line: { text: "elm.04", pill: "suspended", tooltip: "Privileges are treated as none." }
  };
  assert.equal(personhoodLineText(full, "0xabc…"), "cedar.dot");
  assert.equal(personhoodPill(full).pill, "full");
  assert.equal(personhoodLineText(suspended, "0xabc…"), "elm.04");
  assert.equal(personhoodPill(suspended).pill, "suspended");
});

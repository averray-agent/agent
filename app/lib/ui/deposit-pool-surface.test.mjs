import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildDepositPoolSurface } from "./deposit-pool-surface.js";

function fixture(overrides = {}) {
  return {
    available: true,
    disclosure: { statement: "API-owned risk statement A." },
    totalAssets: { raw: "10405132", decimals: 6 },
    bufferAssets: { raw: "10405132", decimals: 6 },
    sharePrice: { assetsPerShare: { raw: "1000000", decimals: 6 } },
    markedSharePrice: null,
    yieldStatus: "not_yet_earning",
    yieldStatusText: "API-owned yield statement.",
    venueMark: {
      status: "not_deployed",
      depositsBlocked: false,
      statement: "API-owned venue statement.",
      costBasis: { raw: "0", decimals: 6 },
      marked: null,
      shortfall: { raw: "0", decimals: 6 },
      surplus: { raw: "0", decimals: 6 }
    },
    yieldAttribution: {
      status: "zero",
      statement: "API-owned zero-state statement.",
      gain: {
        cumulativeNav: { raw: "0", decimals: 6 },
        venueEarned: { raw: "0", decimals: 6 },
        operatorAdded: { raw: "0", decimals: 6 }
      },
      subsidyLedger: {
        attestation: "API-owned attestation.",
        entryCount: 0
      }
    },
    ...overrides
  };
}

test("pool disclosure follows the API fixture mutation instead of client-side copy", () => {
  const before = buildDepositPoolSurface(fixture());
  const after = buildDepositPoolSurface(fixture({
    disclosure: { statement: "Mutated server disclosure — the page must follow." }
  }));

  assert.equal(before.disclosure, "API-owned risk statement A.");
  assert.equal(after.disclosure, "Mutated server disclosure — the page must follow.");
  assert.notEqual(after.disclosure, before.disclosure);
});

test("the rendered risk block binds to the projected API disclosure", async () => {
  const component = await readFile(
    new URL("../../components/pool/DepositPoolSurface.tsx", import.meta.url),
    "utf8"
  );
  assert.match(component, /data-testid="pool-risk-disclosure"/u);
  assert.match(component, /\{surface\.disclosure\}/u);
  assert.doesNotMatch(component, /Technical pilot\. Principal at risk\. No depositor protection\./u);
});

test("pool zero and absent values stay legible without fabricated figures", () => {
  const surface = buildDepositPoolSurface(fixture());
  assert.equal(surface.facts[0].value, "10.405132 USDC");
  assert.equal(surface.venue.costBasis, "0 USDC");
  assert.equal(surface.attribution.cumulativeNav, "0 USDC");
  assert.equal(surface.attribution.entryCount, 0);
  assert.equal(surface.facts[3].value, null);

  const unavailable = buildDepositPoolSurface({ available: false, reason: "pool_read_unavailable" });
  assert.equal(unavailable.available, false);
  assert.deepEqual(unavailable.facts, []);
  assert.equal(JSON.stringify(unavailable).includes("0 USDC"), false);
});

test("the two-pool transition note can only come from API data", async () => {
  const absent = buildDepositPoolSurface(fixture());
  const supplied = buildDepositPoolSurface(fixture({
    transition: { statement: "API says which pool this read represents." }
  }));
  assert.equal(absent.transition, null);
  assert.equal(supplied.transition, "API says which pool this read represents.");

  const sources = await Promise.all([
    readFile(new URL("./deposit-pool-surface.js", import.meta.url), "utf8"),
    readFile(new URL("../../components/pool/DepositPoolSurface.tsx", import.meta.url), "utf8")
  ]);
  assert.doesNotMatch(sources.join("\n"), /0x[a-fA-F0-9]{40}/u, "the UI must not hardcode either pool address");
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildDepositPoolSurface } from "./deposit-pool-surface.js";

const mainnetDeployment = JSON.parse(await readFile(
  new URL("../../../deployments/mainnet.json", import.meta.url),
  "utf8"
));
const poolGenerationManifest = {
  depositPoolV21: mainnetDeployment.contracts.depositPoolV21,
  legacyDepositPoolV2: mainnetDeployment.contracts.legacyDepositPoolV2
};

function fixture(overrides = {}) {
  return {
    available: true,
    pool: poolGenerationManifest.depositPoolV21,
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
  const before = buildDepositPoolSurface(fixture(), poolGenerationManifest);
  const after = buildDepositPoolSurface(fixture({
    disclosure: { statement: "Mutated server disclosure — the page must follow." }
  }), poolGenerationManifest);

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
  const surface = buildDepositPoolSurface(fixture(), poolGenerationManifest);
  assert.equal(surface.facts[0].value, "10.405132 USDC");
  assert.equal(surface.venue.costBasis, "0 USDC");
  assert.equal(surface.attribution.cumulativeNav, "0 USDC");
  assert.equal(surface.attribution.entryCount, 0);
  assert.equal(surface.facts[3].value, null);

  const unavailable = buildDepositPoolSurface(
    { available: false, reason: "pool_read_unavailable" },
    poolGenerationManifest
  );
  assert.equal(unavailable.available, false);
  assert.deepEqual(unavailable.facts, []);
  assert.equal(JSON.stringify(unavailable).includes("0 USDC"), false);
});

test("the two-pool transition note can only come from API data", async () => {
  const absent = buildDepositPoolSurface(fixture(), poolGenerationManifest);
  const supplied = buildDepositPoolSurface(fixture({
    transition: { statement: "API says which pool this read represents." }
  }), poolGenerationManifest);
  assert.equal(absent.transition, null);
  assert.equal(supplied.transition, "API says which pool this read represents.");

  const sources = await Promise.all([
    readFile(new URL("./deposit-pool-surface.js", import.meta.url), "utf8"),
    readFile(new URL("../../components/pool/DepositPoolSurface.tsx", import.meta.url), "utf8")
  ]);
  assert.doesNotMatch(sources.join("\n"), /0x[a-fA-F0-9]{40}/u, "the UI must not hardcode either pool address");
});

test("pool generation follows the served address across manifest generations", () => {
  const live = buildDepositPoolSurface(fixture(), poolGenerationManifest);
  const legacy = buildDepositPoolSurface(fixture({
    pool: poolGenerationManifest.legacyDepositPoolV2
  }), poolGenerationManifest);

  assert.deepEqual(live.identity, {
    generation: "Live v2.1",
    address: poolGenerationManifest.depositPoolV21
  });
  assert.deepEqual(legacy.identity, {
    generation: "Legacy v2",
    address: poolGenerationManifest.legacyDepositPoolV2
  });
});

test("pool identity markup binds to API values and contains no financial literals", async () => {
  const [page, component] = await Promise.all([
    readFile(new URL("../../app/pool/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../components/pool/DepositPoolSurface.tsx", import.meta.url), "utf8")
  ]);

  assert.match(page, /mainnetDeployment\.contracts\.depositPoolV21/u);
  assert.match(page, /mainnetDeployment\.contracts\.legacyDepositPoolV2/u);
  assert.match(component, /generation=\{surface\.identity\.generation\}/u);
  assert.match(component, /address=\{surface\.identity\.address\}/u);
  assert.match(component, /yieldStatus=\{surface\.yield\?\.status\}/u);
  assert.match(component, /venueStatus=\{surface\.venue\?\.status\}/u);
  assert.match(component, /navigator\.clipboard\.writeText\(address\)/u);
  assert.doesNotMatch(component, /\b\d+(?:\.\d+)?\s+USDC\b/u);
  assert.doesNotMatch(component, /not_yet_earning|not_deployed/u);
});

test("unreadable pool identity renders unavailable instead of guessing", async () => {
  for (const pool of [undefined, "", "not-an-address"]) {
    const surface = buildDepositPoolSurface(fixture({ pool }), poolGenerationManifest);
    assert.deepEqual(surface.identity, { generation: null, address: null });
  }

  const component = await readFile(
    new URL("../../components/pool/DepositPoolSurface.tsx", import.meta.url),
    "utf8"
  );
  assert.match(component, /generation \?\? "unavailable"/u);
  assert.match(component, /address \?\? "unavailable"/u);
});

test("changing pool generation leaves the existing pool projection unchanged", () => {
  const live = buildDepositPoolSurface(fixture(), poolGenerationManifest);
  const legacy = buildDepositPoolSurface(fixture({
    pool: poolGenerationManifest.legacyDepositPoolV2
  }), poolGenerationManifest);
  const { identity: liveIdentity, ...liveExistingSurface } = live;
  const { identity: legacyIdentity, ...legacyExistingSurface } = legacy;

  assert.notDeepEqual(liveIdentity, legacyIdentity);
  assert.deepEqual(liveExistingSurface, legacyExistingSurface);
});

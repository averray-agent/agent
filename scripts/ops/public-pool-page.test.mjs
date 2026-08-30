import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const REPO_ROOT = new URL("../../", import.meta.url);
const PAGE = new URL("marketing/src/pages/pool.astro", REPO_ROOT);
const READER = new URL("marketing/public/pool-reader.js", REPO_ROOT);
const SYNC = new URL("scripts/sync-marketing-site.mjs", REPO_ROOT);
const DEPLOY = new URL("scripts/ops/deploy-production.sh", REPO_ROOT);

function amount(raw) {
  return { raw, decimals: 6 };
}

function poolPayload(statement = "Technical pilot. Principal at risk. No depositor protection.") {
  return {
    available: true,
    pool: "0x1111111111111111111111111111111111111111",
    units: { asset: { symbol: "USDC" } },
    totalAssets: amount("14478654"),
    bufferAssets: amount("14478654"),
    sharePrice: { assetsPerShare: amount("1000000") },
    caps: {
      totalAssetCap: amount("1000000000"),
      perAgentAssetCap: amount("100000000"),
      poolHeadroom: amount("985521346")
    },
    yieldStatus: "not_yet_earning",
    yieldStatusText: "Deposits do not currently earn yield; pool capital is home, and venue deployment is not scheduled.",
    disclosure: { statement },
    capitalSignal: {
      statement: "A time-weighted deposit is one capital-backed trust-and-capacity signal."
    },
    withdrawal: {
      note: "Deposited assets are not locked. You may redeem available shares from the pool buffer at any time."
    },
    venueMark: {
      status: "not_deployed",
      statement: "No pool capital is at the venue, so the quoted share price is exact.",
      depositsBlocked: false
    }
  };
}

function publicField(value, unit) {
  return { value, unit, status: "fresh" };
}

function transparencyPayload(liveLabel = "Current generation", legacyLabel = "Earlier generation") {
  return {
    depositPools: {
      live: {
        label: publicField(liveLabel, "pool generation"),
        address: publicField("0x1111111111111111111111111111111111111111", "address"),
        totalAssets: publicField("14.478654", "USDC"),
        bufferAssets: publicField("14.478654", "USDC"),
        deployedStatus: publicField("not_deployed", "deployment status")
      },
      legacy: {
        label: publicField(legacyLabel, "pool generation"),
        address: publicField("0x2222222222222222222222222222222222222222", "address"),
        totalAssets: publicField("14.888371", "USDC"),
        bufferAssets: publicField("10.388371", "USDC"),
        deployedStatus: publicField("deployed", "deployment status")
      }
    }
  };
}

function onboardingPayload() {
  return {
    products: {
      lockedDeposits: {
        enabled: true,
        priority: "Longer commitments receive earlier access inside the deposit-claim-priority window.",
        tiers: [
          { tier: "t7", termDays: 7, perks: ["priority claim access"] },
          { tier: "t30", termDays: 30, perks: ["credit qualification"] }
        ]
      }
    }
  };
}

function loadReader(document = undefined) {
  const context = { document, window: {} };
  runInNewContext(readFileSource, context, { filename: "pool-reader.js" });
  return context.window.AverrayPublicPool;
}

let readFileSource;
test.before(async () => {
  readFileSource = await readFile(READER, "utf8");
});

function visibleSource(source) {
  const surface = source.match(/<div\s+data-public-pool[\s\S]*?>([\s\S]*)<\/div>\s*\n\s*<SiteFooter/u)?.[1];
  assert.ok(surface, "public pool source boundary must be discoverable");
  return surface.replace(/<[^>]+>/gu, " ").replace(/\{[^}]+\}/gu, " ").replace(/\s+/gu, " ").trim();
}

function renderHarness() {
  const nodes = new Map([
    "[data-pool-yield-state]",
    "[data-pool-yield-heading]",
    "[data-pool-yield-text]",
    "[data-pool-risk-statement]",
    "[data-pool-total-assets]",
    "[data-pool-buffer]",
    "[data-pool-share-price]",
    "[data-pool-total-cap]",
    "[data-pool-agent-cap]",
    "[data-pool-headroom]",
    "[data-pool-venue-status]",
    "[data-pool-venue-statement]",
    "[data-pool-capital-signal]",
    "[data-pool-withdrawal]"
  ].map((selector) => [selector, { textContent: "" }]));
  const actions = { hidden: true };
  const root = {
    dataset: {},
    querySelector(selector) {
      return selector === "[data-pool-cta]" ? actions : nodes.get(selector) ?? null;
    }
  };
  const document = {
    querySelector(selector) {
      return selector === "[data-public-pool]" ? root : nodes.get(selector) ?? null;
    }
  };
  return { actions, document, nodes, root };
}

test("public pool page — every figure is fetched and no numeric figure is baked into markup", async () => {
  const [page, readerSource] = await Promise.all([readFile(PAGE, "utf8"), readFile(READER, "utf8")]);
  const text = visibleSource(page);

  assert.doesNotMatch(text, /\b[0-9]+(?:\.[0-9]+)?\b/u);
  assert.doesNotMatch(page, /0x[0-9a-fA-F]{40}/u);
  for (const target of [
    "data-pool-total-assets",
    "data-pool-buffer",
    "data-pool-share-price",
    "data-pool-total-cap",
    "data-pool-agent-cap",
    "data-pool-headroom",
    "data-pool-venue-status"
  ]) assert.match(page, new RegExp(target, "u"));
  assert.match(readerSource, /ENDPOINTS\.pool/u);
  assert.match(readerSource, /ENDPOINTS\.onboarding/u);
  assert.match(readerSource, /ENDPOINTS\.transparency/u);
});

test("public pool page — risk disclosure follows the served API statement under mutation", async () => {
  const page = await readFile(PAGE, "utf8");
  const h = renderHarness();
  const reader = loadReader(h.document);
  const first = "First API-owned pilot warning.";
  const mutated = "Mutated API-owned pilot warning.";

  reader.renderPool(reader.parsePool(poolPayload(first)));
  assert.equal(h.nodes.get("[data-pool-risk-statement]").textContent, first);
  reader.renderPool(reader.parsePool(poolPayload(mutated)));
  assert.equal(h.nodes.get("[data-pool-risk-statement]").textContent, mutated);
  assert.doesNotMatch(page, /Technical pilot\. Principal at risk\. No depositor protection\./u);
});

test("public pool page — rendered copy contains no rate, APY, projection, or yield date", async () => {
  const page = await readFile(PAGE, "utf8");
  const reader = loadReader();
  const forbidden = /\b(?:rate|apy|projection)\b|yield\s+date/iu;

  assert.doesNotMatch(visibleSource(page), forbidden);
  assert.doesNotMatch(JSON.stringify(reader.parsePool(poolPayload())), forbidden);
  assert.doesNotMatch(JSON.stringify(reader.parseOnboarding(onboardingPayload())), forbidden);
  const mutation = poolPayload();
  mutation.yieldStatusText = "A projected APY appears here.";
  assert.throws(() => reader.parsePool(mutation), /forbidden performance claim/u);
});

test("public pool page — not-yet-earning truth renders above every deposit control", async () => {
  const page = await readFile(PAGE, "utf8");
  const h = renderHarness();
  const reader = loadReader(h.document);
  const statePosition = page.indexOf("data-pool-yield-heading");
  const controlPosition = page.indexOf("data-pool-cta");

  assert.ok(statePosition >= 0 && statePosition < controlPosition);
  assert.match(page, /data-pool-cta hidden/u);
  reader.renderPool(reader.parsePool(poolPayload()));
  assert.equal(h.nodes.get("[data-pool-yield-heading]").textContent, "A deposit today earns nothing.");
  assert.equal(h.actions.hidden, false);
});

test("public pool page — both pool labels and addresses come from the public record", async () => {
  const page = await readFile(PAGE, "utf8");
  const reader = loadReader();
  const first = reader.parseTransparency(transparencyPayload("Live label A", "Legacy label A"));
  const mutated = reader.parseTransparency(transparencyPayload("Live label B", "Legacy label B"));

  assert.match(page, /data-pool-generation="live"/u);
  assert.match(page, /data-pool-generation="legacy"/u);
  assert.doesNotMatch(page, /0x[0-9a-fA-F]{40}/u);
  assert.equal(first.live.label.value, "Live label A");
  assert.equal(first.legacy.label.value, "Legacy label A");
  assert.equal(mutated.live.label.value, "Live label B");
  assert.equal(mutated.legacy.label.value, "Legacy label B");
  assert.notEqual(first.live.address.value, first.legacy.address.value);
});

test("public pool page — exit copy matches R4 and both deployment allow-lists include the page", async () => {
  const [page, sync, deploy] = await Promise.all([
    readFile(PAGE, "utf8"),
    readFile(SYNC, "utf8"),
    readFile(DEPLOY, "utf8")
  ]);

  assert.match(page, /synchronously while the adapter's\s+uncommitted balance covers it; otherwise it queues with a disclosed ETA\./u);
  assert.doesNotMatch(visibleSource(page), /\binstant\b/iu);
  assert.match(sync, /"pool\/index\.html"/u);
  assert.match(sync, /"pool-reader\.js"/u);
  assert.match(deploy, /"pool\/index\.html \/pool\/"/u);
  assert.match(deploy, /"pool-reader\.js \/pool-reader\.js"/u);
});

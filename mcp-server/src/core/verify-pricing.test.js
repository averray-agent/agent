import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildVerifyPricing, buildVerifySiteSignalsLlmsSection } from "./verify-pricing.js";
import { VERIFY_BILLING_RULE } from "./verify-product-copy.js";
import { VerificationProfileRegistry, VERIFY_PROFILE_PRICES } from "../services/verification-profile-registry.js";
import { VERIFY_PROFILE_CATALOGUE } from "./verification-profile-prices.js";

test("build-time catalogue and published registry agree on every identity and price", () => {
  const profiles = new VerificationProfileRegistry().list();
  assert.deepEqual(VERIFY_PROFILE_CATALOGUE, profiles.map(({ name, version, ref, price }) => ({ name, version, ref, price })));
  assert.deepEqual(buildVerifyPricing(), buildVerifyPricing(profiles));
  assert.equal(Object.isFrozen(VERIFY_PROFILE_CATALOGUE), true);
  for (const entry of VERIFY_PROFILE_CATALOGUE) {
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(entry.price, VERIFY_PROFILE_PRICES[entry.name]);
  }
});

test("Astro pricing import graph stays dependency-free and llms uses canonical billing copy", () => {
  const seen = new Set();
  function visit(url) {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const source = readFileSync(url, "utf8");
    for (const match of source.matchAll(/(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/gu)) {
      assert.ok(match[1].startsWith("."), `unexpected runtime dependency: ${match[1]}`);
      visit(new URL(match[1], url));
    }
  }
  visit(new URL("./verify-pricing.js", import.meta.url));
  assert.deepEqual([...seen].map((url) => url.split("/").at(-1)).sort(),
    ["verification-profile-prices.js", "verify-pricing.js", "verify-product-copy.js"]);
  const source = readFileSync(new URL("./verify-pricing.js", import.meta.url), "utf8");
  assert.ok(source.includes("${VERIFY_BILLING_RULE}"));
  assert.ok(buildVerifySiteSignalsLlmsSection().includes(VERIFY_BILLING_RULE));
});

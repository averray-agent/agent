import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CREDIT_READ_GRACE_DEFAULT_MS,
  LOCKED_TIER_COHORT_CAP_CEILING_RAW,
  LOCKED_TIER_PER_WALLET_CAP_CEILING_RAW,
  loadLockedTierConfig
} from "../../mcp-server/src/services/locked-tier-service.js";

const DEFAULT_TEMPLATE = new URL("../../deploy/backend.env.template", import.meta.url);
const MAINNET_TEMPLATE = new URL("../../deploy/backend.mainnet.env.template", import.meta.url);

test("locked tiers stay flag-off by default while mainnet enables non-yield perks", async () => {
  const defaults = loadLockedTierConfig({});
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.tierPerksEnabled, false);
  assert.equal(defaults.perWalletCapRaw, 25_000_000n);
  assert.equal(defaults.cohortCapRaw, 1_000_000_000n);
  assert.equal(defaults.creditReadGraceMs, CREDIT_READ_GRACE_DEFAULT_MS);

  for (const [templateUrl, tierPerksEnabled] of [
    [DEFAULT_TEMPLATE, false],
    [MAINNET_TEMPLATE, true]
  ]) {
    const env = parseTemplate(await readFile(templateUrl, "utf8"));
    assert.equal(env.LOCKED_TIERS_ENABLED, "true", templateUrl.pathname);
    assert.equal(env.NON_YIELD_TIER_PERKS_ENABLED, tierPerksEnabled ? "1" : "false", templateUrl.pathname);
    assert.equal(env.LOCKED_TIER_PER_WALLET_CAP_USDC, "25", templateUrl.pathname);
    assert.equal(env.LOCKED_TIER_COHORT_CAP_USDC, "1000", templateUrl.pathname);
    assert.equal(env.CREDIT_READ_GRACE_MS, "300000", templateUrl.pathname);
    const config = loadLockedTierConfig(env);
    assert.equal(config.enabled, true, templateUrl.pathname);
    assert.equal(config.tierPerksEnabled, tierPerksEnabled, templateUrl.pathname);
    assert.equal(config.perWalletCapRaw, defaults.perWalletCapRaw, templateUrl.pathname);
    assert.equal(config.cohortCapRaw, defaults.cohortCapRaw, templateUrl.pathname);
    assert.equal(config.creditReadGraceMs, defaults.creditReadGraceMs, templateUrl.pathname);
  }
});

test("locked-tier wallet cap is configurable only below its hard code ceiling", () => {
  const warnings = [];
  const config = loadLockedTierConfig(
    {
      LOCKED_TIER_PER_WALLET_CAP_USDC: "999",
      LOCKED_TIER_COHORT_CAP_USDC: "9999"
    },
    { logger: { warn: (...args) => warnings.push(args) } }
  );
  assert.equal(config.perWalletCapRaw, LOCKED_TIER_PER_WALLET_CAP_CEILING_RAW);
  assert.equal(config.cohortCapRaw, LOCKED_TIER_COHORT_CAP_CEILING_RAW);
  assert.equal(warnings[0][1], "locked_tiers.per_wallet_cap_clamped");
  assert.equal(warnings[1][1], "locked_tiers.cohort_cap_clamped");
});

function parseTemplate(source) {
  return Object.fromEntries(
    source
      .split("\n")
      .filter((line) => /^[A-Z][A-Z0-9_]*=/u.test(line))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  LOCKED_TIER_COHORT_CAP_CEILING_RAW,
  LOCKED_TIER_PER_WALLET_CAP_CEILING_RAW,
  loadLockedTierConfig
} from "../../mcp-server/src/services/locked-tier-service.js";

const TEMPLATES = [
  new URL("../../deploy/backend.env.template", import.meta.url),
  new URL("../../deploy/backend.mainnet.env.template", import.meta.url)
];

test("locked tiers stay flag-off by default in both generated backend env profiles", async () => {
  const defaults = loadLockedTierConfig({});
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.perWalletCapRaw, 25_000_000n);
  assert.equal(defaults.cohortCapRaw, 1_000_000_000n);

  for (const templateUrl of TEMPLATES) {
    const env = parseTemplate(await readFile(templateUrl, "utf8"));
    assert.equal(env.LOCKED_TIERS_ENABLED, "false", templateUrl.pathname);
    assert.equal(env.LOCKED_TIER_PER_WALLET_CAP_USDC, "25", templateUrl.pathname);
    assert.equal(env.LOCKED_TIER_COHORT_CAP_USDC, "1000", templateUrl.pathname);
    const config = loadLockedTierConfig(env);
    assert.equal(config.enabled, false, templateUrl.pathname);
    assert.equal(config.perWalletCapRaw, defaults.perWalletCapRaw, templateUrl.pathname);
    assert.equal(config.cohortCapRaw, defaults.cohortCapRaw, templateUrl.pathname);
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

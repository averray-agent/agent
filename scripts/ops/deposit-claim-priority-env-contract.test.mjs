import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadDepositClaimPriorityConfig } from "../../mcp-server/src/core/deposit-claim-priority.js";

const DEFAULT_TEMPLATE = new URL("../../deploy/backend.env.template", import.meta.url);
const MAINNET_TEMPLATE = new URL("../../deploy/backend.mainnet.env.template", import.meta.url);

test("priority templates enable a thirty-minute window at one USDC without changing the deposit threshold", async () => {
  const codeDefaults = loadDepositClaimPriorityConfig({});
  assert.equal(codeDefaults.enabled, false);
  assert.equal(codeDefaults.windowSeconds, 1800);
  assert.equal(codeDefaults.thresholdRaw, 1_000_000n);

  for (const [templateUrl, enabled] of [
    [DEFAULT_TEMPLATE, true],
    [MAINNET_TEMPLATE, true]
  ]) {
    const env = parseTemplate(await readFile(templateUrl, "utf8"));
    assert.equal(env.DEPOSIT_CLAIM_PRIORITY_ENABLED, "true", templateUrl.pathname);
    assert.equal(env.PRIORITY_WINDOW_SECONDS, "1800", templateUrl.pathname);
    assert.equal(env.PRIORITY_MIN_REWARD_USDC, "1.0", templateUrl.pathname);
    assert.equal(env.PRIORITY_DEPOSIT_THRESHOLD, "1.0", templateUrl.pathname);

    const templateConfig = loadDepositClaimPriorityConfig(env);
    assert.equal(templateConfig.enabled, enabled, templateUrl.pathname);
    assert.equal(templateConfig.windowSeconds, codeDefaults.windowSeconds, templateUrl.pathname);
    assert.equal(templateConfig.thresholdRaw, codeDefaults.thresholdRaw, templateUrl.pathname);
  }
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

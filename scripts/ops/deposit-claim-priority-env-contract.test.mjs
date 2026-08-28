import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadDepositClaimPriorityConfig } from "../../mcp-server/src/core/deposit-claim-priority.js";

const DEFAULT_TEMPLATE = new URL("../../deploy/backend.env.template", import.meta.url);
const MAINNET_TEMPLATE = new URL("../../deploy/backend.mainnet.env.template", import.meta.url);

test("deposit priority stays default-off while mainnet tier perks activate its existing window", async () => {
  const codeDefaults = loadDepositClaimPriorityConfig({});
  assert.equal(codeDefaults.enabled, false);
  assert.equal(codeDefaults.windowSeconds, 300);
  assert.equal(codeDefaults.thresholdRaw, 1_000_000n);

  for (const [templateUrl, enabled] of [
    [DEFAULT_TEMPLATE, false],
    [MAINNET_TEMPLATE, true]
  ]) {
    const env = parseTemplate(await readFile(templateUrl, "utf8"));
    assert.equal(env.DEPOSIT_CLAIM_PRIORITY_ENABLED, "false", templateUrl.pathname);
    assert.equal(env.PRIORITY_WINDOW_SECONDS, "300", templateUrl.pathname);
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

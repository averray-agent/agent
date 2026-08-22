import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadDepositClaimPriorityConfig } from "../../mcp-server/src/core/deposit-claim-priority.js";

const TEMPLATES = [
  new URL("../../deploy/backend.env.template", import.meta.url),
  new URL("../../deploy/backend.mainnet.env.template", import.meta.url)
];

test("backend templates stay bound to the dormant deposit-priority code defaults", async () => {
  const codeDefaults = loadDepositClaimPriorityConfig({});
  assert.equal(codeDefaults.enabled, false);
  assert.equal(codeDefaults.windowSeconds, 300);
  assert.equal(codeDefaults.thresholdRaw, 1_000_000n);

  for (const templateUrl of TEMPLATES) {
    const env = parseTemplate(await readFile(templateUrl, "utf8"));
    assert.equal(env.DEPOSIT_CLAIM_PRIORITY_ENABLED, "false", templateUrl.pathname);
    assert.equal(env.PRIORITY_WINDOW_SECONDS, "300", templateUrl.pathname);
    assert.equal(env.PRIORITY_DEPOSIT_THRESHOLD, "1.0", templateUrl.pathname);

    const templateConfig = loadDepositClaimPriorityConfig(env);
    assert.equal(templateConfig.enabled, codeDefaults.enabled, templateUrl.pathname);
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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { claimActionReadiness } from "./claim-readiness.js";

const workDetailSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "components", "work", "WorkJobDetail.tsx"),
  "utf8"
);

const ready = {
  authenticated: true,
  providerAvailable: true,
  publiclyListed: true,
  definitionReady: true,
  schemaReady: true,
  schemaFailed: false,
  walletChecksLoading: false,
  walletChecksFailed: false,
  eligible: true,
  refusalReason: null,
};

test("job claim stays disabled while net reward, waiver, and preflight terms are loading", () => {
  const result = claimActionReadiness({ ...ready, walletChecksLoading: true });
  assert.equal(result.enabled, false);
  assert.match(result.reason, /net reward, waiver, eligibility/u);
});

test("job wallet check stays disabled until the live output schema resolves", () => {
  const result = claimActionReadiness({
    ...ready,
    authenticated: false,
    schemaReady: false,
  });
  assert.equal(result.enabled, false);
  assert.match(result.reason, /Loading the live output schema/u);
});

test("provider-backed wallet check remains available once public terms resolve", () => {
  assert.deepEqual(
    claimActionReadiness({ ...ready, authenticated: false }),
    {
      enabled: true,
      reason: "Wallet sign-in opens the live claim preflight; it does not claim yet.",
    }
  );
});

test("signed-in claim opens only after all live claim terms resolve", () => {
  assert.deepEqual(claimActionReadiness(ready), {
    enabled: true,
    reason: "Live claim terms are resolved. Claiming is enabled.",
  });
});

test("wallet sign-in is not presented as a claim before preflight resolves", () => {
  assert.doesNotMatch(workDetailSource, /Check wallet and claim/u);
  assert.match(workDetailSource, /auth\.authenticated \? "Claim this job" : "Check wallet"/u);
  assert.match(workDetailSource, /disabled=\{signing \|\| claiming \|\| !actionReadiness\.enabled/u);
});

test("job detail links the canonical raw definition and copies the fetched JSON", () => {
  assert.match(workDetailSource, /href=\{rawDefinitionUrl\}[\s\S]*Raw JSON/u);
  assert.match(
    workDetailSource,
    /navigator\.clipboard\.writeText\(serializeJobDefinition\(definition\)\)/u
  );
});

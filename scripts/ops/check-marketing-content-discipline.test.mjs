import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MarketingContentDisciplineError,
  assertMarketingContentDiscipline
} from "./check-marketing-content-discipline.mjs";

const REPO_ROOT = new URL("../../", import.meta.url);

function safePages(verifyHtml) {
  const meta = '<meta name="description" content="proof"><meta property="og:title" content="Averray"><meta name="twitter:card" content="summary">';
  return {
    "site/index.html": `${meta}<main>Outcome verification and work receipts.</main>`,
    "site/verify/index.html": `${meta}${verifyHtml}`,
    "site/proof-to-pay/index.html": `${meta}<main>Proof-gated escrow. Release on PASS only.</main>`
  };
}

test("content discipline accepts the required Verify disclosures", () => {
  assert.doesNotThrow(() => assertMarketingContentDiscipline(safePages(
    "<main>Inconclusive runs are never billed.<section data-receipt-proof>demonstration run (operator-funded)</section></main>"
  )));
});

test("hard-coding 5 USDC into verify.astro fails the content-discipline lint by name", async () => {
  const source = await readFile(new URL("marketing/src/pages/verify.astro", REPO_ROOT), "utf8");
  const anchor = "<div id=\"verify-profiles\" aria-live=\"polite\">";
  const mutated = source.replace(anchor, `${anchor}<p>5 USDC</p>`);

  assert.notEqual(mutated, source, "mutation anchor must apply before the drill is trusted");
  assert.match(mutated, /5 USDC/u, "the mutated source must contain the forbidden amount");
  assert.throws(
    () => assertMarketingContentDiscipline(safePages(mutated)),
    (error) => (
      error instanceof MarketingContentDisciplineError
      && error.name === "MarketingContentDisciplineError"
      && /baked amount "5 USDC" is forbidden/u.test(error.message)
    )
  );
});

test("marketing build, sync, and deploy gates name both public product pages", async () => {
  const [syncScript, deployScript, workflow] = await Promise.all([
    readFile(new URL("scripts/sync-marketing-site.mjs", REPO_ROOT), "utf8"),
    readFile(new URL("scripts/ops/deploy-production.sh", REPO_ROOT), "utf8"),
    readFile(new URL(".github/workflows/ci.yml", REPO_ROOT), "utf8")
  ]);

  assert.match(syncScript, /"verify-reader\.js"/u);
  assert.match(syncScript, /"verify\/index\.html"/u);
  assert.match(syncScript, /"proof-to-pay\/index\.html"/u);
  assert.match(deployScript, /"verify\/index\.html \/verify\/"/u);
  assert.match(deployScript, /"proof-to-pay\/index\.html \/proof-to-pay\/"/u);
  assert.match(workflow, /npm run build:site\s+          npm run check:site-content/u);
});

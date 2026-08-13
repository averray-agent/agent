import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..", "..");
const adapter = readFileSync(resolve(here, "catalogue-lanes.ts"), "utf8");
const grid = readFileSync(resolve(appRoot, "components/overview/CatalogueLaneGrid.tsx"), "utf8");
const overview = readFileSync(resolve(appRoot, "app/(authed)/overview/page.tsx"), "utf8");

test("catalogue lane board reads the dedicated admin-status payload", () => {
  assert.match(adapter, /root\?\.catalogueLanes/u);
  assert.match(overview, /buildCatalogueLaneCards\(providerOps\.data\)/u);
  assert.match(overview, /<CatalogueLaneGrid/u);
});

test("catalogue lane tile renders every D3 operator decision field", () => {
  for (const field of [
    "spend24h",
    "cap24h",
    "jobsPosted24h",
    "externalClaimantShare",
    "retainedExternalWorkers14d",
    "costPerRetainedExternalWorker30d",
    "hypothesis",
    "stopCondition"
  ]) {
    assert.match(grid, new RegExp(`lane\\.${field}`, "u"), `tile omits ${field}`);
  }
  assert.match(grid, /lane\.paused \? "paused" : "posting"/u);
});

test("zero external claimants remain visible instead of hiding the metric", () => {
  assert.match(adapter, /externalClaimantCount: nonNegativeInteger/u);
  assert.match(adapter, /externalShareBps[\s\S]*?0/u);
  assert.match(grid, /lane\.externalClaimantCount/u);
});

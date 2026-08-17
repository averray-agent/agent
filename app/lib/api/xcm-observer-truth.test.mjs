import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..", "..");
const adapter = readFileSync(resolve(here, "treasury-adapters.ts"), "utf8");
const lane = readFileSync(resolve(appRoot, "components", "treasury", "XcmObserverLane.tsx"), "utf8");
const classifier = adapter.slice(
  adapter.indexOf("function xcmRowDisposition"),
  adapter.indexOf("export function buildPolicyGateItems")
);

test("failed and finalize-error rows close instead of remaining pending", () => {
  assert.match(classifier, /\["failed", "error", "cancelled", "rejected"\]\.includes\(status\)/u);
  assert.match(adapter, /closed: dispositions\.filter\(\(value\) => value === "terminal"\)\.length/u);
  assert.match(lane, /\{phase\.closed\} closed/u);
});

test("genuinely active request and observation statuses remain pending", () => {
  assert.match(classifier, /\["queued", "dispatched", "pending", "registered", "staged"\]/u);
  assert.match(classifier, /\["observed", "pending", "succeeded"\]/u);
  assert.match(lane, /\{phase\.pending\} pending/u);
});

test("a future status is loud and never falls through to pending", () => {
  assert.match(classifier, /stage === "settle"[\s\S]*?return "unrecognised"/u);
  assert.match(classifier, /stage === "request"[\s\S]*?: "unrecognised"/u);
  assert.match(classifier, /stage === "observe"[\s\S]*?: "unrecognised"/u);
  assert.match(classifier, /return "unrecognised";\s*\n\}/u);
  assert.match(lane, /unrecognised — investigate/u);
});

test("placeholder block zero renders the failure reason instead", () => {
  assert.match(adapter, /block > 0\s*\? `block \$\{block\}`\s*:\s*reason/u);
  assert.doesNotMatch(adapter, /block >= 0 \? `block \$\{block\}`/u);
});

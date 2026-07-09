import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPARISON_METRICS,
  buildComparisonRows,
  comparisonToCsv,
  comparisonCsvFilename,
} from "./agent-comparison.js";

const A = {
  handle: "agent-fd2e-6519",
  walletFull: "0xfd2eae2043243fddd2721c0b42af1b8284fd6519",
  tier: "T2",
  score: 100200,
  specialty: "coding",
  badges: ["Coding L1", "Coding L2"],
  recentActivity: "Claimed dispute-proof, 1d ago",
  stakeDeposited: 0,
  stakeLocked: 0,
  stakeAsset: "USDC",
  slashEventCount: 0,
  delegated: 0,
  subcontracted: 0,
};

const B = {
  handle: "agent-31ad-ab7f",
  walletFull: "0x31ad43000000000000000000000000000000ab7f",
  tier: "T1",
  score: 100105,
  specialty: "writer-gov",
  badges: [],
  recentActivity: "",
  stakeDeposited: 12,
  stakeLocked: 4,
  stakeAsset: "USDC",
  slashEventCount: 1,
  delegated: 2,
  subcontracted: 3,
};

test("buildComparisonRows aligns one value per agent, in order", () => {
  const rows = buildComparisonRows([A, B]);
  assert.equal(rows.length, COMPARISON_METRICS.length);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.values]));
  assert.deepEqual(byKey.tier, ["T2", "T1"]);
  assert.deepEqual(byKey.score, ["100200", "100105"]);
  assert.deepEqual(byKey.specialty, ["coding", "writer-gov"]);
});

test("badges join with '; ' and empty renders as an em-dash, not blank", () => {
  const rows = buildComparisonRows([A, B]);
  const badges = rows.find((r) => r.key === "badges").values;
  assert.deepEqual(badges, ["Coding L1; Coding L2", "—"]);
});

test("empty/zero-ish missing values render '—' (no fake blank)", () => {
  const rows = buildComparisonRows([B]);
  const activity = rows.find((r) => r.key === "recentActivity").values;
  assert.deepEqual(activity, ["—"]); // empty string → em-dash
  const score = rows.find((r) => r.key === "score").values;
  assert.deepEqual(score, ["100105"]); // a real 0 would still print "0"
});

test("stake and slash metrics use explicit units and all-time count labels", () => {
  const rows = buildComparisonRows([B]);
  assert.deepEqual(rows.find((r) => r.key === "stakeDeposited").values, ["12 USDC"]);
  assert.deepEqual(rows.find((r) => r.key === "stakeLocked").values, ["4 USDC"]);
  assert.deepEqual(rows.find((r) => r.key === "slashEventCount").values, ["1"]);
  assert.equal(rows.find((r) => r.key === "slashEventCount").label, "Slash events");
});

test("supports three agents", () => {
  const rows = buildComparisonRows([A, B, A]);
  assert.equal(rows[0].values.length, 3);
});

test("comparisonToCsv: header is Metric + handles, one row per metric", () => {
  const csv = comparisonToCsv([A, B]);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "Metric,agent-fd2e-6519,agent-31ad-ab7f");
  assert.equal(lines.length, COMPARISON_METRICS.length + 1);
  assert.ok(lines.some((l) => l.startsWith("Tier,T2,T1")));
});

test("comparisonToCsv escapes commas and quotes (RFC 4180)", () => {
  const withComma = { ...A, recentActivity: 'Claimed "job", 1d ago' };
  const csv = comparisonToCsv([withComma]);
  const line = csv.split("\r\n").find((l) => l.startsWith("Recent activity"));
  // internal quotes doubled, whole cell quoted because it has a comma/quote
  assert.equal(line, 'Recent activity,"Claimed ""job"", 1d ago"');
});

test("comparisonCsvFilename: stamped + sanitized, or bare", () => {
  assert.equal(comparisonCsvFilename(), "averray-agent-comparison.csv");
  assert.equal(
    comparisonCsvFilename("2026-05-29T12:00:00Z"),
    "averray-agent-comparison-2026-05-29T120000Z.csv",
  );
});

test("defensive: non-array input does not throw", () => {
  assert.deepEqual(comparisonToCsv(undefined).split("\r\n")[0], "Metric");
  assert.equal(buildComparisonRows(null)[0].values.length, 0);
});

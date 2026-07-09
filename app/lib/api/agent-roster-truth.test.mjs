import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  matchesAgentStatusFilter,
  stateFor,
  tierFrom,
} from "./agent-roster-truth.js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..", "..");
const agentsDir = resolve(appRoot, "components", "agents");

test("history without an active session resolves to idle, not active", () => {
  assert.equal(stateFor({ slashEventCount: 0, totalJobs: 49 }), "idle");
  assert.equal(
    stateFor({ slashEventCount: 0, totalJobs: 49, activeStatus: "working" }),
    "working"
  );
  assert.equal(matchesAgentStatusFilter("working", "working"), true);
  assert.equal(matchesAgentStatusFilter("idle", "working"), false);
  assert.equal(matchesAgentStatusFilter("active", "idle"), true);
});

test("API journeyman tier remains T2 even when its raw score is 100200", () => {
  assert.equal(tierFrom("journeyman", 100200), "T2");

  const table = readFileSync(resolve(agentsDir, "AgentDirectoryTable.tsx"), "utf8");
  const drawer = readFileSync(resolve(agentsDir, "AgentDrawerBody.tsx"), "utf8");
  assert.match(table, /<TierChip tier=\{a\.tier\}/u);
  assert.match(drawer, /<TierChip tier=\{agent\.tier\}/u);
  assert.match(drawer, /t\.id === agent\.tier/u);
  assert.doesNotMatch(drawer, /tierFor\(agent\.score\)/u);
});

test("agents surfaces contain no fabricated trend or hardcoded DOT claims", () => {
  const files = [
    resolve(here, "agent-adapters.ts"),
    ...[
      "AgentComparisonDialog.tsx",
      "AgentDirectoryTable.tsx",
      "AgentDrawerBody.tsx",
      "AgentTierLegend.tsx",
      "AgentsAggregateStrip.tsx",
    ].map((name) => resolve(agentsDir, name)),
  ];
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n");

  assert.doesNotMatch(source, /sparkline\s*\(/u);
  assert.doesNotMatch(source, /raw, not smoothed/iu);
  assert.doesNotMatch(source, /["'`] DOT/gu);
  assert.doesNotMatch(source, /Slashed 30d|Slashed \(30d\)|visible roster · 30d/iu);
});

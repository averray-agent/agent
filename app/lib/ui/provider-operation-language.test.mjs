import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatProviderRunSummary,
  providerOperationMetricLabel,
  providerOperationMetricValue,
  PROVIDER_OPERATION_LEGEND,
} from "./provider-operation-language.js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..", "..");
const RAW_COUNTER_WORDS = /\b(candidate|candidates|created|skipped|error|errors)\b/u;

test("provider operation legend replaces scheduler jargon with operator language", () => {
  assert.deepEqual(
    PROVIDER_OPERATION_LEGEND.map((entry) => entry.key),
    ["candidate", "created", "skipped", "error"]
  );
  // candidateCount is post-gate (survivors), verified against
  // mcp-server/src/jobs/ingest-*.js — the label must not imply raw
  // upstream discovery.
  assert.equal(providerOperationMetricLabel("candidate"), "Passed gates");
  assert.equal(providerOperationMetricLabel("created"), "Opened as jobs");
  assert.equal(providerOperationMetricLabel("skipped"), "Safely ignored");
  assert.equal(providerOperationMetricLabel("error"), "Needs attention");
});

test("provider operation metrics read the backend counters without exposing raw labels", () => {
  const run = {
    candidateCount: 26,
    createdCount: 4,
    skippedCount: 22,
    errorCount: 0,
  };
  assert.equal(providerOperationMetricValue("candidate", run), 26);
  assert.equal(providerOperationMetricValue("created", run), 4);
  assert.equal(providerOperationMetricValue("skipped", run), 22);
  assert.equal(providerOperationMetricValue("error", run), 0);
});

test("provider operation summaries tell the operator what happened", () => {
  // "checked" totals are candidates + skipped: candidateCount only counts
  // gate survivors, so the old sentences ("2 upstream items checked; 18
  // safely ignored") were arithmetically impossible.
  const summaries = [
    [
      formatProviderRunSummary({ candidateCount: 26, createdCount: 4, skippedCount: 22, errorCount: 0 }),
      "4 jobs opened from 48 upstream items.",
    ],
    [
      formatProviderRunSummary({ dryRun: true, candidateCount: 12, createdCount: 0, skippedCount: 12, errorCount: 0 }),
      "Dry run: 24 upstream items checked; 12 items safely ignored.",
    ],
    [
      formatProviderRunSummary({ candidateCount: 5, createdCount: 0, skippedCount: 3, errorCount: 2 }),
      "2 items need operator attention after checking 8 upstream items.",
    ],
    [
      formatProviderRunSummary({ candidateCount: 1, createdCount: 0, skippedCount: 0, errorCount: 1 }),
      "1 item needs operator attention after checking 1 upstream item.",
    ],
  ];

  for (const [actual, expected] of summaries) {
    assert.equal(actual, expected);
    assert.doesNotMatch(actual, RAW_COUNTER_WORDS);
  }
});

test("ProviderOperationsCard renders the legend and derived operator summary", () => {
  const source = readFileSync(
    resolve(appRoot, "components/overview/ProviderOperationsCard.tsx"),
    "utf8"
  );
  assert.match(source, /ProviderOperationsLegend/u);
  assert.match(source, /PROVIDER_OPERATION_LEGEND/u);
  assert.match(source, /formatProviderRunSummary\(lastRun\)/u);
  assert.match(source, /ignored because:/u);
  assert.doesNotMatch(source, /\{lastRun\.summary\}/u);
});

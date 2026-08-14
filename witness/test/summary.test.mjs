import assert from "node:assert/strict";
import test from "node:test";

import { formatSummary, summarizeReports } from "../src/summary.mjs";

test("summary prints the distribution and median/worst preparation cost", () => {
  const summary = summarizeReports([
    {
      repo: "one/repo",
      commit: "a",
      classification: "HERMETIC",
      baseExitStatus: 0,
      dependencyPreparationSeconds: 0,
      dependencyCacheSizeBytes: 0,
      totalSeconds: 1
    },
    {
      repo: "two/repo",
      commit: "b",
      classification: "FROZEN_DEPENDENCIES",
      baseExitStatus: 1,
      dependencyPreparation: { attempted: true },
      dependencyPreparationSeconds: 4,
      dependencyCacheSizeBytes: 42,
      totalSeconds: 6
    },
    {
      repo: "three/repo",
      commit: null,
      classification: "UNMATERIALIZABLE",
      baseExitStatus: null,
      dependencyPreparation: { attempted: true },
      dependencyPreparationSeconds: 2,
      dependencyCacheSizeBytes: 0,
      totalSeconds: 3,
      observedFailureReason: "missing cargo"
    }
  ]);
  assert.equal(summary.distribution.HERMETIC, 1);
  assert.equal(summary.distribution.FROZEN_DEPENDENCIES, 1);
  assert.equal(summary.distribution.UNMATERIALIZABLE, 1);
  assert.equal(summary.preparationCost.medianSeconds, 2);
  assert.equal(summary.preparationCost.medianPreparedReposSeconds, 3);
  assert.equal(summary.preparationCost.worstCaseSeconds, 4);
  assert.equal(summary.preparationCost.worstCaseRepo, "two/repo");
  assert.match(formatSummary(summary), /Per repository:/u);
});

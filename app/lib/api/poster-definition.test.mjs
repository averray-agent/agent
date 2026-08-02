import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPosterDefinition,
  verifierDisclosureForDeliverable
} from "./poster-definition.js";

const BASE = {
  title: "example/project#42: Fix parser validation",
  task: "Resolve example/project issue #42 with a pull request.",
  repo: "example/project",
  issueNumber: 42,
  issueUrl: "https://github.com/example/project/issues/42",
  acceptanceCriteria: ["The PR references issue #42.", "Tests pass."],
  rewardUsdc: "1"
};

test("PR-template drafts carry github_pr with a live issue anchor and PR evidence schema", () => {
  const definition = buildPosterDefinition({ ...BASE, deliverableKind: "pr" });

  assert.equal(definition.verifierMode, "github_pr");
  assert.equal(definition.requireClaimantBinding, true);
  assert.equal(definition.outputSchemaRef, "schema://jobs/github-pr-evidence-output");
  assert.deepEqual(definition.source, {
    type: "github_issue",
    repo: "example/project",
    issueNumber: 42,
    issueUrl: "https://github.com/example/project/issues/42"
  });
  assert.match(definition.agentInstructions[0], /standard Averray disclosure footer/iu);
  assert.match(definition.agentInstructions[1], /Agent identity: <claimant EVM wallet>/u);
  assert.match(definition.agentInstructions[1], /Claim session:  <claim session id>/u);
  assert.match(verifierDisclosureForDeliverable("pr").summary, /live CI\/check state/iu);
  assert.match(verifierDisclosureForDeliverable("pr").summary, /actual claimant wallet or claim session/iu);
  assert.match(verifierDisclosureForDeliverable("pr").summary, /missing or mismatched claimant binding is rejected/iu);
  assert.match(verifierDisclosureForDeliverable("pr").summary, /human review and never auto-approves/iu);
});

test("report-template drafts remain human_fallback", () => {
  const definition = buildPosterDefinition({ ...BASE, deliverableKind: "report" });

  assert.equal(definition.verifierMode, "human_fallback");
  assert.equal("requireClaimantBinding" in definition, false);
  assert.equal(definition.outputSchemaRef, "schema://jobs/coding-output");
  assert.equal("agentInstructions" in definition, false);
  assert.match(verifierDisclosureForDeliverable("report").summary, /poster reviews/iu);
});

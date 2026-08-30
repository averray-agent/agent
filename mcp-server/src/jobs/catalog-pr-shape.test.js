import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeJobInput } from "../core/job-catalog-normalization.js";
import {
  countRealWaiverEligibleClaimableJobs,
  resolveOnboardingInventoryHealth
} from "../core/onboarding-inventory.js";
import { DEFAULT_MIN_REWARD_USDC } from "../core/external-posting-policy.js";
import { buildPublicJobsResponse } from "../protocols/http/jobs-response.js";
import { VerifierRegistry } from "../services/verifier-handlers.js";
import {
  assertRetirementStepSafe,
  buildCatalogReshapePlan,
  catalogInventory
} from "../../../scripts/ops/reshape-catalog-pr-jobs.mjs";
import { toPlatformJob as wikipediaJob } from "./ingest-wikipedia-maintenance.js";

const manifest = JSON.parse(await readFile(
  new URL("../../../docs/catalog-pr-shape.json", import.meta.url),
  "utf8"
));

function ratifiedCatalog() {
  const retirements = manifest.retirements.map((retirement) => ({
    id: retirement.id,
    title: `Legacy ${retirement.sourceType} audit`,
    category: "review",
    tier: "starter",
    rewardAsset: retirement.rewardAsset,
    rewardAmount: retirement.rewardAmount,
    verifierMode: "benchmark",
    verifierTerms: ["legacy", retirement.id],
    verifierMinimumMatches: 1,
    onboardingWaiverEligible: true,
    requiresSponsoredGas: true,
    claimable: retirement.claimableAtRatification,
    source: { type: retirement.sourceType }
  }));
  const wikipedia = [1, 2].map((index) => ({
    id: `wiki-anchored-${index}`,
    title: `Anchored Wikipedia proposal ${index}`,
    category: "wikipedia",
    tier: "starter",
    rewardAsset: "USDC",
    rewardAmount: 0.4,
    verifierMode: "benchmark",
    verifierTerms: ["article", String(index)],
    verifierMinimumMatches: 1,
    verifierAnchorEvidence: {
      kind: "wikipedia_revision_wikitext",
      language: "en",
      revisionId: String(index)
    },
    onboardingWaiverEligible: true,
    requiresSponsoredGas: true,
    claimable: true,
    source: { type: "wikipedia_article" }
  }));
  const deterministic = [
    { id: "external-real", source: { type: "external" } },
    { id: "governance-real", source: { type: "governance" } }
  ].map((job) => ({
    ...job,
    title: "Deterministic work",
    category: "coding",
    tier: "starter",
    rewardAsset: "USDC",
    rewardAmount: 1,
    verifierMode: "deterministic",
    verifierTerms: ["expected"],
    claimable: true
  }));
  return [...retirements, ...wikipedia, ...deterministic];
}

test("catalog PR shape — no reachable job instruction forbids a pull request", () => {
  const plan = buildCatalogReshapePlan(ratifiedCatalog(), manifest);
  assert.deepEqual(plan.projectedVerifierMix, {
    benchmark_anchored: 2,
    deterministic: 2,
    github_pr: 3
  });
  for (const { job } of manifest.replacements) {
    const copy = JSON.stringify({
      title: job.title,
      description: job.description,
      acceptanceCriteria: job.acceptanceCriteria,
      agentInstructions: job.agentInstructions
    });
    assert.doesNotMatch(copy, /do not (?:open|create|submit)[^.!?]{0,40}pull request/iu);
    assert.match(copy, /open a (?:reviewable )?pull request/iu);
  }
});

test("catalog PR shape — every reachable verifier rejects deficient evidence", async () => {
  const verdicts = [];
  for (const { job } of manifest.replacements) {
    verdicts.push(await new VerifierRegistry({ githubToken: "" }).evaluate(
      normalizeJobInput(job),
      { summary: "Changed the requested file.", tests: ["not run"] }
    ));
  }

  const anchored = normalizeJobInput(wikipediaJob({
    language: "en",
    pageId: 123,
    title: "Mutation guard article",
    pageUrl: "https://en.wikipedia.org/wiki/Mutation_guard_article",
    revisionId: "987654321",
    revisionTimestamp: "2026-08-30T08:00:00Z",
    categoryTitle: "Category:All articles with dead external links",
    taskType: "citation_repair",
    templates: ["Template:Dead link"]
  }, 88));
  verdicts.push(await new VerifierRegistry({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          query: {
            pages: [{
              revisions: [{
                revid: 987654321,
                slots: { main: { content: "Pinned text does not contain fabricated evidence." } }
              }]
            }]
          }
        };
      }
    })
  }).evaluate(anchored, {
    page_title: "Mutation guard article",
    revision_id: "987654321",
    citation_findings: [{
      section: "Lead",
      problem: "dead_link",
      current_claim: "Claim",
      source_quote: "fabricated quote",
      evidence_url: "https://fabricated.invalid/evidence"
    }],
    proposed_changes: [{
      change_type: "replace_citation",
      target_text: "Old citation",
      replacement_text: "New citation",
      source_url: "https://fabricated.invalid/source"
    }],
    review_notes: anchored.verifierConfig.requiredKeywords.join(" ")
  }));

  const deterministic = normalizeJobInput({
    id: "deterministic-mutation-guard",
    title: "Verify deterministic output",
    category: "coding",
    tier: "starter",
    rewardAsset: "USDC",
    rewardAmount: 1,
    verifierMode: "deterministic",
    verifierTerms: ["expected exact output"],
    verifierMatchMode: "exact"
  });
  verdicts.push(await new VerifierRegistry().evaluate(deterministic, "deficient output"));

  assert.equal(verdicts.length, 5);
  assert.ok(verdicts.every(({ outcome }) => outcome === "rejected"));
  assert.deepEqual(new Set(verdicts.map(({ handler }) => handler)), new Set([
    "github_pr",
    "benchmark",
    "deterministic"
  ]));
});

test("catalog PR shape — replacements are claimable before bounded retirement and inventory never crosses the minimum", () => {
  const before = ratifiedCatalog();
  const plan = buildCatalogReshapePlan(before, manifest);
  assert.equal(plan.before.waiverEligibleClaimableJobs, 7);
  assert.equal(plan.after.waiverEligibleClaimableJobs, 5);
  assert.throws(
    () => assertRetirementStepSafe(before, manifest, manifest.retirements[0].id),
    /replacements? must be listed and claimable/iu
  );

  let staged = [
    ...before,
    ...manifest.replacements.map(({ job }) => ({ ...job, claimable: true }))
  ];
  for (const retirement of manifest.retirements) {
    const projected = assertRetirementStepSafe(staged, manifest, retirement.id);
    assert.ok(projected.waiverEligibleClaimableJobs >= manifest.minimumClaimableInventory);
    staged = staged.filter((job) => job.id !== retirement.id);
  }
  assert.equal(catalogInventory(staged).waiverEligibleClaimableJobs, 5);
});

test("catalog PR shape — health and /jobs use the same waiver-eligible claimable intersection", async () => {
  const jobs = [
    {
      id: "wiki-claimable",
      tier: "starter",
      onboardingWaiverEligible: true,
      claimable: true,
      source: { type: "wikipedia_article" }
    },
    {
      id: "github-claimable",
      tier: "starter",
      onboardingWaiverEligible: true,
      claimable: true,
      source: { type: "github_issue" }
    },
    {
      id: "openapi-exhausted",
      tier: "starter",
      onboardingWaiverEligible: true,
      claimable: false,
      source: { type: "openapi_spec" }
    },
    {
      id: "external-not-waived",
      tier: "starter",
      onboardingWaiverEligible: true,
      claimable: true,
      source: { type: "external" }
    }
  ];
  const health = await resolveOnboardingInventoryHealth({
    service: {
      listJobs: () => jobs,
      attachClaimState: async (job) => job
    }
  });
  const response = buildPublicJobsResponse(jobs, new URLSearchParams({ format: "compact" }));

  assert.equal(countRealWaiverEligibleClaimableJobs(jobs), 2);
  assert.equal(health.waiverEligibleClaimableJobs, 2);
  assert.equal(response.inventory.waiverEligibleClaimableJobs, 2);
  assert.equal(response.inventory.waiverEligibleJobs, 3);
  assert.equal(response.inventory.claimableJobs, 3);
});

test("catalog PR shape — target, reward, waiver, and poster economics are unchanged", () => {
  const expectedTargets = new Map([
    ["pr-stenion-lab-stenion-120", ["stenion-lab/stenion", 120]],
    ["pr-labscrypt-remitlend-1081", ["LabsCrypt/remitlend", 1081]],
    ["pr-meshery-meshery-21594", ["meshery/meshery", 21594]]
  ]);
  for (const replacement of manifest.replacements) {
    const { job, legacyEconomics } = replacement;
    assert.deepEqual(
      [job.source.repo, job.source.issueNumber],
      expectedTargets.get(job.id)
    );
    assert.equal(job.source.type, "github_issue");
    assert.notEqual(job.source.type, "external", "operator catalog work must not read as external demand");
    assert.equal(job.rewardAsset, legacyEconomics.rewardAsset);
    assert.equal(job.rewardAmount, legacyEconomics.rewardAmount);
    assert.equal(job.tier, legacyEconomics.tier);
    assert.equal(job.estimatedDifficulty, legacyEconomics.estimatedDifficulty);
    assert.equal(job.onboardingWaiverEligible, legacyEconomics.onboardingWaiverEligible);
    assert.equal(job.requiresSponsoredGas, legacyEconomics.requiresSponsoredGas);
  }
  assert.equal(DEFAULT_MIN_REWARD_USDC, "1", "external poster minimum stays unchanged");
});

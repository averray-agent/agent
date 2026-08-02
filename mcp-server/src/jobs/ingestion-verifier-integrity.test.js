import test from "node:test";
import assert from "node:assert/strict";

import { normalizeJobInput } from "../core/job-catalog-normalization.js";
import { validateStructuredSubmission } from "../core/job-schema-registry.js";
import { VerifierRegistry } from "../services/verifier-handlers.js";
import { toPlatformJob as githubJob } from "./ingest-github-issues.js";
import { toPlatformJob as openDataJob } from "./ingest-open-data-datasets.js";
import { toPlatformJob as openApiJob } from "./ingest-openapi-specs.js";
import { toPlatformJob as osvJob } from "./ingest-osv-advisories.js";
import { toPlatformJob as standardsJob } from "./ingest-standards-specs.js";
import { toPlatformJob as wikipediaJob } from "./ingest-wikipedia-maintenance.js";

const PLACEHOLDER = "Placeholder content";

const wikipediaArticle = {
  language: "en",
  pageId: 123,
  title: "Substantive article subject",
  pageUrl: "https://en.wikipedia.org/wiki/Substantive_article_subject",
  revisionId: "987654321",
  revisionTimestamp: "2026-04-25T10:00:00Z",
  categoryTitle: "Category:All articles with dead external links",
  templates: ["Template:Dead link"]
};

const fixtures = [
  {
    name: "wikipedia citation repair",
    job: wikipediaJob({ ...wikipediaArticle, taskType: "citation_repair" }, 88),
    submission: {
      page_title: PLACEHOLDER,
      revision_id: "1",
      citation_findings: [{
        section: "Lead",
        problem: "dead_link",
        current_claim: PLACEHOLDER,
        evidence_url: "https://example.invalid/evidence"
      }],
      proposed_changes: [{
        change_type: "flag_for_editor_review",
        target_text: PLACEHOLDER,
        replacement_text: PLACEHOLDER,
        source_url: "https://example.invalid/source"
      }],
      review_notes: PLACEHOLDER
    }
  },
  {
    name: "wikipedia freshness check",
    job: wikipediaJob({ ...wikipediaArticle, taskType: "freshness_check" }, 88),
    submission: {
      page_title: PLACEHOLDER,
      revision_id: "1",
      freshness_findings: [{
        claim: PLACEHOLDER,
        status: "unclear",
        evidence_url: "https://example.invalid/evidence",
        note: PLACEHOLDER
      }],
      recommended_editor_actions: [PLACEHOLDER],
      risk_level: "low"
    }
  },
  {
    name: "wikipedia infobox consistency",
    job: wikipediaJob({ ...wikipediaArticle, taskType: "infobox_consistency" }, 88),
    submission: {
      page_title: PLACEHOLDER,
      revision_id: "1",
      checked_fields: [{
        field: "unknown",
        current_value: PLACEHOLDER,
        evidence_url: "https://example.invalid/evidence",
        status: "needs_editor_review",
        note: PLACEHOLDER
      }],
      proposed_changes: [{
        field: "unknown",
        target_text: PLACEHOLDER,
        replacement_text: PLACEHOLDER,
        source_url: "https://example.invalid/source"
      }],
      review_notes: PLACEHOLDER
    }
  },
  {
    name: "standards specification",
    job: standardsJob({
      provider: "w3c",
      specId: "vc-data-model-2.0",
      specTitle: "Verifiable Credentials Data Model v2.0",
      specUrl: "https://www.w3.org/TR/vc-data-model-2.0/",
      currentVersion: "2.0",
      localSurface: "docs/credentials.md",
      repo: "example/project"
    }, 92),
    submission: {
      source_surface: PLACEHOLDER,
      drift_findings: [{ surface_a: "A", surface_b: "B", mismatch: PLACEHOLDER }],
      missing_updates: [],
      severity: "low",
      fix_recommendation: PLACEHOLDER
    }
  },
  {
    name: "GitHub issue",
    job: githubJob({
      title: "Add parser regression coverage",
      body: "Add a focused parser regression test.",
      number: 42,
      html_url: "https://github.com/example/project/issues/42",
      repository_url: "https://api.github.com/repos/example/project",
      labels: [{ name: "good first issue" }],
      comments: 0,
      locked: false
    }, 92),
    submission: { summary: PLACEHOLDER, output: PLACEHOLDER, status: "complete" }
  },
  {
    name: "OSV advisory",
    job: osvJob({
      target: {
        name: "minimist",
        version: "0.0.8",
        ecosystem: "npm",
        repo: "example/project",
        manifestPath: "package.json"
      },
      advisory: {
        id: "GHSA-vh95-rmgr-6w4m",
        aliases: ["CVE-2020-7598"],
        summary: "Prototype pollution",
        references: []
      },
      fixedVersion: "1.2.3",
      score: 92
    }),
    submission: { summary: PLACEHOLDER, output: PLACEHOLDER, status: "complete" }
  },
  {
    name: "OpenAPI specification",
    job: openApiJob({
      provider: "example",
      specId: "payments-api",
      apiTitle: "Example Payments API",
      specUrl: "https://api.example.invalid/openapi.json",
      localSurface: "docs/payments-api.md",
      openapiVersion: "3.1.0"
    }, 92),
    submission: {
      api_title: PLACEHOLDER,
      spec_url: "https://example.invalid/placeholder",
      checks: [{ name: "placeholder", status: "unknown", evidence: PLACEHOLDER }],
      findings: [],
      no_issue_found: true,
      summary: PLACEHOLDER,
      recommended_actions: [PLACEHOLDER]
    }
  },
  {
    name: "open-data resource",
    job: openDataJob({
      datasetId: "dataset-123",
      datasetTitle: "Federal sample spending data",
      datasetUrl: "https://catalog.data.gov/dataset/federal-sample-spending-data",
      resourceId: "resource-456",
      resourceTitle: "Spending CSV",
      resourceUrl: "https://example.gov/spending.csv",
      resourceFormat: "CSV"
    }, 92),
    submission: {
      dataset_title: PLACEHOLDER,
      dataset_url: "https://example.invalid/dataset",
      resource_url: "https://example.invalid/resource",
      checks: [{ name: "placeholder", status: "unknown", evidence: PLACEHOLDER }],
      findings: [],
      no_issue_found: true,
      summary: PLACEHOLDER,
      recommended_actions: [PLACEHOLDER]
    }
  }
];

for (const fixture of fixtures) {
  test(`${fixture.name} rejects schema-valid placeholder evidence`, async () => {
    validateStructuredSubmission(fixture.job.outputSchemaRef, fixture.submission);
    const normalizedJob = normalizeJobInput(fixture.job);
    const result = await new VerifierRegistry().evaluate(normalizedJob, fixture.submission);

    assert.equal(result.outcome, "rejected");
    assert.equal(result.reasonCode, "BENCHMARK_THRESHOLD_MISSED");
    assert.ok(
      fixture.job.verifierTerms.every((term) => !Object.keys(fixture.submission).includes(term)),
      "verifier terms must not echo top-level output-schema fields"
    );
  });

  test(`${fixture.name} accepts evidence carrying the source-bound claim identifiers`, async () => {
    const submission = structuredClone(fixture.submission);
    const evidence = fixture.job.verifierTerms.join(" ");
    const firstStringField = Object.keys(submission).find((key) => typeof submission[key] === "string");
    submission[firstStringField] = evidence;
    validateStructuredSubmission(fixture.job.outputSchemaRef, submission);

    const result = await new VerifierRegistry().evaluate(normalizeJobInput(fixture.job), submission);
    assert.equal(result.outcome, "approved");
  });
}

test("persisted field-name-only benchmark snapshots fail closed", async () => {
  const rawJob = wikipediaJob({ ...wikipediaArticle, taskType: "citation_repair" }, 88);
  rawJob.verifierTerms = ["page_title", "revision_id", "citation_findings", "proposed_changes", "review_notes"];
  rawJob.verifierMinimumMatches = 4;
  const submission = fixtures[0].submission;
  validateStructuredSubmission(rawJob.outputSchemaRef, submission);

  const result = await new VerifierRegistry().evaluate(normalizeJobInput(rawJob), submission);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reasonCode, "BENCHMARK_CONFIG_UNSAFE");
});

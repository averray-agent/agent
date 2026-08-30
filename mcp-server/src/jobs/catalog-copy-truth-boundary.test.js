import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { toPlatformJob as githubIssueJob } from "./ingest-github-issues.js";
import { toPlatformJob as openDataJob } from "./ingest-open-data-datasets.js";
import { toPlatformJob as openApiJob } from "./ingest-openapi-specs.js";
import { toPlatformJob as osvAdvisoryJob } from "./ingest-osv-advisories.js";
import { toPlatformJob as standardsJob } from "./ingest-standards-specs.js";
import { toPlatformJob as wikipediaJob } from "./ingest-wikipedia-maintenance.js";

const AUDIT_TITLE_PATTERN = /^Audit and report on\b/u;

test("active ingestion titles match the deliverable their verifier can prove", async () => {
  const github = githubIssueJob({
      title: "Fix parser validation",
      body: "The parser accepts an invalid edge case.",
      number: 42,
      html_url: "https://github.com/example/project/issues/42",
      repository_url: "https://api.github.com/repos/example/project",
      labels: [{ name: "good first issue" }, { name: "tests" }],
      comments: 1,
      locked: false
    }, 90);
  const generatedReportJobs = [
    osvAdvisoryJob({
      target: {
        ecosystem: "npm",
        name: "minimist",
        version: "0.0.8",
        repo: "example/project",
        manifestPath: "package.json"
      },
      advisory: {
        id: "GHSA-vh95-rmgr-6w4m",
        aliases: ["CVE-2020-7598"],
        summary: "Prototype pollution"
      },
      fixedVersion: "1.2.3",
      score: 90
    }),
    wikipediaJob({
      language: "en",
      pageId: 123,
      title: "Example article",
      pageUrl: "https://en.wikipedia.org/wiki/Example_article",
      revisionId: "987654321",
      taskType: "citation_repair",
      templates: ["Template:Dead link"]
    }, 88),
    openDataJob({
      datasetId: "dataset-123",
      datasetTitle: "Example dataset",
      datasetUrl: "https://catalog.data.gov/dataset/example",
      resourceId: "resource-123",
      resourceTitle: "Example CSV",
      resourceUrl: "https://example.gov/data.csv",
      resourceFormat: "CSV"
    }, 90),
    openApiJob({
      provider: "example",
      specId: "example-api",
      apiTitle: "Example API",
      specUrl: "https://example.com/openapi.json",
      localSurface: "src/api.js"
    }, 90),
    standardsJob({
      provider: "w3c",
      specId: "example-standard",
      specTitle: "Example standard",
      specUrl: "https://example.com/standard",
      localSurface: "docs/standard.md"
    }, 90)
  ];

  assert.match(github.title, /^Implement GitHub issue:/u);
  assert.equal(github.verifierMode, "github_pr");
  for (const job of generatedReportJobs) {
    assert.match(job.title, AUDIT_TITLE_PATTERN, job.title);
  }

  const bundlePath = fileURLToPath(new URL("../../../docs/ready-to-post-jobs.json", import.meta.url));
  const bundledJobs = JSON.parse(await readFile(bundlePath, "utf8"));
  for (const job of bundledJobs.filter((entry) => entry.source && entry.lifecycle?.status !== "archived")) {
    assert.match(job.title, AUDIT_TITLE_PATTERN, job.title);
  }
});

test("GitHub ingestion delivers a PR while OSV remains unreachable until it gets a fail-able verifier", () => {
  const github = githubIssueJob({
      title: "Add parser regression tests",
      body: "Cover the invalid edge case.",
      number: 42,
      html_url: "https://github.com/example/project/issues/42",
      repository_url: "https://api.github.com/repos/example/project",
      labels: [{ name: "tests" }],
      comments: 1,
      locked: false
    }, 90);
  const osv = osvAdvisoryJob({
      target: {
        ecosystem: "npm",
        name: "minimist",
        version: "0.0.8",
        repo: "example/project",
        manifestPath: "package.json"
      },
      advisory: { id: "GHSA-vh95-rmgr-6w4m", aliases: ["CVE-2020-7598"] },
      fixedVersion: "1.2.3",
      score: 90
    });

  assert.equal(github.verifierMode, "github_pr");
  assert.equal(github.outputSchemaRef, "schema://jobs/github-pr-evidence-output");
  assert.match(github.agentInstructions.join(" "), /Open a pull request/u);
  assert.doesNotMatch(
    github.agentInstructions.join(" "),
    /do not (?:open|create|submit)[^.!?]{0,40}(?:a )?pull request/iu
  );

  assert.equal(osv.verifierMode, "benchmark");
  assert.equal(osv.outputSchemaRef, "schema://jobs/coding-output");
  assert.match(osv.agentInstructions.join(" "), /Do not modify the upstream repository or open a pull request/u);
  assert.doesNotMatch(osv.verification.signals.join(" "), /pr_opened|merged|dependency_updated/u);
});

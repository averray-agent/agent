import test from "node:test";
import assert from "node:assert/strict";

import {
  extractPackageTargets,
  ingestOpenDataDatasets,
  parseDatasets,
  scoreDatasetTarget,
  searchDataGovDatasets,
  toPlatformJob
} from "./ingest-open-data-datasets.js";

const TARGET = {
  portal: "data.gov",
  datasetId: "dataset-123",
  datasetTitle: "Federal sample spending data",
  datasetUrl: "https://catalog.data.gov/dataset/federal-sample-spending-data",
  resourceId: "resource-456",
  resourceTitle: "Spending CSV",
  resourceUrl: "https://example.gov/spending.csv",
  resourceFormat: "CSV",
  agency: "General Services Administration",
  license: "CC0",
  modified: "2021-01-01T00:00:00Z",
  metadataModified: "2026-01-01T00:00:00Z"
};

const CKAN_PACKAGE = {
  id: "dataset-123",
  name: "federal-sample-spending-data",
  title: "Federal sample spending data",
  license_title: "CC0",
  metadata_modified: "2026-01-01T00:00:00Z",
  organization: { title: "General Services Administration" },
  resources: [
    {
      id: "resource-456",
      name: "Spending CSV",
      url: "https://example.gov/spending.csv",
      format: "CSV",
      last_modified: "2021-01-01T00:00:00Z"
    }
  ]
};

test("parseDatasets accepts JSON and compact line syntax", () => {
  assert.deepEqual(parseDatasets(JSON.stringify([TARGET])), [TARGET]);
  assert.deepEqual(
    parseDatasets("Federal sample spending data|https://catalog.data.gov/dataset/federal-sample-spending-data|https://example.gov/spending.csv|CSV|General Services Administration"),
    [
      {
        portal: "data.gov",
        datasetId: "",
        datasetTitle: "Federal sample spending data",
        datasetUrl: "https://catalog.data.gov/dataset/federal-sample-spending-data",
        resourceId: "",
        resourceTitle: "",
        resourceUrl: "https://example.gov/spending.csv",
        resourceFormat: "CSV",
        agency: "General Services Administration",
        license: "",
        modified: "",
        metadataModified: ""
      }
    ]
  );
});

test("extractPackageTargets maps CKAN package resources", () => {
  const targets = extractPackageTargets(CKAN_PACKAGE);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].datasetUrl, "https://catalog.data.gov/dataset/federal-sample-spending-data");
  assert.equal(targets[0].resourceUrl, "https://example.gov/spending.csv");
  assert.equal(targets[0].agency, "General Services Administration");
});

test("scoreDatasetTarget prefers concrete resource audit targets", () => {
  assert.ok(scoreDatasetTarget(TARGET) >= 80);
  assert.equal(scoreDatasetTarget({ ...TARGET, resourceUrl: "" }), 46);
});

test("toPlatformJob creates a benchmark open-data audit job", () => {
  const job = toPlatformJob(TARGET, 92);

  assert.equal(job.id, "open-data-datagov-dataset-123-resource-456");
  assert.equal(job.category, "data");
  assert.equal(job.tier, "starter");
  assert.equal(job.verifierMode, "benchmark");
  assert.equal(job.inputSchemaRef, "schema://jobs/open-data-quality-audit-input");
  assert.equal(job.outputSchemaRef, "schema://jobs/open-data-quality-audit-output");
  assert.equal(job.source.type, "open_data_dataset");
  assert.equal(job.source.provider, "data.gov");
  assert.equal(job.source.resourceFormat, "CSV");
  assert.ok(job.acceptanceCriteria.some((entry) => entry.includes("no_issue_found")));
  assert.ok(job.verifierTerms.includes("recommended_actions"));
});

test("searchDataGovDatasets queries the Data.gov CKAN API", async () => {
  const targets = await searchDataGovDatasets({
    query: "res_format:CSV",
    limit: 5,
    fetchImpl: async (url, request) => {
      assert.equal(url.searchParams.get("q"), "res_format:CSV");
      assert.equal(url.searchParams.get("rows"), "5");
      assert.equal(request.headers.accept, "application/json");
      return {
        ok: true,
        async json() {
          return { result: { results: [CKAN_PACKAGE] } };
        }
      };
    }
  });

  assert.equal(targets.length, 1);
  assert.equal(targets[0].datasetId, "dataset-123");
});

test("ingestOpenDataDatasets uses explicit targets before remote search", async () => {
  const payload = await ingestOpenDataDatasets({
    datasets: [TARGET],
    limit: 5,
    minScore: 55,
    fetchImpl: async () => {
      throw new Error("fetch should not run for explicit datasets");
    }
  });

  assert.equal(payload.provider, "data.gov");
  assert.equal(payload.count, 1);
  assert.equal(payload.jobs[0].source.datasetTitle, "Federal sample spending data");
  assert.equal(payload.skipped.length, 0);
});

test("ingestOpenDataDatasets searches Data.gov and filters low-score resources", async () => {
  const payload = await ingestOpenDataDatasets({
    query: "res_format:CSV",
    limit: 5,
    minScore: 90,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          result: {
            results: [
              CKAN_PACKAGE,
              {
                id: "low",
                name: "low-score-resource",
                title: "Low-score resource",
                resources: [{ id: "low-resource", name: "Low URL", url: "https://example.gov/file.txt", format: "TXT" }]
              }
            ]
          }
        };
      }
    })
  });

  assert.equal(payload.count, 1);
  assert.equal(payload.skipped[0].reason, "below_min_score");
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  legacyCatalogueDefinitions,
  upsertScheduledIngestedJob
} from "./ingested-job-upsert.js";
import { assertIngestedCatalogVerifierCanReject } from "../core/catalog-verifier-integrity.js";

const INGESTION_SCHEDULERS = [
  "github-issue-ingestion-scheduler.js",
  "wikipedia-maintenance-ingestion-scheduler.js",
  "osv-advisory-ingestion-scheduler.js",
  "open-data-ingestion-scheduler.js",
  "standards-spec-ingestion-scheduler.js",
  "openapi-spec-ingestion-scheduler.js"
];

test("all six ingestion schedulers park spec-hash refusals in their per-job catch", async () => {
  for (const file of INGESTION_SCHEDULERS) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(
      source,
      /catch \(error\) \{[\s\S]{0,400}recordIngestSpecHashRefusal\(summary,/u,
      file
    );
  }
});

test("all six ingestion schedulers park non-failable verifier refusals", async () => {
  for (const file of INGESTION_SCHEDULERS) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(
      source,
      /catch \(error\) \{[\s\S]{0,500}recordIngestVerifierRefusal\(summary,/u,
      file
    );
  }
});

test("production catalog write guard refuses keyword-only ingested benchmarks", () => {
  assert.throws(
    () => assertIngestedCatalogVerifierCanReject({
      id: "unsafe-open-data",
      verifierMode: "benchmark",
      verifierTerms: ["dataset", "audit"],
      source: { type: "open_data_dataset" }
    }),
    (error) => error?.code === "catalog_verifier_cannot_reject_bad_work"
  );
});

test("pre-D3 liveness definitions retain their exact lane-less reward variants", () => {
  const current = {
    id: "open-data-job",
    lane: "liveness",
    rewardAmount: 0.1,
    source: { type: "open_data_dataset" }
  };

  assert.deepEqual(legacyCatalogueDefinitions(current), [
    {
      id: "open-data-job",
      rewardAmount: 0.1,
      source: { type: "open_data_dataset" }
    },
    {
      id: "open-data-job",
      rewardAmount: 0.25,
      source: { type: "open_data_dataset" }
    }
  ]);
});

test("an already-posted job hydrates without consuming the new lane budget", async () => {
  let gated = false;
  const platformService = {
    blockchainGateway: {
      isEnabled: () => true,
      async getJob() { return { state: 1, specHash: `0x${"1".repeat(64)}` }; }
    },
    catalogueLaneDiscipline: {
      async post() { gated = true; throw new Error("must not gate hydration"); }
    },
    async upsertIngestedJob(job, options) { return { job, options }; }
  };
  const now = new Date("2026-08-13T12:00:00.000Z");
  const result = await upsertScheduledIngestedJob(platformService, {
    id: "existing",
    lane: "oss-anchored",
    rewardAmount: 0.3,
    source: { type: "osv_advisory" }
  }, { now });

  assert.equal(gated, false);
  assert.equal(result.options.liveJob.state, 1);
  assert.equal(result.options.compatibleDefinitions[0].lane, undefined);
});

test("a missing chain job passes the lane gate before posting", async () => {
  const calls = [];
  const platformService = {
    blockchainGateway: {
      isEnabled: () => true,
      async getJob() { return { state: 0 }; }
    },
    catalogueLaneDiscipline: {
      async post(job, action) {
        calls.push(`gate:${job.id}`);
        return action();
      }
    },
    async upsertIngestedJob(job) {
      calls.push(`post:${job.id}`);
      return job;
    }
  };

  await upsertScheduledIngestedJob(platformService, {
    id: "new",
    lane: "liveness",
    rewardAmount: 0.1
  });

  assert.deepEqual(calls, ["gate:new", "post:new"]);
});

test("scheduled ingestion explicitly declares scheduler origin at the posting boundary", async () => {
  let seen;
  const now = new Date("2026-09-05T12:00:00.000Z");
  const candidate = { id: "github-scheduled", lane: "oss-anchored", source: { type: "github_issue" } };
  await upsertScheduledIngestedJob({
    catalogueLaneDiscipline: {
      async post(job, action, options) {
        seen = options;
        assert.equal(job, candidate);
        return action();
      }
    },
    async upsertIngestedJob(job) { return job; }
  }, candidate, { now });
  assert.deepEqual(seen, { now, origin: "scheduler" });
  assert.equal(candidate.origin, undefined, "posting metadata must not enter the committed definition");
});

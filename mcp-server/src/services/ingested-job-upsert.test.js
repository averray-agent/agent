import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  legacyCatalogueDefinitions,
  upsertScheduledIngestedJob
} from "./ingested-job-upsert.js";

const INGESTION_SCHEDULERS = [
  "wikipedia-maintenance",
  "github-issue",
  "osv-advisory",
  "open-data",
  "standards-spec",
  "openapi-spec"
];

test("every scheduled ingestion lane parks spec-hash refusals and surfaces their count", async () => {
  for (const lane of INGESTION_SCHEDULERS) {
    const source = await readFile(new URL(`./${lane}-ingestion-scheduler.js`, import.meta.url), "utf8");
    assert.match(
      source,
      /recordIngestSpecHashRefusal\(summary, [^,]+, error\)\) continue/u,
      `${lane} must absorb the per-candidate integrity refusal`
    );
    assert.match(
      source,
      /parkedSpecHashRefusals: Number\(this\.lastRun\?\.parkedSpecHashRefusals \?\? 0\)/u,
      `${lane} status must expose parked integrity refusals`
    );
    assert.match(
      source,
      /return finishIngestionRun\(this, summary,/u,
      `${lane} must publish the common ingestion run summary`
    );
  }
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

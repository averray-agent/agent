import assert from "node:assert/strict";
import test from "node:test";

import {
  legacyCatalogueDefinitions,
  upsertScheduledIngestedJob
} from "./ingested-job-upsert.js";

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

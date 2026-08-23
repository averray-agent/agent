import test from "node:test";
import assert from "node:assert/strict";

import {
  projectExternalPostingClaimability,
  sweepExternalPostingClaimability
} from "./external-posting-claimability.js";

const CURRENT_ESCROW = "0xC2Eb191FB75246667226a5D5Db9d821f95a5f793";
const LEGACY_ESCROW = "0x590EbE304E0C7672e2abF3161177D2B94a2aC3fC";

function externalJob(id, lifecycle = { status: "open", state: "open" }) {
  return {
    id,
    source: { type: "external" },
    lifecycle,
    claimState: "open",
    effectiveState: "claimable",
    claimable: true,
    currentWalletCanClaim: true,
    reason: "claimable",
    claimStatus: { claimState: "open", claimable: true, reason: "claimable" }
  };
}

test("legacy external posting sweep counts every open generation and marks only legacy escrow unclaimable", async () => {
  const legacy = externalJob("0x158d074f71c4f15a7d53305084854ad01bbea36b412ee7eba6471b1dbca5090f");
  const current = externalJob("current-open");
  const archived = externalJob("legacy-archived", { status: "archived", state: "archived" });
  const reads = [];
  const blockchainGateway = {
    config: {
      escrowCoreAddress: CURRENT_ESCROW,
      legacyEscrowCoreAddress: LEGACY_ESCROW
    },
    isEnabled: () => true,
    async getJobs(jobIds) {
      reads.push([...jobIds]);
      return jobIds.map((jobId) => ({
        status: "fulfilled",
        value: {
          state: 1,
          escrowAddress: jobId === legacy.id ? LEGACY_ESCROW : CURRENT_ESCROW
        }
      }));
    }
  };

  const sweep = await sweepExternalPostingClaimability({
    jobs: [legacy, current, archived, { id: "curated", source: { type: "github_issue" } }],
    blockchainGateway
  });

  assert.deepEqual(reads, [[legacy.id, "current-open"]]);
  assert.equal(sweep.candidateCount, 2);
  assert.equal(sweep.legacyUnclaimableCount, 1);
  assert.equal(sweep.observations.has(archived.id), false);

  const legacyListing = projectExternalPostingClaimability(legacy, sweep.observations.get(legacy.id));
  assert.equal(legacyListing.escrowGeneration, "legacy");
  assert.equal(legacyListing.legacyPostingUnclaimable, true);
  assert.equal(legacyListing.claimable, false);
  assert.equal(legacyListing.effectiveState, "unclaimable");
  assert.equal(legacyListing.reason, "legacy_posting_unclaimable");
  assert.equal(legacyListing.claimStatus.reason, "legacy_posting_unclaimable");

  const currentListing = projectExternalPostingClaimability(current, sweep.observations.get(current.id));
  assert.equal(currentListing.escrowGeneration, "current");
  assert.equal(currentListing.legacyPostingUnclaimable, false);
  assert.equal(currentListing.claimable, true);
  assert.equal(currentListing.effectiveState, "claimable");
});

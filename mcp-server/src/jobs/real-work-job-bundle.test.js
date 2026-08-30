import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { summarizeJobClaimState } from "../core/claim-state.js";
import { isExternalJob } from "../core/external-job-lifecycle.js";
import { normalizeJobInput } from "../core/job-catalog-normalization.js";
import { getBuiltinJobSchema, validateStructuredSubmission } from "../core/job-schema-registry.js";
import { buildAverrayDisclosureFooter } from "../core/maintainer-surface-policy.js";
import { PlatformService } from "../core/platform-service.js";
import { MemoryStateStore } from "../core/state-store.js";
import { normalizeSubmission } from "../core/submission.js";
import { VerifierRegistry } from "../services/verifier-handlers.js";

const bundlePath = fileURLToPath(new URL("../../../docs/real-work-jobs.json", import.meta.url));
const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
const jobs = bundle.jobs.map((job) => normalizeJobInput(job));
const CLAIMANT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CLAIM_SESSION = "real-work-session-001";

test("ratified real-work bundle is three funded-together Hub 1337 jobs on existing schemas", async () => {
  assert.equal(bundle.schemaVersion, "averray.real-work-job-bundle.v1");
  assert.equal(bundle.network.chainId, 420420419);
  assert.equal(bundle.network.asset, "USDC");
  assert.equal(bundle.network.assetId, 1337);
  assert.equal(bundle.jobs.length, 3);
  assert.equal(bundle.funding.rewardPerJob, 2);
  assert.equal(bundle.funding.rewardTotal, 6);
  assert.equal(bundle.funding.brokeredGasBudget, 0.18);
  assert.equal(bundle.funding.requiredBankBalance, 6.18);
  assert.ok(bundle.funding.ratifiedBankBalance >= bundle.funding.requiredBankBalance);
  assert.equal(bundle.jobs.reduce((total, job) => total + job.rewardAmount, 0), 6);

  const platform = new PlatformService([], new Map(), new Map(), new Map(), undefined, new MemoryStateStore());
  for (const [index, job] of jobs.entries()) {
    assert.equal(job.rewardAsset, "USDC", job.id);
    assert.equal(job.rewardAmount, 2, job.id);
    assert.equal(bundle.jobs[index].onboardingWaiverEligible, false, job.id);
    assert.equal(job.onboardingWaiverEligible, undefined, job.id);
    assert.equal(job.requiresSponsoredGas, true, job.id);
    assert.equal(isExternalJob(job), false, job.id);
    assert.ok(getBuiltinJobSchema(job.inputSchemaRef), `${job.id} input schema must already exist`);
    assert.ok(getBuiltinJobSchema(job.outputSchemaRef), `${job.id} output schema must already exist`);

    const claimStatus = summarizeJobClaimState({
      job,
      wallet: CLAIMANT,
      rewardBank: {
        asset: "USDC",
        decimals: 6,
        liquidRaw: "50275000",
        readable: true,
        asOf: "2026-08-30T00:00:00.000Z"
      }
    });
    assert.equal(claimStatus.claimable, true, job.id);

    const served = await platform.addListingSecurityMetadata(job);
    assert.equal(served.contentTrust, "operator-curated", job.id);
    assert.equal(served.provenance.posterTier, "operator-curated", job.id);
    assert.equal(served.provenance.postingRoute, "curated", job.id);
  }
});

test("GitHub PR job rejects a submission with no PR", async () => {
  const job = jobs[0];
  const verdict = await new VerifierRegistry({ githubToken: "" }).evaluate(
    job,
    normalizeSubmission({ summary: "Implemented the accessibility change.", tests: "npm test passed" }),
    { claimantWallet: CLAIMANT, claimSessionId: CLAIM_SESSION }
  );

  assert.equal(verdict.outcome, "rejected");
  assert.equal(verdict.reasonCode, "GITHUB_PR_EVIDENCE_INCOMPLETE");
  assert.equal(verdict.checks.prUrlValid, false);
});

test("GitHub PR job accepts a live matching PR bound to the claimant", async () => {
  const job = jobs[0];
  const submission = {
    prUrl: "https://github.com/TricklePay/tricklepay-frontend/pull/201",
    summary: "Names every icon-only action for assistive technology.",
    tests: "npm run lint, npm run typecheck, npm test, and npm run build passed"
  };
  validateStructuredSubmission(job.outputSchemaRef, submission);

  const verdict = await githubRegistry({ issueNumber: 165 }).evaluate(
    job,
    normalizeSubmission(submission),
    { claimantWallet: CLAIMANT, claimSessionId: CLAIM_SESSION }
  );

  assert.equal(verdict.outcome, "approved");
  assert.equal(verdict.checks.claimantBinding, true);
});

test("open-data job rejects missing pinned evidence and a resource that does not fetch", async () => {
  const job = jobs[1];
  const base = validOpenDataSubmission();
  const deficient = { ...base };
  delete deficient.resource_url;

  const missing = await new VerifierRegistry({ fetchImpl: async () => okResponse() }).evaluate(
    job,
    normalizeSubmission(deficient)
  );
  assert.equal(missing.outcome, "rejected");

  const unreachable = await new VerifierRegistry({
    fetchImpl: async (url) => String(url) === job.source.resourceUrl
      ? { ok: false, status: 404, body: { async cancel() {} } }
      : okResponse()
  }).evaluate(job, normalizeSubmission(base));
  assert.equal(unreachable.outcome, "rejected");
  assert.equal(unreachable.reasonCode, "DETERMINISTIC_FETCH_EVIDENCE_UNREACHABLE");
});

test("open-data job accepts schema-valid evidence only after both pinned URLs fetch", async () => {
  const job = jobs[1];
  const submission = validOpenDataSubmission();
  validateStructuredSubmission(job.outputSchemaRef, submission);
  const fetched = [];
  const verdict = await new VerifierRegistry({
    fetchImpl: async (url) => {
      fetched.push(String(url));
      return okResponse();
    }
  }).evaluate(job, normalizeSubmission(submission));

  assert.equal(verdict.outcome, "approved");
  assert.equal(verdict.reasonCode, "DETERMINISTIC_FETCH_EVIDENCE_VERIFIED");
  assert.deepEqual(fetched, [job.source.datasetUrl, job.source.resourceUrl]);
});

test("patch job rejects a real matching PR when live tests fail", async () => {
  const job = jobs[2];
  const submission = validPatchSubmission();
  validateStructuredSubmission(job.outputSchemaRef, submission);

  const verdict = await githubRegistry({ issueNumber: 136, checksPassing: false }).evaluate(
    job,
    normalizeSubmission(submission),
    { claimantWallet: CLAIMANT, claimSessionId: CLAIM_SESSION }
  );

  assert.equal(verdict.outcome, "rejected");
  assert.equal(verdict.githubLookup.ciStatus, "failing");
  assert.match(verdict.detail, /live GitHub checks must pass/u);
});

test("patch job accepts the same submission when live tests pass", async () => {
  const job = jobs[2];
  const verdict = await githubRegistry({ issueNumber: 136, checksPassing: true }).evaluate(
    job,
    normalizeSubmission(validPatchSubmission()),
    { claimantWallet: CLAIMANT, claimSessionId: CLAIM_SESSION }
  );

  assert.equal(verdict.outcome, "approved");
  assert.equal(verdict.score, 90);
  assert.equal(verdict.checks.checksPassing, true);
});

function validOpenDataSubmission() {
  return {
    dataset_title: bundle.jobs[1].source.datasetTitle,
    dataset_url: bundle.jobs[1].source.datasetUrl,
    resource_url: bundle.jobs[1].source.resourceUrl,
    resource_format: "CSV",
    checks: [{ name: "reachability", status: "pass", evidence: "Both pinned URLs returned HTTP 200." }],
    findings: [{
      severity: "low",
      issue: "The catalog does not explain the categorical thresholds.",
      evidence: "Site_WVAL_Category is present without threshold metadata in the CSV.",
      recommendation: "Link the category threshold definition from the catalog record."
    }],
    no_issue_found: false,
    summary: "The CDC resource is reachable and structured, with one metadata clarity finding.",
    recommended_actions: ["Link category threshold documentation from Data.gov."]
  };
}

function validPatchSubmission() {
  return {
    summary: "Adds regression coverage for the disconnected wallet button.",
    output: "PR https://github.com/TricklePay/tricklepay-frontend/pull/202; npm test passed.",
    status: "complete",
    filesChanged: ["components/wallet-button.test.tsx"]
  };
}

function githubRegistry({ issueNumber, checksPassing = true }) {
  const footer = buildAverrayDisclosureFooter({
    agentWallet: CLAIMANT,
    claimSessionId: CLAIM_SESSION
  });
  return new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: async (url) => {
      if (/\/pulls\/20[12]$/u.test(url)) {
        return jsonResponse({
          html_url: url.replace("api.github.com/repos/", "github.com/").replace("/pulls/", "/pull/"),
          title: `Complete issue #${issueNumber}`,
          body: `Closes #${issueNumber}\n\n${footer}`,
          state: "open",
          merged: false,
          head: { sha: "abc123" }
        });
      }
      if (url.endsWith("/commits/abc123/status")) {
        return jsonResponse({ state: checksPassing ? "success" : "failure" });
      }
      if (url.endsWith("/commits/abc123/check-runs")) {
        return jsonResponse({
          check_runs: [{
            status: "completed",
            conclusion: checksPassing ? "success" : "failure"
          }]
        });
      }
      if (/\/pulls\/20[12]\/reviews$/u.test(url)) return jsonResponse([]);
      return { ok: false, status: 404, async json() { return {}; } };
    }
  });
}

function okResponse() {
  return { ok: true, status: 200, body: { async cancel() {} } };
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload;
    }
  };
}

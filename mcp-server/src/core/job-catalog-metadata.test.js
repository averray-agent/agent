import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";

import {
  JobCatalogService,
  ROLE_REQUIREMENTS,
  roleRequirements,
  summarizeRoleGate
} from "./job-catalog-service.js";
import { buildExternalSchemaRegistrationMessage } from "./job-schema-registry.js";
import { PlatformService } from "./platform-service.js";
import { MemoryStateStore } from "./state-store.js";
import { BOOTSTRAP_JOBS } from "../services/bootstrap-jobs.js";
import { GithubIssueIngestionScheduler } from "../services/github-issue-ingestion-scheduler.js";
import { toPlatformJob } from "../jobs/ingest-github-issues.js";
import { upsertScheduledIngestedJob } from "../services/ingested-job-upsert.js";
import { createJobsFromImportResult } from "../protocols/http/admin-job-import-routes.js";

function durableCatalogue(store = new MemoryStateStore()) {
  return new PlatformService(structuredClone(BOOTSTRAP_JOBS), new Map(), new Map(), new Map(), undefined, store);
}

const DURABLE_ISSUE = {
  title: "Add tests for parser validation error", body: "Add a regression test for the invalid parser edge case.",
  number: 42, html_url: "https://github.com/example/project/issues/42",
  repository_url: "https://api.github.com/repos/example/project",
  labels: [{ name: "good first issue" }, { name: "help wanted" }, { name: "tests" }], comments: 2, locked: false
};
function durableIngest(platform) {
  return new GithubIssueIngestionScheduler(platform, undefined, { enabled: true, dryRun: false,
    queries: ["is:issue is:open"], minScore: 55, logger: { warn() {}, info() {} },
    fetchImpl: async () => Response.json({ items: [DURABLE_ISSUE] }) });
}

test("catalogue retirement tombstone survives restart and an ingest tick rediscovering the upstream", async () => {
  const store = new MemoryStateStore();
  const service = durableCatalogue(store);
  const input = toPlatformJob(DURABLE_ISSUE);
  await upsertScheduledIngestedJob(service, input);
  assert.equal((await store.listCatalogueMutations()).length, 0);
  await service.updateJobLifecycle(input.id, { action: "archive", reason: "upstream_closed:completed" });
  assert.equal((await store.listCatalogueMutations())[0].definition, undefined);
  const restarted = durableCatalogue(store);
  await restarted.hydrateCatalogue();
  const summary = await durableIngest(restarted).runOnce();
  assert.equal(summary.createdCount, 0);
  assert.equal(summary.skipped[0].reason, "catalogue_job_retired");
  assert.deepEqual(summary.errors, []);
  assert.equal(restarted.listJobs().some(({ id }) => id === input.id), false);
  await assert.rejects(upsertScheduledIngestedJob(restarted, { ...input, id: "new-id-same-upstream" }),
    { code: "catalogue_job_retired" });
  await restarted.updateJobLifecycle(input.id, { action: "reopen" });
  assert.equal((await durableIngest(restarted).runOnce()).createdCount, 1);
});

test("hydration plus normal ingest has one row per job and does not persist scheduled definitions", async () => {
  const store = new MemoryStateStore();
  const first = durableCatalogue(store);
  const operator = { ...BASE_JOB, id: "operator-import" };
  assert.equal((await createJobsFromImportResult(first, [operator])).created.length, 1);
  await durableIngest(first).runOnce();
  const second = durableCatalogue(store);
  await second.hydrateCatalogue();
  await second.hydrateCatalogue();
  await durableIngest(second).runOnce();
  await durableIngest(second).runOnce();
  const ids = second.jobs.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.filter((id) => id === toPlatformJob(DURABLE_ISSUE).id).length, 1);
  assert.deepEqual((await store.listCatalogueMutations()).map(({ jobId }) => jobId), [operator.id]);
});

test("operator updates and lifecycle overrides persist while failed writes are not acknowledged", async () => {
  const store = new MemoryStateStore();
  const service = durableCatalogue(store);
  await service.createAdminJob({ ...BASE_JOB, id: "operator-update" });
  await service.upsertIngestedJob({ ...BASE_JOB, id: "operator-update", rewardAmount: 2 });
  await service.updateJobLifecycle("operator-update", { action: "pause" });
  const restarted = durableCatalogue(store);
  await restarted.hydrateCatalogue();
  assert.equal(restarted.getJobDefinition("operator-update").rewardAmount, 2);
  assert.equal(restarted.getJobDefinition("operator-update").lifecycle.status, "paused");
  store.putCatalogueMutation = async () => { throw new Error("store unavailable"); };
  await assert.rejects(restarted.updateJobLifecycle("operator-update", { action: "reopen" }), /store unavailable/);
  assert.equal(restarted.getJobDefinition("operator-update").lifecycle.status, "paused");
  await assert.rejects(restarted.createAdminJob({ ...BASE_JOB, id: "failed-create" }), /store unavailable/);
  assert.throws(() => restarted.getJobDefinition("failed-create"), { code: "job_not_found" });
});

test("three ordinary two-USDC operator postings and their hydration reserve zero funds", async () => {
  const store = new MemoryStateStore();
  const service = durableCatalogue(store);
  let reserves = 0;
  service.accountMutationService.reserveRecurringTemplateFunding = async () => { reserves += 1; };
  for (let i = 0; i < 3; i++) await service.createAdminJob({ ...BASE_JOB, id: `ordinary-${i}`,
    rewardAsset: "USDC", rewardAmount: 2 });
  const second = durableCatalogue(store);
  second.accountMutationService.reserveRecurringTemplateFunding = async () => { reserves += 1; };
  await second.hydrateCatalogue();
  assert.equal(reserves, 0);
});

test("a retirement during an ingest chain read wins over the delayed write", async () => {
  const service = durableCatalogue();
  const input = toPlatformJob(DURABLE_ISSUE);
  await service.upsertIngestedJob(input);
  let releaseRead;
  service.blockchainGateway = { isEnabled: () => true,
    getJob: () => new Promise((resolve) => { releaseRead = resolve; }) };
  const updating = service.upsertIngestedJob(input);
  await service.updateJobLifecycle(input.id, { action: "archive" });
  releaseRead({ state: 0 });
  await assert.rejects(updating, { code: "catalogue_job_retired" });
  assert.equal(service.getJobDefinition(input.id).lifecycle.status, "archived");
});

test("admin-posted catalogue job survives restart and hydration byte-for-byte without reserving again", async () => {
  const store = new MemoryStateStore();
  const service = durableCatalogue(store);
  const created = await service.createAdminJob({ ...BASE_JOB, id: "operator-durable-job" });
  const restarted = durableCatalogue(store);
  assert.throws(() => restarted.getJobDefinition(created.id), { code: "job_not_found" });
  restarted.reserveRecurringTemplateFunding = () => { throw new Error("hydration must not reserve"); };
  await restarted.hydrateCatalogue();
  assert.deepEqual(restarted.getJobDefinition(created.id), service.getJobDefinition(created.id));
});

function makeService(reputation = { skill: 0, reliability: 0, economic: 0, tier: "starter" }) {
  const jobs = [];
  const profiles = new Map();
  const account = async () => ({ liquid: { DOT: 100 } });
  const getReputation = async () => reputation;
  const bps = async () => 500;
  return new JobCatalogService(jobs, profiles, account, getReputation, bps);
}

const BASE_JOB = {
  id: "github-issue-review-001",
  category: "coding",
  tier: "starter",
  rewardAmount: 1,
  verifierMode: "benchmark",
  verifierTerms: ["github", "tests", "pr"],
  verifierMinimumMatches: 2,
  inputSchemaRef: "schema://jobs/coding-input",
  outputSchemaRef: "schema://jobs/coding-output",
  claimTtlSeconds: 3600,
  retryLimit: 1
};

const EXTERNAL_SCHEMA_SIGNER = new Wallet("0x8b3a350cf5c34c9194ca3a545d0ec67d61f328d6e5d11dd95b9af16e70ec4c63");

async function signedExternalSchemaRegistration(schemaRef = "schema://jobs/external-review-output") {
  const base = {
    schemaRef,
    schemaUrl: "https://schemas.example.com/jobs/external-review-output.json",
    schema: {
      $id: schemaRef,
      type: "object",
      additionalProperties: false,
      required: ["summary", "result"],
      properties: {
        summary: { type: "string", minLength: 1 },
        result: { type: "string", enum: ["pass", "fail"] }
      }
    },
    issuer: EXTERNAL_SCHEMA_SIGNER.address,
    signedAt: "2026-05-23T00:00:00.000Z"
  };
  return {
    ...base,
    signature: await EXTERNAL_SCHEMA_SIGNER.signMessage(buildExternalSchemaRegistrationMessage(base))
  };
}

test("createJob preserves autonomous work metadata", () => {
  const service = makeService();
  const job = service.createJob({
    ...BASE_JOB,
    title: "Audit and report on parser regression coverage",
    description: "GitHub issue context goes here.",
    jobType: "review",
    requiredRole: "reviewer",
    source: {
      type: "github_issue",
      repo: "example/project",
      issueNumber: 123,
      issueUrl: "https://github.com/example/project/issues/123",
      labels: ["good first issue", "tests"],
      score: 88
    },
    acceptanceCriteria: ["Describe a focused proposed change", "Report the relevant tests"],
    estimatedDifficulty: "starter",
    agentInstructions: ["Keep the recommendation narrow."],
    verification: {
      method: "benchmark",
      signals: ["issue_reviewed", "proposed_change_reported", "validation_plan_reported"]
    }
  });

  assert.equal(job.title, "Audit and report on parser regression coverage");
  assert.equal(job.jobType, "review");
  assert.equal(job.requiredRole, "reviewer");
  assert.equal(job.source.repo, "example/project");
  assert.deepEqual(job.acceptanceCriteria, ["Describe a focused proposed change", "Report the relevant tests"]);
  assert.equal(job.verification.method, "benchmark");
});

test("jobs default to worker work when role fields are omitted", () => {
  const service = makeService();
  const job = service.createJob(BASE_JOB);
  assert.equal(job.jobType, "work");
  assert.equal(job.requiredRole, "worker");
});

test("job lifecycle hides paused, archived, and stale jobs from public discovery", async () => {
  const service = makeService();
  const now = new Date("2026-04-27T10:00:00.000Z");
  const open = service.createJob({
    ...BASE_JOB,
    id: "open-lifecycle-001",
    lifecycle: {
      createdAt: "2026-04-27T09:00:00.000Z",
      updatedAt: "2026-04-27T09:00:00.000Z",
      staleAt: "2026-05-11T09:00:00.000Z"
    }
  });
  service.createJob({
    ...BASE_JOB,
    id: "stale-lifecycle-001",
    lifecycle: {
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      staleAt: "2026-04-15T00:00:00.000Z"
    }
  });

  assert.equal(open.lifecycle.status, "open");
  assert.equal(open.lifecycle.staleAt, "2026-05-11T09:00:00.000Z");
  service.updateJobLifecycle("open-lifecycle-001", { action: "pause", reason: "waiting for provider fix" }, now);

  assert.deepEqual(service.listJobs({ now }).map((job) => job.id), []);
  assert.deepEqual(
    service.listJobs({ includePaused: true, includeStale: true, now }).map((job) => [job.id, job.lifecycle.state]),
    [
      ["stale-lifecycle-001", "stale"],
      ["open-lifecycle-001", "paused"]
    ]
  );

  const preflight = await service.preflightJob("0xagent", "open-lifecycle-001");
  assert.equal(preflight.eligible, false);
  assert.equal(preflight.lifecycle.state, "paused");
});

test("job lifecycle supports archival and claimability guardrails", () => {
  const service = makeService();
  service.createJob({
    ...BASE_JOB,
    id: "archive-lifecycle-001",
    lifecycle: {
      createdAt: "2026-04-27T09:00:00.000Z",
      updatedAt: "2026-04-27T09:00:00.000Z",
      staleAt: "2026-05-11T09:00:00.000Z"
    }
  });

  const archived = service.updateJobLifecycle("archive-lifecycle-001", {
    action: "archive",
    reason: "superseded"
  }, new Date("2026-04-27T10:00:00.000Z"));

  assert.equal(archived.lifecycle.state, "archived");
  assert.throws(
    () => service.getPublicJobDefinition("archive-lifecycle-001"),
    /Unknown job: archive-lifecycle-001/
  );
  const archivedDefinition = service.getPublicJobDefinition("archive-lifecycle-001", { includeArchived: true });
  assert.equal(archivedDefinition.id, "archive-lifecycle-001");
  assert.equal(archivedDefinition.lifecycle.state, "archived");
  assert.throws(
    () => service.getClaimableJobDefinition("archive-lifecycle-001"),
    /not claimable/
  );
  assert.deepEqual(service.getJobLifecycleSummary(), {
    total: 1,
    open: 0,
    claimable: 0,
    stale: 0,
    paused: 0,
    archived: 1
  });
});

test("createJob accepts github_pr verifier configuration", () => {
  const service = makeService();
  const job = service.createJob({
    ...BASE_JOB,
    id: "github-pr-evidence-001",
    verifierMode: "github_pr",
    verifierTerms: undefined,
    outputSchemaRef: "schema://jobs/github-pr-evidence-output",
    verifierMinimumScore: 70
  });

  assert.equal(job.verifierMode, "github_pr");
  assert.equal(job.verifierConfig.handler, "github_pr");
  assert.equal(job.verifierConfig.minimumScore, 70);
});

test("public Wikipedia definitions include direct agent affordances", () => {
  const service = makeService();
  service.createJob({
    ...BASE_JOB,
    id: "wiki-en-123-citation-repair-example",
    title: "Audit and report on Wikipedia citations: Example article",
    category: "wikipedia",
    jobType: "review",
    outputSchemaRef: "schema://jobs/wikipedia-citation-repair-output",
    acceptanceCriteria: ["Names the page and revision.", "Does not edit Wikipedia directly."],
    source: {
      type: "wikipedia_article",
      project: "wikipedia",
      language: "en",
      pageId: 123,
      pageTitle: "Example article",
      pageUrl: "https://en.wikipedia.org/wiki/Example_article",
      revisionId: "987654321",
      taskType: "citation_repair",
      attribution: {
        directEdit: false
      }
    }
  });

  const job = service.getPublicJobDefinition("wiki-en-123-citation-repair-example");

  assert.deepEqual(job.publicDetails, {
    jobId: "wiki-en-123-citation-repair-example",
    source: "wikipedia",
    taskType: "citation_repair",
    pageTitle: "Example article",
    lang: "en",
    revisionId: "987654321",
    articleUrl: "https://en.wikipedia.org/wiki/Example_article",
    pinnedRevisionUrl: "https://en.wikipedia.org/w/index.php?title=Example_article&oldid=987654321",
    acceptanceCriteria: ["Names the page and revision.", "Does not edit Wikipedia directly."],
    outputSchemaRef: "schema://jobs/wikipedia-citation-repair-output",
    outputSchemaUrl: "/schemas/jobs/wikipedia-citation-repair-output.json",
    proposalOnly: true,
    attributionPolicy: "Averray proposal only / no direct Wikipedia edit"
  });
  assert.equal(job.submissionContract.endpoint, "POST /jobs/submit");
  assert.equal(job.submissionContract.validationEndpoint, "POST /jobs/validate-submission");
  assert.equal(job.submissionContract.submissionShape, "direct_schema_object");
  assert.equal(job.submissionContract.structuredSubmissionRequired, true);
  assert.equal(job.submissionContract.schemaValidates, "payload.submission");
  assert.equal(job.submissionContract.doNotWrapInOutput, true);
  assert.deepEqual(job.submissionContract.compatibilityAliases, ["payload.submission.output"]);
  assert.equal(job.submissionContract.submitPayloadExample.sessionId, "<session-id>");
  assert.deepEqual(Object.keys(job.submissionContract.submitPayloadExample.submission), [
    "page_title",
    "revision_id",
    "citation_findings",
    "proposed_changes",
    "review_notes"
  ]);
  assert.equal(job.submissionContract.submitPayloadExample.submission.page_title, "Example article");
  assert.equal(job.schemaContract.output.validationEndpoint, "POST /jobs/validate-submission");
  assert.equal(job.schemaContract.output.validates, "payload.submission");
  assert.equal(job.verificationContract.version, "verification-contract-v1");
  assert.equal(job.verificationContract.verifierMode, "benchmark");
  assert.equal(job.verificationContract.handler, "benchmark");
  assert.equal(job.verificationContract.verifierPolicyVersion, 1);
  assert.equal(job.verificationContract.verifierConfigVersion, 1);
  assert.equal(job.verificationContract.replayEndpoint, "POST /verifier/replay");
  assert.equal(typeof job.verificationContract.verifierConfigHash, "string");
});

test("createJob exposes signed external schema contracts with trust metadata", async () => {
  const service = makeService();
  const registration = await signedExternalSchemaRegistration();
  const job = service.createJob({
    ...BASE_JOB,
    id: "external-schema-review-001",
    outputSchemaRef: registration.schemaRef,
    schemaTrustPolicy: {
      trustedIssuers: [EXTERNAL_SCHEMA_SIGNER.address]
    },
    schemaRegistrations: [registration]
  });

  assert.equal(job.schemaRegistrations[0].schemaRef, registration.schemaRef);
  assert.equal(job.schemaRegistrations[0].trusted, true);
  const publicJob = service.getPublicJobDefinition("external-schema-review-001");
  assert.equal(publicJob.submissionContract.registeredSchema, true);
  assert.equal(publicJob.submissionContract.outputSchemaUrl, registration.schemaUrl);
  assert.equal(publicJob.submissionContract.schemaIssuer, EXTERNAL_SCHEMA_SIGNER.address);
  assert.equal(publicJob.submissionContract.trustBoundary, "external_signed_schema");
  assert.equal(publicJob.schemaContract.output.knownBuiltin, false);
  assert.equal(publicJob.schemaContract.output.registered, true);
  assert.equal(publicJob.schemaContract.output.trusted, true);
  assert.equal(publicJob.schemaContract.output.signatureVerified, true);
});

test("reviewer role gate blocks low-score agents", async () => {
  const service = makeService({ skill: 60, reliability: 0, economic: 0, tier: "starter" });
  service.createJob({
    ...BASE_JOB,
    jobType: "review",
    requiredRole: "reviewer"
  });

  const preflight = await service.preflightJob("0xagent", BASE_JOB.id);
  assert.equal(preflight.eligible, false);
  assert.equal(preflight.roleGate.role, "reviewer");
  assert.deepEqual(preflight.roleGate.missing, { skill: 40 });
});

test("ROLE_REQUIREMENTS exposes autonomy unlock thresholds", () => {
  assert.deepEqual(ROLE_REQUIREMENTS, {
    worker: { skill: 0 },
    curator: { skill: 50 },
    reviewer: { skill: 100 },
    publisher: { skill: 200 },
    verifier: { skill: 300 },
    arbitrator: { skill: 500 }
  });
  assert.deepEqual(roleRequirements("publisher"), { skill: 200 });
  assert.equal(summarizeRoleGate("curator", { skill: 75 }).unlocked, true);
  assert.deepEqual(summarizeRoleGate("verifier", { skill: 225 }).missing, { skill: 75 });
});

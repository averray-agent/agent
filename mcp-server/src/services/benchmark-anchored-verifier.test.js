import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildJobSnapshot } from "../core/job-snapshot.js";
import { normalizeJobInput } from "../core/job-catalog-normalization.js";
import { MemoryStateStore } from "../core/state-store.js";
import { normalizeSubmission } from "../core/submission.js";
import { transitionSession } from "../core/session-state-machine.js";
import { toPlatformJob } from "../jobs/ingest-wikipedia-maintenance.js";
import {
  BenchmarkEvidenceUnavailableError,
  VerifierRegistry
} from "./verifier-handlers.js";
import { VerifierService } from "./verifier-service.js";

const REVISION_ID = "987654321";
const EVIDENCE_URL = "https://reliable.example/archive/source-1";
const SOURCE_URL = "https://reliable.example/source-2";
const SOURCE_QUOTE = "The archive records the citation exactly as published.";

function anchoredJob() {
  return normalizeJobInput(toPlatformJob({
    language: "en",
    pageId: 123,
    title: "Anchored article",
    pageUrl: "https://en.wikipedia.org/wiki/Anchored_article",
    revisionId: REVISION_ID,
    revisionTimestamp: "2026-08-21T09:00:00Z",
    categoryTitle: "Category:All articles with dead external links",
    taskType: "citation_repair",
    templates: ["Template:Dead link"]
  }, 88));
}

function anchoredSubmission(overrides = {}) {
  const base = {
    page_title: "Anchored article",
    revision_id: REVISION_ID,
    citation_findings: [{
      section: "Lead",
      problem: "dead_link",
      current_claim: "The article makes an archived claim.",
      source_quote: SOURCE_QUOTE,
      evidence_url: EVIDENCE_URL
    }],
    proposed_changes: [{
      change_type: "replace_citation",
      target_text: "Old citation",
      replacement_text: "Archived citation",
      source_url: SOURCE_URL
    }],
    review_notes: "Proposal only."
  };
  return { ...base, ...overrides };
}

function revisionFetch(wikitext) {
  return async (url) => {
    assert.equal(url.hostname, "en.wikipedia.org");
    assert.equal(url.searchParams.get("revids"), REVISION_ID);
    assert.equal(url.searchParams.get("rvslots"), "main");
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          query: {
            pages: [{
              revisions: [{
                revid: Number(REVISION_ID),
                slots: { main: { content: wikitext } }
              }]
            }]
          }
        };
      }
    };
  };
}

const PINNED_WIKITEXT = [
  "Lead text.",
  `  ${SOURCE_QUOTE.replaceAll(" ", "   ")}  `,
  EVIDENCE_URL,
  SOURCE_URL
].join("\n");

test("new-posting verification passes when every quote and URL appears in pinned wikitext (anchor-check mutation guard)", async () => {
  const verdict = await new VerifierRegistry({
    fetchImpl: revisionFetch(PINNED_WIKITEXT)
  }).evaluate(anchoredJob(), anchoredSubmission());

  assert.equal(verdict.outcome, "approved");
  assert.equal(verdict.reasonCode, "BENCHMARK_REVISION_ANCHORS_MET");

  const source = readFileSync(new URL("./verifier-handlers.js", import.meta.url), "utf8");
  assertAnchoredBenchmarkCheck(source);
  const anchor = "      return evaluateWikipediaRevisionAnchors({";
  const mutated = source.replace(anchor, "      return thresholdVerdict; /* anchor check removed */\n      evaluateWikipediaRevisionAnchors({");
  assert.notEqual(mutated, source, "anchor-check mutation must apply");
  assert.throws(
    () => assertAnchoredBenchmarkCheck(mutated),
    /new benchmark postings must execute the revision anchor check/u
  );
});

test("new-posting verification fails when one word in a quoted finding is altered", async () => {
  const submission = anchoredSubmission();
  submission.citation_findings[0].source_quote = SOURCE_QUOTE.replace("exactly", "approximately");
  const verdict = await new VerifierRegistry({
    fetchImpl: revisionFetch(PINNED_WIKITEXT)
  }).evaluate(anchoredJob(), submission);

  assert.equal(verdict.outcome, "rejected");
  assert.equal(verdict.reasonCode, "BENCHMARK_REVISION_ANCHOR_MISMATCH");
  assert.match(verdict.detail, /citation_findings\[0\]\.source_quote/u);
});

test("new-posting verification rejects a fabricated URL absent from the pinned revision", async () => {
  const submission = anchoredSubmission();
  submission.proposed_changes[0].source_url = "https://fabricated.example/not-in-revision";
  const verdict = await new VerifierRegistry({
    fetchImpl: revisionFetch(PINNED_WIKITEXT)
  }).evaluate(anchoredJob(), submission);

  assert.equal(verdict.outcome, "rejected");
  assert.equal(verdict.reasonCode, "BENCHMARK_REVISION_ANCHOR_MISMATCH");
  assert.match(verdict.detail, /proposed_changes\[0\]\.source_url/u);
});

test("already-posted benchmark job verification remains byte-identical", async () => {
  const legacyJob = {
    id: "legacy-wikipedia-citation-job",
    outputSchemaRef: "schema://jobs/wikipedia-citation-repair-output",
    verifierMode: "benchmark",
    verifierConfig: {
      version: 1,
      handler: "benchmark",
      requiredKeywords: [
        "Anchored article",
        REVISION_ID,
        `https://en.wikipedia.org/w/index.php?title=Anchored_article&oldid=${REVISION_ID}`
      ],
      minimumMatches: 2
    }
  };
  const verdict = await new VerifierRegistry({
    fetchImpl: async () => { throw new Error("legacy verification must not fetch"); }
  }).evaluate(legacyJob, {
    page_title: "Anchored article",
    revision_id: REVISION_ID,
    citation_findings: [],
    proposed_changes: [],
    review_notes: "Legacy evidence."
  });

  assert.equal(JSON.stringify(verdict), JSON.stringify({
    jobId: "legacy-wikipedia-citation-job",
    handler: "benchmark",
    handlerVersion: 2,
    outcome: "approved",
    score: 67,
    reasonCode: "BENCHMARK_THRESHOLD_MET",
    detail: "Matched 2/3 substantive required keywords."
  }));
});

test("pinned-revision fetch failure is retryable and leaves the worker unharmed", async () => {
  const stateStore = new MemoryStateStore();
  const job = anchoredJob();
  const sessionId = "anchored-fetch-unavailable-session";
  const claimed = transitionSession({
    sessionId,
    wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    jobId: job.id,
    submission: normalizeSubmission(anchoredSubmission()),
    jobSnapshot: buildJobSnapshot(job)
  }, "claimed", { reason: "job_claimed" });
  await stateStore.upsertSession(transitionSession(claimed, "submitted", { reason: "work_submitted" }));
  let ingestCalls = 0;
  const service = new VerifierService(
    {
      resumeSession: (id) => stateStore.getSession(id),
      async ingestVerification() { ingestCalls += 1; }
    },
    stateStore,
    undefined,
    new VerifierRegistry({
      fetchImpl: async () => ({ ok: false, status: 503 })
    })
  );

  await assert.rejects(
    () => service.verifySubmission({ sessionId }),
    (error) => {
      assert.equal(error instanceof BenchmarkEvidenceUnavailableError, true);
      assert.equal(error.code, "BENCHMARK_PINNED_REVISION_UNAVAILABLE");
      assert.equal(error.outcome, "inconclusive");
      assert.equal(error.workerConsequence, "none");
      return true;
    }
  );
  assert.equal((await stateStore.getSession(sessionId)).status, "submitted");
  assert.equal(await stateStore.getVerificationResult(sessionId), undefined);
  assert.equal(ingestCalls, 0);
});

function assertAnchoredBenchmarkCheck(source) {
  assert.match(
    source,
    /return evaluateWikipediaRevisionAnchors\(\{[\s\S]*thresholdVerdict,[\s\S]*fetchImpl/u,
    "new benchmark postings must execute the revision anchor check"
  );
}

import test from "node:test";
import assert from "node:assert/strict";

import {
  ingestWikipediaMaintenance,
  scoreArticle,
  toPlatformJob
} from "./ingest-wikipedia-maintenance.js";

const ARTICLE = {
  language: "en",
  pageId: 123,
  title: "Example article",
  pageUrl: "https://en.wikipedia.org/wiki/Example_article",
  revisionId: "987654321",
  revisionTimestamp: "2026-04-25T10:00:00Z",
  categoryTitle: "Category:All articles with dead external links",
  taskType: "citation_repair",
  templates: ["Template:Dead link"]
};

test("scoreArticle prefers fixed revisions with maintenance templates", () => {
  assert.ok(scoreArticle(ARTICLE) >= 80);
});

test("toPlatformJob produces an Averray-attributed Wikipedia proposal job", () => {
  const job = toPlatformJob(ARTICLE, 88);

  assert.equal(job.id, "wiki-en-123-citation_repair-example-article");
  assert.equal(job.category, "wikipedia");
  assert.equal(job.jobType, "review");
  assert.equal(job.source.type, "wikipedia_article");
  assert.equal(job.source.lang, "en");
  assert.equal(job.source.articleUrl, "https://en.wikipedia.org/wiki/Example_article");
  assert.equal(
    job.source.pinnedRevisionUrl,
    "https://en.wikipedia.org/w/index.php?title=Example_article&oldid=987654321"
  );
  assert.equal(job.source.proposalOnly, true);
  assert.equal(job.source.outputSchemaUrl, "/schemas/jobs/wikipedia-citation-repair-output.json");
  assert.equal(job.source.attributionPolicy, "Averray proposal only / no direct Wikipedia edit");
  assert.equal(job.source.writePolicy, "averray_company_reviewed_proposal_only");
  assert.equal(job.source.attribution.proposer, "Averray");
  assert.equal(job.source.attribution.directEdit, false);
  assert.equal(job.inputSchemaRef, "schema://jobs/wikipedia-maintenance-input");
  assert.equal(job.outputSchemaRef, "schema://jobs/wikipedia-citation-repair-output");
  assert.ok(job.agentInstructions.some((entry) => entry.includes("Do not edit Wikipedia directly")));
  assert.ok(job.agentInstructions.some((entry) => entry.includes("Averray")));
  assert.deepEqual(job.verification.signals, [
    "page_revision_cited",
    "source_urls_present",
    "proposal_only",
    "averray_attribution",
    "human_review_ready"
  ]);
});

test("ingestWikipediaMaintenance turns category members into jobs", async () => {
  const calls = [];
  const payload = await ingestWikipediaMaintenance({
    language: "en",
    categories: [{ title: "Category:All articles with dead external links", taskType: "citation_repair" }],
    limit: 2,
    minScore: 55,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes("list=categorymembers")) {
        return jsonResponse({
          query: {
            categorymembers: [
              { pageid: 123, ns: 0, title: "Example article" }
            ]
          }
        });
      }
      return jsonResponse({
        query: {
          pages: {
            123: {
              pageid: 123,
              title: "Example article",
              fullurl: "https://en.wikipedia.org/wiki/Example_article",
              revisions: [{ revid: 987654321, timestamp: "2026-04-25T10:00:00Z" }],
              templates: [{ title: "Template:Dead link" }]
            }
          }
        }
      });
    }
  });

  assert.equal(payload.count, 1);
  assert.equal(payload.jobs[0].source.pageId, 123);
  assert.equal(payload.jobs[0].source.revisionId, "987654321");
  assert.ok(calls.every((url) => url.startsWith("https://en.wikipedia.org/w/api.php")));
});

function jsonResponse(payload) {
  return {
    ok: true,
    async json() {
      return payload;
    }
  };
}

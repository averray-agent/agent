import test from "node:test";
import assert from "node:assert/strict";
import { dryRunWikipediaReplenishment } from "./dry-run-wikipedia-replenishment.js";

test("production-observation dry-run uses the scheduler, reads only, and reports its evidence scope", async () => {
  const urls = [];
  const report = await dryRunWikipediaReplenishment({ fetchImpl: async (url, options = {}) => {
    assert.equal(options.method ?? "GET", "GET");
    urls.push(String(url));
    const request = new URL(url);
    const payload = request.pathname === "/jobs"
      ? [{ id: "done", category: "wikipedia", tier: "starter", effectiveState: "exhausted",
        source: { type: "wikipedia_article", language: "en", pageId: 1, revisionId: "100" } }]
      : request.searchParams.has("list")
        ? { query: { categorymembers: [{ pageid: 1 }, { pageid: 2 }] } }
        : { query: { pages: { x: {
          pageid: Number(request.searchParams.get("pageids")), title: request.searchParams.get("pageids") === "1" ? "Already bought" : "Next article",
          revisions: [{ revid: 100 }], templates: [{ title: "Template:Dead link" }]
        } } } };
    return { ok: true, json: async () => payload };
  } });
  assert.equal(report.summary.skipped[0].reason, "completed_cooldown");
  assert.equal(report.summary.selected[0].title, "Next article");
  assert.equal(report.summary.dryRun, true);
  assert.match(report.limitations, /not archived host history/u);
  assert.ok(urls.some((url) => url.includes("categorymembers")));
});

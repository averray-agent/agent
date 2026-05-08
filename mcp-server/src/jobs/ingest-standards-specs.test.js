import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchSpecDetails,
  ingestStandardsSpecs,
  parseSpecs,
  scoreSpecTarget,
  standardsSpecKey,
  toPlatformJob
} from "./ingest-standards-specs.js";

const SPEC = {
  provider: "w3c",
  specId: "vc-data-model-2.0",
  specTitle: "Verifiable Credentials Data Model v2.0",
  specUrl: "https://www.w3.org/TR/vc-data-model-2.0/",
  currentVersion: "2.0",
  expectedStatus: "W3C Recommendation",
  localSurface: "docs/RC1_WORKING_SPEC.md",
  repo: "averray-agent/agent"
};

function makeFetch({ status = 200, ok = true } = {}) {
  return async (url, request) => {
    assert.equal(url, SPEC.specUrl);
    assert.match(request.headers.accept, /text\/html/u);
    return {
      ok,
      status,
      url: `${SPEC.specUrl}?from=test`,
      headers: new Map([
        ["content-type", "text/html; charset=utf-8"],
        ["last-modified", "Mon, 27 Apr 2026 08:00:00 GMT"],
        ["etag", "\"abc123\""]
      ]),
      async text() {
        return `<!doctype html><html><head>
          <title>${SPEC.specTitle}</title>
          <link rel="canonical" href="/TR/vc-data-model-2.0/">
        </head><body></body></html>`;
      }
    };
  };
}

test("parseSpecs accepts JSON and compact line syntax", () => {
  assert.deepEqual(parseSpecs(JSON.stringify([SPEC])), [SPEC]);
  assert.deepEqual(
    parseSpecs("Verifiable Credentials Data Model v2.0|https://www.w3.org/TR/vc-data-model-2.0/|w3c|docs/RC1_WORKING_SPEC.md|W3C Recommendation"),
    [
      {
        provider: "w3c",
        specId: "",
        specTitle: "Verifiable Credentials Data Model v2.0",
        specUrl: "https://www.w3.org/TR/vc-data-model-2.0/",
        currentVersion: "",
        expectedStatus: "W3C Recommendation",
        localSurface: "docs/RC1_WORKING_SPEC.md",
        repo: ""
      }
    ]
  );
});

test("fetchSpecDetails captures canonical metadata", async () => {
  const details = await fetchSpecDetails({ target: SPEC, fetchImpl: makeFetch() });

  assert.equal(details.finalUrl, `${SPEC.specUrl}?from=test`);
  assert.equal(details.canonicalUrl, SPEC.specUrl);
  assert.equal(details.lastModified, "Mon, 27 Apr 2026 08:00:00 GMT");
  assert.equal(details.etag, "\"abc123\"");
  assert.equal(details.contentType, "text/html; charset=utf-8");
});

test("scoreSpecTarget prefers reachable canonical spec audits", async () => {
  const details = await fetchSpecDetails({ target: SPEC, fetchImpl: makeFetch() });

  assert.ok(scoreSpecTarget(details) >= 90);
  assert.ok(scoreSpecTarget({ ...details, ok: false, httpStatus: 404 }) < scoreSpecTarget(details));
});

test("toPlatformJob creates standards freshness audit job", async () => {
  const details = await fetchSpecDetails({ target: SPEC, fetchImpl: makeFetch() });
  const job = toPlatformJob(details, 92);

  assert.equal(job.id, "standards-w3c-vc-data-model-2-0");
  assert.equal(job.category, "docs");
  assert.equal(job.tier, "starter");
  assert.equal(job.rewardAsset, "USDC");
  assert.equal(job.verifierMode, "benchmark");
  assert.equal(job.inputSchemaRef, "schema://jobs/docs-input");
  assert.equal(job.outputSchemaRef, "schema://jobs/docs-drift-audit-output");
  assert.equal(job.source.type, "standards_spec");
  assert.equal(job.source.provider, "w3c");
  assert.equal(job.source.localSurface, "docs/RC1_WORKING_SPEC.md");
  assert.ok(job.verifierTerms.includes("fix_recommendation"));
});

test("standardsSpecKey dedupes by provider, URL, and local surface", () => {
  assert.equal(
    standardsSpecKey({ provider: "W3C", specUrl: SPEC.specUrl, localSurface: "docs/RC1_WORKING_SPEC.md" }),
    "w3c|https://www.w3.org/tr/vc-data-model-2.0/|docs/rc1_working_spec.md"
  );
});

test("ingestStandardsSpecs fetches configured specs and returns jobs", async () => {
  const payload = await ingestStandardsSpecs({
    specs: [SPEC],
    limit: 5,
    minScore: 55,
    fetchImpl: makeFetch()
  });

  assert.equal(payload.provider, "standards");
  assert.equal(payload.specCount, 1);
  assert.equal(payload.count, 1);
  assert.equal(payload.jobs[0].source.specTitle, SPEC.specTitle);
  assert.deepEqual(payload.skipped, []);
});

test("ingestStandardsSpecs reports fetch failures as skipped targets", async () => {
  const payload = await ingestStandardsSpecs({
    specs: [SPEC],
    fetchImpl: async () => {
      throw new Error("network unavailable");
    }
  });

  assert.equal(payload.count, 0);
  assert.equal(payload.skipped[0].reason, "fetch_failed");
  assert.equal(payload.skipped[0].message, "network unavailable");
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  findFixedVersion,
  ingestOsvAdvisories,
  parsePackages,
  queryOsvVulnerability,
  scoreAdvisory,
  toPlatformJob
} from "./ingest-osv-advisories.js";

const TARGET = {
  name: "minimist",
  version: "0.0.8",
  ecosystem: "npm",
  repo: "example/app",
  manifestPath: "package.json"
};

const ADVISORY = {
  id: "GHSA-vh95-rmgr-6w4m",
  aliases: ["CVE-2020-7598"],
  summary: "Prototype pollution in minimist",
  details: "minimist before 1.2.3 allows prototype pollution.",
  published: "2020-03-11T00:00:00Z",
  modified: "2024-01-01T00:00:00Z",
  severity: [{ type: "CVSS_V3", score: "7.5" }],
  references: [
    { type: "ADVISORY", url: "https://osv.dev/vulnerability/GHSA-vh95-rmgr-6w4m" },
    { type: "WEB", url: "https://nvd.nist.gov/vuln/detail/CVE-2020-7598" }
  ],
  affected: [
    {
      package: { ecosystem: "npm", name: "minimist" },
      ranges: [
        {
          type: "SEMVER",
          events: [{ introduced: "0" }, { fixed: "1.2.3" }]
        }
      ]
    }
  ]
};

test("parsePackages accepts JSON and compact line syntax", () => {
  assert.deepEqual(parsePackages(JSON.stringify([TARGET])), [TARGET]);
  assert.deepEqual(parsePackages("minimist@0.0.8|example/app|package.json"), [TARGET]);
});

test("findFixedVersion extracts the first npm fixed release", () => {
  assert.equal(findFixedVersion(ADVISORY, TARGET), "1.2.3");
});

test("findFixedVersion falls back to advisory metadata fixed versions", () => {
  const advisory = {
    ...ADVISORY,
    affected: [
      {
        package: { ecosystem: "npm", name: "minimist" },
        ranges: [{ type: "SEMVER", events: [{ introduced: "0" }] }],
        database_specific: {
          all_fixed_versions: ["1.2.6", "1.2.5"]
        }
      }
    ]
  };

  assert.equal(findFixedVersion(advisory, TARGET), "1.2.5");
});

test("findFixedVersion reads Snyk/root-style advisory fixed metadata", () => {
  const advisory = {
    ...ADVISORY,
    affected: [
      {
        package: { ecosystem: "npm", name: "minimist" },
        ranges: [{ type: "SEMVER", events: [{ introduced: "0" }] }],
        database_specific: {
          upstream_version: "1.2.8-root.io.1"
        }
      }
    ]
  };

  assert.equal(findFixedVersion(advisory, TARGET), "1.2.8-root.io.1");
});

test("scoreAdvisory prefers fixed CVE-backed advisories", () => {
  assert.ok(scoreAdvisory(ADVISORY, { fixedVersion: "1.2.3" }) >= 85);
});

test("toPlatformJob creates a PR-shaped dependency remediation job", () => {
  const job = toPlatformJob({ target: TARGET, advisory: ADVISORY, fixedVersion: "1.2.3", score: 92 });

  assert.equal(job.id, "osv-npm-example-app-minimist-0-0-8-ghsa-vh95-rmgr-6w4m");
  assert.equal(job.category, "security");
  assert.equal(job.verifierMode, "github_pr");
  assert.equal(job.inputSchemaRef, "schema://jobs/dependency-remediation-input");
  assert.equal(job.outputSchemaRef, "schema://jobs/dependency-remediation-output");
  assert.equal(job.source.type, "osv_advisory");
  assert.equal(job.source.provider, "osv");
  assert.equal(job.source.packageName, "minimist");
  assert.equal(job.source.fixedVersion, "1.2.3");
  assert.deepEqual(job.source.cves, ["CVE-2020-7598"]);
  assert.ok(job.source.nvdUrls[0].includes("CVE-2020-7598"));
  assert.ok(job.acceptanceCriteria.some((entry) => entry.includes("package.json")));
  assert.ok(job.agentInstructions.some((entry) => entry.includes("GHSA-vh95-rmgr-6w4m")));
});

test("ingestOsvAdvisories queries OSV and filters jobs", async () => {
  const payload = await ingestOsvAdvisories({
    packages: [TARGET],
    limit: 5,
    minScore: 55,
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      assert.equal(body.queries[0].package.name, "minimist");
      assert.equal(body.queries[0].package.ecosystem, "npm");
      assert.equal(body.queries[0].version, "0.0.8");
      return {
        ok: true,
        async json() {
          return { results: [{ vulns: [ADVISORY] }] };
        }
      };
    }
  });

  assert.equal(payload.count, 1);
  assert.equal(payload.jobs[0].source.advisoryId, "GHSA-vh95-rmgr-6w4m");
  assert.equal(payload.jobs[0].source.vulnerableVersion, "0.0.8");
  assert.equal(payload.skipped.length, 0);
});

test("ingestOsvAdvisories hydrates sparse querybatch advisories before filtering", async () => {
  const urls = [];
  const payload = await ingestOsvAdvisories({
    packages: [TARGET],
    limit: 5,
    minScore: 55,
    fetchImpl: async (url, request = {}) => {
      urls.push(String(url));
      if (request.method === "POST") {
        return {
          ok: true,
          async json() {
            return { results: [{ vulns: [{ id: ADVISORY.id, summary: ADVISORY.summary }] }] };
          }
        };
      }
      return {
        ok: true,
        async json() {
          return ADVISORY;
        }
      };
    }
  });

  assert.equal(payload.count, 1);
  assert.equal(payload.jobs[0].source.fixedVersion, "1.2.3");
  assert.ok(urls.some((url) => url.endsWith(`/vulns/${ADVISORY.id}`)));
});

test("ingestOsvAdvisories skips advisories without a fixed version", async () => {
  const payload = await ingestOsvAdvisories({
    packages: [TARGET],
    fetchImpl: async (_url, request = {}) => {
      const advisory = {
        ...ADVISORY,
        affected: [{ package: { ecosystem: "npm", name: "minimist" }, ranges: [{ events: [{ introduced: "0" }] }] }]
      };
      return {
        ok: true,
        async json() {
          return request.method === "POST"
            ? { results: [{ vulns: [advisory] }] }
            : advisory;
        }
      };
    }
  });

  assert.equal(payload.count, 0);
  assert.equal(payload.skipped[0].reason, "no_fixed_version");
});

test("queryOsvVulnerability fetches the full advisory document", async () => {
  const advisory = await queryOsvVulnerability({
    advisoryId: ADVISORY.id,
    fetchImpl: async (url, request = {}) => {
      assert.equal(String(url), `https://api.osv.dev/v1/vulns/${ADVISORY.id}`);
      assert.equal(request.headers.accept, "application/json");
      return {
        ok: true,
        async json() {
          return ADVISORY;
        }
      }
    }
  });

  assert.equal(advisory.id, ADVISORY.id);
});

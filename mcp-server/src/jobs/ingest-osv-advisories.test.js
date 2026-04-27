import test from "node:test";
import assert from "node:assert/strict";

import {
  collectPackageTargetsFromManifests,
  extractNpmLockfileTargets,
  findFixedVersion,
  ingestOsvAdvisories,
  parseManifests,
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

test("parseManifests accepts JSON and compact line syntax", () => {
  const manifest = { repo: "example/app", manifestPath: "package-lock.json", ref: "main" };
  assert.deepEqual(parseManifests(JSON.stringify([manifest])), [manifest]);
  assert.deepEqual(parseManifests("https://github.com/example/app.git|locks/package-lock.json|release/v1"), [
    { repo: "example/app", manifestPath: "locks/package-lock.json", ref: "release/v1" }
  ]);
});

test("extractNpmLockfileTargets reads npm package-lock v3 packages", () => {
  const targets = extractNpmLockfileTargets({
    source: { repo: "example/app", manifestPath: "package-lock.json", ref: "main" },
    lockfile: {
      packages: {
        "": { name: "app", version: "1.0.0" },
        "node_modules/minimist": { version: "0.0.8" },
        "node_modules/@scope/pkg": { version: "1.2.3" },
        "node_modules/dev-only": { version: "1.0.0", dev: true }
      }
    }
  });

  assert.deepEqual(targets, [
    { name: "minimist", version: "0.0.8", ecosystem: "npm", repo: "example/app", manifestPath: "package-lock.json" },
    { name: "@scope/pkg", version: "1.2.3", ecosystem: "npm", repo: "example/app", manifestPath: "package-lock.json" }
  ]);
});

test("collectPackageTargetsFromManifests fetches GitHub lockfiles and caps targets", async () => {
  const targets = await collectPackageTargetsFromManifests({
    manifests: [{ repo: "example/app", manifestPath: "package-lock.json", ref: "main" }],
    maxPackageTargets: 1,
    fetchImpl: async (url, request = {}) => {
      assert.equal(String(url), "https://raw.githubusercontent.com/example/app/main/package-lock.json");
      assert.equal(request.headers.accept, "application/json");
      return {
        ok: true,
        async json() {
          return {
            packages: {
              "node_modules/minimist": { version: "0.0.8" },
              "node_modules/left-pad": { version: "1.3.0" }
            }
          };
        }
      };
    }
  });

  assert.deepEqual(targets, [
    { name: "minimist", version: "0.0.8", ecosystem: "npm", repo: "example/app", manifestPath: "package-lock.json" }
  ]);
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
  assert.equal(job.tier, "starter");
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

test("ingestOsvAdvisories can derive package targets from GitHub lockfiles", async () => {
  const payload = await ingestOsvAdvisories({
    manifests: [{ repo: "example/app", manifestPath: "package-lock.json", ref: "main" }],
    limit: 5,
    minScore: 55,
    fetchImpl: async (url, request = {}) => {
      if (String(url).includes("raw.githubusercontent.com")) {
        return {
          ok: true,
          async json() {
            return { packages: { "node_modules/minimist": { version: "0.0.8" } } };
          }
        };
      }
      const body = JSON.parse(request.body);
      assert.equal(body.queries[0].package.name, "minimist");
      return {
        ok: true,
        async json() {
          return { results: [{ vulns: [ADVISORY] }] };
        }
      };
    }
  });

  assert.equal(payload.count, 1);
  assert.equal(payload.jobs[0].source.repo, "example/app");
  assert.equal(payload.jobs[0].source.manifestPath, "package-lock.json");
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

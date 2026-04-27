#!/usr/bin/env node

import { pathToFileURL } from "node:url";

/**
 * Ingest OSV package advisories into dependency remediation jobs.
 *
 * The v1 provider is intentionally allowlist-driven: operators provide npm
 * package/version/repo targets, OSV supplies the advisory facts, and Averray
 * emits PR-shaped remediation jobs only when a fixed version is discoverable.
 *
 * Example:
 *   AGENT_ADMIN_TOKEN=... npm run ingest:osv-advisories -- \
 *     --packages '[{"name":"minimist","version":"0.0.8","repo":"example/app"}]' \
 *     --dry-run
 */

export const DEFAULT_BASE_URL = "http://localhost:8787";
export const DEFAULT_ECOSYSTEM = "npm";
export const OSV_QUERY_BATCH_URL = "https://api.osv.dev/v1/querybatch";
export const OSV_VULN_URL = "https://api.osv.dev/v1/vulns";

const ECOSYSTEMS = new Set(["npm"]);

export function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key.includes("=")) {
      const [name, ...rest] = key.split("=");
      parsed[name] = rest.join("=");
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

export async function ingestOsvAdvisories({
  packages = [],
  limit = 10,
  minScore = 55,
  fetchImpl = fetch
} = {}) {
  const targets = parsePackages(packages);
  if (!targets.length) {
    return { ecosystem: DEFAULT_ECOSYSTEM, minScore, count: 0, jobs: [], skipped: [] };
  }

  const results = await queryOsvBatch({ packages: targets, fetchImpl });
  const skipped = [];
  const candidates = [];

  for (const [index, target] of targets.entries()) {
    const vulns = results[index]?.vulns ?? [];
    if (!vulns.length) {
      skipped.push({ package: target.name, version: target.version, reason: "no_vulnerabilities" });
      continue;
    }
    for (const advisory of vulns) {
      const hydratedAdvisory = await hydrateAdvisoryIfNeeded({ advisory, target, fetchImpl });
      const fixedVersion = findFixedVersion(hydratedAdvisory, target);
      const score = scoreAdvisory(hydratedAdvisory, { fixedVersion });
      if (!fixedVersion) {
        skipped.push({ package: target.name, version: target.version, advisoryId: advisory.id, reason: "no_fixed_version" });
        continue;
      }
      if (score < minScore) {
        skipped.push({ package: target.name, version: target.version, advisoryId: advisory.id, reason: "below_min_score", score });
        continue;
      }
      candidates.push({ target, advisory: hydratedAdvisory, fixedVersion, score });
    }
  }

  const jobs = candidates
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ target, advisory, fixedVersion, score }) => toPlatformJob({ target, advisory, fixedVersion, score }));

  if (candidates.length > jobs.length) {
    skipped.push({ reason: "over_limit", count: candidates.length - jobs.length });
  }

  return {
    ecosystem: DEFAULT_ECOSYSTEM,
    minScore,
    count: jobs.length,
    jobs,
    skipped
  };
}

export async function queryOsvBatch({ packages, fetchImpl = fetch }) {
  const response = await fetchImpl(OSV_QUERY_BATCH_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "AverrayOsvIngest/0.1 (https://averray.com; operator@averray.com)"
    },
    body: JSON.stringify({
      queries: packages.map((target) => ({
        version: target.version,
        package: {
          name: target.name,
          ecosystem: target.ecosystem
        }
      }))
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OSV querybatch failed (${response.status}): ${body}`);
  }
  const payload = await response.json();
  return payload.results ?? [];
}

export async function queryOsvVulnerability({ advisoryId, fetchImpl = fetch }) {
  const response = await fetchImpl(`${OSV_VULN_URL}/${encodeURIComponent(advisoryId)}`, {
    headers: {
      accept: "application/json",
      "user-agent": "AverrayOsvIngest/0.1 (https://averray.com; operator@averray.com)"
    }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OSV vulnerability lookup failed (${response.status}): ${body}`);
  }
  return response.json();
}

async function hydrateAdvisoryIfNeeded({ advisory, target, fetchImpl }) {
  if (findFixedVersion(advisory, target) || !advisory?.id) {
    return advisory;
  }
  try {
    return await queryOsvVulnerability({ advisoryId: advisory.id, fetchImpl });
  } catch {
    return advisory;
  }
}

export function parsePackages(raw) {
  const parsed = typeof raw === "string" ? parsePackageString(raw) : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normalizePackageTarget).filter(Boolean);
}

export function scoreAdvisory(advisory, { fixedVersion } = {}) {
  let score = 30;
  const severity = maxCvssScore(advisory);
  if (fixedVersion) score += 30;
  if (severity >= 9) score += 25;
  else if (severity >= 7) score += 20;
  else if (severity >= 4) score += 10;
  if (hasAlias(advisory, "CVE-")) score += 10;
  if (hasAlias(advisory, "GHSA-")) score += 5;
  if (String(advisory.details ?? advisory.summary ?? "").length > 2000) score -= 10;
  return Math.max(0, Math.min(100, score));
}

export function toPlatformJob({ target, advisory, fixedVersion, score = scoreAdvisory(advisory, { fixedVersion }) }) {
  const advisoryId = String(advisory.id ?? "OSV-UNKNOWN");
  const aliases = advisoryAliases(advisory);
  const cves = aliases.filter((alias) => alias.startsWith("CVE-"));
  const references = advisoryReferences(advisory);
  const repo = target.repo ? normalizeRepo(target.repo) : undefined;
  const manifestPath = target.manifestPath ?? "package.json";
  const title = `Remediate ${advisoryId} in ${target.name}`;
  const id = `osv-npm-${slugify(repo ?? "repo")}-${slugify(target.name)}-${slugify(target.version)}-${slugify(advisoryId)}`.slice(0, 120);

  return {
    id,
    title,
    description:
      `Update npm package ${target.name} from vulnerable version ${target.version} to ${fixedVersion} or a newer safe release. Advisory: ${advisoryId}.`,
    jobType: "work",
    requiredRole: "worker",
    category: "security",
    tier: "starter",
    rewardAsset: "DOT",
    rewardAmount: 3,
    verifierMode: "github_pr",
    verifierMinimumScore: 70,
    requireTestEvidence: true,
    inputSchemaRef: "schema://jobs/dependency-remediation-input",
    outputSchemaRef: "schema://jobs/dependency-remediation-output",
    claimTtlSeconds: 7200,
    retryLimit: 1,
    requiresSponsoredGas: true,
    source: {
      type: "osv_advisory",
      provider: "osv",
      ecosystem: target.ecosystem,
      packageName: target.name,
      vulnerableVersion: target.version,
      fixedVersion,
      repo,
      manifestPath,
      advisoryId,
      aliases,
      cves,
      nvdUrls: cves.map((cve) => `https://nvd.nist.gov/vuln/detail/${cve}`),
      summary: String(advisory.summary ?? "").trim(),
      details: summarise(String(advisory.details ?? "")),
      references,
      severity: advisory.severity ?? [],
      published: advisory.published,
      modified: advisory.modified,
      score,
      discoveryApi: "https://api.osv.dev/v1/querybatch"
    },
    acceptanceCriteria: [
      `Update ${target.name} in ${manifestPath} so ${target.version} is no longer selected.`,
      `Use ${fixedVersion} or a newer non-vulnerable version when compatible.`,
      "Update the lockfile when the ecosystem uses one.",
      "Run the relevant package manager install/check/test commands, or explain why a command cannot be run.",
      "Open a focused pull request that references the OSV advisory and any CVE/GHSA aliases."
    ],
    estimatedDifficulty: estimateDifficulty(score),
    agentInstructions: [
      ...(repo ? [`Work in https://github.com/${repo}.`] : ["Use the repository supplied by the operator before making changes."]),
      `Review OSV advisory ${advisoryId}${aliases.length ? ` (${aliases.join(", ")})` : ""}.`,
      `Find every occurrence of ${target.name}@${target.version} in ${manifestPath} and related lockfiles.`,
      "Prefer the smallest safe dependency bump that satisfies the advisory.",
      "Run tests or at least dependency installation/lockfile validation before submitting.",
      "Submit structured evidence with prUrl, packageName, vulnerableVersion, fixedVersion, advisoryIds, tests, and notes."
    ],
    verification: {
      method: "github_pr",
      suggestedCheck: "dependency_no_longer_vulnerable",
      evidenceSchemaRef: "schema://jobs/dependency-remediation-output",
      signals: ["pr_opened", "advisory_referenced", "dependency_updated", "lockfile_updated", "tests_submitted", "ci_passed"]
    }
  };
}

export async function postJobs({ baseUrl, adminToken, jobs, fetchImpl = fetch }) {
  const results = [];
  for (const job of jobs) {
    results.push(await createJob({ baseUrl, adminToken, job, fetchImpl }));
  }
  return results;
}

export async function createJob({ baseUrl, adminToken, job, fetchImpl = fetch }) {
  const response = await fetchImpl(`${trimTrailingSlash(baseUrl)}/admin/jobs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(job)
  });
  const body = await response.text();
  let payload;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    payload = { raw: body };
  }
  return { id: job.id, status: response.status, ok: response.ok, payload };
}

function parsePackageString(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to compact line parser.
  }
  return String(raw)
    .split(/\n|,/u)
    .map((entry) => {
      const [nameVersion, repo, manifestPath] = entry.split("|").map((part) => part?.trim());
      const at = nameVersion?.lastIndexOf("@") ?? -1;
      if (!nameVersion || at <= 0) return undefined;
      return {
        name: nameVersion.slice(0, at),
        version: nameVersion.slice(at + 1),
        repo,
        manifestPath
      };
    })
    .filter(Boolean);
}

function normalizePackageTarget(raw) {
  const ecosystem = normalizeEcosystem(raw?.ecosystem ?? DEFAULT_ECOSYSTEM);
  const name = String(raw?.name ?? "").trim();
  const version = String(raw?.version ?? "").trim();
  if (!name || !version || !ecosystem) return undefined;
  return {
    name,
    version,
    ecosystem,
    ...(raw?.repo ? { repo: normalizeRepo(raw.repo) } : {}),
    ...(raw?.manifestPath ? { manifestPath: String(raw.manifestPath).trim() } : {})
  };
}

function normalizeEcosystem(value) {
  const ecosystem = String(value ?? "").trim().toLowerCase();
  if (ecosystem === "npm") return "npm";
  return ECOSYSTEMS.has(ecosystem) ? ecosystem : undefined;
}

function normalizeRepo(value) {
  return String(value ?? "")
    .trim()
    .replace(/^https:\/\/github\.com\//u, "")
    .replace(/\.git$/u, "")
    .replace(/^\/+|\/+$/gu, "");
}

export function findFixedVersion(advisory, target) {
  const affected = advisory.affected ?? [];
  const fixed = [];
  for (const entry of affected) {
    const pkg = entry.package ?? {};
    if (String(pkg.ecosystem ?? "").toLowerCase() !== target.ecosystem) continue;
    if (String(pkg.name ?? "") !== target.name) continue;
    for (const range of entry.ranges ?? []) {
      for (const event of range.events ?? []) {
        fixed.push(...extractVersionStrings(event.fixed));
      }
    }
    fixed.push(...extractFixedVersionsFromMetadata(entry.database_specific));
    fixed.push(...extractFixedVersionsFromMetadata(entry.ecosystem_specific));
  }
  fixed.push(...extractFixedVersionsFromMetadata(advisory.database_specific));
  return fixed.sort(compareSemverish)[0];
}

function extractFixedVersionsFromMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return [];
  }
  return [
    ...extractVersionStrings(metadata.fixed_version),
    ...extractVersionStrings(metadata.fixedVersion),
    ...extractVersionStrings(metadata.fixed_versions),
    ...extractVersionStrings(metadata.fixedVersions),
    ...extractVersionStrings(metadata.all_fixed_versions),
    ...extractVersionStrings(metadata.allFixedVersions),
    ...extractVersionStrings(metadata.upstream_version),
    ...extractVersionStrings(metadata.upstreamVersion),
    ...extractVersionStrings(metadata.root_patch_version),
    ...extractVersionStrings(metadata.rootPatchVersion)
  ];
}

function extractVersionStrings(value) {
  if (Array.isArray(value)) {
    return value.flatMap(extractVersionStrings);
  }
  if (value === undefined || value === null) {
    return [];
  }
  return String(value)
    .split(/[,;\s]+/u)
    .map((version) => version.trim())
    .filter(isSemverish);
}

function isSemverish(value) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value);
}

function compareSemverish(left, right) {
  const leftParts = String(left).split(/[.-]/u).map((part) => Number.parseInt(part, 10));
  const rightParts = String(right).split(/[.-]/u).map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const a = Number.isFinite(leftParts[index]) ? leftParts[index] : 0;
    const b = Number.isFinite(rightParts[index]) ? rightParts[index] : 0;
    if (a !== b) return a - b;
  }
  return String(left).localeCompare(String(right));
}

function maxCvssScore(advisory) {
  return Math.max(
    0,
    ...(advisory.severity ?? []).map((entry) => {
      const vector = String(entry.score ?? "");
      const match = vector.match(/\/AV:[A-Z]\/AC:[A-Z]\/PR:[A-Z]\/UI:[A-Z]\/S:[A-Z]\/C:[A-Z]\/I:[A-Z]\/A:[A-Z]/u)
        ? undefined
        : vector.match(/^(\d+(?:\.\d+)?)$/u);
      return match ? Number(match[1]) : 0;
    })
  );
}

function advisoryAliases(advisory) {
  return [...new Set([advisory.id, ...(advisory.aliases ?? [])].map((alias) => String(alias ?? "").trim()).filter(Boolean))];
}

function hasAlias(advisory, prefix) {
  return advisoryAliases(advisory).some((alias) => alias.startsWith(prefix));
}

function advisoryReferences(advisory) {
  return (advisory.references ?? [])
    .map((reference) => ({
      type: String(reference.type ?? "REFERENCE"),
      url: String(reference.url ?? "").trim()
    }))
    .filter((reference) => reference.url);
}

function estimateDifficulty(score) {
  if (score >= 85) return "starter-plus";
  if (score >= 70) return "starter";
  return "review-needed";
}

function summarise(value) {
  return value.length > 4000 ? `${value.slice(0, 3997)}...` : value;
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
}

function parsePositiveInt(raw, fallback) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/u, "");
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args["dry-run"]);
  const packages = args.packages ?? process.env.OSV_INGEST_PACKAGES_JSON ?? process.env.OSV_INGEST_PACKAGES;
  const limit = parsePositiveInt(args.limit, 10);
  const minScore = parsePositiveInt(args["min-score"], 55);
  const baseUrl = trimTrailingSlash(String(args.baseUrl ?? process.env.AGENT_API_BASE_URL ?? DEFAULT_BASE_URL));
  const adminToken = process.env.AGENT_ADMIN_TOKEN?.trim();

  if (!dryRun && !adminToken) {
    fail("AGENT_ADMIN_TOKEN is required unless --dry-run is set.");
  }

  const dryRunPayload = await ingestOsvAdvisories({ packages, limit, minScore });
  if (dryRun) {
    console.log(JSON.stringify(dryRunPayload, null, 2));
    return;
  }

  const results = await postJobs({ baseUrl, adminToken, jobs: dryRunPayload.jobs });
  console.log(JSON.stringify({ ...dryRunPayload, results }, null, 2));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}

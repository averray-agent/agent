#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { DEFAULT_ESCROW_ASSET_SYMBOL } from "../core/assets.js";

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
export const GITHUB_RAW_BASE_URL = "https://raw.githubusercontent.com";

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
  manifests = [],
  limit = 10,
  minScore = 55,
  maxPackageTargets = 100,
  fetchImpl = fetch
} = {}) {
  const explicitTargets = parsePackages(packages);
  const targets = explicitTargets.length
    ? explicitTargets
    : await collectPackageTargetsFromManifests({ manifests, maxPackageTargets, fetchImpl });
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

  const groupedCandidates = groupOsvCandidates(candidates);
  const jobs = groupedCandidates
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ target, advisories, fixedVersion, score }) => toPlatformJob({ target, advisories, fixedVersion, score }));

  if (groupedCandidates.length > jobs.length) {
    skipped.push({ reason: "over_limit", count: groupedCandidates.length - jobs.length });
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

export function parseManifests(raw) {
  const parsed = typeof raw === "string" ? parseManifestString(raw) : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normalizeManifestSource).filter(Boolean);
}

export async function collectPackageTargetsFromManifests({
  manifests = [],
  maxPackageTargets = 100,
  fetchImpl = fetch
} = {}) {
  const sources = parseManifests(manifests);
  const targets = [];
  const seen = new Set();
  for (const source of sources) {
    const lockfile = await fetchNpmLockfile(source, fetchImpl);
    for (const target of extractNpmLockfileTargets({ lockfile, source })) {
      const key = `${target.ecosystem}|${target.repo}|${target.manifestPath}|${target.name}|${target.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(target);
      if (targets.length >= maxPackageTargets) {
        return targets;
      }
    }
  }
  return targets;
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

function groupOsvCandidates(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const key = osvTargetKey(candidate.target);
    const group = groups.get(key) ?? {
      target: candidate.target,
      advisories: [],
      fixedVersion: candidate.fixedVersion,
      score: candidate.score
    };
    group.advisories.push(candidate);
    if (compareSemverish(candidate.fixedVersion, group.fixedVersion) > 0) {
      group.fixedVersion = candidate.fixedVersion;
    }
    group.score = Math.max(group.score, candidate.score);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    advisories: group.advisories.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return String(left.advisory.id ?? "").localeCompare(String(right.advisory.id ?? ""));
    })
  }));
}

function osvTargetKey(target) {
  return [
    String(target.ecosystem ?? DEFAULT_ECOSYSTEM).toLowerCase(),
    String(target.repo ?? "").toLowerCase(),
    String(target.manifestPath ?? "").toLowerCase(),
    String(target.name).toLowerCase(),
    String(target.version)
  ].join("|");
}

export function toPlatformJob({ target, advisory, advisories, fixedVersion, score }) {
  const advisoryEntries = normalizeAdvisoryEntries({ advisory, advisories, fixedVersion, score });
  const primaryEntry = advisoryEntries[0] ?? { advisory: {}, fixedVersion, score: 0 };
  const primaryAdvisory = primaryEntry.advisory;
  const primaryAdvisoryId = String(primaryAdvisory.id ?? "OSV-UNKNOWN");
  const advisoryIds = [...new Set(advisoryEntries.map((entry) => String(entry.advisory.id ?? "").trim()).filter(Boolean))];
  const aliases = [...new Set(advisoryEntries.flatMap((entry) => advisoryAliases(entry.advisory)))];
  const cves = aliases.filter((alias) => alias.startsWith("CVE-"));
  const references = uniqueReferences(advisoryEntries.flatMap((entry) => advisoryReferences(entry.advisory)));
  const repo = target.repo ? normalizeRepo(target.repo) : undefined;
  const manifestPath = target.manifestPath ?? "package.json";
  const effectiveFixedVersion = fixedVersion ?? maxFixedVersion(advisoryEntries.map((entry) => entry.fixedVersion));
  const effectiveScore = score ?? Math.max(...advisoryEntries.map((entry) => entry.score ?? scoreAdvisory(entry.advisory, { fixedVersion: entry.fixedVersion })));
  const isGrouped = advisoryEntries.length > 1;
  const advisoryLabel = advisoryIds.length ? advisoryIds.join(", ") : primaryAdvisoryId;
  const title = isGrouped
    ? `Remediate ${target.name} advisories`
    : `Remediate ${primaryAdvisoryId} in ${target.name}`;
  const id = (isGrouped
    ? `osv-npm-${slugify(repo ?? "repo")}-${slugify(target.name)}-${slugify(target.version)}`
    : `osv-npm-${slugify(repo ?? "repo")}-${slugify(target.name)}-${slugify(target.version)}-${slugify(primaryAdvisoryId)}`
  ).slice(0, 120);

  return {
    id,
    title,
    description:
      `Update npm package ${target.name} from vulnerable version ${target.version} to ${effectiveFixedVersion} or a newer safe release. ${isGrouped ? "Advisories" : "Advisory"}: ${advisoryLabel}.`,
    jobType: "work",
    requiredRole: "worker",
    category: "security",
    tier: "starter",
    rewardAsset: DEFAULT_ESCROW_ASSET_SYMBOL,
    rewardAmount: 0.3,
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
      fixedVersion: effectiveFixedVersion,
      repo,
      manifestPath,
      advisoryId: primaryAdvisoryId,
      advisoryIds: aliases,
      aliases,
      cves,
      nvdUrls: cves.map((cve) => `https://nvd.nist.gov/vuln/detail/${cve}`),
      summary: String(primaryAdvisory.summary ?? "").trim(),
      details: summarise(String(primaryAdvisory.details ?? "")),
      advisories: advisoryEntries.map((entry) => ({
        advisoryId: String(entry.advisory.id ?? "OSV-UNKNOWN"),
        fixedVersion: entry.fixedVersion,
        aliases: advisoryAliases(entry.advisory),
        summary: String(entry.advisory.summary ?? "").trim(),
        references: advisoryReferences(entry.advisory),
        severity: entry.advisory.severity ?? [],
        score: entry.score ?? scoreAdvisory(entry.advisory, { fixedVersion: entry.fixedVersion })
      })),
      references,
      severity: primaryAdvisory.severity ?? [],
      published: primaryAdvisory.published,
      modified: primaryAdvisory.modified,
      score: effectiveScore,
      discoveryApi: "https://api.osv.dev/v1/querybatch"
    },
    acceptanceCriteria: [
      `Update ${target.name} in ${manifestPath} so ${target.version} is no longer selected.`,
      `Use ${effectiveFixedVersion} or a newer non-vulnerable version when compatible.`,
      "Update the lockfile when the ecosystem uses one.",
      "Run the relevant package manager install/check/test commands, or explain why a command cannot be run.",
      "Open a focused pull request that references the OSV advisory/advisories and any CVE/GHSA aliases."
    ],
    estimatedDifficulty: estimateDifficulty(effectiveScore),
    agentInstructions: [
      ...(repo ? [`Work in https://github.com/${repo}.`] : ["Use the repository supplied by the operator before making changes."]),
      `Review OSV ${isGrouped ? "advisories" : "advisory"} ${advisoryLabel}${aliases.length ? ` (${aliases.join(", ")})` : ""}.`,
      `Find every occurrence of ${target.name}@${target.version} in ${manifestPath} and related lockfiles.`,
      "Prefer the smallest safe dependency bump that satisfies every advisory.",
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

function normalizeAdvisoryEntries({ advisory, advisories, fixedVersion, score }) {
  const rawEntries = Array.isArray(advisories) && advisories.length
    ? advisories
    : [{ advisory, fixedVersion, score }];
  return rawEntries
    .map((entry) => {
      const advisoryValue = entry?.advisory ?? entry;
      if (!advisoryValue || typeof advisoryValue !== "object") return undefined;
      const entryFixedVersion = entry?.fixedVersion ?? fixedVersion;
      return {
        advisory: advisoryValue,
        fixedVersion: entryFixedVersion,
        score: entry?.score ?? score ?? scoreAdvisory(advisoryValue, { fixedVersion: entryFixedVersion })
      };
    })
    .filter(Boolean);
}

function maxFixedVersion(versions) {
  return versions
    .map((version) => String(version ?? "").trim())
    .filter(isSemverish)
    .sort(compareSemverish)
    .at(-1);
}

function uniqueReferences(references) {
  const seen = new Set();
  const unique = [];
  for (const reference of references) {
    const key = `${reference.type}|${reference.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(reference);
  }
  return unique;
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

function parseManifestString(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to compact line parser.
  }
  return String(raw)
    .split(/\n|,/u)
    .map((entry) => {
      const [repo, manifestPath = "package-lock.json", ref = "main"] = entry.split("|").map((part) => part?.trim());
      if (!repo) return undefined;
      return { repo, manifestPath, ref };
    })
    .filter(Boolean);
}

function normalizeManifestSource(raw) {
  const repo = normalizeRepo(raw?.repo);
  const manifestPath = String(raw?.manifestPath ?? raw?.path ?? "package-lock.json").trim().replace(/^\/+/u, "");
  const ref = String(raw?.ref ?? raw?.branch ?? "main").trim();
  if (!repo || !manifestPath || !ref) return undefined;
  return { repo, manifestPath, ref };
}

async function fetchNpmLockfile(source, fetchImpl) {
  const url = rawGithubUrl(source);
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/json",
      "user-agent": "AverrayOsvIngest/0.1 (https://averray.com; operator@averray.com)"
    }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub lockfile fetch failed (${response.status}) for ${source.repo}/${source.manifestPath}@${source.ref}: ${body}`);
  }
  return response.json();
}

function rawGithubUrl(source) {
  const repoPath = source.repo.split("/").map(encodeURIComponent).join("/");
  const manifestPath = source.manifestPath.split("/").map(encodeURIComponent).join("/");
  return `${GITHUB_RAW_BASE_URL}/${repoPath}/${encodeURIComponent(source.ref)}/${manifestPath}`;
}

export function extractNpmLockfileTargets({ lockfile, source }) {
  const targets = [];
  const packages = lockfile?.packages && typeof lockfile.packages === "object" ? lockfile.packages : undefined;
  if (packages) {
    for (const [path, entry] of Object.entries(packages)) {
      if (!path.startsWith("node_modules/") || !entry || typeof entry !== "object") continue;
      const name = entry.name || packageNameFromNodeModulesPath(path);
      const version = String(entry.version ?? "").trim();
      if (!name || !version || entry.dev === true) continue;
      targets.push({ name, version, ecosystem: DEFAULT_ECOSYSTEM, repo: source.repo, manifestPath: source.manifestPath });
    }
    return targets;
  }

  const dependencies = lockfile?.dependencies && typeof lockfile.dependencies === "object" ? lockfile.dependencies : {};
  for (const [name, entry] of Object.entries(dependencies)) {
    const version = String(entry?.version ?? "").trim();
    if (!name || !version || entry?.dev === true) continue;
    targets.push({ name, version, ecosystem: DEFAULT_ECOSYSTEM, repo: source.repo, manifestPath: source.manifestPath });
  }
  return targets;
}

function packageNameFromNodeModulesPath(path) {
  const relative = path.replace(/^node_modules\//u, "");
  if (relative.startsWith("@")) {
    const [scope, name] = relative.split("/");
    return scope && name ? `${scope}/${name}` : "";
  }
  return relative.split("/")[0] ?? "";
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
  const manifests = args.manifests ?? process.env.OSV_INGEST_MANIFESTS_JSON ?? process.env.OSV_INGEST_MANIFESTS;
  const limit = parsePositiveInt(args.limit, 10);
  const minScore = parsePositiveInt(args["min-score"], 55);
  const maxPackageTargets = parsePositiveInt(args["max-package-targets"] ?? process.env.OSV_INGEST_MAX_PACKAGE_TARGETS, 100);
  const baseUrl = trimTrailingSlash(String(args.baseUrl ?? process.env.AGENT_API_BASE_URL ?? DEFAULT_BASE_URL));
  const adminToken = process.env.AGENT_ADMIN_TOKEN?.trim();

  if (!dryRun && !adminToken) {
    fail("AGENT_ADMIN_TOKEN is required unless --dry-run is set.");
  }

  const dryRunPayload = await ingestOsvAdvisories({ packages, manifests, limit, minScore, maxPackageTargets });
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

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { CLASSIFICATIONS, REPORT_SCHEMA } from "./constants.mjs";

export async function loadReports(directory) {
  const reports = [];
  for (const path of await jsonFiles(directory)) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      if (parsed.schemaVersion === REPORT_SCHEMA && parsed.repo && parsed.classification) {
        reports.push({ ...parsed, reportPath: path });
      }
    } catch {
      // Non-report JSON in an evidence directory is ignored by design.
    }
  }
  return reports;
}

export function summarizeReports(reports) {
  const distribution = Object.fromEntries(Object.values(CLASSIFICATIONS).map((key) => [key, 0]));
  const repos = reports.map((report) => {
    if (distribution[report.classification] === undefined) distribution[report.classification] = 0;
    distribution[report.classification] += 1;
    return {
      repo: report.repo,
      commit: report.commit,
      classification: report.classification,
      baseExitStatus: report.baseExitStatus,
      preparationAttempted: report.dependencyPreparation?.attempted === true,
      preparationSeconds: number(report.dependencyPreparationSeconds),
      cacheSizeBytes: number(report.dependencyCacheSizeBytes),
      totalSeconds: number(report.totalSeconds),
      error: report.observedFailureReason || null
    };
  }).sort((a, b) => a.repo.localeCompare(b.repo));
  const preparationCosts = repos.map((repo) => repo.preparationSeconds).sort((a, b) => a - b);
  const preparedCosts = repos
    .filter((repo) => repo.preparationAttempted)
    .map((repo) => repo.preparationSeconds)
    .sort((a, b) => a - b);
  const worst = repos.reduce((current, repo) => (
    !current || repo.preparationSeconds > current.preparationSeconds ? repo : current
  ), null);

  return {
    total: reports.length,
    distribution,
    preparationCost: {
      medianSeconds: median(preparationCosts),
      medianPreparedReposSeconds: median(preparedCosts),
      preparedRepoCount: preparedCosts.length,
      worstCaseSeconds: worst?.preparationSeconds || 0,
      worstCaseRepo: worst?.repo || null
    },
    repos
  };
}

export function formatSummary(summary) {
  const lines = [
    `Reports: ${summary.total}`,
    "Distribution:"
  ];
  for (const [classification, count] of Object.entries(summary.distribution)) {
    lines.push(`  ${classification.padEnd(23)} ${count}`);
  }
  lines.push(
    "Preparation cost:",
    `  median ${summary.preparationCost.medianSeconds.toFixed(3)}s`,
    `  median among ${summary.preparationCost.preparedRepoCount} prepared repos ${summary.preparationCost.medianPreparedReposSeconds.toFixed(3)}s`,
    `  worst  ${summary.preparationCost.worstCaseSeconds.toFixed(3)}s${summary.preparationCost.worstCaseRepo ? ` (${summary.preparationCost.worstCaseRepo})` : ""}`,
    "Per repository:"
  );
  for (const repo of summary.repos) {
    lines.push(
      `  ${repo.repo} | ${repo.classification} | prep=${repo.preparationSeconds.toFixed(3)}s | cache=${repo.cacheSizeBytes}B | total=${repo.totalSeconds.toFixed(3)}s${repo.error ? ` | ${repo.error}` : ""}`
    );
  }
  return `${lines.join("\n")}\n`;
}

function median(values) {
  if (values.length === 0) return 0;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1
    ? values[middle]
    : Number(((values[middle - 1] + values[middle]) / 2).toFixed(3));
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

async function jsonFiles(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await jsonFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".json")) result.push(path);
  }
  return result;
}

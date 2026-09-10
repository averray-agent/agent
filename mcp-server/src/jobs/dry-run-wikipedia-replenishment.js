#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { DEFAULT_CATEGORIES } from "./ingest-wikipedia-maintenance.js";
import { WikipediaMaintenanceIngestionScheduler } from "../services/wikipedia-maintenance-ingestion-scheduler.js";

/** Run the real scheduler against public production observations, in memory.
 * No bootstrap, credentials, state store, event bus, job POSTs or chain signer.
 * Public listings are not an exhaustive host-history audit: unknown completion
 * times deliberately retain the scheduler's conservative cooldown behavior.
 */
export async function dryRunWikipediaReplenishment({
  baseUrl = "https://api.averray.com", fetchImpl = fetch, now = new Date()
} = {}) {
  const catalogueUrl = new URL("/jobs?format=full", baseUrl);
  const response = await fetchImpl(catalogueUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Public catalogue read failed: HTTP ${response.status}`);
  const catalogue = await response.json();
  if (!Array.isArray(catalogue)) throw new Error("Public full catalogue was not an array");
  const jobs = catalogue.filter((job) => job?.source?.type === "wikipedia_article");
  const platform = {
    listJobs: () => jobs,
    listJobsWithSessions: async () => jobs,
    createJob() { throw new Error("Dry-run cannot create jobs"); },
    upsertIngestedJob() { throw new Error("Dry-run cannot fund or upsert jobs"); }
  };
  const scheduler = new WikipediaMaintenanceIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: true,
    categories: DEFAULT_CATEGORIES,
    // Evaluate candidate policy even when the live inventory floor is satisfied.
    // This overrides only this in-memory diagnostic, never production settings.
    minClaimableJobs: 0,
    fetchImpl: (url, options = {}) => fetchImpl(url, { ...options, signal: AbortSignal.timeout(30_000) }),
    logger: { info() {}, warn() {} }
  });
  return {
    evidenceKind: "public-catalogue-scheduler-dry-run",
    catalogueUrl: String(catalogueUrl),
    observedAt: now.toISOString(),
    observedWikipediaJobs: jobs.length,
    limitations: "Public listed jobs only, not archived host history. Missing completion timestamps fail closed; no dates are inferred.",
    diagnosticOverrides: { enabled: true, dryRun: true, minClaimableJobs: 0 },
    summary: await scheduler.runOnce(now)
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const report = await dryRunWikipediaReplenishment();
  console.log(JSON.stringify(report, null, 2));
  if (report.summary.errors.length) process.exitCode = 1;
}

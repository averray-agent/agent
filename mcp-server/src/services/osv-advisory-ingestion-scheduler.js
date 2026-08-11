import { ingestOsvAdvisories, parseManifests, parsePackages } from "../jobs/ingest-osv-advisories.js";
import { GuardedSchedulerLoop } from "./guarded-scheduler.js";

const NO_PRODUCTION_FAILURE_THRESHOLD = 3;

export class OsvAdvisoryIngestionScheduler {
  constructor(platformService, eventBus = undefined, {
    enabled = false,
    dryRun = true,
    intervalMs = 60 * 60 * 1000,
    packages = [],
    manifests = [],
    minScore = 55,
    maxJobsPerRun = 2,
    maxPackageTargets = 100,
    maxOpenJobs = 20,
    fetchImpl = fetch,
    logger = console,
    schedulerRunTimeoutMs = undefined
  } = {}) {
    this.platformService = platformService;
    this.eventBus = eventBus;
    this.enabled = enabled;
    this.dryRun = dryRun;
    this.intervalMs = intervalMs;
    this.packages = parsePackagesConfig(packages);
    this.manifests = parseManifestsConfig(manifests);
    this.minScore = minScore;
    this.maxJobsPerRun = maxJobsPerRun;
    this.maxPackageTargets = maxPackageTargets;
    this.maxOpenJobs = maxOpenJobs;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.lastRun = undefined;
    this.consecutiveNoJobRuns = 0;
    this.scheduler = new GuardedSchedulerLoop({
      name: "osv_ingest",
      enabled,
      intervalMs,
      runTimeoutMs: schedulerRunTimeoutMs,
      runOnce: (now) => this.runOnce(now),
      evaluateOutcome: (summary) => this.evaluateSchedulerOutcome(summary),
      logger
    });
  }

  start() {
    this.scheduler.start();
  }

  stop() {
    this.scheduler.stop();
  }

  async getStatus() {
    return {
      enabled: this.enabled,
      running: this.scheduler.running,
      dryRun: this.dryRun,
      intervalMs: this.intervalMs,
      packageCount: this.packages.length,
      manifestCount: this.manifests.length,
      targetCount: this.packages.length || this.manifests.length,
      minScore: this.minScore,
      maxJobsPerRun: this.maxJobsPerRun,
      maxPackageTargets: this.maxPackageTargets,
      maxOpenJobs: this.maxOpenJobs,
      currentOpenJobs: this.countOpenOsvJobs(),
      lastRun: this.lastRun,
      consecutiveNoJobRuns: this.consecutiveNoJobRuns,
      ...this.scheduler.getStatus()
    };
  }

  async runOnce(now = new Date()) {
    const startedAt = now.toISOString();
    const openOsvJobs = this.countOpenOsvJobs();
    const summary = {
      startedAt,
      finishedAt: undefined,
      dryRun: this.dryRun,
      openOsvJobs,
      candidateCount: 0,
      createdCount: 0,
      skipped: [],
      errors: []
    };

    if (!this.enabled) {
      summary.skipped.push({ reason: "disabled" });
      return this.finishRun(summary);
    }
    if (!this.packages.length && !this.manifests.length) {
      summary.skipped.push({ reason: "no_packages_or_manifests_configured" });
      return this.finishRun(summary);
    }
    if (openOsvJobs >= this.maxOpenJobs) {
      summary.skipped.push({ reason: "max_open_jobs_reached", openOsvJobs, maxOpenJobs: this.maxOpenJobs });
      return this.finishRun(summary);
    }

    const remaining = Math.max(0, Math.min(this.maxJobsPerRun, this.maxOpenJobs - openOsvJobs));
    const seenSources = this.existingOsvAdvisoryKeys();
    try {
      const result = await ingestOsvAdvisories({
        packages: this.packages,
        manifests: this.manifests,
        limit: remaining,
        minScore: this.minScore,
        maxPackageTargets: this.maxPackageTargets,
        fetchImpl: this.fetchImpl
      });
      summary.candidateCount = result.count;
      summary.skipped.push(...(Array.isArray(result.skipped) ? result.skipped : []));
      for (const job of result.jobs) {
        const sourceKey = osvJobKey(job);
        if (sourceKey && seenSources.has(sourceKey)) {
          summary.skipped.push({ id: job.id, reason: "source_already_ingested" });
          continue;
        }
        if (this.platformService.getJobDefinition) {
          try {
            this.platformService.getJobDefinition(job.id);
            summary.skipped.push({ id: job.id, reason: "job_already_exists" });
            continue;
          } catch {
            // Missing jobs are expected and created below.
          }
        }
        if (!this.dryRun) {
          this.platformService.createJob(job);
        }
        seenSources.add(sourceKey);
        summary.createdCount += 1;
        this.eventBus?.publish?.({
          id: `platform-osv-ingest-${job.id}-${Date.now()}`,
          topic: "jobs.ingest.osv",
          jobId: job.id,
          timestamp: new Date().toISOString(),
          data: {
            dryRun: this.dryRun,
            jobId: job.id,
            source: job.source
          }
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push({ message });
      this.logger.warn?.({ err: error }, "osv_ingest.run_failed");
    }

    return this.finishRun(summary);
  }

  async runOnceAndSchedule() {
    return this.scheduler.runOnceAndSchedule();
  }

  async getHealth(now = new Date()) {
    return { ...this.scheduler.getHealth(now), component: "osv_advisory_ingestion" };
  }

  evaluateSchedulerOutcome(summary) {
    if (summary.errors.length > 0) {
      this.consecutiveNoJobRuns = 0;
      return { ok: false, state: "ingestion_run_errors", message: `${summary.errors.length} OSV ingestion error(s)` };
    }
    if (this.dryRun || summary.createdCount > 0 || summary.openOsvJobs >= this.maxOpenJobs) {
      this.consecutiveNoJobRuns = 0;
      return { ok: true };
    }
    if (!this.packages.length && !this.manifests.length) {
      return { ok: false, state: "ingestion_misconfigured", message: "OSV ingestion has no packages or manifests" };
    }
    this.consecutiveNoJobRuns += 1;
    if (this.consecutiveNoJobRuns >= NO_PRODUCTION_FAILURE_THRESHOLD) {
      return {
        ok: false,
        state: "repeated_no_production",
        message: `OSV ingestion produced no jobs for ${this.consecutiveNoJobRuns} eligible runs`
      };
    }
    return { ok: true };
  }

  finishRun(summary) {
    summary.finishedAt = new Date().toISOString();
    this.lastRun = summary;
    return summary;
  }

  countOpenOsvJobs() {
    return this.platformService.listJobs()
      .filter((job) => job.source?.type === "osv_advisory")
      .filter((job) => !job.recurring)
      .length;
  }

  existingOsvAdvisoryKeys() {
    return new Set(
      this.platformService.listJobs()
        .map((job) => osvJobKey(job))
        .filter(Boolean)
    );
  }
}

export function loadOsvAdvisoryIngestionConfig(env = process.env) {
  return {
    enabled: parseBooleanEnv(env.OSV_INGEST_ENABLED),
    dryRun: env.OSV_INGEST_DRY_RUN === undefined ? true : parseBooleanEnv(env.OSV_INGEST_DRY_RUN),
    intervalMs: parsePositiveInt(env.OSV_INGEST_INTERVAL_MS, 60 * 60 * 1000),
    packages: parsePackagesConfig(env.OSV_INGEST_PACKAGES_JSON ?? env.OSV_INGEST_PACKAGES),
    manifests: parseManifestsConfig(env.OSV_INGEST_MANIFESTS_JSON ?? env.OSV_INGEST_MANIFESTS),
    minScore: parsePositiveInt(env.OSV_INGEST_MIN_SCORE, 55),
    maxJobsPerRun: parsePositiveInt(env.OSV_INGEST_MAX_JOBS_PER_RUN, 2),
    maxPackageTargets: parsePositiveInt(env.OSV_INGEST_MAX_PACKAGE_TARGETS, 100),
    maxOpenJobs: parsePositiveInt(env.OSV_INGEST_MAX_OPEN_JOBS, 20)
  };
}

function osvJobKey(job) {
  const source = job?.source;
  if (source?.type !== "osv_advisory" || !source.packageName || !source.vulnerableVersion) {
    return undefined;
  }
  return [
    String(source.ecosystem ?? "npm").toLowerCase(),
    String(source.repo ?? "").toLowerCase(),
    String(source.manifestPath ?? "").toLowerCase(),
    String(source.packageName).toLowerCase(),
    String(source.vulnerableVersion)
  ].join("|");
}

function parsePackagesConfig(raw) {
  return parsePackages(raw);
}

function parseManifestsConfig(raw) {
  return parseManifests(raw);
}

function parsePositiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function parseBooleanEnv(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

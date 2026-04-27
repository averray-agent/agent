import { ingestStandardsSpecs, parseSpecs, standardsSpecKey } from "../jobs/ingest-standards-specs.js";

export class StandardsSpecIngestionScheduler {
  constructor(platformService, eventBus = undefined, {
    enabled = false,
    dryRun = true,
    intervalMs = 60 * 60 * 1000,
    specs = [],
    minScore = 55,
    maxJobsPerRun = 2,
    maxOpenJobs = 20,
    fetchImpl = fetch,
    logger = console
  } = {}) {
    this.platformService = platformService;
    this.eventBus = eventBus;
    this.enabled = enabled;
    this.dryRun = dryRun;
    this.intervalMs = intervalMs;
    this.specs = parseSpecs(specs);
    this.minScore = minScore;
    this.maxJobsPerRun = maxJobsPerRun;
    this.maxOpenJobs = maxOpenJobs;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.timer = undefined;
    this.running = false;
    this.lastRun = undefined;
  }

  start() {
    if (!this.enabled || this.running) {
      return;
    }
    this.running = true;
    void this.runOnceAndSchedule();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async getStatus() {
    return {
      enabled: this.enabled,
      running: this.running,
      dryRun: this.dryRun,
      intervalMs: this.intervalMs,
      specCount: this.specs.length,
      minScore: this.minScore,
      maxJobsPerRun: this.maxJobsPerRun,
      maxOpenJobs: this.maxOpenJobs,
      currentOpenJobs: this.countOpenStandardsJobs(),
      lastRun: this.lastRun
    };
  }

  async runOnce(now = new Date()) {
    const startedAt = now.toISOString();
    const openStandardsJobs = this.countOpenStandardsJobs();
    const summary = {
      startedAt,
      finishedAt: undefined,
      dryRun: this.dryRun,
      openStandardsJobs,
      candidateCount: 0,
      createdCount: 0,
      skipped: [],
      errors: []
    };

    if (!this.enabled) {
      summary.skipped.push({ reason: "disabled" });
      return this.finishRun(summary);
    }
    if (!this.specs.length) {
      summary.skipped.push({ reason: "no_specs_configured" });
      return this.finishRun(summary);
    }
    if (openStandardsJobs >= this.maxOpenJobs) {
      summary.skipped.push({ reason: "max_open_jobs_reached", openStandardsJobs, maxOpenJobs: this.maxOpenJobs });
      return this.finishRun(summary);
    }

    const remaining = Math.max(0, Math.min(this.maxJobsPerRun, this.maxOpenJobs - openStandardsJobs));
    const seenSources = this.existingStandardsKeys();
    try {
      const result = await ingestStandardsSpecs({
        specs: this.specs,
        limit: remaining,
        minScore: this.minScore,
        fetchImpl: this.fetchImpl
      });
      summary.candidateCount = result.count;
      summary.skipped.push(...(Array.isArray(result.skipped) ? result.skipped : []));
      for (const job of result.jobs) {
        const sourceKey = standardsJobKey(job);
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
          id: `platform-standards-ingest-${job.id}-${Date.now()}`,
          topic: "jobs.ingest.standards",
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
      this.logger.warn?.({ err: error }, "standards_ingest.run_failed");
    }

    return this.finishRun(summary);
  }

  async runOnceAndSchedule() {
    await this.runOnce(new Date());
    if (!this.running) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      void this.runOnceAndSchedule();
    }, this.intervalMs);
  }

  finishRun(summary) {
    summary.finishedAt = new Date().toISOString();
    this.lastRun = summary;
    return summary;
  }

  countOpenStandardsJobs() {
    return this.platformService.listJobs()
      .filter((job) => job.source?.type === "standards_spec")
      .filter((job) => !job.recurring)
      .length;
  }

  existingStandardsKeys() {
    return new Set(
      this.platformService.listJobs()
        .map((job) => standardsJobKey(job))
        .filter(Boolean)
    );
  }
}

export function loadStandardsSpecIngestionConfig(env = process.env) {
  return {
    enabled: parseBooleanEnv(env.STANDARDS_INGEST_ENABLED),
    dryRun: env.STANDARDS_INGEST_DRY_RUN === undefined ? true : parseBooleanEnv(env.STANDARDS_INGEST_DRY_RUN),
    intervalMs: parsePositiveInt(env.STANDARDS_INGEST_INTERVAL_MS, 60 * 60 * 1000),
    specs: parseSpecs(env.STANDARDS_INGEST_SPECS_JSON ?? env.STANDARDS_INGEST_SPECS),
    minScore: parsePositiveInt(env.STANDARDS_INGEST_MIN_SCORE, 55),
    maxJobsPerRun: parsePositiveInt(env.STANDARDS_INGEST_MAX_JOBS_PER_RUN, 2),
    maxOpenJobs: parsePositiveInt(env.STANDARDS_INGEST_MAX_OPEN_JOBS, 20)
  };
}

function standardsJobKey(job) {
  const source = job?.source;
  if (source?.type !== "standards_spec") {
    return undefined;
  }
  return standardsSpecKey(source);
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

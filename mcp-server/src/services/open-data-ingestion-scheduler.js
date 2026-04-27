import { DEFAULT_QUERY, ingestOpenDataDatasets, parseDatasets } from "../jobs/ingest-open-data-datasets.js";

export class OpenDataIngestionScheduler {
  constructor(platformService, eventBus = undefined, {
    enabled = false,
    dryRun = true,
    intervalMs = 60 * 60 * 1000,
    query = DEFAULT_QUERY,
    datasets = [],
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
    this.query = String(query || DEFAULT_QUERY).trim();
    this.datasets = parseDatasets(datasets);
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
      query: this.query,
      datasetCount: this.datasets.length,
      minScore: this.minScore,
      maxJobsPerRun: this.maxJobsPerRun,
      maxOpenJobs: this.maxOpenJobs,
      currentOpenJobs: this.countOpenDataJobs(),
      lastRun: this.lastRun
    };
  }

  async runOnce(now = new Date()) {
    const startedAt = now.toISOString();
    const openDataJobs = this.countOpenDataJobs();
    const summary = {
      startedAt,
      finishedAt: undefined,
      dryRun: this.dryRun,
      openDataJobs,
      candidateCount: 0,
      createdCount: 0,
      skipped: [],
      errors: []
    };

    if (!this.enabled) {
      summary.skipped.push({ reason: "disabled" });
      return this.finishRun(summary);
    }
    if (openDataJobs >= this.maxOpenJobs) {
      summary.skipped.push({ reason: "max_open_jobs_reached", openDataJobs, maxOpenJobs: this.maxOpenJobs });
      return this.finishRun(summary);
    }

    const remaining = Math.max(0, Math.min(this.maxJobsPerRun, this.maxOpenJobs - openDataJobs));
    const seenSources = this.existingOpenDataKeys();
    try {
      const result = await ingestOpenDataDatasets({
        datasets: this.datasets,
        query: this.query,
        limit: remaining,
        minScore: this.minScore,
        fetchImpl: this.fetchImpl
      });
      summary.candidateCount = result.count;
      summary.query = result.query;
      summary.skipped.push(...(Array.isArray(result.skipped) ? result.skipped : []));
      for (const job of result.jobs) {
        const sourceKey = openDataJobKey(job);
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
          id: `platform-open-data-ingest-${job.id}-${Date.now()}`,
          topic: "jobs.ingest.open_data",
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
      this.logger.warn?.({ err: error }, "open_data_ingest.run_failed");
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

  countOpenDataJobs() {
    return this.platformService.listJobs()
      .filter((job) => job.source?.type === "open_data_dataset")
      .filter((job) => !job.recurring)
      .length;
  }

  existingOpenDataKeys() {
    return new Set(
      this.platformService.listJobs()
        .map((job) => openDataJobKey(job))
        .filter(Boolean)
    );
  }
}

export function loadOpenDataIngestionConfig(env = process.env) {
  return {
    enabled: parseBooleanEnv(env.OPEN_DATA_INGEST_ENABLED),
    dryRun: env.OPEN_DATA_INGEST_DRY_RUN === undefined ? true : parseBooleanEnv(env.OPEN_DATA_INGEST_DRY_RUN),
    intervalMs: parsePositiveInt(env.OPEN_DATA_INGEST_INTERVAL_MS, 60 * 60 * 1000),
    query: env.OPEN_DATA_INGEST_QUERY?.trim() || DEFAULT_QUERY,
    datasets: parseDatasets(env.OPEN_DATA_INGEST_DATASETS_JSON ?? env.OPEN_DATA_INGEST_DATASETS),
    minScore: parsePositiveInt(env.OPEN_DATA_INGEST_MIN_SCORE, 55),
    maxJobsPerRun: parsePositiveInt(env.OPEN_DATA_INGEST_MAX_JOBS_PER_RUN, 2),
    maxOpenJobs: parsePositiveInt(env.OPEN_DATA_INGEST_MAX_OPEN_JOBS, 20)
  };
}

function openDataJobKey(job) {
  const source = job?.source;
  if (source?.type !== "open_data_dataset") {
    return undefined;
  }
  const resourceIdentity = source.resourceId || source.resourceUrl;
  const datasetIdentity = source.datasetId || source.datasetUrl || source.datasetTitle;
  if (!resourceIdentity || !datasetIdentity) {
    return undefined;
  }
  return [
    String(source.provider ?? source.portal ?? "data.gov").toLowerCase(),
    String(datasetIdentity).toLowerCase(),
    String(resourceIdentity).toLowerCase()
  ].join("|");
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

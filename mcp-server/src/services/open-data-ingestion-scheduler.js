import {
  DEFAULT_QUERY,
  ingestOpenDataDatasets,
  openDataDatasetKey,
  openDataResourceKey,
  parseDatasets
} from "../jobs/ingest-open-data-datasets.js";

export class OpenDataIngestionScheduler {
  constructor(platformService, eventBus = undefined, {
    enabled = false,
    dryRun = true,
    intervalMs = 60 * 60 * 1000,
    query = DEFAULT_QUERY,
    queries = undefined,
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
    this.queries = normalizeQueries(queries, query);
    this.query = this.queries[0] ?? DEFAULT_QUERY;
    this.datasets = parseDatasets(datasets);
    this.minScore = minScore;
    this.maxJobsPerRun = maxJobsPerRun;
    this.maxOpenJobs = maxOpenJobs;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.timer = undefined;
    this.running = false;
    this.lastRun = undefined;
    this.nextQueryIndex = 0;
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
      queries: this.queries,
      queryCount: this.queries.length,
      nextQuery: this.datasets.length ? undefined : this.queries[this.nextQueryIndex % Math.max(1, this.queries.length)],
      datasetCount: this.datasets.length,
      targetCount: this.datasets.length || this.queries.length,
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
      errors: [],
      queries: []
    };

    if (!this.enabled) {
      summary.skipped.push({ reason: "disabled" });
      return this.finishRun(summary);
    }
    if (openDataJobs >= this.maxOpenJobs) {
      summary.skipped.push({ reason: "max_open_jobs_reached", openDataJobs, maxOpenJobs: this.maxOpenJobs });
      return this.finishRun(summary);
    }
    if (!this.datasets.length && !this.queries.length) {
      summary.skipped.push({ reason: "no_queries_configured" });
      return this.finishRun(summary);
    }

    let remaining = Math.max(0, Math.min(this.maxJobsPerRun, this.maxOpenJobs - openDataJobs));
    const seenResources = this.existingOpenDataResourceKeys();
    const seenDatasets = this.existingOpenDataDatasetKeys();
    const runQueries = this.datasets.length ? [undefined] : this.rotateQueriesForRun();
    for (const query of runQueries) {
      if (remaining <= 0) break;
      try {
        const result = await ingestOpenDataDatasets({
          datasets: this.datasets,
          query: query ?? this.query,
          limit: remaining,
          minScore: this.minScore,
          excludeDatasetKeys: [...seenDatasets],
          excludeResourceKeys: [...seenResources],
          fetchImpl: this.fetchImpl
        });
        summary.candidateCount += result.count;
        summary.query ??= result.query;
        const querySummary = {
          query: result.query,
          candidates: result.count,
          created: 0,
          skipped: Array.isArray(result.skipped) ? result.skipped : []
        };
        for (const job of result.jobs) {
          if (remaining <= 0) break;
          const datasetKey = openDataDatasetKey(job);
          if (datasetKey && seenDatasets.has(datasetKey)) {
            querySummary.skipped.push({ id: job.id, reason: "dataset_already_ingested" });
            continue;
          }
          const resourceKey = openDataResourceKey(job);
          if (resourceKey && seenResources.has(resourceKey)) {
            querySummary.skipped.push({ id: job.id, reason: "source_already_ingested" });
            continue;
          }
          if (this.platformService.getJobDefinition) {
            try {
              this.platformService.getJobDefinition(job.id);
              querySummary.skipped.push({ id: job.id, reason: "job_already_exists" });
              continue;
            } catch {
              // Missing jobs are expected and created below.
            }
          }
          if (!this.dryRun) {
            this.platformService.createJob(job);
          }
          if (resourceKey) seenResources.add(resourceKey);
          if (datasetKey) seenDatasets.add(datasetKey);
          querySummary.created += 1;
          summary.createdCount += 1;
          remaining -= 1;
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
        summary.queries.push(querySummary);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summary.errors.push({ query, message });
        this.logger.warn?.({ query, err: error }, "open_data_ingest.run_failed");
      }
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

  existingOpenDataDatasetKeys() {
    return new Set(
      this.platformService.listJobs()
        .map((job) => openDataDatasetKey(job))
        .filter(Boolean)
    );
  }

  existingOpenDataResourceKeys() {
    return new Set(
      this.platformService.listJobs()
        .map((job) => openDataResourceKey(job))
        .filter(Boolean)
    );
  }

  rotateQueriesForRun() {
    if (!this.queries.length) {
      return [];
    }
    const start = this.nextQueryIndex % this.queries.length;
    const rotated = [
      ...this.queries.slice(start),
      ...this.queries.slice(0, start)
    ];
    this.nextQueryIndex = (start + 1) % this.queries.length;
    return rotated;
  }
}

export function loadOpenDataIngestionConfig(env = process.env) {
  const query = env.OPEN_DATA_INGEST_QUERY?.trim() || DEFAULT_QUERY;
  const queries = parseQueries(env.OPEN_DATA_INGEST_QUERIES_JSON ?? env.OPEN_DATA_INGEST_QUERIES);
  return {
    enabled: parseBooleanEnv(env.OPEN_DATA_INGEST_ENABLED),
    dryRun: env.OPEN_DATA_INGEST_DRY_RUN === undefined ? true : parseBooleanEnv(env.OPEN_DATA_INGEST_DRY_RUN),
    intervalMs: parsePositiveInt(env.OPEN_DATA_INGEST_INTERVAL_MS, 60 * 60 * 1000),
    query,
    queries: queries.length ? queries : [query],
    datasets: parseDatasets(env.OPEN_DATA_INGEST_DATASETS_JSON ?? env.OPEN_DATA_INGEST_DATASETS),
    minScore: parsePositiveInt(env.OPEN_DATA_INGEST_MIN_SCORE, 55),
    maxJobsPerRun: parsePositiveInt(env.OPEN_DATA_INGEST_MAX_JOBS_PER_RUN, 2),
    maxOpenJobs: parsePositiveInt(env.OPEN_DATA_INGEST_MAX_OPEN_JOBS, 20)
  };
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

function parseQueries(raw) {
  if (!raw || typeof raw !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((query) => String(query).trim()).filter(Boolean);
    }
  } catch {
    // Fall through to newline/comma parsing.
  }
  return raw
    .split(/\n|,/u)
    .map((query) => query.trim())
    .filter(Boolean);
}

function normalizeQueries(queries, fallbackQuery) {
  const parsed = Array.isArray(queries)
    ? queries.map((query) => String(query).trim()).filter(Boolean)
    : parseQueries(queries);
  if (parsed.length) {
    return parsed;
  }
  const fallback = String(fallbackQuery || DEFAULT_QUERY).trim();
  return fallback ? [fallback] : [];
}

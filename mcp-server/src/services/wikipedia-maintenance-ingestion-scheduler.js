import { ingestWikipediaMaintenance, parseCategories, wikipediaArticleKey } from "../jobs/ingest-wikipedia-maintenance.js";
import {
  buildInventorySnapshot,
  desiredInventoryCreates,
  parseNonNegativeInt,
  withReissueJobId
} from "./inventory-replenishment.js";

export class WikipediaMaintenanceIngestionScheduler {
  constructor(platformService, eventBus = undefined, {
    enabled = false,
    dryRun = true,
    intervalMs = 30 * 60 * 1000,
    language = "en",
    categories = [],
    minScore = 75,
    maxJobsPerRun = 2,
    maxOpenJobs = 20,
    minClaimableJobs = 0,
    fetchImpl = fetch,
    logger = console
  } = {}) {
    this.platformService = platformService;
    this.eventBus = eventBus;
    this.enabled = enabled;
    this.dryRun = dryRun;
    this.intervalMs = intervalMs;
    this.language = language;
    this.categories = parseCategories(categories);
    this.minScore = minScore;
    this.maxJobsPerRun = maxJobsPerRun;
    this.maxOpenJobs = maxOpenJobs;
    this.minClaimableJobs = minClaimableJobs;
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
    const inventory = await this.inventorySnapshot();
    return {
      enabled: this.enabled,
      running: this.running,
      dryRun: this.dryRun,
      intervalMs: this.intervalMs,
      language: this.language,
      categoryCount: this.categories.length,
      minScore: this.minScore,
      maxJobsPerRun: this.maxJobsPerRun,
      maxOpenJobs: this.maxOpenJobs,
      minClaimableJobs: this.minClaimableJobs,
      currentOpenJobs: inventory.claimableCount,
      currentClaimableJobs: inventory.claimableCount,
      lastRun: this.lastRun
    };
  }

  async runOnce(now = new Date()) {
    const startedAt = now.toISOString();
    const inventory = await this.inventorySnapshot(now);
    const claimableWikipediaJobs = inventory.claimableCount;
    const summary = {
      startedAt,
      finishedAt: undefined,
      dryRun: this.dryRun,
      claimableWikipediaJobs,
      minClaimableJobs: this.minClaimableJobs,
      activeSourceCount: inventory.activeSourceKeys.size,
      candidateCount: 0,
      createdCount: 0,
      skipped: [],
      errors: []
    };

    if (!this.enabled) {
      summary.skipped.push({ reason: "disabled" });
      return this.finishRun(summary);
    }
    const remaining = desiredInventoryCreates({
      claimableCount: claimableWikipediaJobs,
      minClaimableJobs: this.minClaimableJobs,
      maxJobsPerRun: this.maxJobsPerRun,
      maxOpenJobs: this.maxOpenJobs,
      activeCount: inventory.activeSourceKeys.size
    });
    if (remaining <= 0) {
      summary.skipped.push({
        reason: inventory.activeSourceKeys.size >= this.maxOpenJobs
          ? "max_open_jobs_reached"
          : "minimum_claimable_satisfied",
        claimableWikipediaJobs,
        minClaimableJobs: this.minClaimableJobs,
        maxOpenJobs: this.maxOpenJobs
      });
      return this.finishRun(summary);
    }

    this.logger.info?.({
      source: "wikipedia",
      category: "wikipedia",
      tier: "starter",
      claimableWikipediaJobs,
      minClaimableJobs: this.minClaimableJobs,
      desiredCreateCount: remaining
    }, "inventory.replenish.wikipedia");
    const seenSources = new Set(inventory.activeSourceKeys);
    const candidateLimit = Math.max(remaining * 3, remaining + seenSources.size);
    try {
      const result = await ingestWikipediaMaintenance({
        language: this.language,
        categories: this.categories,
        limit: candidateLimit,
        minScore: this.minScore,
        fetchImpl: this.fetchImpl
      });
      summary.candidateCount = result.count;
      for (const job of result.jobs) {
        if (summary.createdCount >= remaining) break;
        const sourceKey = wikipediaJobKey(job);
        if (sourceKey && seenSources.has(sourceKey)) {
          summary.skipped.push({ id: job.id, reason: "source_already_ingested" });
          continue;
        }
        const replenishedJob = withReissueJobId(job, inventory.allJobIds, { now });
        if (!this.dryRun) {
          this.platformService.createJob(replenishedJob);
        }
        seenSources.add(sourceKey);
        summary.createdCount += 1;
        this.eventBus?.publish?.({
          id: `platform-wikipedia-ingest-${replenishedJob.id}-${Date.now()}`,
          topic: "jobs.ingest.wikipedia",
          jobId: replenishedJob.id,
          timestamp: new Date().toISOString(),
          data: {
            dryRun: this.dryRun,
            jobId: replenishedJob.id,
            source: replenishedJob.source,
            reason: "inventory_replenishment",
            claimableBefore: claimableWikipediaJobs,
            minClaimableJobs: this.minClaimableJobs
          }
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push({ message });
      this.logger.warn?.({ err: error }, "wikipedia_ingest.run_failed");
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

  async inventorySnapshot(now = new Date()) {
    return buildInventorySnapshot(this.platformService, {
      sourceType: "wikipedia_article",
      category: "wikipedia",
      tier: "starter",
      sourceKeyForJob: wikipediaJobKey,
      now
    });
  }

  existingWikipediaArticleKeys() {
    return new Set(
      this.platformService.listJobs()
        .map((job) => wikipediaJobKey(job))
        .filter(Boolean)
    );
  }
}

export function loadWikipediaMaintenanceIngestionConfig(env = process.env) {
  const productionDefault = env.NODE_ENV === "production";
  return {
    enabled: env.WIKIPEDIA_INGEST_ENABLED === undefined
      ? productionDefault
      : parseBooleanEnv(env.WIKIPEDIA_INGEST_ENABLED),
    dryRun: env.WIKIPEDIA_INGEST_DRY_RUN === undefined
      ? !productionDefault
      : parseBooleanEnv(env.WIKIPEDIA_INGEST_DRY_RUN),
    intervalMs: parsePositiveInt(env.WIKIPEDIA_INGEST_INTERVAL_MS, 30 * 60 * 1000),
    language: env.WIKIPEDIA_INGEST_LANGUAGE?.trim() || "en",
    categories: parseCategories(env.WIKIPEDIA_INGEST_CATEGORIES_JSON ?? env.WIKIPEDIA_INGEST_CATEGORIES),
    minScore: parsePositiveInt(env.WIKIPEDIA_INGEST_MIN_SCORE, 75),
    maxJobsPerRun: parsePositiveInt(env.WIKIPEDIA_INGEST_MAX_JOBS_PER_RUN, 2),
    maxOpenJobs: parsePositiveInt(env.WIKIPEDIA_INGEST_MAX_OPEN_JOBS, 20),
    minClaimableJobs: parseNonNegativeInt(
      env.WIKIPEDIA_INGEST_MIN_CLAIMABLE_JOBS,
      productionDefault ? 2 : 0
    )
  };
}

function wikipediaJobKey(job) {
  const source = job?.source;
  if (source?.type !== "wikipedia_article") {
    return undefined;
  }
  return wikipediaArticleKey({
    language: source.language,
    pageId: source.pageId,
    revisionId: source.revisionId,
    taskType: source.taskType
  });
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

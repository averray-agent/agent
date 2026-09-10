import { ingestWikipediaMaintenance, parseCategories } from "../jobs/ingest-wikipedia-maintenance.js";
import { wikipediaRevisionKey } from "../core/paid-source-claim.js";
import {
  buildInventorySnapshot,
  desiredInventoryCreates,
  parseNonNegativeInt,
  withReissueJobId
} from "./inventory-replenishment.js";
import {
  recordIngestSpecHashRefusal,
  recordIngestVerifierRefusal,
  recordLanePostingRefusal,
  upsertScheduledIngestedJob
} from "./ingested-job-upsert.js";

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
    completedCooldownDays = 30,
    maxReissues = 2,
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
    this.completedCooldownDays = completedCooldownDays;
    this.maxReissues = maxReissues;
    this.rotation = 0;
    this.categoryContinuations = new Map();
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
    const waiverEligibleClaimableJobs = countWaiverEligibleClaimableJobs(inventory);
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
      completedCooldownDays: this.completedCooldownDays,
      maxReissues: this.maxReissues,
      currentOpenJobs: inventory.claimableCount,
      currentClaimableJobs: inventory.claimableCount,
      minimumWaiverEligibleClaimableJobs: this.minClaimableJobs,
      currentWaiverEligibleClaimableJobs: waiverEligibleClaimableJobs,
      lastRun: this.lastRun
    };
  }

  async runOnce(now = new Date()) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runInventoryPass(now);
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  async runInventoryPass(now) {
    const startedAt = now.toISOString();
    let inventory;
    try {
      inventory = await this.inventorySnapshot(now);
    } catch (error) {
      this.logger.warn?.({ err: error }, "wikipedia_ingest.inventory_read_failed");
      return this.finishRun({ startedAt, dryRun: this.dryRun, createdCount: 0,
        skipped: [], errors: [{ message: error?.message ?? String(error) }] });
    }
    const claimableWikipediaJobs = inventory.claimableCount;
    const waiverEligibleClaimableJobs = countWaiverEligibleClaimableJobs(inventory);
    const summary = {
      startedAt,
      finishedAt: undefined,
      dryRun: this.dryRun,
      claimableWikipediaJobs,
      waiverEligibleClaimableJobs,
      minClaimableJobs: this.minClaimableJobs,
      activeSourceCount: inventory.activeSourceKeys.size,
      candidateCount: 0,
      candidates: [],
      selected: [],
      createdCount: 0,
      ingestRefusedSpecHashMismatchCount: 0,
      skipped: [],
      errors: []
    };

    if (!this.enabled) {
      summary.skipped.push({ reason: "disabled" });
      return this.finishRun(summary);
    }
    const remaining = desiredInventoryCreates({
      claimableCount: waiverEligibleClaimableJobs,
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
        waiverEligibleClaimableJobs,
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
      waiverEligibleClaimableJobs,
      minClaimableJobs: this.minClaimableJobs,
      desiredCreateCount: remaining
    }, "inventory.replenish.wikipedia");
    const seenSources = new Set(inventory.activeSourceKeys);
    const candidateLimit = Math.min(50, Math.max(remaining * 3, remaining + inventory.seenSourceKeys.size));
    try {
      const result = await ingestWikipediaMaintenance({
        language: this.language,
        categories: this.categories,
        limit: candidateLimit,
        minScore: this.minScore,
        rotation: this.rotation++,
        categoryContinuations: this.categoryContinuations,
        fetchImpl: this.fetchImpl
      });
      summary.candidateCount = result.count;
      summary.candidates = result.jobs.map((job) => ({ id: job.id, title: job.source.pageTitle, sourceKey: wikipediaJobKey(job) }));
      for (const job of result.jobs) {
        const sourceKey = wikipediaJobKey(job);
        if (!sourceKey) {
          summary.skipped.push({ id: job.id, reason: "invalid_source_identity" });
          continue;
        }
        if (inventory.completedSourceKeys.has(sourceKey)) {
          summary.skipped.push({ id: job.id, title: job.source.pageTitle, sourceKey, reason: "completed_cooldown",
            ...inventory.completedSources.get(sourceKey) });
          continue;
        }
        if (sourceKey && seenSources.has(sourceKey)) {
          summary.skipped.push({ id: job.id, reason: "source_already_ingested" });
          continue;
        }
        // Report blocked sources even after the run's create quota is filled;
        // otherwise a successful alternative would hide the incident source.
        if (summary.createdCount >= remaining) {
          summary.skipped.push({ id: job.id, reason: "run_capacity_reached" });
          continue;
        }
        const replenishedJob = withReissueJobId(job, inventory.allJobIds, {
          now,
          sourceHistory: inventory.allSourceJobs,
          sourceKeyForJob: wikipediaJobKey,
          maxReissues: this.maxReissues
        });
        if (!replenishedJob) {
          summary.skipped.push({ id: job.id, title: job.source.pageTitle, sourceKey, reason: "reissue_cap_reached", maxReissues: this.maxReissues });
          continue;
        }
        if (!this.dryRun) {
          try {
            // Prefer the prefunding create path so the reward is escrowed at
            // ingestion; fall back to createJob for callers/tests without it.
            await upsertScheduledIngestedJob(this.platformService, replenishedJob, { prefund: true, now });
          } catch (error) {
            if (recordLanePostingRefusal(summary, replenishedJob, error)) continue;
            if (recordIngestSpecHashRefusal(summary, replenishedJob, error)) continue;
            if (recordIngestVerifierRefusal(summary, replenishedJob, error)) continue;
            throw error;
          }
        }
        seenSources.add(sourceKey);
        inventory.allSourceJobs.push(replenishedJob);
        summary.createdCount += 1;
        summary.selected.push({ id: replenishedJob.id, title: replenishedJob.source.pageTitle,
          sourceKey, reissueNumber: replenishedJob.source.reissueNumber });
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
            waiverEligibleClaimableBefore: waiverEligibleClaimableJobs,
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
      completedCooldownDays: this.completedCooldownDays,
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

function countWaiverEligibleClaimableJobs(inventory) {
  return inventory.claimableJobs.filter((job) => (
    job.onboardingWaiverEligible === true
  )).length;
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
    completedCooldownDays: parseNonNegativeInt(env.WIKIPEDIA_INGEST_COMPLETED_COOLDOWN_DAYS, 30),
    maxReissues: parseNonNegativeInt(env.WIKIPEDIA_INGEST_MAX_REISSUES, 2),
    minClaimableJobs: parseNonNegativeInt(
      env.WIKIPEDIA_INGEST_MIN_CLAIMABLE_JOBS,
      productionDefault ? 2 : 0
    )
  };
}

function wikipediaJobKey(job) {
  return wikipediaRevisionKey(job);
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

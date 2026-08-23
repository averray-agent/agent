import { ingestGithubIssues } from "../jobs/ingest-github-issues.js";
import {
  finishIngestionRun,
  recordIngestSpecHashRefusal,
  recordLanePostingRefusal,
  upsertScheduledIngestedJob
} from "./ingested-job-upsert.js";
import {
  DEFAULT_OPEN_PR_CAP_PER_REPO,
  DEFAULT_SECURITY_STANDARDS_DENYLIST,
  parseRepoList
} from "../core/maintainer-surface-policy.js";
import { GuardedSchedulerLoop, ingestionSchedulerOutcome, schedulerRunTimeoutMs } from "./guarded-scheduler-loop.js";

export class GithubIssueIngestionScheduler {
  constructor(platformService, eventBus = undefined, {
    enabled = false,
    dryRun = true,
    intervalMs = 15 * 60 * 1000,
    queries = [],
    minScore = 75,
    maxJobsPerRun = 2,
    maxJobsPerQuery = 2,
    maxOpenJobs = 20,
    openPrCap = DEFAULT_OPEN_PR_CAP_PER_REPO,
    denylistRepos = DEFAULT_SECURITY_STANDARDS_DENYLIST,
    scanRepoPolicies = false,
    githubToken = undefined,
    fetchImpl = fetch,
    logger = console
  } = {}) {
    this.platformService = platformService;
    this.eventBus = eventBus;
    this.enabled = enabled;
    this.dryRun = dryRun;
    this.intervalMs = intervalMs;
    this.queries = queries;
    this.minScore = minScore;
    this.maxJobsPerRun = maxJobsPerRun;
    this.maxJobsPerQuery = maxJobsPerQuery;
    this.maxOpenJobs = maxOpenJobs;
    this.openPrCap = openPrCap;
    this.denylistRepos = denylistRepos;
    this.scanRepoPolicies = scanRepoPolicies;
    this.githubToken = githubToken;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.timer = undefined;
    this.running = false;
    this.lastRun = undefined;
    this.schedulerLoop = new GuardedSchedulerLoop({
      host: this,
      name: "github-issue-ingestion-scheduler",
      intervalMs: this.intervalMs,
      runTimeoutMs: schedulerRunTimeoutMs(this.intervalMs),
      runOnce: (now) => this.runOnce(now),
      evaluateOutcome: (summary) => ingestionSchedulerOutcome(summary, {
        noInputReasons: ["no_queries_configured"],
        emptySourceState: "github_issue_queries_empty_repeated",
        emptySourceMessage: "Configured GitHub searches produced no eligible issues for three consecutive runs."
      }),
      logger: this.logger
    });
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
    this.schedulerLoop.stop();
  }

  async getStatus() {
    return {
      enabled: this.enabled,
      running: this.running,
      dryRun: this.dryRun,
      intervalMs: this.intervalMs,
      queryCount: this.queries.length,
      minScore: this.minScore,
      maxJobsPerRun: this.maxJobsPerRun,
      maxJobsPerQuery: this.maxJobsPerQuery,
      maxOpenJobs: this.maxOpenJobs,
      openPrCap: this.openPrCap,
      denylistRepoCount: this.denylistRepos.length,
      scanRepoPolicies: this.scanRepoPolicies,
      currentOpenJobs: this.countOpenGithubJobs(),
      parkedSpecHashRefusals: Number(this.lastRun?.parkedSpecHashRefusals ?? 0),
      lastRun: this.lastRun,
      ...this.schedulerLoop.getStatus()
    };
  }

  async runOnce(now = new Date()) {
    const startedAt = now.toISOString();
    const openGithubJobs = this.countOpenGithubJobs();
    const summary = {
      startedAt,
      finishedAt: undefined,
      dryRun: this.dryRun,
      openGithubJobs,
      candidateCount: 0,
      createdCount: 0,
      ingestRefusedSpecHashMismatchCount: 0,
      parkedSpecHashRefusals: 0,
      skipped: [],
      errors: [],
      queries: []
    };

    if (!this.enabled) {
      summary.skipped.push({ reason: "disabled" });
      return this.finishRun(summary);
    }
    if (!this.queries.length) {
      summary.skipped.push({ reason: "no_queries_configured" });
      return this.finishRun(summary);
    }
    if (openGithubJobs >= this.maxOpenJobs) {
      summary.skipped.push({ reason: "max_open_jobs_reached", openGithubJobs, maxOpenJobs: this.maxOpenJobs });
      return this.finishRun(summary);
    }

    let remaining = Math.max(0, Math.min(this.maxJobsPerRun, this.maxOpenJobs - openGithubJobs));
    const seenSources = this.existingGithubIssueKeys();
    for (const query of this.queries) {
      if (remaining <= 0) break;
      const queryLimit = Math.min(remaining, this.maxJobsPerQuery);
      const candidateLimit = Math.max(queryLimit * 3, queryLimit + 1);
      try {
        const result = await ingestGithubIssues({
          query,
          limit: candidateLimit,
          minScore: this.minScore,
          githubToken: this.githubToken,
          fetchImpl: this.fetchImpl,
          maintainerPolicy: {
            denylistRepos: this.denylistRepos,
            scanRepoPolicies: this.scanRepoPolicies,
            openPrCap: this.openPrCap
          }
        });
        summary.candidateCount += result.count;
        const querySummary = {
          query,
          candidates: result.count,
          created: 0,
          maxJobsPerQuery: queryLimit,
          skipped: []
        };
        querySummary.skipped.push(...(result.skippedDetails ?? []));
        for (const job of result.jobs) {
          if (remaining <= 0 || querySummary.created >= queryLimit) break;
          const sourceKey = githubIssueKey(job);
          if (sourceKey && seenSources.has(sourceKey)) {
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
            try {
              await upsertScheduledIngestedJob(this.platformService, job, { now });
            } catch (error) {
              if (recordLanePostingRefusal(summary, job, error)) continue;
              if (recordIngestSpecHashRefusal(summary, job, error)) continue;
              throw error;
            }
          }
          seenSources.add(sourceKey);
          querySummary.created += 1;
          summary.createdCount += 1;
          remaining -= 1;
          this.eventBus?.publish?.({
            id: `platform-github-ingest-${job.id}-${Date.now()}`,
            topic: "jobs.ingest.github",
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
        this.logger.warn?.({ query, err: error }, "github_ingest.run_failed");
      }
    }

    return this.finishRun(summary);
  }

  async runOnceAndSchedule() {
    return this.schedulerLoop.runOnceAndSchedule();
  }

  finishRun(summary) {
    return finishIngestionRun(this, summary, "github_ingest.run_complete");
  }

  countOpenGithubJobs() {
    return this.platformService.listJobs()
      .filter((job) => job.source?.type === "github_issue")
      .filter((job) => !job.recurring)
      .length;
  }

  existingGithubIssueKeys() {
    return new Set(
      this.platformService.listJobs()
        .map((job) => githubIssueKey(job))
        .filter(Boolean)
    );
  }
}

export function loadGithubIssueIngestionConfig(env = process.env) {
  const queries = parseQueries(env.GITHUB_INGEST_QUERIES_JSON ?? env.GITHUB_INGEST_QUERIES);
  return {
    enabled: parseBooleanEnv(env.GITHUB_INGEST_ENABLED),
    dryRun: env.GITHUB_INGEST_DRY_RUN === undefined ? true : parseBooleanEnv(env.GITHUB_INGEST_DRY_RUN),
    intervalMs: parsePositiveInt(env.GITHUB_INGEST_INTERVAL_MS, 15 * 60 * 1000),
    queries,
    minScore: parsePositiveInt(env.GITHUB_INGEST_MIN_SCORE, 75),
    maxJobsPerRun: parsePositiveInt(env.GITHUB_INGEST_MAX_JOBS_PER_RUN, 2),
    maxJobsPerQuery: parsePositiveInt(env.GITHUB_INGEST_MAX_JOBS_PER_QUERY, 2),
    maxOpenJobs: parsePositiveInt(env.GITHUB_INGEST_MAX_OPEN_JOBS, 20),
    openPrCap: parsePositiveInt(env.MAINTAINER_OPEN_PR_CAP ?? env.GITHUB_INGEST_OPEN_PR_CAP, DEFAULT_OPEN_PR_CAP_PER_REPO),
    denylistRepos: [
      ...DEFAULT_SECURITY_STANDARDS_DENYLIST,
      ...parseRepoList(env.MAINTAINER_DENYLIST_REPOS ?? env.GITHUB_INGEST_DENYLIST_REPOS)
    ],
    scanRepoPolicies: parseBooleanEnv(env.GITHUB_INGEST_POLICY_SCAN_ENABLED),
    githubToken: env.GITHUB_TOKEN?.trim() || undefined
  };
}

function githubIssueKey(job) {
  const source = job?.source;
  if (source?.type !== "github_issue" || !source.repo || !source.issueNumber) {
    return undefined;
  }
  return `${String(source.repo).toLowerCase()}#${Number(source.issueNumber)}`;
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

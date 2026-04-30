import { PlatformService } from "../core/platform-service.js";
import { createStateStore } from "../core/state-store.js";
import { BlockchainGateway } from "../blockchain/gateway.js";
import { VerifierService } from "./verifier-service.js";
import { loadLocalEnv } from "./env-loader.js";
import { PimlicoClient } from "./pimlico-client.js";
import { EventBus } from "../core/event-bus.js";
import { EventListener } from "../blockchain/event-listener.js";
import { loadAuthConfig } from "../auth/config.js";
import { createAuthMiddleware } from "../auth/middleware.js";
import { createRateLimiter } from "../auth/rate-limit.js";
import { resolveCapabilities, capabilityMatrix } from "../auth/capabilities.js";
import { createLogger } from "../core/logger.js";
import { MetricRegistry } from "../core/metrics.js";
import { createObservability } from "../core/observability.js";
import { createContentRecoveryLog } from "../core/content-recovery-log.js";
import { RecurringSchedulerService } from "./recurring-scheduler.js";
import {
  GithubIssueIngestionScheduler,
  loadGithubIssueIngestionConfig
} from "./github-issue-ingestion-scheduler.js";
import {
  WikipediaMaintenanceIngestionScheduler,
  loadWikipediaMaintenanceIngestionConfig
} from "./wikipedia-maintenance-ingestion-scheduler.js";
import {
  OsvAdvisoryIngestionScheduler,
  loadOsvAdvisoryIngestionConfig
} from "./osv-advisory-ingestion-scheduler.js";
import {
  OpenDataIngestionScheduler,
  loadOpenDataIngestionConfig
} from "./open-data-ingestion-scheduler.js";
import {
  StandardsSpecIngestionScheduler,
  loadStandardsSpecIngestionConfig
} from "./standards-spec-ingestion-scheduler.js";
import {
  OpenApiSpecIngestionScheduler,
  loadOpenApiSpecIngestionConfig
} from "./openapi-spec-ingestion-scheduler.js";
import { XcmSettlementWatcherService } from "./xcm-settlement-watcher.js";
import { XcmObservationRelayService } from "./xcm-observation-relay.js";
import {
  UpstreamStatusPollerService,
  loadUpstreamStatusPollerConfig
} from "./upstream-status-poller.js";
import {
  JobStaleSweeperService,
  loadJobStaleSweeperConfig
} from "./job-stale-sweeper.js";
import { normaliseStrategyAssetConfig } from "./strategy-asset-config.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
loadLocalEnv(process.cwd(), resolve(moduleDir, "../../"));

const jobs = [
  {
    id: "starter-coding-001",
    category: "coding",
    tier: "starter",
    rewardAsset: "DOT",
    rewardAmount: 5,
    verifierMode: "benchmark",
    verifierConfig: {
      handler: "benchmark",
      requiredKeywords: ["complete", "verified", "output"],
      minimumMatches: 2
    },
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: "schema://jobs/coding-output",
    claimTtlSeconds: 3600,
    retryLimit: 1,
    requiresSponsoredGas: true
  },
  {
    id: "governance-pro-001",
    category: "governance",
    tier: "pro",
    rewardAsset: "DOT",
    rewardAmount: 25,
    verifierMode: "deterministic",
    verifierConfig: {
      handler: "deterministic",
      expectedOutputs: ["governance-approved-summary", "vote-yes rationale"],
      matchMode: "contains_all"
    },
    inputSchemaRef: "schema://jobs/governance-input",
    outputSchemaRef: "schema://jobs/governance-output",
    claimTtlSeconds: 7200,
    retryLimit: 2,
    requiresSponsoredGas: false
  }
];

const profiles = new Map([
  ["0xagent", {
    wallet: "0xagent",
    capabilities: ["claim_job", "submit_work", "allocate_idle_funds"],
    supportedProtocols: ["mcp", "http"],
    preferredCategories: ["coding", "governance"],
    preferredRiskLevel: "low",
    verifierCompatibility: ["benchmark", "deterministic", "human_fallback", "github_pr"],
    minLiquidReserve: 10,
    autoUnwindStrategies: false
  }]
]);

const accounts = new Map([
  ["0xagent", {
    wallet: "0xagent",
    liquid: { DOT: 25 },
    reserved: { DOT: 0 },
    strategyAllocated: { DOT: 5 },
    collateralLocked: { DOT: 10 },
    jobStakeLocked: { DOT: 0 },
    debtOutstanding: { DOT: 0 }
  }]
]);

const reputations = new Map([
  ["0xagent", {
    skill: 50,
    reliability: 75,
    economic: 25,
    tier: "starter"
  }]
]);

export function createPlatformService() {
  const gateway = new BlockchainGateway();
  const stateStore = createStateStore();
  const eventBus = new EventBus();
  return new PlatformService(jobs, profiles, accounts, reputations, gateway, stateStore, eventBus);
}

export async function createPlatformRuntime() {
  const logger = createLogger({
    name: "agent-platform",
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug")
  });
  const metrics = initStep("init-metrics", logger, () => createMetrics());
  const observability = await createObservability({ logger });

  // Each init step is wrapped so a failing step logs a structured error with
  // the step name before the process exits. Without this, a cryptic stack
  // trace is the only signal that a required env var was missing.
  const authConfig = initStep("load-auth-config", logger, () => loadAuthConfig());
  const gateway = initStep("init-blockchain-gateway", logger, () => new BlockchainGateway());
  const pimlicoClient = initStep("init-pimlico-client", logger, () => new PimlicoClient());
  const stateStore = initStep("init-state-store", logger, () => createStateStore(process.env, { logger }));
  const contentRecoveryLog = initStep("init-content-recovery-log", logger, () =>
    createContentRecoveryLog(process.env, { logger })
  );
  const eventBus = initStep("init-event-bus", logger, () => new EventBus());
  const platformService = initStep(
    "init-platform-service",
    logger,
    () => new PlatformService(jobs, profiles, accounts, reputations, gateway, stateStore, eventBus)
  );
  const verifierService = initStep(
    "init-verifier-service",
    logger,
    () => new VerifierService(platformService, stateStore, gateway)
  );
  const eventListener = initStep("init-event-listener", logger, () =>
    gateway.isEnabled() ? new EventListener(gateway, eventBus, stateStore) : undefined
  );
  void eventListener?.start?.();
  const recurringScheduler = initStep("init-recurring-scheduler", logger, () =>
    new RecurringSchedulerService(platformService, eventBus, {
      enabled: parseBooleanEnv(process.env.RECURRING_SCHEDULER_ENABLED),
      logger
    })
  );
  const githubIssueIngestionScheduler = initStep("init-github-issue-ingestion-scheduler", logger, () =>
    new GithubIssueIngestionScheduler(platformService, eventBus, {
      ...loadGithubIssueIngestionConfig(process.env),
      logger
    })
  );
  const wikipediaMaintenanceIngestionScheduler = initStep("init-wikipedia-maintenance-ingestion-scheduler", logger, () =>
    new WikipediaMaintenanceIngestionScheduler(platformService, eventBus, {
      ...loadWikipediaMaintenanceIngestionConfig(process.env),
      logger
    })
  );
  const osvAdvisoryIngestionScheduler = initStep("init-osv-advisory-ingestion-scheduler", logger, () =>
    new OsvAdvisoryIngestionScheduler(platformService, eventBus, {
      ...loadOsvAdvisoryIngestionConfig(process.env),
      logger
    })
  );
  const openDataIngestionScheduler = initStep("init-open-data-ingestion-scheduler", logger, () =>
    new OpenDataIngestionScheduler(platformService, eventBus, {
      ...loadOpenDataIngestionConfig(process.env),
      logger
    })
  );
  const standardsSpecIngestionScheduler = initStep("init-standards-spec-ingestion-scheduler", logger, () =>
    new StandardsSpecIngestionScheduler(platformService, eventBus, {
      ...loadStandardsSpecIngestionConfig(process.env),
      logger
    })
  );
  const openApiSpecIngestionScheduler = initStep("init-openapi-spec-ingestion-scheduler", logger, () =>
    new OpenApiSpecIngestionScheduler(platformService, eventBus, {
      ...loadOpenApiSpecIngestionConfig(process.env),
      logger
    })
  );
  const xcmSettlementWatcher = initStep("init-xcm-settlement-watcher", logger, () =>
    new XcmSettlementWatcherService(platformService, stateStore, eventBus, {
      enabled: process.env.XCM_SETTLEMENT_WATCHER_ENABLED === undefined
        ? gateway.isEnabled()
        : parseBooleanEnv(process.env.XCM_SETTLEMENT_WATCHER_ENABLED),
      pollIntervalMs: parsePositiveInt(process.env.XCM_SETTLEMENT_WATCHER_POLL_MS, 15_000),
      logger
    })
  );
  const xcmObservationRelay = initStep("init-xcm-observation-relay", logger, () =>
    new XcmObservationRelayService(platformService, stateStore, eventBus, {
      enabled: process.env.XCM_OBSERVER_ENABLED === undefined
        ? (gateway.isEnabled() && Boolean(process.env.XCM_OBSERVER_FEED_URL?.trim()))
        : parseBooleanEnv(process.env.XCM_OBSERVER_ENABLED),
      feedUrl: process.env.XCM_OBSERVER_FEED_URL?.trim(),
      authToken: process.env.XCM_OBSERVER_AUTH_TOKEN?.trim(),
      pollIntervalMs: parsePositiveInt(process.env.XCM_OBSERVER_POLL_MS, 30_000),
      batchSize: parsePositiveInt(process.env.XCM_OBSERVER_BATCH_SIZE, 25),
      logger
    })
  );
  const upstreamStatusPoller = initStep("init-upstream-status-poller", logger, () =>
    new UpstreamStatusPollerService(stateStore, eventBus, {
      ...loadUpstreamStatusPollerConfig(process.env),
      logger
    })
  );
  const jobStaleSweeper = initStep("init-job-stale-sweeper", logger, () =>
    new JobStaleSweeperService(platformService, stateStore, eventBus, {
      ...loadJobStaleSweeperConfig(process.env),
      logger
    })
  );
  platformService.recurringScheduler = recurringScheduler;
  platformService.githubIssueIngestionScheduler = githubIssueIngestionScheduler;
  platformService.wikipediaMaintenanceIngestionScheduler = wikipediaMaintenanceIngestionScheduler;
  platformService.osvAdvisoryIngestionScheduler = osvAdvisoryIngestionScheduler;
  platformService.openDataIngestionScheduler = openDataIngestionScheduler;
  platformService.standardsSpecIngestionScheduler = standardsSpecIngestionScheduler;
  platformService.openApiSpecIngestionScheduler = openApiSpecIngestionScheduler;
  platformService.xcmSettlementWatcher = xcmSettlementWatcher;
  platformService.xcmObservationRelay = xcmObservationRelay;
  platformService.upstreamStatusPoller = upstreamStatusPoller;
  platformService.jobStaleSweeper = jobStaleSweeper;
  recurringScheduler.start();
  githubIssueIngestionScheduler.start();
  wikipediaMaintenanceIngestionScheduler.start();
  osvAdvisoryIngestionScheduler.start();
  openDataIngestionScheduler.start();
  standardsSpecIngestionScheduler.start();
  openApiSpecIngestionScheduler.start();
  xcmSettlementWatcher.start();
  xcmObservationRelay.start();
  upstreamStatusPoller.start();
  jobStaleSweeper.start();

  const authMiddleware = createAuthMiddleware({ authConfig, stateStore, logger });
  const rateLimiter = createRateLimiter({ stateStore, logger });
  const rateLimitConfig = loadRateLimitConfig();
  const httpConfig = loadHttpConfig();
  const strategies = loadStrategiesConfig(process.env, { logger });
  const trustProxy = parseBooleanEnv(process.env.TRUST_PROXY);
  if (authConfig.permissive) {
    logger.warn(
      { mode: "permissive" },
      "AUTH_MODE=permissive — legacy ?wallet= is accepted without signature. Do not use in production."
    );
  }
  return {
    platformService,
    verifierService,
    gateway,
    pimlicoClient,
    stateStore,
    contentRecoveryLog,
    eventBus,
    eventListener,
    recurringScheduler,
    githubIssueIngestionScheduler,
    wikipediaMaintenanceIngestionScheduler,
    osvAdvisoryIngestionScheduler,
    openDataIngestionScheduler,
    standardsSpecIngestionScheduler,
    openApiSpecIngestionScheduler,
    xcmSettlementWatcher,
    xcmObservationRelay,
    upstreamStatusPoller,
    jobStaleSweeper,
    authConfig,
    authMiddleware,
    authCapabilities: {
      resolveCapabilities,
      capabilityMatrix
    },
    rateLimiter,
    rateLimitConfig,
    httpConfig,
    strategies,
    trustProxy,
    logger,
    metrics,
    observability
  };
}

function createMetrics() {
  const registry = new MetricRegistry();
  registry.counter("http_requests_total", "Total HTTP requests served.", ["method", "path", "status"]);
  registry.histogram("http_request_duration_ms", "Request duration in milliseconds.", ["method", "path"]);
  registry.counter("auth_failures_total", "Auth or authorization failures by code.", ["code"]);
  registry.counter("rate_limit_rejections_total", "Rate-limit rejections by bucket.", ["bucket"]);
  registry.gauge("sse_active_connections", "Currently open SSE connections.");
  registry.gauge("state_store_backend", "1 when state store backend matches the label.", ["backend"]);
  return registry;
}

function initStep(name, logger, factory) {
  try {
    return factory();
  } catch (error) {
    logger.error(
      { step: name, err: error instanceof Error ? error : new Error(String(error)) },
      "bootstrap.init_failed"
    );
    throw error;
  }
}

function loadRateLimitConfig(env = process.env) {
  return {
    authNonce: buildLimit(env, "RATE_LIMIT_AUTH_NONCE", { limit: 10, windowSeconds: 60 }),
    authVerify: buildLimit(env, "RATE_LIMIT_AUTH_VERIFY", { limit: 10, windowSeconds: 60 }),
    adminJobs: buildLimit(env, "RATE_LIMIT_ADMIN_JOBS", { limit: 60, windowSeconds: 60 }),
    verifierRun: buildLimit(env, "RATE_LIMIT_VERIFIER_RUN", { limit: 120, windowSeconds: 60 }),
    events: buildLimit(env, "RATE_LIMIT_EVENTS", { limit: 30, windowSeconds: 60 })
  };
}

export function loadHttpConfig(env = process.env) {
  const maxBodyBytes = parsePositiveInt(env.HTTP_MAX_BODY_BYTES, 64 * 1024); // 64 KiB default
  const allowedOrigins = (env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowAllOrigins = allowedOrigins.includes("*");
  return {
    maxBodyBytes,
    allowedOrigins: new Set(allowedOrigins),
    allowAllOrigins,
    allowedMethods: "GET, POST, OPTIONS",
    allowedHeaders: "authorization, content-type, last-event-id, x-request-id",
    exposedHeaders: "x-request-id, retry-after",
    maxAgeSeconds: parsePositiveInt(env.CORS_MAX_AGE_SECONDS, 600)
  };
}

function buildLimit(env, prefix, defaults) {
  const limit = parsePositiveInt(env[`${prefix}_LIMIT`], defaults.limit);
  const windowSeconds = parsePositiveInt(env[`${prefix}_WINDOW_SECONDS`], defaults.windowSeconds);
  return { limit, windowSeconds };
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

/**
 * Load the list of registered strategy adapters the backend should
 * surface at `GET /strategies`. Operators populate `STRATEGIES_JSON`
 * with the `strategies` array copied verbatim from the deployment
 * manifest (deployments/<profile>.json). Invalid JSON logs a warning and
 * falls back to an empty list rather than crashing the boot — strategy
 * discovery is a nice-to-have, not a boot-blocking dependency.
 */
export function loadStrategiesConfig(env = process.env, { logger = console } = {}) {
  const raw = (env.STRATEGIES_JSON ?? "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("STRATEGIES_JSON must decode to an array");
    }
    return parsed.map((entry, idx) => normaliseStrategyEntry(entry, idx));
  } catch (error) {
    logger.warn?.(
      { err: error instanceof Error ? error : new Error(String(error)) },
      "strategies.config_parse_failed"
    );
    return [];
  }
}

function normaliseStrategyEntry(entry, idx) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`strategies[${idx}] must be an object`);
  }
  const { strategyId, adapter, kind, riskLabel, asset, executionMode, xcm } = entry;
  const assetConfig = normaliseStrategyAssetConfig(asset, idx);
  if (typeof strategyId !== "string" || !/^0x[a-fA-F0-9]{64}$/u.test(strategyId)) {
    throw new Error(`strategies[${idx}].strategyId must be 0x + 32-byte hex`);
  }
  if (typeof adapter !== "string" || !/^0x[a-fA-F0-9]{40}$/u.test(adapter)) {
    throw new Error(`strategies[${idx}].adapter must be 0x + 20-byte EVM address`);
  }
  return {
    strategyId,
    adapter: adapter.toLowerCase(),
    kind: typeof kind === "string" ? kind : "unknown",
    executionMode: normaliseStrategyExecutionMode(executionMode, typeof kind === "string" ? kind : "unknown", idx),
    riskLabel: typeof riskLabel === "string" ? riskLabel : "",
    asset: assetConfig?.address,
    assetConfig,
    xcm: normaliseStrategyXcmConfig(xcm, idx)
  };
}

function normaliseStrategyXcmConfig(xcm, idx) {
  if (xcm === undefined || xcm === null) {
    return undefined;
  }
  if (typeof xcm !== "object" || Array.isArray(xcm)) {
    throw new Error(`strategies[${idx}].xcm must be an object`);
  }
  if (
    xcm.messagePrefixes !== undefined ||
    xcm.messages !== undefined ||
    xcm.depositMessagePrefix !== undefined ||
    xcm.withdrawMessagePrefix !== undefined
  ) {
    throw new Error(
      `strategies[${idx}].xcm must not include raw message prefixes; the backend assembles XCM from intent`
    );
  }
  const destinationParachain = xcm.destinationParachain ?? xcm.destinationParaId;
  const normalized = {};
  if (!(destinationParachain === undefined || destinationParachain === null || destinationParachain === "")) {
    const parsed = Number(destinationParachain);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
      throw new Error(`strategies[${idx}].xcm.destinationParachain must be a uint32`);
    }
    normalized.destinationParachain = parsed;
  }
  for (const key of [
    "originChain",
    "destinationChain",
    "feeAmount",
    "executionFeeAmount",
    "depositFeeAmount",
    "withdrawFeeAmount",
    "amount",
    "depositAmount",
    "withdrawAmount",
    "beneficiary",
    "beneficiaryLocation",
    "depositBeneficiary",
    "depositBeneficiaryLocation",
    "withdrawBeneficiary",
    "withdrawBeneficiaryLocation",
    "assetLocation",
    "feeAssetLocation"
  ]) {
    if (xcm[key] !== undefined) {
      normalized[key] = xcm[key];
    }
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

function normaliseStrategyExecutionMode(rawExecutionMode, kind, idx) {
  if (rawExecutionMode === undefined || rawExecutionMode === null || rawExecutionMode === "") {
    if (String(kind).trim().toLowerCase() === "polkadot_vdot") {
      return "async_xcm";
    }
    return "sync";
  }
  if (typeof rawExecutionMode !== "string") {
    throw new Error(`strategies[${idx}].executionMode must be a string`);
  }
  const normalized = rawExecutionMode.trim().toLowerCase().replace(/[\s-]+/gu, "_");
  if (normalized === "sync" || normalized === "async_xcm") {
    return normalized;
  }
  throw new Error(`strategies[${idx}].executionMode must be "sync" or "async_xcm"`);
}

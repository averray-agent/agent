import { randomUUID } from "node:crypto";

import { ConfigError, AppError } from "./errors.js";
import { isExternalJob } from "./external-job-lifecycle.js";
import { decimalToBaseUnits, formatBaseUnits } from "./platform-service-helpers.js";
import { isHostedCanaryClaimant } from "./claimant-attribution.js";
import { SelfIdentityRegistry } from "./self-identity-registry.js";

export const CATALOGUE_LANE_PACKET = "PACKET_D3_LANE_DISCIPLINE.md";
export const CATALOGUE_LANE_STATE_SCOPE = "catalogue-lane-discipline-v1";
export const LANE_BUDGET_EXHAUSTED = "lane_budget_exhausted";
export const LANE_PAUSED = "lane_paused";

const USDC_DECIMALS = 6;
const DAY_MS = 24 * 60 * 60 * 1_000;
const RETAINED_WINDOW_MS = 14 * DAY_MS;
const COST_WINDOW_MS = 30 * DAY_MS;
const MAX_SESSION_RECORDS = 10_000;
const POSTING_LOCK_TTL_SECONDS = 300;

export const DEFAULT_CATALOGUE_LANE_REGISTRY = Object.freeze({
  liveness: Object.freeze({
    hypothesis: "Proof-of-life for the board; 0.10 USDC buys it as well as 0.25 USDC.",
    dailyCapRaw: "3000000",
    stopCondition: "Zero external claimants for 14 consecutive days.",
    paused: false
  }),
  "oss-anchored": Object.freeze({
    hypothesis: "Public artifacts and maintainer relationships create an external-worker funnel.",
    dailyCapRaw: "15000000",
    stopCondition: "Cost per retained external worker exceeds 25 USDC over a trailing 30-day window.",
    paused: false
  }),
  "benchmark-showcase": Object.freeze({
    hypothesis: "Verification coverage and demonstrable work provide a useful showcase.",
    dailyCapRaw: "5000000",
    stopCondition: "Real external demand supersedes catalogue work in the same category.",
    paused: false
  })
});

export class CatalogueLanePostingError extends AppError {
  constructor(reason, message, details) {
    super(message, {
      name: "CatalogueLanePostingError",
      code: reason,
      statusCode: 409,
      details
    });
  }
}

export function loadCatalogueLaneRegistry(env = process.env) {
  const raw = env.CATALOGUE_LANE_REGISTRY_JSON;
  if (raw === undefined || String(raw).trim() === "") {
    return validateCatalogueLaneRegistry(DEFAULT_CATALOGUE_LANE_REGISTRY);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw packetConfigError(`CATALOGUE_LANE_REGISTRY_JSON is not valid JSON: ${error.message}`);
  }
  return validateCatalogueLaneRegistry(parsed);
}

export function validateCatalogueLaneRegistry(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw packetConfigError("the catalogue lane registry must be an object keyed by lane id");
  }
  const registry = new Map();
  for (const [rawId, rawEntry] of Object.entries(input)) {
    const id = normalizeLaneId(rawId);
    if (!id || id !== rawId) {
      throw packetConfigError(`lane id ${JSON.stringify(rawId)} must be a normalized kebab-case id`);
    }
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      throw packetConfigError(`lane ${id} must be an object`);
    }
    for (const field of ["hypothesis", "dailyCapRaw", "stopCondition"]) {
      if (rawEntry[field] === undefined || rawEntry[field] === null || rawEntry[field] === "") {
        throw packetConfigError(`lane ${id} is missing ${field}`);
      }
    }
    const hypothesis = requiredText(rawEntry.hypothesis, `lane ${id} hypothesis`);
    const stopCondition = requiredText(rawEntry.stopCondition, `lane ${id} stopCondition`);
    const dailyCapRaw = rawUnits(rawEntry.dailyCapRaw, `lane ${id} dailyCapRaw`);
    registry.set(id, Object.freeze({
      id,
      hypothesis,
      dailyCapRaw,
      stopCondition,
      paused: rawEntry.paused === true
    }));
  }
  if (registry.size === 0) throw packetConfigError("the catalogue lane registry must not be empty");
  return registry;
}

export function assertCatalogueDefinitionsHaveLanes(definitions, registry) {
  for (const definition of definitions ?? []) validateCatalogueDefinitionLane(definition, registry);
}

export function validateCatalogueDefinitionLane(definition, registry) {
  if (isExternalJob(definition)) return undefined;
  const id = String(definition?.id ?? "unknown");
  const lane = normalizeLaneId(definition?.lane);
  if (!lane) throw packetConfigError(`catalogue definition ${id} is missing lane`);
  if (!registry?.has?.(lane)) {
    throw packetConfigError(`catalogue definition ${id} references unknown lane ${lane}`);
  }
  return registry.get(lane);
}

export function createCatalogueLaneDiscipline({
  stateStore,
  registry = loadCatalogueLaneRegistry(),
  gasEstimateUsdc,
  selfWallets = new Set(),
  selfIdentityRegistry,
  now = () => new Date(),
  logger = console
} = {}) {
  return new CatalogueLaneDiscipline({
    stateStore,
    registry,
    gasEstimateUsdc,
    selfWallets,
    selfIdentityRegistry,
    now,
    logger
  });
}

export class CatalogueLaneDiscipline {
  constructor({ stateStore, registry, gasEstimateUsdc = 0.059, selfWallets, selfIdentityRegistry, now, logger } = {}) {
    if (typeof stateStore?.getServiceState !== "function" || typeof stateStore?.upsertServiceState !== "function") {
      throw packetConfigError("lane posting budgets require durable service-state reads and writes");
    }
    if (typeof stateStore?.listRecentSessions !== "function") {
      throw packetConfigError("lane board metrics require global session pagination");
    }
    if (typeof stateStore?.acquireClaimLock !== "function" || typeof stateStore?.releaseClaimLock !== "function") {
      throw packetConfigError("lane posting budgets require a durable posting lock");
    }
    this.stateStore = stateStore;
    this.registry = registry instanceof Map ? registry : validateCatalogueLaneRegistry(registry);
    this.expectedBrokeredGasRaw = decimalToBaseUnits(gasEstimateUsdc, USDC_DECIMALS, "expected brokered gas");
    this.selfIdentityRegistry = selfIdentityRegistry instanceof SelfIdentityRegistry
      ? selfIdentityRegistry
      : new SelfIdentityRegistry({ operatorWallets: selfWallets });
    this.now = now ?? (() => new Date());
    this.logger = logger ?? console;
    this.queue = Promise.resolve();
  }

  async post(job, action, { now = this.now() } = {}) {
    if (isExternalJob(job)) return action();
    const run = async () => this.#postSerial(job, action, asDate(now));
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async #postSerial(job, action, evaluatedAt) {
    const lane = validateCatalogueDefinitionLane(job, this.registry);
    if (lane.paused) {
      throw new CatalogueLanePostingError(
        LANE_PAUSED,
        `Catalogue lane ${lane.id} is paused by the operator. Retry after the lane is resumed.`,
        { lane: lane.id, retryWhen: "operator_resumes_lane" }
      );
    }

    // All lanes share one durable ledger document, so the cross-process lock
    // is global even though caps are evaluated independently per lane.
    const lockId = `${CATALOGUE_LANE_STATE_SCOPE}:posting`;
    const lockOwner = randomUUID();
    const acquired = await this.stateStore.acquireClaimLock(lockId, lockOwner, POSTING_LOCK_TTL_SECONDS);
    if (!acquired) {
      throw new CatalogueLanePostingError(
        "catalogue_lane_posting_busy",
        `Catalogue lane ${lane.id} is processing another posting. Retry on the next scheduler run.`,
        { lane: lane.id, retryWhen: "next_scheduler_run" }
      );
    }
    try {
      return await this.#postUnderLock(job, action, evaluatedAt, lane);
    } finally {
      await this.stateStore.releaseClaimLock(lockId, lockOwner);
    }
  }

  async #postUnderLock(job, action, evaluatedAt, lane) {
    const state = await this.#readState();
    const records = pruneRecords(state.records, evaluatedAt);
    const existing = records.find((record) => record.jobId === String(job.id));
    const candidate = candidateRecord(job, lane.id, evaluatedAt, this.expectedBrokeredGasRaw);
    const active = records.filter((record) => withinWindow(record.postedAt, evaluatedAt, DAY_MS));
    const usedRaw = sumRaw(active.filter((record) => record.lane === lane.id));
    const candidateRaw = existing ? 0n : BigInt(candidate.totalRaw);
    const projectedRaw = usedRaw + candidateRaw;

    if (projectedRaw > lane.dailyCapRaw) {
      const resumeAt = resumeTime(active, lane.id, candidateRaw, lane.dailyCapRaw, evaluatedAt);
      const details = {
        lane: lane.id,
        capRaw: lane.dailyCapRaw.toString(),
        usedRaw: usedRaw.toString(),
        candidateRaw: candidateRaw.toString(),
        projectedRaw: projectedRaw.toString(),
        resumeAt: resumeAt ?? null,
        retryWhen: resumeAt ? "earlier_lane_exposure_ages_out" : "operator_raises_cap_or_reprices_job"
      };
      this.logger.info?.(details, LANE_BUDGET_EXHAUSTED);
      throw new CatalogueLanePostingError(
        LANE_BUDGET_EXHAUSTED,
        resumeAt
          ? `Catalogue lane ${lane.id} has exhausted its rolling 24-hour posting budget. Retry at ${resumeAt}.`
          : `Job ${job.id} cannot fit within catalogue lane ${lane.id}. Retry after the operator raises the cap or reprices the job.`,
        details
      );
    }

    const reserved = existing ? records : [...records, { ...candidate, state: "reserved" }];
    if (!existing) await this.#writeRecords(reserved, evaluatedAt);
    try {
      const posted = await action();
      if (!existing) {
        const current = pruneRecords((await this.#readState()).records, evaluatedAt);
        const completed = current.some((record) => record.jobId === candidate.jobId)
          ? current.map((record) => record.jobId === candidate.jobId ? { ...record, state: "posted" } : record)
          : [...current, { ...candidate, state: "posted" }];
        await this.#writeRecords(
          completed,
          evaluatedAt
        );
      }
      return posted;
    } catch (error) {
      if (!existing) {
        const current = pruneRecords((await this.#readState()).records, evaluatedAt);
        await this.#writeRecords(current.filter((record) => record.jobId !== candidate.jobId), evaluatedAt);
      }
      throw error;
    }
  }

  async getBoardSnapshot({ now = this.now() } = {}) {
    const evaluatedAt = asDate(now);
    const state = await this.#readState();
    const records = pruneRecords(state.records, evaluatedAt);
    const sessions = await collectSessions(this.stateStore);
    const claimantMetrics = buildClaimantMetrics(
      sessions,
      this.registry,
      this.selfIdentityRegistry,
      evaluatedAt
    );

    return {
      version: "catalogue-lanes-v1",
      generatedAt: evaluatedAt.toISOString(),
      exposureWindowSeconds: DAY_MS / 1_000,
      retainedWindowSeconds: RETAINED_WINDOW_MS / 1_000,
      costWindowSeconds: COST_WINDOW_MS / 1_000,
      lanes: [...this.registry.values()].map((lane) => {
        const active = records.filter(
          (record) => record.lane === lane.id && withinWindow(record.postedAt, evaluatedAt, DAY_MS)
        );
        const usedRaw = sumRaw(active);
        const remainingRaw = lane.dailyCapRaw > usedRaw ? lane.dailyCapRaw - usedRaw : 0n;
        const metrics = claimantMetrics.get(lane.id) ?? emptyClaimantMetrics();
        return {
          id: lane.id,
          paused: lane.paused,
          hypothesis: lane.hypothesis,
          stopCondition: lane.stopCondition,
          exposure24h: {
            usedRaw: usedRaw.toString(),
            capRaw: lane.dailyCapRaw.toString(),
            remainingRaw: remainingRaw.toString(),
            used: formatBaseUnits(usedRaw, USDC_DECIMALS),
            cap: formatBaseUnits(lane.dailyCapRaw, USDC_DECIMALS),
            remaining: formatBaseUnits(remainingRaw, USDC_DECIMALS)
          },
          jobsPosted24h: active.length,
          ...metrics
        };
      })
    };
  }

  async #readState() {
    const stored = await this.stateStore.getServiceState(CATALOGUE_LANE_STATE_SCOPE);
    return stored && typeof stored === "object" ? stored : { records: [] };
  }

  async #writeRecords(records, evaluatedAt) {
    await this.stateStore.upsertServiceState(CATALOGUE_LANE_STATE_SCOPE, {
      version: "catalogue-lane-ledger-v1",
      records,
      evaluatedAt: evaluatedAt.toISOString()
    });
  }
}

function candidateRecord(job, lane, postedAt, expectedBrokeredGasRaw) {
  if (String(job?.rewardAsset ?? "USDC").toUpperCase() !== "USDC") {
    throw packetConfigError(`catalogue definition ${job?.id ?? "unknown"} rewardAsset must be USDC for lane accounting`);
  }
  const rewardRaw = decimalToBaseUnits(job.rewardAmount, USDC_DECIMALS, `job ${job.id} reward`);
  return {
    reservationId: randomUUID(),
    jobId: String(job.id),
    lane,
    postedAt: postedAt.toISOString(),
    rewardRaw: rewardRaw.toString(),
    expectedBrokeredGasRaw: expectedBrokeredGasRaw.toString(),
    totalRaw: (rewardRaw + expectedBrokeredGasRaw).toString()
  };
}

function buildClaimantMetrics(sessions, registry, selfIdentityRegistry, now) {
  const byLane = new Map([...registry.keys()].map((lane) => [lane, {
    recentWallets: new Map(),
    paid30Raw: 0n,
    omittedSettlementCount30d: 0
  }]));
  const firstLaneByWallet = new Map();
  const lastSettlementByWallet = new Map();
  const ordered = [...sessions].sort((left, right) => sessionTimestamp(left) - sessionTimestamp(right));

  for (const session of ordered) {
    const lane = normalizeLaneId(session?.jobSnapshot?.definition?.lane);
    const wallet = normalizeWallet(session?.wallet);
    if (!lane || !registry.has(lane) || !wallet || isHostedCanaryClaimant(session)) continue;
    const external = !selfIdentityRegistry.isSelf({ wallet, session });
    if (external && !firstLaneByWallet.has(wallet)) firstLaneByWallet.set(wallet, lane);
    const claimedAt = sessionTimestamp(session);
    if (claimedAt > now.getTime() - DAY_MS) byLane.get(lane).recentWallets.set(wallet, external);

    const settledAt = settlementTimestamp(session);
    if (!Number.isFinite(settledAt)) continue;
    const payoutRaw = settledPayoutRaw(session);
    if (external && settledAt > (lastSettlementByWallet.get(wallet) ?? 0)) {
      lastSettlementByWallet.set(wallet, settledAt);
    }
    if (settledAt > now.getTime() - COST_WINDOW_MS) {
      if (payoutRaw === null) byLane.get(lane).omittedSettlementCount30d += 1;
      else byLane.get(lane).paid30Raw += payoutRaw;
    }
  }

  const retainedByLane = new Map([...registry.keys()].map((lane) => [lane, 0]));
  for (const [wallet, lane] of firstLaneByWallet) {
    if ((lastSettlementByWallet.get(wallet) ?? 0) > now.getTime() - RETAINED_WINDOW_MS) {
      retainedByLane.set(lane, retainedByLane.get(lane) + 1);
    }
  }

  const output = new Map();
  for (const [lane, aggregate] of byLane) {
    const claimantCount = aggregate.recentWallets.size;
    const externalClaimantCount = [...aggregate.recentWallets.values()].filter(Boolean).length;
    const retained = retainedByLane.get(lane);
    const costRaw = retained > 0 ? aggregate.paid30Raw / BigInt(retained) : null;
    output.set(lane, {
      claimantShare24h: {
        claimantCount,
        externalClaimantCount,
        externalShareBps: claimantCount > 0 ? Math.floor((externalClaimantCount * 10_000) / claimantCount) : 0
      },
      retainedExternalWorkers14d: retained,
      costPerRetainedExternalWorker30d: {
        raw: costRaw?.toString() ?? null,
        usdc: costRaw === null ? null : formatBaseUnits(costRaw, USDC_DECIMALS),
        complete: aggregate.omittedSettlementCount30d === 0,
        omittedSettlementCount: aggregate.omittedSettlementCount30d,
        ...(retained === 0 ? { reason: "no_retained_external_workers" } : {})
      }
    });
  }
  return output;
}

function emptyClaimantMetrics() {
  return {
    claimantShare24h: { claimantCount: 0, externalClaimantCount: 0, externalShareBps: 0 },
    retainedExternalWorkers14d: 0,
    costPerRetainedExternalWorker30d: {
      raw: null,
      usdc: null,
      complete: true,
      omittedSettlementCount: 0,
      reason: "no_retained_external_workers"
    }
  };
}

function settledPayoutRaw(session) {
  const settlement = session?.payoutTx?.settlement;
  if (Number(session?.payoutTx?.status) !== 1) return null;
  if (String(settlement?.assetSymbol ?? "").toUpperCase() !== "USDC") return null;
  const raw = settlement?.workerAmountRaw;
  return typeof raw === "string" && /^(0|[1-9][0-9]*)$/u.test(raw) ? BigInt(raw) : null;
}

function settlementTimestamp(session) {
  return Date.parse(session?.resolvedAt ?? session?.rejectedAt ?? session?.closedAt ?? "");
}

function sessionTimestamp(session) {
  return Date.parse(session?.claimedAt ?? session?.createdAt ?? session?.updatedAt ?? "") || 0;
}

async function collectSessions(stateStore) {
  const sessions = [];
  const pageSize = 100;
  for (let offset = 0; offset < MAX_SESSION_RECORDS; offset += pageSize) {
    const page = await stateStore.listRecentSessions?.(pageSize, offset) ?? [];
    if (!Array.isArray(page)) throw new Error("catalogue lane board session source returned a non-array page");
    sessions.push(...page);
    if (page.length < pageSize) return sessions;
  }
  throw new Error(`catalogue lane board exceeded its ${MAX_SESSION_RECORDS}-session read bound`);
}

function resumeTime(records, lane, candidateRaw, capRaw, now) {
  let projected = sumRaw(records.filter((record) => record.lane === lane)) + candidateRaw;
  for (const record of records
    .filter((entry) => entry.lane === lane)
    .sort((left, right) => Date.parse(left.postedAt) - Date.parse(right.postedAt))) {
    projected -= BigInt(record.totalRaw);
    if (projected <= capRaw) return new Date(Date.parse(record.postedAt) + DAY_MS).toISOString();
  }
  return undefined;
}

function pruneRecords(records, now) {
  return Array.isArray(records)
    ? records.filter((record) => record && withinWindow(record.postedAt, now, COST_WINDOW_MS))
    : [];
}

function withinWindow(value, now, windowMs) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now.getTime() - windowMs && timestamp <= now.getTime();
}

function sumRaw(records) {
  return records.reduce((total, record) => total + BigInt(record.totalRaw), 0n);
}

function requiredText(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw packetConfigError(`${field} must be a non-empty string`);
  return text;
}

function rawUnits(value, field) {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/u.test(text)) throw packetConfigError(`${field} must be non-negative base units`);
  return BigInt(text);
}

function normalizeLaneId(value) {
  const lane = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(lane) ? lane : undefined;
}

function normalizeWallet(value) {
  const wallet = String(value ?? "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/u.test(wallet) ? wallet : undefined;
}

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("catalogue lane clock must be a valid date");
  return date;
}

function packetConfigError(message) {
  return new ConfigError(`${CATALOGUE_LANE_PACKET}: ${message}.`);
}

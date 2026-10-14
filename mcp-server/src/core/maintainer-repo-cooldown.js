import { randomUUID } from "node:crypto";

import { NotFoundError, ValidationError } from "./errors.js";
import { normalizeRepo } from "./maintainer-surface-policy.js";
import { acquireMaintainerRepoClaimLock, positiveGithubRepoId } from "./maintainer-repo-claim-cap.js";

export const DEFAULT_MAINTAINER_REPO_COOLDOWN_MODE = "log";
export const DEFAULT_MAINTAINER_REPO_COOLDOWN_DAYS = 7;
export const DEFAULT_MAINTAINER_REPO_COOLDOWN_REPEAT_DAYS = 30;
export const MAINTAINER_REPO_CLOSE_WINDOW_DAYS = 30;
export const MAINTAINER_REPO_COOLDOWN_COUNTER_SCOPE = "maintainer-repo-cooldown-counters";
export const MAINTAINER_REPO_COOLDOWN_LOCK_TTL_SECONDS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOSE_WINDOW_MS = MAINTAINER_REPO_CLOSE_WINDOW_DAYS * DAY_MS;

export function maintainerRepoCooldownScope(repoId) {
  return `maintainer-repo-cooldown:${repoId}`;
}

export function maintainerRepoCooldownLockId(repoId) {
  return `maintainer-repo-cooldown:${repoId}`;
}

function positiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function positivePullNumber(value) {
  const number = typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function normalizeMaintainerRepoCooldownConfig(config = {}) {
  return {
    mode: config.mode === "enforce" ? "enforce" : DEFAULT_MAINTAINER_REPO_COOLDOWN_MODE,
    days: positiveInt(config.days, DEFAULT_MAINTAINER_REPO_COOLDOWN_DAYS),
    repeatDays: positiveInt(config.repeatDays, DEFAULT_MAINTAINER_REPO_COOLDOWN_REPEAT_DAYS)
  };
}

export function loadMaintainerRepoCooldownConfig(env = process.env) {
  return normalizeMaintainerRepoCooldownConfig({
    mode: env?.MAINTAINER_REPO_COOLDOWN_MODE,
    days: env?.MAINTAINER_REPO_COOLDOWN_DAYS,
    repeatDays: env?.MAINTAINER_REPO_COOLDOWN_REPEAT_DAYS
  });
}

export function classifyMaintainerClose(lookup, job, { claimExpired = false, sessionStatus = undefined } = {}) {
  if (claimExpired === true || sessionStatus === "expired") {
    return { kind: "ignore", reason: "expired_claim" };
  }
  if (!lookup || lookup.status === "unavailable" || lookup.status === "not_checked") {
    return { kind: "ignore", reason: "not_observed" };
  }
  if (lookup.state !== "closed") {
    return { kind: "ignore", reason: lookup.state === "open" ? "pull_request_open" : "not_closed" };
  }
  if (lookup.merged === true) return { kind: "ignore", reason: "pull_request_merged" };
  if (lookup.merged !== false) return { kind: "ambiguous", reason: "merge_unreported" };

  const pullNumber = positivePullNumber(lookup.pullNumber);
  if (!pullNumber) return { kind: "ambiguous", reason: "pull_number_missing" };

  const lookupRepoId = positiveGithubRepoId(lookup.baseRepo?.id);
  const jobRepoId = positiveGithubRepoId(job?.source?.githubRepoId);
  if (lookupRepoId && jobRepoId && lookupRepoId !== jobRepoId) {
    return { kind: "ambiguous", reason: "repo_id_conflict" };
  }
  const repoId = lookupRepoId ?? jobRepoId;
  if (!repoId) return { kind: "ambiguous", reason: "repo_unattributed" };

  const fullName = normalizeRepo(lookup.baseRepo?.full_name) || normalizeRepo(job?.source?.repo) || null;
  return { kind: "close", repoId, pullNumber, fullName, key: `${repoId}#${pullNumber}` };
}

export function readCooldownDecision(record, now = new Date()) {
  if (!record || record.cooldownUntil == null || record.cooldownUntil === "") {
    return { active: false };
  }
  if (record.cooldownUntil === "indefinite") {
    return {
      active: true,
      cooldownUntil: "indefinite",
      reason: record.cooldownReason ?? "maintainer_stop_signal"
    };
  }
  const until = Date.parse(record.cooldownUntil);
  if (!Number.isFinite(until)) return { active: false, ambiguous: true };
  if (until <= now.getTime()) return { active: false };
  return {
    active: true,
    cooldownUntil: record.cooldownUntil,
    reason: record.cooldownReason ?? "maintainer_close"
  };
}

function countedCloses(record, now) {
  const closes = Array.isArray(record?.closes) ? record.closes : [];
  return closes.filter((entry) => {
    const at = Date.parse(entry?.at);
    return entry?.key && Number.isFinite(at) && now.getTime() - at < CLOSE_WINDOW_MS;
  });
}

function publicRecord(record) {
  if (!record) return null;
  return {
    repoId: record.repoId,
    fullName: record.fullName ?? null,
    cooldownUntil: record.cooldownUntil ?? null,
    cooldownReason: record.cooldownReason ?? null,
    lastMaintainerCloseAt: record.lastMaintainerCloseAt ?? null,
    closeCount30d: Number.isInteger(record.closeCount30d) ? record.closeCount30d : 0
  };
}

async function withCooldownLock(stateStore, repoId, fn) {
  const lockId = maintainerRepoCooldownLockId(repoId);
  const owner = randomUUID();
  const acquired = await acquireMaintainerRepoClaimLock(stateStore, lockId, owner, {
    ttlSeconds: MAINTAINER_REPO_COOLDOWN_LOCK_TTL_SECONDS
  });
  if (!acquired) return { status: "contended" };
  try {
    return await fn();
  } finally {
    await stateStore.releaseClaimLock?.(lockId, owner);
  }
}

export async function getMaintainerRepoCooldown(stateStore, repoId) {
  const id = positiveGithubRepoId(repoId);
  if (!id || typeof stateStore?.getServiceState !== "function") return null;
  const stored = await stateStore.getServiceState(maintainerRepoCooldownScope(id));
  return stored ?? null;
}

function nextCloseRecord(record, { repoId, fullName, key, now, config }) {
  const closes = countedCloses(record, now);
  const already = closes.some((entry) => entry.key === key);
  const nextCloses = already ? closes : [...closes, { key, at: now.toISOString() }];
  const closeCount30d = nextCloses.length;
  const resolvedName = fullName || record?.fullName || null;
  if (record?.cooldownUntil === "indefinite") {
    return {
      ...record,
      repoId,
      fullName: resolvedName,
      cooldownUntil: "indefinite",
      cooldownReason: "maintainer_stop_signal",
      lastMaintainerCloseAt: already ? record.lastMaintainerCloseAt : now.toISOString(),
      closeCount30d,
      closes: nextCloses
    };
  }
  if (already) {
    return {
      ...record,
      repoId,
      fullName: resolvedName,
      closeCount30d,
      closes: nextCloses
    };
  }
  const repeat = closeCount30d >= 2;
  return {
    ...record,
    repoId,
    fullName: resolvedName,
    cooldownUntil: new Date(now.getTime() + (repeat ? config.repeatDays : config.days) * DAY_MS).toISOString(),
    cooldownReason: repeat ? "maintainer_close_repeat" : "maintainer_close",
    lastMaintainerCloseAt: now.toISOString(),
    closeCount30d,
    closes: nextCloses
  };
}

export async function recordMaintainerClose({
  stateStore,
  repoId,
  fullName = null,
  pullNumber,
  key,
  now = new Date(),
  config
} = {}) {
  const id = positiveGithubRepoId(repoId);
  const prKey = key ?? (id && positivePullNumber(pullNumber) ? `${id}#${pullNumber}` : null);
  if (!id || !prKey || typeof stateStore?.upsertServiceState !== "function") {
    return { status: "ambiguous", reason: "repo_unattributed" };
  }
  const resolved = normalizeMaintainerRepoCooldownConfig(config ?? loadMaintainerRepoCooldownConfig(process.env));
  return withCooldownLock(stateStore, id, async () => {
    const existing = await stateStore.getServiceState(maintainerRepoCooldownScope(id));
    const next = nextCloseRecord(existing, {
      repoId: id,
      fullName: normalizeRepo(fullName) || null,
      key: prKey,
      now,
      config: resolved
    });
    const saved = await stateStore.upsertServiceState(maintainerRepoCooldownScope(id), next);
    return { status: "recorded", record: publicRecord(saved) };
  });
}

export async function recordMaintainerStopSignal({
  stateStore,
  repoId,
  fullName = null,
  now = new Date()
} = {}) {
  const id = positiveGithubRepoId(repoId);
  if (!id || typeof stateStore?.upsertServiceState !== "function") {
    return { status: "ambiguous", reason: "repo_unattributed" };
  }
  return withCooldownLock(stateStore, id, async () => {
    const existing = await stateStore.getServiceState(maintainerRepoCooldownScope(id));
    const closes = countedCloses(existing, now);
    const next = {
      ...existing,
      repoId: id,
      fullName: normalizeRepo(fullName) || existing?.fullName || null,
      cooldownUntil: "indefinite",
      cooldownReason: "maintainer_stop_signal",
      lastMaintainerCloseAt: existing?.lastMaintainerCloseAt ?? null,
      closeCount30d: closes.length,
      closes
    };
    const saved = await stateStore.upsertServiceState(maintainerRepoCooldownScope(id), next);
    return { status: "recorded", record: publicRecord(saved) };
  });
}

export async function clearMaintainerRepoCooldown({
  stateStore,
  repoId,
  actor,
  reason,
  now = new Date(),
  logger
} = {}) {
  const id = positiveGithubRepoId(repoId);
  if (!id) throw new ValidationError("Repository id must be a positive GitHub repository id.");
  const actorId = typeof actor === "string" ? actor.trim() : "";
  const clearReason = typeof reason === "string" ? reason.trim() : "";
  if (!actorId) throw new ValidationError("An operator actor is required to clear a maintainer cooldown.");
  if (!clearReason || clearReason.length > 500) {
    throw new ValidationError("A clear reason of 1–500 characters is required.");
  }
  if (typeof stateStore?.upsertServiceState !== "function") {
    throw new ValidationError("Cooldown state is unavailable.");
  }
  const result = await withCooldownLock(stateStore, id, async () => {
    const existing = await stateStore.getServiceState(maintainerRepoCooldownScope(id));
    if (!existing) {
      throw new NotFoundError(
        "No maintainer cooldown is stored for this repository id.",
        "maintainer_repo_cooldown_not_found",
        { repoId: id }
      );
    }
    const closes = countedCloses(existing, now);
    const next = {
      ...existing,
      repoId: id,
      cooldownUntil: null,
      cooldownReason: null,
      closeCount30d: closes.length,
      closes,
      clearedAt: now.toISOString(),
      clearedBy: actorId,
      clearReason
    };
    await stateStore.upsertServiceState(maintainerRepoCooldownScope(id), next);
    return { repoId: id, cleared: true, cooldownUntil: null, cooldownReason: null, closeCount30d: closes.length };
  });
  if (result?.status === "contended") {
    throw new ValidationError("Another update of this repository cooldown is in progress.");
  }
  logger?.info?.({
    event: "maintainer_repo_cooldown_cleared",
    repoId: id,
    actor: actorId,
    reason: clearReason
  }, "maintainer_repo_cooldown_cleared");
  return result;
}

export async function observeMaintainerPullRequest({
  stateStore,
  lookup,
  job,
  sessionStatus,
  claimExpired = false,
  now = new Date(),
  config,
  logger
} = {}) {
  const classified = classifyMaintainerClose(lookup, job, { claimExpired, sessionStatus });
  if (classified.kind === "ignore") return { status: "ignored", reason: classified.reason };
  if (classified.kind === "ambiguous") {
    await incrementMaintainerRepoCooldownCounter(stateStore, "ambiguous", logger, {
      event: "maintainer_repo_cooldown_ambiguous",
      reason: classified.reason
    });
    return { status: "ambiguous", reason: classified.reason };
  }
  return recordMaintainerClose({
    stateStore,
    repoId: classified.repoId,
    fullName: classified.fullName,
    pullNumber: classified.pullNumber,
    key: classified.key,
    now,
    config
  });
}

function measuredCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export async function readMaintainerRepoCooldownCounters(stateStore) {
  if (typeof stateStore?.getServiceState !== "function") {
    return { wouldRefuse: "not reported", ambiguous: "not reported" };
  }
  try {
    const stored = await stateStore.getServiceState(MAINTAINER_REPO_COOLDOWN_COUNTER_SCOPE);
    if (!stored) return { wouldRefuse: 0, ambiguous: 0 };
    return {
      wouldRefuse: measuredCount(stored.wouldRefuse),
      ambiguous: measuredCount(stored.ambiguous)
    };
  } catch {
    return { wouldRefuse: "not reported", ambiguous: "not reported" };
  }
}

export async function incrementMaintainerRepoCooldownCounter(stateStore, field, logger, details = {}) {
  if (field !== "wouldRefuse" && field !== "ambiguous") return null;
  if (typeof stateStore?.getServiceState !== "function" || typeof stateStore?.upsertServiceState !== "function") {
    return null;
  }
  const lockId = MAINTAINER_REPO_COOLDOWN_COUNTER_SCOPE;
  const owner = randomUUID();
  const acquired = await acquireMaintainerRepoClaimLock(stateStore, lockId, owner, {
    ttlSeconds: MAINTAINER_REPO_COOLDOWN_LOCK_TTL_SECONDS
  });
  if (!acquired) return null;
  try {
    const stored = await stateStore.getServiceState(MAINTAINER_REPO_COOLDOWN_COUNTER_SCOPE);
    const next = {
      wouldRefuse: measuredCount(stored?.wouldRefuse),
      ambiguous: measuredCount(stored?.ambiguous)
    };
    next[field] += 1;
    await stateStore.upsertServiceState(MAINTAINER_REPO_COOLDOWN_COUNTER_SCOPE, next);
    logger?.info?.({
      ...details,
      wouldRefuse: next.wouldRefuse,
      ambiguous: next.ambiguous
    }, details.event ?? "maintainer_repo_cooldown_counter");
    return next;
  } finally {
    await stateStore.releaseClaimLock?.(lockId, owner);
  }
}

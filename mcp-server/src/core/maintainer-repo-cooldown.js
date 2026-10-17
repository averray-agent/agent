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
export const MAINTAINER_ASSOCIATIONS = Object.freeze(["OWNER", "MEMBER", "COLLABORATOR"]);

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOSE_WINDOW_MS = MAINTAINER_REPO_CLOSE_WINDOW_DAYS * DAY_MS;
const LOCK_WAIT_MS = 400;
const LOCK_POLL_MS = 40;

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

function loginOf(value) {
  const login = typeof value === "string" ? value : value?.login;
  const normalized = typeof login === "string" ? login.trim().toLowerCase() : "";
  return normalized || null;
}

function parseTime(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isMaintainerAssociation(value) {
  return MAINTAINER_ASSOCIATIONS.includes(String(value ?? "").trim().toUpperCase());
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

function repositoryFullName(lookup) {
  return normalizeRepo(lookup?.baseRepo?.fullName) || normalizeRepo(lookup?.baseRepo?.full_name) || null;
}

export function classifyMaintainerClose(lookup, job, {
  claimExpired = false,
  sessionStatus = undefined,
  claimedAt = undefined,
  submittedAt = undefined
} = {}) {
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

  if (lookup.claimantBinding?.status !== "matched") {
    return { kind: "ambiguous", reason: "claimant_unbound" };
  }
  const closedAtMs = parseTime(lookup.closedAt);
  if (closedAtMs === null) return { kind: "ambiguous", reason: "closed_at_unreported" };
  const anchorMs = parseTime(claimedAt) ?? parseTime(submittedAt);
  if (anchorMs === null) return { kind: "ambiguous", reason: "claim_time_unreported" };
  if (closedAtMs <= anchorMs) return { kind: "ambiguous", reason: "closed_before_claim" };

  const author = loginOf(lookup.author);
  const closedBy = loginOf(lookup.closedBy);
  if (!author || !closedBy) return { kind: "ambiguous", reason: "closed_by_unreported" };
  if (author === closedBy) return { kind: "ambiguous", reason: "closed_by_author" };

  return {
    kind: "close",
    repoId,
    pullNumber,
    fullName: repositoryFullName(lookup),
    key: `${repoId}#${pullNumber}`,
    closedAt: new Date(closedAtMs).toISOString()
  };
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

function storedCloses(record) {
  return (Array.isArray(record?.closes) ? record.closes : []).filter((entry) => entry?.key);
}

function permanentPullKeys(record) {
  const keys = new Set();
  for (const key of record?.countedPullKeys ?? []) {
    if (typeof key === "string" && key) keys.add(key);
  }
  for (const entry of storedCloses(record)) keys.add(entry.key);
  return keys;
}

function closesInWindow(closes, closedAtMs) {
  return closes.filter((entry) => {
    const at = Date.parse(entry.at);
    return Number.isFinite(at) && closedAtMs - at < CLOSE_WINDOW_MS && closedAtMs - at >= 0;
  });
}

function countedCloses(record, now) {
  return closesInWindow(storedCloses(record), now.getTime());
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

async function withCooldownLock(stateStore, repoId, fn, logger) {
  const lockId = maintainerRepoCooldownLockId(repoId);
  const owner = randomUUID();
  const acquired = await acquireMaintainerRepoClaimLock(stateStore, lockId, owner, {
    ttlSeconds: MAINTAINER_REPO_COOLDOWN_LOCK_TTL_SECONDS,
    waitMs: LOCK_WAIT_MS,
    pollMs: LOCK_POLL_MS
  });
  if (!acquired) {
    logger?.warn?.({
      event: "maintainer_repo_cooldown_lock_contended",
      repoId
    }, "maintainer_repo_cooldown_lock_contended");
    return { status: "contended" };
  }
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

function countableCloses(closes, clearedAtMs) {
  return closes.filter((entry) => {
    const at = Date.parse(entry.at);
    return Number.isFinite(at) && (clearedAtMs === null || at >= clearedAtMs);
  });
}

function nextCloseRecord(record, { repoId, fullName, key, closedAt, config }) {
  const permanent = permanentPullKeys(record);
  const resolvedName = fullName || record?.fullName || null;
  if (permanent.has(key)) {
    return {
      record: {
        ...record,
        repoId,
        fullName: resolvedName,
        countedPullKeys: [...permanent]
      }
    };
  }
  const clearedAtMs = parseTime(record?.clearedAt);
  if (clearedAtMs !== null && closedAt.getTime() < clearedAtMs) {
    permanent.add(key);
    return {
      ignored: "closed_before_clear",
      record: {
        ...record,
        repoId,
        fullName: resolvedName,
        countedPullKeys: [...permanent]
      }
    };
  }
  const closes = [...storedCloses(record), { key, at: closedAt.toISOString() }];
  permanent.add(key);
  const countable = countableCloses(closes, clearedAtMs);
  const latestMs = countable.reduce((latest, entry) => Math.max(latest, Date.parse(entry.at)), closedAt.getTime());
  const closeCount30d = closesInWindow(countable, latestMs).length;
  const repeat = closeCount30d >= 2;
  const proposedMs = latestMs + (repeat ? config.repeatDays : config.days) * DAY_MS;
  let cooldownUntil = record?.cooldownUntil ?? null;
  let cooldownReason = repeat ? "maintainer_close_repeat" : "maintainer_close";
  if (cooldownUntil === "indefinite") {
    cooldownReason = "maintainer_stop_signal";
  } else {
    const existingMs = Date.parse(cooldownUntil);
    const keptMs = Number.isFinite(existingMs) ? Math.max(existingMs, proposedMs) : proposedMs;
    cooldownUntil = new Date(keptMs).toISOString();
    if (Number.isFinite(existingMs) && existingMs > proposedMs && record?.cooldownReason) {
      cooldownReason = record.cooldownReason;
    }
  }
  return {
    record: {
      ...record,
      repoId,
      fullName: resolvedName,
      cooldownUntil,
      cooldownReason,
      lastMaintainerCloseAt: new Date(latestMs).toISOString(),
      closeCount30d,
      closes,
      countedPullKeys: [...permanent]
    }
  };
}

export async function recordMaintainerClose({
  stateStore,
  repoId,
  fullName = null,
  pullNumber,
  key,
  now = new Date(),
  closedAt = undefined,
  config,
  logger
} = {}) {
  const id = positiveGithubRepoId(repoId);
  const prKey = key ?? (id && positivePullNumber(pullNumber) ? `${id}#${pullNumber}` : null);
  const at = new Date(closedAt ?? now);
  if (!id || !prKey || !Number.isFinite(at.getTime()) || typeof stateStore?.upsertServiceState !== "function") {
    return { status: "ambiguous", reason: "repo_unattributed" };
  }
  const resolved = normalizeMaintainerRepoCooldownConfig(config ?? loadMaintainerRepoCooldownConfig(process.env));
  return withCooldownLock(stateStore, id, async () => {
    const existing = await stateStore.getServiceState(maintainerRepoCooldownScope(id));
    const next = nextCloseRecord(existing, {
      repoId: id,
      fullName: normalizeRepo(fullName) || null,
      key: prKey,
      closedAt: at,
      config: resolved
    });
    const saved = await stateStore.upsertServiceState(maintainerRepoCooldownScope(id), next.record);
    if (next.ignored) return { status: "ignored", reason: next.ignored, record: publicRecord(saved) };
    return { status: "recorded", record: publicRecord(saved) };
  }, logger);
}

function acknowledgedSources(record) {
  return new Set((record?.acknowledgedStopSources ?? []).filter((source) => typeof source === "string" && source));
}

function knownStopSources(record) {
  return new Set((record?.stopSources ?? []).filter((source) => typeof source === "string" && source));
}

export async function recordMaintainerStopSignal({
  stateStore,
  repoId,
  fullName = null,
  source,
  now = new Date(),
  logger
} = {}) {
  const id = positiveGithubRepoId(repoId);
  const signalSource = typeof source === "string" ? source.trim() : "";
  if (!id || !signalSource || typeof stateStore?.upsertServiceState !== "function") {
    return { status: "ambiguous", reason: "stop_source_missing" };
  }
  return withCooldownLock(stateStore, id, async () => {
    const existing = await stateStore.getServiceState(maintainerRepoCooldownScope(id));
    const acknowledged = acknowledgedSources(existing);
    if (acknowledged.has(signalSource)) {
      return { status: "ignored", reason: "stop_source_acknowledged", record: publicRecord(existing) };
    }
    const sources = knownStopSources(existing);
    sources.add(signalSource);
    const closes = storedCloses(existing);
    const next = {
      ...existing,
      repoId: id,
      fullName: normalizeRepo(fullName) || existing?.fullName || null,
      cooldownUntil: "indefinite",
      cooldownReason: "maintainer_stop_signal",
      lastMaintainerCloseAt: existing?.lastMaintainerCloseAt ?? null,
      closeCount30d: closesInWindow(closes, now.getTime()).length,
      closes,
      countedPullKeys: [...permanentPullKeys(existing)],
      stopSources: [...sources],
      acknowledgedStopSources: [...acknowledged]
    };
    const saved = await stateStore.upsertServiceState(maintainerRepoCooldownScope(id), next);
    return { status: "recorded", record: publicRecord(saved) };
  }, logger);
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
    const acknowledged = acknowledgedSources(existing);
    for (const source of knownStopSources(existing)) acknowledged.add(source);
    const closes = storedCloses(existing);
    const next = {
      ...existing,
      repoId: id,
      cooldownUntil: null,
      cooldownReason: null,
      closeCount30d: closesInWindow(closes, now.getTime()).length,
      closes,
      countedPullKeys: [...permanentPullKeys(existing)],
      stopSources: [...knownStopSources(existing)],
      acknowledgedStopSources: [...acknowledged],
      clearedAt: now.toISOString(),
      clearedBy: actorId,
      clearReason
    };
    await stateStore.upsertServiceState(maintainerRepoCooldownScope(id), next);
    return {
      repoId: id,
      cleared: true,
      cooldownUntil: null,
      cooldownReason: null,
      closeCount30d: next.closeCount30d
    };
  }, logger);
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
  claimedAt,
  submittedAt,
  claimExpired = false,
  now = new Date(),
  config,
  logger
} = {}) {
  const classified = classifyMaintainerClose(lookup, job, {
    claimExpired,
    sessionStatus,
    claimedAt,
    submittedAt
  });
  if (classified.kind === "ignore") return { status: "ignored", reason: classified.reason };
  if (classified.kind === "ambiguous") {
    try {
      await incrementMaintainerRepoCooldownCounter(stateStore, "ambiguous", logger, {
        event: "maintainer_repo_cooldown_ambiguous",
        reason: classified.reason
      });
    } catch {
      logger?.warn?.({
        event: "maintainer_repo_cooldown_counter_persist_failed",
        reason: classified.reason
      }, "maintainer_repo_cooldown_counter_persist_failed");
    }
    return { status: "ambiguous", reason: classified.reason };
  }
  return recordMaintainerClose({
    stateStore,
    repoId: classified.repoId,
    fullName: classified.fullName,
    pullNumber: classified.pullNumber,
    key: classified.key,
    now,
    closedAt: classified.closedAt,
    config,
    logger
  });
}

function measuredCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function counterSnapshot(stored) {
  const wouldRefuseClaim = measuredCount(stored?.wouldRefuseClaim);
  const wouldRefuseIngest = measuredCount(stored?.wouldRefuseIngest);
  const wouldRefuse = Number.isInteger(stored?.wouldRefuse) && stored.wouldRefuse >= 0
    ? stored.wouldRefuse
    : wouldRefuseClaim + wouldRefuseIngest;
  return {
    wouldRefuse,
    wouldRefuseClaim,
    wouldRefuseIngest,
    ambiguous: measuredCount(stored?.ambiguous)
  };
}

export async function readMaintainerRepoCooldownCounters(stateStore) {
  const unmeasured = {
    wouldRefuse: "not reported",
    wouldRefuseClaim: "not reported",
    wouldRefuseIngest: "not reported",
    ambiguous: "not reported"
  };
  if (typeof stateStore?.getServiceState !== "function") return unmeasured;
  try {
    const stored = await stateStore.getServiceState(MAINTAINER_REPO_COOLDOWN_COUNTER_SCOPE);
    if (!stored) return { wouldRefuse: 0, wouldRefuseClaim: 0, wouldRefuseIngest: 0, ambiguous: 0 };
    return counterSnapshot(stored);
  } catch {
    return unmeasured;
  }
}

export async function incrementMaintainerRepoCooldownCounter(stateStore, field, logger, details = {}) {
  if (field !== "wouldRefuse" && field !== "ambiguous") return null;
  if (typeof stateStore?.getServiceState !== "function" || typeof stateStore?.upsertServiceState !== "function") {
    return null;
  }
  const surface = details.surface === "ingest" ? "ingest" : details.surface === "claim" ? "claim" : null;
  const lockId = MAINTAINER_REPO_COOLDOWN_COUNTER_SCOPE;
  const owner = randomUUID();
  const acquired = await acquireMaintainerRepoClaimLock(stateStore, lockId, owner, {
    ttlSeconds: MAINTAINER_REPO_COOLDOWN_LOCK_TTL_SECONDS
  });
  if (!acquired) return null;
  try {
    const stored = await stateStore.getServiceState(MAINTAINER_REPO_COOLDOWN_COUNTER_SCOPE);
    const next = counterSnapshot(stored);
    if (field === "wouldRefuse") {
      next.wouldRefuse += 1;
      if (surface === "claim") next.wouldRefuseClaim += 1;
      if (surface === "ingest") next.wouldRefuseIngest += 1;
    } else {
      next.ambiguous += 1;
    }
    await stateStore.upsertServiceState(MAINTAINER_REPO_COOLDOWN_COUNTER_SCOPE, next);
    logger?.info?.({
      event: details.event ?? "maintainer_repo_cooldown_counter",
      surface: surface ?? undefined,
      reason: details.reason,
      repoId: details.repoId,
      cooldownUntil: details.cooldownUntil,
      wouldRefuse: next.wouldRefuse,
      wouldRefuseClaim: next.wouldRefuseClaim,
      wouldRefuseIngest: next.wouldRefuseIngest,
      ambiguous: next.ambiguous
    }, details.event ?? "maintainer_repo_cooldown_counter");
    return next;
  } finally {
    await stateStore.releaseClaimLock?.(lockId, owner);
  }
}

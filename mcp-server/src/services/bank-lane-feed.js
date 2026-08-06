import { Contract } from "ethers";

import { ValidationError } from "../core/errors.js";
import { redactProviderError } from "../core/redact-provider-error.js";
import { normalizeVenueBalanceTarget } from "./venue-balance-reader.js";

const DEFAULT_STATE_SCOPE = "bank-lane-feed";
const ALL_PENDING_REQUESTS_LIMIT = Number.MAX_SAFE_INTEGER;
const RECENT_TERMINAL_REQUESTS_LIMIT = 10;
const WRAPPER_PAUSE_ABI = ["function dispatchPaused() view returns (bool)"];
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;

export class EvmWrapperPauseReader {
  constructor(provider) {
    this.provider = provider;
  }

  async readDispatchPaused(wrapper) {
    if (!this.provider) throw new Error("Asset Hub EVM provider is unavailable");
    return Boolean(await new Contract(wrapper, WRAPPER_PAUSE_ABI, this.provider).dispatchPaused());
  }
}

/**
 * Observer-owned snapshot behind GET /monitor/bank-feed.
 *
 * The service reuses the #910 VenueBalanceReader. It never asks the HTTP
 * request path (or Hermes) to read either chain, and it persists each source's
 * own completion clock instead of inventing an assembly timestamp.
 */
export class BankLaneFeedService {
  constructor(
    stateStore,
    balanceReader,
    {
      enabled = false,
      subject = undefined,
      subjectReader = undefined,
      targets = undefined,
      requestTargets = undefined,
      now = () => Date.now(),
      stateScope = DEFAULT_STATE_SCOPE
    } = {}
  ) {
    this.stateStore = stateStore;
    this.balanceReader = balanceReader;
    this.enabled = enabled;
    this.now = now;
    this.stateScope = String(stateScope || DEFAULT_STATE_SCOPE);
    this.subject = enabled ? normalizeSubjectConfig(subject) : undefined;
    this.subjectReader = subjectReader;
    this.targets = enabled ? normalizeFeedTargets(targets) : undefined;
    this.requestTargets = enabled
      ? (requestTargets ?? [this.targets.position]).map((target) => normalizeVenueBalanceTarget(target))
      : undefined;
    this.persistenceTail = Promise.resolve();
  }

  async pollOnce() {
    if (!this.enabled) return this.getFeed();

    // Persist each read as it completes. If one RPC hangs, the other three
    // sources still advance their own clocks while the hung source remains
    // visibly stale. The write queue prevents concurrent read/merge/write
    // cycles from losing sibling sections in Redis.
    await Promise.all([
      this.readBalance(this.targets.position)
        .then((position) => this.persistPosition(position)),
      this.readBalance(this.targets.float)
        .then((float) => this.persistSection("float", float)),
      this.readBalance(this.targets.postage)
        .then((postage) => this.persistSection("postage", postage)),
      this.readRequests()
        .then((requests) => this.persistSection("requests", requests)),
      this.readSubject()
        .then((subject) => this.persistSection("subject", subject))
    ]);
    return this.getFeed();
  }

  async getFeed() {
    if (!this.enabled) return disabledFeed();

    const stored = await this.stateStore.getServiceState?.(this.stateScope) ?? {};
    const positionSource = describeBalanceTarget(this.targets.position);
    const position = readForCurrentTarget(stored.position, positionSource);
    const float = readForCurrentTarget(
      stored.float,
      describeBalanceTarget(this.targets.float)
    );
    const postage = readForCurrentTarget(
      stored.postage,
      describeBalanceTarget(this.targets.postage)
    );
    const calibration = validCalibration(stored.calibration, positionSource);
    return {
      subject: subjectForCurrentConfig(stored.subject, this.subject),
      position,
      float,
      postage,
      requests: normalizeRequests(stored.requests),
      calibration
    };
  }

  async readBalance(target) {
    const source = describeBalanceTarget(target);
    try {
      const reading = await this.balanceReader.read(target);
      const value = normalizeSuccessfulRaw(reading.raw);
      return {
        raw: value.toString(),
        source,
        readAtMs: normalizeReadCompletion(reading.asOf, this.now()),
        lastError: null
      };
    } catch (error) {
      return {
        raw: null,
        source,
        readAtMs: this.now(),
        lastError: redactProviderError(error) || "balance_read_failed"
      };
    }
  }

  async readRequests() {
    try {
      const [pending, terminal] = await Promise.all([
        this.stateStore.listPendingXcmBalanceWatches?.(ALL_PENDING_REQUESTS_LIMIT) ?? [],
        this.stateStore.listRecentTerminalXcmBalanceWatches?.(RECENT_TERMINAL_REQUESTS_LIMIT) ?? []
      ]);
      const readAtMs = this.now();
      const currentWatches = [...pending, ...terminal]
        .filter((watch) => this.classifyRequestWatch(watch) !== "foreign");
      const observations = await Promise.all(currentWatches.map((watch) =>
        this.stateStore.getXcmObservation?.(watch.wrapperAddress, watch.requestId)
      ));
      return {
        // Request ids are scoped by wrapper on-chain and the durable observer
        // preserves that same composite identity. Retired generations stay in
        // history without colliding with the active request table.
        items: currentWatches.map((watch, index) =>
          requestFromWatch(watch, readAtMs, observations[index])
        ),
        readAtMs,
        lastError: null
      };
    } catch (error) {
      return {
        // Empty here is deliberately paired with lastError. It cannot be
        // interpreted as an all-clear by the consumer.
        items: [],
        readAtMs: this.now(),
        lastError: redactProviderError(error) || "request_table_read_failed"
      };
    }
  }

  async readSubject() {
    const observations = await Promise.all(this.subject.candidates.map(async (candidate) => {
      try {
        if (typeof this.subjectReader?.readDispatchPaused !== "function") {
          throw new Error("wrapper pause reader is unavailable");
        }
        const dispatchPaused = await this.subjectReader.readDispatchPaused(candidate.wrapper);
        if (typeof dispatchPaused !== "boolean") {
          throw new Error("wrapper pause reader returned a non-boolean value");
        }
        return { ...candidate, dispatchPaused, lastError: null };
      } catch (error) {
        return {
          ...candidate,
          dispatchPaused: null,
          lastError: redactProviderError(error) || "wrapper_pause_read_failed"
        };
      }
    }));
    return evaluateSoleArmedWrapper({
      configuredWrapper: this.subject.configuredWrapper,
      candidates: observations,
      readAtMs: this.now()
    });
  }

  async persistPosition(position) {
    return this.enqueuePersistence(async () => {
      const previous = await this.stateStore.getServiceState?.(this.stateScope) ?? {};
      const calibration = nextCalibration({ previous: previous.calibration, position });
      await this.stateStore.upsertServiceState?.(this.stateScope, { position, calibration });
    });
  }

  classifyRequestWatch(watch) {
    if (watch?.wrapperAddress
      && !sameAddress(watch.wrapperAddress, this.subject?.configuredWrapper)) return "foreign";
    return classifyPositionWatch(watch, this.requestTargets);
  }

  async persistSection(name, value) {
    return this.enqueuePersistence(async () => {
      await this.stateStore.upsertServiceState?.(this.stateScope, { [name]: value });
    });
  }

  enqueuePersistence(operation) {
    const pending = this.persistenceTail.then(operation, operation);
    this.persistenceTail = pending.catch(() => undefined);
    return pending;
  }
}

export function loadBankLaneFeedConfig(env = process.env) {
  const enabled = parseBoolean(env.BANK_LANE_FEED_ENABLED);
  if (!enabled) return { enabled: false };

  const hydrationAccount = requireValue(
    env.BANK_LANE_FEED_HYDRATION_ACCOUNT_ID32,
    "BANK_LANE_FEED_HYDRATION_ACCOUNT_ID32"
  );
  return {
    enabled: true,
    subject: {
      configuredWrapper: requireAddressValue(
        env.XCM_WRAPPER_ADDRESS,
        "XCM_WRAPPER_ADDRESS"
      ),
      candidates: parseWrapperCandidates(
        env.BANK_LANE_FEED_WRAPPER_CANDIDATES_JSON,
        "BANK_LANE_FEED_WRAPPER_CANDIDATES_JSON"
      )
    },
    targets: {
      position: {
        ledger: "erc20",
        endpoint: requireValue(
          env.BANK_LANE_FEED_HYDRATION_EVM_RPC_URL,
          "BANK_LANE_FEED_HYDRATION_EVM_RPC_URL"
        ),
        chainId: requireValue(
          env.BANK_LANE_FEED_HYDRATION_EVM_CHAIN_ID,
          "BANK_LANE_FEED_HYDRATION_EVM_CHAIN_ID"
        ),
        account: hydrationAccount,
        accountTransform: "hydration_truncate20",
        contract: requireValue(
          env.BANK_LANE_FEED_AUSDC_CONTRACT,
          "BANK_LANE_FEED_AUSDC_CONTRACT"
        )
      },
      float: {
        ledger: "substrate_tokens",
        endpoint: requireValue(
          env.BANK_LANE_FEED_HYDRATION_SUBSTRATE_RPC_URL,
          "BANK_LANE_FEED_HYDRATION_SUBSTRATE_RPC_URL"
        ),
        account: hydrationAccount,
        assetId: requireValue(
          env.BANK_LANE_FEED_FLOAT_ASSET_ID,
          "BANK_LANE_FEED_FLOAT_ASSET_ID"
        )
      },
      postage: {
        ledger: "substrate_system",
        endpoint: requireValue(
          env.BANK_LANE_FEED_POSTAGE_SUBSTRATE_RPC_URL,
          "BANK_LANE_FEED_POSTAGE_SUBSTRATE_RPC_URL"
        ),
        account: requireValue(
          env.BANK_LANE_FEED_POSTAGE_ACCOUNT,
          "BANK_LANE_FEED_POSTAGE_ACCOUNT"
        )
      }
    }
  };
}

export function describeBalanceTarget(rawTarget) {
  const target = normalizeVenueBalanceTarget(rawTarget);
  if (target.ledger === "erc20") {
    return `erc20:${target.contract}.balanceOf(${target.evmAccount})`;
  }
  if (target.ledger === "substrate_tokens") {
    return `substrate_tokens:Tokens.accounts(${target.account},${target.assetId})`;
  }
  return `substrate_system:System.account(${target.account})`;
}

function normalizeFeedTargets(targets = {}) {
  return {
    position: normalizeVenueBalanceTarget(targets.position),
    float: normalizeVenueBalanceTarget(targets.float),
    postage: normalizeVenueBalanceTarget(targets.postage)
  };
}

export function evaluateSoleArmedWrapper({ configuredWrapper, candidates, readAtMs }) {
  // Runtime observations are allowed to report that the configured wrapper is
  // missing. Static configuration remains strict in normalizeSubjectConfig;
  // this evaluator must turn observed drift into an honest subject state
  // instead of throwing away the feed snapshot.
  const normalized = normalizeSubjectDefinition(
    { configuredWrapper, candidates },
    { requireConfiguredCandidate: false }
  );
  const observations = candidates.map((candidate, index) => ({
    ...normalized.candidates[index],
    dispatchPaused: typeof candidate?.dispatchPaused === "boolean" ? candidate.dispatchPaused : null,
    lastError: candidate?.lastError ? String(candidate.lastError) : null
  }));
  const configuredCandidate = observations.find((candidate) => (
    sameAddress(candidate.wrapper, normalized.configuredWrapper)
  ));
  const unreadable = observations.filter((candidate) => candidate.dispatchPaused === null);
  const armed = observations.filter((candidate) => candidate.dispatchPaused === false);
  let status;
  let matches;
  let uniqueArmedWrapper = null;
  let reason = null;
  let lastError = null;
  if (!configuredCandidate || configuredCandidate.lastError) {
    status = "error";
    matches = false;
    reason = "no_armed_wrapper";
    lastError = "no_armed_wrapper";
  } else if (unreadable.length > 0) {
    status = "unknown";
    matches = null;
    reason = "wrapper_pause_state_unverified";
    lastError = "wrapper_pause_state_unverified";
  } else if (armed.length === 0) {
    // The configured generation is readable and deliberately paused. With no
    // other armed generation, zero-armed is the expected consequence rather
    // than a missing-wrapper failure. It is verified, but not green: callers
    // receive a distinct paused state and reason.
    status = "paused";
    matches = true;
    reason = "administratively_paused";
  } else if (armed.length > 1) {
    status = "error";
    matches = false;
    reason = "multiple_armed_wrappers";
    lastError = "multiple_armed_wrappers";
  } else {
    uniqueArmedWrapper = armed[0].wrapper;
    matches = sameAddress(uniqueArmedWrapper, normalized.configuredWrapper);
    status = matches ? "ok" : "error";
    reason = matches ? null : "configured_wrapper_not_unique_armed_wrapper";
    lastError = matches ? null : "configured_wrapper_not_unique_armed_wrapper";
  }
  return {
    configuredWrapper: normalized.configuredWrapper,
    uniqueArmedWrapper,
    matches,
    status,
    reason,
    candidates: observations,
    readAtMs: Number.isFinite(readAtMs) ? readAtMs : null,
    lastError
  };
}

function normalizeSubjectConfig(subject = {}) {
  return normalizeSubjectDefinition(subject, { requireConfiguredCandidate: true });
}

function normalizeSubjectDefinition(subject = {}, { requireConfiguredCandidate }) {
  const configuredWrapper = requireAddressValue(subject.configuredWrapper, "subject.configuredWrapper");
  if (!Array.isArray(subject.candidates) || subject.candidates.length === 0) {
    throw new ValidationError("subject.candidates must contain the append-only wrapper history.");
  }
  const seen = new Set();
  const candidates = subject.candidates.map((candidate, index) => {
    const version = String(candidate?.version ?? "").trim();
    if (!version) throw new ValidationError(`subject.candidates[${index}].version is required.`);
    const wrapper = requireAddressValue(candidate?.wrapper, `subject.candidates[${index}].wrapper`);
    const key = wrapper.toLowerCase();
    if (seen.has(key)) throw new ValidationError(`subject.candidates contains duplicate wrapper ${wrapper}.`);
    seen.add(key);
    return { version, wrapper };
  });
  if (requireConfiguredCandidate && !seen.has(configuredWrapper.toLowerCase())) {
    throw new ValidationError("subject.configuredWrapper must be present in subject.candidates.");
  }
  return { configuredWrapper, candidates };
}

function subjectForCurrentConfig(raw, config) {
  const expected = normalizeSubjectConfig(config);
  const matchesConfig = raw
    && sameAddress(raw.configuredWrapper, expected.configuredWrapper)
    && Number.isFinite(raw.readAtMs)
    && Array.isArray(raw.candidates)
    && raw.candidates.length === expected.candidates.length
    && raw.candidates.every((candidate, index) => (
      candidate?.version === expected.candidates[index].version
      && sameAddress(candidate?.wrapper, expected.candidates[index].wrapper)
    ));
  if (!matchesConfig) return unreadSubject(expected, "subject_snapshot_missing_or_stale");
  try {
    return evaluateSoleArmedWrapper({
      configuredWrapper: expected.configuredWrapper,
      candidates: raw.candidates,
      readAtMs: raw.readAtMs
    });
  } catch {
    return unreadSubject(expected, "stored_subject_snapshot_invalid");
  }
}

function unreadSubject(subject, lastError) {
  return {
    configuredWrapper: subject.configuredWrapper,
    uniqueArmedWrapper: null,
    matches: null,
    status: "unknown",
    reason: lastError,
    candidates: subject.candidates.map((candidate) => ({
      ...candidate,
      dispatchPaused: null,
      lastError: null
    })),
    readAtMs: null,
    lastError
  };
}

function parseWrapperCandidates(raw, name) {
  let parsed;
  try {
    parsed = JSON.parse(requireValue(raw, name));
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`${name} must be valid JSON.`);
  }
  return parsed;
}

function sameAddress(left, right) {
  return typeof left === "string"
    && typeof right === "string"
    && left.toLowerCase() === right.toLowerCase();
}

function normalizeReadCompletion(raw, fallback) {
  const value = typeof raw === "number" ? raw : Date.parse(raw ?? "");
  return Number.isFinite(value) ? value : fallback;
}

function requestFromWatch(watch, nowMs, observation = undefined) {
  const startedAtMs = Date.parse(watch?.startedAt ?? "");
  const deadlineAtMs = Date.parse(watch?.deadlineAt ?? "");
  const invalidTiming = !Number.isFinite(startedAtMs)
    || !Number.isFinite(deadlineAtMs)
    || startedAtMs > nowMs
    || deadlineAtMs < startedAtMs;
  const reconciliation = safeTerminalReconciliation(watch?.reconciliation);
  const balanceTerminal = watch?.status !== "pending";
  // A balance terminal is only an observation. Until the settlement watcher
  // records the chain-side finalization, the board must not call it succeeded.
  // Historical manual recoveries carry their explicit reconciliation instead.
  const chainSettlementConfirmed = observationConfirmsChainSettlement(watch, observation);
  const finalizationPending = balanceTerminal && !reconciliation && !chainSettlementConfirmed;
  const finalizationErrored = finalizationPending
    && Boolean(observation?.lastError)
    && !observation?.processed;
  const terminal = balanceTerminal && !finalizationPending;
  const item = {
    id: String(watch?.requestId ?? "unknown-request"),
    wrapperAddress: String(watch?.wrapperAddress ?? "unknown-wrapper"),
    kind: String(watch?.kind ?? inferRequestKind(watch?.direction)),
    phase: String(
      finalizationErrored
        ? "finalize-error"
        : finalizationPending
          ? "pending-finalize"
          : invalidTiming
            ? "timing-unknown"
            : watch?.phase ?? (watch?.lastError ? "recovery-pending" : "pending-finalize")
    ),
    ageSeconds: Number.isFinite(startedAtMs)
      ? Math.max(Math.floor((nowMs - startedAtMs) / 1000), 0)
      : 0,
    // An unreadable deadline fails toward the alarm, not toward all-clear.
    overdue: terminal || finalizationPending ? false : invalidTiming || nowMs >= deadlineAtMs,
    status: finalizationErrored
      ? "error"
      : finalizationPending
        ? "pending"
        : String(watch?.status ?? "pending")
  };
  if (finalizationPending) {
    item.observedOutcome = String(watch?.status ?? observation?.status ?? "unknown");
    item.finalization = {
      status: finalizationErrored ? "error" : "pending",
      attemptCount: Number(observation?.attemptCount ?? 0),
      lastError: observation?.lastError
        ? redactProviderError(observation.lastError) || "finalization_failed"
        : null,
      lastTriedAt: observation?.lastTriedAt ?? null,
      nextAttemptAt: observation?.nextAttemptAt ?? null
    };
    if (observation?.processed && !chainSettlementConfirmed) {
      item.finalization.chainConfirmation = "missing_or_mismatched";
    }
  }
  if (!terminal && !finalizationPending && !invalidTiming) item.deadlineAtMs = deadlineAtMs;
  if (terminal && reconciliation) item.reconciliation = reconciliation;
  return item;
}

function observationConfirmsChainSettlement(watch, observation) {
  if (!observation?.processed) return false;
  const proof = observation?.result?.chainSettlement;
  if (!proof || typeof proof !== "object") return false;
  return sameAddress(proof.wrapperAddress, watch?.wrapperAddress)
    && String(proof.requestId ?? "").toLowerCase() === String(watch?.requestId ?? "").toLowerCase()
    && String(proof.status ?? "").toLowerCase() === String(watch?.status ?? "").toLowerCase()
    && String(proof.settledAssetsRaw ?? "") === String(observation?.settledAssets ?? "")
    && String(proof.settledSharesRaw ?? "") === String(observation?.settledShares ?? "");
}

function safeTerminalReconciliation(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const fields = [
    "stagedRaw",
    "actualTreasuryReturnRaw",
    "leg1TransferFeeRaw",
    "trappedWriteOff3Raw",
    "recoveryReturnFeeRaw",
    "remoteRecoverableRaw",
    "unexplainedRaw",
    "finalRawRecoverySlotResidueRaw",
    "artifactLabel"
  ];
  const value = Object.fromEntries(fields
    .filter((field) => raw[field] !== undefined)
    .map((field) => [field, String(raw[field])]));
  return Object.keys(value).length > 0 ? value : undefined;
}

function classifyPositionWatch(watch, positionTargets) {
  if (!watch?.target || !positionTargets) return "unknown";
  try {
    const target = normalizeVenueBalanceTarget(watch.target);
    if (target.ledger !== "erc20") return "unknown";
    const candidates = Array.isArray(positionTargets) ? positionTargets : [positionTargets];
    return candidates.some((candidate) => {
      const normalized = normalizeVenueBalanceTarget(candidate);
      return target.contract === normalized.contract && target.evmAccount === normalized.evmAccount;
    })
      ? "current"
      : "foreign";
  } catch {
    return "unknown";
  }
}

function inferRequestKind(direction) {
  if (direction === "increase") return "deposit";
  if (direction === "decrease") return "withdraw";
  return "unknown";
}

function nextCalibration({ previous, position }) {
  const current = validCalibration(previous, position.source);
  if (current) return current;
  if (position.raw === null) return null;
  try {
    if (BigInt(position.raw) <= 0n) return null;
  } catch {
    return null;
  }
  return {
    provenAtMs: position.readAtMs,
    provenRaw: position.raw,
    provenSource: position.source
  };
}

function validCalibration(raw, source) {
  if (!raw || raw.provenSource !== source) return null;
  if (!Number.isFinite(raw.provenAtMs)) return null;
  try {
    if (BigInt(raw.provenRaw) <= 0n) return null;
  } catch {
    return null;
  }
  return {
    provenAtMs: raw.provenAtMs,
    provenRaw: BigInt(raw.provenRaw).toString(),
    provenSource: raw.provenSource
  };
}

function readForCurrentTarget(raw, source) {
  if (!raw || raw.source !== source) return unread(source);
  const normalizedRaw = normalizeRawOrNull(raw.raw);
  const invalidStoredRead = raw.raw !== null && raw.raw !== undefined && normalizedRaw === null;
  const missingFailureReason = normalizedRaw === null
    && Number.isFinite(raw.readAtMs)
    && !raw.lastError;
  return {
    raw: normalizedRaw,
    source,
    readAtMs: Number.isFinite(raw.readAtMs) ? raw.readAtMs : null,
    lastError: raw.lastError
      ? String(raw.lastError)
      : invalidStoredRead || missingFailureReason
        ? "stored_balance_snapshot_invalid"
        : null
  };
}

function normalizeRawOrNull(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    const value = normalizeSuccessfulRaw(raw);
    return value >= 0n ? value.toString() : null;
  } catch {
    return null;
  }
}

function normalizeRequests(raw) {
  if (!raw) {
    return { items: [], readAtMs: null, lastError: null };
  }
  const storedItems = Array.isArray(raw.items) ? raw.items : [];
  let invalid = !Array.isArray(raw.items) || !Number.isFinite(raw.readAtMs);
  const items = storedItems.map((item) => {
    const id = String(item?.id ?? "").trim();
    const wrapperAddress = String(item?.wrapperAddress ?? "").toLowerCase();
    const kind = String(item?.kind ?? "").trim();
    const phase = String(item?.phase ?? "").trim();
    const ageSeconds = Number(item?.ageSeconds);
    const deadlineAtMs = item?.deadlineAtMs;
    const itemValid = Boolean(id && /^0x[a-f0-9]{40}$/u.test(wrapperAddress) && kind && phase)
      && Number.isFinite(ageSeconds)
      && ageSeconds >= 0
      && (deadlineAtMs === undefined || Number.isFinite(deadlineAtMs))
      && typeof item?.overdue === "boolean";
    if (itemValid) {
      const normalized = {
        id,
        wrapperAddress,
        kind,
        phase,
        ageSeconds,
        overdue: item.overdue,
        status: String(item?.status ?? (phase === "terminal" ? "unknown-terminal" : "pending"))
      };
      if (phase !== "terminal" && Number.isFinite(deadlineAtMs)) normalized.deadlineAtMs = deadlineAtMs;
      if ((phase === "pending-finalize" || phase === "finalize-error")
        && item?.finalization && typeof item.finalization === "object") {
        normalized.observedOutcome = String(item?.observedOutcome ?? "unknown");
        normalized.finalization = {
          status: item.finalization.status === "error" ? "error" : "pending",
          attemptCount: Number.isSafeInteger(item.finalization.attemptCount)
            && item.finalization.attemptCount >= 0
            ? item.finalization.attemptCount
            : 0,
          lastError: item.finalization.lastError
            ? String(item.finalization.lastError)
            : null,
          lastTriedAt: item.finalization.lastTriedAt
            ? String(item.finalization.lastTriedAt)
            : null,
          nextAttemptAt: item.finalization.nextAttemptAt
            ? String(item.finalization.nextAttemptAt)
            : null
        };
      }
      const reconciliation = safeTerminalReconciliation(item?.reconciliation);
      if (phase === "terminal" && reconciliation) normalized.reconciliation = reconciliation;
      return normalized;
    }
    invalid = true;
    return {
      id: id || "unknown-request",
      wrapperAddress: wrapperAddress || "unknown-wrapper",
      kind: kind || "unknown",
      phase: "snapshot-invalid",
      ageSeconds: Number.isFinite(ageSeconds) && ageSeconds >= 0 ? ageSeconds : 0,
      overdue: true
    };
  });
  return {
    items,
    readAtMs: Number.isFinite(raw.readAtMs) ? raw.readAtMs : null,
    lastError: raw.lastError
      ? String(raw.lastError)
      : invalid
        ? "stored_request_snapshot_invalid"
        : null
  };
}

function normalizeSuccessfulRaw(raw) {
  if (typeof raw === "bigint") {
    if (raw < 0n) throw new Error("balance reader returned a negative raw value");
    return raw;
  }
  if (typeof raw === "string" && /^(0|[1-9][0-9]*)$/u.test(raw)) {
    return BigInt(raw);
  }
  throw new Error("balance reader returned an invalid raw integer");
}

function disabledFeed() {
  const lastError = "bank_lane_feed_disabled";
  return {
    subject: {
      configuredWrapper: null,
      uniqueArmedWrapper: null,
      matches: null,
      status: "unknown",
      reason: lastError,
      candidates: [],
      readAtMs: null,
      lastError
    },
    position: { ...unread("unconfigured:position"), lastError },
    float: { ...unread("unconfigured:float"), lastError },
    postage: { ...unread("unconfigured:postage"), lastError },
    requests: { items: [], readAtMs: null, lastError },
    calibration: null
  };
}

function unread(source) {
  return { raw: null, source, readAtMs: null, lastError: null };
}

function requireValue(raw, name) {
  const value = String(raw ?? "").trim();
  if (!value) throw new ValidationError(`${name} is required when BANK_LANE_FEED_ENABLED=true.`);
  return value;
}

function requireAddressValue(raw, name) {
  const value = requireValue(raw, name);
  if (!ADDRESS_RE.test(value)) {
    throw new ValidationError(`${name} must be a 0x + 20-byte EVM address.`);
  }
  return value;
}

function parseBoolean(raw) {
  return ["1", "true", "yes", "on"].includes(String(raw ?? "").trim().toLowerCase());
}

export { DEFAULT_STATE_SCOPE as BANK_LANE_FEED_STATE_SCOPE };

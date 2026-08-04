import { ValidationError } from "../core/errors.js";
import { redactProviderError } from "../core/redact-provider-error.js";
import { normalizeVenueBalanceTarget } from "./venue-balance-reader.js";

const DEFAULT_STATE_SCOPE = "bank-lane-feed";
const ALL_PENDING_REQUESTS_LIMIT = Number.MAX_SAFE_INTEGER;
const RECENT_TERMINAL_REQUESTS_LIMIT = 10;

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
      targets = undefined,
      now = () => Date.now(),
      stateScope = DEFAULT_STATE_SCOPE
    } = {}
  ) {
    this.stateStore = stateStore;
    this.balanceReader = balanceReader;
    this.enabled = enabled;
    this.now = now;
    this.stateScope = String(stateScope || DEFAULT_STATE_SCOPE);
    this.targets = enabled ? normalizeFeedTargets(targets) : undefined;
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
        .then((requests) => this.persistSection("requests", requests))
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
      return {
        // Request ids are scoped by wrapper on-chain, but the durable observer
        // table predates that namespace and is keyed by request id alone. v2.0
        // and v2.1 can therefore share an id. A valid watch aimed at another
        // venue target is known-retired work and must not alarm on the active
        // lane. Unknown/malformed targets remain visible (and overdue) rather
        // than being silently classified as safe.
        items: [...pending, ...terminal]
          .filter((watch) => this.classifyRequestWatch(watch) !== "foreign")
          .map((watch) => requestFromWatch(watch, readAtMs)),
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

  async persistPosition(position) {
    return this.enqueuePersistence(async () => {
      const previous = await this.stateStore.getServiceState?.(this.stateScope) ?? {};
      const calibration = nextCalibration({ previous: previous.calibration, position });
      await this.stateStore.upsertServiceState?.(this.stateScope, { position, calibration });
    });
  }

  classifyRequestWatch(watch) {
    return classifyPositionWatch(watch, this.targets?.position);
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

function normalizeReadCompletion(raw, fallback) {
  const value = typeof raw === "number" ? raw : Date.parse(raw ?? "");
  return Number.isFinite(value) ? value : fallback;
}

function requestFromWatch(watch, nowMs) {
  const startedAtMs = Date.parse(watch?.startedAt ?? "");
  const deadlineAtMs = Date.parse(watch?.deadlineAt ?? "");
  const invalidTiming = !Number.isFinite(startedAtMs)
    || !Number.isFinite(deadlineAtMs)
    || startedAtMs > nowMs
    || deadlineAtMs < startedAtMs;
  const terminal = watch?.status !== "pending";
  const item = {
    id: String(watch?.requestId ?? "unknown-request"),
    kind: String(watch?.kind ?? inferRequestKind(watch?.direction)),
    phase: String(
      invalidTiming
        ? "timing-unknown"
        : watch?.phase ?? (watch?.lastError ? "recovery-pending" : "pending-finalize")
    ),
    ageSeconds: Number.isFinite(startedAtMs)
      ? Math.max(Math.floor((nowMs - startedAtMs) / 1000), 0)
      : 0,
    // An unreadable deadline fails toward the alarm, not toward all-clear.
    overdue: terminal ? false : invalidTiming || nowMs >= deadlineAtMs,
    status: String(watch?.status ?? "pending")
  };
  const reconciliation = safeTerminalReconciliation(watch?.reconciliation);
  if (terminal && reconciliation) item.reconciliation = reconciliation;
  return item;
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

function classifyPositionWatch(watch, positionTarget) {
  if (!watch?.target || !positionTarget) return "unknown";
  try {
    const target = normalizeVenueBalanceTarget(watch.target);
    if (target.ledger !== "erc20") return "unknown";
    return target.contract === positionTarget.contract
      && target.evmAccount === positionTarget.evmAccount
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
    const kind = String(item?.kind ?? "").trim();
    const phase = String(item?.phase ?? "").trim();
    const ageSeconds = Number(item?.ageSeconds);
    const itemValid = Boolean(id && kind && phase)
      && Number.isFinite(ageSeconds)
      && ageSeconds >= 0
      && typeof item?.overdue === "boolean";
    if (itemValid) {
      const normalized = {
        id,
        kind,
        phase,
        ageSeconds,
        overdue: item.overdue,
        status: String(item?.status ?? (phase === "terminal" ? "unknown-terminal" : "pending"))
      };
      const reconciliation = safeTerminalReconciliation(item?.reconciliation);
      if (phase === "terminal" && reconciliation) normalized.reconciliation = reconciliation;
      return normalized;
    }
    invalid = true;
    return {
      id: id || "unknown-request",
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

function parseBoolean(raw) {
  return ["1", "true", "yes", "on"].includes(String(raw ?? "").trim().toLowerCase());
}

export { DEFAULT_STATE_SCOPE as BANK_LANE_FEED_STATE_SCOPE };

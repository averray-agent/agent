import { formatUnits } from "ethers";

import { DEFAULT_ESCROW_ASSET, ASSET_DECIMALS_BY_SYMBOL } from "../core/assets.js";
import { claimExpiresAt } from "../core/claim-state.js";
import { ValidationError } from "../core/errors.js";
import { parseGithubPullRequestUrl } from "../core/funded-jobs.js";
import { approvedSettlement, RETAINED_WINDOW_MS } from "../core/retained-workers.js";
import { SelfIdentityRegistry } from "../core/self-identity-registry.js";
import { settlementOutcome } from "../core/session-settlement.js";
import { boundGithubAuthor } from "./github-author-visibility.js";

export const BANK_MOVES_SCHEMA = "averray.admin.bank-moves.v1";
export const NOT_REPORTED = "not reported";
export const BANK_MOVES_DEFAULT_LIMIT = 100;
export const BANK_MOVES_MAX_LIMIT = 200;
export const BANK_MOVES_EVENT_READ_LIMIT = 5_000;
export const BANK_MOVES_SESSION_READ_LIMIT = 10_000;

const MOVE_TOPICS = Object.freeze({
  "account.reserved": "reserve",
  "account.reservation_settled": "settle",
  "account.reservation_released": "refund",
  "account.deposited": "deposit"
});
const FUND_TOPIC = "escrow.job_funded";
const RELEASE_TOPICS = Object.freeze([
  "escrow.job_rejected",
  "escrow.job_cancelled",
  "escrow.auto_resolved_on_timeout",
  "escrow.dispute_resolved",
  "escrow.job_closed"
]);
const SETTLE_TOPICS = Object.freeze([
  "escrow.auto_resolved_on_timeout",
  "escrow.dispute_resolved",
  "escrow.job_closed"
]);
const JOIN_TOPICS = Object.freeze({
  reserve: [FUND_TOPIC],
  refund: RELEASE_TOPICS,
  settle: SETTLE_TOPICS
});
const FUNNEL_RANK = new Map([
  ["signed_in", 1],
  ["preflighted", 2],
  ["claimed", 3],
  ["submitted", 4],
  ["verified", 5],
  ["settled", 6]
]);
const TRAIL_STAGE = new Map([
  ["authenticated", "signed_in"],
  ["claimed", "claimed"],
  ["submitted", "submitted"],
  ["settled", "settled"]
]);
const OPEN_STATUSES = new Set(["claimed", "submitted", "disputed"]);
const AWAITING_STATUSES = new Set(["claimed", "submitted"]);
const PAYOUT_ON_APPROVAL = new Set(["benchmark", "deterministic", "witness", "human_fallback"]);
const MONTHS = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
const WALLET_RE = /^0x[a-f0-9]{40}$/u;
const ARRIVAL_WALLET_RECORD_PREFIX = "arrival-session-record:wallet:";

const VERBS = Object.freeze({
  reserve: "reserved",
  settle: "settled",
  refund: "refunded",
  deposit: "deposited"
});

/**
 * Operator read of reward-bank reserve, settle, refund, and deposit events.
 * Job ids come only from an escrow event in the same transaction. Wallet tags
 * use sessions strictly before that move. Nothing here is inferred from amount
 * or time, and pre-auth telemetry is never attached to a wallet.
 *
 * One settlement transaction can emit several ReservationSettled logs. The
 * tagged wallet is always the joined session's worker. A leg whose recipient
 * is that worker stays `settled`. Any other recipient is `settled fee`, or
 * `settled retention` when exactly one such leg matches a same-transaction
 * GasRetentionApplied amount. Fee and retention recipients are never tagged.
 */
export function buildBankMoves({
  since,
  limit,
  generatedAt,
  sessions = [],
  events = [],
  bankAccounts = [],
  usdcAddresses = [],
  arrivalRecords = new Map(),
  selfIdentityRegistry,
  historyComplete = true,
  sessionReadCap = BANK_MOVES_SESSION_READ_LIMIT,
  eventReadCap = BANK_MOVES_EVENT_READ_LIMIT,
  eventLogBounded = false
} = {}) {
  const parsedSince = parseBankMovesSince(since);
  const parsedLimit = parseBankMovesLimit(limit);
  const registry = selfIdentityRegistry instanceof SelfIdentityRegistry
    ? selfIdentityRegistry
    : new SelfIdentityRegistry();
  const banks = addressSet(bankAccounts);
  const usdc = addressSet([DEFAULT_ESCROW_ASSET.address, ...usdcAddresses]);
  const sessionRows = Array.isArray(sessions) ? sessions : [];
  const eventRows = Array.isArray(events) ? events : [];
  const txEvents = groupByTx(eventRows);
  const attributed = [];

  if (banks.size === 0) {
    return responseShell({
      generatedAt,
      since: parsedSince,
      limit: parsedLimit,
      bankAccount: NOT_REPORTED,
      bankAccounts: [],
      historyComplete,
      sessionReadCap,
      eventReadCap,
      eventLogBounded,
      moves: [],
      gap: false,
      hasMore: false,
      unavailable: "reward_bank_account_unresolved"
    });
  }

  for (const event of eventRows) {
    const kind = MOVE_TOPICS[event?.topic];
    if (!kind || !banks.has(normalizeAddress(event.wallet))) continue;
    const at = validIso(event.timestamp);
    if (!at) continue;
    attributed.push(attributeMove({
      event,
      kind,
      at,
      txEvents: txEvents.get(normalizeHash(event.txHash)) ?? [],
      sessions: sessionRows,
      events: eventRows,
      usdc,
      arrivalRecords,
      registry,
      historyComplete
    }));
  }

  attributed.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  const window = selectSince(attributed, parsedSince, { eventLogBounded, events: eventRows });
  const page = window.moves.slice(0, parsedLimit);
  return responseShell({
    generatedAt,
    since: parsedSince,
    limit: parsedLimit,
    bankAccount: [...banks][0],
    bankAccounts: [...banks].sort(),
    historyComplete,
    sessionReadCap,
    eventReadCap,
    eventLogBounded,
    moves: page,
    gap: window.gap,
    hasMore: window.moves.length > page.length,
    unavailable: NOT_REPORTED
  });
}

export function parseBankMovesSince(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new ValidationError("since must be an ISO timestamp or a move cursor.", { field: "since" });
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(raw)) {
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) {
      throw new ValidationError("since must be an ISO timestamp or a move cursor.", { field: "since", value });
    }
    return { kind: "timestamp", value: new Date(ms).toISOString(), ms };
  }
  if (raw.length > 200 || /[\u0000-\u001f]/u.test(raw)) {
    throw new ValidationError("since must be an ISO timestamp or a move cursor.", { field: "since" });
  }
  return { kind: "cursor", value: raw };
}

export function parseBankMovesLimit(value) {
  if (value === undefined || value === null || value === "") return BANK_MOVES_DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > BANK_MOVES_MAX_LIMIT) {
    throw new ValidationError("limit must be an integer from 1 to 200.", { field: "limit", value });
  }
  return parsed;
}

export function bankMoveWallets({ sessions = [], events = [], bankAccounts = [] } = {}) {
  const banks = addressSet(bankAccounts);
  const wallets = new Set();
  for (const session of sessions) {
    const wallet = normalizeAddress(session?.wallet);
    if (wallet) wallets.add(wallet);
  }
  for (const event of events) {
    if (!banks.has(normalizeAddress(event?.wallet))) continue;
    const recipient = normalizeAddress(event?.data?.recipient);
    if (recipient) wallets.add(recipient);
    if (event?.topic === "account.deposited") {
      const account = normalizeAddress(event.wallet);
      if (account) wallets.add(account);
    }
  }
  return wallets;
}

export async function loadWalletArrivalRecords(stateStore, wallets) {
  const records = new Map();
  if (typeof stateStore?.getServiceState !== "function") return records;
  await Promise.all([...wallets].map(async (wallet) => {
    const record = await stateStore.getServiceState(`${ARRIVAL_WALLET_RECORD_PREFIX}${wallet}`);
    if (record && typeof record === "object") records.set(wallet, record);
  }));
  return records;
}

export function formatBankMoveDisplay(raw, decimals) {
  const text = formatUnits(raw, decimals);
  const [whole, fraction = ""] = text.split(".");
  const padded = fraction.padEnd(2, "0");
  const trimmed = padded.replace(/0+$/u, "");
  const shown = trimmed.length >= 2 ? trimmed : padded.slice(0, 2);
  return `${whole}.${shown}`;
}

function attributeMove({
  event,
  kind,
  at,
  txEvents,
  sessions,
  events,
  usdc,
  arrivalRecords,
  registry,
  historyComplete
}) {
  const join = joinMove(kind, txEvents, sessions);
  const wallet = workerWallet(kind, event, join);
  const moveMs = Date.parse(at);
  const earlier = wallet ? earlierSessions(sessions, wallet, moveMs, join.session?.sessionId) : [];
  const undated = wallet ? hasUndatedSibling(sessions, wallet, join.session?.sessionId) : false;
  const arrivalRecord = wallet ? arrivalRecords.get(wallet) : undefined;
  const clientSoftware = clientSoftwareOf(arrivalRecord);
  const tag = classifyTag({
    kind,
    wallet,
    session: join.session,
    earlier,
    historyComplete: historyComplete && !undated,
    joined: join.joined,
    clientSoftware,
    registry,
    moveMs
  });
  const amount = amountOf(event, usdc, kind);
  const part = settlementPart(kind, event, join, txEvents);
  const work = workOf(kind, join, events, at);
  const githubAuthor = githubAuthorOf(join.session);
  const arrival = {
    door: kind === "deposit" ? NOT_REPORTED : doorOf(join.session, arrivalRecord),
    clientSoftware: kind === "deposit" ? NOT_REPORTED : clientSoftware,
    funnelStage: funnelStage({ kind, session: join.session, wallet, events, arrivalRecord })
  };
  const next = nextOf(kind, join.session, work.job);
  const walletView = {
    address: wallet ?? NOT_REPORTED,
    short: wallet ? shortAddress(wallet) : NOT_REPORTED,
    tag: tag.tag,
    githubAuthor,
    counts: tag.counts
  };
  return {
    id: moveId(event),
    at,
    txHash: normalizeHash(event.txHash) ?? NOT_REPORTED,
    kind,
    part,
    amount,
    line: lineFor({ amount, kind, part, work, wallet: walletView, arrival, next, at }),
    work: publicWork(work),
    wallet: walletView,
    arrival,
    next: {
      claimExpiresAt: next.claimExpiresAt,
      expected: next.expected,
      humanReview: next.humanReview
    },
    attribution: {
      job: kind === "deposit" ? "no job" : join.joined ? "reported" : "not reported",
      basis: join.basis
    }
  };
}

function joinMove(kind, txEvents, sessions) {
  if (kind === "deposit") return { joined: true, session: undefined, basis: "deposit" };
  const topics = new Set(JOIN_TOPICS[kind] ?? []);
  const matches = txEvents.filter((event) => topics.has(event.topic));
  const keys = matches.map(eventJobKey);
  const candidates = sessions.filter((session) => keys.length > 0 && keys.every((key) => eventMatchesSession(session, key)));
  if (candidates.length === 1) {
    return { joined: true, session: candidates[0], basis: basisFor(kind, matches), jobId: candidates[0].jobId };
  }
  const ids = unique(keys.map((key) => key.jobId || key.chainJobId).filter(Boolean));
  if (ids.length === 1) {
    return { joined: true, session: undefined, basis: basisFor(kind, matches), jobId: ids[0] };
  }
  return { joined: false, session: undefined, basis: NOT_REPORTED };
}

function eventJobKey(event) {
  return {
    jobId: text(event?.jobId) || text(event?.data?.jobId) || text(event?.data?.job?.id),
    chainJobId: text(event?.data?.chainJobId),
    sessionId: text(event?.sessionId)
  };
}

function eventMatchesSession(session, key) {
  // A derived session id from before the claim row exists must not hide the
  // chain job id ensureJob already emitted.
  if (key.sessionId && session?.sessionId === key.sessionId) return true;
  if (key.jobId && (sameId(session?.jobId, key.jobId) || sameId(session?.chainJobId, key.jobId))) return true;
  if (key.chainJobId && (sameId(session?.chainJobId, key.chainJobId) || sameId(session?.jobId, key.chainJobId))) {
    return true;
  }
  return false;
}

function basisFor(kind, matches) {
  const order = kind === "refund" ? RELEASE_TOPICS : kind === "settle" ? SETTLE_TOPICS : [FUND_TOPIC];
  return order.find((topic) => matches.some((event) => event.topic === topic)) ?? NOT_REPORTED;
}

function workerWallet(kind, event, join) {
  if (kind === "deposit") return normalizeAddress(event.wallet);
  return normalizeAddress(join.session?.wallet);
}

function settlementPart(kind, event, join, txEvents) {
  if (kind !== "settle") return NOT_REPORTED;
  const worker = normalizeAddress(join.session?.wallet);
  const recipient = normalizeAddress(event?.data?.recipient);
  if (!worker || !recipient) return NOT_REPORTED;
  if (recipient === worker) return "worker";
  return uniqueRetentionLeg(event, txEvents, worker) ? "retention" : "fee";
}

function uniqueRetentionLeg(event, txEvents, worker) {
  const amount = rawAmount(event);
  if (!amount) return false;
  const retentionAmounts = txEvents
    .filter((row) => row.topic === "escrow.gas_retention_applied")
    .map((row) => String(row?.data?.retainedRaw ?? row?.data?.amount ?? ""))
    .filter((value) => value === amount);
  if (retentionAmounts.length !== 1) return false;
  const matches = txEvents.filter((row) => (
    row.topic === "account.reservation_settled"
    && rawAmount(row) === amount
    && normalizeAddress(row?.data?.recipient) !== worker
  ));
  return matches.length === 1 && matches[0] === event;
}

function earlierSessions(sessions, wallet, moveMs, currentSessionId) {
  return sessions.filter((session) => {
    if (normalizeAddress(session?.wallet) !== wallet) return false;
    if (currentSessionId && session.sessionId === currentSessionId) return false;
    const at = earliestActivity(session);
    return Number.isFinite(at) && at < moveMs;
  });
}

function hasUndatedSibling(sessions, wallet, currentSessionId) {
  return sessions.some((session) => {
    if (normalizeAddress(session?.wallet) !== wallet) return false;
    if (currentSessionId && session.sessionId === currentSessionId) return false;
    return !Number.isFinite(earliestActivity(session));
  });
}

function classifyTag({
  kind,
  wallet,
  session,
  earlier,
  historyComplete,
  joined,
  clientSoftware,
  registry,
  moveMs
}) {
  if (kind === "deposit") return { tag: "self", counts: NOT_REPORTED };
  const identity = registry.classifySessions({
    wallet,
    sessions: session ? [session, ...earlier] : earlier
  });
  if (identity?.self === true) return { tag: "self", counts: NOT_REPORTED };
  if (!historyComplete) return { tag: "ambiguous", counts: NOT_REPORTED };
  if (!joined || !wallet) return { tag: "ambiguous", counts: NOT_REPORTED };
  if (clientSoftware !== NOT_REPORTED && registry.classify({ clientInfo: { name: clientSoftware } }).ambiguous === true) {
    return { tag: "ambiguous", counts: NOT_REPORTED };
  }
  if (earlier.length === 0) return { tag: "first arrival", counts: NOT_REPORTED };
  const counts = countHistory(earlier);
  if (earlier.some((row) => approvedInWindow(row, moveMs))) return { tag: "regular", counts };
  return { tag: "returning", counts };
}

function approvedInWindow(session, moveMs) {
  if (!approvedSettlement(session)) return false;
  const at = Date.parse(session?.resolvedAt ?? "");
  return Number.isFinite(at) && at > moveMs - RETAINED_WINDOW_MS && at < moveMs;
}

function countHistory(sessions) {
  const jobs = new Set();
  let settled = 0;
  let rejected = 0;
  let open = 0;
  let firstSeenMs = Infinity;
  for (const session of sessions) {
    jobs.add(String(session.jobId ?? session.sessionId));
    const at = earliestActivity(session);
    if (Number.isFinite(at) && at < firstSeenMs) firstSeenMs = at;
    if (approvedSettlement(session)) settled += 1;
    else if (session.status === "rejected" || settlementOutcome(session) === "rejected") rejected += 1;
    else if (OPEN_STATUSES.has(session.status)) open += 1;
  }
  return {
    jobs: jobs.size,
    settled,
    rejected,
    open,
    firstSeen: Number.isFinite(firstSeenMs) ? new Date(firstSeenMs).toISOString() : NOT_REPORTED
  };
}

function workOf(kind, join, events, at) {
  if (kind === "deposit") return blankWork("deposit");
  if (!join.joined) return blankWork("missing");
  const job = jobDefinition(join.session);
  const pull = pullRequest(join.session);
  const issueNumber = Number(job?.source?.issueNumber);
  const reference = pull
    ? { referenceKind: "pull_request", referenceNumber: pull.pullNumber }
    : Number.isInteger(issueNumber) && issueNumber > 0
      ? { referenceKind: "issue", referenceNumber: issueNumber }
      : { referenceKind: NOT_REPORTED, referenceNumber: NOT_REPORTED };
  return {
    jobId: text(join.session?.jobId) || text(join.jobId) || NOT_REPORTED,
    sessionId: text(join.session?.sessionId) || NOT_REPORTED,
    profile: profileOf(job),
    jobType: text(job?.jobType) || NOT_REPORTED,
    repo: text(job?.source?.repo) || pull?.repo || NOT_REPORTED,
    ...reference,
    rewardAmount: rewardAmountOf(job),
    rewardAsset: text(job?.rewardAsset) || NOT_REPORTED,
    status: moveStatus(kind, join, events, at),
    job,
    lineKind: "job"
  };
}

function blankWork(lineKind) {
  return {
    jobId: NOT_REPORTED,
    sessionId: NOT_REPORTED,
    profile: NOT_REPORTED,
    jobType: NOT_REPORTED,
    repo: NOT_REPORTED,
    referenceKind: NOT_REPORTED,
    referenceNumber: NOT_REPORTED,
    rewardAmount: NOT_REPORTED,
    rewardAsset: NOT_REPORTED,
    status: NOT_REPORTED,
    job: undefined,
    lineKind
  };
}

function publicWork(work) {
  return {
    jobId: work.jobId,
    sessionId: work.sessionId,
    profile: work.profile,
    jobType: work.jobType,
    repo: work.repo,
    referenceKind: work.referenceKind,
    referenceNumber: work.referenceNumber,
    rewardAmount: work.rewardAmount,
    rewardAsset: work.rewardAsset,
    status: work.status
  };
}

function moveStatus(kind, join, events, at) {
  if (kind === "reserve") return "claimed";
  if (kind === "settle") return "settled";
  if (kind === "refund") {
    if (join.basis === "escrow.job_rejected" || laterCloseOfRejection(join, events, at)) return "rejected";
    return "refunded";
  }
  return NOT_REPORTED;
}

function laterCloseOfRejection(join, events, at) {
  if (join.basis !== "escrow.job_closed") return false;
  const ids = [join.session?.jobId, join.session?.chainJobId, join.jobId].filter(Boolean);
  const moveMs = Date.parse(at ?? "");
  if (!Number.isFinite(moveMs) || ids.length === 0) return false;
  return events.some((event) => {
    if (event?.topic !== "escrow.job_rejected") return false;
    const key = eventJobKey(event);
    const sameJob = ids.some((id) => sameId(key.jobId, id) || sameId(key.chainJobId, id));
    const rejectedMs = Date.parse(event?.timestamp ?? "");
    return sameJob && Number.isFinite(rejectedMs) && rejectedMs < moveMs;
  });
}

function rawAmount(event) {
  const raw = event?.data?.amountRaw ?? event?.data?.amount;
  return /^(0|[1-9][0-9]*)$/u.test(String(raw ?? "")) ? String(raw) : undefined;
}

function amountOf(event, usdc, kind) {
  const raw = rawAmount(event);
  const known = raw !== undefined;
  const asset = assetOf(event, usdc);
  const direction = kind === "settle" || kind === "refund" ? "out" : "in";
  return {
    raw: known ? String(raw) : NOT_REPORTED,
    decimals: asset.decimals,
    display: known && Number.isInteger(asset.decimals) ? formatBankMoveDisplay(BigInt(raw), asset.decimals) : NOT_REPORTED,
    asset: asset.asset,
    direction
  };
}

function assetOf(event, usdc) {
  const symbol = String(event?.data?.assetSymbol ?? "").trim().toUpperCase();
  if (ASSET_DECIMALS_BY_SYMBOL[symbol]) {
    return { asset: symbol, decimals: ASSET_DECIMALS_BY_SYMBOL[symbol] };
  }
  const address = normalizeAddress(event?.data?.asset);
  if (address && usdc.has(address)) return { asset: "USDC", decimals: DEFAULT_ESCROW_ASSET.decimals };
  return { asset: NOT_REPORTED, decimals: NOT_REPORTED };
}

function funnelStage({ kind, session, wallet, events, arrivalRecord }) {
  if (kind === "deposit" || !wallet) return NOT_REPORTED;
  let best;
  const consider = (stage) => {
    if (!FUNNEL_RANK.has(stage)) return;
    if (!best || FUNNEL_RANK.get(stage) > FUNNEL_RANK.get(best)) best = stage;
  };
  if (session) consider(sessionStage(session));
  // These two topics are published only after auth middleware succeeds.
  // journey.auth_nonce_issued is the pre-auth step and is never a stage.
  for (const event of events) {
    if (normalizeAddress(event?.wallet) !== wallet) continue;
    if (event.topic === "journey.auth_verified") consider("signed_in");
    if (event.topic === "journey.preflight_completed") consider("preflighted");
  }
  if (!session) consider(TRAIL_STAGE.get(arrivalRecord?.furthestStage));
  return best ?? NOT_REPORTED;
}

function sessionStage(session) {
  if (approvedSettlement(session)) return "settled";
  if (settlementOutcome(session)) return "verified";
  if (session?.status === "rejected" || session?.rejectedAt) return "verified";
  if (session?.submittedAt || session?.status === "submitted") return "submitted";
  if (session?.claimedAt || session?.status === "claimed") return "claimed";
  return undefined;
}

function nextOf(kind, session, job) {
  const empty = { claimExpiresAt: NOT_REPORTED, expected: NOT_REPORTED, humanReview: NOT_REPORTED };
  if (kind !== "reserve" || !session) return empty;
  const awaiting = AWAITING_STATUSES.has(session.status);
  const expires = session.status === "claimed" ? claimExpiresAt(session, job) : undefined;
  const lookup = boundLookup(session);
  let expected = NOT_REPORTED;
  if (awaiting && (job?.verifierMode === "github_pr" || job?.source?.type === "github_issue")) {
    expected = "payout on merge";
  } else if (awaiting && PAYOUT_ON_APPROVAL.has(job?.verifierMode)) {
    expected = "payout on approval";
  }
  let humanReview = NOT_REPORTED;
  if (awaiting && (job?.verifierMode === "github_pr" || job?.source?.type === "github_issue") && typeof lookup?.merged === "boolean") {
    humanReview = lookup.merged ? "none" : "pending";
  }
  return {
    claimExpiresAt: expires || NOT_REPORTED,
    expected,
    humanReview
  };
}

function lineFor({ amount, kind, part, work, wallet, arrival, next, at }) {
  const signed = amount.display === NOT_REPORTED
    ? NOT_REPORTED
    : `${amount.direction === "out" ? "-" : "+"}${amount.display}`;
  return [
    `${signed} ${verbFor(kind, part)}`,
    workLine(work),
    walletLine(wallet, at),
    `${arrival.door}, client "${lineToken(arrival.clientSoftware)}", stage ${arrival.funnelStage}`,
    nextLine(next)
  ].join(" · ");
}

function verbFor(kind, part) {
  if (kind === "settle" && part === "fee") return "settled fee";
  if (kind === "settle" && part === "retention") return "settled retention";
  return VERBS[kind];
}

function workLine(work) {
  if (work.lineKind === "deposit") return "no job";
  if (work.lineKind === "missing" || work.jobId === NOT_REPORTED) return "job not reported";
  const id = lineToken(work.jobId);
  const jobText = work.profile !== NOT_REPORTED ? `job ${id} (${lineToken(work.profile)})` : `job ${id}`;
  return work.status === "rejected" ? `${jobText} rejected` : jobText;
}

function walletLine(wallet, at) {
  const who = wallet.short === NOT_REPORTED ? NOT_REPORTED : wallet.short;
  const author = wallet.githubAuthor !== NOT_REPORTED ? `, github @${lineToken(wallet.githubAuthor)}` : "";
  if (!wallet.counts || wallet.counts === NOT_REPORTED) return `${who} ${wallet.tag}${author}`;
  const since = wallet.counts.firstSeen === NOT_REPORTED ? NOT_REPORTED : sinceLabel(wallet.counts.firstSeen, at);
  return `${who} ${wallet.tag} (${wallet.counts.jobs} jobs, ${wallet.counts.settled} settled, ${wallet.counts.rejected} rejected, ${wallet.counts.open} open, since ${since})${author}`;
}

function nextLine(next) {
  const parts = [];
  if (next.claimExpiresAt !== NOT_REPORTED) parts.push(`claim expires ${clockLabel(next.claimExpiresAt)}`);
  if (next.expected !== NOT_REPORTED) parts.push(next.expected);
  if (next.humanReview === "pending") parts.push("human review pending");
  return parts.length > 0 ? parts.join(", ") : NOT_REPORTED;
}

function responseShell({
  generatedAt,
  since,
  limit,
  bankAccount,
  bankAccounts,
  historyComplete,
  sessionReadCap,
  eventReadCap,
  eventLogBounded,
  moves,
  gap,
  hasMore,
  unavailable
}) {
  return {
    schemaVersion: BANK_MOVES_SCHEMA,
    generatedAt,
    since: { kind: since.kind, value: since.value },
    bankAccount,
    bankAccounts,
    history: {
      complete: historyComplete === true,
      sessionReadCap,
      eventReadCap,
      eventLogBounded: eventLogBounded === true,
      retainedWindowMs: RETAINED_WINDOW_MS
    },
    privacy: {
      containsNetworkIdentifiers: false,
      preAuthJoinedToWallet: false
    },
    unavailable,
    moves,
    returnedCount: moves.length,
    limit,
    hasMore,
    nextCursor: moves.length > 0 ? moves.at(-1).id : (since.kind === "cursor" ? since.value : null),
    gap
  };
}

function selectSince(moves, since, { eventLogBounded = false, events = [] } = {}) {
  if (since.kind === "timestamp") {
    const oldestEvent = events
      .map((event) => Date.parse(event?.timestamp ?? ""))
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0];
    const gap = eventLogBounded === true
      && Number.isFinite(oldestEvent)
      && oldestEvent > since.ms;
    return { moves: moves.filter((move) => Date.parse(move.at) >= since.ms), gap };
  }
  const index = moves.findIndex((move) => move.id === since.value);
  if (index === -1) return { moves, gap: moves.length > 0 || eventLogBounded === true };
  return { moves: moves.slice(index + 1), gap: false };
}

function clientSoftwareOf(record) {
  const name = text(record?.clientName);
  if (!name || name === NOT_REPORTED) return NOT_REPORTED;
  return name.slice(0, 64);
}

function doorOf(session, record) {
  const history = Array.isArray(session?.protocolHistory) ? session.protocolHistory : [];
  const fromSession = history.map((door) => String(door).trim().toLowerCase()).find((door) => door === "mcp" || door === "http");
  if (fromSession === "mcp") return "MCP";
  if (fromSession === "http") return "REST";
  const step = [...(record?.steps ?? [])].reverse().find((entry) => entry?.door === "mcp" || entry?.door === "http");
  if (step?.door === "mcp") return "MCP";
  if (step?.door === "http") return "REST";
  return NOT_REPORTED;
}

function githubAuthorOf(session) {
  return boundGithubAuthor(boundLookup(session))?.login ?? NOT_REPORTED;
}

function boundLookup(session) {
  const lookup = session?.verification?.githubLookup ?? session?.verificationSummary?.githubLookup;
  return boundGithubAuthor(lookup) ? lookup : undefined;
}

function jobDefinition(session) {
  const definition = session?.jobSnapshot?.definition;
  return definition && typeof definition === "object" ? definition : undefined;
}

function profileOf(job) {
  return text(job?.verification?.profile) || text(job?.verifierConfig?.profile) || text(job?.verifierMode) || NOT_REPORTED;
}

function rewardAmountOf(job) {
  if (!job || !Object.hasOwn(job, "rewardAmount")) return NOT_REPORTED;
  const amount = Number(job.rewardAmount);
  return Number.isFinite(amount) ? String(amount) : NOT_REPORTED;
}

function pullRequest(session) {
  const submission = session?.submission?.structured ?? session?.submission;
  const url = text(submission?.prUrl) || text(submission?.pullRequestUrl);
  return url ? parseGithubPullRequestUrl(url) : undefined;
}

function earliestActivity(session) {
  const stamps = [
    session?.claimedAt,
    session?.createdAt,
    session?.submittedAt,
    session?.resolvedAt,
    session?.rejectedAt,
    session?.updatedAt
  ].map((value) => Date.parse(value ?? ""));
  const finite = stamps.filter(Number.isFinite);
  return finite.length > 0 ? Math.min(...finite) : Number.NaN;
}

function groupByTx(events) {
  const grouped = new Map();
  for (const event of events) {
    const hash = normalizeHash(event?.txHash);
    if (!hash) continue;
    const rows = grouped.get(hash) ?? [];
    rows.push(event);
    grouped.set(hash, rows);
  }
  return grouped;
}

function moveId(event) {
  return text(event?.id) || `${normalizeHash(event?.txHash) ?? "no-tx"}:${event?.topic}`;
}

function shortAddress(address) {
  return `${address.slice(0, 6)}\u2026${address.slice(-2)}`;
}

function sinceLabel(iso, moveIso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return NOT_REPORTED;
  const move = new Date(moveIso);
  const year = Number.isFinite(move.getTime()) && move.getUTCFullYear() !== date.getUTCFullYear()
    ? `, ${date.getUTCFullYear()}`
    : "";
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}${year}`;
}

function clockLabel(iso) {
  const match = /T(\d{2}):(\d{2})/u.exec(String(iso));
  return match ? `${match[1]}:${match[2]}Z` : NOT_REPORTED;
}

function lineToken(value) {
  return String(value).replace(/[\u0000-\u001f"]/gu, "").replaceAll("·", "-");
}

function addressSet(values) {
  return new Set(values.map(normalizeAddress).filter(Boolean));
}

function normalizeAddress(value) {
  const wallet = String(value ?? "").trim().toLowerCase();
  return WALLET_RE.test(wallet) ? wallet : undefined;
}

function normalizeHash(value) {
  const hash = String(value ?? "").trim().toLowerCase();
  return /^0x[a-f0-9]{64}$/u.test(hash) ? hash : undefined;
}

function sameId(left, right) {
  return Boolean(left) && Boolean(right) && String(left).toLowerCase() === String(right).toLowerCase();
}

function unique(values) {
  return [...new Set(values)];
}

function text(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const raw = String(value ?? "").trim();
  return raw || undefined;
}

function validIso(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createPlatformRuntime } from "../../services/bootstrap.js";
import {
  AuthenticationError,
  AuthorizationError,
  normalizeError,
  ValidationError
} from "../../core/errors.js";
import { buildSiweMessage, verifySiweMessage } from "../../auth/siwe.js";
import { signToken } from "../../auth/jwt.js";
import { extractClientKey } from "../../auth/rate-limit.js";
import { hasRole } from "../../auth/config.js";
import { resolveRequestId } from "../../core/logger.js";
import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import { buildBadgeFromSession } from "../../core/badge-metadata.js";
import { buildAgentProfile } from "../../core/agent-profile.js";
import { buildDiscoveryManifest } from "../../core/discovery-manifest.js";
import { hashCanonicalContent } from "../../core/canonical-content.js";
import { buildDisputeResolution, ARBITRATOR_SLA_SECONDS } from "../../core/dispute-resolution.js";
import { transitionSession } from "../../core/session-state-machine.js";
import { TIER_REQUIREMENTS } from "../../core/job-catalog-service.js";
import {
  getPublicBuiltinJobSchemaByName,
  listBuiltinJobSchemas,
  schemaRefToJobSchemaPath
} from "../../core/job-schema-registry.js";
import { ingestGithubIssues } from "../../jobs/ingest-github-issues.js";
import { ingestOpenDataDatasets, parseDatasets as parseOpenDataDatasets } from "../../jobs/ingest-open-data-datasets.js";
import { ingestOpenApiSpecs, parseOpenApiSpecs } from "../../jobs/ingest-openapi-specs.js";
import {
  ingestOsvAdvisories,
  parseManifests as parseOsvManifests,
  parsePackages as parseOsvPackages
} from "../../jobs/ingest-osv-advisories.js";
import { ingestStandardsSpecs, parseSpecs as parseStandardsSpecs } from "../../jobs/ingest-standards-specs.js";
import { ingestWikipediaMaintenance, parseCategories } from "../../jobs/ingest-wikipedia-maintenance.js";

const {
  platformService: service,
  verifierService,
  stateStore,
  gateway,
  pimlicoClient,
  eventBus,
  authConfig,
  authMiddleware,
  authCapabilities,
  rateLimiter,
  rateLimitConfig,
  httpConfig,
  strategies,
  trustProxy,
  logger,
  metrics,
  observability
} = await createPlatformRuntime();

// Label the state-store gauge once at boot for Prometheus discovery.
metrics.gauge("state_store_backend", "1 when state store backend matches the label.", ["backend"]).set(
  { backend: stateStore.constructor.name },
  1
);

const METRICS_BEARER_TOKEN = process.env.METRICS_BEARER_TOKEN?.trim() || undefined;
const port = Number(process.env.PORT ?? 8787);

const SIWE_STATEMENT = "Sign in to the Agent Platform.";

function respond(response, statusCode, payload, extraHeaders = {}) {
  const headers = {
    "content-type": "application/json",
    ...(response._corsHeaders ?? {}),
    ...extraHeaders
  };
  if (response._requestId && !headers["x-request-id"]) {
    headers["x-request-id"] = response._requestId;
  }
  response.writeHead(statusCode, headers);
  response.end(JSON.stringify(payload, null, 2));
}

function respondSse(response) {
  const headers = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    ...(response._corsHeaders ?? {})
  };
  if (response._requestId) {
    headers["x-request-id"] = response._requestId;
  }
  response.writeHead(200, headers);
}

async function readJsonBody(request, { maxBytes = httpConfig.maxBodyBytes } = {}) {
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > maxBytes) {
      throw new ValidationError(`Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  if (!body.trim()) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new ValidationError("Invalid JSON body.");
  }
}

function writeSseEvent(response, { id, topic, data }) {
  if (id) {
    response.write(`id: ${id}\n`);
  }
  if (topic) {
    response.write(`event: ${topic}\n`);
  }
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function parseTopics(url) {
  return url.searchParams
    .get("topics")
    ?.split(",")
    .map((topic) => topic.trim())
    .filter(Boolean) ?? [];
}

function generateNonce() {
  return randomBytes(16).toString("hex");
}

function walletsMatch(a, b) {
  if (!a || !b) {
    return false;
  }
  return a.toLowerCase() === b.toLowerCase();
}

async function ensureSessionOwnership(sessionId, wallet) {
  const session = await service.resumeSession(sessionId);
  if (!walletsMatch(session.wallet, wallet)) {
    throw new AuthorizationError(
      `Session ${sessionId} does not belong to authenticated wallet.`,
      "session_not_owned"
    );
  }
  return session;
}

function ensureXcmRequestOwnership(record, auth) {
  if (hasRole(auth.claims, "admin")) {
    return;
  }
  if (!walletsMatch(record.account, auth.wallet)) {
    throw new AuthorizationError(
      `XCM request ${record.requestId} does not belong to authenticated wallet.`,
      "xcm_request_not_owned"
    );
  }
}

function clientIp(request) {
  return extractClientKey(request, { trustProxy });
}

function safeChecksum(raw) {
  try {
    return getAddress(raw);
  } catch {
    return raw;
  }
}

function parseLimit(url, fallback = 50, max = 250) {
  const raw = Number(url.searchParams.get("limit") ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(raw), max);
}

function parsePositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const raw = Number(value ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(raw), max);
}

function profileTierToOperatorTier(reputation = {}) {
  const skill = Number(reputation.skill ?? 0);
  if (skill >= 300) return "master";
  if (reputation.tier === "elite" || skill >= 200) return "expert";
  if (reputation.tier === "pro" || skill >= 100) return "journeyman";
  return "apprentice";
}

function handleForWallet(wallet) {
  const normalized = String(wallet ?? "").toLowerCase();
  return `agent-${normalized.slice(2, 6)}-${normalized.slice(-4)}`;
}

function buildAgentDirectoryRow(profile) {
  const reputation = profile.reputation ?? {};
  const approvedCount = Number(profile.stats?.approvedCount ?? 0);
  const rejectedCount = Number(profile.stats?.rejectedCount ?? 0);
  const totalJobs = approvedCount + rejectedCount;
  return {
    wallet: profile.wallet,
    handle: handleForWallet(profile.wallet),
    tier: profileTierToOperatorTier(reputation),
    reputationScore:
      Number(reputation.skill ?? 0) +
      Number(reputation.reliability ?? 0) +
      Number(reputation.economic ?? 0),
    successRate: profile.stats?.completionRate ?? null,
    totalJobs,
    activeStake: 0,
    badges: profile.badges ?? [],
    slashEvents: []
  };
}

async function buildAgentDirectory(limit = 50) {
  const sessions = await service.listRecentSessions(limit);
  const wallets = [...new Set(sessions.map((session) => session.wallet).filter(Boolean))];
  const rows = await Promise.all(wallets.map(async (wallet) => {
    const checksummed = safeChecksum(wallet);
    const [reputation, history] = await Promise.all([
      service.getReputation(checksummed),
      service.collectSessionHistory(checksummed, { logger })
    ]);
    const profile = buildAgentProfile({
      wallet: wallet.toLowerCase(),
      reputation,
      sessions: history,
      getJobDefinition: (jobId) => {
        try {
          return service.getJobDefinition(jobId);
        } catch {
          return undefined;
        }
      },
      publicBaseUrl: process.env.PUBLIC_BASE_URL
    });
    return buildAgentDirectoryRow(profile);
  }));
  return rows.sort((left, right) => {
    if (right.reputationScore !== left.reputationScore) {
      return right.reputationScore - left.reputationScore;
    }
    return String(left.wallet).localeCompare(String(right.wallet));
  });
}

function buildBadgeReceipt(badge) {
  const averray = badge.averray ?? {};
  return {
    sessionId: averray.sessionId,
    jobId: averray.jobId,
    worker: averray.worker,
    kind: "badge",
    issuedAt: averray.completedAt,
    signers: [
      { wallet: averray.poster, status: "posted" },
      { wallet: averray.verifier, status: "signed" }
    ],
    evidenceHash: averray.evidenceHash,
    blockRef: averray.chainJobId,
    badge
  };
}

async function listBadgeReceipts(limit = 100) {
  const sessions = await service.listRecentSessions(limit);
  const receipts = [];
  for (const session of sessions) {
    let badge;
    try {
      badge = buildBadgeFromSession({
        session,
        job: service.getJobDefinition(session.jobId),
        verification: session.verification,
        context: {
          publicBaseUrl: process.env.PUBLIC_BASE_URL,
          posterAddress: process.env.DEFAULT_POSTER_ADDRESS,
          verifierAddress: process.env.DEFAULT_VERIFIER_ADDRESS
        }
      });
    } catch {
      continue;
    }
    receipts.push(buildBadgeReceipt(badge));
  }
  return receipts;
}

function disputeIdForSession(sessionId) {
  return `dispute-${keccak256(toUtf8Bytes(String(sessionId))).slice(2, 14)}`;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null)
  );
}

const OPERATOR_SIGNERS = {
  fd2e: {
    role: "primary operator",
    addr: process.env.DEFAULT_POSTER_ADDRESS ?? "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
    initials: "FD",
    hue: 148
  },
  "9a13": {
    role: "co-signer",
    addr: process.env.DEFAULT_VERIFIER_ADDRESS ?? "0x9A13C20000000000000000000000000000000CB2",
    initials: "9A",
    hue: 214
  },
  "3e42": {
    role: "verifier",
    addr: process.env.DEFAULT_VERIFIER_ADDRESS ?? "0x3E420000000000000000000000000000000008D1",
    initials: "V2",
    hue: 196
  }
};

const POLICY_PROPOSALS = new Map();

function signerApproval(key, state = "signed", at = "2026-04-24 14:08 UTC") {
  const signer = OPERATOR_SIGNERS[key] ?? OPERATOR_SIGNERS.fd2e;
  return {
    key,
    ...signer,
    state,
    ...(state === "signed" ? { at, sig: `0x${key}...signed` } : {})
  };
}

function makePolicy({
  id,
  tag,
  scope,
  scopeLabel,
  severity,
  state,
  revision,
  handler,
  gates,
  rooms,
  activeSince,
  lastChange,
  rule,
  attachedJobs = [],
  signerKeys = ["fd2e", "9a13", "3e42"],
  signersReq = 2
}) {
  return {
    id,
    tag,
    scope,
    scopeLabel,
    severity,
    signersReq,
    signersTotal: signerKeys.length,
    signerKeys,
    activeSince,
    lastChange,
    state,
    revision,
    rooms,
    handler,
    gates,
    attachedJobs,
    rule,
    approvals: signerKeys.map((key, index) => signerApproval(key, index < signersReq ? "signed" : "pending")),
    history: [
      {
        rev: revision,
        author: lastChange.author,
        at: String(lastChange.at ?? "").slice(0, 10),
        summary: lastChange.text,
        active: true
      }
    ]
  };
}

const BUILTIN_POLICIES = [
  makePolicy({
    id: "p-claim-deps-sec-only",
    tag: "claim/deps-sec-only@v4",
    scope: "claim",
    scopeLabel: "Claim",
    severity: "gating",
    state: "Active",
    revision: 4,
    activeSince: "2026-03-11",
    handler: "verifier/deps_sec_only.ts",
    gates: "Auto-claim on dependency bumps where only security advisories changed.",
    rooms: ["runs/coding/*", "runs/deps-bump/*"],
    attachedJobs: [{ id: "starter-coding-001", title: "Starter coding verification", at: "live" }],
    lastChange: {
      text: "Raised max-cvss ceiling to 7.5 for staged dependency work.",
      author: "fd2e",
      at: "2026-04-24 14:08 UTC"
    },
    rule: {
      v4: JSON.stringify({
        kind: "claim.auto",
        scope: "deps-bump",
        require: { advisory_type: "security", semver_delta: ["patch", "minor"], max_cvss: 7.5 },
        deny: { lockfile_drift: true, transitive_majors: true },
        receipt: { co_sign: ["verifier_handler"], attach_cvss_trail: true }
      }, null, 2)
    }
  }),
  makePolicy({
    id: "p-settle-receipt-before-payout",
    tag: "settle/receipt-before-payout@v1",
    scope: "settle",
    scopeLabel: "Settle",
    severity: "hard-stop",
    state: "Active",
    revision: 1,
    activeSince: "2026-04-17",
    handler: "settlement/receipt_gate.ts",
    gates: "Release stake and reward only after verifier receipt exists.",
    rooms: ["sessions/*", "treasury/settlement/*"],
    lastChange: {
      text: "Initial settlement gate for operator launch.",
      author: "9a13",
      at: "2026-04-24 14:08 UTC"
    },
    rule: {
      v1: JSON.stringify({
        kind: "settle.gate",
        require: { receipt_signed: true, verifier_result: "approved" },
        deny: { open_dispute: true }
      }, null, 2)
    }
  }),
  makePolicy({
    id: "p-dispute-human-review",
    tag: "dispute/human-review-window@v1",
    scope: "co-sign",
    scopeLabel: "Co-sign",
    severity: "gating",
    state: "Active",
    revision: 1,
    activeSince: "2026-04-17",
    handler: "disputes/human_review.ts",
    gates: "Disputed sessions hold stake until a verifier verdict is recorded.",
    rooms: ["disputes/*"],
    lastChange: {
      text: "Set 72 hour review window before stake release.",
      author: "3e42",
      at: "2026-04-24 14:08 UTC"
    },
    rule: {
      v1: JSON.stringify({
        kind: "dispute.review",
        window_hours: 72,
        verdicts: ["upheld", "dismissed", "split"],
        release_requires: ["verdict", "operator"]
      }, null, 2)
    }
  })
];

function listPolicies() {
  return [...BUILTIN_POLICIES, ...POLICY_PROPOSALS.values()];
}

function findPolicy(tag) {
  return listPolicies().find((policy) => policy.tag === tag || policy.id === tag);
}

function buildPolicyProposal(payload, auth) {
  const tag = String(payload?.tag ?? payload?.id ?? "").trim();
  if (!tag) {
    throw new ValidationError("policy tag is required.");
  }
  const title = String(payload?.title ?? tag).trim();
  const body = typeof payload?.currentBody === "string"
    ? payload.currentBody
    : JSON.stringify(payload?.rule ?? { title }, null, 2);
  const now = new Date().toISOString();
  const id = `p-proposed-${keccak256(toUtf8Bytes(tag)).slice(2, 10)}`;
  return makePolicy({
    id,
    tag,
    scope: payload?.scope ?? "claim",
    scopeLabel: payload?.scopeLabel ?? "Claim",
    severity: payload?.severity ?? "gating",
    state: "Pending",
    revision: Number(payload?.revision ?? 1),
    activeSince: null,
    handler: payload?.handler ?? "operator/proposed_policy.ts",
    gates: payload?.gates ?? title,
    rooms: Array.isArray(payload?.rooms) ? payload.rooms : ["policies/proposed/*"],
    signerKeys: ["fd2e", "9a13", "3e42"],
    signersReq: 2,
    lastChange: {
      text: `Proposed by ${auth.wallet}`,
      author: "fd2e",
      at: now.replace("T", " ").slice(0, 19) + " UTC"
    },
    rule: {
      v1: body
    }
  });
}

function compactWallet(wallet) {
  const value = String(wallet ?? "");
  if (value.length <= 12) return value || "system";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function auditTime(value) {
  const date = new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) return "00:00:00";
  return date.toISOString().slice(11, 19);
}

function auditDay(value) {
  const date = new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) return "today";
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const day = date.toISOString().slice(0, 10);
  if (day === today) return "today";
  if (day === yesterday) return "yesterday";
  return day;
}

function auditActor(handle, address, tone = "muted") {
  const label = String(handle ?? "system");
  return {
    handle: label,
    address: address ?? "averray.platform",
    initials: label.slice(0, 2).toUpperCase(),
    tone
  };
}

function auditEvent({ id, at, source, category, action, actor, summary, target, hash, tone, link }) {
  return compactObject({
    id,
    at: auditTime(at),
    day: auditDay(at),
    source,
    category,
    action,
    actor,
    summary,
    target,
    hash,
    tone,
    link
  });
}

async function listAuditEvents(limit = 100) {
  const sessions = await service.listRecentSessions(limit);
  const events = [];
  for (const session of sessions) {
    const actor = auditActor(`agent-${compactWallet(session.wallet)}`, compactWallet(session.wallet), "sage");
    events.push(auditEvent({
      id: `audit-${session.sessionId}-claimed`,
      at: session.createdAt ?? session.updatedAt,
      source: "system",
      category: "runs",
      action: "session.claimed",
      actor,
      summary: `Claimed ${session.jobId}.`,
      target: session.sessionId,
      hash: session.chainJobId,
      link: { label: "Open run ->", href: "/runs" }
    }));
    if (session.submittedAt || session.submission) {
      events.push(auditEvent({
        id: `audit-${session.sessionId}-submitted`,
        at: session.submittedAt ?? session.updatedAt,
        source: "system",
        category: "runs",
        action: "session.submitted",
        actor,
        summary: `Submitted evidence for ${session.jobId}.`,
        target: session.sessionId,
        link: { label: "Open session ->", href: "/sessions" }
      }));
    }
    if (session.verification || session.verificationSummary) {
      events.push(auditEvent({
        id: `audit-${session.sessionId}-verified`,
        at: session.verifiedAt ?? session.updatedAt,
        source: "operator",
        category: "verifier",
        action: "verification.resolved",
        actor: auditActor("verifier", compactWallet(process.env.DEFAULT_VERIFIER_ADDRESS), "blue"),
        summary: `Verifier resolved ${session.jobId} as ${session.status}.`,
        target: session.sessionId,
        tone: session.status === "disputed" ? "warn" : "accent",
        link: { label: "Open receipt ->", href: "/receipts" }
      }));
    }
  }
  for (const policy of listPolicies()) {
    events.push(auditEvent({
      id: `audit-policy-${policy.id}`,
      at: policy.lastChange?.at,
      source: "operator",
      category: "policy",
      action: policy.state === "Pending" ? "policy.proposed" : "policy.active",
      actor: auditActor(OPERATOR_SIGNERS[policy.lastChange?.author]?.role ?? "operator", OPERATOR_SIGNERS[policy.lastChange?.author]?.addr, "ink"),
      summary: `${policy.tag}: ${policy.lastChange?.text}`,
      target: policy.tag,
      tone: policy.state === "Pending" ? "warn" : "neutral",
      link: { label: "Open policy ->", href: "/policies" }
    }));
  }
  return events
    .sort((left, right) => String(right.day + right.at).localeCompare(String(left.day + left.at)))
    .slice(0, limit);
}

async function listAlerts(limit = 20) {
  const [sessions, disputes] = await Promise.all([
    service.listRecentSessions(limit),
    listDisputes(limit)
  ]);
  const alerts = [];
  for (const dispute of disputes) {
    alerts.push({
      id: `alert-${dispute.id}`,
      tone: "warn",
      title: "Dispute awaiting verdict",
      ref: dispute.sessionId,
      body: `Stake of ${dispute.stakedAmount} DOT remains locked until a verifier verdict is recorded.`,
      ctaLabel: "Open disputes ->",
      ctaHref: "/disputes"
    });
  }
  const pendingPolicies = listPolicies().filter((policy) => policy.state === "Pending");
  for (const policy of pendingPolicies) {
    alerts.push({
      id: `alert-${policy.id}`,
      tone: "warn",
      title: "Policy awaiting second signer",
      ref: policy.tag,
      body: `${policy.signersReq} signatures required before this rule can gate live work.`,
      ctaLabel: "Open policies ->",
      ctaHref: "/policies"
    });
  }
  const submitted = sessions.filter((session) => ["submitted", "disputed"].includes(session.status));
  for (const session of submitted.slice(0, Math.max(0, limit - alerts.length))) {
    alerts.push({
      id: `alert-session-${session.sessionId}`,
      tone: session.status === "disputed" ? "warn" : "accent",
      title: session.status === "disputed" ? "Run needs human review" : "Submitted run ready for verification",
      ref: session.sessionId,
      body: `${session.jobId} is currently ${session.status}.`,
      ctaLabel: "Open runs ->",
      ctaHref: "/runs"
    });
  }
  return alerts.slice(0, limit);
}

function addSecondsIso(value, seconds) {
  const parsed = Date.parse(value ?? "");
  const base = Number.isFinite(parsed) ? parsed : Date.now();
  return new Date(base + seconds * 1000).toISOString();
}

function publicContentUri(hash) {
  const normalized = typeof hash === "string" && /^0x[a-fA-F0-9]{64}$/u.test(hash)
    ? hash
    : undefined;
  if (!normalized) {
    return "";
  }
  const base = process.env.PUBLIC_BASE_URL?.trim()?.replace(/\/+$/u, "");
  return base ? `${base}/content/${normalized}` : `urn:averray:content:${normalized}`;
}

function buildDisputeReasoningReceipt({ id, dispute, payload, auth, verdict, decidedAt }) {
  const rationale = typeof payload?.rationale === "string" ? payload.rationale.trim() : "";
  const explicitHash = typeof payload?.reasoningHash === "string" && /^0x[a-fA-F0-9]{64}$/u.test(payload.reasoningHash)
    ? payload.reasoningHash
    : undefined;
  const reasoningHash = explicitHash ?? hashCanonicalContent({
    disputeId: id,
    sessionId: dispute.sessionId,
    verdict,
    rationale,
    decidedBy: auth.wallet,
    decidedAt
  });
  const metadataURI = typeof payload?.metadataURI === "string" && payload.metadataURI.trim()
    ? payload.metadataURI.trim()
    : publicContentUri(reasoningHash);
  return { rationale, reasoningHash, metadataURI };
}

async function resolveRemainingPayout(session) {
  if (gateway?.isEnabled?.() && typeof gateway.getJob === "function") {
    const live = await gateway.getJob(session.chainJobId ?? session.jobId);
    return Math.max(Number(live.reward ?? 0) - Number(live.released ?? 0), 0);
  }
  try {
    const job = service.getJobDefinition(session.jobId);
    return Math.max(Number(job.rewardAmount ?? 0), 0);
  } catch {
    return 0;
  }
}

async function buildDisputeFromSession(session) {
  const id = disputeIdForSession(session.sessionId);
  const [verdictReceipt, releaseReceipt] = await Promise.all([
    stateStore.getMutationReceipt?.("dispute_verdict", id),
    stateStore.getMutationReceipt?.("dispute_release", id)
  ]);
  const openedAt = session.disputedAt ?? session.updatedAt ?? new Date().toISOString();
  const windowEndsAt = addSecondsIso(openedAt, ARBITRATOR_SLA_SECONDS);
  const timeline = (session.statusHistory ?? []).map((entry, index) => ({
    id: `${id}:session:${index}`,
    at: entry.at,
    actor: "system",
    action: entry.reason ?? `session_${entry.to}`,
    data: entry
  }));
  if (verdictReceipt) {
    timeline.push({
      id: `${id}:verdict`,
      at: verdictReceipt.decidedAt,
      actor: verdictReceipt.decidedBy,
      action: "verdict_submitted",
      data: verdictReceipt
    });
  }
  if (releaseReceipt) {
    timeline.push({
      id: `${id}:release`,
      at: releaseReceipt.releasedAt,
      actor: releaseReceipt.releasedBy,
      action: "stake_release_recorded",
      data: releaseReceipt
    });
  }

  let job;
  try {
    job = service.getJobDefinition(session.jobId);
  } catch {
    job = undefined;
  }

  return {
    id,
    status: releaseReceipt || verdictReceipt ? "resolved" : "open",
    sessionId: session.sessionId,
    chainJobId: session.chainJobId,
    claimant: session.wallet,
    respondent: process.env.DEFAULT_VERIFIER_ADDRESS ?? "0x0000000000000000000000000000000000000000",
    openedAt,
    windowEndsAt,
    slaSeconds: ARBITRATOR_SLA_SECONDS,
    evidence: {
      before: compactObject({
        jobId: session.jobId,
        jobTitle: job?.title,
        requirements: job?.verifierTerms,
        claimStake: session.claimStake
      }),
      after: compactObject({
        submission: session.submission,
        verification: session.verification ?? session.verificationSummary
      })
    },
    verdict: verdictReceipt?.verdict ?? null,
    reasonCode: verdictReceipt?.reasonCode,
    reasoningHash: verdictReceipt?.reasoningHash,
    metadataURI: verdictReceipt?.metadataURI,
    txHash: verdictReceipt?.txHash,
    chainStatus: verdictReceipt?.chainStatus,
    workerPayout: verdictReceipt?.workerPayout,
    remainingPayout: verdictReceipt?.remainingPayout,
    stakedAmount: Number(session.claimStake ?? 0),
    release: releaseReceipt ?? null,
    timeline: timeline.sort((left, right) => String(left.at ?? "").localeCompare(String(right.at ?? "")))
  };
}

async function listDisputes(limit = 100) {
  const sessions = await service.listRecentSessions(limit);
  const candidates = await Promise.all(
    sessions.map(async (session) => {
      if (session.status === "disputed") {
        return session;
      }
      const id = disputeIdForSession(session.sessionId);
      const [verdictReceipt, releaseReceipt] = await Promise.all([
        stateStore.getMutationReceipt?.("dispute_verdict", id),
        stateStore.getMutationReceipt?.("dispute_release", id)
      ]);
      return verdictReceipt || releaseReceipt ? session : undefined;
    })
  );
  return Promise.all(candidates.filter(Boolean).map((session) => buildDisputeFromSession(session)));
}

async function findDispute(id, limit = 250) {
  const disputes = await listDisputes(limit);
  return disputes.find((dispute) => dispute.id === id);
}

function resolveCorsHeaders(request) {
  const origin = request.headers?.origin;
  if (!origin || typeof origin !== "string") {
    return {};
  }
  if (httpConfig.allowAllOrigins) {
    return buildCorsHeaders("*");
  }
  if (httpConfig.allowedOrigins.has(origin)) {
    return buildCorsHeaders(origin);
  }
  return {};
}

function buildCorsHeaders(allowOrigin) {
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": httpConfig.allowedMethods,
    "access-control-allow-headers": httpConfig.allowedHeaders,
    "access-control-expose-headers": httpConfig.exposedHeaders,
    "access-control-max-age": String(httpConfig.maxAgeSeconds),
    vary: "origin"
  };
}

async function enforceLimit(bucket, key, limits) {
  if (!rateLimiter) {
    return;
  }
  try {
    await rateLimiter(bucket, key, limits);
  } catch (error) {
    if (error?.code === "rate_limited") {
      metrics.counter("rate_limit_rejections_total").inc({ bucket });
    }
    throw error;
  }
}

/**
 * Normalise a URL path into a low-cardinality metric label. Without this
 * every unique `sessionId` / `jobId` becomes its own Prometheus series,
 * which defeats the purpose. Known static paths pass through; anything
 * else collapses to a bucket label so scrape payloads stay small.
 */
function metricPathLabel(pathname) {
  const known = new Set([
    "/",
    "/health",
    "/metrics",
    "/agent-tools.json",
    "/onboarding",
    "/jobs",
    "/jobs/definition",
    "/jobs/recommendations",
    "/jobs/preflight",
    "/jobs/claim",
    "/jobs/submit",
    "/jobs/tiers",
    "/session/state-machine",
    "/strategies",
    "/admin/jobs",
    "/admin/jobs/ingest/github",
    "/admin/jobs/ingest/openapi",
    "/admin/jobs/ingest/open-data",
    "/admin/jobs/ingest/osv",
    "/admin/jobs/ingest/standards",
    "/admin/jobs/ingest/wikipedia",
    "/admin/jobs/pause",
    "/admin/jobs/resume",
    "/admin/xcm/observe",
    "/admin/xcm/finalize",
    "/account",
    "/account/fund",
    "/auth/session",
    "/payments/send",
    "/reputation",
    "/session",
    "/session/timeline",
    "/sessions",
    "/xcm/request",
    "/jobs/sub",
    "/events",
    "/auth/nonce",
    "/auth/verify",
    "/agents",
    "/badges",
    "/alerts",
    "/audit",
    "/policies",
    "/disputes",
    "/verifier/handlers",
    "/verifier/result",
    "/verifier/replay",
    "/verifier/run",
    "/gas/health",
    "/gas/capabilities",
    "/gas/quote",
    "/gas/sponsor"
  ]);
  if (known.has(pathname)) return pathname;
  // Collapse sessionId/wallet-scoped routes to a single label so Prometheus
  // doesn't create one series per session or wallet.
  if (/^\/disputes\/[^/]+\/verdict$/u.test(pathname)) return "/disputes/:id/verdict";
  if (/^\/disputes\/[^/]+\/release$/u.test(pathname)) return "/disputes/:id/release";
  if (pathname.startsWith("/disputes/")) return "/disputes/:id";
  if (pathname.startsWith("/policies/")) return "/policies/:tag";
  if (pathname.startsWith("/badges/")) return "/badges/:sessionId";
  if (pathname.startsWith("/agents/")) return "/agents/:wallet";
  return "other";
}

function sumNumericValues(record = {}) {
  return Object.values(record).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function ratioToBps(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  return Math.round((numerator / denominator) * 10_000);
}

function resolveAssetSymbol(assetAddress) {
  if (!assetAddress) return "DOT";
  const supportedAssets = gateway?.config?.supportedAssets ?? [];
  const match = supportedAssets.find((asset) => asset.address?.toLowerCase() === assetAddress.toLowerCase());
  return match?.symbol ?? "DOT";
}

function resolveStrategyAssetSymbol(strategy) {
  return strategy?.assetConfig?.symbol ?? resolveAssetSymbol(strategy?.asset);
}

function findStrategyConfig(strategyId) {
  if (!strategyId) return undefined;
  const normalized = gateway?.normalizeStrategyId?.(strategyId) ?? strategyId;
  return strategies.find((entry) => entry.strategyId === strategyId || entry.strategyId === normalized);
}

function normalizeAsyncWeight(input = undefined) {
  const refTime = Number(input?.refTime ?? input?.ref_time ?? 0);
  const proofSize = Number(input?.proofSize ?? input?.proof_size ?? 0);
  return {
    refTime: Number.isFinite(refTime) && refTime > 0 ? Math.trunc(refTime) : 0,
    proofSize: Number.isFinite(proofSize) && proofSize > 0 ? Math.trunc(proofSize) : 0
  };
}

function deriveAsyncNonce(seed) {
  const hash = keccak256(toUtf8Bytes(seed));
  return Number.parseInt(hash.slice(2, 14), 16);
}

function parseAsyncTreasuryOptions(payload = {}, url, { defaultRecipient = undefined } = {}) {
  const queryWeight = {
    refTime: url.searchParams.get("maxWeightRefTime"),
    proofSize: url.searchParams.get("maxWeightProofSize")
  };
  const maxWeight = normalizeAsyncWeight(
    payload?.maxWeight && typeof payload.maxWeight === "object"
      ? payload.maxWeight
      : queryWeight
  );
  const idempotencyKey = typeof payload?.idempotencyKey === "string" && payload.idempotencyKey.trim()
    ? payload.idempotencyKey.trim()
    : undefined;
  const nonceRaw = payload?.nonce ?? url.searchParams.get("nonce");
  const nonce = Number.isFinite(Number(nonceRaw)) && Number(nonceRaw) >= 0
    ? Math.trunc(Number(nonceRaw))
    : undefined;
  const recipient = typeof payload?.recipient === "string" && payload.recipient.trim()
    ? payload.recipient.trim()
    : (url.searchParams.get("recipient")?.trim() || defaultRecipient);
  const requestedSharesRaw = payload?.requestedShares ?? payload?.shares ?? url.searchParams.get("shares");
  const requestedShares = Number.isFinite(Number(requestedSharesRaw)) && Number(requestedSharesRaw) > 0
    ? Number(requestedSharesRaw)
    : undefined;
  return {
    destination: payload?.destination ?? url.searchParams.get("destination") ?? "0x",
    message: payload?.message ?? url.searchParams.get("message") ?? "0x",
    maxWeight,
    idempotencyKey,
    nonce,
    recipient,
    requestedShares
  };
}

function buildLaneAttention({ shares, isMock, debtTotal, borrowCapacity, deploymentShareBps }) {
  if (!(shares > 0)) {
    return undefined;
  }
  if (isMock) {
    return {
      code: "simulated_yield",
      tone: "tier-warn",
      message: "This lane is using the mock vDOT adapter, so yield is simulated rather than market-backed."
    };
  }
  if (debtTotal > 0 && !(borrowCapacity > 0)) {
    return {
      code: "credit_constrained",
      tone: "tier-warn",
      message: "This wallet has debt outstanding and no additional live borrow headroom."
    };
  }
  if (deploymentShareBps >= 7000) {
    return {
      code: "lane_concentration",
      tone: "status-pending",
      message: "Most deployed capital is concentrated in this lane right now."
    };
  }
  return undefined;
}

function formatAdapterYieldLabel({ telemetry, isMock, shares }) {
  if (!telemetry?.reported) {
    return isMock
      ? "Mock adapter is registered, but no simulated yield data is reported yet."
      : "Adapter is registered, but it is not reporting a live yield/performance read yet.";
  }
  const sharePrice = Number(telemetry.sharePrice);
  const performanceBps = Number(telemetry.performanceBps);
  const sharePriceLabel = Number.isFinite(sharePrice) ? `${sharePrice.toFixed(4)}x share price` : "share price unavailable";
  const driftLabel = Number.isFinite(performanceBps)
    ? `${performanceBps >= 0 ? "+" : ""}${performanceBps} bps`
    : "drift unavailable";
  if (shares > 0) {
    return `${sharePriceLabel} · ${driftLabel} on the adapter for currently routed wallet capital.`;
  }
  return `${sharePriceLabel} · ${driftLabel} on deployed adapter capital.`;
}

function normalizeTimelineEntry(entry = {}) {
  const amount = Number(entry.amount ?? 0);
  const yieldDelta = Number(entry.yieldDelta ?? entry.realizedYieldDelta ?? 0);
  return {
    id: entry.id,
    type: entry.type ?? "treasury_event",
    strategyId: entry.strategyId,
    asset: entry.asset ?? "DOT",
    amount,
    yieldDelta,
    at: entry.at
  };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const requestId = resolveRequestId(request);
  const requestLogger = logger.child({ requestId });
  const startedAt = process.hrtime.bigint();
  // Stash CORS headers + request id on the response so `respond`/`respondSse`
  // can echo them back without each route needing to thread them through.
  response._corsHeaders = resolveCorsHeaders(request);
  response._requestId = requestId;
  response.on("finish", () => {
    const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    const pathLabel = metricPathLabel(pathname);
    metrics.counter("http_requests_total").inc({
      method: request.method ?? "UNKNOWN",
      path: pathLabel,
      status: String(response.statusCode ?? 0)
    });
    metrics.histogram("http_request_duration_ms").observe(
      { method: request.method ?? "UNKNOWN", path: pathLabel },
      durationMs
    );
    requestLogger.info(
      {
        method: request.method,
        path: pathname,
        status: response.statusCode,
        durationMs,
        ip: extractClientKey(request, { trustProxy })
      },
      "http.response"
    );
  });

  if (request.method === "OPTIONS") {
    // CORS preflight: only acknowledge origins on the allowlist. Unlisted
    // origins get a 204 with no CORS headers, so the browser rejects them.
    response.writeHead(204, response._corsHeaders);
    response.end();
    return;
  }

  try {
    // ---------- public routes ----------

    if (request.method === "GET" && pathname === "/") {
      return respond(response, 200, {
        name: "agent-platform",
        status: "ok",
        authMode: authConfig.mode,
        endpoints: [
          "/health",
          "/metrics",
          "/agent-tools.json",
          "/onboarding",
          "/auth/nonce",
          "/auth/verify",
          "/auth/logout",
          "/auth/session",
          "/events",
          "/account",
          "/account/fund",
          "/xcm/request",
          "/payments/send",
          "/reputation",
          "/session",
          "/session/timeline",
          "/sessions",
          "/jobs",
          "/jobs/sub",
          "/jobs/tiers",
          "/agents",
          "/agents/:wallet",
          "/badges",
          "/badges/:sessionId",
          "/alerts",
          "/audit",
          "/policies",
          "/policies/:tag",
          "/disputes",
          "/disputes/:id",
          "/disputes/:id/verdict",
          "/disputes/:id/release",
          "/strategies",
          "/admin/jobs/pause",
          "/admin/jobs/resume",
          "/jobs/preflight",
          "/jobs/recommendations",
          "/gas/health",
          "/gas/capabilities",
          "/gas/quote",
          "/gas/sponsor",
          "/verifier/handlers",
          "/verifier/replay",
          "/admin/jobs",
          "/admin/jobs/ingest/github",
          "/admin/jobs/ingest/openapi",
          "/admin/jobs/ingest/open-data",
          "/admin/jobs/ingest/osv",
          "/admin/jobs/ingest/standards",
          "/admin/jobs/ingest/wikipedia",
          "/admin/jobs/fire",
          "/admin/jobs/pause",
          "/admin/jobs/resume",
          "/admin/xcm/observe",
          "/admin/xcm/finalize",
          "/admin/status"
        ]
      });
    }

    if (request.method === "GET" && pathname === "/health") {
      const [storeHealth, chainHealth, gasHealth] = await Promise.all([
        stateStore.healthCheck?.() ?? { ok: true, backend: stateStore.constructor.name },
        gateway?.healthCheck?.() ?? { ok: true, backend: "blockchain", enabled: false, mode: "disabled" },
        pimlicoClient?.healthCheck?.() ?? { ok: true, backend: "pimlico", enabled: false, mode: "disabled" }
      ]);
      const overallOk = Boolean(storeHealth.ok) && Boolean(chainHealth.ok) && Boolean(gasHealth.ok);
      return respond(response, overallOk ? 200 : 503, {
        status: overallOk ? "ok" : "degraded",
        auth: { mode: authConfig.mode, domain: authConfig.domain, chainId: authConfig.chainId },
        components: {
          stateStore: storeHealth,
          blockchain: chainHealth,
          gasSponsor: gasHealth
        }
      });
    }

    if (request.method === "GET" && pathname === "/metrics") {
      // Optionally gated. Leave METRICS_BEARER_TOKEN unset for the standard
      // Prometheus "scrape any network peer" convention; set it to a random
      // token when /metrics is reachable from the public internet.
      if (METRICS_BEARER_TOKEN) {
        const header = request.headers.authorization ?? "";
        if (header !== `Bearer ${METRICS_BEARER_TOKEN}`) {
          return respond(response, 401, { error: "unauthorized" });
        }
      }
      response.writeHead(200, {
        "content-type": "text/plain; version=0.0.4",
        ...(response._corsHeaders ?? {}),
        "x-request-id": response._requestId ?? ""
      });
      response.end(metrics.serialize());
      return;
    }

    if (request.method === "GET" && pathname === "/onboarding") {
      return respond(response, 200, service.getPlatformCapabilities());
    }

    if (request.method === "GET" && pathname === "/agent-tools.json") {
      // Discovery manifest. The canonical copy is served by the static
      // site at https://averray.com/.well-known/agent-tools.json — this
      // API mirror lets MCP clients that only know the api host still
      // find the capability listing. Bumps refer to
      // discovery/.well-known/agent-tools.json in the repo.
      return respond(
        response,
        200,
        buildDiscoveryManifest({
          baseUrl: process.env.PUBLIC_BASE_URL?.trim() || undefined
        }),
        { "cache-control": "public, max-age=300" }
      );
    }

    if (request.method === "GET" && pathname === "/jobs") {
      return respond(response, 200, service.listJobs());
    }

    if (request.method === "GET" && pathname === "/strategies") {
      // Public read: which yield/strategy adapters are registered for
      // this deployment. Populated from STRATEGIES_JSON env (copied from
      // the deployment manifest). Returns an empty list when no strategy
      // adapter is registered — that's the expected state on dev/Anvil.
      return respond(
        response,
        200,
        {
          strategies,
          docs: "https://github.com/depre-dev/agent/blob/main/docs/strategies/vdot.md"
        },
        { "cache-control": "public, max-age=300" }
      );
    }

    if (request.method === "GET" && pathname === "/jobs/tiers") {
      // Public tier-requirements ladder. No auth; no per-wallet data.
      // Agents use this endpoint for discovery — "what does each tier of
      // work cost in reputation?" — without needing to sign in first.
      // Personalised progress lives on /jobs/recommendations (per-job
      // tierGate) and on the authenticated /jobs/preflight.
      return respond(
        response,
        200,
        {
          tiers: Object.entries(TIER_REQUIREMENTS).map(([tier, requires]) => ({ tier, requires }))
        },
        { "cache-control": "public, max-age=300" }
      );
    }

    if (request.method === "GET" && pathname === "/session/state-machine") {
      return respond(
        response,
        200,
        service.getSessionStateMachine(),
        { "cache-control": "public, max-age=300" }
      );
    }

    if (request.method === "GET" && pathname === "/schemas/jobs") {
      const schemas = listBuiltinJobSchemas().map((entry) => ({
        ...entry,
        path: schemaRefToJobSchemaPath(entry.$id)
      }));
      return respond(
        response,
        200,
        {
          schemas,
          count: schemas.length,
          docs: "https://github.com/depre-dev/agent/tree/main/docs/schemas/jobs"
        },
        { "cache-control": "public, max-age=300" }
      );
    }

    if (request.method === "GET" && pathname.startsWith("/schemas/jobs/")) {
      const schema = getPublicBuiltinJobSchemaByName(decodeURIComponent(pathname.slice("/schemas/jobs/".length)));
      if (!schema) {
        return respond(response, 404, {
          status: "not_found",
          message: "Unknown built-in job schema."
        });
      }
      return respond(response, 200, schema, { "cache-control": "public, max-age=300" });
    }

    if (request.method === "GET" && pathname === "/jobs/definition") {
      return respond(response, 200, service.getJobDefinition(url.searchParams.get("jobId") ?? ""));
    }

    if (request.method === "GET" && pathname === "/gas/health") {
      return respond(response, 200, await pimlicoClient.healthCheck());
    }

    if (request.method === "GET" && pathname === "/gas/capabilities") {
      return respond(response, 200, pimlicoClient.getCapabilities());
    }

    if (request.method === "GET" && pathname === "/verifier/handlers") {
      return respond(response, 200, { handlers: verifierService.listHandlers() });
    }

    if (request.method === "GET" && pathname === "/verifier/result") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      return respond(response, 200, await verifierService.getResult(sessionId) ?? { status: "not_found" });
    }

    if (request.method === "POST" && pathname === "/verifier/replay") {
      const auth = await authMiddleware(request, url, { requireRole: "verifier" });
      await enforceLimit("verifier_run", auth.wallet, rateLimitConfig.verifierRun);
      const payload = await readJsonBody(request);
      const sessionId = typeof payload?.sessionId === "string" && payload.sessionId.trim()
        ? payload.sessionId.trim()
        : (url.searchParams.get("sessionId") ?? "");
      return respond(response, 200, await verifierService.replayVerification(sessionId));
    }

    // Public agent directory for the new operator app. It is derived from
    // the same recent session + reputation source as the per-wallet profile.
    if (request.method === "GET" && pathname === "/agents") {
      return respond(response, 200, await buildAgentDirectory(parseLimit(url, 50, 250)), {
        "cache-control": "public, max-age=30"
      });
    }

    // Public agent profile — the aggregate "LinkedIn for agents" resume.
    // Returns reputation + per-category levels + lifetime stats + ordered
    // badges. Public (no auth) so other agents/humans can verify. See
    // docs/schemas/agent-profile-v1.md for the full format.
    if (request.method === "GET" && pathname.startsWith("/agents/")) {
      const rawWallet = decodeURIComponent(pathname.slice("/agents/".length));
      if (!/^0x[a-fA-F0-9]{40}$/u.test(rawWallet)) {
        throw new ValidationError("wallet path segment must be a 0x-prefixed 20-byte hex address.");
      }
      // Sessions are keyed by the checksummed form (authMiddleware calls
      // getAddress before persisting). We accept lowercase or checksummed
      // in the URL, normalise for lookup, and return lowercase in the body
      // so consumers have a single canonical form to compare against.
      const checksummed = safeChecksum(rawWallet);
      // Lifetime aggregates need every session, not a truncated page.
      // collectSessionHistory walks the state store page-by-page up to a
      // safety cap (10_000 by default) — see
      // src/core/job-execution-service.js#collectSessionHistory.
      const [reputation, sessions] = await Promise.all([
        service.getReputation(checksummed),
        service.collectSessionHistory(checksummed, { logger: requestLogger })
      ]);
      const profile = buildAgentProfile({
        wallet: rawWallet.toLowerCase(),
        reputation,
        sessions,
        getJobDefinition: (jobId) => {
          try {
            return service.getJobDefinition(jobId);
          } catch {
            return undefined;
          }
        },
        publicBaseUrl: process.env.PUBLIC_BASE_URL
      });
      return respond(response, 200, profile, { "cache-control": "public, max-age=30" });
    }

    if (request.method === "GET" && pathname === "/badges") {
      return respond(response, 200, await listBadgeReceipts(parseLimit(url, 100, 500)), {
        "cache-control": "public, max-age=30"
      });
    }

    // Public badge metadata — the "LinkedIn for agents" read surface.
    // Anyone can fetch `/badges/<sessionId>` to inspect a completed job's
    // badge without auth. Returns 404 for missing or not-yet-approved
    // sessions; returns schema-compliant JSON otherwise. See
    // docs/schemas/agent-badge-v1.md for the full format.
    if (request.method === "GET" && pathname.startsWith("/badges/")) {
      const sessionId = decodeURIComponent(pathname.slice("/badges/".length));
      if (!sessionId) {
        throw new ValidationError("sessionId path segment is required.");
      }
      let session;
      try {
        session = await service.resumeSession(sessionId);
      } catch (error) {
        const normalized = normalizeError(error);
        if (normalized.code === "session_not_found") {
          return respond(response, 404, { status: "not_found", sessionId });
        }
        throw normalized;
      }
      const verification = await verifierService.getResult(sessionId);
      const job = service.getJobDefinition(session.jobId);
      try {
        const badge = buildBadgeFromSession({
          session,
          job,
          verification,
          context: {
            publicBaseUrl: process.env.PUBLIC_BASE_URL,
            posterAddress: process.env.DEFAULT_POSTER_ADDRESS,
            verifierAddress: process.env.DEFAULT_VERIFIER_ADDRESS
          }
        });
        // Keep badge JSON browser-cacheable for a minute — it's deterministic
        // once the session is resolved.
        return respond(response, 200, badge, { "cache-control": "public, max-age=60" });
      } catch (error) {
        const normalized = normalizeError(error);
        if (normalized.code === "badge_not_ready") {
          return respond(response, 404, { status: "not_ready", sessionId, reason: normalized.message });
        }
        throw normalized;
      }
    }

    if (request.method === "GET" && pathname === "/alerts") {
      await authMiddleware(request, url);
      return respond(response, 200, await listAlerts(parseLimit(url, 20, 100)));
    }

    if (request.method === "GET" && pathname === "/audit") {
      await authMiddleware(request, url);
      return respond(response, 200, await listAuditEvents(parseLimit(url, 100, 500)));
    }

    if (request.method === "GET" && pathname === "/policies") {
      await authMiddleware(request, url);
      return respond(response, 200, listPolicies());
    }

    if (request.method === "POST" && pathname === "/policies") {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      const payload = await readJsonBody(request);
      const proposal = buildPolicyProposal(payload, auth);
      POLICY_PROPOSALS.set(proposal.tag, proposal);
      await stateStore.upsertMutationReceipt?.("policy_proposal", proposal.tag, proposal);
      eventBus?.publish({
        id: `policy-proposal-${proposal.id}-${Date.now()}`,
        topic: "policy.proposed",
        wallet: auth.wallet,
        wallets: [auth.wallet],
        timestamp: new Date().toISOString(),
        data: { tag: proposal.tag, status: proposal.state }
      });
      return respond(response, 201, proposal);
    }

    if (request.method === "GET" && pathname.startsWith("/policies/")) {
      await authMiddleware(request, url);
      const tag = decodeURIComponent(pathname.slice("/policies/".length));
      if (!tag) {
        throw new ValidationError("policy tag path segment is required.");
      }
      const policy = findPolicy(tag);
      if (!policy) {
        return respond(response, 404, { status: "not_found", tag });
      }
      return respond(response, 200, policy);
    }

    if (request.method === "GET" && pathname === "/disputes") {
      await authMiddleware(request, url);
      return respond(response, 200, await listDisputes(parseLimit(url, 100, 500)));
    }

    if (request.method === "GET" && pathname.startsWith("/disputes/")) {
      await authMiddleware(request, url);
      const id = decodeURIComponent(pathname.slice("/disputes/".length));
      if (!id || id.includes("/")) {
        throw new ValidationError("dispute id path segment is required.");
      }
      const dispute = await findDispute(id);
      if (!dispute) {
        return respond(response, 404, { status: "not_found", id });
      }
      return respond(response, 200, dispute);
    }

    if (request.method === "POST" && /^\/disputes\/[^/]+\/verdict$/u.test(pathname)) {
      const auth = await authMiddleware(request, url);
      if (!hasRole(auth.claims, "admin") && !hasRole(auth.claims, "verifier")) {
        throw new AuthorizationError("Requires admin or verifier role.", "missing_role");
      }
      const id = decodeURIComponent(pathname.slice("/disputes/".length, -"/verdict".length));
      const dispute = await findDispute(id);
      if (!dispute) {
        return respond(response, 404, { status: "not_found", id });
      }
      if (dispute.verdict || dispute.reasonCode) {
        return respond(response, 200, dispute);
      }
      const payload = await readJsonBody(request);
      const session = await service.resumeSession(dispute.sessionId);
      const decidedAt = new Date().toISOString();
      const remainingPayout = await resolveRemainingPayout(session);
      const resolution = buildDisputeResolution({
        verdict: payload?.verdict ?? payload?.outcome,
        remainingPayout,
        workerPayout: payload?.workerPayout ?? payload?.payoutAmount
      });
      const reasoning = buildDisputeReasoningReceipt({
        id,
        dispute,
        payload,
        auth,
        verdict: resolution.verdict,
        decidedAt
      });
      const chainReceipt = gateway?.isEnabled?.() && typeof gateway.resolveDispute === "function"
        ? await gateway.resolveDispute(
            session.chainJobId ?? session.jobId,
            resolution.workerPayout,
            resolution.reasonCode,
            reasoning.metadataURI
          )
        : {
            txHash: undefined,
            blockNumber: undefined,
            status: undefined
          };
      const receipt = {
        id,
        disputeId: id,
        sessionId: dispute.sessionId,
        chainJobId: session.chainJobId,
        verdict: resolution.verdict,
        workerPayout: resolution.workerPayout,
        remainingPayout,
        reasonCode: resolution.reasonCode,
        reasoningHash: reasoning.reasoningHash,
        metadataURI: reasoning.metadataURI,
        rationale: reasoning.rationale || undefined,
        releaseAction: resolution.releaseAction,
        payoutSource: resolution.payoutSource,
        txHash: chainReceipt.txHash,
        blockNumber: chainReceipt.blockNumber,
        chainStatus: gateway?.isEnabled?.()
          ? (chainReceipt.status === 1 ? "confirmed" : "submitted")
          : "local_only",
        decidedBy: auth.wallet,
        decidedAt
      };
      await stateStore.upsertMutationReceipt?.("dispute_verdict", id, receipt);
      if (session.status === "disputed") {
        const transitioned = transitionSession(session, resolution.nextSessionStatus, {
          reason: resolution.reasonCode,
          timestamp: decidedAt,
          metadata: {
            disputeId: id,
            verdict: resolution.verdict,
            workerPayout: resolution.workerPayout,
            reasonCode: resolution.reasonCode,
            txHash: receipt.txHash
          }
        });
        await stateStore.upsertSession?.(transitioned);
      }
      eventBus?.publish({
        id: `dispute-verdict-${id}-${Date.now()}`,
        topic: "escrow.dispute_resolved",
        wallet: dispute.claimant,
        wallets: [dispute.claimant, auth.wallet],
        sessionId: dispute.sessionId,
        timestamp: receipt.decidedAt,
        data: {
          disputeId: id,
          verdict: resolution.verdict,
          workerPayout: resolution.workerPayout,
          reasonCode: resolution.reasonCode,
          txHash: receipt.txHash
        }
      });
      return respond(response, 200, {
        ...dispute,
        status: "resolved",
        verdict: resolution.verdict,
        reasonCode: resolution.reasonCode,
        reasoningHash: reasoning.reasoningHash,
        metadataURI: reasoning.metadataURI,
        txHash: receipt.txHash,
        chainStatus: receipt.chainStatus,
        workerPayout: resolution.workerPayout,
        remainingPayout,
        timeline: [
          ...dispute.timeline,
          {
            id: `${id}:verdict`,
            at: receipt.decidedAt,
            actor: receipt.decidedBy,
            action: "verdict_submitted",
            data: receipt
          }
        ]
      });
    }

    if (request.method === "POST" && /^\/disputes\/[^/]+\/release$/u.test(pathname)) {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      const id = decodeURIComponent(pathname.slice("/disputes/".length, -"/release".length));
      const dispute = await findDispute(id);
      if (!dispute) {
        return respond(response, 404, { status: "not_found", id });
      }
      const payload = await readJsonBody(request);
      const receipt = {
        id,
        disputeId: id,
        sessionId: dispute.sessionId,
        action: typeof payload?.action === "string" && payload.action.trim() ? payload.action.trim() : "release",
        amount: Number(payload?.amount ?? dispute.stakedAmount ?? 0),
        chainStatus: dispute.txHash ? "settled_by_verdict" : "local_only",
        txHash: dispute.txHash,
        releasedBy: auth.wallet,
        releasedAt: new Date().toISOString()
      };
      await stateStore.upsertMutationReceipt?.("dispute_release", id, receipt);
      eventBus?.publish({
        id: `dispute-release-${id}-${Date.now()}`,
        topic: "account.job_stake_released",
        wallet: dispute.claimant,
        wallets: [dispute.claimant, auth.wallet],
        sessionId: dispute.sessionId,
        timestamp: receipt.releasedAt,
        data: { disputeId: id, amount: receipt.amount, action: receipt.action }
      });
      return respond(response, 200, {
        ...dispute,
        status: "resolved",
        release: receipt,
        timeline: [
          ...dispute.timeline,
          {
            id: `${id}:release`,
            at: receipt.releasedAt,
            actor: receipt.releasedBy,
            action: "stake_release_recorded",
            data: receipt
          }
        ]
      });
    }

    // ---------- auth routes ----------

    if (request.method === "POST" && pathname === "/auth/nonce") {
      await enforceLimit("auth_nonce", clientIp(request), rateLimitConfig.authNonce);
      const payload = await readJsonBody(request);
      const wallet = String(payload?.wallet ?? "").trim();
      if (!/^0x[a-fA-F0-9]{40}$/u.test(wallet)) {
        throw new ValidationError("wallet must be a 0x-prefixed 20-byte hex address.");
      }
      const nonce = generateNonce();
      const stored = await stateStore.storeNonce?.(nonce, wallet.toLowerCase(), authConfig.nonceTtlSeconds);
      if (stored === false) {
        throw new ValidationError("Nonce collision — retry.");
      }
      const issuedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + authConfig.nonceTtlSeconds * 1000).toISOString();
      return respond(response, 200, {
        wallet,
        nonce,
        domain: authConfig.domain,
        chainId: authConfig.chainId,
        statement: SIWE_STATEMENT,
        issuedAt,
        expiresAt,
        message: buildSiweMessage({
          domain: authConfig.domain,
          address: wallet,
          statement: SIWE_STATEMENT,
          uri: `https://${authConfig.domain}`,
          chainId: authConfig.chainId,
          nonce,
          issuedAt,
          expirationTime: expiresAt
        })
      });
    }

    if (request.method === "POST" && pathname === "/auth/verify") {
      await enforceLimit("auth_verify", clientIp(request), rateLimitConfig.authVerify);
      const payload = await readJsonBody(request);
      const message = typeof payload?.message === "string" ? payload.message : "";
      const signature = typeof payload?.signature === "string" ? payload.signature : "";
      if (!message || !signature) {
        throw new ValidationError("message and signature are required.");
      }
      if (message.length > 4096) {
        throw new ValidationError("SIWE message exceeds 4096 characters.");
      }
      // EIP-191 personal_sign signatures are 65 bytes -> 132 chars incl. 0x.
      // Some wallets return r/s/v concatenated without 0x; accept both but cap
      // the length to discourage callers from submitting unrelated payloads.
      if (!/^(0x)?[0-9a-fA-F]{130,132}$/u.test(signature)) {
        throw new ValidationError("signature must be a 65-byte hex string.");
      }
      if (!authConfig.signingSecret) {
        throw new AuthenticationError(
          "Auth not configured — set AUTH_JWT_SECRETS to issue tokens.",
          "auth_not_configured"
        );
      }

      const verified = verifySiweMessage(message, signature, {
        expectedDomain: authConfig.domain,
        expectedChainId: authConfig.chainId
      });

      const consumedWallet = await stateStore.consumeNonce?.(verified.nonce);
      if (!consumedWallet) {
        throw new AuthenticationError("Nonce missing or already consumed.", "invalid_nonce");
      }
      if (!walletsMatch(consumedWallet, verified.recoveredAddress)) {
        throw new AuthenticationError("Nonce was issued for a different wallet.", "nonce_wallet_mismatch");
      }

      const roles = authConfig.resolveRoles?.(verified.recoveredAddress) ?? [];
      const { token, claims } = signToken(
        { sub: verified.recoveredAddress, roles },
        { secret: authConfig.signingSecret, expiresInSeconds: authConfig.tokenTtlSeconds }
      );

      return respond(response, 200, {
        token,
        wallet: verified.recoveredAddress,
        roles,
        capabilities: authCapabilities.resolveCapabilities({ roles }),
        expiresAt: new Date(claims.exp * 1000).toISOString(),
        tokenType: "Bearer"
      });
    }

    if (request.method === "GET" && pathname === "/auth/session") {
      const auth = await authMiddleware(request, url);
      return respond(response, 200, {
        wallet: auth.wallet,
        roles: auth.claims?.roles ?? [],
        capabilities: auth.capabilities ?? [],
        capabilityMatrix: authCapabilities.capabilityMatrix()
      });
    }

    if (request.method === "POST" && pathname === "/auth/logout") {
      // Revoke the current JWT by its `jti`. Requires authentication so a
      // random caller can't revoke someone else's token.
      const auth = await authMiddleware(request, url);
      const jti = auth.claims?.jti;
      const exp = auth.claims?.exp;
      if (jti && Number.isFinite(exp)) {
        const ttlSeconds = Math.max(1, exp - Math.floor(Date.now() / 1000));
        await stateStore.revokeToken?.(jti, ttlSeconds);
      }
      return respond(response, 200, {
        status: "logged_out",
        wallet: auth.wallet,
        jti
      });
    }

    // ---------- protected routes ----------

    if (request.method === "GET" && pathname === "/events") {
      const auth = await authMiddleware(request, url, { allowQueryToken: true });
      await enforceLimit("events", auth.wallet, rateLimitConfig.events);
      respondSse(response);
      const filter = {
        wallet: auth.wallet,
        jobId: url.searchParams.get("jobId") ?? undefined,
        sessionId: url.searchParams.get("sessionId") ?? undefined,
        topics: parseTopics(url)
      };
      const lastEventId = request.headers["last-event-id"] ?? url.searchParams.get("lastEventId") ?? undefined;
      const replay = eventBus?.replay?.(filter, lastEventId);

      if (replay?.gap) {
        writeSseEvent(response, {
          id: `gap-${Date.now()}`,
          topic: "gap",
          data: {
            topic: "gap",
            lastDelivered: lastEventId ?? null
          }
        });
      }

      for (const event of replay?.events ?? []) {
        writeSseEvent(response, { id: event.id, topic: event.topic, data: event });
      }

      const heartbeat = setInterval(() => {
        response.write(": ping\n\n");
      }, 15_000);

      const unsubscribe = eventBus?.subscribe?.(filter, (event) => {
        writeSseEvent(response, { id: event.id, topic: event.topic, data: event });
      });

      metrics.gauge("sse_active_connections").inc();
      request.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe?.();
        metrics.gauge("sse_active_connections").dec();
        response.end();
      });
      return;
    }

    if (request.method === "GET" && pathname === "/account") {
      const auth = await authMiddleware(request, url);
      const account = await service.getAccountSummary(auth.wallet);
      if (!gateway?.isEnabled?.() || !strategies.length) {
        return respond(response, 200, account);
      }

      const [strategyPositions, strategyTelemetry] = await Promise.all([
        gateway.getStrategyPositions(auth.wallet, strategies).catch(() => []),
        gateway.getStrategyTelemetry(strategies).catch(() => [])
      ]);
      const sharesByStrategy = Object.fromEntries(strategyPositions.map((entry) => [entry.strategyId, Number(entry.shares ?? 0)]));
      const telemetryByStrategy = Object.fromEntries(strategyTelemetry.map((entry) => [entry.strategyId, entry]));
      const liveAllocatedByAsset = {};
      for (const strategy of strategies) {
        const shares = Number(sharesByStrategy[strategy.strategyId] ?? 0);
        if (!(shares > 0)) continue;
        const telemetry = telemetryByStrategy[strategy.strategyId];
        const liveValue = telemetry?.reported && Number.isFinite(Number(telemetry.sharePrice))
          ? shares * Number(telemetry.sharePrice)
          : shares;
        const symbol = resolveAssetSymbol(strategy.asset);
        liveAllocatedByAsset[symbol] = (liveAllocatedByAsset[symbol] ?? 0) + liveValue;
      }

      return respond(response, 200, {
        ...account,
        strategyAllocated: {
          ...account.strategyAllocated,
          ...liveAllocatedByAsset
        }
      });
    }

    if (request.method === "GET" && pathname === "/account/borrow-capacity") {
      const auth = await authMiddleware(request, url);
      const asset = url.searchParams.get("asset")?.trim() || "DOT";
      return respond(response, 200, {
        wallet: auth.wallet,
        asset,
        borrowCapacity: await service.getBorrowCapacity(auth.wallet, asset)
      });
    }

    if (request.method === "POST" && pathname === "/account/fund") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      const asset = typeof payload?.asset === "string" && payload.asset.trim()
        ? payload.asset.trim()
        : (url.searchParams.get("asset")?.trim() || "DOT");
      const amount = Number(payload?.amount ?? url.searchParams.get("amount") ?? "0");
      return respond(response, 200, await service.fundAccount(auth.wallet, asset, amount));
    }

    if (request.method === "POST" && pathname === "/account/allocate") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      const asset = typeof payload?.asset === "string" && payload.asset.trim()
        ? payload.asset.trim()
        : (url.searchParams.get("asset")?.trim() || "DOT");
      const strategyId = typeof payload?.strategyId === "string" && payload.strategyId.trim()
        ? payload.strategyId.trim()
        : (url.searchParams.get("strategyId")?.trim() || "default-low-risk");
      const amount = Number(payload?.amount ?? url.searchParams.get("amount") ?? "0");
      const strategy = findStrategyConfig(strategyId);
      if (strategy?.executionMode === "async_xcm") {
        const strategyAsset = resolveStrategyAssetSymbol(strategy);
        const options = parseAsyncTreasuryOptions(payload, url);
        const mutationKey = options.idempotencyKey
          ? `${auth.wallet}:${strategyId}:${options.idempotencyKey}`
          : undefined;
        const existing = mutationKey ? await stateStore.getMutationReceipt?.("account_allocate_async", mutationKey) : undefined;
        if (existing) {
          return respond(response, 200, existing);
        }
        const nonce = options.nonce ?? (mutationKey ? deriveAsyncNonce(mutationKey) : Date.now());
        const result = await service.allocateIdleFunds(
          auth.wallet,
          strategyAsset,
          amount,
          strategyId,
          strategy,
          { ...options, nonce }
        );
        if (mutationKey) {
          await stateStore.upsertMutationReceipt?.("account_allocate_async", mutationKey, result);
        }
        return respond(response, 200, result);
      }
      return respond(response, 200, await service.allocateIdleFunds(auth.wallet, asset, amount, strategyId, strategy));
    }

    if (request.method === "POST" && pathname === "/account/deallocate") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      const asset = typeof payload?.asset === "string" && payload.asset.trim()
        ? payload.asset.trim()
        : (url.searchParams.get("asset")?.trim() || "DOT");
      const strategyId = typeof payload?.strategyId === "string" && payload.strategyId.trim()
        ? payload.strategyId.trim()
        : (url.searchParams.get("strategyId")?.trim() || "default-low-risk");
      const amount = Number(payload?.amount ?? url.searchParams.get("amount") ?? "0");
      const strategy = findStrategyConfig(strategyId);
      if (strategy?.executionMode === "async_xcm") {
        const strategyAsset = resolveStrategyAssetSymbol(strategy);
        const options = parseAsyncTreasuryOptions(payload, url, {
          defaultRecipient: gateway?.config?.agentAccountAddress
        });
        const mutationKey = options.idempotencyKey
          ? `${auth.wallet}:${strategyId}:${options.idempotencyKey}`
          : undefined;
        const existing = mutationKey ? await stateStore.getMutationReceipt?.("account_deallocate_async", mutationKey) : undefined;
        if (existing) {
          return respond(response, 200, existing);
        }
        const nonce = options.nonce ?? (mutationKey ? deriveAsyncNonce(mutationKey) : Date.now());
        const result = await service.deallocateIdleFunds(
          auth.wallet,
          strategyAsset,
          amount,
          strategyId,
          strategy,
          { ...options, nonce }
        );
        if (mutationKey) {
          await stateStore.upsertMutationReceipt?.("account_deallocate_async", mutationKey, result);
        }
        return respond(response, 200, result);
      }
      return respond(response, 200, await service.deallocateIdleFunds(auth.wallet, asset, amount, strategyId, strategy));
    }

    if (request.method === "GET" && pathname === "/account/strategies") {
      const auth = await authMiddleware(request, url);
      const account = await service.getAccountSummary(auth.wallet);
      const borrowCapacity = await service.getBorrowCapacity(auth.wallet, "DOT").catch(() => undefined);
      const adapterTelemetryByStrategy = gateway?.isEnabled?.()
        ? Object.fromEntries((await gateway.getStrategyTelemetry(strategies)).map((entry) => [entry.strategyId, entry]))
        : {};
      const strategyPositions = gateway?.isEnabled?.()
        ? await gateway.getStrategyPositions(auth.wallet, strategies)
        : [];
      const sharesByStrategy = gateway?.isEnabled?.()
        ? Object.fromEntries(strategyPositions.map((entry) => [entry.strategyId, entry.shares]))
        : (account.strategyShares ?? {});
      const pendingByStrategy = gateway?.isEnabled?.()
        ? Object.fromEntries(strategyPositions.map((entry) => [entry.strategyId, entry]))
        : (account.strategyPending ?? {});
      const totalLiquid = sumNumericValues(account.liquid);
      const debtTotal = sumNumericValues(account.debtOutstanding);
      const strategyActivity = account.strategyActivity ?? {};
      const strategyAccounting = account.strategyAccounting ?? {};
      const positions = strategies.map((strategy) => {
        const shares = Number(sharesByStrategy[strategy.strategyId] ?? 0);
        const pendingPosition = pendingByStrategy[strategy.strategyId] ?? {};
        const pendingDepositAssets = Number(pendingPosition.pendingDepositAssets ?? 0);
        const pendingWithdrawalShares = Number(pendingPosition.pendingWithdrawalShares ?? 0);
        const lastMovement = strategyActivity[strategy.strategyId];
        const accounting = strategyAccounting[strategy.strategyId] ?? {};
        const isMock = String(strategy.kind ?? "").includes("mock");
        const telemetry = adapterTelemetryByStrategy[strategy.strategyId];
        const routedAmount = telemetry?.reported && Number.isFinite(Number(telemetry.sharePrice))
          ? shares * Number(telemetry.sharePrice)
          : shares;
        const principalValue = Number(accounting.principal ?? shares);
        const realizedYield = Number(accounting.realizedYield ?? 0);
        const unrealizedYield = routedAmount - principalValue;
        return {
          strategyId: strategy.strategyId,
          asset: strategy.asset,
          assetConfig: strategy.assetConfig,
          assetSymbol: resolveStrategyAssetSymbol(strategy),
          executionMode: strategy.executionMode ?? "sync",
          shares,
          shareCount: shares,
          pendingDepositAssets,
          pendingWithdrawalShares,
          routedAmount,
          principalValue,
          unrealizedYield,
          realizedYield,
          totalYield: realizedYield + unrealizedYield,
          statusLabel: pendingDepositAssets > 0
            ? "Pending deposit"
            : pendingWithdrawalShares > 0
              ? "Pending withdraw"
              : shares > 0
                ? "Routed"
                : "Idle",
          yieldReported: Boolean(telemetry?.reported),
          yieldStatus: telemetry?.reported ? (isMock ? "simulated" : "live") : (isMock ? "simulated_unreported" : "unreported"),
          yieldLabel: formatAdapterYieldLabel({ telemetry, isMock, shares }),
          sharePrice: telemetry?.sharePrice,
          performanceBps: telemetry?.performanceBps,
          adapterTotalAssets: telemetry?.totalAssets,
          adapterTotalShares: telemetry?.totalShares,
          adapterLinked: true,
          adapterLinkStatus: shares > 0
            ? "Wallet capital is now settled into the adapter and priced from live adapter reads."
            : "Adapter performance is live even when this wallet has no routed capital in the lane.",
          riskLabel: telemetry?.riskLabel || strategy.riskLabel || "",
          lastAction: lastMovement?.action,
          lastMovementAt: lastMovement?.at,
          attention: buildLaneAttention({
            shares,
            isMock,
            debtTotal,
            borrowCapacity: Number(borrowCapacity),
            deploymentShareBps: 0
          })
        };
      });
      const totalAllocated = positions.reduce((sum, entry) => sum + (Number(entry.routedAmount) || 0), 0);
      const totalPrincipal = positions.reduce((sum, entry) => sum + (Number(entry.principalValue) || 0), 0);
      const totalUnrealizedYield = positions.reduce((sum, entry) => sum + (Number(entry.unrealizedYield) || 0), 0);
      const totalRealizedYield = positions.reduce((sum, entry) => sum + (Number(entry.realizedYield) || 0), 0);
      const treasuryBase = totalLiquid + totalAllocated;
      const normalizedPositions = positions.map((entry) => ({
        ...entry,
        deploymentShareBps: ratioToBps(Number(entry.routedAmount), totalAllocated),
        treasuryShareBps: ratioToBps(Number(entry.routedAmount), treasuryBase),
        attention: buildLaneAttention({
          shares: Number(entry.routedAmount),
          isMock: entry.yieldStatus === "simulated" || entry.yieldStatus === "simulated_unreported",
          debtTotal,
          borrowCapacity: Number(borrowCapacity),
          deploymentShareBps: ratioToBps(Number(entry.routedAmount), totalAllocated)
        })
      }));
      const treasuryTimeline = await service.recordStrategySnapshots(
        auth.wallet,
        normalizedPositions.map((entry) => ({
          strategyId: entry.strategyId,
          asset: entry.asset,
          assetSymbol: entry.assetSymbol,
          shares: entry.shares,
          currentValue: entry.routedAmount,
          sharePrice: entry.sharePrice
        }))
      );
      return respond(response, 200, {
        wallet: auth.wallet,
        summary: {
          treasuryBase,
          liquid: totalLiquid,
          allocated: totalAllocated,
          principal: totalPrincipal,
          unrealizedYield: totalUnrealizedYield,
          realizedYield: totalRealizedYield,
          totalYield: totalRealizedYield + totalUnrealizedYield,
          debt: debtTotal,
          borrowCapacity: Number.isFinite(Number(borrowCapacity)) ? Number(borrowCapacity) : undefined,
          deployedLanes: normalizedPositions.filter((entry) => entry.routedAmount > 0).length,
          attentionCount: normalizedPositions.filter((entry) => entry.attention).length
        },
        positions: normalizedPositions,
        timeline: (treasuryTimeline ?? []).map(normalizeTimelineEntry)
      });
    }

    if (request.method === "POST" && pathname === "/account/borrow") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      const asset = typeof payload?.asset === "string" && payload.asset.trim()
        ? payload.asset.trim()
        : (url.searchParams.get("asset")?.trim() || "DOT");
      const amount = Number(payload?.amount ?? url.searchParams.get("amount") ?? "0");
      return respond(response, 200, await service.borrow(auth.wallet, asset, amount));
    }

    if (request.method === "POST" && pathname === "/account/repay") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      const asset = typeof payload?.asset === "string" && payload.asset.trim()
        ? payload.asset.trim()
        : (url.searchParams.get("asset")?.trim() || "DOT");
      const amount = Number(payload?.amount ?? url.searchParams.get("amount") ?? "0");
      return respond(response, 200, await service.repay(auth.wallet, asset, amount));
    }

    if (request.method === "GET" && pathname === "/reputation") {
      const auth = await authMiddleware(request, url);
      return respond(response, 200, await service.getReputation(auth.wallet));
    }

    if (request.method === "GET" && pathname === "/session") {
      const auth = await authMiddleware(request, url);
      const sessionId = url.searchParams.get("sessionId") ?? "";
      try {
        const session = await service.resumeSession(sessionId);
        if (!walletsMatch(session.wallet, auth.wallet)) {
          throw new AuthorizationError(
            `Session ${sessionId} does not belong to authenticated wallet.`,
            "session_not_owned"
          );
        }
        return respond(response, 200, session);
      } catch (error) {
        const normalized = normalizeError(error);
        if (normalized.code === "session_not_found") {
          return respond(response, 404, { status: "not_found", sessionId });
        }
        throw normalized;
      }
    }

    if (request.method === "GET" && pathname === "/session/timeline") {
      const auth = await authMiddleware(request, url);
      const sessionId = url.searchParams.get("sessionId") ?? "";
      await ensureSessionOwnership(sessionId, auth.wallet);
      return respond(response, 200, await service.getSessionTimeline(sessionId));
    }

    if (request.method === "GET" && pathname === "/xcm/request") {
      const auth = await authMiddleware(request, url);
      const requestId = url.searchParams.get("requestId") ?? "";
      if (!requestId) {
        throw new ValidationError("requestId is required.");
      }
      const record = await service.getXcmRequest(requestId);
      ensureXcmRequestOwnership(record, auth);
      return respond(response, 200, record);
    }

    if (request.method === "GET" && pathname === "/sessions") {
      const auth = await authMiddleware(request, url);
      const limit = Number(url.searchParams.get("limit") ?? 8);
      const jobId = url.searchParams.get("jobId") ?? undefined;
      return respond(
        response,
        200,
        await service.listSessionHistory({
          wallet: auth.wallet,
          limit: Number.isFinite(limit) ? limit : 8,
          jobId
        })
      );
    }

    if (request.method === "GET" && pathname === "/jobs/recommendations") {
      const auth = await authMiddleware(request, url);
      return respond(response, 200, await service.recommendJobs(auth.wallet));
    }

    if (request.method === "GET" && pathname === "/jobs/preflight") {
      const auth = await authMiddleware(request, url);
      return respond(
        response,
        200,
        await service.preflightJob(auth.wallet, url.searchParams.get("jobId") ?? "")
      );
    }

    if (request.method === "GET" && pathname === "/jobs/sub") {
      const auth = await authMiddleware(request, url);
      const parentSessionId = url.searchParams.get("parentSessionId") ?? "";
      await ensureSessionOwnership(parentSessionId, auth.wallet);
      return respond(response, 200, await service.listSubJobs(parentSessionId));
    }

    if (request.method === "POST" && pathname === "/jobs/sub") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      const parentSessionId = typeof payload?.parentSessionId === "string" && payload.parentSessionId.trim()
        ? payload.parentSessionId.trim()
        : (url.searchParams.get("parentSessionId") ?? "");
      if (!parentSessionId) {
        throw new ValidationError("parentSessionId is required.");
      }
      const created = await service.createSubJob(parentSessionId, auth.wallet, payload);
      return respond(response, 201, created);
    }

    if (request.method === "POST" && pathname === "/admin/jobs") {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
      const payload = await readJsonBody(request);
      const idempotencyKey = typeof payload?.idempotencyKey === "string" && payload.idempotencyKey.trim()
        ? payload.idempotencyKey.trim()
        : undefined;
      const mutationKey = idempotencyKey ? `${auth.wallet}:${idempotencyKey}` : undefined;
      const existing = mutationKey ? await stateStore.getMutationReceipt?.("admin_jobs", mutationKey) : undefined;
      if (existing) {
        return respond(response, 200, existing);
      }
      const created = service.createJob(payload);
      if (mutationKey) {
        await stateStore.upsertMutationReceipt?.("admin_jobs", mutationKey, created);
      }
      return respond(response, 201, created);
    }

    if (request.method === "POST" && pathname === "/admin/jobs/ingest/github") {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
      const payload = await readJsonBody(request);
      const query = typeof payload?.query === "string" && payload.query.trim()
        ? payload.query.trim()
        : undefined;
      const limit = parsePositiveInteger(payload?.limit, 10, 50);
      const minScore = parsePositiveInteger(payload?.minScore, 55, 100);
      const dryRun = payload?.dryRun !== false;
      const result = await ingestGithubIssues({
        query,
        limit,
        minScore,
        githubToken: process.env.GITHUB_TOKEN?.trim() || undefined
      });

      if (dryRun) {
        return respond(response, 200, {
          ...result,
          dryRun: true,
          created: [],
          skipped: [
            ...(Array.isArray(result.skipped) ? result.skipped : []),
            ...(Number.isFinite(result.skipped) ? [{ reason: "below_min_score_or_over_limit", count: result.skipped }] : [])
          ]
        });
      }

      const created = [];
      const skipped = [];
      const errors = [];
      for (const job of result.jobs) {
        try {
          created.push(service.createJob(job));
        } catch (error) {
          const normalized = normalizeError(error);
          if (normalized.code === "job_exists") {
            skipped.push({ id: job.id, reason: "already_exists" });
            continue;
          }
          errors.push({
            id: job.id,
            code: normalized.code,
            message: normalized.message
          });
        }
      }

      const status = errors.length ? 207 : 201;
      return respond(response, status, {
        query: result.query,
        minScore: result.minScore,
        dryRun: false,
        candidateCount: result.count,
        created,
        skipped: [
          ...skipped,
          ...(Number.isFinite(result.skipped) ? [{ reason: "below_min_score_or_over_limit", count: result.skipped }] : [])
        ],
        errors
      });
    }

    if (request.method === "POST" && pathname === "/admin/jobs/ingest/wikipedia") {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
      const payload = await readJsonBody(request);
      const language = typeof payload?.language === "string" && payload.language.trim()
        ? payload.language.trim()
        : undefined;
      const categories = Array.isArray(payload?.categories) || typeof payload?.categories === "string"
        ? parseCategories(payload.categories)
        : undefined;
      const limit = parsePositiveInteger(payload?.limit, 10, 50);
      const minScore = parsePositiveInteger(payload?.minScore, 55, 100);
      const dryRun = payload?.dryRun !== false;
      const result = await ingestWikipediaMaintenance({
        language,
        categories,
        limit,
        minScore
      });

      if (dryRun) {
        return respond(response, 200, {
          ...result,
          dryRun: true,
          created: [],
          skipped: [
            ...(Array.isArray(result.skipped) ? result.skipped : []),
            ...(Number.isFinite(result.skipped) ? [{ reason: "below_min_score_or_over_limit", count: result.skipped }] : [])
          ]
        });
      }

      const created = [];
      const skipped = [];
      const errors = [];
      for (const job of result.jobs) {
        try {
          created.push(service.createJob(job));
        } catch (error) {
          const normalized = normalizeError(error);
          if (normalized.code === "job_exists") {
            skipped.push({ id: job.id, reason: "already_exists" });
            continue;
          }
          errors.push({
            id: job.id,
            code: normalized.code,
            message: normalized.message
          });
        }
      }

      const status = errors.length ? 207 : 201;
      return respond(response, status, {
        language: result.language,
        categories: result.categories,
        minScore: result.minScore,
        dryRun: false,
        candidateCount: result.count,
        created,
        skipped: [
          ...skipped,
          ...(Number.isFinite(result.skipped) ? [{ reason: "below_min_score_or_over_limit", count: result.skipped }] : [])
        ],
        errors
      });
    }

    if (request.method === "POST" && pathname === "/admin/jobs/ingest/osv") {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
      const payload = await readJsonBody(request);
      const packages = Array.isArray(payload?.packages) || typeof payload?.packages === "string"
        ? parseOsvPackages(payload.packages)
        : parseOsvPackages(process.env.OSV_INGEST_PACKAGES_JSON ?? process.env.OSV_INGEST_PACKAGES);
      const manifests = Array.isArray(payload?.manifests) || typeof payload?.manifests === "string"
        ? parseOsvManifests(payload.manifests)
        : parseOsvManifests(process.env.OSV_INGEST_MANIFESTS_JSON ?? process.env.OSV_INGEST_MANIFESTS);
      const limit = parsePositiveInteger(payload?.limit, 10, 50);
      const minScore = parsePositiveInteger(payload?.minScore, 55, 100);
      const maxPackageTargets = parsePositiveInteger(payload?.maxPackageTargets, 100, 500);
      const dryRun = payload?.dryRun !== false;
      const result = await ingestOsvAdvisories({ packages, manifests, limit, minScore, maxPackageTargets });

      if (dryRun) {
        return respond(response, 200, {
          ...result,
          dryRun: true,
          created: []
        });
      }

      const created = [];
      const skipped = [];
      const errors = [];
      for (const job of result.jobs) {
        try {
          created.push(service.createJob(job));
        } catch (error) {
          const normalized = normalizeError(error);
          if (normalized.code === "job_exists") {
            skipped.push({ id: job.id, reason: "already_exists" });
            continue;
          }
          errors.push({
            id: job.id,
            code: normalized.code,
            message: normalized.message
          });
        }
      }

      const status = errors.length ? 207 : 201;
      return respond(response, status, {
        ecosystem: result.ecosystem,
        minScore: result.minScore,
        dryRun: false,
        candidateCount: result.count,
        created,
        skipped: [...skipped, ...(Array.isArray(result.skipped) ? result.skipped : [])],
        errors
      });
    }

    if (request.method === "POST" && pathname === "/admin/jobs/ingest/open-data") {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
      const payload = await readJsonBody(request);
      const datasets = Array.isArray(payload?.datasets) || typeof payload?.datasets === "string"
        ? parseOpenDataDatasets(payload.datasets)
        : parseOpenDataDatasets(process.env.OPEN_DATA_INGEST_DATASETS_JSON ?? process.env.OPEN_DATA_INGEST_DATASETS);
      const query = typeof payload?.query === "string" && payload.query.trim()
        ? payload.query.trim()
        : process.env.OPEN_DATA_INGEST_QUERY;
      const limit = parsePositiveInteger(payload?.limit, 10, 50);
      const minScore = parsePositiveInteger(payload?.minScore, 55, 100);
      const dryRun = payload?.dryRun !== false;
      const result = await ingestOpenDataDatasets({ datasets, query, limit, minScore });

      if (dryRun) {
        return respond(response, 200, {
          ...result,
          dryRun: true,
          created: []
        });
      }

      const created = [];
      const skipped = [];
      const errors = [];
      for (const job of result.jobs) {
        try {
          created.push(service.createJob(job));
        } catch (error) {
          const normalized = normalizeError(error);
          if (normalized.code === "job_exists") {
            skipped.push({ id: job.id, reason: "already_exists" });
            continue;
          }
          errors.push({
            id: job.id,
            code: normalized.code,
            message: normalized.message
          });
        }
      }

      const status = errors.length ? 207 : 201;
      return respond(response, status, {
        provider: result.provider,
        query: result.query,
        minScore: result.minScore,
        dryRun: false,
        candidateCount: result.count,
        created,
        skipped: [...skipped, ...(Array.isArray(result.skipped) ? result.skipped : [])],
        errors
      });
    }

    if (request.method === "POST" && pathname === "/admin/jobs/ingest/openapi") {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
      const payload = await readJsonBody(request);
      const specs = Array.isArray(payload?.specs) || typeof payload?.specs === "string"
        ? parseOpenApiSpecs(payload.specs)
        : parseOpenApiSpecs(process.env.OPENAPI_INGEST_SPECS_JSON ?? process.env.OPENAPI_INGEST_SPECS);
      const limit = parsePositiveInteger(payload?.limit, 10, 50);
      const minScore = parsePositiveInteger(payload?.minScore, 55, 100);
      const dryRun = payload?.dryRun !== false;
      const result = await ingestOpenApiSpecs({ specs, limit, minScore });

      if (dryRun) {
        return respond(response, 200, {
          ...result,
          dryRun: true,
          created: []
        });
      }

      const created = [];
      const skipped = [];
      const errors = [];
      for (const job of result.jobs) {
        try {
          created.push(service.createJob(job));
        } catch (error) {
          const normalized = normalizeError(error);
          if (normalized.code === "job_exists") {
            skipped.push({ id: job.id, reason: "already_exists" });
            continue;
          }
          errors.push({
            id: job.id,
            code: normalized.code,
            message: normalized.message
          });
        }
      }

      const status = errors.length ? 207 : 201;
      return respond(response, status, {
        provider: result.provider,
        specCount: result.specCount,
        minScore: result.minScore,
        dryRun: false,
        candidateCount: result.count,
        created,
        skipped: [...skipped, ...(Array.isArray(result.skipped) ? result.skipped : [])],
        errors
      });
    }

    if (request.method === "POST" && pathname === "/admin/jobs/ingest/standards") {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
      const payload = await readJsonBody(request);
      const specs = Array.isArray(payload?.specs) || typeof payload?.specs === "string"
        ? parseStandardsSpecs(payload.specs)
        : parseStandardsSpecs(process.env.STANDARDS_INGEST_SPECS_JSON ?? process.env.STANDARDS_INGEST_SPECS);
      const limit = parsePositiveInteger(payload?.limit, 10, 50);
      const minScore = parsePositiveInteger(payload?.minScore, 55, 100);
      const dryRun = payload?.dryRun !== false;
      const result = await ingestStandardsSpecs({ specs, limit, minScore });

      if (dryRun) {
        return respond(response, 200, {
          ...result,
          dryRun: true,
          created: []
        });
      }

      const created = [];
      const skipped = [];
      const errors = [];
      for (const job of result.jobs) {
        try {
          created.push(service.createJob(job));
        } catch (error) {
          const normalized = normalizeError(error);
          if (normalized.code === "job_exists") {
            skipped.push({ id: job.id, reason: "already_exists" });
            continue;
          }
          errors.push({
            id: job.id,
            code: normalized.code,
            message: normalized.message
          });
        }
      }

      const status = errors.length ? 207 : 201;
      return respond(response, status, {
        provider: result.provider,
        specCount: result.specCount,
        minScore: result.minScore,
        dryRun: false,
        candidateCount: result.count,
        created,
        skipped: [...skipped, ...(Array.isArray(result.skipped) ? result.skipped : [])],
        errors
      });
    }

    if (request.method === "POST" && pathname === "/admin/jobs/fire") {
      // Manually fire one instance off a recurring template. This is the
      // v1 stopgap for the real scheduler worker (docs/patterns/recurring-
      // jobs.md) — ops or an external cron can poke this endpoint at the
      // schedule's cadence until a proper scheduler lands.
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
      const payload = await readJsonBody(request);
      const templateId = typeof payload?.templateId === "string" ? payload.templateId.trim() : "";
      if (!templateId) {
        throw new ValidationError("templateId is required.");
      }
      const idempotencyKey = typeof payload?.idempotencyKey === "string" && payload.idempotencyKey.trim()
        ? payload.idempotencyKey.trim()
        : undefined;
      const mutationKey = idempotencyKey ? `${auth.wallet}:${idempotencyKey}` : undefined;
      const existing = mutationKey ? await stateStore.getMutationReceipt?.("admin_jobs_fire", mutationKey) : undefined;
      if (existing) {
        return respond(response, 200, existing);
      }
      const firedAt = payload?.firedAt ? new Date(payload.firedAt) : new Date();
      if (Number.isNaN(firedAt.getTime())) {
        throw new ValidationError("firedAt must be ISO-8601 if provided.");
      }
      const derivative = service.fireRecurringJob(templateId, { firedAt });
      if (mutationKey) {
        await stateStore.upsertMutationReceipt?.("admin_jobs_fire", mutationKey, derivative);
      }
      return respond(response, 201, derivative);
    }

    if (request.method === "POST" && pathname === "/admin/jobs/pause") {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
      const payload = await readJsonBody(request);
      const templateId = typeof payload?.templateId === "string" ? payload.templateId.trim() : "";
      if (!templateId) {
        throw new ValidationError("templateId is required.");
      }
      await service.pauseRecurringTemplate(templateId);
      return respond(response, 200, await service.getAdminStatus({ auth }));
    }

    if (request.method === "POST" && pathname === "/admin/jobs/resume") {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
      const payload = await readJsonBody(request);
      const templateId = typeof payload?.templateId === "string" ? payload.templateId.trim() : "";
      if (!templateId) {
        throw new ValidationError("templateId is required.");
      }
      await service.resumeRecurringTemplate(templateId);
      return respond(response, 200, await service.getAdminStatus({ auth }));
    }

    if (request.method === "GET" && pathname === "/admin/status") {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      return respond(response, 200, await service.getAdminStatus({ auth }));
    }

    if (request.method === "POST" && pathname === "/admin/xcm/observe") {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
      const payload = await readJsonBody(request);
      const requestId = typeof payload?.requestId === "string" && payload.requestId.trim()
        ? payload.requestId.trim()
        : (url.searchParams.get("requestId") ?? "");
      if (!requestId) {
        throw new ValidationError("requestId is required.");
      }
      const idempotencyKey = typeof payload?.idempotencyKey === "string" && payload.idempotencyKey.trim()
        ? payload.idempotencyKey.trim()
        : undefined;
      const mutationKey = idempotencyKey ? `${auth.wallet}:${requestId}:${idempotencyKey}` : undefined;
      const existing = mutationKey ? await stateStore.getMutationReceipt?.("admin_xcm_observe", mutationKey) : undefined;
      if (existing) {
        return respond(response, 200, existing);
      }
      const observed = await service.observeXcmOutcome(requestId, {
        status: payload?.status,
        settledAssets: Number(payload?.settledAssets ?? 0),
        settledShares: Number(payload?.settledShares ?? 0),
        remoteRef: payload?.remoteRef,
        failureCode: payload?.failureCode,
        source: payload?.source ?? "admin_observer",
        observedAt: payload?.observedAt
      });
      if (mutationKey) {
        await stateStore.upsertMutationReceipt?.("admin_xcm_observe", mutationKey, observed);
      }
      return respond(response, 200, observed);
    }

    if (request.method === "POST" && pathname === "/admin/xcm/finalize") {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
      const payload = await readJsonBody(request);
      const requestId = typeof payload?.requestId === "string" && payload.requestId.trim()
        ? payload.requestId.trim()
        : (url.searchParams.get("requestId") ?? "");
      if (!requestId) {
        throw new ValidationError("requestId is required.");
      }
      const idempotencyKey = typeof payload?.idempotencyKey === "string" && payload.idempotencyKey.trim()
        ? payload.idempotencyKey.trim()
        : undefined;
      const mutationKey = idempotencyKey ? `${auth.wallet}:${requestId}:${idempotencyKey}` : undefined;
      const existing = mutationKey ? await stateStore.getMutationReceipt?.("admin_xcm_finalize", mutationKey) : undefined;
      if (existing) {
        return respond(response, 200, existing);
      }
      const finalized = await service.finalizeXcmRequest(requestId, {
        status: payload?.status,
        settledAssets: Number(payload?.settledAssets ?? 0),
        settledShares: Number(payload?.settledShares ?? 0),
        remoteRef: payload?.remoteRef,
        failureCode: payload?.failureCode
      });
      if (mutationKey) {
        await stateStore.upsertMutationReceipt?.("admin_xcm_finalize", mutationKey, finalized);
      }
      return respond(response, 200, finalized);
    }

    if (request.method === "POST" && pathname === "/gas/quote") {
      await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      return respond(response, 200, await pimlicoClient.quoteUserOperation(payload.userOperation));
    }

    if (request.method === "POST" && pathname === "/gas/sponsor") {
      await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      return respond(
        response,
        200,
        await pimlicoClient.sponsorUserOperation(payload.userOperation, payload.context ?? {})
      );
    }

    if (request.method === "POST" && pathname === "/payments/send") {
      // Agent-to-agent transfer. Pillar 5 of docs/AGENT_BANKING.md.
      // Authenticated: the signed-in wallet is the sender, and the
      // backend relays via AgentAccountCore.sendToAgentFor so the hot
      // signer key on the platform is the one paying gas, not the user.
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      const recipientRaw = String(payload?.recipient ?? "").trim();
      if (!/^0x[a-fA-F0-9]{40}$/u.test(recipientRaw)) {
        throw new ValidationError("recipient must be a 0x-prefixed 20-byte hex address.");
      }
      const recipient = safeChecksum(recipientRaw);
      if (recipient.toLowerCase() === auth.wallet.toLowerCase()) {
        throw new ValidationError("recipient must differ from the sender.");
      }
      const asset = typeof payload?.asset === "string" && payload.asset.trim()
        ? payload.asset.trim().toUpperCase()
        : "DOT";
      const amount = Number(payload?.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new ValidationError("amount must be a positive number.");
      }
      const balances = await service.sendToAgent(auth.wallet, recipient, asset, amount);
      return respond(response, 200, {
        status: "sent",
        from: auth.wallet,
        to: recipient,
        asset,
        amount,
        balances
      });
    }

    if (request.method === "POST" && pathname === "/jobs/claim") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      const jobId = typeof payload?.jobId === "string" && payload.jobId.trim()
        ? payload.jobId.trim()
        : (url.searchParams.get("jobId") ?? "");
      const idempotencyKey = typeof payload?.idempotencyKey === "string" && payload.idempotencyKey.trim()
        ? payload.idempotencyKey.trim()
        : (url.searchParams.get("idempotencyKey") ?? `${auth.wallet}:${jobId}`);
      return respond(response, 200, await service.claimJob(auth.wallet, jobId, "http", idempotencyKey));
    }

    if (request.method === "POST" && pathname === "/jobs/submit") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      const sessionId = typeof payload?.sessionId === "string" && payload.sessionId.trim()
        ? payload.sessionId.trim()
        : (url.searchParams.get("sessionId") ?? "");
      const submission = payload && typeof payload === "object" && "submission" in payload
        ? payload.submission
        : (typeof payload?.evidence === "string"
            ? payload.evidence
            : (url.searchParams.get("evidence") ?? "submitted-via-http"));
      if (!sessionId) {
        throw new ValidationError("sessionId is required.");
      }
      if (typeof submission === "string" && submission.length > 16 * 1024) {
        throw new ValidationError("evidence exceeds 16 KiB. Submit long payloads via evidenceURI once supported.");
      }
      await ensureSessionOwnership(sessionId, auth.wallet);
      return respond(response, 200, await service.submitWork(sessionId, "http", submission));
    }

    if (request.method === "POST" && pathname === "/verifier/run") {
      const auth = await authMiddleware(request, url, { requireRole: "verifier" });
      await enforceLimit("verifier_run", auth.wallet, rateLimitConfig.verifierRun);
      const payload = await readJsonBody(request);
      const sessionId = typeof payload?.sessionId === "string" && payload.sessionId.trim()
        ? payload.sessionId.trim()
        : (url.searchParams.get("sessionId") ?? "");
      const evidence = payload && typeof payload === "object" && "evidence" in payload
        ? payload.evidence
        : (url.searchParams.get("evidence") ?? "");
      const metadataURI = typeof payload?.metadataURI === "string" && payload.metadataURI.trim()
        ? payload.metadataURI.trim()
        : (url.searchParams.get("metadataURI") ?? "ipfs://pending-badge");
      return respond(response, 200, await verifierService.verifySubmission({ sessionId, evidence, metadataURI }));
    }

    return respond(response, 404, { error: "not_found" });
  } catch (error) {
    const normalized = normalizeError(error);
    const extraHeaders = { "x-request-id": requestId };
    const retryAfter = normalized.details?.retryAfterSeconds;
    if (normalized.statusCode === 429 && Number.isFinite(retryAfter)) {
      extraHeaders["retry-after"] = String(Math.max(1, Math.ceil(retryAfter)));
    }
    const logLevel = (normalized.statusCode ?? 500) >= 500 ? "error" : "warn";
    requestLogger[logLevel](
      {
        method: request.method,
        path: pathname,
        status: normalized.statusCode ?? 500,
        code: normalized.code,
        err: error instanceof Error ? error : new Error(String(error))
      },
      "http.error"
    );
    if ((normalized.statusCode ?? 500) === 401 || (normalized.statusCode ?? 500) === 403) {
      metrics.counter("auth_failures_total").inc({ code: normalized.code ?? "unknown" });
    }
    if ((normalized.statusCode ?? 500) >= 500) {
      // 5xx only — we deliberately don't ship 4xx noise to Sentry.
      observability.captureException(error instanceof Error ? error : new Error(String(error)), {
        requestId,
        method: request.method,
        path: pathname,
        status: normalized.statusCode ?? 500,
        code: normalized.code
      });
    }
    return respond(
      response,
      normalized.statusCode ?? 500,
      {
        error: normalized.code ?? "internal_error",
        message: normalized.message ?? "internal_error",
        details: normalized.details,
        requestId
      },
      extraHeaders
    );
  }
});

server.listen(port, () => {
  logger.info(
    {
      port,
      authMode: authConfig.mode,
      stateStoreBackend: stateStore.constructor.name,
      blockchainEnabled: Boolean(gateway?.isEnabled?.()),
      pimlicoEnabled: Boolean(pimlicoClient?.isEnabled?.())
    },
    "http.listening"
  );
});

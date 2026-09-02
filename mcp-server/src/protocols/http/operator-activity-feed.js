import { OPERATOR_SIGNERS } from "../../core/builtin-policies.js";

export function createOperatorActivityFeed({
  defaultVerifierAddress,
  listDisputes,
  listPolicies,
  now = () => Date.now(),
  operatorSigners = OPERATOR_SIGNERS,
  service,
  stateStore,
}) {
  return {
    listAlerts: (limit = 20) => listAlerts({
      limit,
      listDisputes,
      listPolicies,
      service,
    }),
    listAuditEvents: (limit = 100) => listAuditEvents({
      defaultVerifierAddress,
      limit,
      listPolicies,
      now,
      operatorSigners,
      service,
      stateStore,
    }),
  };
}

export async function listAuditEvents({
  defaultVerifierAddress,
  limit = 100,
  listPolicies,
  now = () => Date.now(),
  operatorSigners = OPERATOR_SIGNERS,
  service,
  stateStore,
}) {
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
      link: { label: "Open run ->", href: "/runs" },
      now,
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
        link: { label: "Open session ->", href: "/sessions" },
        now,
      }));
    }
    if (session.verification || session.verificationSummary) {
      events.push(auditEvent({
        id: `audit-${session.sessionId}-verified`,
        at: session.verifiedAt ?? session.updatedAt,
        source: "operator",
        category: "verifier",
        action: "verification.resolved",
        actor: auditActor("verifier", compactWallet(defaultVerifierAddress), "blue"),
        summary: `Verifier resolved ${session.jobId} as ${session.status}.`,
        target: session.sessionId,
        tone: session.status === "disputed" ? "warn" : "accent",
        link: { label: "Open receipt ->", href: "/receipts" },
        now,
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
      actor: auditActor(
        operatorSigners[policy.lastChange?.author]?.role ?? "operator",
        operatorSigners[policy.lastChange?.author]?.addr,
        "ink"
      ),
      summary: `${policy.tag}: ${policy.lastChange?.text}`,
      target: policy.tag,
      tone: policy.state === "Pending" ? "warn" : "neutral",
      link: { label: "Open policy ->", href: "/policies" },
      now,
    }));
  }
  if (typeof stateStore?.listCapabilityGrants === "function") {
    const grants = await stateStore.listCapabilityGrants({ limit: Math.min(limit, 100) }).catch(() => []);
    for (const grant of grants) {
      const issuer = compactWallet(grant.issuedBy);
      const subject = compactWallet(grant.subject);
      events.push(auditEvent({
        id: `audit-capability-grant-${grant.id}`,
        at: grant.issuedAt,
        source: "operator",
        category: "policy",
        action: "capability.grant",
        actor: auditActor("operator", issuer, "ink"),
        summary: `Granted ${grant.capabilities.length} capabilit${grant.capabilities.length === 1 ? "y" : "ies"} to ${subject}${grant.scope ? ` (${grant.scope})` : ""}.`,
        target: grant.id,
        tone: "neutral",
        link: { label: "Open grants ->", href: "/capabilities" },
        now,
      }));
      if (grant.status === "revoked" && grant.revokedAt) {
        events.push(auditEvent({
          id: `audit-capability-revoke-${grant.id}`,
          at: grant.revokedAt,
          source: "operator",
          category: "policy",
          action: "capability.revoke",
          actor: auditActor("operator", compactWallet(grant.revokedBy), "warn"),
          summary: `Revoked grant ${grant.id} for ${subject}${grant.revokeNote ? ` - ${grant.revokeNote}` : ""}.`,
          target: grant.id,
          tone: "warn",
          link: { label: "Open grants ->", href: "/capabilities" },
          now,
        }));
      }
    }
  }
  return events
    .sort((left, right) => String(right.day + right.at).localeCompare(String(left.day + left.at)))
    .slice(0, limit);
}

export async function listAlerts({
  limit = 20,
  listDisputes,
  listPolicies,
  service,
}) {
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

export function compactWallet(wallet) {
  const value = String(wallet ?? "");
  if (value.length <= 12) return value || "system";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function auditTime(value) {
  const date = new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) return "00:00:00";
  return date.toISOString().slice(11, 19);
}

function auditDay(value, now = () => Date.now()) {
  const date = new Date(value ?? now());
  if (Number.isNaN(date.getTime())) return "today";
  const today = new Date(now()).toISOString().slice(0, 10);
  const yesterday = new Date(now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
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

function auditEvent({ id, at, source, category, action, actor, summary, target, hash, tone, link, now }) {
  return compactObject({
    id,
    at: auditTime(at),
    day: auditDay(at, now),
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

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null)
  );
}

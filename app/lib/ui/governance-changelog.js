function toTime(value) {
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? time : 0;
}

function previousRevision(rule, currentRevision) {
  const revisions = Object.keys(rule ?? {})
    .map((key) => {
      const match = /^v(\d+)$/u.exec(key);
      return match ? Number(match[1]) : null;
    })
    .filter((value) => Number.isFinite(value) && value < currentRevision)
    .sort((left, right) => right - left);
  return revisions[0] ?? null;
}

export function buildPolicyChangeEntries(policies, { limit = 4 } = {}) {
  const entries = [];
  for (const policy of Array.isArray(policies) ? policies : []) {
    const toRevision = Number(policy?.revision);
    const fromRevision = previousRevision(policy?.rule, toRevision);
    const before = fromRevision ? policy.rule?.[`v${fromRevision}`] : "";
    const after = policy?.rule?.[`v${toRevision}`] ?? "";
    if (!fromRevision || !before || !after) continue;
    const at = policy?.lastChange?.at ?? policy?.history?.find?.((entry) => entry?.rev === toRevision)?.at ?? "";
    entries.push({
      id: `policy:${policy.id}:v${fromRevision}->v${toRevision}`,
      kind: "policy",
      subjectId: policy.id,
      subjectLabel: policy.tag,
      title: policy.lastChange?.text ?? `Policy updated to v${toRevision}`,
      summary: `${policy.scopeLabel ?? policy.scope ?? "Policy"} rule changed from v${fromRevision} to v${toRevision}.`,
      at,
      time: toTime(at),
      badge: `v${fromRevision} -> v${toRevision}`,
      fromRevision,
      toRevision,
      before,
      after,
      beforeLabel: `v${fromRevision}`,
      afterLabel: `v${toRevision} active`,
    });
  }
  return entries
    .sort((left, right) => right.time - left.time)
    .slice(0, limit);
}

function capabilityBlock(capabilities) {
  const list = Array.isArray(capabilities) ? capabilities : [];
  if (list.length === 0) return "capabilities: none";
  return ["capabilities:", ...list.map((capability) => `  - ${capability}`)].join("\n");
}

function capabilitySubject(grant) {
  return grant?.scope ? `${grant.scope} · ${grant.subject}` : grant?.subject;
}

export function buildCapabilityChangeEntries(grants, { limit = 4 } = {}) {
  const entries = [];
  for (const grant of Array.isArray(grants) ? grants : []) {
    if (!grant?.id || !grant?.subject) continue;
    if (grant.issuedAt) {
      entries.push({
        id: `capability:${grant.id}:issued`,
        kind: "capability",
        subjectId: grant.id,
        subjectLabel: capabilitySubject(grant),
        title: `Grant issued: ${grant.id}`,
        summary: `${grant.capabilities?.length ?? 0} delegated capabilit${grant.capabilities?.length === 1 ? "y" : "ies"} became available to this subject.`,
        at: grant.issuedAt,
        time: toTime(grant.issuedAt),
        badge: "issued",
        before: "status: no grant\ncapabilities: none",
        after: `status: active\n${capabilityBlock(grant.capabilities)}`,
        beforeLabel: "before",
        afterLabel: "after issue",
      });
    }
    if (grant.status === "revoked" && grant.revokedAt) {
      entries.push({
        id: `capability:${grant.id}:revoked`,
        kind: "capability",
        subjectId: grant.id,
        subjectLabel: capabilitySubject(grant),
        title: `Grant revoked: ${grant.id}`,
        summary: grant.revokeNote
          ? `Revoked with note: ${grant.revokeNote}`
          : "Delegated capabilities stopped merging into the subject session.",
        at: grant.revokedAt,
        time: toTime(grant.revokedAt),
        badge: "revoked",
        before: `status: active\n${capabilityBlock(grant.capabilities)}`,
        after: `status: revoked\n${capabilityBlock([])}`,
        beforeLabel: "before revoke",
        afterLabel: "after",
      });
    }
  }
  return entries
    .sort((left, right) => right.time - left.time)
    .slice(0, limit);
}

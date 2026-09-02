const FINAL_FUNDED_JOB_STATUSES = new Set(["merged", "closed_unmerged", "open_stale", "reverted"]);

export function cloneJsonRecord(record) {
  return record === undefined ? undefined : JSON.parse(JSON.stringify(record));
}

export function normalizeContentHash(hash) {
  return String(hash ?? "").toLowerCase();
}

export function normalizeFundedJobId(jobId) {
  return String(jobId ?? "");
}

export function timestampScore(value, fallback = Date.now()) {
  return Date.parse(value ?? "") || fallback;
}

export function sliceWindow(records, { limit = 100, offset = 0 } = {}) {
  const start = Math.max(offset, 0);
  return records.slice(start, start + Math.max(limit, 0));
}

export function redisRangeFromLimitOffset(limit = 10, offset = 0) {
  const start = Math.max(offset, 0);
  return {
    start,
    stop: start + Math.max(limit - 1, 0)
  };
}

export function filterFinalFundedJobRecords(records, finalOnly = false) {
  return records.filter((record) => !finalOnly || FINAL_FUNDED_JOB_STATUSES.has(record?.finalStatus));
}

export function listFundedJobRecords(records, { limit = 100, offset = 0, finalOnly = false } = {}) {
  return sliceWindow(
    filterFinalFundedJobRecords([...records], finalOnly).sort((left, right) =>
      String(right.fundedAt ?? right.updatedAt ?? "").localeCompare(String(left.fundedAt ?? left.updatedAt ?? ""))
    ),
    { limit, offset }
  );
}

export function mergeXcmObservationRecord(existing, observation, { now = new Date().toISOString() } = {}) {
  const current = existing ?? {};
  return {
    ...current,
    ...observation,
    observedAt: observation.observedAt ?? current.observedAt ?? now,
    processed: Boolean(observation.processed ?? current.processed),
    attemptCount: Number(observation.attemptCount ?? current.attemptCount ?? 0)
  };
}

export function markXcmObservationProcessedRecord(current, result = undefined, { now = new Date().toISOString() } = {}) {
  if (!current) return undefined;
  return {
    ...current,
    processed: true,
    processedAt: now,
    result,
    lastError: undefined
  };
}

export function markXcmObservationFailedRecord(current, error, { now = new Date().toISOString() } = {}) {
  if (!current) return undefined;
  return {
    ...current,
    processed: false,
    attemptCount: Number(current.attemptCount ?? 0) + 1,
    lastError: error?.message ?? String(error ?? "unknown_error"),
    lastTriedAt: now
  };
}

export function mergeServiceStateRecord(existing, state, { now = new Date().toISOString() } = {}) {
  return {
    ...(existing ?? {}),
    ...state,
    updatedAt: now
  };
}

export function listCapabilityGrantRecords(records, { subject, status, limit = 100, offset = 0 } = {}) {
  const subjectKey = subject ? String(subject).toLowerCase() : undefined;
  return sliceWindow(
    filterCapabilityGrantRecords(records, { status })
      .filter((grant) => {
        if (subjectKey && String(grant.subject ?? "").toLowerCase() !== subjectKey) return false;
        return true;
      })
      .sort((left, right) => String(right.issuedAt ?? "").localeCompare(String(left.issuedAt ?? ""))),
    { limit, offset }
  );
}

export function filterCapabilityGrantRecords(records, { status } = {}) {
  const statusKey = status ? String(status).toLowerCase() : undefined;
  return [...records].filter((record) => {
    if (!record) return false;
    if (statusKey && record.status !== statusKey) return false;
    return true;
  });
}

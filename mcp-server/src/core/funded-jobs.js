export const FUNDED_JOB_STATUSES = Object.freeze({
  OPEN: "open",
  MERGED: "merged",
  CLOSED_UNMERGED: "closed_unmerged",
  OPEN_STALE: "open_stale",
  REVERTED: "reverted"
});

export const FINAL_FUNDED_JOB_STATUSES = new Set([
  FUNDED_JOB_STATUSES.MERGED,
  FUNDED_JOB_STATUSES.CLOSED_UNMERGED,
  FUNDED_JOB_STATUSES.OPEN_STALE,
  FUNDED_JOB_STATUSES.REVERTED
]);

const DEFAULT_GITHUB_DEADLINE_DAYS = 30;
const DEFAULT_WIKIPEDIA_DEADLINE_DAYS = 14;

export function buildFundedJobFromClaim({ job, session, now = new Date() }) {
  const fundedAt = session?.claimedAt ?? now.toISOString();
  return compact({
    jobId: session?.jobId ?? job?.id,
    sessionId: session?.sessionId,
    chainJobId: session?.chainJobId,
    wallet: session?.wallet,
    sourceType: job?.source?.type ?? "manual",
    source: job?.source ? { ...job.source } : undefined,
    rewardAsset: job?.rewardAsset ?? "DOT",
    rewardAmount: finiteNumber(job?.rewardAmount, 0),
    claimStake: finiteNumber(session?.claimStake, 0),
    claimFee: finiteNumber(session?.claimFee, 0),
    totalClaimLock: finiteNumber(session?.totalClaimLock, 0),
    fundedAt,
    claimedAt: session?.claimedAt ?? fundedAt,
    submittedAt: session?.submittedAt,
    finalStatus: FUNDED_JOB_STATUSES.OPEN,
    upstreamStatus: "not_submitted",
    deadlineAt: computeDeadlineAt({ job, session }),
    closeReason: undefined,
    lastPolledAt: undefined,
    updatedAt: now.toISOString()
  });
}

export function updateFundedJobFromSession(existing, { job, session, verification = undefined, now = new Date() }) {
  const upstream = resolveUpstreamFromSession({ job, session, existing });
  const patch = compact({
    jobId: session?.jobId ?? existing?.jobId,
    sessionId: session?.sessionId ?? existing?.sessionId,
    chainJobId: session?.chainJobId ?? existing?.chainJobId,
    wallet: session?.wallet ?? existing?.wallet,
    sourceType: job?.source?.type ?? existing?.sourceType,
    source: job?.source ? { ...job.source } : existing?.source,
    rewardAsset: job?.rewardAsset ?? existing?.rewardAsset,
    rewardAmount: job ? finiteNumber(job.rewardAmount, 0) : existing?.rewardAmount,
    claimStake: session ? finiteNumber(session.claimStake, 0) : existing?.claimStake,
    claimFee: session ? finiteNumber(session.claimFee, 0) : existing?.claimFee,
    totalClaimLock: session ? finiteNumber(session.totalClaimLock, 0) : existing?.totalClaimLock,
    claimedAt: session?.claimedAt ?? existing?.claimedAt,
    submittedAt: session?.submittedAt ?? existing?.submittedAt,
    deadlineAt: computeDeadlineAt({ job, session }) ?? existing?.deadlineAt,
    upstream,
    upstreamStatus: upstream?.kind === "github_pull_request" ? "submitted" : existing?.upstreamStatus,
    verificationOutcome: verification?.outcome ?? session?.verificationSummary?.outcome ?? existing?.verificationOutcome,
    verificationReasonCode: verification?.reasonCode ?? session?.verificationSummary?.reasonCode ?? existing?.verificationReasonCode,
    receiptCount: verification || session?.verificationSummary ? 1 : existing?.receiptCount,
    updatedAt: now.toISOString()
  });
  return normalizeFundedJobRecord({
    ...(existing ?? {}),
    ...patch
  });
}

export function applyUpstreamStatus(record, upstreamStatus, { now = new Date() } = {}) {
  const finalStatus = upstreamStatus.finalStatus ?? record.finalStatus ?? FUNDED_JOB_STATUSES.OPEN;
  return normalizeFundedJobRecord(compact({
    ...record,
    finalStatus,
    upstreamStatus: upstreamStatus.upstreamStatus,
    upstream: upstreamStatus.upstream ?? record.upstream,
    closeReason: upstreamStatus.closeReason ?? record.closeReason,
    upstreamCheckedAt: upstreamStatus.checkedAt ?? now.toISOString(),
    lastPolledAt: now.toISOString(),
    updatedAt: now.toISOString(),
    finalizedAt: FINAL_FUNDED_JOB_STATUSES.has(finalStatus)
      ? (record.finalizedAt ?? now.toISOString())
      : record.finalizedAt
  }));
}

export function summarizeFundedJobs(records, {
  from = undefined,
  to = undefined,
  now = new Date()
} = {}) {
  const windowed = records.filter((record) => withinWindow(record, { from, to }));
  const finalRecords = windowed.filter((record) => FINAL_FUNDED_JOB_STATUSES.has(record.finalStatus));
  const successful = finalRecords.filter((record) => record.finalStatus === FUNDED_JOB_STATUSES.MERGED);
  const closeReasonCounts = new Map();
  for (const record of finalRecords) {
    if (record.finalStatus === FUNDED_JOB_STATUSES.MERGED) continue;
    const reason = record.closeReason || record.finalStatus || "unknown";
    closeReasonCounts.set(reason, (closeReasonCounts.get(reason) ?? 0) + 1);
  }
  const totalReserved = sum(windowed.map((record) => finiteNumber(record.rewardAmount, 0)));
  const confirmedPayout = sum(successful.map((record) => finiteNumber(record.rewardAmount, 0)));
  return {
    generatedAt: now.toISOString(),
    window: {
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined
    },
    totalFundedJobs: windowed.length,
    finalJobs: finalRecords.length,
    successfulJobs: successful.length,
    mergeRate: finalRecords.length ? successful.length / finalRecords.length : null,
    totalReserved,
    confirmedPayout,
    totalReceipts: windowed.reduce((accumulator, record) => accumulator + finiteNumber(record.receiptCount, 0), 0),
    statuses: countBy(windowed, (record) => record.finalStatus ?? FUNDED_JOB_STATUSES.OPEN),
    sourceTypes: countBy(windowed, (record) => record.sourceType ?? "unknown"),
    topCloseReasons: [...closeReasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))
      .slice(0, 3)
  };
}

export function normalizeFundedJobRecord(record) {
  return compact({
    ...record,
    rewardAmount: finiteNumber(record?.rewardAmount, 0),
    claimStake: finiteNumber(record?.claimStake, 0),
    claimFee: finiteNumber(record?.claimFee, 0),
    totalClaimLock: finiteNumber(record?.totalClaimLock, 0),
    finalStatus: FINAL_FUNDED_JOB_STATUSES.has(record?.finalStatus)
      ? record.finalStatus
      : record?.finalStatus === FUNDED_JOB_STATUSES.OPEN
        ? FUNDED_JOB_STATUSES.OPEN
        : FUNDED_JOB_STATUSES.OPEN,
    updatedAt: record?.updatedAt ?? new Date().toISOString()
  });
}

export function isFinalFundedJob(record) {
  return FINAL_FUNDED_JOB_STATUSES.has(record?.finalStatus);
}

function resolveUpstreamFromSession({ job, session, existing }) {
  const source = job?.source ?? existing?.source;
  const submission = session?.submission?.structured ?? session?.submission;
  const prUrl = firstText(
    submission?.prUrl,
    submission?.pullRequestUrl,
    findGithubPullRequestUrl(JSON.stringify(submission ?? "")),
    existing?.upstream?.url
  );
  const parsedPr = parseGithubPullRequestUrl(prUrl);
  if (parsedPr) {
    return {
      kind: "github_pull_request",
      url: prUrl,
      repo: parsedPr.repo,
      owner: parsedPr.owner,
      name: parsedPr.name,
      pullNumber: parsedPr.pullNumber,
      issueNumber: source?.type === "github_issue" ? Number(source.issueNumber) : undefined
    };
  }

  if (source?.type === "wikipedia_article") {
    const editRevisionId = firstText(
      submission?.editRevisionId,
      submission?.publishedRevisionId,
      existing?.upstream?.editRevisionId
    );
    return compact({
      kind: "mediawiki_revision",
      project: source.project ?? "wikipedia",
      language: source.language,
      pageId: source.pageId,
      pageTitle: source.pageTitle,
      pageUrl: source.pageUrl,
      reviewRevisionId: source.revisionId,
      editRevisionId,
      proposalOnly: !editRevisionId
    });
  }

  return existing?.upstream;
}

function computeDeadlineAt({ job, session }) {
  const sourceType = job?.source?.type;
  const submittedAt = session?.submittedAt;
  const base = submittedAt ?? session?.claimedAt;
  if (!base) return undefined;
  const days = sourceType === "wikipedia_article"
    ? DEFAULT_WIKIPEDIA_DEADLINE_DAYS
    : sourceType === "github_issue"
      ? DEFAULT_GITHUB_DEADLINE_DAYS
      : undefined;
  if (!days) return undefined;
  return addDays(base, days).toISOString();
}

function withinWindow(record, { from, to }) {
  const timestamp = Date.parse(record?.fundedAt ?? record?.claimedAt ?? record?.updatedAt ?? "");
  if (!Number.isFinite(timestamp)) return false;
  if (from && timestamp < Date.parse(from)) return false;
  if (to && timestamp > Date.parse(to)) return false;
  return true;
}

function addDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function sum(values) {
  return values.reduce((accumulator, value) => accumulator + value, 0);
}

function countBy(records, selector) {
  const counts = {};
  for (const record of records) {
    const key = selector(record);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() ?? "";
}

function findGithubPullRequestUrl(text) {
  return String(text ?? "").match(/https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/pull\/\d+/iu)?.[0] ?? "";
}

export function parseGithubPullRequestUrl(url) {
  const match = String(url ?? "").trim().match(/^https:\/\/github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/iu);
  if (!match) return undefined;
  return {
    owner: match[1],
    name: match[2],
    repo: `${match[1]}/${match[2]}`.toLowerCase(),
    pullNumber: Number(match[3])
  };
}

function compact(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

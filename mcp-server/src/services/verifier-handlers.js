import { extractSubmissionText } from "../core/submission.js";
import { hasAverrayDisclosureFooter } from "../core/maintainer-surface-policy.js";

const HANDLER_VERSION = 1;

function normalizeEvidence(input) {
  return extractSubmissionText(input).trim().toLowerCase();
}

function structuredEvidence(input) {
  if (input?.kind === "structured" && input.structured && typeof input.structured === "object") {
    return input.structured;
  }
  if (input?.structured && typeof input.structured === "object") {
    return input.structured;
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input;
  }
  return {};
}

function createBenchmarkHandler() {
  return {
    id: "benchmark",
    evaluate(job, evidence) {
      const normalized = normalizeEvidence(evidence);
      const matched = job.verifierConfig.requiredKeywords.filter((keyword) => normalized.includes(keyword.toLowerCase()));
      const approved = matched.length >= job.verifierConfig.minimumMatches;

      return {
        jobId: job.id,
        handler: "benchmark",
        handlerVersion: HANDLER_VERSION,
        outcome: approved ? "approved" : "rejected",
        score: Math.round((matched.length / Math.max(job.verifierConfig.requiredKeywords.length, 1)) * 100),
        reasonCode: approved ? "BENCHMARK_THRESHOLD_MET" : "BENCHMARK_THRESHOLD_MISSED",
        detail: `Matched ${matched.length}/${job.verifierConfig.requiredKeywords.length} required keywords.`
      };
    }
  };
}

function createDeterministicHandler() {
  return {
    id: "deterministic",
    evaluate(job, evidence) {
      const normalized = normalizeEvidence(evidence);
      const expected = job.verifierConfig.expectedOutputs.map((value) => value.toLowerCase());
      const approved = job.verifierConfig.matchMode === "exact"
        ? expected.includes(normalized)
        : expected.every((value) => normalized.includes(value));

      return {
        jobId: job.id,
        handler: "deterministic",
        handlerVersion: HANDLER_VERSION,
        outcome: approved ? "approved" : "rejected",
        score: approved ? 100 : 0,
        reasonCode: approved ? "DETERMINISTIC_MATCH" : "DETERMINISTIC_MISMATCH",
        detail: approved
          ? `Submission satisfied ${job.verifierConfig.matchMode} deterministic checks.`
          : `Submission failed ${job.verifierConfig.matchMode} deterministic checks.`
      };
    }
  };
}

function createHumanFallbackHandler() {
  return {
    id: "human_fallback",
    evaluate(job) {
      return {
        jobId: job.id,
        handler: "human_fallback",
        handlerVersion: HANDLER_VERSION,
        outcome: job.verifierConfig.autoApprove ? "approved" : "disputed",
        score: job.verifierConfig.autoApprove ? 100 : 0,
        reasonCode: job.verifierConfig.autoApprove ? "HUMAN_FALLBACK_AUTO_APPROVE" : "HUMAN_REVIEW_REQUIRED",
        detail: job.verifierConfig.escalationMessage
      };
    }
  };
}

function createGithubPrHandler({ fetchImpl = globalThis.fetch, githubToken = process.env.GITHUB_TOKEN, githubApiBaseUrl = "https://api.github.com" } = {}) {
  return {
    id: "github_pr",
    async evaluate(job, evidence) {
      const normalized = normalizeEvidence(evidence);
      const structured = structuredEvidence(evidence);
      const prUrl = firstNonEmptyString(structured.prUrl, structured.pullRequestUrl, findGithubPullRequestUrl(normalized));
      const parsedPr = parseGithubPullRequestUrl(prUrl);
      const expectedRepo = normalizeRepo(job.source?.repo);
      const expectedIssueNumber = Number(job.source?.issueNumber);
      const issueReferenceRequired = job.verifierConfig?.requireIssueReference !== false;
      const testEvidenceRequired = job.verifierConfig?.requireTestEvidence !== false;
      const acceptMergedAsApproved = job.verifierConfig?.acceptMergedAsApproved !== false;
      const disclosureRequired = job.source?.maintainerPolicy?.disclosureRequired === true;
      const submittedIssueReferenced = referencesIssue({
        structured,
        normalized,
        issueNumber: expectedIssueNumber,
        issueUrl: job.source?.issueUrl
      });
      const submittedTestEvidence = hasTestEvidence(structured, normalized);
      const submittedChecksPassing = structured.checksPassing === true || structured.ciStatus === "passing";
      const submittedReviewApproved = structured.reviewApproved === true;
      const submittedMerged = structured.merged === true;
      const submittedPrBody = firstNonEmptyString(structured.prBody, structured.pullRequestBody);
      const submittedDisclosureFooterPresent = hasAverrayDisclosureFooter(submittedPrBody);
      const githubLookup = parsedPr && hasUsableGithubToken(githubToken) && typeof fetchImpl === "function"
        ? await fetchGithubPullRequestSnapshot({
            parsedPr,
            issueNumber: expectedIssueNumber,
            issueUrl: job.source?.issueUrl,
            fetchImpl,
            githubToken,
            githubApiBaseUrl
          })
        : {
            status: parsedPr ? "skipped" : "not_applicable",
            reason: parsedPr ? "github_token_not_configured" : "invalid_or_missing_pr_url"
          };
      const githubVerified = githubLookup.status === "verified";

      const repoMatches = Boolean(parsedPr && expectedRepo && parsedPr.repo === expectedRepo);
      const issueReferenced = githubVerified ? (githubLookup.issueReferenced || submittedIssueReferenced) : submittedIssueReferenced;
      const checksPassing = githubVerified ? githubLookup.checksPassing : submittedChecksPassing;
      const reviewApproved = githubVerified ? githubLookup.reviewApproved : submittedReviewApproved;
      const merged = githubVerified ? githubLookup.merged : submittedMerged;
      const disclosureFooterObservable = githubVerified || Boolean(submittedPrBody);
      const disclosureFooterPresent = githubVerified
        ? githubLookup.disclosureFooterPresent
        : submittedDisclosureFooterPresent;
      const testEvidenceSubmitted = submittedTestEvidence || checksPassing || merged;
      const summarySubmitted = hasText(structured.summary) || hasText(structured.output) || Boolean(githubLookup.title);

      const checks = {
        prUrlPresent: Boolean(prUrl),
        prUrlValid: Boolean(parsedPr),
        repoMatches,
        issueReferenced,
        summarySubmitted,
        testEvidenceSubmitted,
        checksPassing,
        reviewApproved,
        merged,
        disclosureFooterPresent: !disclosureRequired || !disclosureFooterObservable || disclosureFooterPresent
      };
      const signals = {
        attempted: true,
        prOpened: checks.prUrlValid && repoMatches,
        issueReferenced,
        testEvidenceSubmitted,
        checksPassed: checksPassing,
        maintainerApproved: reviewApproved,
        merged
      };
      const mergedAccepted = acceptMergedAsApproved && merged && checks.prUrlValid && repoMatches && issueReferenced;
      const score = mergedAccepted ? Math.max(scoreGithubPrEvidence(checks), 95) : scoreGithubPrEvidence(checks);
      const minimumScore = Number(job.verifierConfig?.minimumScore ?? 60);
      const blockers = [];

      if (!checks.prUrlValid) blockers.push("valid GitHub pull request URL");
      if (!repoMatches) blockers.push(`PR repo must match ${job.source?.repo ?? "the source repo"}`);
      if (issueReferenceRequired && !issueReferenced) blockers.push(`submission must reference issue #${expectedIssueNumber}`);
      if (testEvidenceRequired && !testEvidenceSubmitted && !mergedAccepted) blockers.push("test or docs-build evidence");
      if (disclosureRequired && disclosureFooterObservable && !disclosureFooterPresent) {
        blockers.push("Averray disclosure footer");
      }

      const approved = score >= minimumScore && blockers.length === 0;
      return {
        jobId: job.id,
        handler: "github_pr",
        handlerVersion: HANDLER_VERSION,
        outcome: approved ? "approved" : "rejected",
        score,
        reasonCode: approved ? "GITHUB_PR_EVIDENCE_ACCEPTED" : "GITHUB_PR_EVIDENCE_INCOMPLETE",
        detail: approved
          ? `GitHub PR evidence reached ${score}/100 without required blockers.`
          : `GitHub PR evidence reached ${score}/100; missing ${blockers.join(", ") || "minimum score"}.`,
        evidence: {
          prUrl: prUrl || null,
          repo: parsedPr?.repo ?? null,
          pullNumber: parsedPr?.pullNumber ?? null,
          expectedRepo: expectedRepo || null,
          expectedIssueNumber: Number.isFinite(expectedIssueNumber) ? expectedIssueNumber : null,
          disclosureRequired
        },
        githubLookup,
        checks,
        signals,
        reputationSignals: {
          category: job.category,
          attempted: 1,
          prOpened: signals.prOpened ? 1 : 0,
          checksPassed: signals.checksPassed ? 1 : 0,
          maintainerApproved: signals.maintainerApproved ? 1 : 0,
          merged: signals.merged ? 1 : 0
        }
      };
    }
  };
}

export class VerifierRegistry {
  constructor(options = {}) {
    this.handlers = new Map([
      ["benchmark", createBenchmarkHandler()],
      ["deterministic", createDeterministicHandler()],
      ["human_fallback", createHumanFallbackHandler()],
      ["github_pr", createGithubPrHandler(options)]
    ]);
  }

  listHandlers() {
    return [...this.handlers.keys()];
  }

  async evaluate(job, evidence) {
    const handlerId = job.verifierConfig.handler;
    const handler = this.handlers.get(handlerId);
    if (!handler) {
      throw new Error(`No verifier handler registered for ${handlerId}`);
    }
    return handler.evaluate(job, evidence);
  }
}

function firstNonEmptyString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() ?? "";
}

function findGithubPullRequestUrl(text) {
  return String(text ?? "").match(/https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/pull\/\d+/iu)?.[0] ?? "";
}

function parseGithubPullRequestUrl(url) {
  const match = String(url ?? "").trim().match(/^https:\/\/github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/iu);
  if (!match) {
    return undefined;
  }
  return {
    owner: match[1],
    name: match[2],
    repo: normalizeRepo(`${match[1]}/${match[2]}`),
    pullNumber: Number(match[3])
  };
}

async function fetchGithubPullRequestSnapshot({
  parsedPr,
  issueNumber,
  issueUrl,
  fetchImpl,
  githubToken,
  githubApiBaseUrl
}) {
  const baseUrl = String(githubApiBaseUrl ?? "https://api.github.com").replace(/\/+$/u, "");
  const repoPath = `${encodeURIComponent(parsedPr.owner)}/${encodeURIComponent(parsedPr.name)}`;
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "averray-github-pr-verifier"
  };
  if (hasUsableGithubToken(githubToken)) {
    headers.authorization = `Bearer ${githubToken}`;
  }

  try {
    const pr = await fetchGithubJson(fetchImpl, `${baseUrl}/repos/${repoPath}/pulls/${parsedPr.pullNumber}`, { headers });
    const headSha = typeof pr?.head?.sha === "string" ? pr.head.sha : "";
    const title = typeof pr?.title === "string" ? pr.title : "";
    const body = typeof pr?.body === "string" ? pr.body : "";
    const htmlUrl = typeof pr?.html_url === "string" ? pr.html_url : "";
    const prText = `${title}\n${body}\n${htmlUrl}`.toLowerCase();
    const [statusResult, checkRunsResult, reviewsResult] = headSha
      ? await Promise.allSettled([
          fetchGithubJson(fetchImpl, `${baseUrl}/repos/${repoPath}/commits/${headSha}/status`, { headers }),
          fetchGithubJson(fetchImpl, `${baseUrl}/repos/${repoPath}/commits/${headSha}/check-runs`, { headers }),
          fetchGithubJson(fetchImpl, `${baseUrl}/repos/${repoPath}/pulls/${parsedPr.pullNumber}/reviews`, { headers })
        ])
      : [];

    const combinedStatus = statusResult?.status === "fulfilled" ? statusResult.value : undefined;
    const checkRuns = checkRunsResult?.status === "fulfilled" ? checkRunsResult.value : undefined;
    const reviews = reviewsResult?.status === "fulfilled" ? reviewsResult.value : undefined;
    const checkSummary = summarizeGithubChecks(combinedStatus, checkRuns);
    const reviewSummary = summarizeGithubReviews(reviews);

    return {
      status: "verified",
      htmlUrl,
      repo: parsedPr.repo,
      pullNumber: parsedPr.pullNumber,
      title,
      state: typeof pr?.state === "string" ? pr.state : "unknown",
      merged: Boolean(pr?.merged),
      headSha: headSha || null,
      issueReferenced: referencesIssue({
        structured: {},
        normalized: prText,
        issueNumber,
        issueUrl
      }),
      checksPassing: checkSummary.checksPassing,
      ciStatus: checkSummary.ciStatus,
      reviewApproved: reviewSummary.reviewApproved,
      reviewState: reviewSummary.reviewState,
      disclosureFooterPresent: hasAverrayDisclosureFooter(body),
      partial: {
        status: statusResult?.status === "rejected" ? "unavailable" : "available",
        checkRuns: checkRunsResult?.status === "rejected" ? "unavailable" : "available",
        reviews: reviewsResult?.status === "rejected" ? "unavailable" : "available"
      }
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error?.message ?? "github_lookup_failed"
    };
  }
}

async function fetchGithubJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  if (!response?.ok) {
    throw new Error(`github_api_${response?.status ?? "error"}`);
  }
  return response.json();
}

function summarizeGithubChecks(combinedStatus, checkRuns) {
  if (Array.isArray(checkRuns?.check_runs) && checkRuns.check_runs.length > 0) {
    const terminalOk = new Set(["success", "neutral", "skipped"]);
    const allCompleted = checkRuns.check_runs.every((run) => run.status === "completed");
    const allOk = checkRuns.check_runs.every((run) => terminalOk.has(run.conclusion));
    return {
      checksPassing: allCompleted && allOk,
      ciStatus: allCompleted && allOk ? "passing" : "pending"
    };
  }
  if (combinedStatus?.state === "success") {
    return { checksPassing: true, ciStatus: "passing" };
  }
  if (combinedStatus?.state === "failure" || combinedStatus?.state === "error") {
    return { checksPassing: false, ciStatus: "failing" };
  }
  return { checksPassing: false, ciStatus: "unknown" };
}

function summarizeGithubReviews(reviews) {
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return { reviewApproved: false, reviewState: "none" };
  }
  const latestByReviewer = new Map();
  for (const review of reviews) {
    const reviewer = String(review?.user?.login ?? "").toLowerCase();
    const state = String(review?.state ?? "").toUpperCase();
    if (!reviewer || !state) {
      continue;
    }
    latestByReviewer.set(reviewer, state);
  }
  const latestStates = [...latestByReviewer.values()];
  if (latestStates.includes("CHANGES_REQUESTED")) {
    return { reviewApproved: false, reviewState: "changes_requested" };
  }
  if (latestStates.includes("APPROVED")) {
    return { reviewApproved: true, reviewState: "approved" };
  }
  return { reviewApproved: false, reviewState: "reviewed" };
}

function normalizeRepo(repo) {
  const normalized = String(repo ?? "").trim().toLowerCase();
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u.test(normalized) ? normalized : "";
}

function hasUsableGithubToken(token) {
  const value = String(token ?? "").trim();
  return Boolean(value && !value.startsWith("your_") && value !== "ghp_your_actual_token_here");
}

function referencesIssue({ structured, normalized, issueNumber, issueUrl }) {
  if (structured.referencesIssue === true) {
    return true;
  }
  if (Number.isFinite(issueNumber) && Number(structured.issueNumber) === issueNumber) {
    return true;
  }
  const issueRef = Number.isFinite(issueNumber) ? `#${issueNumber}` : "";
  const issueUrlText = typeof issueUrl === "string" ? issueUrl.toLowerCase() : "";
  return Boolean(
    issueRef && normalized.includes(issueRef.toLowerCase())
      || (issueUrlText && normalized.includes(issueUrlText))
  );
}

function hasTestEvidence(structured, normalized) {
  if (hasText(structured.tests) || hasText(structured.testOutput)) {
    return true;
  }
  return /\b(test|tests|lint|build|docs build|ci)\b/u.test(normalized)
    && /\b(pass|passed|passing|ok|success|green)\b/u.test(normalized);
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function scoreGithubPrEvidence(checks) {
  let score = 0;
  if (checks.prUrlValid) score += 25;
  if (checks.repoMatches) score += 15;
  if (checks.issueReferenced) score += 15;
  if (checks.summarySubmitted) score += 10;
  if (checks.testEvidenceSubmitted) score += 15;
  if (checks.checksPassing) score += 10;
  if (checks.reviewApproved) score += 5;
  if (checks.merged) score += 5;
  return Math.min(score, 100);
}

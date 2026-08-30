import { extractSubmissionText } from "../core/submission.js";
import {
  hasAverrayDisclosureFooter,
  inspectAverrayClaimantBinding
} from "../core/maintainer-surface-policy.js";
import { getJobSchema } from "../core/job-schema-registry.js";
import { normalizeWhitespace } from "../core/evidence-normalization.js";

const HANDLER_VERSION = 1;
const BENCHMARK_HANDLER_VERSION = 2;

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

export class BenchmarkEvidenceUnavailableError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "BenchmarkEvidenceUnavailableError";
    this.code = "BENCHMARK_PINNED_REVISION_UNAVAILABLE";
    this.outcome = "inconclusive";
    this.workerConsequence = "none";
  }
}

function createBenchmarkHandler({ fetchImpl = globalThis.fetch } = {}) {
  return {
    id: "benchmark",
    version: BENCHMARK_HANDLER_VERSION,
    evaluate(job, evidence) {
      const normalized = normalizeEvidence(evidence);
      const outputSchema = getJobSchema(job.outputSchemaRef, { registrations: job.schemaRegistrations });
      const schemaFields = new Set(
        Object.keys(outputSchema?.properties ?? {}).map((field) => field.toLowerCase())
      );
      const substantiveKeywords = job.verifierConfig.requiredKeywords.filter(
        (keyword) => !schemaFields.has(keyword.toLowerCase())
      );
      if (substantiveKeywords.length < job.verifierConfig.minimumMatches) {
        return {
          jobId: job.id,
          handler: "benchmark",
          handlerVersion: BENCHMARK_HANDLER_VERSION,
          outcome: "rejected",
          score: 0,
          reasonCode: "BENCHMARK_CONFIG_UNSAFE",
          detail: "Benchmark configuration does not contain enough substantive keywords beyond output-schema field names."
        };
      }
      const matched = substantiveKeywords.filter((keyword) => normalized.includes(keyword.toLowerCase()));
      const approved = matched.length >= job.verifierConfig.minimumMatches;

      const thresholdVerdict = {
        jobId: job.id,
        handler: "benchmark",
        handlerVersion: BENCHMARK_HANDLER_VERSION,
        outcome: approved ? "approved" : "rejected",
        score: Math.round((matched.length / substantiveKeywords.length) * 100),
        reasonCode: approved ? "BENCHMARK_THRESHOLD_MET" : "BENCHMARK_THRESHOLD_MISSED",
        detail: `Matched ${matched.length}/${substantiveKeywords.length} substantive required keywords.`
      };
      if (!job.verifierConfig.anchorEvidence || !approved) {
        return thresholdVerdict;
      }
      return evaluateWikipediaRevisionAnchors({
        job,
        evidence,
        thresholdVerdict,
        fetchImpl
      });
    }
  };
}

async function evaluateWikipediaRevisionAnchors({ job, evidence, thresholdVerdict, fetchImpl }) {
  const anchor = job.verifierConfig.anchorEvidence;
  let wikitext;
  try {
    wikitext = await fetchWikipediaRevisionWikitext(anchor, fetchImpl);
  } catch (error) {
    if (error instanceof BenchmarkEvidenceUnavailableError) throw error;
    throw new BenchmarkEvidenceUnavailableError(
      `Pinned Wikipedia revision ${anchor.revisionId} could not be read; verification remains pending.`,
      { cause: error }
    );
  }

  const normalizedWikitext = normalizeWhitespace(wikitext);
  const anchors = wikipediaReportAnchors(structuredEvidence(evidence));
  const unsupported = anchors.find(({ value }) =>
    !normalizedWikitext.includes(normalizeWhitespace(value))
  );
  if (unsupported) {
    return {
      ...thresholdVerdict,
      outcome: "rejected",
      score: 0,
      reasonCode: "BENCHMARK_REVISION_ANCHOR_MISMATCH",
      detail: `Submitted ${unsupported.kind} at ${unsupported.path} does not appear in the pinned revision after whitespace normalization.`
    };
  }
  return {
    ...thresholdVerdict,
    reasonCode: "BENCHMARK_REVISION_ANCHORS_MET",
    detail: `${thresholdVerdict.detail} All ${anchors.length} submitted URL and quote anchors appear in the pinned revision after whitespace normalization.`
  };
}

async function fetchWikipediaRevisionWikitext(anchor, fetchImpl) {
  if (anchor?.kind !== "wikipedia_revision_wikitext" || typeof fetchImpl !== "function") {
    throw new BenchmarkEvidenceUnavailableError("Pinned Wikipedia revision fetch is unavailable; verification remains pending.");
  }
  const url = new URL(`https://${anchor.language}.wikipedia.org/w/api.php`);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("prop", "revisions");
  url.searchParams.set("rvprop", "ids|content");
  url.searchParams.set("rvslots", "main");
  url.searchParams.set("revids", anchor.revisionId);
  url.searchParams.set("origin", "*");

  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        "user-agent": "averray-benchmark-verifier/1.0"
      }
    });
  } catch (error) {
    throw new BenchmarkEvidenceUnavailableError(
      `Pinned Wikipedia revision ${anchor.revisionId} could not be fetched; verification remains pending.`,
      { cause: error }
    );
  }
  if (!response?.ok) {
    throw new BenchmarkEvidenceUnavailableError(
      `Pinned Wikipedia revision ${anchor.revisionId} returned HTTP ${response?.status ?? "unknown"}; verification remains pending.`
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new BenchmarkEvidenceUnavailableError(
      `Pinned Wikipedia revision ${anchor.revisionId} returned unreadable JSON; verification remains pending.`,
      { cause: error }
    );
  }
  const page = Array.isArray(payload?.query?.pages)
    ? payload.query.pages[0]
    : Object.values(payload?.query?.pages ?? {})[0];
  const revision = page?.revisions?.[0];
  const returnedRevisionId = String(revision?.revid ?? "");
  const content = revision?.slots?.main?.content ?? revision?.slots?.main?.["*"] ?? revision?.["*"];
  if (returnedRevisionId !== anchor.revisionId || typeof content !== "string") {
    throw new BenchmarkEvidenceUnavailableError(
      `Pinned Wikipedia revision ${anchor.revisionId} was absent from the response; verification remains pending.`
    );
  }
  return content;
}

function wikipediaReportAnchors(report) {
  const anchors = [];
  for (const [index, finding] of (report.citation_findings ?? []).entries()) {
    anchors.push({ kind: "quote", path: `citation_findings[${index}].source_quote`, value: finding.source_quote });
    anchors.push({ kind: "URL", path: `citation_findings[${index}].evidence_url`, value: finding.evidence_url });
  }
  for (const [index, change] of (report.proposed_changes ?? []).entries()) {
    anchors.push({ kind: "URL", path: `proposed_changes[${index}].source_url`, value: change.source_url });
  }
  return anchors;
}

const FETCHABLE_OPEN_DATA_EVIDENCE_METHOD = "fetchable_open_data_evidence";

function createDeterministicHandler({ fetchImpl = globalThis.fetch } = {}) {
  return {
    id: "deterministic",
    version: HANDLER_VERSION,
    async evaluate(job, evidence) {
      const normalized = normalizeEvidence(evidence);
      const expected = job.verifierConfig.expectedOutputs.map((value) => value.toLowerCase());
      const approved = job.verifierConfig.matchMode === "exact"
        ? expected.includes(normalized)
        : expected.every((value) => normalized.includes(value));

      if (!approved || !requiresFetchableOpenDataEvidence(job)) {
        return deterministicThresholdVerdict(job, approved);
      }

      return evaluateFetchableOpenDataEvidence({ job, evidence, fetchImpl });
    }
  };
}

function deterministicThresholdVerdict(job, approved) {
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

function requiresFetchableOpenDataEvidence(job) {
  return job?.source?.type === "open_data_dataset"
    && job?.verification?.method === FETCHABLE_OPEN_DATA_EVIDENCE_METHOD;
}

async function evaluateFetchableOpenDataEvidence({ job, evidence, fetchImpl }) {
  const structured = structuredEvidence(evidence);
  const targets = [
    { field: "dataset_url", expectedUrl: job.source?.datasetUrl },
    { field: "resource_url", expectedUrl: job.source?.resourceUrl }
  ];
  const mismatched = targets.find(({ field, expectedUrl }) => (
    !isPinnedPublicHttpsUrl(expectedUrl)
    || String(structured?.[field] ?? "").trim() !== String(expectedUrl).trim()
  ));
  if (mismatched) {
    return {
      jobId: job.id,
      handler: "deterministic",
      handlerVersion: HANDLER_VERSION,
      outcome: "rejected",
      score: 0,
      reasonCode: "DETERMINISTIC_FETCH_EVIDENCE_MISMATCH",
      detail: `${mismatched.field} must exactly match the operator-pinned public evidence URL.`
    };
  }

  if (typeof fetchImpl !== "function") {
    return fetchableEvidenceRejection(job, "The deterministic evidence fetcher is unavailable.");
  }

  for (const { field, expectedUrl } of targets) {
    let response;
    try {
      response = await fetchImpl(expectedUrl, {
        method: "GET",
        // Refuse redirects so an operator-pinned public URL cannot be turned
        // into a backend-network probe after the job snapshot is committed.
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          accept: field === "resource_url" ? "*/*" : "text/html,application/json;q=0.9,*/*;q=0.8",
          range: "bytes=0-1023",
          "user-agent": "averray-open-data-verifier/1.0"
        }
      });
    } catch (error) {
      return fetchableEvidenceRejection(
        job,
        `${field} could not be fetched: ${boundedErrorMessage(error)}`
      );
    }
    try {
      if (!response?.ok) {
        return fetchableEvidenceRejection(
          job,
          `${field} returned HTTP ${response?.status ?? "unknown"}.`
        );
      }
    } finally {
      try {
        await response?.body?.cancel?.();
      } catch {
        // The status already establishes reachability; draining/cancelling a
        // provider-specific response body is best-effort cleanup only.
      }
    }
  }

  return {
    jobId: job.id,
    handler: "deterministic",
    handlerVersion: HANDLER_VERSION,
    outcome: "approved",
    score: 100,
    reasonCode: "DETERMINISTIC_FETCH_EVIDENCE_VERIFIED",
    detail: "Submission matched both pinned open-data URLs and both public evidence targets fetched successfully."
  };
}

function fetchableEvidenceRejection(job, detail) {
  return {
    jobId: job.id,
    handler: "deterministic",
    handlerVersion: HANDLER_VERSION,
    outcome: "rejected",
    score: 0,
    reasonCode: "DETERMINISTIC_FETCH_EVIDENCE_UNREACHABLE",
    detail
  };
}

function isPinnedPublicHttpsUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]).has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function boundedErrorMessage(error) {
  return String(error?.message ?? error ?? "unknown fetch error").slice(0, 300);
}

function createHumanFallbackHandler() {
  return {
    id: "human_fallback",
    version: HANDLER_VERSION,
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
    version: HANDLER_VERSION,
    async evaluate(job, evidence, verificationContext = {}) {
      const normalized = normalizeEvidence(evidence);
      const structured = structuredEvidence(evidence);
      const prUrl = firstNonEmptyString(structured.prUrl, structured.pullRequestUrl, findGithubPullRequestUrl(normalized));
      const parsedPr = parseGithubPullRequestUrl(prUrl);
      const githubSource = githubSourceForJob(job);
      const expectedRepo = normalizeRepo(githubSource?.repo);
      const expectedIssueNumber = Number(githubSource?.issueNumber);
      const issueReferenceRequired = job.verifierConfig?.requireIssueReference !== false;
      const testEvidenceRequired = job.verifierConfig?.requireTestEvidence !== false;
      const acceptMergedAsApproved = job.verifierConfig?.acceptMergedAsApproved !== false;
      const claimantBindingRequired = job.verifierConfig?.requireClaimantBinding === true;
      const disclosureRequired = githubSource?.maintainerPolicy?.disclosureRequired === true;
      const submittedIssueReferenced = referencesIssue({
        structured,
        normalized,
        issueNumber: expectedIssueNumber,
        issueUrl: githubSource?.issueUrl
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
            issueUrl: githubSource?.issueUrl,
            fetchImpl,
            githubToken,
            githubApiBaseUrl,
            claimantWallet: verificationContext.claimantWallet,
            claimSessionId: verificationContext.claimSessionId
          })
        : {
            status: parsedPr ? "skipped" : "not_applicable",
            reason: parsedPr ? "github_token_not_configured" : "invalid_or_missing_pr_url"
          };
      const githubVerified = githubLookup.status === "verified";
      const claimantBinding = githubVerified
        ? githubLookup.claimantBinding
        : { status: "unavailable" };
      const claimantBindingObservable = githubVerified && githubLookup.prBodyReadable === true;
      const claimantBindingMatches = claimantBinding?.status === "matched";

      const repoMatches = Boolean(parsedPr && expectedRepo && parsedPr.repo === expectedRepo);
      const issueReferenced = githubVerified ? githubLookup.issueReferenced : submittedIssueReferenced;
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
        disclosureFooterPresent: !disclosureRequired || !disclosureFooterObservable || disclosureFooterPresent,
        claimantBinding: !claimantBindingRequired || claimantBindingMatches
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
      if (!repoMatches) blockers.push(`PR repo must match ${githubSource?.repo ?? "the source repo"}`);
      if (issueReferenceRequired && !issueReferenced) blockers.push(`submission must reference issue #${expectedIssueNumber}`);
      if (testEvidenceRequired && !testEvidenceSubmitted && !mergedAccepted) blockers.push("test or docs-build evidence");
      if (githubVerified && githubLookup.ciStatus === "failing" && !mergedAccepted) {
        blockers.push("live GitHub checks must pass");
      }
      if (disclosureRequired && disclosureFooterObservable && !disclosureFooterPresent) {
        blockers.push("Averray disclosure footer");
      }
      if (
        claimantBindingRequired
        && claimantBindingObservable
        && ["missing", "mismatched"].includes(claimantBinding?.status)
      ) {
        blockers.push(claimantBinding.status === "mismatched"
          ? "Averray disclosure claimant must match the actual claimant wallet or claim session"
          : "Averray disclosure must identify the actual claimant wallet or claim session");
      }

      const githubEvidenceUnavailable = githubLookup.status !== "verified";
      const githubEvidencePartial = Object.values(githubLookup.partial ?? {}).includes("unavailable");
      const claimantBindingUnverified = claimantBindingRequired
        && (!claimantBindingObservable || claimantBinding?.status === "claimant_context_missing");
      const scoreAmbiguous = score < minimumScore && blockers.length === 0;
      const definiteClaimantFailure = claimantBindingRequired
        && claimantBindingObservable
        && ["missing", "mismatched"].includes(claimantBinding?.status);
      const definiteInputFailure = !checks.prUrlValid || !repoMatches || definiteClaimantFailure;

      // A malformed or cross-repository submission is directly observable and
      // remains a rejection. Every inability to re-derive the PR against live
      // GitHub is different: it must enter human review, never reuse submitted
      // claims as sufficient evidence for an automatic payout.
      if (!definiteInputFailure && (
        githubEvidenceUnavailable
        || githubEvidencePartial
        || claimantBindingUnverified
        || scoreAmbiguous
      )) {
        return githubPrHumanReviewEscalation({
          job,
          score,
          githubLookup,
          checks,
          signals,
          evidence: {
            prUrl: prUrl || null,
            repo: parsedPr?.repo ?? null,
            pullNumber: parsedPr?.pullNumber ?? null,
            expectedRepo: expectedRepo || null,
            expectedIssueNumber: Number.isFinite(expectedIssueNumber) ? expectedIssueNumber : null,
            disclosureRequired,
            claimantBindingRequired,
            claimantBindingStatus: claimantBinding?.status ?? "unavailable"
          },
          reason: githubEvidenceUnavailable
            ? githubLookup.reason ?? "github_lookup_unavailable"
            : githubEvidencePartial
              ? "github_lookup_partial"
              : claimantBindingUnverified
                ? `github_pr_body_claimant_binding_${claimantBinding?.status ?? "unavailable"}`
                : "github_score_ambiguous"
        });
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
          disclosureRequired,
          claimantBindingRequired,
          claimantBindingStatus: claimantBinding?.status ?? "not_required"
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
      ["benchmark", createBenchmarkHandler(options)],
      ["deterministic", createDeterministicHandler(options)],
      ["human_fallback", createHumanFallbackHandler()],
      ["github_pr", createGithubPrHandler(options)]
    ]);
  }

  listHandlers() {
    return [...this.handlers.keys()];
  }

  listHandlerMetadata() {
    return [...this.handlers.values()].map((handler) => ({
      id: handler.id,
      version: handler.version
    }));
  }

  async evaluate(job, evidence, verificationContext = {}) {
    const handlerId = job.verifierConfig.handler;
    const handler = this.handlers.get(handlerId);
    if (!handler) {
      throw new Error(`No verifier handler registered for ${handlerId}`);
    }
    return handler.evaluate(job, evidence, verificationContext);
  }
}

function githubPrHumanReviewEscalation({
  job,
  score,
  githubLookup,
  checks,
  signals,
  evidence,
  reason
}) {
  return {
    jobId: job.id,
    handler: "human_fallback",
    handlerVersion: HANDLER_VERSION,
    escalatedFrom: "github_pr",
    outcome: "disputed",
    score,
    reasonCode: "HUMAN_REVIEW_REQUIRED",
    detail: `Live GitHub verification could not make a confident decision (${reason}); human review is required and the submission was not auto-approved.`,
    evidence,
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

function githubSourceForJob(job) {
  const source = job?.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {};
  }
  const declared = source.declared;
  return declared && typeof declared === "object" && !Array.isArray(declared)
    ? { ...declared, ...source }
    : source;
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
  githubApiBaseUrl,
  claimantWallet,
  claimSessionId
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
    const prBodyReadable = Boolean(
      pr
      && typeof pr === "object"
      && Object.hasOwn(pr, "body")
      && (typeof pr.body === "string" || pr.body === null)
    );
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
      prBodyReadable,
      claimantBinding: prBodyReadable
        ? inspectAverrayClaimantBinding(body, { claimantWallet, claimSessionId })
        : { status: "unavailable", disclosedWallet: null, disclosedSessionId: null },
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
      ciStatus: allCompleted ? allOk ? "passing" : "failing" : "pending"
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

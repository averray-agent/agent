import type { JobCardData } from "@/components/runs/JobCard";
import type { QueueFilterCount } from "@/components/runs/QueueBar";
import type { RunRow } from "@/components/runs/RunQueueTable";
import type { RunState, Tier } from "@/components/runs/StatePill";
import type {
  GitHubJobContext,
  JobSource,
  OpenDataJobContext,
  OsvJobContext,
  WikipediaJobContext,
} from "@/components/runs/types";
import { buildJobLifecycle } from "@/lib/api/job-lifecycle";
import { buildClaimSummary } from "@/lib/api/claim-status";

type RawRecord = Record<string, unknown>;

const RUN_STATES: RunState[] = ["ready", "claimed", "submitted", "disputed", "settled"];

function asRecord(value: unknown): RawRecord {
  return value && typeof value === "object" ? (value as RawRecord) : {};
}

function asArray(value: unknown): RawRecord[] {
  if (Array.isArray(value)) return value.map(asRecord);
  const record = asRecord(value);
  for (const key of ["items", "jobs", "recommendations", "sessions"]) {
    if (Array.isArray(record[key])) return record[key].map(asRecord);
  }
  return [];
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * Read a field that the backend may emit as either a single string or an
 * array of bullet-style lines. The adapter has historically used `text()`
 * which silently dropped array values, leaving the Loaded-run panel's
 * Instructions tab empty for real Wikipedia jobs (whose
 * `agentInstructions` ships as `string[]`). This helper joins arrays
 * with newlines so the panel renders readable prose either way.
 *
 * Behaviour:
 *   ["A", "B"] -> "A\nB"
 *   "A"        -> "A"
 *   ""/missing -> ""
 */
function textOrLines(value: unknown, fallback = ""): string {
  if (Array.isArray(value)) {
    const lines = value
      .filter((line): line is string => typeof line === "string")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return lines.length ? lines.join("\n") : fallback;
  }
  return text(value, fallback);
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function shortAddress(value: unknown): string {
  const raw = text(value);
  if (!raw) return "unclaimed";
  if (raw.length <= 12) return raw;
  return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
}

function titleFromId(id: string): string {
  return id
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function tierFromRaw(value: unknown): Tier {
  switch (text(value).toLowerCase()) {
    case "pro":
    case "t2":
      return "T2";
    case "elite":
    case "t3":
      return "T3";
    default:
      return "T1";
  }
}

function stateFromRaw(value: unknown): RunState {
  const raw = text(value).toLowerCase();
  if (RUN_STATES.includes(raw as RunState)) return raw as RunState;
  if (raw === "open" || raw === "none") return "ready";
  if (raw === "closed" || raw === "resolved") return "settled";
  if (raw === "rejected" || raw === "failed") return "disputed";
  return "ready";
}

function formatReward(value: unknown): string {
  const amount = numberValue(value);
  return amount.toLocaleString("en-US", {
    maximumFractionDigits: amount >= 100 ? 0 : 2,
    minimumFractionDigits: amount > 0 && amount < 10 ? 2 : 0,
  });
}

function formatWindow(seconds: unknown): string {
  const total = numberValue(seconds);
  if (!total) return "-";
  if (total < 3600) return `${Math.round(total / 60)} min`;
  return `${Math.round(total / 3600)} h`;
}

function verifierLabel(mode: unknown): string {
  const raw = text(mode, "benchmark");
  return raw.replace(/_/gu, " ");
}

function lookupJob(jobs: RawRecord[], id: unknown): RawRecord {
  const jobId = text(id);
  return jobs.find((job) => text(job.id) === jobId) ?? {};
}

/**
 * Pull a lightweight provenance block off a job record. GitHub- and
 * Wikipedia-ingested jobs carry a `source.type` discriminator plus the
 * upstream handle (repo + issue, or page title + revision). Native
 * platform jobs either omit `source` or emit `{ type: "native" }`;
 * those return undefined so the UI renders the generic layout.
 */
export function buildJobSource(job: unknown): JobSource | undefined {
  const src = asRecord(asRecord(job).source);
  const sourceType = text(src.type);
  if (sourceType === "github_issue") {
    const repo = text(src.repo);
    const issueNumber = numberValue(src.issueNumber);
    const issueUrl = text(src.issueUrl);
    if (!repo || !issueNumber || !issueUrl) return undefined;
    const labels = Array.isArray(src.labels)
      ? src.labels.filter((label): label is string => typeof label === "string")
      : undefined;
    const score = typeof src.score === "number" ? src.score : undefined;
    return {
      type: "github_issue",
      repo,
      issueNumber,
      issueUrl,
      ...(labels && labels.length ? { labels } : {}),
      ...(score !== undefined ? { score } : {}),
    };
  }
  if (sourceType === "wikipedia_article") {
    const pageTitle = text(src.pageTitle);
    const language = text(src.language, "en");
    const pageUrl = text(src.pageUrl);
    const revisionId = numberValue(src.revisionId);
    const taskType = text(src.taskType);
    if (!pageTitle || !pageUrl || !revisionId || !taskType) return undefined;
    const score = typeof src.score === "number" ? src.score : undefined;
    return {
      type: "wikipedia_article",
      pageTitle,
      language,
      pageUrl,
      revisionId,
      taskType,
      ...(score !== undefined ? { score } : {}),
    };
  }
  if (sourceType === "osv_advisory") {
    const provider = text(src.provider, "osv");
    const ecosystem = text(src.ecosystem, "npm");
    const packageName = text(src.packageName);
    const vulnerableVersion = text(src.vulnerableVersion);
    const fixedVersion = text(src.fixedVersion);
    const repo = text(src.repo);
    const manifestPath = text(src.manifestPath);
    const advisoryId = text(src.advisoryId);
    if (
      !packageName ||
      !vulnerableVersion ||
      !fixedVersion ||
      !repo ||
      !manifestPath ||
      !advisoryId
    ) {
      return undefined;
    }
    const stringList = (value: unknown): string[] | undefined => {
      if (!Array.isArray(value)) return undefined;
      const arr = value.filter(
        (item): item is string => typeof item === "string" && item.trim() !== ""
      );
      return arr.length ? arr : undefined;
    };
    return {
      type: "osv_advisory",
      provider,
      ecosystem,
      packageName,
      vulnerableVersion,
      fixedVersion,
      repo,
      manifestPath,
      advisoryId,
      ...(stringList(src.aliases) ? { aliases: stringList(src.aliases)! } : {}),
      ...(stringList(src.cves) ? { cves: stringList(src.cves)! } : {}),
      ...(stringList(src.nvdUrls) ? { nvdUrls: stringList(src.nvdUrls)! } : {}),
      ...(text(src.summary) ? { summary: text(src.summary) } : {}),
      ...(text(src.details) ? { details: text(src.details) } : {}),
      ...(stringList(src.references)
        ? { references: stringList(src.references)! }
        : {}),
      ...(text(src.severity) ? { severity: text(src.severity) } : {}),
      ...(text(src.published) ? { published: text(src.published) } : {}),
      ...(text(src.modified) ? { modified: text(src.modified) } : {}),
      ...(typeof src.score === "number" ? { score: src.score } : {}),
      ...(text(src.discoveryApi) ? { discoveryApi: text(src.discoveryApi) } : {}),
    };
  }
  if (sourceType === "open_data_dataset") {
    const provider = text(src.provider, "data.gov");
    const datasetTitle = text(src.datasetTitle);
    const datasetUrl = text(src.datasetUrl);
    const resourceUrl = text(src.resourceUrl);
    if (!datasetTitle || !datasetUrl || !resourceUrl) return undefined;
    return {
      type: "open_data_dataset",
      provider,
      ...(text(src.portal) ? { portal: text(src.portal) } : {}),
      ...(text(src.datasetId) ? { datasetId: text(src.datasetId) } : {}),
      datasetTitle,
      datasetUrl,
      ...(text(src.resourceId) ? { resourceId: text(src.resourceId) } : {}),
      ...(text(src.resourceTitle)
        ? { resourceTitle: text(src.resourceTitle) }
        : {}),
      resourceUrl,
      ...(text(src.resourceFormat)
        ? { resourceFormat: text(src.resourceFormat) }
        : {}),
      ...(text(src.agency) ? { agency: text(src.agency) } : {}),
      ...(text(src.license) ? { license: text(src.license) } : {}),
      ...(text(src.modified) ? { modified: text(src.modified) } : {}),
      ...(text(src.metadataModified)
        ? { metadataModified: text(src.metadataModified) }
        : {}),
      ...(typeof src.score === "number" ? { score: src.score } : {}),
      ...(text(src.discoveryApi)
        ? { discoveryApi: text(src.discoveryApi) }
        : {}),
    };
  }
  if (sourceType === "openapi_spec") {
    const specId = text(src.specId);
    const apiTitle = text(src.apiTitle);
    const provider = text(src.provider);
    const specUrl = text(src.specUrl);
    if (!specId || !apiTitle || !provider || !specUrl) return undefined;
    return {
      type: "openapi_spec",
      specId,
      apiTitle,
      provider,
      specUrl,
      ...(text(src.finalUrl) ? { finalUrl: text(src.finalUrl) } : {}),
      ...(text(src.documentVersion)
        ? { documentVersion: text(src.documentVersion) }
        : {}),
      ...(text(src.openapiVersion)
        ? { openapiVersion: text(src.openapiVersion) }
        : {}),
      ...(text(src.repo) ? { repo: text(src.repo) } : {}),
      ...(typeof src.pathCount === "number" ? { pathCount: src.pathCount } : {}),
      ...(typeof src.operationCount === "number"
        ? { operationCount: src.operationCount }
        : {}),
      ...(typeof src.schemaCount === "number"
        ? { schemaCount: src.schemaCount }
        : {}),
      ...(typeof src.score === "number" ? { score: src.score } : {}),
    };
  }
  if (sourceType === "standards_spec") {
    const specId = text(src.specId);
    const specTitle = text(src.specTitle);
    const provider = text(src.provider);
    const specUrl = text(src.specUrl);
    if (!specId || !specTitle || !provider || !specUrl) return undefined;
    return {
      type: "standards_spec",
      specId,
      specTitle,
      provider,
      specUrl,
      ...(text(src.finalUrl) ? { finalUrl: text(src.finalUrl) } : {}),
      ...(text(src.expectedStatus)
        ? { expectedStatus: text(src.expectedStatus) }
        : {}),
      ...(text(src.currentVersion)
        ? { currentVersion: text(src.currentVersion) }
        : {}),
      ...(text(src.repo) ? { repo: text(src.repo) } : {}),
      ...(typeof src.score === "number" ? { score: src.score } : {}),
    };
  }
  return undefined;
}

/**
 * Build the rich GitHubJobContext used by the Loaded-run panel when a
 * GitHub-ingested job is selected. Returns undefined for native jobs so
 * the panel falls back to the generic governance layout.
 */
export function buildGitHubContext(
  row: Pick<RunRow, "source" | "title">,
  job: unknown
): GitHubJobContext | undefined {
  if (row.source?.type !== "github_issue") return undefined;
  const record = asRecord(job);
  const verification = asRecord(record.verification);
  const verificationMethod = text(verification.method, "github_pr");
  const verificationSignals = Array.isArray(verification.signals)
    ? verification.signals.filter(
        (signal): signal is string => typeof signal === "string"
      )
    : ["PR opened", "CI green", "maintainer review"];
  const acceptance = Array.isArray(record.acceptanceCriteria)
    ? record.acceptanceCriteria.filter(
        (item): item is string => typeof item === "string"
      )
    : [];

  return {
    ...row.source,
    title: text(record.title, row.title),
    category: text(record.category, "work"),
    body: text(record.description, text(record.body, "")),
    acceptanceCriteria: acceptance,
    agentInstructions: textOrLines(record.agentInstructions),
    verification: { method: verificationMethod, signals: verificationSignals },
  };
}

/**
 * Mirror of `buildGitHubContext` for Wikipedia maintenance runs. Returns
 * undefined for any non-Wikipedia row so the panel falls back to the
 * generic layout. Defaults bake in the proposal-only verification path
 * since the platform never edits Wikipedia directly.
 */
export function buildWikipediaContext(
  row: Pick<RunRow, "source" | "title">,
  job: unknown
): WikipediaJobContext | undefined {
  if (row.source?.type !== "wikipedia_article") return undefined;
  const record = asRecord(job);
  const verification = asRecord(record.verification);
  const verificationMethod = text(
    verification.method,
    "wikipedia_proposal_review"
  );
  const verificationSignals = Array.isArray(verification.signals)
    ? verification.signals.filter(
        (signal): signal is string => typeof signal === "string"
      )
    : [
        "Proposal submitted to Averray",
        "Evidence verified",
        "Editor review · Averray-approved",
      ];
  const acceptance = Array.isArray(record.acceptanceCriteria)
    ? record.acceptanceCriteria.filter(
        (item): item is string => typeof item === "string"
      )
    : [];

  return {
    ...row.source,
    title: text(record.title, row.title),
    category: text(record.category, "wikipedia"),
    body: text(record.description, text(record.body, "")),
    acceptanceCriteria: acceptance,
    agentInstructions: textOrLines(record.agentInstructions),
    verification: { method: verificationMethod, signals: verificationSignals },
  };
}

/**
 * Mirror of `buildGitHubContext` for OSV dependency-remediation runs.
 * Returns undefined for any non-OSV row so the panel falls back to the
 * generic layout. Defaults bake in the focused-PR verification path
 * since OSV jobs are always "open one PR that bumps the vulnerable
 * package and updates lockfiles + tests".
 */
export function buildOsvContext(
  row: Pick<RunRow, "source" | "title">,
  job: unknown
): OsvJobContext | undefined {
  if (row.source?.type !== "osv_advisory") return undefined;
  const record = asRecord(job);
  const verification = asRecord(record.verification);
  const verificationMethod = text(verification.method, "osv_dependency_pr");
  const verificationSignals = Array.isArray(verification.signals)
    ? verification.signals.filter(
        (signal): signal is string => typeof signal === "string"
      )
    : [
        "PR opened against the vulnerable manifest",
        "Lockfile updated to fixed version",
        "Install + test evidence attached",
      ];
  const acceptance = Array.isArray(record.acceptanceCriteria)
    ? record.acceptanceCriteria.filter(
        (item): item is string => typeof item === "string"
      )
    : [];

  return {
    ...row.source,
    title: text(record.title, row.title),
    category: text(record.category, "security"),
    body: text(
      record.description,
      text(record.body, row.source.summary ?? "")
    ),
    acceptanceCriteria: acceptance,
    agentInstructions: textOrLines(record.agentInstructions),
    verification: { method: verificationMethod, signals: verificationSignals },
  };
}

/**
 * Mirror of `buildOsvContext` for open-data dataset quality-audit runs.
 * Returns undefined for any non-open-data row so the panel falls back to
 * the generic layout. Defaults bake in the audit-only verification path
 * since the platform never edits source data and never contacts the
 * publishing agency from this workflow.
 */
export function buildOpenDataContext(
  row: Pick<RunRow, "source" | "title">,
  job: unknown
): OpenDataJobContext | undefined {
  if (row.source?.type !== "open_data_dataset") return undefined;
  const record = asRecord(job);
  const verification = asRecord(record.verification);
  const verificationMethod = text(
    verification.method,
    "open_data_quality_audit"
  );
  const verificationSignals = Array.isArray(verification.signals)
    ? verification.signals.filter(
        (signal): signal is string => typeof signal === "string"
      )
    : [
        "Dataset URL reachable",
        "Resource URL reachable",
        "Checks performed",
        "Findings or no_issue_found recorded",
        "Recommended actions present",
      ];
  const acceptance = Array.isArray(record.acceptanceCriteria)
    ? record.acceptanceCriteria.filter(
        (item): item is string => typeof item === "string"
      )
    : [];

  return {
    ...row.source,
    title: text(record.title, row.title),
    category: text(record.category, "data"),
    body: text(record.description, text(record.body, "")),
    acceptanceCriteria: acceptance,
    agentInstructions: textOrLines(record.agentInstructions),
    verification: { method: verificationMethod, signals: verificationSignals },
  };
}

export function extractRunJobs(payload: unknown): RawRecord[] {
  return asArray(payload);
}

export function buildRunRows(payload: unknown): RunRow[] {
  return asArray(payload).map((job) => {
    const id = text(job.id, "unknown-job");
    const title = text(job.title, text(job.description, titleFromId(id)));
    const state = stateFromRaw(job.state);
    const worker = text(job.claimedBy) || text(job.worker);

    const source = buildJobSource(job);
    // For ingested-source jobs the row already shows the upstream
    // identity (owner/repo #N for GitHub, lang.wikipedia/page for
    // Wikipedia) via the SourceBadge, so drop the redundant job-id
    // slug from jobMeta to keep the meta line scannable. Wikipedia
    // rows additionally swap the job's own `category` (always
    // "wikipedia", duplicating the SourceBadge) for the more specific
    // task type so the meta line carries new signal. Native jobs
    // keep the full `id · category · tier` because there's no other
    // provenance signal.
    const tier = tierFromRaw(job.tier);
    const category = text(job.category, "work");
    // Source-aware meta: surface the most specific identity the row
    // already shows visually (lang.wikipedia / page, owner/repo,
    // ecosystem / package · advisory) and avoid re-printing the
    // SourceBadge label as text. OSV in particular avoids the generic
    // "security" category — operators want to scan
    // `npm / minimist · GHSA-...` instead.
    const jobMeta =
      source?.type === "wikipedia_article"
        ? `${source.taskType.replace(/_/g, " ")} · ${tier}`
        : source?.type === "github_issue"
          ? `${category} · ${tier}`
          : source?.type === "osv_advisory"
            ? `${source.ecosystem} / ${source.packageName} · ${source.advisoryId} · ${tier}`
            : source?.type === "open_data_dataset"
              ? // Spec: `Data.gov · <agency> · <resource_format> · quality
                // audit`. Agency and format are optional in the catalog;
                // drop the missing parts and any leading/trailing
                // separators so the meta line never reads
                // `Data.gov ·  ·  · quality audit`.
                [
                  "Data.gov",
                  source.agency,
                  source.resourceFormat,
                  "quality audit",
                  tier,
                ]
                  .filter(
                    (part): part is string =>
                      typeof part === "string" && part.length > 0
                  )
                  .join(" · ")
              : source?.type === "openapi_spec"
                ? // OpenAPI audit row meta: `<provider> / <openapi
                  // version> · <op count> ops · quality audit · T*`.
                  // Drop missing pieces gracefully.
                  [
                    source.provider,
                    source.openapiVersion
                      ? `OpenAPI ${source.openapiVersion}`
                      : undefined,
                    typeof source.operationCount === "number"
                      ? `${source.operationCount} ops`
                      : undefined,
                    "quality audit",
                    tier,
                  ]
                    .filter(
                      (part): part is string =>
                        typeof part === "string" && part.length > 0
                    )
                    .join(" · ")
                : source?.type === "standards_spec"
                  ? // Standards-freshness row meta: `<provider> · <expected
                    // status> · freshness audit · T*`.
                    [
                      source.provider.toUpperCase(),
                      source.expectedStatus,
                      "freshness audit",
                      tier,
                    ]
                      .filter(
                        (part): part is string =>
                          typeof part === "string" && part.length > 0
                      )
                      .join(" · ")
                  : `${id} · ${category} · ${tier}`;
    const lifecycle = buildJobLifecycle(job.lifecycle);
    // Compact claim block read straight off the row. The backend
    // documents `claimabilitySource: "claimStatus"` — claimable rows
    // and pills must derive from this, never from `lifecycle.status`
    // alone (a row can be lifecycle.open + claim.exhausted).
    const claim = buildClaimSummary(job);
    return {
      id,
      sessionId: text(job.sessionId),
      title,
      jobMeta,
      ...(source ? { source } : {}),
      ...(lifecycle ? { lifecycle } : {}),
      ...(claim ? { claim } : {}),
      worker: {
        variant: worker ? "a" : "unclaimed",
        initials: worker ? "AG" : "-",
        label: worker ? shortAddress(worker) : "unclaimed",
      },
      state,
      stake: formatReward(job.stake ?? job.rewardAmount),
      age: formatWindow(job.claimTtlSeconds),
      // The SourceBadge already shows where the row came from, so the
      // lastEvent line carries the work *kind* instead of restating the
      // source. The previous "Ingested from Wikipedia · proposal-only"
      // truncated to "Inge…" in narrow queue columns and lost all
      // signal.
      lastEvent:
        source?.type === "github_issue"
          ? state === "ready"
            ? "Issue triage"
            : `State: ${state}`
          : source?.type === "wikipedia_article"
            ? state === "ready"
              ? "Proposal-only"
              : `State: ${state}`
            : source?.type === "osv_advisory"
              ? state === "ready"
                ? "Dependency remediation"
                : `State: ${state}`
              : source?.type === "open_data_dataset"
                ? state === "ready"
                  ? "Audit only"
                  : `State: ${state}`
                : source?.type === "openapi_spec"
                  ? state === "ready"
                    ? "Quality audit"
                    : `State: ${state}`
                  : source?.type === "standards_spec"
                    ? state === "ready"
                      ? "Freshness audit"
                      : `State: ${state}`
                    : state === "ready"
                      ? "Job listed"
                      : `State: ${state}`,
      lastEventMeta:
        source?.type === "github_issue"
          ? `${source.repo} #${source.issueNumber} · verifier ${verifierLabel(job.verifierMode)}`
          : source?.type === "wikipedia_article"
            ? `${source.language}.wikipedia · rev ${source.revisionId} · ${source.taskType.replace(/_/g, " ")}`
            : source?.type === "osv_advisory"
              ? `${source.repo} · ${source.manifestPath} · ${source.vulnerableVersion} → ${source.fixedVersion}`
              : source?.type === "open_data_dataset"
                ? // Same graceful-degrade rule as jobMeta: drop missing
                  // optional parts so the meta never has empty bullets.
                  [source.agency, source.resourceFormat, source.datasetTitle]
                    .filter(
                      (part): part is string =>
                        typeof part === "string" && part.length > 0
                    )
                    .join(" · ") ||
                  `verifier ${verifierLabel(job.verifierMode)}`
                : source?.type === "openapi_spec"
                  ? [
                      source.apiTitle,
                      source.documentVersion
                        ? `v${source.documentVersion}`
                        : undefined,
                      typeof source.pathCount === "number"
                        ? `${source.pathCount} paths`
                        : undefined,
                    ]
                      .filter(
                        (part): part is string =>
                          typeof part === "string" && part.length > 0
                      )
                      .join(" · ") ||
                    `verifier ${verifierLabel(job.verifierMode)}`
                  : source?.type === "standards_spec"
                    ? [
                        source.specTitle,
                        source.expectedStatus,
                      ]
                        .filter(
                          (part): part is string =>
                            typeof part === "string" && part.length > 0
                        )
                        .join(" · ") ||
                      `verifier ${verifierLabel(job.verifierMode)}`
                    : `${text(job.rewardAsset, "DOT")} · verifier ${verifierLabel(job.verifierMode)}`,
    };
  });
}

export function buildRunFilters(rows: RunRow[]): QueueFilterCount[] {
  return [
    { id: "all", label: "All", count: rows.length },
    ...RUN_STATES.map((state) => ({
      id: state,
      label: `${state.slice(0, 1).toUpperCase()}${state.slice(1)}`,
      count: rows.filter((row) => row.state === state).length,
    })),
  ];
}

export function buildRecommendationCards(
  recommendationPayload: unknown,
  jobsPayload: unknown
): JobCardData[] {
  const jobs = asArray(jobsPayload);
  return asArray(recommendationPayload).map((recommendation, index) => {
    const job = lookupJob(jobs, recommendation.jobId);
    const id = text(recommendation.jobId, text(job.id, "unknown-job"));
    const fitScore = numberValue(recommendation.fitScore);
    const fit = Math.max(1, Math.min(5, Math.ceil(fitScore / 20)));

    const source = buildJobSource(job);
    const category = text(job.category, "work");
    // Recommendation card subtitle. OSV runs are most identifiable by
    // ecosystem/package + advisory id — `npm / minimist · GHSA-...` —
    // so the card shows that instead of the generic "security"
    // category. GitHub/Wikipedia keep their existing single-token
    // category subtitle (the SourceBadge already supplies the
    // platform identity).
    const jobMeta =
      source?.type === "osv_advisory"
        ? `${source.ecosystem} / ${source.packageName} · ${source.advisoryId}`
        : source?.type === "open_data_dataset"
          ? [
              "Data.gov",
              source.agency,
              source.resourceFormat,
              "quality audit",
            ]
              .filter(
                (part): part is string =>
                  typeof part === "string" && part.length > 0
              )
              .join(" · ")
          : category;
    const isIngested =
      source?.type === "github_issue" ||
      source?.type === "wikipedia_article" ||
      source?.type === "osv_advisory" ||
      source?.type === "open_data_dataset";
    return {
      id,
      title: text(job.title, text(job.description, titleFromId(id))),
      jobMeta,
      category,
      ...(source ? { source } : {}),
      rewardValue: formatReward(recommendation.netReward ?? job.rewardAmount),
      rewardCurrency: text(job.rewardAsset, "DOT"),
      rewardUsd: "live",
      tier: tierFromRaw(recommendation.tier ?? job.tier),
      modeLabel: verifierLabel(job.verifierMode),
      modeTone: recommendation.eligible === false ? "disputed" : "claimed",
      meta: [
        { label: "Reward", value: `${formatReward(job.rewardAmount)} ${text(job.rewardAsset, "DOT")}` },
        { label: "Verifier", value: verifierLabel(job.verifierMode) },
        { label: "Window", value: formatWindow(job.claimTtlSeconds), accent: true },
        {
          label: isIngested ? "Fit score" : "Gas",
          value: isIngested
            ? `${
                (source && "score" in source && typeof source.score === "number"
                  ? source.score
                  : fitScore)
              }/100`
            : job.requiresSponsoredGas
              ? "sponsored"
              : "worker",
        },
      ],
      fit,
      hot: index === 0,
      // Pass the live claim contract through so the JobCard's Claim
      // button gates correctly on the rail. Recommendation rows are
      // joined to the job feed by id above (`lookupJob`), so the
      // contract is already present when the backend emits it.
      ...(buildClaimSummary(job) ? { claim: buildClaimSummary(job)! } : {}),
    };
  });
}

export function sumReadyStake(rows: RunRow[]): string {
  const total = rows
    .filter((row) => row.state === "ready")
    .reduce((sum, row) => sum + numberValue(row.stake), 0);
  return `${formatReward(total)} DOT`;
}
